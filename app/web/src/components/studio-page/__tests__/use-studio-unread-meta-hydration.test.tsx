// @vitest-environment jsdom
/**
 * use-studio-unread-meta hydration 单测（v0.0.348 T1）
 * 参考: specs/tech/version_logs/v0.0.348/change_plan.md 决策①③④⑦⑧（三层 hydration + 竞态仲裁 + 句柄回收）
 *
 * 覆盖 acceptanceCriteria 三场景：
 *   a) 冷启动订阅前已 running：GET 基线 hydrate 后 stateMap/runningMap 正确（GET 在订阅生效前补齐首帧）
 *   b) 断连丢帧重连：onResumed 回调 → 重 GET 校正（丢帧期间 state 变化被补齐）
 *   c) 竞态：GET 在途新帧先到（updatedAt 更新）→ GET 响应后到不回退（决策④仲裁）
 *   d) unmount：onResumed 退订句柄回收（严于 use-squad-meta 先例，unmount 后 singleton 无残留回调）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// —— vi.hoisted：单例 spy（含 onResumed 捕获）+ 绝对路径 mock（参考 singleton 测试同款模式）—— //
const { singletonSpies, singletonPath, sseClientPath, chatApiPath, listByBizMock } = vi.hoisted(() => ({
  singletonSpies: {
    getCalls: 0,
    /** 当前注册的 onResumed 回调（最新注册覆盖；退订从数组移除） */
    resumedCbs: [] as Array<() => void>,
    subscribe: vi.fn(async (..._args: unknown[]) => undefined),
    unsubscribe: vi.fn(async (..._args: unknown[]) => undefined),
  },
  singletonPath: require('node:path').resolve(__dirname, '../../../lib/sse-singleton'),
  sseClientPath: require('node:path').resolve(__dirname, '../../../lib/sse-client'),
  // 注意带 .ts 扩展名（对齐 main/running-state 两个可断言的既有测试；无扩展版在 bun-vitest 下不生效）
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
  listByBizMock: vi.fn(async (): Promise<unknown[]> => []),
}));

// mock sse-singleton（lazy singleton 语义 + onResumed 注册/退订捕获）
vi.mock(singletonPath, () => {
  let singleton: object | null = null;
  return {
    getSseClient: () => {
      singletonSpies.getCalls++;
      if (!singleton) {
        singleton = {
          subscribe: async (topic: string, group: string, handler: (f: unknown) => void) => {
            await singletonSpies.subscribe(topic, group, handler);
            const subId = `sub-${singletonSpies.subscribe.mock.calls.length}-${topic}`;
            return {
              subId,
              topic,
              group,
              unsubscribe: async () => {
                await singletonSpies.unsubscribe(subId);
              },
            };
          },
          // [v0.0.348] onResumed：注册进数组返退订 fn（对齐 SseClient.onResumed 契约）
          onResumed: (cb: () => void) => {
            singletonSpies.resumedCbs.push(cb);
            return () => {
              const i = singletonSpies.resumedCbs.indexOf(cb);
              if (i >= 0) singletonSpies.resumedCbs.splice(i, 1);
            };
          },
          isConnected: () => false,
        };
      }
      return singleton;
    },
    _resetSseSingletonForTest: () => {
      singleton = null;
    },
  };
});

// mock SseClient 类：hook 不应 new SseClient（v0.0.92 后单例），意外 import 兜底抛错
vi.mock(sseClientPath, () => ({
  SseClient: vi.fn().mockImplementation(() => {
    throw new Error('use-studio-unread-meta should not new SseClient');
  }),
}));

// mock chat-api：listSessionsByBiz 可控（hydrate 数据源）+ markSessionRead 不跑真网络
vi.mock(chatApiPath, async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/chat-api')>();
  return {
    ...actual,
    listSessionsByBiz: listByBizMock,
    markSessionRead: vi.fn(async () => ({ ok: true })),
  };
});

import { useStudioUnreadMeta } from '../use-studio-unread-meta';
import type { SessionMetaUpdateEvent } from '../../../store/chat-slice';
import type { Session } from '../../chat-page/types';

/** 构造 GET 响应中的 Session（biz/state/unread/updatedAt 可控） */
function mkSession(
  sid: string,
  opts: { state?: string; unread?: boolean; updatedAt?: string },
): Session {
  return {
    id: sid,
    title: sid,
    status: 'active',
    role: 'rocky',
    state: opts.state ?? 'idle',
    unread: opts.unread === true,
    biz: 'studio',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: opts.updatedAt ?? '2026-06-28T00:00:00.000Z',
  } as unknown as Session;
}

/** 构造 session_meta_update SSE 帧（data=全量最新态 Session） */
function mkMeta(
  sid: string,
  opts: { state?: string; unread?: boolean; updatedAt?: string },
): SessionMetaUpdateEvent {
  return {
    id: `evt-${sid}-${Math.random()}`,
    type: 'session_meta_update',
    sessionId: sid,
    createdAt: new Date().toISOString(),
    data: mkSession(sid, opts) as SessionMetaUpdateEvent['data'],
  };
}

/** 取 subscribe 时注册的 frame handler（topic=session_meta / group=_all） */
function getHandler(): (frame: { data: SessionMetaUpdateEvent }) => void {
  const call = singletonSpies.subscribe.mock.calls.find(
    (c) => c[0] === 'session_meta' && c[1] === '_all',
  );
  expect(call).toBeDefined();
  return call![2] as (frame: { data: SessionMetaUpdateEvent }) => void;
}

/**
 * mock GET 响应（每次调用依次消费 lists 一项）。
 * 关键：模拟真实 fetch 时序——至少一个宏任务后才 resolve（网络 I/O 必经宏任务；
 * 纯微任务 mockResolvedValue 会跑赢 onInit await 微任务链，在 ctxRef 赋值前触发
 * mutate 被 null 守卫丢弃，与生产时序不符）。
 */
function mockGet(...lists: Array<Session[]>) {
  for (const list of lists) {
    listByBizMock.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 0));
      return list;
    });
  }
}

beforeEach(() => {
  singletonSpies.getCalls = 0;
  singletonSpies.resumedCbs.length = 0;
  singletonSpies.subscribe.mockClear();
  singletonSpies.unsubscribe.mockClear();
  listByBizMock.mockReset();
  listByBizMock.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe('useStudioUnreadMeta hydration（v0.0.348 T1 三层保障）', () => {
  it('a) 冷启动：订阅前已 running → hydrate 后 stateMap/runningMap 正确（GET 基线补首帧）', async () => {
    mockGet([
      mkSession('sess-a', { state: 'running', unread: true, updatedAt: '2026-06-28T01:00:00.000Z' }),
      mkSession('sess-b', { state: 'idle', updatedAt: '2026-06-28T01:00:00.000Z' }),
    ]);
    const { result } = renderHook(() => useStudioUnreadMeta());
    // hydrate 在 onInit 内 fire-and-forget 发起 → 等微任务链（GET resolve → mutate → merge）
    await act(async () => {
      await vi.waitFor(() => expect(listByBizMock).toHaveBeenCalledWith('studio'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.stateMap['sess-a']).toBe('running');
    expect(result.current.runningMap['sess-a']).toBe(true);
    expect(result.current.unreadMap['sess-a']).toBe(true);
    expect(result.current.stateMap['sess-b']).toBe('idle');
    expect(result.current.runningMap['sess-b']).toBe(false);
  });

  it('b) 断连重连：onResumed 回调 → 重 GET 校正（丢帧期间 state 变化被补齐）', async () => {
    mockGet([mkSession('sess-r', { state: 'idle', updatedAt: '2026-06-28T01:00:00.000Z' })]);
    const { result } = renderHook(() => useStudioUnreadMeta());
    await act(async () => {
      await vi.waitFor(() => expect(listByBizMock).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.runningMap['sess-r']).toBe(false);
    // 断连期间 state 变 running（丢帧）→ 重连 onResumed → 重 GET 拿到新态
    mockGet([mkSession('sess-r', { state: 'running', updatedAt: '2026-06-28T02:00:00.000Z' })]);
    await act(async () => {
      singletonSpies.resumedCbs.forEach((cb) => cb());
      await vi.waitFor(() => expect(listByBizMock).toHaveBeenCalledTimes(2));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.runningMap['sess-r']).toBe(true);
    expect(result.current.stateMap['sess-r']).toBe('running');
  });

  it('c) 竞态：GET 在途新帧先到（updatedAt 更新）→ GET 响应后到不回退（决策④仲裁）', async () => {
    // GET 挂起（在途）：resolve 句柄稍后手动放行
    let resolveGet: (v: Session[]) => void = () => {};
    listByBizMock.mockImplementationOnce(
      () => new Promise<Array<Session>>((r) => { resolveGet = r; }),
    );
    const { result } = renderHook(() => useStudioUnreadMeta());
    await act(async () => {
      await vi.waitFor(() => expect(singletonSpies.subscribe).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
    });
    // 新帧先到：state=running + updatedAt=02:00（比 GET 响应里的 01:00 新）
    const handler = getHandler();
    act(() => {
      handler({ data: mkMeta('sess-c', { state: 'running', updatedAt: '2026-06-28T02:00:00.000Z' }) });
    });
    expect(result.current.runningMap['sess-c']).toBe(true);
    // GET 响应后到：陈旧数据（updatedAt=01:00 idle）→ 仲裁保留 ctx 新帧，不回退
    await act(async () => {
      resolveGet([mkSession('sess-c', { state: 'idle', updatedAt: '2026-06-28T01:00:00.000Z' })]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.runningMap['sess-c']).toBe(true);
    expect(result.current.stateMap['sess-c']).toBe('running');
  });

  it('d) unmount：onResumed 退订句柄回收（singleton 无残留回调）+ 订阅句柄退订', async () => {
    const { unmount } = renderHook(() => useStudioUnreadMeta());
    await act(async () => {
      await vi.waitFor(() => expect(singletonSpies.subscribe).toHaveBeenCalled());
      await vi.waitFor(() => expect(singletonSpies.resumedCbs.length).toBe(1));
      await new Promise((r) => setTimeout(r, 0));
    });
    unmount();
    expect(singletonSpies.resumedCbs.length).toBe(0);
    expect(singletonSpies.unsubscribe).toHaveBeenCalled();
  });
});
