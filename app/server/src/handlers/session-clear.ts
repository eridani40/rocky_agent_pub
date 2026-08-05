/**
 * session-clear handler — POST /session/:id/clear 清空会话内容
 * 参考: specs/api/overall/04-agent-session.md §8（POST /session/:id/clear 契约）
 *       specs/tech/agent/session/[P0]session_clear.md §5（并发处理 caller 职责）
 *       specs/tech/agent/session/[P0]session_task_lock.md §3.3（subsumes summaryTask CAS）
 *
 * 职责（薄壳，参考 session-compact.ts 模式）：
 *   - POST → 200 同步原子（不 fire-and-forget；clear 用户感知即时完成）
 *   - 并发编排（spec §5，caller 职责；force=true 时跳过 §1 abort）：
 *       1. state ∈ {running, interrupting} → manager.abort(sid, currentRunId, "current")
 *          （abortRun 同步等 4 步收尾完成，返 accepted 后 state=interrupted；
 *           accepted:false 时（无 active controller）继续强制 clear 兜底）
 *       2. lock.getState(sid,'compact').status==='running' → lock.markFailed("cleared")
 *          + clearReplay(summary)（清 forked summary 的半截 replay buffer）
 *       3. store.clearSession(sid)（单事务清空 §3 全部范围 + emit 3 事件）
 *   - body { force?: boolean }：force=true 跳过 §5.1 等 abort（默认 false）
 *
 * 不直接持有依赖：经 SessionHandlerDeps 注入 SessionStore / AgentManager / SessionTaskLock（session.ts 定义并 re-export）。
 */
import type { SessionHandlerDeps } from './session';
import type { Session } from '../agent/session-store-types';

/** 构造 JSON Response（可选 Allow 头，405 类响应附带） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * 处理 POST /session/:id/clear — 清空会话内容（同步原子）。
 *
 * spec api §8 / session_clear.md §5：
 *   - 200 + { ok: true, session: Session } = 清空完成
 *   - 404 session 不存在
 *   - 405 非 POST
 *
 * 并发编排（force=false 默认）：
 *   - state ∈ {running, interrupting} → manager.abort（4 步收尾；同步等完成）
 *   - lock.getState(sid,'compact').status=running → lock.markFailed("cleared") + clearReplay(summary)
 *   - store.clearSession（强制重置 state=idle + 单事务清空 + emit 3 事件）
 *
 * @param req Request（POST /clear 请求体 { force?: boolean }）
 * @param method HTTP 方法（用于 405 判定）
 * @param id session id（path param）
 * @param deps SessionHandlerDeps（用 store + agentManager + taskLock）
 */
export async function handleSessionClear(
  req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' }, 'POST');
  }
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });

  // subagent 只读语义（api §4.3）：subagent session 拒绝手动 clear。
  // subagent transcript 是审计/观测依据，不可被用户手动清空。
  if (got.derivation === 'subagent') {
    return json(403, { error: 'subagent_readonly' });
  }

  // 解析 body { force?: boolean }（容错：缺省 false；非法 body 视作空 {}）
  let force = false;
  try {
    if (req.body !== null && req.body !== undefined) {
      const parsed = (await req.json()) as { force?: boolean };
      if (typeof parsed.force === 'boolean') force = parsed.force;
    }
  } catch {
    // body 解析失败：force 保持默认 false
  }

  // ── 并发编排（spec §5，force=true 跳过 §5.1）──
  // 1. state ∈ {running, interrupting} → abort（4 步收尾）
  if (!force && (got.state === 'running' || got.state === 'interrupting')) {
    const runId = got.currentRunId ?? '';
    // manager.abort 内部 4 步（agent_interrupt §3）：CAS markInterrupting → loop exit →
    // finalizeHalfData → clearReplay(current) → emit run_stop(interrupted) → markInterrupted
    // 返 accepted:true 即 state 已=interrupted；accepted:false（无 active controller）继续兜底 clear
    await deps.agentManager.abort(id, runId, 'main');
  }

  // 重读 session（abort 后 state/currentRunId 已变；taskLock 内存态仍是原值需判定）
  const afterAbort = await deps.store.getSession(id);
  if (!afterAbort) return json(404, { error: 'session not found' });

  // 2. lock.getState(sid,'compact').status=running → lock.markFailed("cleared")
  //   + clearReplay(summary)（spec §5.2）
  //   taskLock 缺省（旧测试未注入）→ 跳过 compact 清理（保 UT 兼容）。
  const taskLock = deps.taskLock;
  if (taskLock && taskLock.getState(id, 'compact').status === 'running') {
    // CAS WHERE status=running → failed + error="cleared"；forked agent 无副作用仅状态标失败
    taskLock.markFailed(id, 'compact', 'cleared');
    // 清 forked summary 的半截 replay buffer（compact 崩溃 / clear 打断 compact 时残留）
    deps.agentManager.clearReplay(id, 'summary');
  }

  // 3. 单事务清空（session-clear-op.ts：强制重置 state=idle + 清全部范围 + emit 3 事件）
  const cleared: Session = await deps.store.clearSession(id);

  return json(200, { ok: true, session: cleared });
}
