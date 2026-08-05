// @vitest-environment jsdom
/**
 * use-chat-actions hook 单测（v0.0.216 裁剪后：列表/拓扑 5 handler）
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §2.5（A3 原始重组 + INV-A3-2 stale closure）
 *       specs/tech/version_logs/v0.0.216/change_plan.md C 段（会话内 handler 内置 SectionChatSession）
 *
 * 覆盖：
 *   - handler 行为等价：openSession / handleCreate / handleDelete / handleRenameTitle / handleSelectSub
 *   - INV-A3-2 stale closure 防护：openSession deps 含 sessions；handleDelete deps 含 activeSessionId
 *   - 错误路径：handleCreate/handleDelete catch → setError
 *   （send/picker/compact/clear/enqueue 类 handler 已迁 SectionChatSession/useChatChrome，
 *    对应断言见 use-chat-chrome.test.ts + section-chat-session.test.tsx）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const apiMocks = vi.hoisted(() => ({
  createSession: vi.fn(async () => ({ id: 'new-sess' })),
  deleteSession: vi.fn(async () => undefined),
  listSessions: vi.fn(async () => [] as unknown[]),
  markSessionRead: vi.fn(async () => ({ ok: true, session: { unread: false } })),
  updateSession: vi.fn(async () => ({})),
  // chat-api barrel 还导出其他函数，mock 全部以 noop 避免「No export defined on mock」
  cancelEnqueue: vi.fn(async () => ({ ok: true })),
  postClear: vi.fn(async () => ({ ok: true })),
  postCompact: vi.fn(async () => ({ ok: true })),
  postMessage: vi.fn(async () => ({ runId: 'r' })),
  listChildren: vi.fn(async () => ({ running: [], terminated: [] })),
  getSession: vi.fn(async () => ({})),
  getSessionChrome: vi.fn(async () => ({})),
  getMessages: vi.fn(async () => ({ items: [], hasMore: false })),
  getInbox: vi.fn(async () => []),
  getPendingToolCall: vi.fn(async () => null),
  abortSession: vi.fn(async () => ({ ok: true })),
  getSessionUsage: vi.fn(async () => null),
  getSummary: vi.fn(async () => null),
  getWorkspaceTree: vi.fn(async () => ({ workspaceDir: '', tree: [] })),
  openWorkspaceItem: vi.fn(async () => undefined),
  pickWorkspaceDirectory: vi.fn(async () => undefined),
  watchWorkspaceDir: vi.fn(async () => ({ ok: true })),
  unwatchWorkspaceDir: vi.fn(async () => ({ ok: true })),
  req: vi.fn(),
}));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'));
vi.mock(apiPath, () => apiMocks);

import { useChatActions } from '../use-chat-actions';
import type { UseChatActionsDeps } from '../use-chat-actions';
import type { Session } from '../types';

/** 构造最小 deps（测试可覆盖 store setters） */
function makeDeps(overrides: Partial<UseChatActionsDeps> = {}): UseChatActionsDeps {
  return {
    activeSessionId: 'sess-A',
    sessions: [] as Session[],
    setSessions: vi.fn(),
    setActiveSession: vi.fn(),
    setSessionUnread: vi.fn(),
    setActiveSubId: vi.fn(),
    setError: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(apiMocks).forEach((m) => (m as ReturnType<typeof vi.fn>).mockClear());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('use-chat-actions — handler 行为等价', () => {
  it('openSession 非subagent: setActiveSubId(null) + setActiveSession(sid) + markSessionRead', async () => {
    const sessions: Session[] = [{ id: 'sess-A', title: 'A', status: 'active', createdAt: '', updatedAt: '' }];
    const deps = makeDeps({ sessions });
    const { result } = renderHook(() => useChatActions(deps));

    await act(async () => {
      await result.current.openSession('sess-A');
    });

    expect(deps.setActiveSubId).toHaveBeenCalledWith(null);
    expect(deps.setActiveSession).toHaveBeenCalledWith('sess-A');
    expect(apiMocks.markSessionRead).toHaveBeenCalledWith('sess-A');
  });

  it('openSession subagent: 不清 activeSubId（保护 handleSelectSub 先设的 subSid）', async () => {
    const sessions: Session[] = [
      { id: 'sub-1', title: 'sub', status: 'active', derivation: 'subagent', createdAt: '', updatedAt: '' },
    ];
    const deps = makeDeps({ sessions });
    const { result } = renderHook(() => useChatActions(deps));

    await act(async () => {
      await result.current.openSession('sub-1');
    });

    expect(deps.setActiveSubId).not.toHaveBeenCalled();
    expect(deps.setActiveSession).toHaveBeenCalledWith('sub-1');
  });

  it('handleCreate: createSession + listSessions + setSessions + openSession(newId)', async () => {
    const setSessions = vi.fn();
    const deps = makeDeps({ setSessions });
    const { result } = renderHook(() => useChatActions(deps));

    await act(async () => {
      await result.current.handleCreate();
    });

    expect(apiMocks.createSession).toHaveBeenCalled();
    expect(apiMocks.listSessions).toHaveBeenCalled();
    expect(setSessions).toHaveBeenCalled();
    // openSession(new-sess) 被触发（markSessionRead 是 openSession 的副作用）
    expect(apiMocks.markSessionRead).toHaveBeenCalledWith('new-sess');
  });

  it('handleCreate catch: setError on createSession throw', async () => {
    apiMocks.createSession.mockRejectedValueOnce(new Error('boom'));
    const setError = vi.fn();
    const deps = makeDeps({ setError });
    const { result } = renderHook(() => useChatActions(deps));

    await act(async () => {
      await result.current.handleCreate();
    });

    expect(setError).toHaveBeenCalledWith('boom');
  });

  it('handleDelete: deleteSession + listSessions + setSessions', async () => {
    const setSessions = vi.fn();
    const deps = makeDeps({ activeSessionId: 'sess-A', setSessions });
    const { result } = renderHook(() => useChatActions(deps));

    await act(async () => {
      await result.current.handleDelete('sess-A');
    });

    expect(apiMocks.deleteSession).toHaveBeenCalledWith('sess-A');
    expect(setSessions).toHaveBeenCalled();
  });

  it('handleDelete active session: 清 activeSubId + setActiveSession(null)（messages 清残留由 key remount 承担）', async () => {
    const setActiveSession = vi.fn();
    const setActiveSubId = vi.fn();
    const deps = makeDeps({ activeSessionId: 'sess-A', setActiveSession, setActiveSubId });
    const { result } = renderHook(() => useChatActions(deps));

    await act(async () => {
      await result.current.handleDelete('sess-A');
    });

    expect(setActiveSubId).toHaveBeenCalledWith(null);
    expect(setActiveSession).toHaveBeenCalledWith(null);
  });

  it('handleDelete catch: setError on deleteSession throw', async () => {
    apiMocks.deleteSession.mockRejectedValueOnce(new Error('del failed'));
    const setError = vi.fn();
    const deps = makeDeps({ setError });
    const { result } = renderHook(() => useChatActions(deps));

    await act(async () => {
      await result.current.handleDelete('sess-X');
    });

    expect(setError).toHaveBeenCalledWith('del failed');
  });

  it('handleRenameTitle: updateSession {title, titled:true}', () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useChatActions(deps));

    act(() => {
      result.current.handleRenameTitle('sess-A', '新名字');
    });

    expect(apiMocks.updateSession).toHaveBeenCalledWith('sess-A', { title: '新名字', titled: true });
  });

  it('handleSelectSub: setActiveSubId + openSession(subSid)', async () => {
    const setActiveSubId = vi.fn();
    const deps = makeDeps({ setActiveSubId });
    const { result } = renderHook(() => useChatActions(deps));

    await act(async () => {
      result.current.handleSelectSub('sub-1');
    });

    expect(setActiveSubId).toHaveBeenCalledWith('sub-1');
    // openSession(sub-1) 触发 markSessionRead
    expect(apiMocks.markSessionRead).toHaveBeenCalledWith('sub-1');
  });
});

describe('use-chat-actions — INV-A3-2 stale closure 防护', () => {
  it('openSession deps 含 sessions: rerender 后读到最新 sessions（不锁旧空列表）', async () => {
    // 首次渲染：sessions=[] → openSession('sub-1') 查不到 derivation，会清 activeSubId
    const deps = makeDeps({ sessions: [] });
    const { result, rerender } = renderHook((deps) => useChatActions(deps), { initialProps: deps });

    // rerender 后 sessions 含 sub-1（subagent），不清 activeSubId
    const newSessions: Session[] = [
      { id: 'sub-1', title: 'sub', status: 'active', derivation: 'subagent', createdAt: '', updatedAt: '' },
    ];
    const setActiveSubId = vi.fn();
    rerender({ ...deps, sessions: newSessions, setActiveSubId });

    await act(async () => {
      await result.current.openSession('sub-1');
    });

    // 关键：deps 含 sessions → useCallback 重建 → 闭包读最新 sessions → sub-1 是 subagent → 不清
    expect(setActiveSubId).not.toHaveBeenCalled();
  });

  it('handleDelete deps 含 activeSessionId: rerender 后 activeSessionId 切换读到最新值', async () => {
    // 初始 activeSessionId='sess-A'
    const deps = makeDeps({ activeSessionId: 'sess-A' });
    const { result, rerender } = renderHook((deps) => useChatActions(deps), { initialProps: deps });

    // 切到 sess-B 后删除 sess-A（不是当前 active 了）→ 不应清 active
    const setActiveSession = vi.fn();
    const setActiveSubId = vi.fn();
    rerender({ ...deps, activeSessionId: 'sess-B', setActiveSession, setActiveSubId });

    await act(async () => {
      await result.current.handleDelete('sess-A');
    });

    // 关键断言：activeSessionId=sess-B ≠ 'sess-A' → 不清 active session
    expect(setActiveSession).not.toHaveBeenCalled();
    expect(setActiveSubId).not.toHaveBeenCalled();
  });
});
