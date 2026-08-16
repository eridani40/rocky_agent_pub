/**
 * AutoNamingService — playground session AI 自动起名服务。
 *
 * 用户在 playground session 发出**首条 query** 时，handleMessagesPost 内部 fire-and-forget
 * 触发本 service：后台并行单次 LLM 调用拿 AI 名 → CAS 应用（titled===false 时写
 * {title, titled:true} + 触发 session_meta_update 广播），失败/竞态静默 no-op。
 *
 * [v0.0.84] 起名链路改走 LlmCaller.invoke（替代裸 config.client.call）：复用 adaptive retry
 * 全套 / backgroundPath=true 仅排除 capacity 类防雪崩 / baseReq 不传 params 复用 session 配置 /
 * 独立 trace + generation（同 forked 模式）接 langfuse 闭环。observability 真源 = deps 注入
 * 的 observabilityManager（非 config.observability，详见 deps.observability 注释）。
 *
 * 参考: specs/tech/agent/auto_naming/ + specs/tech/agent/llm_caller/[P0]llm_caller_overview.md
 *
 * 不变量：
 *   1. 任何失败都不抛到 handleMessagesPost 主路径（外层 `.catch(()=>{})` 兜底）
 *   2. CAS：re-read session，仅当 titled===false 才应用 AI 名
 *   3. 仅 playground + 非 subagent scope 触发（studio / subagent 不起名）
 *   4. 仅首 query 触发（transcript 无 prior role=user 消息）
 *   5. 观测本身 fail-silent（langfuse 失败绝不影响主路径）
 */
import type { SessionStore } from './session-store';
import type { AgentManagerImpl } from './agent-manager';
import type { SessionMetaBroadcaster } from './session-meta-broadcaster';
import type { CanonicalRequest } from '../llm/protocol';
import type { ContentBlock } from '../llm/protocol-types';
import type { ObservabilityAdapter } from '../observability/adapter';
import type { ObservabilityPort, InvokeContext, InvokeResponse } from '../llm/caller/llm_caller';
import type { AbortControllerHandle } from './agent-interface';
import type { TraceHandle, GenHandle } from '../observability/types';
import { createLlmErrorState } from '../llm/caller/llm_error_state';
import { buildInvokeContext } from '../llm/caller/build_invoke_context';
import { createLangfuseObservabilityPort } from '../llm/caller/langfuse_observability_port';
import { LlmErrorCategory } from '../llm/caller/error_types';
import { noopAdapter } from '../observability/noop-adapter';
import { AutoNamingHandler } from '../prompts/handlers/auto-naming-handler';

/** AutoNamingService 注入依赖集合 */
export interface AutoNamingServiceDeps {
  store: SessionStore;
  agentManager: AgentManagerImpl;
  /** 可选：触发 session_meta_update 广播（AI 名应用后让前端列表实时刷新 title） */
  metaBroadcaster?: SessionMetaBroadcaster;
  /**
   * [v0.0.84] LlmCaller.invoke 入口（替代裸 client.call）。
   * 复用 adaptive retry / provider 降级 / 错误归一化 / langfuse 闭环。
   */
  llmCaller: { invoke(baseReq: CanonicalRequest, ctx: InvokeContext): Promise<InvokeResponse> };
  /**
   * [v0.0.84] observability adapter（**起名 trace 真源**，bootstrap 注入 observabilityManager）。
   *
   * 必须从 deps 注入、不能从 config.observability 取：resolveConfigBySid 返的 SessionConfig
   * 无 observability 字段（该字段只在 AgentManager.activate 注入主 run 路径）。起名 applyAiName
   * 走 resolveConfigBySid、不走 activate → 旧实现 `config.observability ?? noopAdapter` 恒落 noop。
   */
  observability?: ObservabilityAdapter;
}

/** invoke observability 资源（trace + gen + port；startGeneration 失败时 null） */
interface AutoNamingObs {
  adapter: ObservabilityAdapter;
  trace: TraceHandle;
  gen: GenHandle;
  port: ObservabilityPort;
}

/**
 * AutoNamingService — playground session AI 自动起名。
 * 用法：handleMessagesPost 内 `void svc.triggerIfFirstQuery(sid, plainText).catch(()=>{})`。
 */
export class AutoNamingService {
  private readonly store: SessionStore;
  private readonly agentManager: AgentManagerImpl;
  private readonly metaBroadcaster?: SessionMetaBroadcaster;
  private readonly llmCaller: AutoNamingServiceDeps['llmCaller'];
  /**
   * [v0.0.84] 起名 observability 真源（deps 注入，非 config.observability，详见 deps.observability 注释）。
   */
  private readonly observability: ObservabilityAdapter;

  constructor(deps: AutoNamingServiceDeps) {
    this.store = deps.store;
    this.agentManager = deps.agentManager;
    this.metaBroadcaster = deps.metaBroadcaster;
    this.llmCaller = deps.llmCaller;
    this.observability = deps.observability ?? noopAdapter;
  }

  /**
   * 触发 AI 起名（gate + applyAiName）。
   *
   * Gate 顺序（短路）：
   *   1. session 存在 + bizType==='playground' + type!=='subagent'（playground scope gate）
   *   2. titled!==true（防御：已置 true 不再触发）
   *   3. transcript 无 prior role=user 消息（首 query 判定，关键 gate）
   * 全过 → 调 applyAiName（内部 LLM call + CAS）。
   */
  async triggerIfFirstQuery(sid: string, plainText: string): Promise<void> {
    try {
      const session = await this.store.getSession(sid);
      if (!session) return;
      const biz = session.biz ?? 'playground';
      if (biz !== 'playground') return;
      if (session.derivation === 'subagent') return;
      if (session.titled === true) return;
      const page = await this.store.getMessages(sid, { limit: 200 });
      const hasPriorUser = page.items.some((m) => m.role === 'user');
      if (hasPriorUser) return;
      await this.applyAiName(sid, plainText);
    } catch {
      // gate/store 失败：fail-silent（无 LLM 资源可回收，无 generation 可 end）。
    }
  }

  /**
   * 调 LLM 拿 AI 名 + CAS 应用（re-read titled===false → 写 + broadcast）。
   * 全失败静默（catch return）。
   *
   * @internal triggerIfFirstQuery 调用；export 仅 UT 注入 mock 用
   */
  async applyAiName(sid: string, plainText: string): Promise<void> {
    let invokeResp: InvokeResponse | null = null;
    // [v0.0.84] 独立 trace + generation（同 forked 模式：auto-naming 是 fire-and-forget 后台任务，无父 trace）
    let obs: AutoNamingObs | null = null;
    let invokeStarted = false;
    try {
      const config = await this.agentManager.resolveConfigBySid(sid);
      // [v0.0.84] observability 真源 = this.observability（deps 注入的 observabilityManager），
      //   非 config.observability（详见 deps.observability 注释）。
      obs = this.startGeneration(this.observability, sid, config.modelId, plainText);
      // baseReq 不传 params（D3）—— maxTokens/temperature 全复用 session/model 配置 +
      // invoke buildRequest overlay（baseReq.params.maxTokens ?? model.capabilities.maxOutputTokens）
      const baseReq: CanonicalRequest = {
        modelId: config.modelId,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: new AutoNamingHandler().build({ vars: { query: plainText } }).content }],
          },
        ],
        params: {},
      };
      // [v0.0.84] ctx 最小集：client/errorState/controller/observability + backgroundPath=true；
      //   onEvent/llmRequestConfig/allProviders/health 不传（起名单 provider 单 attempt 兜底）。
      const ctx: InvokeContext = buildInvokeContext({
        client: config.client as never,
        errorState: createLlmErrorState(),
        sessionId: sid,
        controller: { runId: 'auto-naming', aborted: false } satisfies AbortControllerHandle,
        observability: obs?.port,
        backgroundPath: true,
      });
      invokeStarted = true;
      invokeResp = await this.llmCaller.invoke(baseReq, ctx);
      // 成功：invoke 内部已 endGenerationOk；此处不再 end（避免双 end）
    } catch (err) {
      // [v0.0.84] 失败观测（fail-silent）：invokeStarted=false（resolveConfig/startGeneration
      //   /buildInvokeContext 抛）时补 endGenerationError；invokeStarted=true 时 invoke 已 end
      if (obs && !invokeStarted) {
        this.observeFailure(obs, err);
      }
      this.endTrace(obs);
      return;
    }
    this.endTrace(obs);

    const aiName = invokeResp ? extractPlainName(invokeResp) : null;
    if (!aiName || aiName.length === 0) return;
    const truncated = aiName.length > 60 ? aiName.slice(0, 60) : aiName;

    // CAS gate：re-read session，仅当 titled===false 才应用（防首 query 期间人工改名竞态）
    const latest = await this.store.getSession(sid);
    if (!latest) return;
    if (latest.titled === true) return;

    try {
      await this.store.updateSession(sid, { title: truncated, titled: true });
      if (this.metaBroadcaster) this.metaBroadcaster.broadcast(sid);
    } catch {
      // 落库失败：generation 已 endGenerationOk，不重复 end；fail-silent（外层 .catch 兜底）。
    }
  }

  /**
   * [v0.0.84] 启独立 trace + generation，返 ObservabilityPort（bridge 到 langfuse）。
   * adapter 失败 → 视为无 observability（invoke 仍跑，零阻塞）。
   */
  private startGeneration(
    adapter: ObservabilityAdapter,
    sid: string,
    modelId: string,
    plainText: string,
  ): AutoNamingObs | null {
    try {
      const trace = adapter.startTrace({
        id: `auto-naming-${sid}-${Date.now()}`,
        sessionId: sid,
        name: 'auto_naming',
        input: [{
          id: 'auto-naming-input',
          sessionId: sid,
          role: 'user',
          content: [{ type: 'text', text: plainText }],
        }] as never,
        metadata: {
          runId: `auto-naming-${sid}`,
          sessionId: sid,
          inputMessageIds: [],
          modelId,
          toolNames: [],
        } as never,
      });
      const gen = adapter.startGeneration({
        parent: trace,
        model: modelId,
        input: { messages: [], modelId, iteration: 0 } as never,
        startTime: new Date(),
        // [v0.0.353 T3 A1 review fix] 与主链路 LoopObservability/port 对称：logical start 同标
        // providerId/providerName=null + logicalView=true（真实 provider 在 port physical 子 span）
        providerId: null,
        providerName: null,
        logicalView: true,
      });
      const port = createLangfuseObservabilityPort({ adapter, genHandle: gen, iteration: 0, step: 0, model: modelId });
      return { adapter, trace, gen, port };
    } catch (err) {
      // adapter 失败不阻塞主流程（核心红线：observability 失败绝不向主路径抛）
      void err;
      return null;
    }
  }

  /** endTrace（idempotent；obs null 时 noop；endTrace 本身 fail-silent） */
  private endTrace(obs: AutoNamingObs | null): void {
    if (!obs) return;
    try {
      obs.adapter.endTrace(obs.trace);
    } catch (err) {
      void err;
    }
  }

  /**
   * [v0.0.84] 兜底 endGenerationError（仅在 invoke 未启动/未 end 时调）。
   * fail-silent：observability 自身异常被 catch 吞掉（核心红线）。
   */
  private observeFailure(obs: AutoNamingObs, err: unknown): void {
    try {
      const reason = err instanceof Error ? err.message : String(err);
      obs.port.endGenerationError?.(LlmErrorCategory.INTERNAL, reason, { retryChain: [] });
    } catch {
      // 观测本身 fail-silent：绝不向主路径抛
    }
  }
}

/**
 * 从 LLM 响应提取净化后的纯名字（去引号/标点/取首行/trim；空 → null）。
 *
 * 入参类型用 protocol-types 的 ContentBlock（与 CanonicalResponse / InvokeResponse 同源）；
 * CanonicalResponse / InvokeResponse 均满足此结构类型。
 *
 * 净化规则（容 LLM 不严格遵守起名提示词 content/auto_naming.md 的情况）：
 *   1. 取 resp.message.content[] 首个 text block 的 text
 *   2. trim 首尾空白
 *   3. 去包围引号（"..." / "..." / '...' / 「...」）
 *   4. 去末尾声明标点（。.!！?？）
 *   5. 取首行（防 LLM 返多行解释）
 *   6. trim；空 → null
 *
 * @internal export 仅 UT 直接断言用
 */
export function extractPlainName(resp: { message: { content: ContentBlock[] } }): string | null {
  const block = resp.message.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') return null;
  let name = block.text.trim();
  name = name.replace(/^["“」『]+|["”」』]+$/g, '').trim();
  name = name.replace(/^[「『]+|[」』]+$/g, '').trim();
  name = name.replace(/^['']+|['']+$/g, '').trim();
  name = name.replace(/[。.!！?？]+$/g, '').trim();
  name = name.split(/\r?\n/)[0]!.trim();
  return name.length > 0 ? name : null;
}
