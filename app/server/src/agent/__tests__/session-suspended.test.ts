/**
 * [v0.0.101 T2] session suspended 第六态 + lifecycle 落盘 + reconcile 单元测试
 * 参考: specs/tech/version_logs/v0.0.101/change_plan.md 模块 D
 *       reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md
 *
 * 覆盖 T2 acceptanceCriteria：
 *   1. markSuspended CAS 原子 + suspended 态 running bool=false（INV-2）
 *   2. reconcileOnStartup 不动 suspended（保留存活态，INV-3）；落盘后重启 peekPendingToolCall 可读
 *   3. onRunEnd 三分支 error→markError / tool_pending→markSuspended / 其余→markIdle
 *   4. markRunning WHERE 含 suspended（回填/query 激活路径可走，O6 闸门不堵）
 *   + peekPendingToolCall / setPendingToolCalls / resolvePendingToolCall 落盘 round-trip
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import {
  SessionSchema,
  MessageSchema,
  SummarySchema,
  RunSchema,
} from '../schema_defs';
import { SessionStore } from '../session-store';
import { ReplayableEventBus } from '../event-bus';
import { RunLifecyclePort } from '../run-lifecycle-port';
import type { ResolvedSessionProfile } from '../session-type-profile-loader';
import type { LoopState } from '../loop-ports';
import type { SessionConfig } from '../context-types';
import type { PendingToolCall } from '../../tools/types';

/** main profile mock（persistsRun=true / touchesStateMachine=true → onRunEnd persist + CAS） */
const MAIN_PROFILE: ResolvedSessionProfile = {
  id: 'playground-rocky:parent:main',
  enabled: true,
  toolBound: [],
  toolDefinitionsSource: 'own',
  runShape: { drainMode: 'eager', backgroundPath: false, maxIterDefault: 25, touchesStateMachine: true, persistsRun: true, usagePartition: 'current' },
  lifecycleHooks: { abortFinalize: 'four-step', cascadeChildren: true },
  eventChannel: { emitDefault: true },
  modelHints: { readsSquadDefault: false },
  skillSource: 'global-enabled',
  eosStop: [],
  autoNaming: false,
  preloadContext: 'none',
};

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-suspended-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 创建 session（默认 state=idle） */
async function newSession(): Promise<string> {
  const sid = ulid();
  await store.createSession({ id: sid });
  return sid;
}

/** 构造最小 LoopState fixture（只填 persistRun/CAS 分支读的字段） */
function loopStateWith(stopReason: string): LoopState {
  return {
    ingestUpTo: null,
    llmUpTo: null,
    snapshot: null,
    step: 1,
    done: true,
    stopReason: stopReason as LoopState['stopReason'],
  } as LoopState;
}

/** 构造 RunLifecyclePort（main profile：persistsRun + touchesStateMachine 触发 persistRun + CAS 三分支） */
function newLifecycle(sid: string, runId: string): RunLifecyclePort {
  return new RunLifecyclePort({
    config: { sessionId: sid } as SessionConfig,
    store,
    runId,
    profile: MAIN_PROFILE,
  });
}

/** 构造最小 PendingToolCall fixture */
function pendingFixture(sid: string, runId: string, toolCallId: string): PendingToolCall {
  return {
    sessionId: sid,
    runId,
    toolCallId,
    toolName: 'ask-question',
    handleType: 'direct_result',
    subState: 'need_feedback',
    data: { prompt: '请选择', questions: [] },
    status: 'pending',
  };
}

describe('[v0.0.101 T2] markSuspended — CAS + INV-2 running=false', () => {
  it('markSuspended: running + currentRunId 匹配 → suspended + running=false + 清 currentRunId', async () => {
    const sid = await newSession();
    const runId = ulid();
    expect(await store.stateMachine.markRunning(sid, runId)).toBe(true);

    const ok = await store.stateMachine.markSuspended(sid, runId);
    expect(ok).toBe(true);

    const got = await store.getSession(sid);
    expect(got?.state).toBe('suspended');
    // INV-2：suspended 排除 running（列表亮「?」非 spinner）
    expect(got?.running).toBe(false);
    expect(got?.currentRunId).toBeNull();
  });

  it('markSuspended CAS: currentRunId 不匹配 → false（不被他人改）', async () => {
    const sid = await newSession();
    const r1 = ulid();
    await store.stateMachine.markRunning(sid, r1);
    // 用错误的 expectedRunId
    expect(await store.stateMachine.markSuspended(sid, ulid())).toBe(false);
    const got = await store.getSession(sid);
    expect(got?.state).toBe('running'); // 未被改
  });

  it('markSuspended CAS: 非 running 态 → false（idle 不可直接 suspended）', async () => {
    const sid = await newSession(); // idle
    expect(await store.stateMachine.markSuspended(sid, ulid())).toBe(false);
    const got = await store.getSession(sid);
    expect(got?.state).toBe('idle');
  });

  it('markSuspended CAS: error/interrupted 态 → false（仅 running 可 suspended）', async () => {
    const sid = await newSession();
    const r1 = ulid();
    await store.stateMachine.markRunning(sid, r1);
    await store.stateMachine.markError(sid, r1); // → error
    expect(await store.stateMachine.markSuspended(sid, r1)).toBe(false);
    expect((await store.getSession(sid))?.state).toBe('error');
  });
});

describe('[v0.0.101 T2] markRunning WHERE 含 suspended（O6 activate 闸门）', () => {
  it('markRunning: suspended → running 可激活（回填/query 路径不堵）', async () => {
    const sid = await newSession();
    const r1 = ulid();
    await store.stateMachine.markRunning(sid, r1);
    await store.stateMachine.markSuspended(sid, r1);
    expect((await store.getSession(sid))?.state).toBe('suspended');

    // 用户回填或发 query → markRunning 激活（O6 闸门 WHERE 含 suspended）
    const r2 = ulid();
    const ok = await store.stateMachine.markRunning(sid, r2);
    expect(ok).toBe(true);
    const got = await store.getSession(sid);
    expect(got?.state).toBe('running');
    expect(got?.currentRunId).toBe(r2);
  });

  it('markRunning: running/interrupting 态仍不可重复 activate（不变）', async () => {
    const sid = await newSession();
    const r1 = ulid();
    await store.stateMachine.markRunning(sid, r1);
    // running 态不可再 activate（仍 enforced）
    expect(await store.stateMachine.markRunning(sid, ulid())).toBe(false);
  });
});

describe('[v0.0.101 T2] reconcileOnStartup — 保留 suspended（INV-3）+ peek 可读', () => {
  it('reconcile 保留 suspended 不清 idle；重启后 peekPendingToolCall 可读', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    await store.stateMachine.markSuspended(sid, runId);
    const pending = pendingFixture(sid, runId, 'tc_1');
    await store.setPendingToolCalls(sid, [pending]);

    // 模拟重启：新建 store 实例（同一 fsRoot 落盘数据）
    const fs2 = new FsCrudStore({ root: tmpRoot });
    const crud2 = new CompositeStore()
      .mount('session', fs2).mount('transcript', fs2).mount('summary', fs2).mount('runs', fs2);
    const store2 = new SessionStore({ crud: crud2, fsRoot: tmpRoot });

    // 重启前确认是 suspended
    expect((await store2.getSession(sid))?.state).toBe('suspended');

    await store2.stateMachine.reconcileOnStartup();

    // INV-3：suspended 保留（未被清成 idle）
    const got = await store2.getSession(sid);
    expect(got?.state).toBe('suspended');
    expect(got?.running).toBe(false);

    // peek 可读队首（recover d 路径）
    const head = await store2.peekPendingToolCall(sid);
    expect(head).not.toBeNull();
    expect(head?.toolCallId).toBe('tc_1');
    expect(head?.status).toBe('pending');
  });

  it('reconcile: running/interrupting 仍清 idle（suspended 不影响原有逻辑）', async () => {
    // running orphan
    const sidRun = await newSession();
    const r1 = ulid();
    await store.stateMachine.markRunning(sidRun, r1);
    // suspended
    const sidSusp = await newSession();
    const r2 = ulid();
    await store.stateMachine.markRunning(sidSusp, r2);
    await store.stateMachine.markSuspended(sidSusp, r2);
    await store.setPendingToolCalls(sidSusp, [pendingFixture(sidSusp, r2, 'tc_x')]);

    const { reconciled } = await store.stateMachine.reconcileOnStartup();
    // running orphan 被清
    expect(reconciled).toContain(sidRun);
    expect((await store.getSession(sidRun))?.state).toBe('idle');
    // suspended 保留
    expect((await store.getSession(sidSusp))?.state).toBe('suspended');
  });

  it('reconcile: suspended 但 pendingToolCalls 空/不一致 → 清 pending，state 保持 suspended', async () => {
    const sid = await newSession();
    const r1 = ulid();
    await store.stateMachine.markRunning(sid, r1);
    await store.stateMachine.markSuspended(sid, r1);
    // 不写 pendingToolCalls（不一致场景：suspended 但无悬挂项）

    const { reconciled } = await store.stateMachine.reconcileOnStartup();
    expect(reconciled).toContain(sid);
    // state 保持 suspended（INV-3 不清 idle），pendingToolCalls 规范化为 []
    const got = await store.getSession(sid);
    expect(got?.state).toBe('suspended');
    expect(got?.pendingToolCalls).toEqual([]);
    // peek 返 null（无悬挂项）
    expect(await store.peekPendingToolCall(sid)).toBeNull();
  });
});

describe('[v0.0.101 T2] onRunEnd 三分支（error/tool_pending/其余）', () => {
  it('onRunEnd stopReason=error → markError（state=error）', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.createRun({ id: runId, sessionId: sid });
    await store.stateMachine.markRunning(sid, runId);
    const lc = newLifecycle(sid, runId);

    await lc.onRunEnd(loopStateWith('error'));

    const got = await store.getSession(sid);
    expect(got?.state).toBe('error');
    expect(got?.running).toBe(false);
    // run 落盘 stopReason=error status=failed
    const run = await store.getRun(sid, runId);
    expect(run?.stopReason).toBe('error');
    expect(run?.status).toBe('failed');
  });

  it('onRunEnd stopReason=tool_pending → markSuspended（state=suspended, INV-2 running=false）', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.createRun({ id: runId, sessionId: sid });
    await store.stateMachine.markRunning(sid, runId);
    const lc = newLifecycle(sid, runId);

    await lc.onRunEnd(loopStateWith('tool_pending'));

    const got = await store.getSession(sid);
    expect(got?.state).toBe('suspended');
    expect(got?.running).toBe(false); // INV-2
    // run 落盘 stopReason=tool_pending status=completed（非 error）
    const run = await store.getRun(sid, runId);
    expect(run?.stopReason).toBe('tool_pending');
    expect(run?.status).toBe('completed');
  });

  it('onRunEnd stopReason=其余（no_tool_call/max_iterations 等）→ markIdle', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.createRun({ id: runId, sessionId: sid });
    await store.stateMachine.markRunning(sid, runId);
    const lc = newLifecycle(sid, runId);

    await lc.onRunEnd(loopStateWith('no_tool_call'));

    const got = await store.getSession(sid);
    expect(got?.state).toBe('idle');
    expect(got?.running).toBe(false);
  });
});

describe('[v0.0.101 T2] pendingToolCalls 落盘 API（peek/set/resolve）', () => {
  it('setPendingToolCalls + peekPendingToolCall 返队首（深拷贝快照）', async () => {
    const sid = await newSession();
    const runId = ulid();
    const p1 = pendingFixture(sid, runId, 'tc_a');
    const p2 = pendingFixture(sid, runId, 'tc_b');
    await store.setPendingToolCalls(sid, [p1, p2]);

    const head = await store.peekPendingToolCall(sid);
    expect(head?.toolCallId).toBe('tc_a'); // 队首
    expect(head?.status).toBe('pending');
    // 深拷贝：改返回值不影响落盘
    if (head) head.status = 'resolved';
    const head2 = await store.peekPendingToolCall(sid);
    expect(head2?.status).toBe('pending');
  });

  it('peekPendingToolCall 跳过 resolved，返首个 pending（队首串行 INV-4）', async () => {
    const sid = await newSession();
    const runId = ulid();
    const p1 = { ...pendingFixture(sid, runId, 'tc_a'), status: 'resolved' as const };
    const p2 = pendingFixture(sid, runId, 'tc_b');
    await store.setPendingToolCalls(sid, [p1, p2]);
    const head = await store.peekPendingToolCall(sid);
    expect(head?.toolCallId).toBe('tc_b'); // 跳过 resolved 的 tc_a
  });

  it('peekPendingToolCall: 无悬挂项/session 不存在 → null', async () => {
    const sid = await newSession();
    expect(await store.peekPendingToolCall(sid)).toBeNull(); // 无字段
    await store.setPendingToolCalls(sid, []);
    expect(await store.peekPendingToolCall(sid)).toBeNull(); // 空数组
    expect(await store.peekPendingToolCall('no_such_session')).toBeNull();
  });

  it('resolvePendingToolCall: 按 toolCallId 删一条 + 剩余保留', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.setPendingToolCalls(sid, [
      pendingFixture(sid, runId, 'tc_a'),
      pendingFixture(sid, runId, 'tc_b'),
    ]);

    const ok = await store.resolvePendingToolCall(sid, 'tc_a');
    expect(ok).toBe(true);

    const head = await store.peekPendingToolCall(sid);
    expect(head?.toolCallId).toBe('tc_b'); // tc_a 已删，tc_b 升队首
  });

  it('resolvePendingToolCall: 未匹配/session 不存在 → false', async () => {
    const sid = await newSession();
    await store.setPendingToolCalls(sid, [pendingFixture(sid, ulid(), 'tc_a')]);
    expect(await store.resolvePendingToolCall(sid, 'no_such_tc')).toBe(false);
    expect(await store.resolvePendingToolCall('no_such_session', 'tc_a')).toBe(false);
  });

  it('toSession: pendingToolCalls 兼容历史 session 无字段 → 缺省 []', async () => {
    const sid = await newSession();
    const got = await store.getSession(sid);
    expect(got?.pendingToolCalls).toEqual([]);
  });
});
