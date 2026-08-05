/**
 * SessionUnreadOps 单元测试（v0.0.163 race 修复）
 * 参考:
 *   - specs/tech/agent/session/[P0]session_state.md §3.1（CAS SQL）+ §4.4（两 timing）+ §6.3（不变量 5 幂等）
 *   - specs/tech/agent/session/[P0]session_event.md §2（session_read_update 事件契约）
 *   - states/v0.0.163.studio_unread_race/verify/test-plan.md § UT 覆盖
 *
 * 覆盖：
 *   1. markReadAndEmit 落盘后再 emit：wrap 后同步 fan-out 到 SessionMetaBroadcaster.broadcast(sid)
 *      重读 crud 时读到 NEW unread=false（本次 race 断死点——修复前 broadcaster 读到旧 unread=true）
 *   2. markUnreadTrue 落盘后可读：await 返回后 crud.get 立即读到 unread=true
 *   3. markReadAndEmit 幂等 no-op（rec.unread=false）：返回 false，不 emit
 *   4. markUnreadTrue 幂等 no-op（rec.unread=true）：返回 false
 *
 * 约束（change_plan.md 行 3+4）：MUST 用真 CompositeStore（putAsync 走 FsCrudStore.withFileLock
 * 真 async 路径）；MUST NOT mock crud.putAsync 让它同步返回——那会绕开本次 race 场景。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { SessionSchema } from '../schema_defs';
import { SessionStore } from '../session-store';
import { ReplayableEventBus } from '../event-bus';
import { markUnreadTrue, markReadAndEmit } from '../session-unread-ops';
import { SessionMetaBroadcaster } from '../session-meta-broadcaster';
import { SessionUnreadRuntime, wrapStatusBusForUnread } from '../session-unread-runtime';
import { SESSION_META_BROADCAST_GROUP } from '../session-event-types';
import type {
  SessionReadUpdateEvent,
  SessionMetaUpdateEvent,
} from '../session-event-types';

let tmpRoot: string;
let crud: CompositeStore;
let store: SessionStore;
let statusBus: ReplayableEventBus;
let sessionMetaBus: ReplayableEventBus;
/** 捕获 sessionMetaBus 上 broadcast 出的 SessionMetaView（本次 race 关键观察点） */
let broadcastedMetaViews: SessionMetaUpdateEvent[] = [];
/** 捕获 statusBus 上收到的 session_read_update 帧 */
let readUpdateEvents: SessionReadUpdateEvent[] = [];

/**
 * 构造 sessionMetaBus 的 spy：捕获所有 emit 到 _all 的 session_meta_update 事件。
 * 参考 session-meta-broadcaster.test.ts 的 spyMetaBus 模式。
 */
function makeSessionMetaBusSpy(): ReplayableEventBus {
  const real = new ReplayableEventBus({ replayable: false });
  const realEmit = real.emit.bind(real);
  const spy = Object.create(real) as ReplayableEventBus;
  spy.emit = (group: string, event: { data: unknown; timestamp: string }): void => {
    if (group === SESSION_META_BROADCAST_GROUP) {
      broadcastedMetaViews.push(event.data as SessionMetaUpdateEvent);
    }
    realEmit(group, event);
  };
  return spy;
}

/** 构造 statusBus 的 spy：捕获 session_read_update 帧 */
function makeStatusBusSpy(): ReplayableEventBus {
  const real = new ReplayableEventBus({ replayable: true });
  const realEmit = real.emit.bind(real);
  const spy = Object.create(real) as ReplayableEventBus;
  spy.emit = (group: string, event: { data: unknown; timestamp: string }): void => {
    const data = event.data as { type?: string };
    if (data?.type === 'session_read_update') {
      readUpdateEvents.push(event.data as SessionReadUpdateEvent);
    }
    realEmit(group, event);
  };
  return spy;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-unread-ops-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  broadcastedMetaViews = [];
  readUpdateEvents = [];
  sessionMetaBus = makeSessionMetaBusSpy();
  statusBus = makeStatusBusSpy();
  store = new SessionStore({ crud, fsRoot: tmpRoot, statusBus });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('session-unread-ops — markReadAndEmit 落盘时序（race 断死）', () => {
  it('rec.unread=true → await markReadAndEmit → 立即 crud.get 读到 unread=false + emit 帧 data.unread=false', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.markUnreadTrue(sid); // 铺 rec.unread=true

    const ok = await markReadAndEmit(crud, statusBus, sid);
    expect(ok).toBe(true);

    // 立即（同步）读回：await 后应可见 NEW 值
    const got = crud.get(SessionSchema, sid) as { unread?: boolean } | null;
    expect(got?.unread).toBe(false);

    // emit 帧存在 + 载荷 data.unread=false（spec session_event.md §2）
    expect(readUpdateEvents).toHaveLength(1);
    expect(readUpdateEvents[0]!.type).toBe('session_read_update');
    expect(readUpdateEvents[0]!.sessionId).toBe(sid);
    expect(readUpdateEvents[0]!.data.unread).toBe(false);
  });

  it('wrap+broadcaster 场景：emit 同步 fan-out 时 broadcaster.broadcast 重读 crud 应见 NEW unread=false（本次 race 断死点）', async () => {
    // 构造真实的 wrap 链路：statusBus wrap 后 emit 会同步触发 metaBroadcaster.broadcast
    // 修复前：markReadAndEmit 的 void putAsync 未落盘 → broadcaster.broadcast 里 crud.get 读到旧 unread=true
    // 修复后：await putAsync 落盘后 emit → broadcaster.broadcast 读到 NEW unread=false
    const metaBroadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: { isSessionActive: () => false } });
    const wrappedBus = wrapStatusBusForUnread(statusBus, runtime, { metaBroadcaster });
    // 用 wrapped bus 重开 store（让 markRead 触发的 emit 走 wrap fan-out）
    const store2 = new SessionStore({ crud, fsRoot: tmpRoot, statusBus: wrappedBus });

    const sid = ulid();
    await store2.createSession({ id: sid });
    await store2.markUnreadTrue(sid); // 铺 rec.unread=true
    broadcastedMetaViews = []; // 清空创建/产生未读期间的 broadcast（只关注消除路径的广播）

    // 直调 markReadAndEmit 走 wrapped bus（等价 handler → store.markRead → markReadAndEmit）
    await markReadAndEmit(crud, wrappedBus, sid);

    // 捕获到的 SessionMetaView 至少一条（broadcaster 在 emit 同步 fan-out 时调 broadcast）
    expect(broadcastedMetaViews.length).toBeGreaterThanOrEqual(1);
    const lastView = broadcastedMetaViews[broadcastedMetaViews.length - 1]!;
    expect(lastView.type).toBe('session_meta_update');
    expect(lastView.sessionId).toBe(sid);
    // 关键断言：broadcaster 重读 crud 应见 NEW unread=false——修复前会 fail（读到旧 true）
    expect(lastView.data.unread).toBe(false);
  });
});

describe('session-unread-ops — markUnreadTrue 落盘时序', () => {
  it('rec.unread=false → await markUnreadTrue → 立即 crud.get 读到 unread=true', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });

    const ok = await markUnreadTrue(crud, sid);
    expect(ok).toBe(true);

    // 立即（同步）读回：await 后应可见 NEW 值
    const got = crud.get(SessionSchema, sid) as { unread?: boolean } | null;
    expect(got?.unread).toBe(true);
  });

  it('wrap+broadcaster 场景：await 返回后立即 broadcast(sid) 应读到 NEW unread=true（对称 race 场景）', async () => {
    // markUnreadTrue 无直接 emit，race 在 SessionUnreadRuntime.handleSessionEvent 的
    // `.then(changed => broadcaster.broadcast(sid))` 路径——await 后紧接 broadcast，
    // 未落盘会广播 unread=false 旧值。
    const metaBroadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });

    const sid = ulid();
    await store.createSession({ id: sid });
    broadcastedMetaViews = [];

    const changed = await markUnreadTrue(crud, sid);
    expect(changed).toBe(true);
    // 模拟 SessionUnreadRuntime 的 .then 路径：await 返回后立即调 broadcast
    metaBroadcaster.broadcast(sid);

    expect(broadcastedMetaViews).toHaveLength(1);
    // 关键断言：broadcaster 重读 crud 应见 NEW unread=true
    expect(broadcastedMetaViews[0]!.data.unread).toBe(true);
  });
});

describe('session-unread-ops — 幂等 no-op', () => {
  it('markReadAndEmit(rec.unread=false) → 返 false + 不 emit + 不写盘', async () => {
    const sid = ulid();
    await store.createSession({ id: sid }); // 默认 unread=false

    const ok = await markReadAndEmit(crud, statusBus, sid);
    expect(ok).toBe(false); // CAS 0 行（已是目标值）
    // 未发 session_read_update（避免重复 emit 抖动，spec §6.3 不变量 5）
    expect(readUpdateEvents).toHaveLength(0);
    // 落盘状态保持 false
    const got = crud.get(SessionSchema, sid) as { unread?: boolean } | null;
    expect(got?.unread).toBe(false);
  });

  it('markUnreadTrue(rec.unread=true) → 返 false（幂等 no-op）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.markUnreadTrue(sid); // 首次 CAS 成功 → unread=true

    const ok = await markUnreadTrue(crud, sid);
    expect(ok).toBe(false); // 已 true → 幂等 no-op
    const got = crud.get(SessionSchema, sid) as { unread?: boolean } | null;
    expect(got?.unread).toBe(true);
  });

  it('markReadAndEmit(session 不存在) → 返 false + 不 emit', async () => {
    const ok = await markReadAndEmit(crud, statusBus, 'nonexistent-sid');
    expect(ok).toBe(false);
    expect(readUpdateEvents).toHaveLength(0);
  });

  it('markUnreadTrue(session 不存在) → 返 false', async () => {
    const ok = await markUnreadTrue(crud, 'nonexistent-sid');
    expect(ok).toBe(false);
  });
});
