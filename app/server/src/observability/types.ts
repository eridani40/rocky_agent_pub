/**
 * Observability 类型定义 — Trace/Generation/Span 全量字段 + Handle。
 * 参考: specs/tech/agent/observability/[P0]overall.md §5（全量字段）+ §6（Handle 类型）
 *       specs/tech/agent/session/[P0]session_usage.md §1（Usage）
 *       specs/tech/agent/message/[P0]agent_message_interface.md（Message/ToolResultBlock）
 *       specs/tech/agent/tools/[P0]overall.md（ToolDefinition）
 *
 * 设计：
 *   - 接口独立于任何 SDK（Langfuse 只在 LangfuseAdapter 内映射）
 *   - 三类对象（Trace/Generation/Span）各自记录完整 input/output/metadata，不截断
 *   - Handle 携带父子关系，backend 据此建树（任意深度嵌套）
 *
 * 类型决策：参数/工具参数保留 Record<string, unknown>（外部数据原样透传），
 *           其余类型引用 Message/Usage/ToolDefinition/ToolResultBlock，不用 any。
 */
import type { Message, ToolResultBlock, Usage } from '../message/types';
import type { ToolDefinition } from '../tools/types';
// [v0.0.80.t1] GenInput.contextWindowUsage（change_plan §2.5 改进#2）
import type { ContextWindowUsage } from '../message/types';

// ============================================================
// 1. Handle（overall §6）
// ============================================================

/** Trace 句柄（= run） */
export interface TraceHandle {
  kind: 'trace';
  id: string;
}

/** Span 句柄（step span 或 tool span）。parent 决定挂载位置。 */
export interface SpanHandle {
  kind: 'span';
  id: string;
  parent: TraceHandle | SpanHandle;
}

/** Generation 句柄（= 一次 LLM 调用） */
export interface GenHandle {
  kind: 'gen';
  id: string;
  parent: SpanHandle | TraceHandle;
}

/**
 * [v0.0.68 R7] langfuse trace/span/generation 级别（用于 markTraceError 等）。
 * 对齐 langfuse SDK 的 level 取值（'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR'）。
 */
export type ObservabilityLevel = 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';

// ============================================================
// 2. Trace（= run，overall §5.1）
// ============================================================

/** startTrace 入参 */
export interface TraceStart {
  /** = runId（Langfuse trace.id 自定义） */
  id: string;
  sessionId: string;
  /** agent name / session name */
  name?: string;
  /** 触发本 run 的输入消息（= run_start.inputMessageIds 对应 message） */
  input?: Message[];
  /** run 最终产出（endTrace 时填，含最后 assistant message） */
  output?: Message[];
  metadata: TraceMetadata;
}

/** endTrace 入参 */
export interface TraceEnd {
  /** 覆盖 metadata（如 stopReason） */
  metadata?: Partial<TraceMetadata>;
  /** 最终输出消息 */
  output?: Message[];
}

/** Trace metadata（全量） */
export interface TraceMetadata {
  runId: string;
  sessionId: string;
  /** P0 不建关联，字段预留（session_usage §6） */
  parentSessionId?: string;
  agentName?: string;
  /** run_start 传入 */
  inputMessageIds: string[];
  /** = modelConfig.modelId */
  modelId: string;
  /** e.g. "anthropic" */
  providerImpl?: string;
  /** e.g. "anthropic_messages" */
  protocolImpl?: string;
  /** config.tools 的 name 清单 */
  toolNames: string[];
  /** system prompt 内容 hash（追踪 prompt 变更影响） */
  systemPromptHash?: string;
  appVersion?: string;
  /** endTrace 填（= RunState.stopReason） */
  stopReason?: string;
  tags?: string[];
}

// ============================================================
// 3. Generation（= LLM 调用，overall §5.2，信息最密集）
// ============================================================

/** startGeneration 入参 */
export interface GenStart {
  parent: SpanHandle | TraceHandle;
  /** = modelConfig.modelId */
  model: string;
  /**
   * [v0.0.50] generation 类型判别字段：
   *   - `'logical'`（默认，向后兼容）：业务视图 input（messages + system + tools + params）。
   *   - `'physical'`：protocol.encode 后的 wire body 载荷（独立 generation，不带 usage/output），
   *     用于对账"业务视图"与"LLM 实际收到 wire body"的差异。
   *
   * 同一 step span 内可调两次 startGeneration（logical + physical），name 后缀 `-logical` /
   * `-physical` 区分两条 generation；二者共享 parent（= step span），handle 互相独立。
   *
   * 参考: specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md §4.2
   */
  kind?: 'logical' | 'physical';
  /**
   * [v0.0.50 §4.3] generation 名称（caller 完全控名，方案 A）。
   * 传入时优先使用（如 `llm-1-logical` / `llm-1-physical`，N = iteration）；
   * 不传时由 adapter fallback（logical→`'llm'` / physical→`'llm-physical'`，向后兼容老 trace）。
   *
   * 命名格式（AT 硬要求）：`llm-${N}-logical` / `llm-${N}-physical`，同 iteration 内成对（同 N）。
   * 参考: specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md §4.3
   */
  name?: string;
  /**
   * logical 用（既有）：完整 LLM 输入（assemble 后 snapshot）。
   * kind='physical' 时此字段被忽略，改用 physicalInput。
   * v0.0.50 起改为 optional 以允许 physical-only GenStart。
   */
  input?: GenInput;
  /**
   * [v0.0.50] physical 用：protocol.encode 后的 wire body（任意形状，由调用方传入）。
   * 仅 kind='physical' 时使用；logical 不读此字段。
   */
  physicalInput?: unknown;
  /** 开始时间戳（duration 计算） */
  startTime?: Date;
}

/** endGeneration 入参 */
export interface GenEnd {
  gen: GenHandle;
  /** LLM 真正产出的回复。error 路径（status='error'）可省略 */
  output?: GenOutput;
  /** session_usage §1 全字段（token 拆分 + char + cost） */
  usage: Usage;
  metadata: GenMetadata;
  /** 结束时间戳 */
  endTime?: Date;
  /**
   * [v0.0.25 BUG-001 §3] 调用状态。'success'（默认，正常完成）或 'error'
   * （throw / 不可恢复错误，写 metadata.errorCategory + retry_chain，不再笼统 LOOP_ERROR）。
   * 不传按 'success' 处理（向后兼容）。
   */
  status?: 'success' | 'error';
  /**
   * [v0.0.25 BUG-001 §3] error 路径的错误分类（LlmErrorCategory 枚举字符串值）。
   * 类型用 string 而非 import LlmErrorCategory，避免 observability → llm/caller 反向依赖
   * （types.ts 仅依赖 message/tools）。task 5 接线时传 classified.category。
   */
  errorCategory?: string;
}

/** Generation input = 完整 LLM 输入（assemble 后 snapshot） */
export interface GenInput {
  /** assembled system prompt（完整内容） */
  system: string;
  systemCharCount: number;
  /** 发往 LLM 的全部 history（assemble 后完整 snapshot），非最后一条 message */
  messages: Message[];
  /** = snapshot.inputCharCount */
  messagesCharCount: number;
  /** = snapshot.tools（LLM 可调工具清单） */
  tools: ToolDefinition[];
  params: GenParams;
  modelId: string;
  /** 第几轮 LLM 调用（全局） */
  iteration: number;
  /**
   * [v0.0.80.t1] 触发时 context window 用量（来源：snapshot.contextWindowUsage，stage-llm 注入）。
   * 让 LLM trace meta 携带本轮 context window 用量，便于反查触发规模 / compact 阈值监测。
   * 缺省（旧调用点 / UT fixture）→ undefined（optional 向后兼容）。
   * 参考: change_plan §2.5 改进#2（主 loop 每次 LLM 请求 meta 带 context window usage）
   */
  contextWindowUsage?: ContextWindowUsage;
}

/** LLM 调用参数（原样透传，保留扩展键） */
export interface GenParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  [k: string]: unknown;
}

/** Generation output = LLM 真正产出的完整回复 */
export interface GenOutput {
  /** LLM 返回的完整 message（含 text/reasoning/tool_call blocks） */
  message: Message;
  /** LLM stop_reason（"stop"/"tool_use"/...） */
  stopReason: string;
}

/** Generation metadata（全量） */
export interface GenMetadata {
  iteration: number;
  /** 所属 step span */
  step: number;
  /** = usage.input_cache_read */
  cacheReadTokens: number;
  /** = usage.input_cache_write */
  cacheWriteTokens: number;
  /** LLM 调用耗时（start→end） */
  durationMs?: number;
  /**
   * [v0.0.25 BUG-001 §3] 物理层 wire body（onWire 钩子记录的 protocol.encode 产出，
   * 与逻辑层 GenInput diff 对账）。onWire 未注入时 undefined（向后兼容）。
   *
   * @deprecated v0.0.50 起停写——物理层 wire body 改走独立 physical generation（kind='physical'
   * + physicalInput 载荷）。本字段声明保留（optional，只读）以兼容旧 trace / 旧读取代码，
   * **新代码写路径全部走独立 physical generation，不再填入此字段**。
   * 参考: specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md §4.4
   */
  physicalWireBody?: unknown;
  /**
   * [v0.0.25 BUG-001 §3] 错误分类（仅 status='error' 写入，LlmErrorCategory 字符串值）。
   * 类型 string 避免反向依赖 llm/caller。
   */
  errorCategory?: string;
  /**
   * [v0.0.25 BUG-001 §3] 重试链。每项 = { providerId, keyRef?, attempt, category?, delayMs? }。
   * 仅 invoke 内多次 attempt 时非空。
   */
  retryChain?: RetryAttempt[];
}

/**
 * [v0.0.25 BUG-001 §3] 单次 attempt 重试记录（GenMetadata.retryChain 元素）。
 */
export interface RetryAttempt {
  providerId: string;
  /** key 引用名（如 'default' / 'alt1'） */
  keyRef?: string;
  /** 第几次 attempt（1-based） */
  attempt: number;
  /** 本次 attempt 的错误分类（成功 attempt 可省略） */
  category?: string;
  /** 本次 attempt 触发重试前的退避延时（ms） */
  delayMs?: number;
}

// ============================================================
// 4. step Span（= iteration，overall §5.3）
// ============================================================

/** startSpan(step) 入参 */
export interface StepSpanStart {
  /** step 直接挂 trace */
  parent: TraceHandle;
  /** `step ${N}` */
  name: string;
  input?: { step: number };
  metadata: StepSpanMetadata;
  startTime?: Date;
}

/** endSpan(step) 入参 */
export interface StepSpanEnd {
  metadata?: Partial<StepSpanMetadata>;
  endTime?: Date;
}

/** step Span metadata */
export interface StepSpanMetadata {
  /** = RunState.step */
  step: number;
  /** 本 step 起始游标（agent_loop §7） */
  ingestUpTo: string | null;
  llmUpTo: string | null;
  /** 本 step ingest 的新消息数 */
  newMessageCount: number;
  /** 本 step 是否含 tool 执行 */
  hasToolCall: boolean;
}

// ============================================================
// 5. tool Span（= 单次 tool 执行，overall §5.4）
// ============================================================

/** startSpan(tool) 入参 */
export interface ToolSpanStart {
  /** 挂 step span，或另一 tool span（深嵌套） */
  parent: SpanHandle;
  /** `tool:${toolName}` */
  name: string;
  input: ToolSpanInput;
  metadata: ToolSpanMetadata;
  startTime?: Date;
}

/** endSpan(tool) 入参 */
export interface ToolSpanEnd {
  output: ToolSpanOutput;
  metadata?: Partial<ToolSpanMetadata>;
  endTime?: Date;
}

/** tool Span input（完整 tool call arguments） */
export interface ToolSpanInput {
  /** ToolCallBlock.id */
  toolCallId: string;
  toolName: string;
  /** 完整 tool call arguments（LLM 产出，原样） */
  arguments: Record<string, unknown>;
}

/** tool Span output（完整 tool result） */
export interface ToolSpanOutput {
  /** 完整 tool result（content 原样） */
  result: ToolResultBlock;
  isError: boolean;
}

/** tool Span metadata */
export interface ToolSpanMetadata {
  step: number;
  toolCallId: string;
  /** [v0.0.101] HITL 悬挂子状态（取代退役的 needsApproval boolean）。
   *  取值：'pending'（悬挂中，等用户回填）/ 'resolved'（已回填）；
   *  非 HITL tool 缺省视普通执行（不写本字段）。 */
  hitlState?: 'pending' | 'resolved';
  durationMs?: number;
}

// ============================================================
// 6. startSpan/endSpan 联合入参（overall §6：同一方法签名）
// ============================================================

export type SpanStart = StepSpanStart | ToolSpanStart;
export type SpanEnd = StepSpanEnd | ToolSpanEnd;
