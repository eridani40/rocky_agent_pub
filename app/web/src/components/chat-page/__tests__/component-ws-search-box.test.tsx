// @vitest-environment jsdom
/**
 * component-ws-search-box 搜索框单测（v0.0.324 D3 瘦身后）
 * 参考: specs/tech/version_logs/v0.0.324/change_plan.md D3
 *
 * 瘦身后搜索框只保留输入 + 防抖 + loading，结果通过 onResult 上报父级。
 * 覆盖：
 *   - 空输入 → onResult(null) + onSearchingChange(false)
 *   - 输入 → 防抖 300ms 后：前端过滤 + 后端补全合并去重 → onResult({hits, truncated})
 *   - 后端失败 → 降级仅前端结果
 *   - 清空（×）→ onResult(null)
 *
 * mock 策略（MEMORY test-vitest-mock-absolute-path）：vi.hoisted + __dirname 派生绝对路径 mock chat-api。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import type { WsTreeNode } from '../workspace-types';

const { searchWorkspaceFilesMock, chatApiPath } = vi.hoisted(() => ({
  searchWorkspaceFilesMock: vi.fn(),
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
}));

vi.mock(chatApiPath, () => ({
  searchWorkspaceFiles: (...args: unknown[]) => searchWorkspaceFilesMock(...args),
}));

import { ComponentWsSearchBox } from '../component-ws-search-box';

/** 顶层树：src 目录 + notes.md */
const TREE: WsTreeNode[] = [
  { name: 'src', path: 'src', type: 'dir', hasChildren: true },
  { name: 'notes.md', path: 'notes.md', type: 'file', hasChildren: false },
];
/** childrenCache：src 展开 → main.ts + utils 目录 */
const CHILDREN: Record<string, WsTreeNode[]> = {
  src: [
    { name: 'main.ts', path: 'src/main.ts', type: 'file', hasChildren: false },
    { name: 'utils', path: 'src/utils', type: 'dir', hasChildren: true },
  ],
};

beforeAll(async () => {
  await initI18n('zh-CN');
});

beforeEach(() => {
  searchWorkspaceFilesMock.mockReset();
  searchWorkspaceFilesMock.mockResolvedValue({ files: [], dirs: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 标准渲染 + onResult/onSearchingChange spy */
function renderBox() {
  const onResult = vi.fn();
  const onSearchingChange = vi.fn();
  render(
    <ComponentWsSearchBox
      sessionId="s1"
      tree={TREE}
      childrenCache={CHILDREN}
      onResult={onResult}
      onSearchingChange={onSearchingChange}
    />,
  );
  return { onResult, onSearchingChange };
}

describe('D3 — 空输入不请求后端', () => {
  it('挂载即渲染输入框，searchWorkspaceFiles 不调', () => {
    renderBox();
    expect(screen.getByTestId('ws-search-input')).toBeTruthy();
    expect(searchWorkspaceFilesMock).not.toHaveBeenCalled();
  });

  it('空输入 → onResult(null) + onSearchingChange(false)', () => {
    const { onResult, onSearchingChange } = renderBox();
    expect(onResult).toHaveBeenCalledWith(null);
    expect(onSearchingChange).toHaveBeenCalledWith(false);
  });
});

describe('D3 — 前端过滤 + 后端补全合并去重 → onResult 上报', () => {
  it('输入 300ms 防抖后：前端命中 + 后端补全合并去重 → onResult', async () => {
    const { onResult } = renderBox();
    // 后端补全：src/main.ts（前端已命中 → 去重）+ remote.py（前端未加载 → 补全）+ src/utils（dir）
    searchWorkspaceFilesMock.mockResolvedValue({ files: ['src/main.ts', 'remote.py'], dirs: ['src/utils'] });
    const input = screen.getByTestId('ws-search-input');
    fireEvent.change(input, { target: { value: 'main' } });
    // 防抖 300ms 后请求后端
    await waitFor(() => expect(searchWorkspaceFilesMock).toHaveBeenCalledWith('s1', { q: 'main' }));
    // onResult 被调用（非空 result）
    await waitFor(() => {
      const calls = onResult.mock.calls.filter((c) => c[0] !== null);
      expect(calls.length).toBeGreaterThan(0);
    });
    const result = onResult.mock.calls.find((c) => c[0] !== null)![0]!;
    // 合并去重：src/main.ts（后端）+ remote.py（后端）+ src/utils（后端 dir）= 3 条
    expect(result.hits).toHaveLength(3);
    expect(result.hits.map((h: { path: string }) => h.path)).toEqual(
      expect.arrayContaining(['src/main.ts', 'remote.py', 'src/utils']),
    );
    // truncated = false
    expect(result.truncated).toBe(false);
  });

  it('后端 truncated=true → onResult.truncated=true', async () => {
    const { onResult } = renderBox();
    searchWorkspaceFilesMock.mockResolvedValue({
      files: Array.from({ length: 101 }, (_, i) => `f${i}.py`),
      dirs: [],
      truncated: true,
    });
    const input = screen.getByTestId('ws-search-input');
    fireEvent.change(input, { target: { value: 'f' } });
    await waitFor(() => {
      const calls = onResult.mock.calls.filter((c) => c[0] !== null);
      expect(calls.length).toBeGreaterThan(0);
    });
    const result = onResult.mock.calls.find((c) => c[0] !== null)![0]!;
    expect(result.truncated).toBe(true);
    // 截断为 100
    expect(result.hits.length).toBeLessThanOrEqual(100);
  });

  it('后端失败 → 降级仅前端结果（不崩溃）', async () => {
    const { onResult } = renderBox();
    searchWorkspaceFilesMock.mockRejectedValue(new Error('network'));
    const input = screen.getByTestId('ws-search-input');
    fireEvent.change(input, { target: { value: 'notes' } });
    await waitFor(() => {
      const calls = onResult.mock.calls.filter((c) => c[0] !== null);
      expect(calls.length).toBeGreaterThan(0);
    });
    const result = onResult.mock.calls.find((c) => c[0] !== null)![0]!;
    // 前端命中 notes.md
    expect(result.hits.some((h: { path: string }) => h.path === 'notes.md')).toBe(true);
  });

  it('清空（×）→ onResult(null)', async () => {
    const { onResult } = renderBox();
    const input = screen.getByTestId('ws-search-input');
    fireEvent.change(input, { target: { value: 'notes' } });
    await waitFor(() => expect(searchWorkspaceFilesMock).toHaveBeenCalledTimes(1));
    // 清空按钮出现 → 点击
    fireEvent.click(screen.getByTestId('ws-search-clear'));
    // 最后一次 onResult 为 null
    const lastCall = onResult.mock.calls[onResult.mock.calls.length - 1]!;
    expect(lastCall[0]).toBeNull();
  });
});

describe('v0.0.328 — 500ms 防抖 + 回车立即搜', () => {
  it('连续快速输入：防抖期间不发请求，停下 500ms 后才发一次', async () => {
    vi.useFakeTimers();
    try {
      renderBox();
      const input = screen.getByTestId('ws-search-input');
      // 连续快速输入 m/ma/mai/main（每 100ms 一次，< 500ms 防抖窗口）
      fireEvent.change(input, { target: { value: 'm' } });
      await vi.advanceTimersByTimeAsync(100);
      fireEvent.change(input, { target: { value: 'ma' } });
      await vi.advanceTimersByTimeAsync(100);
      fireEvent.change(input, { target: { value: 'mai' } });
      await vi.advanceTimersByTimeAsync(100);
      fireEvent.change(input, { target: { value: 'main' } });
      // 防抖窗口内：不发请求
      expect(searchWorkspaceFilesMock).not.toHaveBeenCalled();
      // 推进 500ms（防抖到期）→ 发一次请求，用最终 query 'main'
      await vi.advanceTimersByTimeAsync(500);
      expect(searchWorkspaceFilesMock).toHaveBeenCalledTimes(1);
      expect(searchWorkspaceFilesMock).toHaveBeenCalledWith('s1', { q: 'main' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('回车立即搜：输入后按 Enter 跳过 500ms 防抖立即发请求', async () => {
    vi.useFakeTimers();
    try {
      renderBox();
      const input = screen.getByTestId('ws-search-input');
      fireEvent.change(input, { target: { value: 'main' } });
      // 不等 500ms，立即按 Enter
      fireEvent.keyDown(input, { key: 'Enter' });
      // 立即发请求（未推进定时器）
      expect(searchWorkspaceFilesMock).toHaveBeenCalledTimes(1);
      expect(searchWorkspaceFilesMock).toHaveBeenCalledWith('s1', { q: 'main' });
      // 推进 500ms：防抖定时器已被 Enter 清掉，不再重复发
      await vi.advanceTimersByTimeAsync(500);
      expect(searchWorkspaceFilesMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
