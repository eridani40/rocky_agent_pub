/**
 * Agent Loop Base — 机制层原语（v0.0.15 T6 新建）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md（§2 §5 §6）
 *
 * 定位（base §1）：三种 mode（eager-drain / lazy-drain / forked）共享的**单轮执行积木 + 循环契约**。
 * 本文件只提供**纯函数原语**，不做副作用/不写 store/不转状态机（副作用归 mode）。
 *
 * 原语清单（对齐 base §2 §5 §6）：
 *   - `callLLM(input)` 流式 LLM 调用（chunk 循环中断 + emit + 聚合 message/usage）
 *   - `executeTools(input)` 工具执行（allowedTools 门控 + 每 step 前中断检查 + emit）
 *   - `isInterrupted(controller)` 中断单条件判定
 *   - `checkDoomLoop(toolCalls, recentSigs)` 连续 N 轮同签名检测
 *   - `checkMaxIter(step, maxIter)` 最大迭代检测
 *   - `LoopStateBase` 类型（§4 共享字段：step/done/stopReason/snapshot/lastAssistantContent）
 *
 * 设计原则（base §1.2 D1）：策略注入形态——提供原语函数，mode 自己写 while 调用。
 * 不用模板方法（mode 循环结构差异大）。
 */
import type { Message, ToolCallBlock, ToolResultBlock, Usage, ContentBlock } from '../message/types';
import type { CanonicalRequest, StreamEvent } from '../llm/protocol';
import type { ToolDefinition, PendingToolCall } from '../tools/types';
import type { ContextSnapshot } from './context-types';
import type { StopReason, AgentEvent } from './agent-event-types';
import type { AbortControllerHandle } from './agent-interface';
import type { RunKind } from '../../../shared/src/types/session-kind';
import type { ChildProcessRegistry } from '../tools/child-process-registry';
import { StreamConsumer } from './agent-loop-stream';
// [v0.0.25 task 5] LlmCaller 接入：callLLM 改为可选走 invoke 路径
import type { LlmErrorState } from '../llm/caller/llm_error_state';
import type { InvokeContext, InvokeResponse } from '../llm/caller/llm_caller';

// ============================================================
// §4 LoopStateBase（共享字段；mode 各自扩展游标）
// ============================================================

/**
 * Loop 共享状态字段（base §4）。
 * mode 在此基础上扩展：
 *   - eager-drain：+ ingestUpTo / llmUpTo（store 游标，不变量 llmUpTo ≤ ingestUpTo）
 *   - forked：+ messages buffer（内存追加，无 store 游标）
 */
export interface LoopStateBase {
  /** 当前迭代步数 */
  step: number;
  /** 是否退出 */
  done: boolean;
  /** 退出原因（§9 StopReason） */
  stopReason?: StopReason;
  /** 当前上下文快照（eager=assemble 产出；forked=内存组装） */
  snapshot: ContextSnapshot | null;
  /** ②→③ 传递的 assistant content，避免反查 snapshot */
  lastAssistantContent?: ContentBlock[];
  /** [v0.0.25] LLM 错误状态（跨 iteration overlay，spec §5 + llm_request_config §2）。不落盘（§6.3）。可选：未传时 callLLM 走旧 client.stream 路径（向后兼容）。 */
  llmErrorState?: LlmErrorState;
}

// ============================================================
// §5 isInterrupted（中断单条件原语）
// ============================================================

/**
 * 中断判定原语（base §5 / agent_interrupt §2.1 v1.5）。
 * 单一内存条件 `controller.aborted`（O(1) 读），不读 store/state/currentRunId。
 *
 * @param controller 内存对象 { runId, aborted }（manager 创建注入）
 * @returns controller.aborted
 */
export function isInterrupted(controller: AbortControllerHandle): boolean {
  return controller.aborted;
}

// ============================================================
// §6 退出检查原语（checkDoomLoop / checkMaxIter）
// ============================================================

/** doom_loop 检测阈值（连续 N 轮同签名） */
const DOOM_LOOP_THRESHOLD = 3;

/**
 * doom_loop 检测（base §6）：连续 N(=3) 轮 tool_calls 签名全相同。
 *
 * @param toolCalls 本轮 tool_calls（用于算签名）
 * @param recentSigs 近期签名缓冲数组（**会原地 push 当前签名**，调用方每次 runLoop 开始清空）
 * @returns 命中 doom_loop=true
 */
export function checkDoomLoop(toolCalls: ToolCallBlock[], recentSigs: string[]): boolean {
  const sig = signatureOf(toolCalls);
  recentSigs.push(sig);
  return (
    recentSigs.length >= DOOM_LOOP_THRESHOLD &&
    lastNEqual(recentSigs, DOOM_LOOP_THRESHOLD, sig)
  );
}

/**
 * 最大迭代检测（base §6）。
 *
 * @param step 当前迭代步数
 * @param maxIter 上限（eager=config.maxIterations（来源 buildSessionConfigFromDeps：subagent=spawn maxIter / 顶层=DEFAULT_MAX_ITERATIONS）；forked=option.maxIter，=1 即单次终结）
 * @returns step >= maxIter
 */
export function checkMaxIter(step: number, maxIter: number): boolean {
  return step >= maxIter;
}

/** tool_calls 签名（doom_loop 检测用）：name + arguments JSON */
function signatureOf(calls: ToolCallBlock[]): string {
  return calls.map((c) => `${c.name}:${JSON.stringify(c.arguments)}`).join('|');
}

/** 判定数组末尾连续 N 个元素是否全等于 value */
function lastNEqual<T>(arr: T[], n: number, value: T): boolean {
  if (arr.length < n) return false;
  for (let i = arr.length - n; i < arr.length; i++) {
    if (arr[i] !== value) return false;
  }
  return true;
}

// ============================================================
// §2.1 callLLM（流式 LLM 调用原语）
// ============================================================

/**
 * callLLM 输入参数（base §2.1，策略注入形态）。
 *
 * mode 注入：
 *   - client + modelId（来自 SessionConfig）
 *   - messages（eager=snapshot.messages；forked=内存 buffer 组装后）
 *   - tools（toolDefinitions；forked 空 array 时不传 tools 字段）
 *   - controller（manager 创建的 { runId, aborted } 内存对象）
 *   - emit（mode 决定发哪个 group / 是否发；callLLM 不感知 group）
 *   - observabilityStartGen / observabilityEndGen（可选埋点 hook，base 不耦合 LoopObservability）
 */
export interface CallLLMInput {
  /** session id（事件公共字段） */
  sessionId: string;
  /** run id（事件公共字段） */
  runId: string;
  /** LLM client（提供 stream） */
  client: { stream(req: CanonicalRequest, signal: AbortSignal): AsyncIterable<StreamEvent> };
  /** model id */
  modelId: string;
  /** 已组装的 protocol messages（含 system；forked 前缀 system+snapshot+user） */
  messages: { id: string; role: Message['role']; content: ContentBlock[] }[];
  /** tool 声明（=[] 时不传 tools 字段；>0 时原样传 LLM） */
  tools: ToolDefinition[];
  /** manager 注入的内存 controller */
  controller: AbortControllerHandle;
  /** 流式事件 emit 回调（mode 决定 group/开关） */
  emit: (event: AgentEvent) => void;
  /** assistant message id（caller 预分配的 ULID） */
  messageId: string;
  /** [v0.0.13 S3] snapshot.inputCharCount（usage.inputCharCount 写入用） */
  inputCharCount: number;
  /**
   * [v0.0.15 BUG-002] runKind：透传给 StreamConsumer，每条 emit 事件自动附上
   * （agent_event.md §2 AgentEventBase.runKind 必填）。caller（eager/forked）注入对应 runKind。
   */
  runKind: RunKind;
  /**
   * [v0.0.20] 输出 token 上限（= snapshot.contextWindowUsage.maxOutputTokens）。
   * 透传 CanonicalRequest.params.maxTokens → wire max_tokens。
   */
  maxOutputTokens: number;
  /**
   * stop sequence（EOS 双保险）。
   * SquadChat session（kind.role='squad'）由装配层（build-run-deps）注入 `['<EOS>']`，
   * 透传 CanonicalRequest.params.stop → wire stop_sequences（protocol-encode）。
   * 缺省 undefined → 不加 stop seq 字段（对齐既有行为）。
   */
  stop?: string[];
  /**
   * [v0.0.148] effort 推理强度（canonical 语义键，4 档）。
   * 来源 config.effort（main+forked 共享 session.effort）。
   * 透传 CanonicalRequest.params.effort → encode 注入 output_config.effort。
   * 缺省 undefined → encode 走 default 档（不注入 output_config，向后兼容 forked 不传场景）。
   */
  effort?: 'default' | 'low' | 'high' | 'max';
  /** [v0.0.25 task 5 gap 1] 可选 LlmCaller invoke 入口。传入则走新路径；不传走旧 client.stream（向后兼容）。eager/forked 生产路径均注入。 */
  llmCaller?: { invoke(baseReq: CanonicalRequest, ctx: InvokeContext): Promise<InvokeResponse> };
  /** [v0.0.25 task 5 gap 1] RunState 引用（读 llmErrorState 跨 iteration overlay）。llmCaller 路径必填。 */
  runState?: { llmErrorState?: LlmErrorState };
  /** [v0.0.25 task 5 gap 1] 后台路径标记（true=overload 直接 fail 不重试，防雪崩，forked summary/title 用）。 */
  backgroundPath?: boolean;
  /**
   * [v0.0.25 task 5 gap 3] 可选 observability 端口（langfuse 桥接）。
   * 传入则 invoke 内部调 endGenerationOk/Error（零泄漏）。main 传入时 caller 不再调 obs.endGeneration（避免双调）。
   */
  invokeObservability?: import('../llm/caller/llm_caller').ObservabilityPort;
  /**
   * [v0.0.25 retry-1 P2] 可选 llm_request config（含 fallback_chain）。
   * 传入且 fallback_chain 非空 → invoke 走多 provider fallback（resolveTarget pickFirstAvailableTarget）。
   * 不传或 chain 空 → 走单 target 兜底（向后兼容）。
   */
  llmRequestConfig?: import('../config/llm_request_config').LlmRequestConfig;
  /** [v0.0.25 retry-1 P2] 多 provider 实例表（fallback_chain 命中查找用）。不传 → 只用 client 派生的单 provider。 */
  allProviders?: import('../llm/provider-types').LlmProviderConfig[];
  /** [v0.0.25 retry-1 P2] 健康表（多 provider fallback 用）。不传 → invoke 内部用进程单例。 */
  health?: import('../llm/caller/provider_health_registry').ProviderHealthRegistry;
  /**
   * [v0.0.30] dev 调试日志（llm hook，spec dev-logs §3.1）。
   * 透传到 InvokeContext.logWriter；缺省 undefined → 不写（开关 false 也早 return 零开销）。
   * 由 stage-llm/forked-agent 从 SessionConfig.logWriter 注入。
   */
  logWriter?: import('../dev-logs/log-writer').LogWriter;
  /**
   * [v0.0.347] 模型路由方案（SessionConfig.modelRoutingPlan 透传；分支 2 挂载才有）。
   * 有 routingPlan → invoke 走 routingAttemptLoop（候选决策循环）；缺省 undefined → 现有路径。
   */
  routingPlan?: import('../llm/caller/llm_caller').InvokeContext['routingPlan'];
  /**
   * [v0.0.347] 按 (providerId, modelId) 真实组装 LlmClient 的 builder（routing 多候选模型用）。
   * 缺省 undefined → clientFactory 占位（恒返回 client，向后兼容）。
   * 由 stage-llm 从 SessionConfig.appConfig + pluginManager 注入 buildLlmClient。
   */
  clientBuilder?: (providerId: string, modelId: string) => import('../llm/client').LlmClient;
}

/**
 * callLLM 返回（base §2.1）。
 * - assistantMessage：聚合所有 text/tool_call/reasoning block
 * - usage：per-call usage（caller 决定累计分区）
 */
export interface CallLLMResult {
  assistantMessage: Message;
  usage: Usage | null;
}

/**
 * callLLM 原语（base §2.1）：流式 LLM 调用 + chunk 循环中断 + emit + 聚合。
 *
 * **契约**：
 *   - 流式产出 message_start → text_block_* / reasoning_block_* / tool_call_* → usage_block → message_end
 *   - **每条 emit 前隐式中断检查**（StreamConsumer 不查 controller；中断生效点在 chunk 循环）
 *   - **chunk 循环中断**：局部 `webAbort = new AbortController()`，fetch 用 webAbort.signal；
 *     每个 chunk 检查 `controller.aborted`，命中即 `webAbort.abort()` + break。webAbort 随 callLLM
 *     生灭（局部作用域），controller 保持纯 { runId, aborted } 不派生 Web AbortSignal（D3）。
 *   - fetch 等待期（chunk 循环前）abort 接受短暂延迟（D3）
 *
 * @returns assistant Message + per-call usage；caller 决定 ingest / 累计 / 追加内存
 */
export async function callLLM(input: CallLLMInput): Promise<CallLLMResult> {
  const { sessionId, runId, messageId, client, controller, emit, inputCharCount, runKind, maxOutputTokens } = input;

  const consumer = new StreamConsumer({
    sessionId,
    runId,
    messageId,
    emit,
    inputCharCount,
    runKind,
  });

  // 先 emit message_start（caller 决定发不发；mode 通过 emit 回调控制）
  emit(consumer.messageStart());

  // [v0.0.25 task 5] LlmCaller 接入：注入 llmCaller + runState.llmErrorState 则走新路径
  // （错误归一化 + retry + fallback + 超时 + length overlay，spec §4）；否则走旧 client.stream（向后兼容）。
  if (input.llmCaller && input.runState?.llmErrorState) {
    // 动态 import 避免循环依赖（agent-loop-call-via-invoker 反向依赖 agent-loop-base 的类型）
    const { callLLMViaInvoker } = await import('./agent-loop-call-via-invoker');
    return callLLMViaInvoker(input, consumer);
  }

  // 旧路径：直接 client.stream（chunk 循环中断，base §2.1 v1.2 + agent_interrupt §2.3 v1.5）
  // 局部 Web AbortController；controller 保持纯 { runId, aborted }，不派生 Web AbortSignal（D3）。
  const webAbort = new AbortController();
  const req: CanonicalRequest = {
    modelId: input.modelId,
    messages: input.messages as unknown as CanonicalRequest['messages'],
    ...(input.tools.length > 0 ? { tools: input.tools } : {}),
    // [v0.0.20] 带 maxTokens（输出预算）→ encode 成 wire max_tokens；缺失会兜底 0 导致严格 provider 截断无内容
    // stop seq（EOS 双保险）：装配层（build-run-deps）对 main+squad 注入 ['<EOS>']
    params: {
      stream: true,
      maxTokens: maxOutputTokens,
      ...(input.stop !== undefined && input.stop.length > 0 ? { stop: input.stop } : {}),
      // [v0.0.148] effort 透传（canonical 语义键；映射归 encode）
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
    },
  };
  for await (const evt of client.stream(req, webAbort.signal)) {
    // chunk 循环中断生效点：命中 controller.aborted 即打断 fetch、停止读后续 chunk
    if (controller.aborted) {
      webAbort.abort();
      break;
    }
    // HTTP 2xx 但 body 含 error 事件兜底（主路径非 2xx 由 client.stream 抛错）
    if (evt.type === 'error') {
      throw new Error((evt as { message?: string }).message ?? 'stream error');
    }
    consumer.consume(evt);
  }

  const assistantMessage = consumer.buildMessage(sessionId);
  const usage = consumer.getLastUsage();
  return { assistantMessage, usage };
}

// ============================================================
// §2.2 executeTools（工具执行 + allowedTools 门控原语）
// ============================================================

/**
 * executeTools 输入参数（base §2.2，策略注入形态）。
 *
 * mode 注入：
 *   - toolEngine（执行引擎；门控逻辑在引擎内，见 tools/engine.ts）
 *   - config（SessionConfig 透传给引擎）
 *   - controller（manager 内存对象；每 tool step 前 mode 自己检查，base 此处不嵌入）
 *   - allowedTools（eager=全集；forked=白名单）
 *
 * 注：base §2.2 要求「每个 tool step 前检查 controller」——实际工程在 ToolExecutionEngine
 * 内串行执行，每 tool 间无法插入检查；由 mode 调用 executeTools **前** 单次检查 + 引擎内部
 * 串行性保证（已在执行中的工具不可中断，见 agent_interrupt §4 场景 B/C）。
 *
 * [v0.0.101] toolEngine.execute 签名返 `{ results, pending }`（HITL 悬挂队列）；
 * opts.runId 透传给引擎构造 PendingToolCall.runId（caller 在 ③ 段已知 spec.runId）。
 */
export interface ExecuteToolsInput<TConfig> {
  /** 工具执行引擎 */
  toolEngine: {
    execute(
      config: TConfig,
      toolCalls: ToolCallBlock[],
      allowedTools?: string[],
      opts?: {
        runId?: string;
        childRegistry?: ChildProcessRegistry;
        /** [v0.0.354 T1] 增量结果回调（对齐 engine ExecuteRunCtx.onResult）：每 result 确定即调 */
        onResult?: (result: ToolResultBlock, index: number) => void;
      },
    ): Promise<{ results: ToolResultBlock[]; pending: PendingToolCall[] }>;
  };
  /** session 配置（透传给引擎） */
  config: TConfig;
  /** 待执行 tool_calls */
  toolCalls: ToolCallBlock[];
  /** 白名单（eager=全集；forked=option 白名单） */
  allowedTools: string[];
  /**
   * [v0.0.101] run 上下文（runId 透传给引擎构造 PendingToolCall）。
   * [v0.0.130.hang] 加 childRegistry?（类型对齐 engine ExecuteRunCtx，沿 opts 透传链下沉到
   * tools/engine.ts ctx.childRegistry）
   * [v0.0.354 T1] 加 onResult?（类型对齐 engine ExecuteRunCtx.onResult：每 result 确定即调）
   */
  opts?: {
    runId?: string;
    childRegistry?: ChildProcessRegistry;
    onResult?: (result: ToolResultBlock, index: number) => void;
  };
}

/**
 * executeTools 原语（base §2.2）：工具执行 + allowedTools 门控。
 *
 * **门控逻辑**（实际在 ToolExecutionEngine.execute 内）：
 *   - toolCall.name ∈ allowedTools → 交引擎执行，产出真实 result
 *   - toolCall.name ∉ allowedTools → 引擎构造 not-allowed tool_result（中文文案）
 *   - eager-drain 的 allowedTools=全集（等价不过滤）
 *   - forked 的 allowedTools=option 白名单（拦截）
 *
 * [v0.0.101] 返回 `{ results, pending }`（HITL 钩子产 pending 占位 block + PendingToolCall wrapper）。
 * emit（tool_result_*）由 caller 处理——base.executeTools 只返回 results + pending，
 * caller（mode）按需 emit（eager 在 stageToolExecution 内 emit + ingest；forked 内存追加）。
 *
 * @returns { results, pending }（results 与 toolCalls 等长同序；pending 顺序对应悬挂 toolCalls 相对顺序）
 */
export async function executeTools<TConfig>(
  input: ExecuteToolsInput<TConfig>,
): Promise<{ results: ToolResultBlock[]; pending: PendingToolCall[] }> {
  return input.toolEngine.execute(input.config, input.toolCalls, input.allowedTools, input.opts);
}
