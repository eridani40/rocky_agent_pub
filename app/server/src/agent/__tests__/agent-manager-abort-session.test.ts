/**
 * agent-manager abortSession 单测（白盒）—— v0.0.111 块② team 硬删 teardown 用
 * 参考: specs/tech/version_logs/v0.0.111/change_plan.md 块②（abortSession 契约）
 *
 * abortSession(sid)：读 session.currentRunId → 存在则以 RUN_KIND_MAIN abort 当前 run；
 *   无 run / session 不存在 → no-op；封装 RUN_KIND_MAIN 不外泄；幂等。
 *
 * 测法：用 Object.create(prototype) 构造轻量实例，只注入 store + abort（spy），
 *   避免全量构造 AgentManagerImpl（依赖繁多）。abortSession 逻辑仅依赖 this.store + this.abort。
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentManagerImpl } from '../agent-manager';
import { RUN_KIND_MAIN } from '../agent-run-registry';

/** 造轻量 mgr：注入 store.getSession + abort spy（其余不构造） */
function makeMgr(session: { currentRunId?: string } | undefined) {
  const abort = vi.fn(async () => ({ accepted: true }));
  const getSession = vi.fn(async () => session);
  // store 为 private，用 Record 中转赋值后再取 abortSession（原型方法）
  const raw = Object.create(AgentManagerImpl.prototype) as Record<string, unknown>;
  raw.store = { getSession };
  raw.abort = abort;
  const mgr = raw as unknown as { abortSession(sessionId: string): Promise<void> };
  return { mgr, abort, getSession };
}

describe('AgentManagerImpl.abortSession', () => {
  it('有 currentRunId → 以 (sid, runId, RUN_KIND_MAIN) 调 abort', async () => {
    const { mgr, abort } = makeMgr({ currentRunId: 'RUN-1' });
    await mgr.abortSession('S-1');
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith('S-1', 'RUN-1', RUN_KIND_MAIN);
  });

  it('无 currentRunId（session 存在但无进行中 run）→ no-op，不调 abort', async () => {
    const { mgr, abort } = makeMgr({});
    await mgr.abortSession('S-1');
    expect(abort).not.toHaveBeenCalled();
  });

  it('session 不存在 → 安全 no-op（幂等），不调 abort', async () => {
    const { mgr, abort } = makeMgr(undefined);
    await mgr.abortSession('missing');
    expect(abort).not.toHaveBeenCalled();
  });
});
