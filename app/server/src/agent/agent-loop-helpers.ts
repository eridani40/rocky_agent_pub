/**
 * AgentLoop 内部 helpers（agent-loop 拆分模块，无状态纯函数）
 * 参考: specs/tech/version_logs/v0.0.8/change_log.md §4
 *
 * 职责：把 RunState 类型 + 各阶段用到的纯函数抽离，让 agent-loop.ts 主类更聚焦。
 *   - RunState：游标 + snapshot + 退出标记
 *   - toMessageInput：业务 Message → MessageInput（剥信封）
 *   - toProtocolMessage：业务 Message → protocol Message（剥离 sessionId/runId/sender）
 *   - extractToolCalls：从 assistant content 提取 ToolCallBlock[]
 *   - signatureOf：tool_calls 签名（doom_loop 检测用）
 *   - lastNEqual：判定数组末尾连续 N 个元素是否全等于 value
 *   - buildTraceName：[v0.0.61] 拼 langfuse trace name（kind + sid6 + input10）
 */
import type {
  ContentBlock,
  Message,
  MessageInput,
  TextBlock,
  ToolCallBlock,
} from '../message/types';
import type { ContextSnapshot } from './context-types';
import type { StopReason } from './agent-event-types';
import type { RunErrorInfo } from './session-store-types';

/** agent loop 内部 RunState 游标 */
export interface RunState {
  /** 已经 ingest 到 ContextEngine 的最后一个 message id */
  ingestUpTo: string | null;
  /** 已经发送给 LLM 的最后一个 message id（始终 ≤ ingestUpTo） */
  llmUpTo: string | null;
  /** 当前 ContextSnapshot（每次 assemble 后更新） */
  snapshot: ContextSnapshot | null;
  /** 当前迭代步数 */
  step: number;
  /** 是否应该退出循环 */
  done: boolean;
  /** 退出原因 */
  stopReason?: StopReason;
  /**
   * [v0.0.25 rev2] run 失败结构化错误（仅 stopReason="error" 时填）。
   * 由 catch ClassifiedLlmError 派生（buildRunErrorFromThrowable）；persistRun 写 Run/RunRecord。
   * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §9.1
   */
  error?: RunErrorInfo;
  /**
   * ② LLM 请求产出的 assistant content（② → ③ 之间传递，避免从 snapshot 反查）。
   * 每次 ② 准入后写入，③ 据此提取 toolCalls；无 tool_call 时 ③ 不读它。
   */
  lastAssistantContent?: ContentBlock[];
  /**
   * [v0.0.25 task 5 gap 1] LLM 错误状态（跨 iteration overlay 继承，spec §5）。
   * agent loop 一次 run 内由 LlmCaller.invoke 写入（maxTokensOverlay / prefillPartial / ...），
   * run 结束销毁（不落盘，spec §6.3）。callLLMViaInvoker 读此字段构造 InvokeContext。
   */
  llmErrorState?: import('../llm/caller/llm_error_state').LlmErrorState;
  /**
   * [v0.0.361 §1.4] full reminder 开关（零持久化，run 结束销毁）。
   *   - undefined 视同 true：run 开始新建 RunState 天然 full（injector full 分支消费后置 false，T3）
   *   - summary.version 变化 → run-react-loop 置回 true（T1）
   * 参考: specs/tech/version_logs/v0.0.361/change_plan.md §1.4
   */
  useFullReminder?: boolean;
}

/** 业务 Message → MessageInput（剥信封字段 createdAt/updatedAt/version） */
export function toMessageInput(m: Message): MessageInput {
  return {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role,
    content: m.content,
    ...(m.runId !== undefined ? { runId: m.runId } : {}),
    ...(m.sender !== undefined ? { sender: m.sender } : {}),
    ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
  };
}

/**
 * 业务 Message → protocol Message（剥离 sessionId/runId/sender 等信封字段）。
 *
 * [v0.0.50 T1] sender 展平（a2a 前缀渲染）职责迁到 llm/logical-view.ts 的
 * toLogicalMessages。本函数不再渲染前缀——调用方需先 toLogicalMessages 把 sender
 * 展平入 content（prefix 拼到首块 TextBlock 前），再 map 本函数剥信封成 {id,role,content}。
 * 这样前缀只渲染一次（避免双前缀），wire body byte-level 与 v0.0.49 一致。
 * 参考: specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md §3.4（调用点表）
 *
 * [v0.0.45] mention 走内嵌 XML tag（`<mention type="..." path="..."/>`）方案：
 * server 不解析、原样发 LLM；content 已在落库时保存 tag 字符串，此处零转换。
 */
export function toProtocolMessage(
  m: Message,
): { id: string; role: Message['role']; content: ContentBlock[] } {
  return { id: m.id, role: m.role, content: m.content };
}

/** 从 assistant message content 提取 ToolCallBlock[] */
export function extractToolCalls(blocks: ContentBlock[]): ToolCallBlock[] {
  return blocks.filter((b): b is ToolCallBlock => b.type === 'tool_call');
}

/** tool_calls 签名（doom_loop 检测）：name + arguments JSON */
export function signatureOf(calls: ToolCallBlock[]): string {
  return calls.map((c) => `${c.name}:${JSON.stringify(c.arguments)}`).join('|');
}

/** 判定数组末尾连续 N 个元素是否全等于 value */
export function lastNEqual<T>(arr: T[], n: number, value: T): boolean {
  if (arr.length < n) return false;
  for (let i = arr.length - n; i < arr.length; i++) {
    if (arr[i] !== value) return false;
  }
  return true;
}

/**
 * [v0.0.61] 拼 langfuse trace name（避免 unnamed-trace）。
 * 格式：`${kind} ${sid6} ${input10}`（空格分隔），例 `studio-leader 01KWBP helloworld`。
 *   - kind = sessionKind ?? 'session'（兜底，避免 langfuse UI 显示 unnamed-trace）
 *   - sid6 = sessionId.slice(0, 6)
 *   - input10 = 首条 user 消息所有 TextBlock.text 拼接，`\s+`→单空格 trim 后 slice(0, 10)；
 *     无 user 消息则空串（trailing space 由 trimEnd 处理）
 *
 * [v0.0.78.bug] 加第 4 参 runKind（forked 用途标识）：
 *   - runKind 非空且 ≠ 'main' → kind 段拼 [runKind] 后缀：`studio-leader[summary] 01KWBPa3 helloworld`
 *     / `studio-leader[consolidate] ...`（langfuse UI 区分主对话 vs forked 任务）
 *   - runKind 缺省 / 'main' → 退原格式（main loop 视觉零回归）
 *   - runKind 段紧贴 kind 不加空格（与 sid6 之间仍单空格分隔）
 *
 * 从 LoopObservability 抽离为纯函数（agent-loop-observability.ts 超 300 行拆分）。
 */
export function buildTraceName(
  sessionKind: string | undefined,
  sessionId: string,
  triggerMessages: Message[],
  runKind?: string,
): string {
  const kindRaw = sessionKind ?? 'session';
  // [v0.0.78.bug] runKind 段：forked 任务（summary / consolidate）显式标，main loop 退原格式
  const kind = runKind && runKind !== 'main' ? `${kindRaw}[${runKind}]` : kindRaw;
  const sid6 = sessionId.slice(0, 6);
  const firstUser = triggerMessages.find((m) => m.role === 'user');
  let inputText = '';
  if (firstUser) {
    const text = firstUser.content
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    inputText = text.replace(/\s+/g, ' ').trim().slice(0, 10);
  }
  return `${kind} ${sid6} ${inputText}`.trimEnd();
}
