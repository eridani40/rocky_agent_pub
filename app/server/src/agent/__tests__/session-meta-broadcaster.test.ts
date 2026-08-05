/**
 * SessionMetaBroadcaster 单元测试（v0.0.27 session_meta 广播层）
 * 参考:
 *   - specs/tech/app/frontend/[P0]sse_channel.md §10（session_meta topic 架构）
 *   - specs/tech/agent/session/[P0]session_event.md §3a（SessionMetaView + 触发时机全集）
 *   - specs/tech/version_logs/v0.0.27/session-meta-broadcast-decision.md（决策 + 触发时机表）
 *
 * 覆盖：
 *   - broadcast(sid) 读最新 session record → 组装全量 SessionMetaView → emit 到 (session_meta, _all)
 *   - SessionMetaView 字段全集（id/title/state/running/unread/summaryTask/workspaceDir/createdAt/updatedAt）
 *   - payload 非部分 diff（全量最新态，spec decision.md §3）
 *   - session 不存在（crud.get null）→ no-op（不 emit）
 *   - handleSessionEvent：META_TRIGGERING_TYPES 触发 broadcast；其他类型 no-op
 *   - wrapStatusBusForUnread 泛化版：任意 statusBus.emit session 事件 → broadcaster 广播
 *     （含 session_status_update / summary_task_update / session_usage_update / session_read_update /
 *       messages_cleared / session_workspace_dir_changed）
 *   - session_workspace_file_changed（chokidar fs event）**不触发**（高频非 meta 本身）
 *   - SessionUnreadRuntime 产生路径：markUnreadTrue CAS 成功后直调 broadcaster.broadcast(sid)
 *   - 共享广播 group `_all`（非 per-sid）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { SessionStore } from '../session-store';
import { ReplayableEventBus } from '../event-bus';
import {
  SessionUnreadRuntime,
  wrapStatusBusForUnread,
} from '../session-unread-runtime';
import { SessionMetaBroadcaster, _META_TRIGGERING_TYPES } from '../session-meta-broadcaster';
import { SESSION_META_BROADCAST_GROUP, SESSION_META_TOPIC } from '../session-event-types';
import type {
  SessionEvent,
  SessionStatusUpdateEvent,
  SessionUsageUpdateEvent,
  MessagesClearedEvent,
  SessionWorkspaceDirChangedEvent,
  SessionWorkspaceFileChangedEvent,
  SessionReadUpdateEvent,
  SessionMetaUpdateEvent,
} from '../session-event-types';
import type { SessionPresenceProbe } from '../../sse/sse-channel';

let tmpRoot: string;
let store: SessionStore;
let crud: CompositeStore;
let statusBus: ReplayableEventBus;
let sessionMetaBus: ReplayableEventBus;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-meta-broadcast-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  statusBus = new ReplayableEventBus({ replayable: true });
  sessionMetaBus = new ReplayableEventBus({ replayable: false });
  store = new SessionStore({ crud, fsRoot: tmpRoot, statusBus });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeProbe(activeSids: Set<string> = new Set()): SessionPresenceProbe {
  return { isSessionActive: (sid: string) => activeSids.has(sid) };
}

async function flushMicrotasks(): Promise<void> {
  // markUnreadTrue 走 await putAsync 落盘，runtime `.then(cb)` 链需 10 轮 microtask
  // 才能等到 broadcast 触发（少于 10 轮会漏观测）
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function mkStatusEvent(sid: string, state: 'idle' | 'running' | 'error' = 'idle'): SessionStatusUpdateEvent {
  return {
    id: ulid(), type: 'session_status_update', sessionId: sid, createdAt: new Date().toISOString(),
    data: { state, running: state === 'running', currentRunId: null },
  };
}

// v0.0.55：mkSummaryEvent 已删除（summary_task_update 事件已废弃，被 SessionTaskLock 取代）

function mkUsageEvent(sid: string): SessionUsageUpdateEvent {
  return {
    id: ulid(), type: 'session_usage_update', sessionId: sid, createdAt: new Date().toISOString(),
    data: { current: {}, sub: {}, forked: {}, total: {}, ratio: 1, currentCacheRate: 0, subCacheRate: 0, forkedCacheRate: 0, totalCacheRate: 0 },
  };
}

function mkReadEvent(sid: string): SessionReadUpdateEvent {
  return {
    id: ulid(), type: 'session_read_update', sessionId: sid, createdAt: new Date().toISOString(),
    data: { unread: false },
  };
}

function mkClearedEvent(sid: string): MessagesClearedEvent {
  return {
    id: ulid(), type: 'messages_cleared', sessionId: sid, createdAt: new Date().toISOString(),
    data: {},
  };
}

function mkDirChangedEvent(sid: string): SessionWorkspaceDirChangedEvent {
  return {
    id: ulid(), type: 'session_workspace_dir_changed', sessionId: sid, createdAt: new Date().toISOString(),
    data: { workspaceDir: '/tmp/ws', prevDir: null },
  };
}

function mkFileChangedEvent(sid: string): SessionWorkspaceFileChangedEvent {
  return {
    id: ulid(), type: 'session_workspace_file_changed', sessionId: sid, createdAt: new Date().toISOString(),
    data: { path: 'foo.txt', kind: 'change', isDir: false },
  };
}

let collected: SessionMetaUpdateEvent[] = [];

/** 包装 sessionMetaBus，捕获所有 emit 到 _all 的事件 */
function spyMetaBus(): ReplayableEventBus {
  const real = new ReplayableEventBus({ replayable: false });
  const realEmit = real.emit.bind(real);
  const spy = Object.create(real) as ReplayableEventBus;
  spy.emit = (group: string, event: { data: unknown; timestamp: string }): void => {
    if (group === SESSION_META_BROADCAST_GROUP) {
      collected.push(event.data as SessionMetaUpdateEvent);
    }
    realEmit(group, event);
  };
  return spy;
}

describe('SessionMetaBroadcaster — broadcast 全量 SessionMetaView 到 _all', () => {
  beforeEach(() => {
    collected = [];
    sessionMetaBus = spyMetaBus();
  });

  it('broadcast(sid) 读最新 record → emit session_meta_update 到 (session_meta, _all)', async () => {
    const sid = ulid();
    await store.createSession({ id: sid, title: 'meta-test' });
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });

    broadcaster.broadcast(sid);

    expect(collected).toHaveLength(1);
    const ev = collected[0]!;
    expect(ev.type).toBe('session_meta_update');
    expect(ev.sessionId).toBe(sid);
    expect(ev.data.id).toBe(sid);
  });

  it('SessionMetaView payload 含全字段（非部分 diff，spec decision.md §3）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid, title: 'full-payload' });
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });

    broadcaster.broadcast(sid);

    const data = collected[0]!.data;
    // 全量字段（spec session_event.md §3a.3）
    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('title');
    expect(data).toHaveProperty('status');
    expect(data).toHaveProperty('state');
    expect(data).toHaveProperty('running');
    expect(data).toHaveProperty('currentRunId');
    expect(data).toHaveProperty('workspaceDir');
    expect(data).toHaveProperty('unread');
    // v0.0.55：summaryTask 字段已从 SessionMetaView 删除（被 SessionTaskLock 取代，内存 only 无 SSE 推送源）
    expect(data).not.toHaveProperty('summaryTask');
    expect(data).toHaveProperty('createdAt');
    expect(data).toHaveProperty('updatedAt');
  });

  it('每次都读最新态：广播两次（产生未读 → 消除）payload.unread 随之变化', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });

    broadcaster.broadcast(sid);
    expect(collected[0]!.data.unread).toBe(false);

    // 模拟产生未读
    await store.markUnreadTrue(sid);
    broadcaster.broadcast(sid);
    expect(collected[1]!.data.unread).toBe(true);
  });

  it('session 不存在（crud.get null）→ no-op 不 emit', () => {
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });
    broadcaster.broadcast('nonexistent-sid');
    expect(collected).toHaveLength(0);
  });

  it('[v0.0.231] SessionMetaView 投影 pinned：置顶 session → pinned===true', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.updateSession(sid, { pinned: true });
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });
    broadcaster.broadcast(sid);
    expect(collected[0]!.data.pinned).toBe(true);
  });

  it('[v0.0.231] SessionMetaView 投影 pinned：未置顶 / 历史 session（无字段）→ pinned===false', async () => {
    const sid = ulid();
    await store.createSession({ id: sid }); // 不传 pinned → lazy 默认 false
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });
    broadcaster.broadcast(sid);
    expect(collected[0]!.data.pinned).toBe(false);
  });

  it('broadcast 异常吞掉不影响主路径（sessionMetaBus.emit 抛错不向外传播）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    // 注入会抛错的 bus
    const badBus = Object.create(new ReplayableEventBus({ replayable: false })) as ReplayableEventBus;
    badBus.emit = (): never => { throw new Error('bus boom'); };
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus: badBus });
    expect(() => broadcaster.broadcast(sid)).not.toThrow();
  });

  it('[v0.0.33.1] studio session 广播含 bizType/squadId/memberId（T6 新三字段，11-squad.md §3）', async () => {
    const sid = ulid();
    const squadId = ulid();
    const memberId = ulid();
    await store.createSession({
      id: sid, role: 'mate', biz: 'studio', squadId, memberId,
      workspaceDir: '/tmp/test-ws',
    });
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });
    broadcaster.broadcast(sid);
    const data = collected[0]!.data;
    expect(data.biz).toBe('studio');
    expect(data.squadId).toBe(squadId);
    expect(data.memberId).toBe(memberId);
    expect(data.role).toBe('mate');
  });

  it('[v0.0.33.1] playground session（无 bizType）广播不含 bizType/squadId/memberId 字段', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });
    broadcaster.broadcast(sid);
    const data = collected[0]!.data;
    // biz 默认 'playground'（createSession 自动落 biz='playground'）
    expect(data.biz).toBe('playground');
    expect(data).not.toHaveProperty('squadId');
    expect(data).not.toHaveProperty('memberId');
  });
});

describe('SessionMetaBroadcaster.handleSessionEvent — 触发类型集合过滤', () => {
  beforeEach(() => {
    collected = [];
    sessionMetaBus = spyMetaBus();
  });

  it('session_status_update 触发 broadcast', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });
    broadcaster.handleSessionEvent(mkStatusEvent(sid));
    expect(collected).toHaveLength(1);
  });

  it('session_usage_update / session_read_update / messages_cleared / session_workspace_dir_changed 都触发 broadcast', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });
    // v0.0.55：summary_task_update 已从触发类型集删除（被 SessionTaskLock 取代）
    for (const ev of [
      mkUsageEvent(sid), mkReadEvent(sid), mkClearedEvent(sid), mkDirChangedEvent(sid),
    ] as SessionEvent[]) {
      broadcaster.handleSessionEvent(ev);
    }
    expect(collected).toHaveLength(4);
  });

  it('session_workspace_file_changed（chokidar fs event）**不触发**（高频非 meta 本身，spec decision.md §4）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });
    broadcaster.handleSessionEvent(mkFileChangedEvent(sid));
    expect(collected).toHaveLength(0);
  });

  it('_META_TRIGGERING_TYPES 集合含 6 种触发类型（v0.0.78.bug 恢复 summary_task_update），不含 session_workspace_file_changed', () => {
    expect(_META_TRIGGERING_TYPES.has('session_status_update')).toBe(true);
    // [v0.0.78.bug] summary_task_update 已恢复（v0.0.55 误删导致 CompactBtn spinner 信号丢失；
    //   SessionTaskLock bus 注入后 CAS 状态变更 emit 该事件，broadcaster 捕获触发 meta 广播）
    expect(_META_TRIGGERING_TYPES.has('summary_task_update')).toBe(true);
    expect(_META_TRIGGERING_TYPES.has('session_usage_update')).toBe(true);
    expect(_META_TRIGGERING_TYPES.has('session_read_update')).toBe(true);
    expect(_META_TRIGGERING_TYPES.has('messages_cleared')).toBe(true);
    expect(_META_TRIGGERING_TYPES.has('session_workspace_dir_changed')).toBe(true);
    expect(_META_TRIGGERING_TYPES.has('session_workspace_file_changed')).toBe(false);
  });
});

describe('wrapStatusBusForUnread 泛化版 — 任意 statusBus session 事件 → broadcaster 广播', () => {
  beforeEach(() => {
    collected = [];
    sessionMetaBus = spyMetaBus();
  });

  it('statusBus.emit(session_status_update) → wrap fan-out → broadcaster.broadcast', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe(), metaBroadcaster: broadcaster });
    runtime.start();
    const wrapped = wrapStatusBusForUnread(statusBus, runtime, { metaBroadcaster: broadcaster });

    wrapped.emit(`session_id:${sid}`, {
      data: mkStatusEvent(sid, 'running'),
      timestamp: new Date().toISOString(),
    });

    // session_status_update running 触发 broadcast（state 变化）
    expect(collected.length).toBeGreaterThanOrEqual(1);
    expect(collected[0]!.sessionId).toBe(sid);
  });

  it('statusBus.emit(session_read_update) → wrap fan-out → broadcaster.broadcast（消除也广播）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe(), metaBroadcaster: broadcaster });
    runtime.start();
    const wrapped = wrapStatusBusForUnread(statusBus, runtime, { metaBroadcaster: broadcaster });

    wrapped.emit(`session_id:${sid}`, {
      data: mkReadEvent(sid),
      timestamp: new Date().toISOString(),
    });

    expect(collected).toHaveLength(1);
    expect(collected[0]!.data.unread).toBe(false);
  });

  it('statusBus.emit(session_workspace_file_changed) → wrap 不触发 broadcaster（高频非 meta）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe(), metaBroadcaster: broadcaster });
    runtime.start();
    const wrapped = wrapStatusBusForUnread(statusBus, runtime, { metaBroadcaster: broadcaster });

    wrapped.emit(`session_id:${sid}`, {
      data: mkFileChangedEvent(sid),
      timestamp: new Date().toISOString(),
    });

    expect(collected).toHaveLength(0);
  });

  it('未注入 metaBroadcaster 时 wrap 仅 fan-out runtime（向后兼容）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe() });
    runtime.start();
    // 不传 opts.metaBroadcaster
    const wrapped = wrapStatusBusForUnread(statusBus, runtime);
    expect(() => {
      wrapped.emit(`session_id:${sid}`, {
        data: mkStatusEvent(sid),
        timestamp: new Date().toISOString(),
      });
    }).not.toThrow();
    expect(collected).toHaveLength(0);
  });
});

describe('SessionUnreadRuntime 产生路径 — markUnreadTrue CAS 成功后直调 broadcaster.broadcast', () => {
  beforeEach(() => {
    collected = [];
    sessionMetaBus = spyMetaBus();
  });

  it('completion(state=idle) + 非前台 → markUnreadTrue CAS 成功 → broadcaster.broadcast(sid)', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });
    const runtime = new SessionUnreadRuntime({
      crud,
      presenceProbe: makeProbe(), // 非前台
      metaBroadcaster: broadcaster,
    });
    runtime.start();

    runtime.handleSessionEvent(mkStatusEvent(sid, 'idle'));
    await flushMicrotasks();

    // markUnreadTrue CAS 成功（false→true）→ 直调 broadcaster
    expect(collected).toHaveLength(1);
    expect(collected[0]!.sessionId).toBe(sid);
    expect(collected[0]!.data.unread).toBe(true);
  });

  it('completion + 前台 → no markUnreadTrue → 不调 broadcaster（前台不产生未读）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });
    const runtime = new SessionUnreadRuntime({
      crud,
      presenceProbe: makeProbe(new Set([sid])), // 前台
      metaBroadcaster: broadcaster,
    });
    runtime.start();

    runtime.handleSessionEvent(mkStatusEvent(sid, 'idle'));
    await flushMicrotasks();

    expect(collected).toHaveLength(0);
  });

  it('CAS 失败（unread 已是 true）→ 不调 broadcaster（已 true 不广播，幂等）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.markUnreadTrue(sid); // 预置 true

    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });
    const runtime = new SessionUnreadRuntime({
      crud,
      presenceProbe: makeProbe(),
      metaBroadcaster: broadcaster,
    });
    runtime.start();

    runtime.handleSessionEvent(mkStatusEvent(sid, 'idle'));
    await flushMicrotasks();

    // CAS 0 行（已 true）→ changed=false → 不调 broadcaster
    expect(collected).toHaveLength(0);
  });
});

describe('session_meta topic 共享广播 group `_all`（spec sse_channel.md §10.2）', () => {
  it('SESSION_META_BROADCAST_GROUP 常量 = "_all"', () => {
    expect(SESSION_META_BROADCAST_GROUP).toBe('_all');
  });

  it('SESSION_META_TOPIC 常量 = "session_meta"', () => {
    expect(SESSION_META_TOPIC).toBe('session_meta');
  });

  it('broadcaster 把所有 session 的 meta 都 emit 到同一 _all group（broadcast 模型）', async () => {
    collected = [];
    sessionMetaBus = spyMetaBus();
    const sidA = ulid();
    const sidB = ulid();
    await store.createSession({ id: sidA });
    await store.createSession({ id: sidB });
    const broadcaster = new SessionMetaBroadcaster({ crud, sessionMetaBus });

    broadcaster.broadcast(sidA);
    broadcaster.broadcast(sidB);

    // 两个 session 的 meta 都进了同一 group 的流（_all 共享，列表订阅一次收所有）
    expect(collected).toHaveLength(2);
    expect(new Set(collected.map((e) => e.sessionId))).toEqual(new Set([sidA, sidB]));
  });
});
