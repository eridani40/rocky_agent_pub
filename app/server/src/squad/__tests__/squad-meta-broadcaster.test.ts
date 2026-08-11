/**
 * SquadMetaBroadcaster 单元测试（v0.0.305 T1）
 * 参考: specs/tech/version_logs/v0.0.305.squad-list-ui-upgrade/architecture.md D3/D4
 *       specs/tech/app/frontend/[P0]sse_channel.md §10（session_meta topic 同构）
 *
 * 覆盖：
 *   - handleSessionEvent 触发类型路由：playground（无 squadId）跳过 / 非触发类型跳过 /
 *     触发类型 → getSession → squadId → broadcast 正确 payload
 *   - broadcast(squadId)：读最新聚合 → emit squad_meta_update 到 (squad_meta, _all)
 *   - squad 不存在 / session 不存在 → no-op 不 emit
 *   - sessionStore 未注入（setSessionStore 前）→ no-op
 *   - 异常吞掉不影响调用方
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Session } from '../../agent/session-store-types';
import type { SessionEvent } from '../../agent/session-event-types';
import { ulid } from '../../config/ulid';
import { ReplayableEventBus } from '../../agent/event-bus';
import type { ReplayableEventBus as ReplayableEventBusType } from '../../agent/event-bus';
import { wrapStatusBusForUnread } from '../../agent/session-unread-runtime';
import {
  SquadMetaBroadcaster,
  SQUAD_META_TRIGGERING_TYPES,
} from '../squad-meta-broadcaster';
import {
  SQUAD_META_BROADCAST_GROUP,
  type SquadMetaUpdateEvent,
} from '../squad-event-types';

/** 捕获 emit 到 _all 的 squadMetaBus（同构 session-meta-broadcaster.test.ts spyMetaBus） */
function spyMetaBus(): ReplayableEventBusType {
  const real = new ReplayableEventBus({ replayable: false });
  const realEmit = real.emit.bind(real);
  const spy = Object.create(real) as ReplayableEventBusType;
  spy.emit = (group: string, event: { data: unknown; timestamp: string }): void => {
    if (group === SQUAD_META_BROADCAST_GROUP) {
      collected.push(event.data as SquadMetaUpdateEvent);
    }
    realEmit(group, event);
  };
  return spy;
}

let collected: SquadMetaUpdateEvent[];
let squadMetaBus: ReplayableEventBusType;
let sessionStore: { getSession: ReturnType<typeof vi.fn>; listSessions: ReturnType<typeof vi.fn> };
let squadStore: { getSquad: ReturnType<typeof vi.fn> };
let memberStore: { listMembers: ReturnType<typeof vi.fn> };

function mkSession(sid: string, squadId: string | null): Session {
  return {
    id: sid, state: 'idle', running: false, status: 'active', unread: false,
    currentRunId: null, updatedAt: '2026-08-01T00:00:00.000Z',
    ...(squadId ? { squadId } : {}),
  } as Session;
}

function mkStatusEvent(sid: string): SessionEvent {
  return {
    id: ulid(), type: 'session_status_update', sessionId: sid, createdAt: new Date().toISOString(),
    data: { state: 'idle', running: false, currentRunId: null },
  };
}

function mkNonTriggerEvent(sid: string): SessionEvent {
  return {
    id: ulid(), type: 'session_workspace_file_changed', sessionId: sid, createdAt: new Date().toISOString(),
    data: { path: 'x.ts', kind: 'change', isDir: false },
  };
}

/** 构造已装配 broadcaster（sessionStore 注入 + stores mock 返回固定聚合） */
function makeBroadcaster(store?: { getSession: ReturnType<typeof vi.fn>; listSessions: ReturnType<typeof vi.fn> }): SquadMetaBroadcaster {
  const b = new SquadMetaBroadcaster({
    squadStore: squadStore as never,
    memberStore: memberStore as never,
    squadMetaBus,
  });
  b.setSessionStore((store ?? sessionStore) as never);
  return b;
}

beforeEach(() => {
  collected = [];
  squadMetaBus = spyMetaBus();
  sessionStore = {
    getSession: vi.fn(),
    // computeAndEmit 经 computeSquadAggregate 拉全量 studio session（squadId 过滤在服务内）
    listSessions: vi.fn().mockResolvedValue([]),
  };
  squadStore = {
    getSquad: vi.fn().mockResolvedValue({
      id: 'sq-1', name: 's1', squadChatSessionId: 'chat-1', updatedAt: '2026-08-01T00:00:00.000Z',
    }),
  };
  memberStore = { listMembers: vi.fn().mockResolvedValue([]) };
});

describe('SquadMetaBroadcaster.handleSessionEvent — 触发类型路由', () => {
  it('触发类型（session_status_update）+ squad session → 路由 squadId → emit 正确 payload 到 _all', async () => {
    sessionStore.getSession.mockResolvedValue(mkSession('sess-1', 'sq-1'));
    const broadcaster = makeBroadcaster();
    broadcaster.handleSessionEvent(mkStatusEvent('sess-1'));
    // handleSessionEvent → void route → 异步链：flush microtasks 等 emit
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(collected).toHaveLength(1);
    const ev = collected[0]!;
    expect(ev.type).toBe('squad_meta_update');
    expect(ev.squadId).toBe('sq-1');
    expect(ev.data.squadId).toBe('sq-1');
    expect(ev.data.onlineCount).toBe(0);
    expect(ev.data.lastActiveAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('playground session（无 squadId）→ 跳过不 emit', async () => {
    sessionStore.getSession.mockResolvedValue(mkSession('sess-1', null));
    const broadcaster = makeBroadcaster();
    broadcaster.handleSessionEvent(mkStatusEvent('sess-1'));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(collected).toHaveLength(0);
  });

  it('非触发类型（session_workspace_file_changed）→ 跳过不 emit', async () => {
    sessionStore.getSession.mockResolvedValue(mkSession('sess-1', 'sq-1'));
    const broadcaster = makeBroadcaster();
    broadcaster.handleSessionEvent(mkNonTriggerEvent('sess-1'));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(collected).toHaveLength(0);
  });

  it('session 不存在（并发删除）→ no-op 不 emit', async () => {
    sessionStore.getSession.mockResolvedValue(undefined);
    const broadcaster = makeBroadcaster();
    broadcaster.handleSessionEvent(mkStatusEvent('gone'));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(collected).toHaveLength(0);
  });

  it('sessionStore 未注入（setSessionStore 前）→ no-op 不 emit', async () => {
    const b = new SquadMetaBroadcaster({ squadStore: squadStore as never, memberStore: memberStore as never, squadMetaBus });
    b.handleSessionEvent(mkStatusEvent('sess-1'));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(sessionStore.getSession).not.toHaveBeenCalled();
    expect(collected).toHaveLength(0);
  });

  it('SQUAD_META_TRIGGERING_TYPES 集合含 5 种触发类型，不含高频 file 事件', () => {
    for (const t of ['session_status_update', 'summary_task_update', 'session_usage_update', 'session_read_update', 'messages_cleared']) {
      expect(SQUAD_META_TRIGGERING_TYPES.has(t)).toBe(true);
    }
    expect(SQUAD_META_TRIGGERING_TYPES.has('session_workspace_file_changed')).toBe(false);
  });
});

describe('SquadMetaBroadcaster.broadcast — 显式写路径广播', () => {
  it('broadcast(squadId) → 读最新聚合 → emit squad_meta_update 到 _all', async () => {
    memberStore.listMembers.mockResolvedValue([
      { id: 'a', sessionId: 'sa', state: 'deployed' },
      { id: 'b', sessionId: 'sb', state: 'benched' },
    ]);
    const broadcaster = makeBroadcaster();
    broadcaster.broadcast('sq-1');
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(collected).toHaveLength(1);
    expect(collected[0]!.data.onlineCount).toBe(1);
  });

  it('squad 不存在（并发删除）→ no-op 不 emit', async () => {
    squadStore.getSquad.mockResolvedValue(undefined);
    const broadcaster = makeBroadcaster();
    broadcaster.broadcast('gone');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(collected).toHaveLength(0);
  });

  it('broadcast 异常吞掉（squadStore.getSquad 抛错）不向外抛', () => {
    squadStore.getSquad.mockRejectedValue(new Error('boom'));
    const broadcaster = makeBroadcaster();
    expect(() => broadcaster.broadcast('sq-1')).not.toThrow();
  });
});

describe('wrapStatusBusForUnread — squadMetaBroadcaster fan-out（2c）', () => {
  it('statusBus.emit 触发类型事件 → wrap fan-out 调 squadMetaBroadcaster.handleSessionEvent', () => {
    const realBus = new ReplayableEventBus({ replayable: true });
    const handleSpy = vi.fn();
    const runtime = { handleSessionEvent: vi.fn() } as never;
    const broadcaster = {
      handleSessionEvent: handleSpy,
    } as unknown as SquadMetaBroadcaster;
    const wrapped = wrapStatusBusForUnread(realBus, runtime, { squadMetaBroadcaster: broadcaster });

    wrapped.emit(`session_id:sess-1`, {
      data: mkStatusEvent('sess-1'),
      timestamp: new Date().toISOString(),
    });

    expect(handleSpy).toHaveBeenCalledTimes(1);
    expect(handleSpy.mock.calls[0]![0]).toMatchObject({ type: 'session_status_update', sessionId: 'sess-1' });
  });

  it('fan-out 异常吞掉不影响 emit 主路径（handleSessionEvent 抛错仍不向外抛）', () => {
    const realBus = new ReplayableEventBus({ replayable: true });
    const runtime = { handleSessionEvent: vi.fn() } as never;
    const broadcaster = {
      handleSessionEvent: () => { throw new Error('broadcast boom'); },
    } as unknown as SquadMetaBroadcaster;
    const wrapped = wrapStatusBusForUnread(realBus, runtime, { squadMetaBroadcaster: broadcaster });

    expect(() => {
      wrapped.emit(`session_id:sess-1`, {
        data: mkStatusEvent('sess-1'),
        timestamp: new Date().toISOString(),
      });
    }).not.toThrow();
  });

  it('未注入 squadMetaBroadcaster 时 wrap 仅 fan-out runtime（向后兼容）', () => {
    const realBus = new ReplayableEventBus({ replayable: true });
    const runtimeHandle = vi.fn();
    const runtime = { handleSessionEvent: runtimeHandle } as never;
    const wrapped = wrapStatusBusForUnread(realBus, runtime); // 不传 squadMetaBroadcaster

    wrapped.emit(`session_id:sess-1`, {
      data: mkStatusEvent('sess-1'),
      timestamp: new Date().toISOString(),
    });

    expect(runtimeHandle).toHaveBeenCalledTimes(1); // runtime fan-out 照旧
  });
});
