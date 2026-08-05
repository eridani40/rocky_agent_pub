/**
 * AgentRun Registry — agentRuns/abortControllers/loops 三 map 管理
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md §4 三 map
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_interface.md §2 AgentRun instance
 *
 * 职责：把 AgentManager 三 map 管理逻辑（createAgentRunShell / attachRunPromise / cleanupRun /
 * makeErrorRun / loopKey / runMapKey）抽离主类。
 *
 * 设计：所有函数无状态（操作传入的 Map），主类 AgentManager 持有三 Map 实例。
 */
import { ulid } from '../config/ulid';
import type { AgentRun, RunResult } from './agent-interface';
import type { AbortControllerHandle } from './agent-interface';
import type { RunKind } from '../../../shared/src/types/session-kind';
import type { LoopHandle } from './run-loop-handle';
import type { RunSpec } from './loop-ports';
import { buildAgentRunShell } from './side-run-shell';

/** 主对话 runKind（agent_interface §4；RunKind 扁平枚举 'main'） */
export const RUN_KIND_MAIN = 'main';

/** loops map key（${sid}_main，对齐 agent_manager §4） */
export function loopKey(sid: string): string {
  return `${sid}_${RUN_KIND_MAIN}`;
}

/** agentRuns / abortControllers 共用 key（${sid}_${runKind}，agent_interface §6 + agent_manager §4） */
export function runMapKey(sid: string, runKind: RunKind): string {
  return `${sid}_${runKind}`;
}

/**
 * 构造 AgentRun shell（agent_interface §2 caller 视图对象）。
 * promise 初始为 pending（attachRunPromise 后绑定 loop.start 的 then/catch）。
 */
export function createAgentRunShell(sid: string, runKind: RunKind, runId: string): AgentRun {
  const groupKey = `session_id:${sid}_amt:${runKind}`;
  let resolveFn!: (r: { answer: string; usage: unknown; stopReason: string; rounds: number }) => void;
  let rejectFn!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolveFn = res as typeof resolveFn;
    rejectFn = rej;
  }) as Promise<AgentRun['result']>;
  const shell: AgentRun = {
    sessionId: sid,
    runKind,
    runId,
    groupKey,
    state: 'running',
    promise: promise as unknown as Promise<NonNullable<AgentRun['result']>>,
    result: undefined,
  };
  // 存 resolve/reject 供 attachRunPromise 调用（用闭包挂 shell 上）
  (shell as unknown as { __resolve: typeof resolveFn; __reject: typeof rejectFn }).__resolve = resolveFn;
  (shell as unknown as { __resolve: typeof resolveFn; __reject: typeof rejectFn }).__reject = rejectFn;
  return shell;
}

/**
 * 把 loop.start() 的 promise 绑定到 AgentRun.promise（settle 时填 result/state + 调 onSettled）。
 *
 * startPromise 类型放宽为 Promise<unknown>：main loop 返 Promise<void>，
 * 旁路 loop 返 Promise<RunResult>。本函数忽略 resolved value（只看 settle 状态），
 * 故 Promise<unknown> 足够（main 用 createAgentRunShell+attachRunPromise；旁路用 buildAgentRunShell）。
 */
export function attachRunPromise(
  agentRun: AgentRun,
  startPromise: Promise<unknown>,
  onSettled: () => void,
): void {
  const shell = agentRun as unknown as {
    __resolve: (r: { answer: string; usage: unknown; stopReason: string; rounds: number }) => void;
    __reject: (e: unknown) => void;
  };
  void startPromise
    .then(() => {
      agentRun.state = 'completed';
      agentRun.result = { answer: '', usage: {} as never, stopReason: 'no_tool_call', rounds: 0 };
      shell.__resolve({ answer: '', usage: {}, stopReason: 'no_tool_call', rounds: 0 });
      onSettled();
    })
    .catch((e) => {
      agentRun.state = 'error';
      shell.__reject(e);
      onSettled();
    });
}

/**
 * 构造 error AgentRun（activate session not found / config resolve failed / buildMainDeps throw 用）。
 *
 * state='error' 是 error 的权威信号（caller session-run/session-messages handler 据 state 走兜底）。
 * promise rejection 是冗余信号：__reject 把 promise 转 rejected 态供 caller 按需 await throw，
 * 但 error 已通过 state 表达，promise 不应再变成 unhandled rejection 击穿进程。
 *
 * [Bun crash 修复] __reject 后立即挂 noop catch：
 *   - caller（agent-manager.ts activate 三处）走 async 路径返回 shell，多一跳 microtask；
 *   - 即便 caller（session-messages.ts:192）事后挂 catch，也晚于 Bun 的 unhandled rejection 检查时机
 *     → 进程 crash（任何 resolveConfig 失败都会击穿整个 server）。
 *   - 在 makeErrorRun 内同步挂 noop catch，rejection 当场被消费，不依赖 caller 时序。
 *   - 不影响 caller 后续 await shell.promise 的 throw 语义（await 总看 promise 最终态，与 handler 无关）。
 *
 * error 参数接受 Error 对象（透传结构化错误如 ModelNotConfiguredError 的 code/detail，
 *   供 caller 识别返语义化 400）；字符串入参自动包 Error（兼容旧调用点 session not found / buildMainDeps throw）。
 */
export function makeErrorRun(sid: string, runKind: RunKind, error: Error | string): AgentRun {
  const newRunId = ulid();
  const shell = createAgentRunShell(sid, runKind, newRunId);
  shell.state = 'error';
  // 字符串入参自动包 Error；Error 入参原样保留（caller 据 instanceof 判语义化错误）
  const errObj = typeof error === 'string' ? new Error(error) : error;
  shell.error = errObj;
  const errShell = shell as unknown as { __reject: (e: unknown) => void };
  errShell.__reject(errObj);
  // 同步挂 noop catch 防 unhandled rejection（error 已由 shell.state 表达，吞掉冗余信号）
  void shell.promise.catch(() => {});
  return shell;
}

/**
 * 清理指定 run 的 agentRuns + abortControllers 条目（agent_manager §4 cleanupRun）。
 * loops 由 loop run_end 单独清（见 activate 内 onSettled）。
 */
export function cleanupRun(
  agentRuns: Map<string, AgentRun>,
  abortControllers: Map<string, AbortControllerHandle>,
  runKey: string,
): void {
  agentRuns.delete(runKey);
  abortControllers.delete(runKey);
}

/** 异步 sleep */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 等 loop 退出（轮询 isRunning；timeout 兜底防死等） */
export async function waitForLoopExit(loop: LoopHandle, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (loop.isRunning() && Date.now() - start < timeoutMs) {
    await sleep(20);
  }
}

/**
 * startRunAndTrack — 唯一 loop 启动 shell（agent_manager §1 单 loop 入口）。
 *
 * 抽 activate/sideRun 共同启动逻辑：注册三 map → void loop.start() → 绑 promise + cleanup。
 * shell 构造按 runKind 分流：
 *   - main = createAgentRunShell + attachRunPromise（loop.start 返 void，结果不通过 promise 传播）
 *   - 旁路（summary/consolidate）= buildAgentRunShell 绑 RunResult 真实传播 + error→reject
 *     （保 compact markSummaryFailed 契约）
 * 五态机 CAS / 幂等 / 旁路并发检查 / agentToolContext 注入全留在 caller wrapper，本函数不改语义。
 *
 * @param maps  AgentManager 持有的三 map（agentRuns / abortControllers / loops）
 * @param spec  buildRunDeps 装配的 RunSpec
 * @param loop  buildRunDeps 装配的 LoopHandle
 * @returns AgentRun（caller 视图对象）
 */
export function startRunAndTrack(
  maps: {
    agentRuns: Map<string, AgentRun>;
    abortControllers: Map<string, AbortControllerHandle>;
    loops: Map<string, LoopHandle>;
  },
  spec: RunSpec,
  loop: LoopHandle,
): AgentRun {
  const sid = spec.sessionId;
  const runKind = spec.runKind;
  const rk = runMapKey(sid, runKind);
  const lk = loopKey(sid);
  const isMain = runKind === RUN_KIND_MAIN;

  // 注册 controller（wrapper 已完成并发检查 / CAS）；loops 仅 main 用（abort-finalize 轮询用）
  maps.abortControllers.set(rk, spec.controller);
  if (isMain) {
    // main：loops map 注册 + createAgentRunShell + attachRunPromise（loop.start 返 void，结果不通过 promise 传播）
    maps.loops.set(lk, loop);
    const agentRun = createAgentRunShell(sid, runKind, spec.runId);
    maps.agentRuns.set(rk, agentRun);
    const startPromise = loop.start();
    attachRunPromise(agentRun, startPromise, () => {
      cleanupRun(maps.agentRuns, maps.abortControllers, rk);
      maps.loops.delete(lk);
    });
    // 早失败 guard：loop.start() 同步抛错（running 未置）→ 清三 map 以便重试
    void startPromise.catch(() => {
      if (!loop.isRunning()) {
        maps.loops.delete(lk);
        cleanupRun(maps.agentRuns, maps.abortControllers, rk);
      }
    });
    return agentRun;
  }

  // 旁路 run：buildAgentRunShell 绑 loop.start()=Promise<RunResult>（真实结果传播 + error→reject）
  const agentRun = buildAgentRunShell(sid, runKind, spec.runId, loop.start() as Promise<RunResult>);
  maps.agentRuns.set(rk, agentRun);
  // fire-and-forget cleanup；.catch 兜底吞 finally 链透传的 rejection（caller 经 agentRun.promise 本体拿错误）
  void agentRun.promise
    .finally(() => cleanupRun(maps.agentRuns, maps.abortControllers, rk))
    .catch(() => {});
  return agentRun;
}
