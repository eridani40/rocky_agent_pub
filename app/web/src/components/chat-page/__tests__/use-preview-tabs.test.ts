// @vitest-environment jsdom
/**
 * use-preview-tabs 单测（v0.0.320 D4 tab 状态机）
 * 参考: specs/tech/version_logs/v0.0.320/change_plan.md D4（PreviewTab 契约 + acceptanceCriteria）
 *
 * 覆盖：
 *   - openTab 同 path 已存在 → activate（不重复新建）；新 path → 新建 + activate + 异步 load
 *   - activateTab 编辑态守卫：当前 mode='edit' 且目标不同 → dirtyPending 挂起
 *   - closeTab 编辑态守卫：mode='edit' → pending；非编辑态 → 关闭 + 焦点左移
 *   - [老板编辑态守卫] 切换后目标 tab mode='view'（只读态，不保留编辑态）
 *   - 关最后一个 → activeTabId null（空态）
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

describe('openTab', () => {
  it('新 path → 新建 tab + activate + 异步 load 写入 content/version', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await act(async () => {
      result.current.openTab(mkTarget());
    });
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]!).toMatchObject({
      id: 'workspace:a.md',
      path: 'a.md',
      source: 'workspace',
      format: 'md',
      mode: 'view',
      dirty: false,
    });
    expect(result.current.activeTabId).toBe('workspace:a.md');
    await waitFor(() => {
      expect(result.current.tabs[0]!.loadState).toBe('loaded');
    });
    expect(result.current.tabs[0]!).toMatchObject({ content: 'hello', draft: 'hello', version: 'v1' });
  });

  it('同 path 已存在 → activate（不重复新建、不重新 load）', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await act(async () => {
      result.current.openTab(mkTarget());
    });
    await waitFor(() => expect(result.current.tabs[0]!.loadState).toBe('loaded'));
    // 开第二个 tab（新 path 会 load）
    await act(async () => {
      result.current.openTab(mkTarget({ path: 'b.md', fileName: 'b.md', subtitle: 'b.md' }));
    });
    await waitFor(() => expect(result.current.tabs).toHaveLength(2));
    // 同 path 已存在 → 只 activate，不 fetch
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockClear();
    await act(async () => {
      result.current.openTab(mkTarget());
    });
    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.activeTabId).toBe('workspace:a.md');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('format null → 兜底 txt', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await act(async () => {
      result.current.openTab(mkTarget({ format: null }));
    });
    expect(result.current.tabs[0]!.format).toBe('txt');
  });
});

describe('activateTab / closeTab 编辑态守卫', () => {
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
      result.current.activateTab('workspace:a.md'); // active 回到 a
    });
  }

  it('activateTab 非编辑态 → 直接切', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await openTwo(result);
    await act(async () => {
      result.current.activateTab('workspace:b.md');
    });
    expect(result.current.activeTabId).toBe('workspace:b.md');
    expect(result.current.dirtyPending).toBeNull();
  });

  it('[老板编辑态守卫] activateTab 当前 mode=edit 且目标不同 → dirtyPending 挂起（不切）', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await openTwo(result);
    await act(async () => {
      result.current.setMode('workspace:a.md', 'edit');
    });
    expect(result.current.tabs[0]!.mode).toBe('edit');
    await act(async () => {
      result.current.activateTab('workspace:b.md');
    });
    expect(result.current.activeTabId).toBe('workspace:a.md'); // 未切换
    expect(result.current.dirtyPending).toEqual({ tabId: 'workspace:a.md', action: 'activate', targetTabId: 'workspace:b.md' });
  });

  it('closeTab 非编辑态 → 关闭 + 焦点左移（左邻居优先）', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await openTwo(result);
    await act(async () => {
      result.current.openTab(mkTarget({ path: 'c.md', fileName: 'c.md', subtitle: 'c.md' })); // c
    });
    await waitFor(() => expect(result.current.tabs).toHaveLength(3));
    await act(async () => {
      result.current.closeTab('workspace:c.md');
    });
    expect(result.current.tabs.map((t) => t.id)).toEqual(['workspace:a.md', 'workspace:b.md']);
    expect(result.current.activeTabId).toBe('workspace:b.md'); // 左邻居
  });

  it('[老板编辑态守卫] closeTab mode=edit → dirtyPending 挂起（不关闭）', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await act(async () => {
      result.current.openTab(mkTarget());
    });
    await act(async () => {
      result.current.setMode('workspace:a.md', 'edit');
    });
    await act(async () => {
      result.current.closeTab('workspace:a.md');
    });
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.dirtyPending).toEqual({ tabId: 'workspace:a.md', action: 'close', targetTabId: null });
  });

  it('关最后一个（无邻居）→ activeTabId null（空态）', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await act(async () => {
      result.current.openTab(mkTarget());
    });
    await act(async () => {
      result.current.closeTab('workspace:a.md');
    });
    expect(result.current.tabs).toHaveLength(0);
    expect(result.current.activeTabId).toBeNull();
  });
});

describe('resolveDirty', () => {
  /** 开两 tab + active=a + 编辑态(a) + 触发 activate(b) pending */
  async function setupPending(result: { current: ReturnType<typeof usePreviewTabs> }) {
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
      // [老板编辑态守卫] mode='edit' 就拦截（不只 dirty）
      result.current.setMode('workspace:a.md', 'edit');
      result.current.setDraft('workspace:a.md', 'changed'); // 同时有修改
    });
    await act(async () => {
      result.current.activateTab('workspace:b.md'); // 编辑态守卫 → pending
    });
    expect(result.current.dirtyPending).not.toBeNull();
  }

  it('cancel → 清 pending，不切不关', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await setupPending(result);
    await act(async () => {
      result.current.resolveDirty('cancel');
    });
    expect(result.current.dirtyPending).toBeNull();
    expect(result.current.activeTabId).toBe('workspace:a.md');
    expect(result.current.tabs[0]!.dirty).toBe(true);
  });

  it('discard → 放弃修改直接切目标（[ET-fix BLOCKING2] draft 重置为 content 防旧草稿残留）', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await setupPending(result);
    await act(async () => {
      result.current.resolveDirty('discard');
    });
    expect(result.current.activeTabId).toBe('workspace:b.md');
    expect(result.current.tabs[0]!).toMatchObject({ dirty: false, mode: 'view', draft: 'hello' });
    // 放弃后回编辑 → textbox 显示文件最新内容（content），非旧草稿 'changed'
    expect(result.current.tabs[0]!.draft).not.toBe('changed');
  });

  it('save-switch → 保存成功才切（saveWorkspaceFile 调用 + version 更新 + [ET-fix BLOCKING2] draft 同步）', async () => {
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await setupPending(result);
    await act(async () => {
      await result.current.resolveDirty('save-switch');
    });
    expect(lastSaveBody()).toMatchObject({ path: 'a.md', content: 'changed', expectedVersion: 'v1' });
    expect(result.current.activeTabId).toBe('workspace:b.md');
    expect(result.current.tabs[0]!).toMatchObject({ dirty: false, version: 'v2', draft: 'changed' });
  });

  it('save-switch 但 409 → conflictPending 挂起不切换', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation((url, init) => {
      if (init?.method === 'POST' && String(url).includes('/file/save'))
        return Promise.resolve(jsonResponse(409, { error: 'conflict', currentVersion: 'v9' }));
      return defaultFetch(String(url), init);
    });
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await setupPending(result);
    await act(async () => {
      await result.current.resolveDirty('save-switch');
    });
    expect(result.current.conflictPending).toEqual({ tabId: 'workspace:a.md', currentVersion: 'v9' });
    expect(result.current.activeTabId).toBe('workspace:a.md'); // 未切换
  });
});

describe('读失败 error pill + retry', () => {
  it('读失败 → loadState error + errorMsg；retryLoad 重新 load', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    let getCount = 0;
    fetchMock.mockImplementation((url, init) => {
      if (!init?.method && String(url).includes('/workspace/file')) {
        getCount += 1;
        if (getCount === 1) return Promise.resolve(jsonResponse(500, { error: 'read failed' }));
        return Promise.resolve(jsonResponse(200, { content: 'hello', version: 'v1' }));
      }
      return defaultFetch(String(url), init);
    });
    const { result } = renderHook(() => usePreviewTabs({ sessionId: 's1' }));
    await act(async () => { result.current.openTab(mkTarget()); });
    await waitFor(() => expect(result.current.tabs[0]!.loadState).toBe('error'));
    expect(result.current.tabs[0]!.errorMsg).toBe('read failed');
    await act(async () => { result.current.retryLoad('workspace:a.md'); });
    await waitFor(() => expect(result.current.tabs[0]!.loadState).toBe('loaded'));
    expect(result.current.tabs[0]!.content).toBe('hello');
  });
});
