// @vitest-environment jsdom
/**
 * use-studio-unread-meta 单例改造单测（v0.0.92 W1 / G1 修复）
 * 参考: specs/tech/version_logs/v0.0.92.sse_opt/change_plan.md W1（method 级契约 6 行）
 *       specs/tech/app/frontend/[P0]sse_client_singleton.md §1 S1/S3（全局唯一 + 组件不碰连接）
 *
 * 覆盖 W1 关键不变量：
 *   - mount：经 getSseClient() 单例订阅 session_meta `_all`（不再 new SseClient）
 *   - hook 全周期不调 connect/destroy（连接生命周期归 app 单例，hook 仅订阅 + unsubscribe 句柄）
 *   - biz='studio' 反向守卫不动（非 studio meta 不刷 unreadMap，与 playground reducer 双向隔离）
 *   - unmount：调句柄 unsubscribe，不调 destroy（spec §1 S3）
 *   - 多次 mount 返回同一单例（getSseClient 调用次数与 mount 次数无关，单例幂等）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// —— vi.hoisted：单例 spy + 绝对路径 mock（参考 page-chat-sse-singleton-mount.test.tsx，memory: test-vitest-mock-absolute-path）—— //
const { singletonSpies, singletonPath, sseClientPath, chatApiPath } = vi.hoisted(() => ({
  singletonSpies: {
    getCalls: 0,
    connectCalls: 0,
    destroyCalls: 0,
    subscribe: vi.fn(async (..._args: unknown[]) => undefined),
    unsubscribe: vi.fn(async (..._args: unknown[]) => undefined),
  },
  singletonPath: require('node:path').resolve(__dirname, '../../../lib/sse-singleton'),
  sseClientPath: require('node:path').resolve(__dirname, '../../../lib/sse-client'),
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api'),
}));

// mock sse-singleton（lazy singleton 语义：多次 getSseClient 返回同一 fake）
vi.mock(singletonPath, () => {
  let singleton: object | null = null;
  return {
    getSseClient: () => {
      singletonSpies.getCalls++;
      if (!singleton) {
        singleton = {
          // 单例自管连接：hook 不应调 connect/destroy，这里 spy 计数以断言
          connect: async () => {
            singletonSpies.connectCalls++;
          },
          destroy: () => {
            singletonSpies.destroyCalls++;
          },
          subscribe: async (
            topic: string,
            group: string,
            handler: (f: unknown) => void,
          ) => {
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

// mock SseClient 类：本 hook 改造后不应 import SseClient 类；如意外 import 也兜底抛错
vi.mock(sseClientPath, () => ({
  SseClient: vi.fn().mockImplementation(() => {
    throw new Error('use-studio-unread-meta should not new SseClient after v0.0.92');
  }),
}));

// mock markSessionRead（fire-and-forget POST /read，不跑真网络）
vi.mock(chatApiPath, async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/chat-api')>();
  return {
    ...actual,
    markSessionRead: vi.fn(async () => ({ ok: true })),
  };
});

import { useStudioUnreadMeta } from '../use-studio-unread-meta';
import type { SessionMetaUpdateEvent } from '../../../store/chat-slice';

/** 构造 session_meta_update 事件（biz/unread 可控） */
function mkMeta(
  sid: string,
  opts: { biz?: 'studio' | 'playground'; unread?: boolean },
): SessionMetaUpdateEvent {
  return {
    id: `evt-${sid}-${Date.now()}-${Math.random()}`,
    type: 'session_meta_update',
    sessionId: sid,
    createdAt: new Date().toISOString(),
    data: {
      id: sid,
      title: sid,
      status: 'active',
      role: 'rocky',
      state: 'idle',
      running: false,
      unread: opts.unread === true,
      biz: opts.biz,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-28T00:00:00.000Z',
    } as SessionMetaUpdateEvent['data'],
  };
}

/** 取 subscribe 时注册的 handler（topic=session_meta / group=_all） */
function getHandler(): (frame: { data: SessionMetaUpdateEvent }) => void {
  expect(singletonSpies.subscribe).toHaveBeenCalled();
  const call = singletonSpies.subscribe.mock.calls.find(
    (c) => c[0] === 'session_meta' && c[1] === '_all',
  );
  expect(call).toBeDefined();
  return call![2] as (frame: { data: SessionMetaUpdateEvent }) => void;
}

beforeEach(() => {
  singletonSpies.getCalls = 0;
  singletonSpies.connectCalls = 0;
  singletonSpies.destroyCalls = 0;
  singletonSpies.subscribe.mockClear();
  singletonSpies.unsubscribe.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('useStudioUnreadMeta v0.0.92 单例改造（W1 / G1 修复）', () => {
  it('mount：经 getSseClient() 单例订阅 session_meta `_all`（不 new SseClient）', async () => {
    renderHook(() => useStudioUnreadMeta());
    // [v0.0.94 T3] 改 useLifecycle 四方法后 getSseClient 在 establishSubscriptions（onInit resolve 后）
    //   异步调用——故 getCalls 断言改 waitFor（之前是同步 useEffect 内调，renderHook 后即 ≥1）
    // subscribe 走单例（topic=session_meta / group=_all）；subscribe 被调则 getSseClient 必已调
    await vi.waitFor(() => {
      expect(singletonSpies.subscribe).toHaveBeenCalledWith(
        'session_meta',
        '_all',
        expect.any(Function),
      );
    });
    // getSseClient 被调（hook 进入 subscribe 前必经单例入口；establishSubscriptions 内已调）
    expect(singletonSpies.getCalls).toBeGreaterThanOrEqual(1);
  });

  it('hook 全周期不调 connect/destroy（连接生命周期归 app 单例，hook 仅订阅 + unsubscribe）', async () => {
    const { unmount } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(singletonSpies.subscribe).toHaveBeenCalled());
    // 等一个 microtask 让 .then(h => metaHandle = h) resolve（否则 cleanup 是 no-op）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    unmount();
    // 关键不变量：hook 不碰连接——不调 connect，不调 destroy
    expect(singletonSpies.connectCalls).toBe(0);
    expect(singletonSpies.destroyCalls).toBe(0);
  });

  it('biz="studio" + unread=true → 写入 unreadMap（反向守卫正向路径不动）', async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(singletonSpies.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    act(() => handler({ data: mkMeta('sess-studio-1', { biz: 'studio', unread: true }) }));
    expect(result.current.unreadMap['sess-studio-1']).toBe(true);
  });

  it('biz="playground" → 拒纳（与 playground reducer 双向隔离，反向守卫不动）', async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(singletonSpies.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    act(() => handler({ data: mkMeta('sess-pg-1', { biz: 'playground', unread: true }) }));
    expect(result.current.unreadMap['sess-pg-1']).toBeUndefined();
  });

  it('biz 未设（undefined）→ 拒纳（playground 缺省视为非 studio）', async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(singletonSpies.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    act(() => handler({ data: mkMeta('sess-no-biz', { unread: true }) }));
    expect(result.current.unreadMap['sess-no-biz']).toBeUndefined();
  });

  it('unmount：调句柄 unsubscribe（不调 destroy 单例）', async () => {
    const { unmount } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(singletonSpies.subscribe).toHaveBeenCalled());
    // 等 subscribe Promise resolve → metaHandle 已存（否则 cleanup 句柄是 null）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    unmount();
    await vi.waitFor(() => {
      expect(singletonSpies.unsubscribe).toHaveBeenCalled();
    });
    // 关键不变量（spec §1 S3）：cleanup 不 destroy 单例（连接归 app 级）
    expect(singletonSpies.destroyCalls).toBe(0);
  });

  it('多次 mount 共用同一单例（getSseClient 多次调用返回同一实例，subId 各自唯一）', async () => {
    const { unmount: u1 } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(singletonSpies.subscribe).toHaveBeenCalledTimes(1));
    const { unmount: u2 } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(singletonSpies.subscribe).toHaveBeenCalledTimes(2));
    // getSseClient 被调多次但单例只建一次（singletonSpies.connectCalls 由单例内部触发；hook 0 调）
    expect(singletonSpies.getCalls).toBeGreaterThanOrEqual(2);
    expect(singletonSpies.connectCalls).toBe(0);
    expect(singletonSpies.destroyCalls).toBe(0);
    u1();
    u2();
    // 全周期仍不 destroy
    expect(singletonSpies.destroyCalls).toBe(0);
  });
});
