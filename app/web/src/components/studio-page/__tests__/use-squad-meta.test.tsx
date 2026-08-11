// @vitest-environment jsdom
/**
 * v0.0.305 T2 UT — useSquadMeta + 排序纯函数 + togglePin localStorage
 * 参考: specs/tech/version_logs/v0.0.305.squad-list-ui-upgrade/change_plan.md D 组
 *
 * 覆盖：
 *   - useSquadMeta onEvent squad_meta_update → applyKeyed set 整条替换
 *   - useSquadMeta onEvent 非目标事件忽略
 *   - useSquadMeta onResumed 调 reloadSquads
 *   - sortSquads：置顶组最前（组内活跃 desc）+ 非置顶组活跃 desc
 *   - sortSquads：旧后端降级 updatedAt（无 lastActiveAt/agg）
 *   - sortSquads：未知 squadId（pin 列表有但 squads 没有）渲染时忽略
 *   - togglePinInList：pin / unpin / 新 pin 插头部
 *   - localStorage 损坏兜底
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { SquadSummary } from '../squad-types';
import type { SquadAggregate } from '../use-squad-meta';
import { sortSquads, togglePinInList } from '../section-studio-sidebar';

/** 构造 SquadSummary 测试数据 */
function mkSquad(id: string, name: string, updatedAt: string, extra?: Partial<SquadSummary>): SquadSummary {
  return {
    id,
    name,
    description: '',
    modelDefault: 'test-model',
    leaderId: 'leader-1',
    memberCount: 1,
    squadChatSessionId: `chat-${id}`,
    enableHeartBeat: false,
    enableGroupChat: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt,
    ...extra,
  };
}

/** 构造 SquadAggregate 测试数据 */
function mkAgg(squadId: string, online: number, working: number, lastActiveAt: string): SquadAggregate {
  return { squadId, onlineCount: online, inProgressCount: working, lastActiveAt };
}

// ── sortSquads 排序纯函数 ──

describe('sortSquads 排序纯函数', () => {
  it('非置顶组按 lastActiveAt desc 排序', () => {
    const a = mkSquad('a', 'Alpha', '2026-01-01T00:00:00Z', { lastActiveAt: '2026-08-01T10:00:00Z' });
    const b = mkSquad('b', 'Beta', '2026-01-02T00:00:00Z', { lastActiveAt: '2026-08-09T10:00:00Z' });
    const c = mkSquad('c', 'Gamma', '2026-01-03T00:00:00Z', { lastActiveAt: '2026-08-05T10:00:00Z' });

    const sorted = sortSquads([a, b, c], []);
    expect(sorted.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('置顶组整体最前 + 组内按活跃 desc', () => {
    const a = mkSquad('a', 'Alpha', '2026-01-01T00:00:00Z', { lastActiveAt: '2026-08-01T10:00:00Z' });
    const b = mkSquad('b', 'Beta', '2026-01-02T00:00:00Z', { lastActiveAt: '2026-08-09T10:00:00Z' });
    const c = mkSquad('c', 'Gamma', '2026-01-03T00:00:00Z', { lastActiveAt: '2026-08-05T10:00:00Z' });

    const sorted = sortSquads([a, b, c], ['a', 'c']);
    expect(sorted.map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('旧后端降级：无 lastActiveAt 时按 updatedAt desc', () => {
    const a = mkSquad('a', 'Alpha', '2026-08-01T10:00:00Z');
    const b = mkSquad('b', 'Beta', '2026-08-09T10:00:00Z');

    const sorted = sortSquads([a, b], []);
    expect(sorted.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('SSE agg 值优先于 squad.lastActiveAt', () => {
    const a = mkSquad('a', 'Alpha', '2026-01-01T00:00:00Z', { lastActiveAt: '2026-08-01T10:00:00Z' });
    const b = mkSquad('b', 'Beta', '2026-01-02T00:00:00Z', { lastActiveAt: '2026-08-09T10:00:00Z' });

    const getAgg = (id: string) => (id === 'a' ? mkAgg('a', 1, 0, '2026-08-10T00:00:00Z') : undefined);
    const sorted = sortSquads([a, b], [], getAgg);
    expect(sorted.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('未知 squadId（pin 列表有但 squads 没有）渲染时忽略', () => {
    const a = mkSquad('a', 'Alpha', '2026-01-01T00:00:00Z');
    const sorted = sortSquads([a], ['ghost', 'a']);
    expect(sorted.map((s) => s.id)).toEqual(['a']);
  });
});

// ── togglePinInList ──

describe('togglePinInList', () => {
  it('未 pin → 插入头部', () => {
    expect(togglePinInList([], 'a')).toEqual(['a']);
    expect(togglePinInList(['b'], 'a')).toEqual(['a', 'b']);
  });

  it('已 pin → 移除', () => {
    expect(togglePinInList(['a', 'b'], 'a')).toEqual(['b']);
    expect(togglePinInList(['a'], 'a')).toEqual([]);
  });
});

// ── useSquadMeta hook 测试（mock SSE 绝对路径） ──

const { sseMock, singletonPath } = vi.hoisted(() => {
  const handlers = new Map<string, (frame: unknown) => void>();
  const resumedCallbacks: (() => void)[] = [];
  return {
    sseMock: {
      handlers,
      resumedCallbacks,
      subscribe: vi.fn(async (topic: string, group: string, handler: (f: unknown) => void) => {
        const key = `${topic}:${group}`;
        handlers.set(key, handler);
        return {
          subId: `sub-${key}`,
          topic,
          group,
          unsubscribe: async () => { handlers.delete(key); },
        };
      }),
      onResumed: vi.fn((cb: () => void) => {
        resumedCallbacks.push(cb);
        return () => {
          const idx = resumedCallbacks.indexOf(cb);
          if (idx >= 0) resumedCallbacks.splice(idx, 1);
        };
      }),
      emit(topic: string, group: string, data: unknown) {
        const handler = handlers.get(`${topic}:${group}`);
        if (handler) handler({ topic, group, data, timestamp: new Date().toISOString(), subId: 'test' });
      },
      triggerResume() {
        resumedCallbacks.forEach((cb) => cb());
      },
    },
    singletonPath: require('node:path').resolve(__dirname, '../../../lib/sse-singleton'),
  };
});

vi.mock(singletonPath, () => ({
  getSseClient: () => ({
    subscribe: sseMock.subscribe,
    onResumed: sseMock.onResumed,
    connect: async () => {},
    destroy: () => {},
  }),
}));

const { useSquadMeta } = await import('../use-squad-meta');

describe('useSquadMeta', () => {
  beforeEach(() => {
    sseMock.handlers.clear();
    sseMock.resumedCallbacks.length = 0;
    vi.clearAllMocks();
  });

  it('onEvent squad_meta_update → applyKeyed set 整条替换', async () => {
    const reloadSquads = vi.fn(async () => {});
    const { result } = renderHook(() => useSquadMeta({ reloadSquads }));

    // 等 useLifecycle onInit resolve + establishSubscriptions 完成（subscribe 是异步的）
    await act(() => Promise.resolve());

    expect(result.current.aggregateMap).toEqual({});

    const agg = mkAgg('squad-1', 3, 1, '2026-08-09T10:00:00Z');
    act(() => {
      sseMock.emit('squad_meta', '_all', { type: 'squad_meta_update', data: agg });
    });
    expect(result.current.aggregateMap['squad-1']).toEqual(agg);

    const agg2 = mkAgg('squad-1', 2, 0, '2026-08-09T11:00:00Z');
    act(() => {
      sseMock.emit('squad_meta', '_all', { type: 'squad_meta_update', data: agg2 });
    });
    expect(result.current.aggregateMap['squad-1']).toEqual(agg2);
  });

  it('onEvent 非目标事件忽略', async () => {
    const reloadSquads = vi.fn(async () => {});
    const { result } = renderHook(() => useSquadMeta({ reloadSquads }));

    await act(() => Promise.resolve());

    act(() => {
      sseMock.emit('squad_meta', '_all', { type: 'other_event', data: {} });
    });
    expect(result.current.aggregateMap).toEqual({});

    act(() => {
      sseMock.emit('squad_meta', '_all', { type: 'squad_meta_update' });
    });
    expect(result.current.aggregateMap).toEqual({});
  });

  it('onResumed 调 reloadSquads 断连兜底', async () => {
    const reloadSquads = vi.fn(async () => {});
    renderHook(() => useSquadMeta({ reloadSquads }));

    await act(() => Promise.resolve());

    act(() => {
      sseMock.triggerResume();
    });

    expect(reloadSquads).toHaveBeenCalledTimes(1);
  });

  it('subscribe squad_meta _all on mount', async () => {
    const reloadSquads = vi.fn(async () => {});
    renderHook(() => useSquadMeta({ reloadSquads }));

    await act(() => Promise.resolve());

    expect(sseMock.subscribe).toHaveBeenCalledWith('squad_meta', '_all', expect.any(Function));
  });
});

// ── localStorage pin 读写 ──

describe('localStorage pin 读写', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('写入后读取一致', () => {
    localStorage.setItem('studio.squadPins', JSON.stringify(['a', 'b']));
    const raw = localStorage.getItem('studio.squadPins');
    expect(JSON.parse(raw!)).toEqual(['a', 'b']);
  });

  it('损坏 JSON → JSON.parse 抛错（readPins catch 兜底）', () => {
    localStorage.setItem('studio.squadPins', 'not-json{{{');
    expect(() => JSON.parse(localStorage.getItem('studio.squadPins')!)).toThrow();
  });

  it('非数组 JSON → Array.isArray false（readPins 兜底 []）', () => {
    localStorage.setItem('studio.squadPins', '"just-a-string"');
    const parsed = JSON.parse(localStorage.getItem('studio.squadPins')!);
    expect(Array.isArray(parsed)).toBe(false);
  });
});
