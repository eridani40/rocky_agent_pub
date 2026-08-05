/**
 * AgentRun 实例 + AbortController 内存对象 + groupKey/runMapKey 命名
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_interface.md
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_interrupt.md §1-§1.1
 *
 * 本文件是 agent 子系统的统一类型契约：
 *   - AgentRun instance（caller 视图对象，不暴露 controller，§2）
 *   - AbortControllerHandle（自定义内存对象 {runId, aborted}，非 Web API；命名避开 Web API 冲突）
 *   - RunResult / AbortResult / groupKeyForRunKind / runMapKey（§3 §4 §6）
 *
 * 设计原则（agent_interface §1）：
 *   - 中断不在 run 对象上——abort 归 AgentManager.abort() 唯一入口
 *   - AgentRun 不暴露 controller，caller 不能直接操作 controller.aborted
 *   - mode 差异下沉进 RunSpec 的 port 字段（buildRunDeps 装配）
 */
import type { Usage } from '../message/types';
import type { StopReason } from './agent-event-types';
import type { RunKind } from '../../../shared/src/types/session-kind';
// type-only import tools 层（agent→tools 依赖方向合法；不引入运行时依赖）
import type { ChildProcessRegistry } from '../tools/child-process-registry';

// ============================================================
// 2. AgentRun（instance）
// ============================================================

/**
 * Agent run 实例（agent_interface §2）。
 * 每次 activate / sideRun 产出；caller 拿到后可 await promise / 读 state。
 *
 * **不暴露 controller**：caller 无法直接操作 controller.aborted，
 * 中断必须经 AgentManager.abort() 入口。
 */
export interface AgentRun {
  /** 归属 session */
  readonly sessionId: string;
  /** run 种类（扁平闭合枚举 RunKind：main / summary / consolidate） */
  readonly runKind: RunKind;
  /** ULID，全局唯一 */
  readonly runId: string;
  /** `session_id:<sid>_amt:<runKind>` */
  readonly groupKey: string;
  /** run 状态（caller 可读不可改） */
  state: AgentRunState;
  /** 可 await 拿最终结果（main 等 run_end，旁路 run 等 answer） */
  promise: Promise<RunResult>;
  /** 完成后填充 */
  result?: RunResult;
  /**
   * activate 失败时携带的原始 Error（仅 state==='error' 时存在）。
   * 供 caller（session-run/session-messages handler）识别结构化错误（如 ModelNotConfiguredError）
   * 决定 HTTP 状态码（400 vs 500）。pending/completed 态无此字段。
   */
  error?: unknown;
}

/** AgentRun.state 取值（agent_interface §3） */
export type AgentRunState = 'running' | 'completed' | 'interrupted' | 'error';

// ============================================================
// 3. RunResult
// ============================================================

/**
 * run 的最终结果（agent_interface §3）。
 * main 在 run_end 时 settle；旁路 run 在 answer 提取后 settle。
 */
export interface RunResult {
  /** LLM 产出文本（聚合 text block） */
  answer: string;
  /** 累计 usage */
  usage: Usage;
  /** 退出原因（no_tool_call / interrupted / error 等） */
  stopReason: StopReason;
  /** ReAct 轮数 */
  rounds: number;
}

// ============================================================
// 4. AbortController 内存对象 + AbortResult
// ============================================================

/**
 * AbortController 内存对象（agent_interrupt §1）。
 *
 * **自定义类型，非 Web API**：命名为 AbortControllerHandle 避开和 Web AbortController 冲突。
 * AgentManager 创建并持有，构造时注入 loop；JS 对象引用语义保证 manager 端置 aborted=true
 * 后 loop 下一次读 controller.aborted 立即看到 true。
 */
export interface AbortControllerHandle {
  /** 目标 runId，AgentManager.abort 校验 controller.runId === runId 后才置 aborted */
  runId: string;
  /** 内存布尔位；置 true 后 loop 下一检查点立即停（O(1) 读） */
  aborted: boolean;
  /**
   * run 级子进程注册表（挂载点）。agent-manager 建 controller 时一并 new
   * ChildProcessRegistry() 挂上；沿 opts 透传链下沉到 tools/engine.ts ctx.childRegistry，
   * 供 bash 等 spawn 型工具注册子进程。run 终止（abort-finalize.abortRun）时调用
   * killAll() 做终止级 sweep。可选字段——auto-naming 等零参构造 controller 不受影响。
   */
  childRegistry?: ChildProcessRegistry;
}

/**
 * AgentManager.abort 返回（agent_interface §3 + agent_interrupt §6）。
 *
 * reason 取值：
 *   - run_id_mismatch：runId 不匹配 controller.runId
 *   - no_active_controller：无对应 controller（已结束或未启动）
 *   - cas_failed：CAS markInterrupting 失败（并发 abort，仅主对话）
 */
export type AbortResult =
  | { accepted: true }
  | { accepted: false; reason: 'run_id_mismatch' | 'no_active_controller' | 'cas_failed' };

// ============================================================
// 5. groupKey 命名约定（agent_interface §4）
// ============================================================

/**
 * 生成 groupKey（agent_interface §4）。
 * 命名规范：`session_id:<sid>_amt:<runKind>`，amt = agent mode type。
 *
 * | runKind | groupKey |
 * |---------|----------|
 * | main | session_id:<sid>_amt:main（主对话 eager/lazy） |
 * | summary | session_id:<sid>_amt:summary（旁路压缩） |
 * | consolidate | session_id:<sid>_amt:consolidate（旁路记忆整理） |
 */
export function groupKeyForRunKind(sid: string, runKind: RunKind): string {
  return `session_id:${sid}_amt:${runKind}`;
}

/**
 * 生成 AgentRun 的三 map key（agent_interface §6 + agent_manager §4）。
 * 命名规范：`${sid}_${runKind}`（agentRuns / abortControllers 共用）。
 */
export function runMapKey(sid: string, runKind: RunKind): string {
  return `${sid}_${runKind}`;
}
