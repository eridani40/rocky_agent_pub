/**
 * Loop Ports — 统一 runReActLoop 的注入 port 契约 + RunSpec 类型
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md §3（port 契约）
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_interface.md §2（RunSpec）
 *
 * 定位：runKind（main/summary/consolidate）差异完全收敛到 RunSpec 字段 + LifecyclePort impl。
 * runReActLoop 骨架对 kind 零感知（无 if kind 字面分支，全参数化）。
 */
import type { Message, Usage, ContentBlock } from '../message/types';
import type { ToolDefinition } from '../tools/types';
import type { RunKind } from '../../../shared/src/types/session-kind';
import type { RunState } from './agent-loop-helpers';
import type { SessionConfig, ContextSnapshot } from './context-types';
import type { ObservabilityAdapter } from '../observability/adapter';
import type { AbortControllerHandle, AgentRun } from './agent-interface';
import type { StopReason, AgentEvent } from './agent-event-types';
import type { LoopObservability } from './agent-loop-observability';
import type { PluginManager } from '../plugin/plugin-manager';
import type { ToolExecutionEngine } from '../tools/engine';
import type { EmitContext } from './agent-loop-emitters';
import type { SessionStore } from './session-store';
import type { ContextEngine } from './context-engine';
import type { SessionStateMachine } from './session-state-machine';
import type { SessionTaskLock } from './session-task-lock';
import type { InboxStore } from './inbox';

// ============================================================
// AgentReplyRequest（async subagent 回报兜底结算对象，v0.0.255）
// ============================================================

/**
 * 本 run drain 到的待回 a2a 请求（source='agent' && needReply=true）。
 * messageId = drain reissue 后的新 id（inReplyTo 才指得回 transcript 真身）。
 * 供 DrainResult / LoopState / A2aReplyTracker / subagent-reply-fallback 四处共用。
 */
export interface AgentReplyRequest {
  messageId: string;
  fromSessionId: string;
}

// ============================================================
// LoopState（runReActLoop 内部状态，复用 RunState 字段 + buffer）
// ============================================================

/**
 * runReActLoop 主循环共享状态（unified §2 + design §2.1）。
 *
 * 继承 RunState（agent-loop-helpers.ts）以保留 helper 复用（obs/checkDoomLoop/callLLM/persistRun）。
 * RunState 字段：ingestUpTo/llmUpTo（main 游标，旁路 run 全 null）/snapshot/step/done/stopReason/
 *   lastAssistantContent/llmErrorState/error。
 *
 * LoopState 额外字段：
 *   - recentToolSigs：doom_loop 检测缓冲（每次 runReActLoop 清空）
 */
export interface LoopState extends RunState {
  /** 最近 N 轮 tool_call 签名（doom_loop 检测缓冲，每次 runReActLoop 清空） */
  recentToolSigs?: string[];
  /**
   * HITL pre-process 信号：tool_reply 处理后仍有 pending。
   * prepareStage drain 出 tool_reply → handleToolReply 编辑占位 + resolve；
   * 仍有 pending（队列非空）→ 置 true → caller（runReActLoop ① 段）emit require_human_input(队首) +
   * state.done=true + stopReason='tool_pending' + break（续 suspended）。
   */
  hitlAfterReplyPending?: boolean;
  /**
   * HITL pre-process 信号：user query 与 pending 共存路径已清空 pendingToolCalls。
   * prepareStage 检测「user query + 有 pending」→ setPendingToolCalls([]) → 置 true。
   * caller 据此可知本轮占位未被编辑（保持 pending 原样发 LLM，INV-1 pair 合法）+ 续 LLM。
   */
  hitlClearedPending?: boolean;
  /**
   * forked 专属：固定 parent snapshot（wireInitState 设 opts.snapshot，整 run 不变）。
   *
   * side_run_builder 读 ctx.prevSnapshot.messages 必须固定，不能用每轮漂移的 state.snapshot
   * （漂移会让多轮 [...prevSnapshot.messages, ...transcript] 重复 reminder/userMessage）。
   * main 不设（= null）。
   */
  parentSnapshot?: ContextSnapshot | null;
  /**
   * run 内跨多次 drain 累积的待回 a2a 请求（v0.0.255 回报兜底结算对象）。
   * 仅由 prepareStage drain 路径写入（只增不判，履约判定归 run 收尾 replySettle）；
   * forked（drainMode='none'）恒空。
   */
  agentReplyRequests?: AgentReplyRequest[];
}

// ============================================================
// RunResult（runReActLoop 返回值，对齐 spec §1.4）
// ============================================================

/** runReActLoop 返回（unified §2 末；与 AgentRun.result 结构一致） */
export interface RunResult {
  answer: string;
  usage: Usage;
  stopReason: StopReason;
  rounds: number;
}

// ============================================================
// LifecyclePort（unified §3.2，D7 并入 FinalizePort → 三 hook）
// ============================================================

/**
 * 生命周期 port：run 结束 + usage 分区 + 中断收尾（D7：FinalizePort 并入）。
 *
 * 现行为（RunLifecyclePort 单 impl，profile.runShape 字段分派，run-lifecycle-port.ts）：
 * main 类 profile：
 *   - onRunEnd = persistRun + 五态机 CAS（markIdle/markError）
 *   - onUsage = updateUsage(sid, {usagePartition: 'current'/'sub', usage: u})（写+推一体）
 *   - onInterrupted = 默认 noop（transcript 收尾归 abort api 4 步——关键不变量）；仅装配
 *     replySettle 的 main subagent run 开「系统代发回报」旁路（见 run-lifecycle-port.ts）
 * 旁路 run（summary/consolidate）：
 *   - onRunEnd = noop（不 persistRun / 不碰五态机）
 *   - onUsage = 跳过（usage 由 caller 按 run 结束总量一次性累计到 'forked' 桶：fork-1 在
 *     runCompact，fork-2 在 post-compact-consolidation；tier2 三 run 零累计——防双计）
 *   - onInterrupted = noop（buffer 随 RunState GC）
 */
export interface LifecyclePort {
  /** run 正常结束（非 interrupted）时调用。main=persistRun+五态机；旁路=noop */
  onRunEnd(state: LoopState): Promise<void>;
  /** usage 分区累计（每次 callLLM 后调）。main→'current'/'sub'；旁路→跳过（caller 总量单计） */
  onUsage(usage: Usage | null): Promise<void>;
  /** 中断收尾（controller.aborted 后调）。transcript 收尾归 abort api 4 步；装配 replySettle 的 main subagent 额外做系统代发回报；旁路=noop（buffer GC） */
  onInterrupted(state: LoopState): Promise<void>;
}

// ============================================================
// drainMode 三态枚举（design §2.1 + §3）
// ============================================================

/**
 * drain 模式三态（design §2.1 + §3 4 维差异表）：
 *   - 'eager'：main，每轮 drain inbox + 游标准入
 *   - 'none'：forked，不 drain（buffer 自带完整上下文）
 *   - 'lazy'：占位 future（run 结束 drain，spec base §1.1 概念定稿暂不实现）
 */
export type DrainMode = 'eager' | 'none' | 'lazy';

// ============================================================
// RunSpec（unified §2 入口参数，design §2.1）
// ============================================================

/**
 * runReActLoop 入口参数（unified §2 + agent_interface §2 + design §2.1）。
 *
 * main/forked 差异全参数化（design §3 4 维差异表），骨架无 if main/forked 字面分支：
 *   - scopeId：default / forked（router.resolve 产出，选 contextEngine impl 链）
 *   - drainMode：eager(main) / none(forked) / lazy(占位)
 *   - backgroundPath：false(main) / true(forked)
 *   - stopSequences/eosStripper：main squad 才有 / forked undefined
 *   - lifecycle：Main/ForkedLifecyclePort impl（含 onInterrupted）
 */
export interface RunSpec {
  // —— 身份 ——
  sessionId: string;
  runId: string;
  /** "main" | "summary" | "consolidate"（种类标签，observability 身份；RunKind 扁平闭合枚举） */
  runKind: RunKind;
  /** scopeIdOf(kind) 纯拼接产出（= canonical id），选 contextEngine impl 链 */
  scopeId: string;
  /** 内存中断对象（manager 创建并注入） */
  controller: AbortControllerHandle;

  // —— 入参消息 ——
  /** 可选；main=undefined（首轮由 inbox 提供）；forked=任务消息（已纳入 buffer 前缀） */
  message?: Message;

  // —— 工具（双维度，装配时定）——
  /** 缓存契约：传 LLM 的工具声明（main 已 filterToolDefinitionsBySessionType；forked caller 原样传），整个 run 不变 */
  toolDefinitions: ToolDefinition[];
  /** 行为契约：执行门控白名单（非 allowed → not-allowed result 喂回）；由 resolveToolSet 产出写 spec */
  allowedTools: string[];
  /** main = config.maxIterations（来源 buildSessionConfigFromDeps：subagent=spawn maxIter / 顶层=DEFAULT_MAX_ITERATIONS）；forked = profile.runShape.maxIterDefault（summary=1 / consolidate=N） */
  maxIter: number;

  // —— 配置 ——
  config: SessionConfig;

  // —— main/forked 4 维差异（D12，参数化）——
  /** main=false；forked=true（overload 直接 fail 防雪崩） */
  backgroundPath: boolean;
  /** drain 模式三态（见 DrainMode） */
  drainMode: DrainMode;
  /** main squad=[EOS]；forked undefined */
  stopSequences?: string[];
  /** main squad=stripEosToken；forked undefined */
  eosStripper?: (content: ContentBlock[]) => void;

  // —— LifecyclePort（D7：FinalizePort 并入，三 hook onUsage/onRunEnd/onInterrupted）——
  lifecycle: LifecyclePort;
  /** 事件 emit 回调（mode 决定 group/开关） */
  emit: (e: AgentEvent) => void;

  // —— 观测 + run 实例 ——
  observability: LoopObservability;
  /** run 记录句柄（caller 视图对象，attachRunPromise 据此 settle） */
  agentRun?: AgentRun;

  // —— wire extras（装配层注入；骨架 + stage helper 复用的实操需要）——
  /** contextEngine 引用（骨架直调 ingest/assemble；main+forked 都注入） */
  wireContextEngine: ContextEngine;
  /** state 初始化 hook（forked 设 buffer；main 不设走默认 initState(store)） */
  wireInitState?: () => Promise<LoopState>;
  /** tool 执行引擎（executeAndEmit 用） */
  wireToolEngine?: ToolExecutionEngine;
  /** emit ctx（emitToolResult 等 helper 用；publish 经 groupKeyForRunKind 路由） */
  wireEmitCtx?: EmitContext;
  /** drain 前 peek inbox（run_start inputMessageIds 用；main 专属） */
  wirePeekTriggerMessages?: () => Message[];
  /** session store（initState/persistRun/updateUsage/compact summary 用；main 专属） */
  wireStore?: SessionStore;
  /** inbox store（drain 用；main 专属，drainMode='eager' 必填） */
  wireInbox?: InboxStore;
  /** session state machine（五态机；main 专属，旁路 run 不触碰） */
  wireStateMachine?: SessionStateMachine;
  /**
   * SessionTaskLock（tryCompact CompactCtx.taskLock 注入用；main 专属）。
   * compact 互斥统一锁（不落盘，内存 only）。
   */
  wireTaskLock?: SessionTaskLock;
  /** pluginManager（tryCompact 用；main+forked 都传，让 forked scope 显式调 reject_should_compact） */
  pluginManager?: PluginManager | null;
}

// ============================================================
// 便捷别名（仅类型，无运行时）
// ============================================================

/** PluginManager / ObservabilityAdapter re-export（装配层 impl 构造签名用） */
export type { PluginManager, ObservabilityAdapter };
