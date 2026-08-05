/**
 * LlmClient — 把 4 件套组合发起真实调用（I/O + 编排 + token 计数）
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_client_interface.md §2/§3.2/§3.6/§3.8
 *
 * 4 件套：
 *   - providerConfig（app_config per-instance 数据）
 *   - provider（llm_provider ext impl，无状态代码）
 *   - protocol（llm_protocol ext impl，自承载 path/contentType）
 *   - modelConfig（app_config per-instance 数据）
 * 外加可选 tokenizer、可选 fetchImpl、可选 onWire（物理层钩子）。
 *
 * 设计（client §3.2/§3.4/§3.6/§3.8）：
 *   - I/O 与编排归 client，protocol 只做纯翻译
 *   - URL = providerConfig.baseUrl + protocol.path；headers 含 buildAuthHeaders + contentType
 *   - stream() 用 protocol.parseStream 解析 chunk 并 yield StreamEvent
 *   - 不可变（绑定 4 组件只读），可跨 session/run 共享、async 并发安全
 *   - onWire 钩子：prepare 后、fetch 前触发（call + stream 两路同源），
 *     记 wire body 供 langfuse physical_wire_body diff 对账（§3.8）。
 */
import type { LlmProvider } from './provider';
import type {
  CanonicalRequest,
  CanonicalResponse,
  LlmProtocol,
  StreamEvent,
  WireResponse,
} from './protocol';
import type {
  LlmModelConfig,
  LlmProviderConfig,
  Tokenizer,
} from './provider-types';
import type { Usage } from '../message/types';
// 非 2xx 抛结构化错误（携 numeric status），供 classifier 的 asWireResponse 命中
import { buildHttpErrorFromResponse, LlmHttpError } from './http_error';

/**
 * 物理层 onWire 钩子函数（spec §3.8）。
 * 在 protocol.encode 产出最终 wire body 后、fetchImpl 调用前触发（call + stream 两路同源）。
 * 用途：LlmCaller.invoke 内通过 LlmClient.withOnWire 注入此回调，将 wire body 写入
 * langfuse generation metadata 的 physical_wire_body 字段（逻辑 vs 物理 diff 对账）。
 */
export type OnWireHook = (
  request: CanonicalRequest,
  body: unknown,
  url: string,
) => void;

/** LlmClient 构造参数 */
export interface LlmClientOptions {
  providerConfig: LlmProviderConfig;
  provider: LlmProvider;
  protocol: LlmProtocol;
  modelConfig: LlmModelConfig;
  /** 可选 tokenizer（来源 context/usage 模块） */
  tokenizer?: Tokenizer;
  /** 可选 fetch 注入点（server 在 ROCKY_TEST_MOCK_LLM=1 时注入假 SSE） */
  fetchImpl?: typeof fetch;
  /** 可选物理层 wire body 钩子（prepare 后 fetch 前，spec §3.8） */
  onWire?: OnWireHook;
}

/**
 * LLM 调用门面。构造期绑定 4 件套 + tokenizer + 可选 fetchImpl，之后不可变。
 *
 * 用法：
 *   const client = new LlmClient({ providerConfig, provider, protocol, modelConfig });
 *   for await (const e of client.stream(req)) { ... }
 */
export class LlmClient {
  private readonly providerConfig: LlmProviderConfig;
  private readonly provider: LlmProvider;
  private readonly protocol: LlmProtocol;
  private readonly modelConfig: LlmModelConfig;
  private readonly tokenizer?: Tokenizer;
  private readonly fetchImpl: typeof fetch;
  private readonly onWire?: OnWireHook;

  constructor(opts: LlmClientOptions) {
    this.providerConfig = opts.providerConfig;
    this.provider = opts.provider;
    this.protocol = opts.protocol;
    this.modelConfig = opts.modelConfig;
    this.tokenizer = opts.tokenizer;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.onWire = opts.onWire;
  }

  /**
   * 暴露客户端绑定的不可变元信息（providerId/modelId/capabilities）。
   * 用途：LlmCaller.invoke 的 InvokeContext 需 provider/model 形状（resolveTarget fallback +
   * buildRequest 取 capabilities + decideAction 取 credentials）；eager/forked 只有 client 句柄。
   * 不暴露 credentials（敏感，由 client 内部持有）。
   */
  getInfo(): {
    providerId: string; providerName: LlmProviderConfig['name']; modelId: string;
    capabilities: NonNullable<LlmModelConfig['capabilities']>; maxOutputTokens: number;
  } {
    const cap = this.modelConfig.capabilities ?? {
      maxOutputTokens: this.modelConfig.maxOutputTokens,
      supportsPrefill: false, supportsThinking: false,
    };
    return {
      providerId: this.providerConfig.id, providerName: this.providerConfig.name,
      modelId: this.modelConfig.modelId, capabilities: cap, maxOutputTokens: this.modelConfig.maxOutputTokens,
    };
  }

  /** 非流式调用（chat 用 stream，call 留作 agent loop 用） */
  async call(request: CanonicalRequest): Promise<CanonicalResponse> {
    this.validate(request);
    const { url, headers, body } = this.prepare(request, false);
    // 物理层 onWire 钩子：prepare 后 fetch 前（call 路径）
    this.onWire?.(request, body, url);
    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    // 非 2xx 抛 LlmHttpError（携 numeric status + body + headers）：
    //   asWireResponse 查 typeof e.status==='number' 直接命中 → classifyWire 分类（否则塌缩成 NETWORK 兜底，401 误判）。
    if (!resp.ok) {
      throw await buildHttpErrorFromResponse(resp);
    }
    const wire: WireResponse = {
      status: resp.status,
      body: await resp.json(),
    };
    const parsed = this.protocol.parse(wire);
    // llm_client_interface §2：call() 末尾用 modelConfig.pricing 算 cost 并填 currency。
    // computeCost 按 spec §3.3 消费 modelConfig.pricing（input/output/cache_read/cache_write）。
    parsed.usage.cost = this.computeCost(parsed.usage);
    parsed.usage.currency = this.modelConfig.pricing.currency;
    return parsed;
  }

  /**
   * 流式调用：迭代 StreamEvent（thinking_delta / text_delta / usage / finish）。
   * URL = baseUrl + protocol.path；headers = buildAuthHeaders + contentType；
   * body 用 protocol.encode（stream:true）；chunk 用 protocol.parseStream 解析。
   * 可选 signal 注入 fetch（abort api 中断；agent_interrupt.md §2.3）。
   */
  async *stream(request: CanonicalRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.validate(request);
    const { url, headers, body } = this.prepare(request, true);
    // 物理层 onWire 钩子（stream 路径同 call 路径）：prepare 后 fetch 前
    this.onWire?.(request, body, url);
    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    // 非 2xx 抛 LlmHttpError（同 call 路径，携 numeric status）。
    //   HTTP 2xx 但 body 含 anthropic error 事件的兜底由 protocol-parse-stream 的 error 分支产 error StreamEvent。
    if (!resp.ok) {
      throw await buildHttpErrorFromResponse(resp);
    }
    if (!resp.body) return;
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      // stream 路径 cost/currency 闭环（§3.7）：
      //   parseStream 产出的 usage 事件只带 token 字段（parseAnthropicUsage 翻译 wire usage），
      //   cost/currency 未填 → client 在 yield 前补齐（与 call() 同源 computeCost + pricing.currency）。
      //   否则 stream-only 调用方（agent loop 默认走 stream）永远拿不到 cost。
      //   char 字段不归 client（agent loop 从 snapshot.inputCharCount / StreamConsumer 填）。
      for (const evt of this.protocol.parseStream(chunk)) {
        if (evt.type === 'usage') {
          evt.usage.cost = this.computeCost(evt.usage);
          evt.usage.currency = this.modelConfig.pricing.currency;
        }
        yield evt;
      }
    }
  }

  /**
   * 派生绑了新 onWire 的 LlmClient（不可变共享，spec §3.6/§3.8）。
   * 用途：生产 invoke 每 attempt 需绑本次 attempt 的 onWire（捕获 wire body 进 langfuse generation）。
   * 保留 4 件套 + tokenizer + fetchImpl，只替换 onWire（caller 显式覆盖语义）。
   * @param onWire 新钩子（undefined = 解绑）
   */
  withOnWire(onWire?: OnWireHook): LlmClient {
    return new LlmClient({
      providerConfig: this.providerConfig,
      provider: this.provider,
      protocol: this.protocol,
      modelConfig: this.modelConfig,
      tokenizer: this.tokenizer,
      fetchImpl: this.fetchImpl,
      onWire,
    });
  }

  /** 按 modelConfig.modelId 选 tokenizer 计 token；无则字符估算（client §2） */
  countTokens(text: string): number {
    return this.tokenizer?.count(text) ?? estimateChars(text);
  }

  /** 上下文窗口上限 = modelConfig.contextWindow */
  get contextWindow(): number {
    return this.modelConfig.contextWindow;
  }

  /**
   * 用 modelConfig 校验请求参数（§2/§3.3/§3.9）：temperature/topP 落
   * paramConstraints 范围；maxTokens ≤ maxOutputTokens。违反抛 LlmHttpError（携 numeric status=400），
   * 让 classifier 按 message 分类（否则裸 Error 无 status → 塌缩 NETWORK 对必再失败的请求白重试）：
   *   - maxTokens 越界：body.message 含 "max_tokens" → adapter classifyWire 400 命中
   *     MAX_TOKENS_BAD_PARAM_PATTERNS → MAX_TOKENS_TOO_HIGH（retryable + buildRequest 降 ×0.7，
   *     让用户配低 maxOutputTokens 时 session 不重启自适应恢复）。
   *   - temperature/topP 越界：body.message 不含 "max_tokens" → adapter 400 兜底
   *     BAD_REQUEST_OTHER（NO_RETRY，真正不可恢复的 misconfig）。
   */
  private validate(request: CanonicalRequest): void {
    const { params } = request;
    const { paramConstraints, maxOutputTokens } = this.modelConfig;
    if (params.temperature !== undefined) {
      const c = paramConstraints.temperature;
      if (c && (params.temperature < c.min || params.temperature > c.max)) {
        // 抛 LlmHttpError{status:400} → classifier → BAD_REQUEST_OTHER（NO_RETRY）。
        // message 不含 max_tokens 字样，确保不被 MAX_TOKENS_BAD_PARAM_PATTERNS 误命中。
        const msg = `temperature ${params.temperature} out of [${c.min}, ${c.max}]`;
        throw new LlmHttpError(
          400,
          { error: { type: 'invalid_request_error', message: msg } },
          undefined,
          msg,
        );
      }
    }
    if (params.topP !== undefined) {
      const c = paramConstraints.topP;
      if (c && (params.topP < c.min || params.topP > c.max)) {
        // 同 temperature：LlmHttpError{status:400} → BAD_REQUEST_OTHER（NO_RETRY）。
        const msg = `topP ${params.topP} out of [${c.min}, ${c.max}]`;
        throw new LlmHttpError(
          400,
          { error: { type: 'invalid_request_error', message: msg } },
          undefined,
          msg,
        );
      }
    }
    if (params.maxTokens !== undefined && params.maxTokens > maxOutputTokens) {
      // message 含 "max_tokens" 字样 → adapter classifyWire 400 命中
      // MAX_TOKENS_BAD_PARAM_PATTERNS → MAX_TOKENS_TOO_HIGH（retryable + buildRequest 降 ×0.7）。
      // 关键：用 wire 字段名 max_tokens（不是 camelCase maxTokens），否则 pattern 不命中。
      const msg = `max_tokens ${params.maxTokens} exceeds model max ${maxOutputTokens}`;
      throw new LlmHttpError(
        400,
        { error: { type: 'invalid_request_error', message: msg } },
        undefined,
        msg,
      );
    }
  }

  /** 用 modelConfig.pricing 算 cost（§2/§3.3）：input/output/cache 各乘 perMillion/1e6，cache 无定价则跳过。 */
  private computeCost(usage: Usage): number {
    const p = this.modelConfig.pricing;
    let cost = 0;
    cost += (usage.input_no_cache ?? 0) * p.inputPerMillion / 1e6;
    cost += (usage.output_total_tokens ?? 0) * p.outputPerMillion / 1e6;
    if (p.cacheReadPerMillion !== undefined) {
      cost += (usage.input_cache_read ?? 0) * p.cacheReadPerMillion / 1e6;
    }
    if (p.cacheWritePerMillion !== undefined) {
      cost += (usage.input_cache_write ?? 0) * p.cacheWritePerMillion / 1e6;
    }
    return cost;
  }

  /** 组装 url/headers/body（call 与 stream 共用） */
  private prepare(request: CanonicalRequest, stream: boolean): { url: string; headers: Record<string, string>; body: unknown } {
    const url = this.providerConfig.baseUrl + this.protocol.path;
    const headers: Record<string, string> = {
      ...this.provider.buildAuthHeaders(this.providerConfig),
      'Content-Type': this.protocol.contentType,
    };
    const body = this.protocol.encode({
      ...request,
      params: { ...request.params, stream },
    });
    return { url, headers, body };
  }
}

/** 字符级 token 估算（无 tokenizer 时兜底，粗略：1 字符 ≈ 0.3 token） */
function estimateChars(text: string): number {
  return Math.max(1, Math.ceil(text.length * 0.3));
}
