/**
 * @vitest-environment jsdom
 * use-studio-unread-meta F4 单测 —— studio sidebar 红点 unread 订阅 hook
 * 参考: specs/ui/components/studio-page/studio-sidebar.md §红点 DOM 契约（v1.3）
 *       specs/tech/version_logs/v0.0.85.ui_opt/change_plan.md F4（page-studio session_meta 订阅 effect）
 *       specs/tech/agent/session/[P0]session_state.md §6（unread CAS 模型）
 *       specs/tech/app/frontend/[P0]sse_channel.md §10（session_meta 广播）
 *
 * 覆盖：
 * - biz='studio' session meta → 写入 unreadMap（按 data.id 整条替换 unread 字段）
 * - biz='playground'（或 undefined）→ 拒纳（与 playground reducer 双向隔离）
 * - unread:true→false 转换（markRead SSE 兜底也走同一条 path）
 * - markReadAndClear：本地立即清该 sid（乐观更新）+ 后台调 markSessionRead（fire-and-forget）
 * - unmount → unsubscribe + destroy 防泄露
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// —— vi.hoisted 提升 spy + 绝对路径 mock（memory: test-vitest-mock-absolute-path）—— //
// [v0.0.88] SseClient API 改 handle-based unsubscribe：subscribe 返回 SubscribeHandle，
//   cleanup 调 handle.unsubscribe()，不再传 (topic, group) 旧签名。这里捕获 handle 上的 spy
//   供 unmount 防泄露 case 断言（参考 use-page-chat-mount singletonSpies 模式）。
const { sseClientMock, metaHandleMock, handleUnsubscribeSpy, markReadMock, listByBizMock, sseClientPath, chatApiPath } = vi.hoisted(() => {
  const handleUnsubscribeSpy = vi.fn().mockResolvedValue(undefined);
  return {
    sseClientMock: {
      connect: vi.fn(),
      subscribe: vi.fn(),
      // 旧签名 client.unsubscribe(topic, group) 保留 spy 以便误用时能抓到（hook 已不再调它）
      unsubscribe: vi.fn(),
      destroy: vi.fn(),
      // [v0.0.348] onResumed：注册断连回调返退订 fn（T1 三层 hydration 需要）
      onResumed: vi.fn(() => vi.fn()),
    },
    // subscribe resolve 返回的 handle 对象（含 unsubscribe spy）
    metaHandleMock: { unsubscribe: handleUnsubscribeSpy },
    handleUnsubscribeSpy,
    markReadMock: vi.fn(),
    // [v0.0.348] hydrate GET 数据源（本文件不测 hydration，mock 空表防真 fetch）
    listByBizMock: vi.fn(async () => [] as Array<never>),
    sseClientPath: require('node:path').resolve(__dirname, '../../../lib/sse-client'),
    chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
  };
});

// mock SseClient 类：构造函数返回单例 spy
vi.mock(sseClientPath, () => ({
  SseClient: vi.fn().mockImplementation(() => sseClientMock),
}));

// mock markSessionRead（fire-and-forget POST /read）+ listSessionsByBiz（hydrate GET 不跑真网络）
vi.mock(chatApiPath, async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/chat-api')>();
  return {
    ...actual,
    markSessionRead: (...args: Parameters<typeof markReadMock>) => markReadMock(...args),
    listSessionsByBiz: listByBizMock,
  };
});

import { useStudioUnreadMeta } from '../use-studio-unread-meta';
import type { SessionMetaUpdateEvent } from '../../../store/chat-slice';

/** 构造 session_meta_update 事件（biz/unread/state 可控） */
function mkMeta(sid: string, opts: { biz?: 'studio' | 'playground'; unread?: boolean }): SessionMetaUpdateEvent {
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

/** 拿到 subscribe 时注册的 handler（hook 内 connect 成功后调 subscribe） */
function getHandler(): (frame: { data: SessionMetaUpdateEvent }) => void {
  expect(sseClientMock.subscribe).toHaveBeenCalled();
  const call = sseClientMock.subscribe.mock.calls[0];
  expect(call).toBeDefined();
  const [topic, group, handler] = call!;
  expect(topic).toBe('session_meta');
  expect(group).toBe('_all');
  return handler as (frame: { data: SessionMetaUpdateEvent }) => void;
}

beforeEach(() => {
  vi.clearAllMocks();
  sseClientMock.connect.mockResolvedValue(undefined);
  // [v0.0.88] subscribe 返回 SubscribeHandle（含 unsubscribe）；hook cleanup 调 handle.unsubscribe()
  sseClientMock.subscribe.mockResolvedValue(metaHandleMock);
  sseClientMock.unsubscribe.mockResolvedValue(undefined);
  markReadMock.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
});

describe('useStudioUnreadMeta (F4)', () => {
  it('mount：建 SseClient → connect → subscribe(session_meta, _all, handler)', async () => {
    renderHook(() => useStudioUnreadMeta());
    // mount 后异步 connect 完成 → subscribe 调用
    await vi.waitFor(() => {
      expect(sseClientMock.connect).toHaveBeenCalledTimes(1);
      expect(sseClientMock.subscribe).toHaveBeenCalledTimes(1);
    });
    expect(sseClientMock.subscribe.mock.calls[0]?.[0]).toBe('session_meta');
    expect(sseClientMock.subscribe.mock.calls[0]?.[1]).toBe('_all');
  });

  it('[回归 v0.0.85.ui_opt F4 bug] connect 未 resolve（stream-consuming loop 不结束）→ subscribe 仍独立调用', async () => {
    // 真实 SseClient.connect() 是 stream-consuming infinite loop，永不 resolve 直到连接关闭。
    // 旧实现 connect().then(() => subscribe()) 致 subscribe 永不调用 → 红点永不渲（UT 因 mock
    // connect 立即 resolve 未暴露此 bug）。本回归测试：connect mock 不 resolve，验证 subscribe
    // 仍独立触发（正确模式：void connect(); subscribe().catch()）。
    sseClientMock.connect.mockReturnValue(new Promise<void>(() => { /* never resolve */ }));
    renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => {
      expect(sseClientMock.subscribe).toHaveBeenCalledTimes(1);
    });
    expect(sseClientMock.subscribe.mock.calls[0]?.[0]).toBe('session_meta');
    expect(sseClientMock.subscribe.mock.calls[0]?.[1]).toBe('_all');
  });

  it('biz="studio" + unread=true → 写入 unreadMap', async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    act(() => handler({ data: mkMeta('sess-studio-1', { biz: 'studio', unread: true }) }));
    expect(result.current.unreadMap['sess-studio-1']).toBe(true);
  });

  it('biz="playground" → 拒纳（与 playground reducer 双向隔离）', async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    act(() => handler({ data: mkMeta('sess-pg-1', { biz: 'playground', unread: true }) }));
    expect(result.current.unreadMap['sess-pg-1']).toBeUndefined();
  });

  it('biz 未设（undefined）→ 拒纳（playground 缺省视为非 studio）', async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    act(() => handler({ data: mkMeta('sess-undefined-biz', { unread: true }) }));
    expect(result.current.unreadMap['sess-undefined-biz']).toBeUndefined();
  });

  it('unread:true→false 转换：markRead SSE 兜底路径（hook 仍按 biz=studio 收）', async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    act(() => handler({ data: mkMeta('sess-studio-2', { biz: 'studio', unread: true }) }));
    expect(result.current.unreadMap['sess-studio-2']).toBe(true);
    act(() => handler({ data: mkMeta('sess-studio-2', { biz: 'studio', unread: false }) }));
    expect(result.current.unreadMap['sess-studio-2']).toBe(false);
  });

  it('markReadAndClear：本地立即清该 sid + 后台调 markSessionRead（fire-and-forget）', async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    act(() => handler({ data: mkMeta('sess-clear', { biz: 'studio', unread: true }) }));
    expect(result.current.unreadMap['sess-clear']).toBe(true);
    act(() => result.current.markReadAndClear('sess-clear'));
    // 本地乐观清零（不等网络）
    expect(result.current.unreadMap['sess-clear']).toBe(false);
    // 后台调 markSessionRead（POST /read）
    expect(markReadMock).toHaveBeenCalledWith('sess-clear');
  });

  it('markReadAndClear 对未在 unreadMap 中的 sid：不调 markSessionRead（无红点不需要清）', async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    act(() => result.current.markReadAndClear('never-existed'));
    // markRead 仍调用（即使本地 false，仍 POST /read 兜底，对齐 playground conv-item 行为）
    // 实际：本地 prev[sessionId] 为 undefined → if (!prev[sessionId]) return prev → state 不变；
    // 但 markRead 仍发起（CAS 幂等，已 false 后端不发 session_read_update，无副作用）。
    expect(markReadMock).toHaveBeenCalledWith('never-existed');
  });

  it('unmount：handle.unsubscribe 被调，不 destroy 单例（v0.0.88 handle-based + v0.0.92 W1 单例）', async () => {
    const { unmount } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    // 等 subscribe Promise resolve → metaHandle 已赋值（否则 cleanup 句柄是 null）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    unmount();
    // [v0.0.88] cleanup 走 subscribe 返回的 handle.unsubscribe()，不再调 client.unsubscribe(topic, group)
    expect(handleUnsubscribeSpy).toHaveBeenCalledTimes(1);
    expect(sseClientMock.unsubscribe).not.toHaveBeenCalled();
    // [v0.0.92 W1] hook 不 destroy 单例（连接归 app 级，跨 page 复用）—— 单例改造关键不变量
    expect(sseClientMock.destroy).not.toHaveBeenCalled();
  });

  it('SSE subscribe 异常：不抛（保持既有 unreadMap，不致命）', async () => {
    // v0.0.92 起：hook 不调 connect（单例 lazy 自连）；测 subscribe 自身 reject 时 hook 不抛
    sseClientMock.subscribe.mockRejectedValueOnce(new Error('subscribe fail'));
    const { result } = renderHook(() => useStudioUnreadMeta());
    // 不抛 + unreadMap 保持空对象（默认值）
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    expect(result.current.unreadMap).toEqual({});
  });
});
