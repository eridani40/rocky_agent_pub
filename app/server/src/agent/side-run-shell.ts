/**
 * side-run AgentRun shell 构造（旁路 run 拆分模块）
 * 参考: [P0]agent_interface.md v1.1 §2 AgentRun instance
 *       [P0]agent_loop_forked.md v2.2 §4 buildAgentRunShellAndStart
 *
 * 职责：把 AgentRun shell 构造 + 异步绑定 loop promise 抽离主类。
 * shell 由 caller 视图对象组成（sessionId/runKind/runId/groupKey/state/promise/result）。
 */
import type { RunKind } from '../../../shared/src/types/session-kind';
import type { AgentRun, RunResult } from './agent-interface';
import { groupKeyForRunKind } from './agent-interface';

/**
 * 构造 AgentRun shell（agent_interface §2）+ 异步绑定 loop promise。
 *
 * @param sessionId session id
 * @param runKind summary / consolidate
 * @param runId ULID（manager 生成）
 * @param loopPromise 异步启动的 loop promise（resolve 时填 result）
 * @returns AgentRun shell（caller 拿到后可 await promise）
 */
export function buildAgentRunShell(
  sessionId: string,
  runKind: RunKind,
  runId: string,
  loopPromise: Promise<RunResult>,
): AgentRun {
  const groupKey = groupKeyForRunKind(sessionId, runKind);
  let resolveFn!: (r: RunResult) => void;
  let rejectFn!: (e: unknown) => void;
  const promise = new Promise<RunResult>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  const agentRun: AgentRun = {
    sessionId,
    runKind,
    runId,
    groupKey,
    state: 'running',
    promise,
    result: undefined,
  };
  // agentRun.promise 兜底吞 rejection：
  // 生产 agent-manager 用 `void promise.finally(cleanup)` fire-and-forget（finally 不接 rejection）；
  // UT 也常 `await agent.run()` 后不 await promise。
  // 这两种场景 promise reject 时会 unhandled crash 进程。
  // 此处给 promise 自身挂 noop catch；caller 显式 await 仍拿到 rejection（同步 then 链优先）。
  promise.catch(() => {
    /* noop: 见上注释，caller 未 await 时防 unhandled rejection */
  });
  // 异步绑定 loop promise → agentRun.promise（settle 时填 result/state）
  // 末尾追加 noop catch：agentRun.promise 是 caller 显式 await 的契约，
  // 但生产 fire-and-forget 后台 forked（agent-manager.ts 用 void ...finally(cleanup)）
  // 或 UT 不 await promise 时，loop 抛错（如 EMPTY_RESPONSE）会经 rejectFn 转 promise，
  // 若无人 await 则变 unhandled rejection 让进程 exit≠0。
  // 加末尾 noop 吞「无人 await」的 rejection；caller 真正 await 仍拿到 rejection（同一 promise）。
  //
  // runReActLoop 不 rethrow 非 abort 错误（统一骨架设 stopReason='error' 返回）。
  // 但旁路 caller（compact）需 promise reject 才能触发 markSummaryFailed（runCompact catch 分支）。
  // 故 stopReason='error' 时显式 reject。
  void loopPromise
    .then((result) => {
      if (result.stopReason === 'error') {
        agentRun.state = 'error';
        agentRun.result = result;
        rejectFn(new Error(`side run loop error: ${result.answer || '(no detail)'}`));
        return;
      }
      agentRun.state = result.stopReason === 'interrupted' ? 'interrupted' : 'completed';
      agentRun.result = result;
      resolveFn(result);
    })
    .catch((e) => {
      agentRun.state = 'error';
      rejectFn(e);
    })
    .catch(() => {
      /* noop: caller 未 await agentRun.promise 时吞 rejection，防 unhandled */
    });
  return agentRun;
}
