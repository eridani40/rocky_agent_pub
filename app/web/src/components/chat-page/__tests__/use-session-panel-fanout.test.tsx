// @vitest-environment jsdom
/**
 * useSessionPanelFanout area-hook 单测（v0.0.94.component_refactor T2）
 * 参考: specs/tech/app/frontend/[P0]chat_area_hooks.md §4.2（workspace/read 扇出归此受控例外）
 *
 * 覆盖：
 *   - session_workspace_file_changed → store.setLastWorkspaceEvent(evt)
 *   - session_workspace_dir_changed → store.setLastWorkspaceEvent(evt)
 *   - session_read_update → store.setSessionUnread(sessionId, false)
 *   - session_todo_changed → store.setLastTodoEvent(evt)（第三类扇出；同 id 幂等）
 *   - 其它 session_panel type（status/usage/summary/messages_cleared）不写 store（归各 area-hook）
 *   - 切 session：cleanup unsubscribe（不 destroy 单例）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatStore } from '../../../store/chat-slice';

const sse = vi.hoisted(() => ({
  handlers: {} as Record<string, (f: { data: unknown }) => void>,
  instances: 0,
  destroyed: 0,
  unsub: [] as string[],
}));
const singletonPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/sse-singleton'));

vi.mock(singletonPath, () => {
  let subIdCounter = 0;
  class FakeSseClient {
    constructor() {
      sse.instances++;
    }
    async connect() {
      /* no-op */
    }
    async subscribe(topic: string, _group: string, handler: (f: { data: unknown }) => void) {
      sse.handlers[topic] = handler;
      const subId = `sub-${++subIdCounter}-${topic}`;
      return { subId, topic, group: _group, unsubscribe: async () => { sse.unsub.push(topic); } };
    }
    async unsubscribe(handle: { subId?: string } | string) {
      const subId = typeof handle === 'string' ? handle : handle?.subId;
      if (subId) sse.unsub.push(subId);
    }
    destroy() {
      sse.destroyed++;
    }
  }
  let singleton: FakeSseClient | null = null;
  return {
    getSseClient: () => {
      if (!singleton) singleton = new FakeSseClient();
      return singleton;
    },
    _resetSseSingletonForTest: () => {
      if (singleton) singleton.destroy();
      singleton = null;
    },
  };
});

import { useSessionPanelFanout } from '../use-session-panel-fanout';
import type { SessionEvent } from '../../../store/session-slice-reducer';
import type { WorkspaceEvent } from '../workspace-types';

function pushPanel(evt: SessionEvent): void {
  act(() => sse.handlers['session_panel']?.({ data: evt }));
}
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  sse.handlers = {};
  sse.instances = 0;
  sse.destroyed = 0;
  sse.unsub = [];
  // 清 store 状态
  useChatStore.getState().setLastWorkspaceEvent(null);
  useChatStore.getState().setSessions([]);
  useChatStore.setState({ lastTodoEvent: null });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('useSessionPanelFanout — workspace 扇出', () => {
  it('session_workspace_file_changed → store.setLastWorkspaceEvent(evt)', async () => {
    renderHook(() => useSessionPanelFanout('s1'));
    await settle();
    const evt: WorkspaceEvent = {
      type: 'session_workspace_file_changed',
      sessionId: 's1',
      createdAt: 't1',
      data: { path: 'src/a.ts', kind: 'change', isDir: false },
    };
    pushPanel(evt);
    expect(useChatStore.getState().lastWorkspaceEvent).toEqual(evt);
  });

  it('session_workspace_dir_changed → store.setLastWorkspaceEvent(evt)', async () => {
    renderHook(() => useSessionPanelFanout('s1'));
    await settle();
    const evt: WorkspaceEvent = {
      type: 'session_workspace_dir_changed',
      sessionId: 's1',
      createdAt: 't2',
      data: { workspaceDir: '/new/dir', prevDir: '/old/dir' },
    };
    pushPanel(evt);
    expect(useChatStore.getState().lastWorkspaceEvent).toEqual(evt);
  });
});

describe('useSessionPanelFanout — read 扇出', () => {
  it('session_read_update → store.setSessionUnread(sessionId, false)', async () => {
    // 预置一个 session 带 unread=true
    useChatStore.getState().setSessions([
      { id: 's1', title: 't', status: 'active', unread: true, createdAt: 't', updatedAt: 't' },
    ]);
    renderHook(() => useSessionPanelFanout('s1'));
    await settle();
    pushPanel({ type: 'session_read_update', sessionId: 's1', createdAt: 't1', data: { unread: false } });
    expect(useChatStore.getState().sessions.find((s) => s.id === 's1')?.unread).toBe(false);
  });
});

describe('useSessionPanelFanout — 不处理其它 session_panel type', () => {
  it('status/usage/summary/messages_cleared 不写 lastWorkspaceEvent 也不改 unread', async () => {
    useChatStore.getState().setSessions([
      { id: 's1', title: 't', status: 'active', unread: true, createdAt: 't', updatedAt: 't' },
    ]);
    renderHook(() => useSessionPanelFanout('s1'));
    await settle();
    pushPanel({ type: 'session_status_update', sessionId: 's1', createdAt: 't1', data: { state: 'idle', running: false, currentRunId: null } });
    pushPanel({ type: 'session_usage_update', sessionId: 's1', createdAt: 't2', data: {} as never });
    pushPanel({ type: 'summary_task_update', sessionId: 's1', createdAt: 't3', data: { status: 'running', runId: 'r1', startedAt: null, error: null } });
    pushPanel({ type: 'messages_cleared', sessionId: 's1', createdAt: 't4', data: { sessionId: 's1' } });
    expect(useChatStore.getState().lastWorkspaceEvent).toBeNull();
    expect(useChatStore.getState().lastTodoEvent).toBeNull();
    expect(useChatStore.getState().sessions.find((s) => s.id === 's1')?.unread).toBe(true);
  });
});

describe('useSessionPanelFanout — todo 扇出（v0.0.228 第三类）', () => {
  it('session_todo_changed → store.setLastTodoEvent(evt)（lastTodoEvent 写入整事件含 id）', async () => {
    renderHook(() => useSessionPanelFanout('s1'));
    await settle();
    const evt = {
      id: 'evt-t1',
      type: 'session_todo_changed' as const,
      sessionId: 's1',
      createdAt: '2026-07-31T00:00:00.000Z',
      data: {},
    };
    pushPanel(evt);
    expect(useChatStore.getState().lastTodoEvent).toEqual(evt);
    // todo 扇出不误写 workspace 通道
    expect(useChatStore.getState().lastWorkspaceEvent).toBeNull();
  });

  it('同 id 重发不重复 set（store 幂等）；新 id 正常更新', async () => {
    renderHook(() => useSessionPanelFanout('s1'));
    await settle();
    const evt1 = {
      id: 'evt-dup',
      type: 'session_todo_changed' as const,
      sessionId: 's1',
      createdAt: '2026-07-31T00:00:00.000Z',
      data: {},
    };
    pushPanel(evt1);
    const first = useChatStore.getState().lastTodoEvent;
    // 同 id 重推：引用不变（store skip，不触发下游 refetch）
    pushPanel({ ...evt1 });
    expect(useChatStore.getState().lastTodoEvent).toBe(first);
    // 新 id：正常替换
    pushPanel({ ...evt1, id: 'evt-new' });
    expect(useChatStore.getState().lastTodoEvent?.id).toBe('evt-new');
  });
});

describe('useSessionPanelFanout — 切 session cleanup', () => {
  it('unmount → unsubscribe session_panel（不 destroy 单例）', async () => {
    const { unmount } = renderHook(() => useSessionPanelFanout('s1'));
    await settle();
    expect(sse.handlers['session_panel']).toBeTruthy();
    unmount();
    expect(sse.unsub).toContain('session_panel');
    expect(sse.destroyed).toBe(0);
  });
});
