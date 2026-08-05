// @vitest-environment jsdom
/**
 * use-workspace-event-effect 单测 —— T2 effect 抽离行为 100% 平移
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §4.3（SSE 事件处理）
 *       specs/tech/version_logs/v0.0.182/change_plan.md §3（ws-panel useWorkspaceEventEffect 抽离行）
 *
 * 覆盖 acceptanceCriteria：
 *   - useWorkspaceEventEffect 行为 100% 平移（file-changed/dir-changed/watchPath/tree-loaded 语义不变）
 *
 * 验证点（与原 section-workspace-panel effect 行为对齐）：
 *   - lastWorkspaceEvent=null → 跳过（无 dispatch/watch/GET）
 *   - sid 不匹配 → 跳过
 *   - session_workspace_file_changed → dispatch file-changed，无 watch/GET
 *   - session_workspace_dir_changed → dispatch dir-changed + watchPath('') + GET tree → dispatch tree-loaded
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { initI18n } from '../../../i18n';

const { getWorkspaceTreeMock, chatApiPath } = vi.hoisted(() => ({
  getWorkspaceTreeMock: vi.fn(),
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
}));

vi.mock(chatApiPath, () => ({
  getWorkspaceTree: (...args: unknown[]) => getWorkspaceTreeMock(...args),
  openWorkspaceItem: vi.fn(async () => ({ ok: true })),
  pickWorkspaceDirectory: vi.fn(async () => ({ path: null })),
  updateSession: vi.fn(async () => ({})),
}));

import { useWorkspaceEventEffect } from '../use-workspace-event-effect';
import { useChatStore } from '../../../store/chat-slice';

beforeAll(async () => {
  await initI18n('zh-CN');
});

const ROOT_TREE = {
  workspaceDir: '/tmp/ws',
  tree: [
    { name: 'src', path: 'src', type: 'dir' as const, hasChildren: true },
    { name: 'readme.md', path: 'readme.md', type: 'file' as const, hasChildren: false },
  ],
};

beforeEach(() => {
  getWorkspaceTreeMock.mockReset();
  getWorkspaceTreeMock.mockResolvedValue(ROOT_TREE);
  useChatStore.getState().setLastWorkspaceEvent(null);
});

afterEach(() => {
  useChatStore.getState().setLastWorkspaceEvent(null);
});

describe('useWorkspaceEventEffect —— 行为平移自原 section-workspace-panel effect', () => {
  it('lastWorkspaceEvent=null → 不 dispatch / 不 watch / 不 GET', async () => {
    const dispatch = vi.fn();
    const watchPath = vi.fn();
    renderHook(() => useWorkspaceEventEffect({ sessionId: 'sess-1', dispatch, watchPath }));
    // store 已为 null，触发 re-render 验证不动作
    useChatStore.getState().setLastWorkspaceEvent(null);
    expect(dispatch).not.toHaveBeenCalled();
    expect(watchPath).not.toHaveBeenCalled();
    expect(getWorkspaceTreeMock).not.toHaveBeenCalled();
  });

  it('sid 不匹配 → 跳过', async () => {
    const dispatch = vi.fn();
    const watchPath = vi.fn();
    renderHook(() => useWorkspaceEventEffect({ sessionId: 'sess-1', dispatch, watchPath }));

    useChatStore.getState().setLastWorkspaceEvent({
      type: 'session_workspace_file_changed',
      sessionId: 'sess-OTHER',
      createdAt: '2026-07-14T10:00:00.000Z',
      data: { path: 'foo.ts', kind: 'change', isDir: false },
    });

    // 等一拍确保 effect 跑完
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatch).not.toHaveBeenCalled();
    expect(watchPath).not.toHaveBeenCalled();
  });

  it('session_workspace_file_changed → dispatch file-changed，无 watch/GET', async () => {
    const dispatch = vi.fn();
    const watchPath = vi.fn();
    renderHook(() => useWorkspaceEventEffect({ sessionId: 'sess-1', dispatch, watchPath }));

    useChatStore.getState().setLastWorkspaceEvent({
      type: 'session_workspace_file_changed',
      sessionId: 'sess-1',
      createdAt: '2026-07-14T10:00:00.000Z',
      data: { path: 'foo.ts', kind: 'change', isDir: false },
    });

    // 等一拍确保 effect 跑完
    await new Promise((r) => setTimeout(r, 0));

    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: 'file-changed',
        payload: expect.objectContaining({ type: 'session_workspace_file_changed', sessionId: 'sess-1' }),
      });
    });
    // file_changed 不触发 watchPath 或 GET（spec §4.3 仅 dispatch）
    expect(watchPath).not.toHaveBeenCalled();
    expect(getWorkspaceTreeMock).not.toHaveBeenCalled();
  });

  it('session_workspace_dir_changed → dispatch dir-changed + watchPath("") + GET tree → dispatch tree-loaded', async () => {
    const dispatch = vi.fn();
    const watchPath = vi.fn();
    renderHook(() => useWorkspaceEventEffect({ sessionId: 'sess-1', dispatch, watchPath }));

    useChatStore.getState().setLastWorkspaceEvent({
      type: 'session_workspace_dir_changed',
      sessionId: 'sess-1',
      createdAt: '2026-07-14T10:00:00.000Z',
      data: { workspaceDir: '/tmp/ws-new', prevDir: '/tmp/ws' },
    });

    // dir-changed 同步 dispatch
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: 'dir-changed',
        payload: expect.objectContaining({ type: 'session_workspace_dir_changed', sessionId: 'sess-1' }),
      });
    });
    // watchPath('') 同步触发（§2.5：re-watch 新根）
    expect(watchPath).toHaveBeenCalledWith('');
    // 兜底 GET tree → tree-loaded dispatch（异步）
    await vi.waitFor(() => {
      expect(getWorkspaceTreeMock).toHaveBeenCalledWith('sess-1');
    });
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: 'tree-loaded',
        payload: { dir: '/tmp/ws', tree: ROOT_TREE.tree },
      });
    });
  });
});
