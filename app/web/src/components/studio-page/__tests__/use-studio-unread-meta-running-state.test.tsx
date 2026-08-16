/**
 * @vitest-environment jsdom
 * use-studio-unread-meta running/state 提取单测（v0.0.101 T6）
 * 参考: specs/ui/components/studio-page/studio-sidebar.md（[v0.0.101] running spinner/state 透传）
 *       reqs/[done] v0.0.101.ask_question_tool/2-running-indicator.md（#2 studio 透传）
 *       specs/tech/version_logs/v0.0.101/change_plan.md 模块 I
 *
 * 覆盖 acceptanceCriteria：
 *   - session_meta 广播 biz='studio' → 写入 runningMap（state∈{running,interrupting}→true）
 *   - 同帧写入 stateMap（含 suspended → 「?」）
 *   - biz='playground'（或 undefined）→ 拒纳 running/state（双向隔离）
 *   - state 'running'→'idle' 转换：runningMap 对应 key 翻 false；stateMap 更新
 *   - state 'suspended'：runningMap=false（INV-2 排除），stateMap='suspended'
 *   - state 缺省：保留旧 stateMap 值（不覆盖）；runningMap 写 false
 *   - markReadAndClear 仅清 unread，不动 running/state（切 chat 不是状态变化）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// —— vi.hoisted 提升 spy + 绝对路径 mock（参考 use-studio-unread-meta.test.tsx 同款模式）—— //
const { sseClientMock, metaHandleMock, handleUnsubscribeSpy, markReadMock, listByBizMock, sseClientPath, chatApiPath } = vi.hoisted(() => {
  const handleUnsubscribeSpy = vi.fn().mockResolvedValue(undefined);
  return {
    sseClientMock: {
      connect: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      destroy: vi.fn(),
      // [v0.0.348] onResumed：注册断连回调返退订 fn（T1 三层 hydration 需要）
      onResumed: vi.fn(() => vi.fn()),
    },
    metaHandleMock: { unsubscribe: handleUnsubscribeSpy },
    handleUnsubscribeSpy,
    markReadMock: vi.fn(),
    // [v0.0.348] hydrate GET 数据源（本文件不测 hydration，mock 空表防真 fetch）
    listByBizMock: vi.fn(async () => [] as Array<never>),
    sseClientPath: require('node:path').resolve(__dirname, '../../../lib/sse-client'),
    chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
  };
});

vi.mock(sseClientPath, () => ({
  SseClient: vi.fn().mockImplementation(() => sseClientMock),
}));

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
import type { SessionState } from '../../chat-page/types';

/** 构造 session_meta_update 事件（biz/state/unread 可控） */
function mkMeta(
  sid: string,
  opts: { biz?: 'studio' | 'playground'; state?: SessionState; unread?: boolean },
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
      state: opts.state ?? 'idle',
      running: opts.state === 'running' || opts.state === 'interrupting',
      unread: opts.unread === true,
      biz: opts.biz,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-28T00:00:00.000Z',
    } as SessionMetaUpdateEvent['data'],
  };
}

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
  sseClientMock.subscribe.mockResolvedValue(metaHandleMock);
  sseClientMock.unsubscribe.mockResolvedValue(undefined);
  markReadMock.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
});

describe('useStudioUnreadMeta running/state 提取（v0.0.101 T6）', () => {
  it("biz='studio' + state='running' → runningMap[sid]=true + stateMap[sid]='running'", async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    act(() => handler({ data: mkMeta('s-run', { biz: 'studio', state: 'running' }) }));
    expect(result.current.runningMap['s-run']).toBe(true);
    expect(result.current.stateMap['s-run']).toBe('running');
  });

  it("biz='studio' + state='interrupting' → runningMap=true（interrupting 属 running 态）", async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    act(() => handler({ data: mkMeta('s-int', { biz: 'studio', state: 'interrupting' }) }));
    expect(result.current.runningMap['s-int']).toBe(true);
    expect(result.current.stateMap['s-int']).toBe('interrupting');
  });

  it("biz='studio' + state='suspended' → runningMap=false（INV-2 排除）+ stateMap='suspended'", async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    act(() => handler({ data: mkMeta('s-sus', { biz: 'studio', state: 'suspended' }) }));
    expect(result.current.runningMap['s-sus']).toBe(false);
    expect(result.current.stateMap['s-sus']).toBe('suspended');
  });

  it("biz='studio' + state='idle' → runningMap=false + stateMap='idle'", async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    act(() => handler({ data: mkMeta('s-idle', { biz: 'studio', state: 'idle' }) }));
    expect(result.current.runningMap['s-idle']).toBe(false);
    expect(result.current.stateMap['s-idle']).toBe('idle');
  });

  it("state 转换 running→idle：runningMap 翻 false + stateMap 更新（caller 据 stateMap 切 spinner/无）", async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    // 先 running
    act(() => handler({ data: mkMeta('s-flip', { biz: 'studio', state: 'running' }) }));
    expect(result.current.runningMap['s-flip']).toBe(true);
    // 转 idle
    act(() => handler({ data: mkMeta('s-flip', { biz: 'studio', state: 'idle' }) }));
    expect(result.current.runningMap['s-flip']).toBe(false);
    expect(result.current.stateMap['s-flip']).toBe('idle');
  });

  it("state 转换 running→suspended：runningMap 翻 false（INV-2）+ stateMap='suspended'", async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    act(() => handler({ data: mkMeta('s-r2s', { biz: 'studio', state: 'running' }) }));
    expect(result.current.runningMap['s-r2s']).toBe(true);
    // 转 suspended（HITL 悬挂）
    act(() => handler({ data: mkMeta('s-r2s', { biz: 'studio', state: 'suspended' }) }));
    expect(result.current.runningMap['s-r2s']).toBe(false);
    expect(result.current.stateMap['s-r2s']).toBe('suspended');
  });

  it("biz='playground' → 拒纳 running/state（双向隔离）", async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    act(() => handler({ data: mkMeta('s-pg', { biz: 'playground', state: 'running' }) }));
    expect(result.current.runningMap['s-pg']).toBeUndefined();
    expect(result.current.stateMap['s-pg']).toBeUndefined();
  });

  it('biz 未设（undefined）→ 拒纳（playground 缺省视为非 studio）', async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    act(() => handler({ data: mkMeta('s-undef-biz', { state: 'running' }) }));
    expect(result.current.runningMap['s-undef-biz']).toBeUndefined();
    expect(result.current.stateMap['s-undef-biz']).toBeUndefined();
  });

  it('markReadAndClear 仅清 unread，不动 running/state（切 chat 不是状态变化）', async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    // session running + 有未读
    act(() => handler({ data: mkMeta('s-clear', { biz: 'studio', state: 'running', unread: true }) }));
    expect(result.current.unreadMap['s-clear']).toBe(true);
    expect(result.current.runningMap['s-clear']).toBe(true);
    expect(result.current.stateMap['s-clear']).toBe('running');
    // 点 chat 节点 → 清 unread 但保留 running/state
    act(() => result.current.markReadAndClear('s-clear'));
    expect(result.current.unreadMap['s-clear']).toBe(false);
    // running/state 不动（切 chat ≠ 状态变化，SSE 兜底会同步）
    expect(result.current.runningMap['s-clear']).toBe(true);
    expect(result.current.stateMap['s-clear']).toBe('running');
    expect(markReadMock).toHaveBeenCalledWith('s-clear');
  });

  it('三张 map 独立：unread 变化不影响 running/state；state 变化不影响 unread', async () => {
    const { result } = renderHook(() => useStudioUnreadMeta());
    await vi.waitFor(() => expect(sseClientMock.subscribe).toHaveBeenCalled());
    const handler = getHandler();
    // 初始 idle + unread
    act(() => handler({ data: mkMeta('s-decouple', { biz: 'studio', state: 'idle', unread: true }) }));
    expect(result.current.unreadMap['s-decouple']).toBe(true);
    expect(result.current.runningMap['s-decouple']).toBe(false);
    // 仅 state 变 running（unread 不变）
    act(() => handler({ data: mkMeta('s-decouple', { biz: 'studio', state: 'running', unread: true }) }));
    expect(result.current.unreadMap['s-decouple']).toBe(true);
    expect(result.current.runningMap['s-decouple']).toBe(true);
    // 仅 unread 变 false（state 不变）
    act(() => handler({ data: mkMeta('s-decouple', { biz: 'studio', state: 'running', unread: false }) }));
    expect(result.current.unreadMap['s-decouple']).toBe(false);
    expect(result.current.runningMap['s-decouple']).toBe(true);
  });
});
