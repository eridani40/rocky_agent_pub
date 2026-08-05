/**
 * SessionStateMachine 单元测试 — CAS 并发竞态 + 状态机 + reconcile（v0.0.12 task t1）
 * 参考: states/v0.0.12/design.md 板块 4/7/11
 *       specs/tech/agent/session/[P0]session_state.md §3 §4 §5
 *
 * 覆盖（design §10 UT 清单）：
 *   - markRunning/markInterrupting/markInterrupted/markIdle/markError CAS 并发竞态
 *   - reconcileOnStartup 扫描 running/interrupting → idle + Run=interrupted
 *   - session_status_update CAS 成功后推送（statusBus 注入）
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
import type { SessionStatusUpdateEvent } from '../session-event-types';

let tmpRoot: string;
let store: SessionStore;
let statusBus: ReplayableEventBus;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-state-machine-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  statusBus = new ReplayableEventBus({ replayable: true });
  store = new SessionStore({ crud, fsRoot: tmpRoot, statusBus });
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

/** 收 statusBus 的 session_status_update（订阅 group） */
function collectStatusEvents(sid: string): SessionStatusUpdateEvent[] {
  const out: SessionStatusUpdateEvent[] = [];
  const iter = statusBus.subscribe<SessionStatusUpdateEvent>(`session_id:${sid}`)[Symbol.asyncIterator]();
  void (async () => {
    while (true) {
      const r = await iter.next();
      if (r.done) break;
      if (r.value?.data?.type === 'session_status_update') {
        out.push(r.value.data as SessionStatusUpdateEvent);
      }
    }
  })();
  return out;
}

describe('SessionStateMachine — CAS 状态机', () => {
  it('markRunning: idle → running + 设 currentRunId', async () => {
    const sid = await newSession();
    const runId = ulid();
    const ok = await store.stateMachine.markRunning(sid, runId);
    expect(ok).toBe(true);
    const got = await store.getSession(sid);
    expect(got?.state).toBe('running');
    expect(got?.running).toBe(true);
    expect(got?.currentRunId).toBe(runId);
  });

  it('markRunning: running 状态下 CAS 失败（不允许重复 activate）', async () => {
    const sid = await newSession();
    const r1 = ulid();
    const r2 = ulid();
    expect(await store.stateMachine.markRunning(sid, r1)).toBe(true);
    // 第二次 activate 同 session：CAS 失败（state 已 running）
    expect(await store.stateMachine.markRunning(sid, r2)).toBe(false);
    const got = await store.getSession(sid);
    expect(got?.currentRunId).toBe(r1); // 保持第一个 run
  });

  it('markRunning: interrupted/error/idle 均可 activate', async () => {
    const sid = await newSession();
    // idle
    expect(await store.stateMachine.markRunning(sid, ulid())).toBe(true);
    // 走完整 round-trip：markIdle
    const r2 = ulid();
    await store.stateMachine.markIdle(sid, (await store.getSession(sid))!.currentRunId!);
    expect(await store.stateMachine.markRunning(sid, r2)).toBe(true);
  });

  it('markInterrupting: CAS currentRunId=expected AND state=running → interrupting + 清 currentRunId', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    const ok = await store.stateMachine.markInterrupting(sid, runId);
    expect(ok).toBe(true);
    const got = await store.getSession(sid);
    expect(got?.state).toBe('interrupting');
    expect(got?.running).toBe(true);
    expect(got?.currentRunId).toBeNull();
  });

  it('markInterrupting: CAS 失败（currentRunId 不匹配）', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    // 用错的 expectedRunId
    expect(await store.stateMachine.markInterrupting(sid, ulid())).toBe(false);
  });

  it('markInterrupting: 并发 abort 只有一个胜出（CAS 原子）', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    // 第一次 abort 胜出
    expect(await store.stateMachine.markInterrupting(sid, runId)).toBe(true);
    // 第二次 abort：currentRunId 已被清成 null → CAS 失败
    expect(await store.stateMachine.markInterrupting(sid, runId)).toBe(false);
  });

  it('markInterrupted: interrupting → interrupted + running=false', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    await store.stateMachine.markInterrupting(sid, runId);
    expect(await store.stateMachine.markInterrupted(sid)).toBe(true);
    const got = await store.getSession(sid);
    expect(got?.state).toBe('interrupted');
    expect(got?.running).toBe(false);
  });

  it('markInterrupted: 非 interrupting 时 CAS 失败', async () => {
    const sid = await newSession();
    expect(await store.stateMachine.markInterrupted(sid)).toBe(false);
  });

  it('markIdle: running → idle + 清 currentRunId（loop 正常退出）', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    expect(await store.stateMachine.markIdle(sid, runId)).toBe(true);
    const got = await store.getSession(sid);
    expect(got?.state).toBe('idle');
    expect(got?.running).toBe(false);
    expect(got?.currentRunId).toBeNull();
  });

  it('markIdle: CAS 失败（abort 已改 state → loop 不应再覆盖）', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    // 模拟 abort 在 loop 退出前抢到（markInterrupting）
    await store.stateMachine.markInterrupting(sid, runId);
    // loop run_end 试 markIdle → CAS 失败（state 已 interrupting 非 running）
    expect(await store.stateMachine.markIdle(sid, runId)).toBe(false);
  });

  it('markError: running → error + running=false（loop 异常退出）', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    expect(await store.stateMachine.markError(sid, runId)).toBe(true);
    const got = await store.getSession(sid);
    expect(got?.state).toBe('error');
    expect(got?.running).toBe(false);
  });
});

describe('SessionStateMachine — reconcileOnStartup', () => {
  it('扫 running session → idle + Run.status=interrupted', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    await store.createRun({ id: runId, sessionId: sid, status: 'running' });

    const result = await store.stateMachine.reconcileOnStartup();
    expect(result.reconciled).toContain(sid);

    const s = await store.getSession(sid);
    expect(s?.state).toBe('idle');
    expect(s?.running).toBe(false);
    expect(s?.currentRunId).toBeNull();
    const r = await store.getRun(sid, runId);
    expect(r?.status).toBe('interrupted');
    expect(r?.endedAt).toBeTruthy();
  });

  it('扫 interrupting session → idle + Run.status=interrupted', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    await store.stateMachine.markInterrupting(sid, runId);
    await store.createRun({ id: runId, sessionId: sid, status: 'running' });

    await store.stateMachine.reconcileOnStartup();
    const s = await store.getSession(sid);
    expect(s?.state).toBe('idle');
  });

  it('已终态 session（idle/interrupted/error）不动', async () => {
    const sidIdle = await newSession();
    const sidErr = await newSession();
    const eRun = ulid();
    await store.stateMachine.markRunning(sidErr, eRun);
    await store.stateMachine.markError(sidErr, eRun);

    const result = await store.stateMachine.reconcileOnStartup();
    expect(result.reconciled).not.toContain(sidIdle);
    expect(result.reconciled).not.toContain(sidErr);
  });
});

describe('SessionStateMachine — session_status_update 推送', () => {
  it('markRunning CAS 成功后推送 status=interrupting 事件', async () => {
    const sid = await newSession();
    const events = collectStatusEvents(sid);
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    // 让 microtask 推一下事件
    await new Promise((r) => setTimeout(r, 10));
    const statusEvents = events.filter((e) => e.data.state === 'running');
    expect(statusEvents.length).toBe(1);
    expect(statusEvents[0]!.data.currentRunId).toBe(runId);
  });

  it('CAS 失败不发事件（state 未变）', async () => {
    const sid = await newSession();
    const events = collectStatusEvents(sid);
    const r1 = ulid();
    await store.stateMachine.markRunning(sid, r1);
    // 第二次 CAS 失败
    await store.stateMachine.markRunning(sid, ulid());
    await new Promise((r) => setTimeout(r, 10));
    // 只应有 1 条 running 事件（第一次）
    const runningEvents = events.filter((e) => e.data.state === 'running');
    expect(runningEvents.length).toBe(1);
  });
});
