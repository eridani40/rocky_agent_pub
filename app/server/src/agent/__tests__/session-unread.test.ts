/**
 * session unread 字段单元测试（v0.0.27）
 * 参考:
 *   - specs/tech/agent/session/[P0]session_state.md §3.1（产生/消除 CAS SQL）+ §4.4（两 timing）+ §6.3（不变量）
 *   - specs/tech/agent/session/[P0]session_store.md §2（unread 字段）+ §4（markRead API）
 *   - specs/tech/agent/session/[P0]session_event.md §2（session_read_update 事件）
 *
 * 覆盖（test-plan.md §5 UT 范围）：
 *   - 产生 CAS：store.markUnreadTrue（CAS false→true）；已 true 幂等不写
 *   - 消除 CAS：store.markRead（CAS true→false + emit session_read_update）；已 false 幂等不发事件
 *   - 三 no-op 情形：abort 走 markInterrupted 不调产生逻辑；reconcileOnStartup 不动 unread
 *   - unread 字段持久化（落盘 + engine 读回）；历史 session（无字段）toSession 缺省 false
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { SessionSchema } from '../schema_defs';
import { SessionStore } from '../session-store';
import { ReplayableEventBus } from '../event-bus';
import type { SessionReadUpdateEvent } from '../session-event-types';

let tmpRoot: string;
let store: SessionStore;
let statusBus: ReplayableEventBus;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-unread-'));
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

/** 收 statusBus 的 session_read_update（订阅 group） */
function collectReadEvents(sid: string): SessionReadUpdateEvent[] {
  const out: SessionReadUpdateEvent[] = [];
  const iter = statusBus.subscribe<SessionReadUpdateEvent>(`session_id:${sid}`)[Symbol.asyncIterator]();
  void (async () => {
    while (true) {
      const r = await iter.next();
      if (r.done) break;
      if (r.value?.data?.type === 'session_read_update') {
        out.push(r.value.data as SessionReadUpdateEvent);
      }
    }
  })();
  return out;
}

describe('session unread — 字段持久化 + 缺省兼容', () => {
  it('createSession 后 toSession 返 unread=false（默认值）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const got = await store.getSession(sid);
    expect(got?.unread).toBe(false);
  });

  it('手动改 unread=true 重启 engine（new SessionStore 同 crud）后读回仍 true', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    // 手动 CAS 置 true（模拟 agent-loop 产生未读）
    expect(await store.markUnreadTrue(sid)).toBe(true);
    // 同 crud 再开一个 SessionStore（模拟重启 engine，复用同一 fs 数据）
    const fs2 = new FsCrudStore({ root: tmpRoot });
    const crud2 = new CompositeStore()
      .mount('session', fs2)
      .mount('transcript', fs2)
      .mount('summary', fs2)
      .mount('runs', fs2);
    const store2 = new SessionStore({ crud: crud2, fsRoot: tmpRoot });
    const got = await store2.getSession(sid);
    expect(got?.unread).toBe(true);
  });

  it('历史 session（无 unread 字段）toSession 缺省 false 兼容', async () => {
    // 模拟历史 session：直接写一个无 unread 字段的 session.json 到 fs
    const sid = ulid();
    const legacyRec = {
      id: sid,
      status: 'active',
      state: 'idle',
      // 故意无 unread 字段
    };
    const sessionDir = join(tmpRoot, 'session');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `${sid}.json`), JSON.stringify(legacyRec));
    const got = await store.getSession(sid);
    expect(got?.unread).toBe(false);
  });
});

describe('session unread — 产生 CAS（markUnreadTrue）', () => {
  it('false → true CAS 成功（返 true）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    expect(await store.markUnreadTrue(sid)).toBe(true);
    const got = await store.getSession(sid);
    expect(got?.unread).toBe(true);
  });

  it('已 true 时 CAS 幂等 no-op（返 false，不重复写）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    expect(await store.markUnreadTrue(sid)).toBe(true); // 首次 true
    expect(await store.markUnreadTrue(sid)).toBe(false); // 已 true → no-op
    const got = await store.getSession(sid);
    expect(got?.unread).toBe(true);
  });

  it('session 不存在返 false', async () => {
    expect(await store.markUnreadTrue('nonexistent-sid')).toBe(false);
  });
});

describe('session unread — 消除 CAS（markRead）+ 事件', () => {
  it('true → false CAS 成功 + emit session_read_update', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.markUnreadTrue(sid); // 先置 true
    const events = collectReadEvents(sid);
    expect(await store.markRead(sid)).toBe(true);
    const got = await store.getSession(sid);
    expect(got?.unread).toBe(false);
    // 等事件 flush
    await new Promise((r) => setTimeout(r, 30));
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('session_read_update');
    expect(events[0]!.sessionId).toBe(sid);
    expect(events[0]!.data).toEqual({ unread: false });
    expect(typeof events[0]!.createdAt).toBe('string');
  });

  it('已 false 时 CAS 幂等 no-op（返 false + 不发事件）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const events = collectReadEvents(sid);
    // session 默认 unread=false → markRead CAS 0 行
    expect(await store.markRead(sid)).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(events.length).toBe(0);
    const got = await store.getSession(sid);
    expect(got?.unread).toBe(false);
  });

  it('session 不存在返 false（不发事件）', async () => {
    const events = collectReadEvents('nonexistent-sid');
    expect(await store.markRead('nonexistent-sid')).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(events.length).toBe(0);
  });
});

describe('session unread — 三种 no-op 情形（不产生未读）', () => {
  it('abort 走 markInterrupted：unread 不变（不调产生逻辑）', async () => {
    // 模拟 abort 流程：markRunning → markInterrupting → markInterrupted
    // 期间不调 markUnreadTrue（abort 不是完成事件，不产生未读，spec §4.4 no-op）
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();
    expect(await store.stateMachine.markRunning(sid, runId)).toBe(true);
    expect(await store.stateMachine.markInterrupting(sid, runId)).toBe(true);
    expect(await store.stateMachine.markInterrupted(sid)).toBe(true);
    // 整个 abort 流程不调 markUnreadTrue → unread 保持初始 false
    const got = await store.getSession(sid);
    expect(got?.state).toBe('interrupted');
    expect(got?.unread).toBe(false);
  });

  it('reconcileOnStartup 不动 unread（保持崩溃前值）', async () => {
    // 模拟崩溃前 session：state=running + unread=true（崩溃前已产生未读）
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    await store.markUnreadTrue(sid); // 崩溃前 unread=true
    // 崩溃恢复：把 running → idle，但不动 unread（spec §6.3 不变量 4）
    await store.stateMachine.reconcileOnStartup();
    const got = await store.getSession(sid);
    expect(got?.state).toBe('idle'); // reconcile 修复 state
    expect(got?.unread).toBe(true); // 但 unread 保持崩溃前值 true（不重置、不产生新未读）
  });

  it('reconcileOnStartup 对崩溃前 unread=false 的 session 也保持 false（不产生未读）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    // unread 默认 false（未调 markUnreadTrue）
    await store.stateMachine.reconcileOnStartup();
    const got = await store.getSession(sid);
    expect(got?.state).toBe('idle');
    expect(got?.unread).toBe(false); // reconcile 不产生未读
  });
});
