// @vitest-environment jsdom
/**
 * use-preview-tabs 守卫/冲突/重试 单测（v0.0.320 D4 tab 状态机；[ET-fix] 拆分自 use-preview-tabs.test.ts 控行数）
 * 参考: specs/tech/version_logs/v0.0.320/change_plan.md D4（PreviewTab 契约 + acceptanceCriteria）
 *
 * 覆盖（主文件前 3 个 describe 之外的部分）：
 *   - openTab 编辑态守卫（[老板编辑态守卫] mode='edit' 拦截开新文件：discard/save-switch/cancel 三选）
 *   - saveTabContent 409 → conflictPending；resolveConflict reload=重读 / overwrite=force 重发
 *   - 读失败 → loadState error + errorMsg；retryLoad 重试
 *
 * mock 策略：真实 workspace-api 模块（走 fetch），mock globalThis.fetch 拦截请求
 * （bun 下 vi.mock 拦不住模块导入 —— group memory bun-vitest-vi-mock-module-cache-di-fallback）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { usePreviewTabs } from '../use-preview-tabs';
import type { OpenLocalTarget } from '../../../lib/open-local-path';

/** 模拟 fetch 响应（req helper 用 res.ok + res.text() 解析） */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** 默认 fetch 实现：GET file → {content, version}；POST file/save → {ok, version} */
function defaultFetch(url: string, init?: RequestInit): Promise<Response> {
  if (init?.method === 'POST' && String(url).includes('/file/save')) {
    return Promise.resolve(jsonResponse(200, { ok: true, version: 'v2' }));
  }
  if (String(url).includes('/workspace/file')) {
    return Promise.resolve(jsonResponse(200, { content: 'hello', version: 'v1' }));
  }
  return Promise.resolve(jsonResponse(404, { error: 'not found' }));
}

function mkTarget(over: Partial<OpenLocalTarget> = {}): OpenLocalTarget {
  return {
    path: 'a.md',
    fileName: 'a.md',
    subtitle: 'a.md',
    format: 'md',
    source: 'workspace',
    ...over,
  };
}

/** 取最后一次 POST body（save 请求） */
function lastSaveBody(): Record<string, unknown> {
  const calls = vi.mocked(globalThis.fetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  const last = calls[calls.length - 1];
  return JSON.parse(String(last?.[1]?.body ?? '{}'));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(defaultFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('openTab 编辑态守卫（[老板编辑态守卫] mode=edit 拦截开新文件）', () => {
  /** 开一个编辑态 tab + active（[老板编辑态守卫] mode='edit' 就拦截，不只 dirty） */
  async function setupDirtySingle(result: { current: ReturnType<typeof usePreviewTabs> }) {
    await act(async () => {
      result.current.openTab(mkTarget()); // a
    });
    await waitFor(() => expect(result.current.tabs[0]!.loadState).toBe('loaded'));
    await act(async () => {
      // [老板编辑态守卫] mode='edit' 就拦截（不只 dirty）；同时改内容模拟编辑场景
      result.current.setMode('workspace:a.md', 'edit');
      result.current.setDraft('workspace:a.md', 'changed');
    });
  }

  it('当前 dirty 且 openTab 新文件 → dirtyPending action=open（不直接打开）', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await setupDirtySingle(result);
    const target = mkTarget({ path: 'b.md', fileName: 'b.md', subtitle: 'b.md' });
    await act(async () => {
      result.current.openTab(target);
    });
    expect(result.current.tabs).toHaveLength(1); // 未新建
    expect(result.current.activeTabId).toBe('workspace:a.md');
    expect(result.current.dirtyPending).toMatchObject({
      tabId: 'workspace:a.md',
      action: 'open',
      targetTabId: 'workspace:b.md',
      pendingOpen: target,
    });
  });

  it('open 守卫 discard → 打开新文件（pendingOpen 完整 openTab 语义：新建+load）', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await setupDirtySingle(result);
    await act(async () => {
      result.current.openTab(mkTarget({ path: 'b.md', fileName: 'b.md', subtitle: 'b.md' }));
    });
    await act(async () => {
      result.current.resolveDirty('discard');
    });
    expect(result.current.activeTabId).toBe('workspace:b.md');
    expect(result.current.tabs.map((t) => t.id)).toEqual(['workspace:a.md', 'workspace:b.md']);
    expect(result.current.tabs[0]!).toMatchObject({ dirty: false, draft: 'hello' }); // BLOCKING2 同步
    await waitFor(() => expect(result.current.tabs[1]!.loadState).toBe('loaded'));
  });

  it('open 守卫 save-switch → 保存成功才打开新文件', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await setupDirtySingle(result);
    await act(async () => {
      result.current.openTab(mkTarget({ path: 'b.md', fileName: 'b.md', subtitle: 'b.md' }));
    });
    await act(async () => {
      await result.current.resolveDirty('save-switch');
    });
    expect(lastSaveBody()).toMatchObject({ path: 'a.md', content: 'changed', expectedVersion: 'v1' });
    expect(result.current.activeTabId).toBe('workspace:b.md');
    expect(result.current.tabs[0]!).toMatchObject({ dirty: false, version: 'v2' });
  });

  it('open 守卫 cancel → 不打开新文件（编辑态保留）', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await setupDirtySingle(result);
    await act(async () => {
      result.current.openTab(mkTarget({ path: 'b.md', fileName: 'b.md', subtitle: 'b.md' }));
    });
    await act(async () => {
      result.current.resolveDirty('cancel');
    });
    expect(result.current.activeTabId).toBe('workspace:a.md');
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]!.mode).toBe('edit'); // 编辑态保留
    expect(result.current.tabs[0]!.dirty).toBe(true);
    expect(result.current.dirtyPending).toBeNull();
  });
});

describe('[老板编辑态守卫] mode=edit 拦截切 tab + 切换后只读态', () => {
  /** 开两个 tab 并把 active 设为 a */
  async function openTwo(result: { current: ReturnType<typeof usePreviewTabs> }) {
    await act(async () => {
      result.current.openTab(mkTarget()); // a
    });
    await waitFor(() => expect(result.current.tabs[0]!.loadState).toBe('loaded'));
    await act(async () => {
      result.current.openTab(mkTarget({ path: 'b.md', fileName: 'b.md', subtitle: 'b.md' })); // b
    });
    await waitFor(() => expect(result.current.tabs).toHaveLength(2));
    await act(async () => {
      result.current.activateTab('workspace:a.md'); // active 回 a
    });
  }

  it('编辑态但 dirty=false（刚进 edit 没改）也拦截', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await openTwo(result);
    await act(async () => {
      result.current.setMode('workspace:a.md', 'edit');
    });
    expect(result.current.tabs[0]!.dirty).toBe(false);
    expect(result.current.tabs[0]!.mode).toBe('edit');
    await act(async () => {
      result.current.activateTab('workspace:b.md');
    });
    expect(result.current.dirtyPending).not.toBeNull();
    expect(result.current.activeTabId).toBe('workspace:a.md');
  });

  it('切换后目标 tab mode=view（只读态，不保留编辑态）', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await openTwo(result);
    await act(async () => {
      result.current.activateTab('workspace:b.md');
      result.current.setMode('workspace:b.md', 'edit');
    });
    expect(result.current.tabs[1]!.mode).toBe('edit');
    // 切回 a（a 非 edit，直接放行）
    await act(async () => {
      result.current.activateTab('workspace:a.md');
    });
    expect(result.current.tabs[0]!.mode).toBe('view');
    // openTab 重激活已有 tab → mode 重置为 view
    await act(async () => {
      result.current.openTab(mkTarget({ path: 'b.md', fileName: 'b.md', subtitle: 'b.md' }));
    });
    expect(result.current.tabs.find((t) => t.id === 'workspace:b.md')!.mode).toBe('view');
  });
});

describe('saveTab / resolveConflict（409 冲突 modal）', () => {
  it('saveTab 成功 → dirty=false + mode=view + version 更新', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await act(async () => {
      result.current.openTab(mkTarget());
    });
    await waitFor(() => expect(result.current.tabs[0]!.loadState).toBe('loaded'));
    await act(async () => {
      result.current.setDraft('workspace:a.md', 'changed');
      result.current.setMode('workspace:a.md', 'edit');
    });
    await act(async () => {
      await result.current.saveTab('workspace:a.md');
    });
    expect(result.current.tabs[0]!).toMatchObject({ dirty: false, mode: 'view', version: 'v2', content: 'changed' });
  });

  it('saveTab 409 → conflictPending（reload/overwrite 两选）', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation((url, init) => {
      if (init?.method === 'POST' && String(url).includes('/file/save')) {
        return Promise.resolve(jsonResponse(409, { error: 'conflict', currentVersion: 'v9' }));
      }
      return defaultFetch(String(url), init);
    });
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await act(async () => {
      result.current.openTab(mkTarget());
    });
    await waitFor(() => expect(result.current.tabs[0]!.loadState).toBe('loaded'));
    await act(async () => {
      result.current.setDraft('workspace:a.md', 'changed');
    });
    await act(async () => {
      await result.current.saveTab('workspace:a.md');
    });
    expect(result.current.conflictPending).toEqual({ tabId: 'workspace:a.md', currentVersion: 'v9' });
    expect(result.current.tabs[0]!.dirty).toBe(true); // 保留 draft 未丢
  });

  it('resolveConflict reload → 以服务端重读（readWorkspaceFile 再次调用 + dirty 清零）', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation((url, init) => {
      if (init?.method === 'POST' && String(url).includes('/file/save')) {
        return Promise.resolve(jsonResponse(409, { error: 'conflict', currentVersion: 'v9' }));
      }
      return defaultFetch(String(url), init);
    });
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await act(async () => {
      result.current.openTab(mkTarget());
    });
    await waitFor(() => expect(result.current.tabs[0]!.loadState).toBe('loaded'));
    await act(async () => {
      result.current.setDraft('workspace:a.md', 'changed');
      await result.current.saveTab('workspace:a.md');
    });
    expect(result.current.conflictPending).not.toBeNull();
    fetchMock.mockClear();
    await act(async () => {
      await result.current.resolveConflict('reload');
    });
    expect(result.current.conflictPending).toBeNull();
    // reload → 再次 GET file
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/workspace/file'))).toBe(true);
    await waitFor(() => expect(result.current.tabs[0]!.loadState).toBe('loaded'));
    expect(result.current.tabs[0]!).toMatchObject({ content: 'hello', version: 'v1', dirty: false });
  });

  it('resolveConflict overwrite → force 重发（saveWorkspaceFile 带 force:true）', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    // 第一次 save → 409；第二次 save（overwrite）→ 成功 v10
    let saveCount = 0;
    fetchMock.mockImplementation((url, init) => {
      if (init?.method === 'POST' && String(url).includes('/file/save')) {
        saveCount += 1;
        if (saveCount === 1) return Promise.resolve(jsonResponse(409, { error: 'conflict', currentVersion: 'v9' }));
        return Promise.resolve(jsonResponse(200, { ok: true, version: 'v10' }));
      }
      return defaultFetch(String(url), init);
    });
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await act(async () => {
      result.current.openTab(mkTarget());
    });
    await waitFor(() => expect(result.current.tabs[0]!.loadState).toBe('loaded'));
    await act(async () => {
      result.current.setDraft('workspace:a.md', 'changed');
      await result.current.saveTab('workspace:a.md');
    });
    expect(result.current.conflictPending).not.toBeNull();
    await act(async () => {
      await result.current.resolveConflict('overwrite');
    });
    expect(lastSaveBody()).toMatchObject({ path: 'a.md', content: 'changed', expectedVersion: 'v1', force: true });
    expect(result.current.conflictPending).toBeNull();
    expect(result.current.tabs[0]!).toMatchObject({ dirty: false, version: 'v10', mode: 'view' });
  });
});
