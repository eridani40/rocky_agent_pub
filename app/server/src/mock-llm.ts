/**
 * mock-llm — ROCKY_TEST_MOCK_LLM=1 注入的假 fetch（不真调 Anthropic）
 * 参考: states/v0.0.3/verify/test-plan.md §1（mock 策略）
 *       states/v0.0.8/verify/test-plan.md §0（四剧本：mock:text/tool/error/compact）
 *       specs/research/v0.0.3-anthropic-protocol.md §3/§4（anthropic SSE wire 格式）
 *
 * v0.0.8 扩展（task-5 必做）：按 **request body 的 model 字段** 切换剧本：
 *   - mock:text    → 纯文本回复（"你好，我是助手"）
 *   - mock:tool    → 首轮 text+tool_use(bash echo)；收到 tool_result 后 → 续答文本
 *   - mock:error   → 流中推 error（HTTP 500 + SSE error event）
 *   - mock:compact → 返回足够长文本（或配合 seed 长历史触发 char 估算超阈值）
 *   - 其他 model   → 退化为 v0.0.3 默认剧本（thinking+text，兼容既有 mock-llm.test.ts）
 *
 * BUG-002 修复（[fixed] 2026-06-21）：按 request body 的 **stream 字段** 分流——
 *   - stream:true  → 返 SSE 流（client.stream 用，chat 正常路径）
 *   - stream:false → 返标准 anthropic JSON body（client.call 用，compact 路径）
 * 之前不分流导致 compact 调 client.call 时 resp.json() 解析 SSE 失败 → run error。
 *
 * 各阶段 emit 停留 ≥1s（D3，便于 e2e 抓 loading 阶段）：在 text_delta / tool_use 等之间
 * `await sleep(~1000)`。
 *
 * 不读 url/credentials（永远命中剧本），适合自动化测试。
 *
 * 剧本构造函数已拆到 mock-llm-scenarios.ts（单文件 ≤300 行约束）。
 */
import type { CanonicalRequest } from './llm/protocol';
import {
  buildCompactNonStreaming,
  buildCompactScenario,
  buildComputerScenario,
  buildErrorSse,
  buildMockAnthropicSse,
  buildNonStreamingMessage,
  buildTextScenario,
  buildToolScenario,
} from './mock-llm-scenarios';

/**
 * computer use directive 正则：user message 含 @@cu:<json>@@ → 出单个 `computer` tool_call。
 * <json> = tool arguments（如 {"action":"screenshot"} / {"action":"click","element_index":3}）。
 * 非贪婪 (.*?) 匹配 @@cu: 与随后第一个 @@ 之间的 json（directive 单行，json 内无裸 @@）。
 */
const CU_DIRECTIVE_RE = /@@cu:(.*?)@@/;

/**
 * 从 request 的 user message content 提取 computer use directive 的 json 串（未解析）。
 * 找到第一个 @@cu:<json>@@ → 返 <json>；无 → undefined。
 * directive 由 AT case 写进 user 消息，跨 turn 持续存在（用 lastMessageIsToolResult 判 turn）。
 */
function extractComputerDirective(init: RequestInit | undefined): string | undefined {
  if (!init?.body) return undefined;
  try {
    const body = JSON.parse(init.body as string) as CanonicalRequest;
    for (const m of body.messages ?? []) {
      if (m.role !== 'user') continue;
      for (const b of m.content ?? []) {
        if (
          b &&
          typeof b === 'object' &&
          (b as { type?: string }).type === 'text' &&
          typeof (b as { text?: unknown }).text === 'string'
        ) {
          const match = (b as { text: string }).text.match(CU_DIRECTIVE_RE);
          if (match) return match[1];
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** mock 剧本之间的停留时间（ms）—— D3：≥1s 便于 e2e 抓 loading 阶段 */
const STEP_DELAY_MS = 1000;

/** sleep helper（在 ReadableStream start 内不可直接 await，需用 controller 异步推） */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 从 fetch 参数解析 modelId（读 request body 的 model 字段） */
function extractModelId(init?: RequestInit): string | undefined {
  if (!init?.body) return undefined;
  try {
    const body = JSON.parse(init.body as string) as { model?: string };
    return body.model;
  } catch {
    return undefined;
  }
}

/**
 * 从 fetch 参数解析 stream 字段（client.call 走非流式 false；client.stream 走 true）。
 * BUG-002 修复：mock 必须按 stream 分流，非流式返标准 JSON。
 * client.prepare() 把 stream 放进 body.params.stream（见 client.ts prepare + protocol-encode）。
 *
 * 无 body（裸 fetch 调用，如 mock-llm.test.ts 默认剧本测试）→ 默认 stream:true
 * （SSE），兼容既有测试断言（mock 默认 = anthropic wire SSE）。
 * 有 body 但解析不出 stream 字段 → 默认 stream:false（保守，匹配 client.call 行为）。
 */
function extractStream(init?: RequestInit): boolean {
  if (!init?.body) return true; // 无 body：兼容旧测试默认 SSE
  try {
    const body = JSON.parse(init.body as string) as { stream?: boolean; params?: { stream?: boolean } };
    if (typeof body.stream === 'boolean') return body.stream;
    if (body.params && typeof body.params.stream === 'boolean') return body.params.stream;
    return false; // 有 body 但无 stream 字段：保守非流式
  } catch {
    return false;
  }
}

/** 判断 request messages 中最后一条是否为 role=tool（tool_result）—— mock:tool 续轮判定 */
function lastMessageIsToolResult(init?: RequestInit): boolean {
  if (!init?.body) return false;
  try {
    const body = JSON.parse(init.body as string) as CanonicalRequest;
    const last = body.messages[body.messages.length - 1];
    return !!last && last.role === 'tool';
  } catch {
    return false;
  }
}

/** createMockFetch 选项 */
export interface CreateMockFetchOptions {
  /**
   * 各阶段 emit 停留时间（ms）。D3 要求 ≥1s 便于 e2e 抓 loading 阶段。
   * 单元测试可传 0 避免 testTimeout 超时（既有 mock-llm.test.ts 默认行为）。
   * 默认 1000（满足 D3）。
   */
  stepDelayMs?: number;
}

/**
 * 构造一个 mock fetch（typeof fetch 兼容签名）。
 * - model 命中 mock:* 剧本 → 返对应 SSE 流（各阶段停留 stepDelayMs）
 * - model 缺省/未知 → 退化 v0.0.3 默认剧本（兼容既有 mock-llm.test.ts）
 * - mock:error → HTTP 500 + SSE error event
 *
 * BUG-002 修复：按 body.stream 分流：
 *   - stream:false（client.call，compact 用）→ 标准 anthropic JSON body
 *   - stream:true（client.stream，chat 用）→ SSE 流
 *
 * @param opts.stepDelayMs 各阶段停留（默认 1000ms 满足 D3；单元测试传 0）
 */
export function createMockFetch(opts: CreateMockFetchOptions = {}): typeof fetch {
  const stepDelay = opts.stepDelayMs ?? STEP_DELAY_MS;
  return (async (_url: URL | string, init?: RequestInit) => {
    const model = extractModelId(init);
    const isStream = extractStream(init);
    const enc = new TextEncoder();

    // ── mock:error 直接返 500（无论 stream，error 场景都是 SSE error event）──
    if (model === 'mock:error') {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await sleep(stepDelay);
          controller.enqueue(enc.encode(buildErrorSse()));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 500,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    // ── 非流式（stream:false，client.call 走此路：compact 用）──
    // BUG-002 修复：返标准 anthropic JSON body，而非 SSE 流。
    if (!isStream) {
      let json: string;
      switch (model) {
        case 'mock:compact':
          // compact 路径：返含 <summary>...</summary> 的 JSON
          json = buildCompactNonStreaming();
          break;
        case 'mock:text':
          json = buildNonStreamingMessage('你好，我是助手');
          break;
        case 'mock:tool':
          json = buildNonStreamingMessage(
            lastMessageIsToolResult(init) ? '工具执行完毕，结果如上。' : '我来执行一个命令',
            lastMessageIsToolResult(init) ? 'end_turn' : 'tool_use',
          );
          break;
        default:
          // 默认兼容剧本（thinking + text，非流式只取 text 部分）
          json = buildNonStreamingMessage('你好');
      }
      return new Response(json, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // ── 流式（stream:true，client.stream 走此路）──
    // 选剧本（默认 v0.0.3 兼容版）
    let body: string | undefined;
    // [v0.0.105] computer use directive 优先（不看 model；user 含 @@cu:<json>@@ 即触发）：
    //   首轮出单个 name='computer' tool_call（arguments=json）→ tool 走 mock native port →
    //   收 tool_result 后续轮 end_turn。json 解析失败 → buildComputerScenario 返 undefined，回退默认剧本。
    const cuJson = extractComputerDirective(init);
    if (cuJson !== undefined) {
      body = buildComputerScenario(cuJson, lastMessageIsToolResult(init));
    }
    if (body === undefined) {
      switch (model) {
        case 'mock:text':
          body = buildTextScenario();
          break;
        case 'mock:tool':
          body = buildToolScenario(lastMessageIsToolResult(init));
          break;
        case 'mock:compact':
          body = buildCompactScenario();
          break;
        default:
          body = buildMockAnthropicSse();
      }
    }

    // 把 body 按帧切（双 \n 分隔），逐帧 enqueue 之间 sleep
    const frames = body.split('\n\n').map((f) => f + '\n\n');
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const frame of frames) {
          if (frame.trim()) {
            controller.enqueue(enc.encode(frame));
            // 内容帧之间停留（D3：≥1s 便于 e2e 抓 loading 阶段；单元测试传 0）
            await sleep(stepDelay);
          }
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
}
