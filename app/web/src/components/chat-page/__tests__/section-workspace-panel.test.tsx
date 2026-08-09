// @vitest-environment jsdom
/**
 * section-workspace-panel 懒监听接线单测（v0.0.271 重构：watch-set 声明式）
 * 参考: specs/api/overall/04-agent-session.md §2.6.5（watch-set 请求契约）
 *       specs/ui/components/chat-page/component-workspace-panel.md §4.3.1（接线小节）
 *       specs/tech/version_logs/v0.0.271/change_plan.md（R1：前端算完整集合推送，后端 diff 兜底）
 *
 * 覆盖 acceptanceCriteria（v0.0.271 新语义）：
 *   - 挂载 → applyWatchSet(['']) 被调（根；初始 rootTree 未到只有根）
 *   - rootTree 到后 → applyWatchSet 含根一级子文件夹（['', 'src']）
 *   - 展开文件夹 → applyWatchSet 集合含节点自身 + 一级子文件夹（childrenCache 筛 dir）
 *   - 收起文件夹 → applyWatchSet 集合移出该节点（除非被根一级覆盖）
 *   - 卸载组件 → unwatchWorkspaceDir release-all 被调（不带 path，clientId 与挂载时一致）
 *   - refresh 后 applyWatchSet 重算（幂等，集合内容与展开态一致）
 *
 * mock 策略（MEMORY test-vitest-mock-absolute-path）：vi.hoisted + __dirname 派生绝对路径 mock chat-api，
 * 严禁相对/硬编码绝对路径（bun+jsdom 全量并发下相对路径 mock 会静默失效）。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';

const { getWorkspaceTreeMock, watchMock, unwatchMock, watchSetMock, chatApiPath } = vi.hoisted(() => ({
  getWorkspaceTreeMock: vi.fn(),
  watchMock: vi.fn(),
  unwatchMock: vi.fn(),
  watchSetMock: vi.fn(),
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
}));

vi.mock(chatApiPath, () => ({
  getWorkspaceTree: (...args: unknown[]) => getWorkspaceTreeMock(...args),
  openWorkspaceItem: vi.fn(async () => ({ ok: true })),
  pickWorkspaceDirectory: vi.fn(async () => ({ path: null })),
  updateSession: vi.fn(async () => ({})),
  watchWorkspaceDir: (...args: unknown[]) => watchMock(...args),
  unwatchWorkspaceDir: (...args: unknown[]) => unwatchMock(...args),
  watchWorkspaceSet: (...args: unknown[]) => watchSetMock(...args),
}));

import { SectionWorkspacePanel } from '../section-workspace-panel';
import { useChatStore } from '../../../store/chat-slice';

const ROOT_TREE = {
  workspaceDir: '/tmp/ws',
  tree: [
    { name: 'src', path: 'src', type: 'dir' as const, hasChildren: true },
    { name: 'readme.md', path: 'readme.md', type: 'file' as const, hasChildren: false },
  ],
};
const SRC_CHILDREN = {
  workspaceDir: '/tmp/ws',
  tree: [
    { name: 'utils', path: 'src/utils', type: 'dir' as const, hasChildren: true },
    { name: 'main.ts', path: 'src/main.ts', type: 'file' as const, hasChildren: false },
  ],
};

beforeAll(async () => {
  await initI18n('zh-CN');
});

beforeEach(() => {
  getWorkspaceTreeMock.mockReset();
  watchMock.mockReset();
  unwatchMock.mockReset();
  watchSetMock.mockReset();
  getWorkspaceTreeMock.mockImplementation(async (_sid: string, opts?: { parent?: string }) => {
    if (opts?.parent === 'src') return SRC_CHILDREN;
    return ROOT_TREE;
  });
  watchMock.mockResolvedValue({ ok: true });
  unwatchMock.mockResolvedValue({ ok: true });
  watchSetMock.mockResolvedValue({ ok: true });
  // store 单例跨 test 复用：清掉上个 test 遗留的 lastWorkspaceEvent，避免误触发
  useChatStore.getState().setLastWorkspaceEvent(null);
});

afterEach(() => {
  cleanup();
});

/** 取最近一次 applyWatchSet 的 paths 数组 */
function lastWatchSetPaths(): string[] | null {
  const calls = watchSetMock.mock.calls.filter((c) => c[1]?.paths);
  if (calls.length === 0) return null;
  const last = calls[calls.length - 1] as [string, { paths?: string[] }] | undefined;
  return last?.[1]?.paths ?? null;
}

/** src 树项的 twisty（role=button span；展开/收起 label 随态切换，故按结构定位） */
function getSrcTwisty(): HTMLElement {
  const item = screen.getByText('src').closest('.ws-item')!;
  return item.querySelector('[role="button"]') as HTMLElement;
}

describe('SectionWorkspacePanel 懒监听接线（v0.0.271 watch-set）', () => {
  it('挂载 → applyWatchSet 被调（初始只有根；rootTree 到后含根一级子文件夹）', async () => {
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await screen.findByLabelText('拖动调节工作区宽度');
    // 初始（tree 未到）→ ['']；rootTree 到后 → ['', 'src']（根一级 dir）
    await vi.waitFor(() => {
      const paths = lastWatchSetPaths();
      expect(paths).toBeTruthy();
      expect(paths).toContain('');
      expect(paths).toContain('src');
    });
    // clientId 稳定为字符串
    const call = watchSetMock.mock.calls.find((c) => c[1]?.paths)?.[0];
    expect(call).toBe('sess-1');
    expect(typeof watchSetMock.mock.calls[0]![1].clientId).toBe('string');
  });

  it('展开文件夹 → applyWatchSet 集合含节点自身 + 一级子文件夹（childrenCache 筛 dir）', async () => {
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await screen.findByText('src');
    await vi.waitFor(() => expect(lastWatchSetPaths()).toContain('src'));

    fireEvent.click(getSrcTwisty());
    // 展开 → toggle-expand + GET children → childrenCache 含 src/utils dir → 集合 ['', 'src', 'src/utils']
    await vi.waitFor(() => {
      const paths = lastWatchSetPaths();
      expect(paths).toContain('src');
      expect(paths).toContain('src/utils');
    });
    // clientId 跨展开稳定（与挂载时一致）
    const rootClientId = watchSetMock.mock.calls[0]![1].clientId;
    const expandCall = watchSetMock.mock.calls[watchSetMock.mock.calls.length - 1]!;
    expect(expandCall[1].clientId).toBe(rootClientId);
  });

  it('收起文件夹 → applyWatchSet 集合移出该节点自身 + 一级子文件夹（根一级 dir 仍保留）', async () => {
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await screen.findByText('src');
    await vi.waitFor(() => expect(lastWatchSetPaths()).toContain('src'));

    // 先展开（src 一级子文件夹 src/utils 进集合）
    fireEvent.click(getSrcTwisty());
    await vi.waitFor(() => expect(lastWatchSetPaths()).toContain('src/utils'));

    // 再收起（同一按钮 toggle）→ src 自身 + src/utils 移出；但 src 是根一级 dir → 仍在集合
    fireEvent.click(getSrcTwisty());
    await vi.waitFor(() => {
      const paths = lastWatchSetPaths();
      expect(paths).not.toContain('src/utils');
    });
    expect(lastWatchSetPaths()).toContain('src'); // 根一级 dir 仍 watch（R4 覆盖语义）
    expect(lastWatchSetPaths()).toContain('');
  });

  it('卸载组件 → unwatchWorkspaceDir release-all 被调（不带 path，clientId 与挂载时一致）', async () => {
    const { unmount } = render(<SectionWorkspacePanel sessionId="sess-1" />);
    await screen.findByLabelText('拖动调节工作区宽度');
    await vi.waitFor(() => expect(watchSetMock).toHaveBeenCalled());
    const rootClientId = watchSetMock.mock.calls[0]![1].clientId;

    unmount();
    await vi.waitFor(() => {
      const call = unwatchMock.mock.calls.find((c) => c[1]?.path === undefined);
      expect(call).toBeTruthy();
    });
    const releaseCall = unwatchMock.mock.calls.find((c) => c[1]?.path === undefined)!;
    expect(releaseCall[0]).toBe('sess-1');
    expect(releaseCall[1].clientId).toBe(rootClientId);
    // release-all body 不带 path 键（对齐 §2.6.5 UnwatchBody.path 省略语义）
    expect('path' in releaseCall[1]).toBe(false);
  });

  it('refresh 后 applyWatchSet 重算（幂等：集合内容与展开态一致，后端 diff 无增删）', async () => {
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await screen.findByLabelText('拖动调节工作区宽度');
    // 初始加载完成（refresh 按钮可用）
    await vi.waitFor(() => {
      expect((screen.getByRole('button', { name: '刷新工作区' }) as HTMLButtonElement).disabled).toBe(false);
    });
    const callsBeforeRefresh = getWorkspaceTreeMock.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: '刷新工作区' }));
    await vi.waitFor(() => {
      expect(getWorkspaceTreeMock.mock.calls.length).toBeGreaterThan(callsBeforeRefresh);
    });
    // refresh 后重算集合仍含根 + 根一级 dir（内容稳定，幂等）
    await vi.waitFor(() => {
      const paths = lastWatchSetPaths();
      expect(paths).toContain('');
      expect(paths).toContain('src');
    });
  });

  it('[v0.0.275] 结构刷新：t1 里建 t2（addDir）→ 50ms 防抖 → refetch parentOf(t1)=root tree（t1 twisty 出现）', async () => {
    // 复现场景：root 展开（无 t1）→ 建 t1（addDir root）→ t1 里建 t2（addDir t1/t2 → structural('t1') → refetch '' root tree）
    let rootTreeCalls = 0;
    getWorkspaceTreeMock.mockImplementation(async (_sid: string, opts?: { parent?: string }) => {
      rootTreeCalls += 1;
      if (opts?.parent === 'src') return SRC_CHILDREN;
      // 后续 root tree 返回含 t1（hasChildren=true，t2 已建）
      return {
        workspaceDir: '/tmp/ws',
        tree: [
          { name: 'src', path: 'src', type: 'dir' as const, hasChildren: true },
          { name: 't1', path: 't1', type: 'dir' as const, hasChildren: true },
          { name: 'readme.md', path: 'readme.md', type: 'file' as const, hasChildren: false },
        ],
      };
    });

    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await screen.findByText('src');
    await vi.waitFor(() => expect(lastWatchSetPaths()).toContain('src'));
    const rootCallsBefore = rootTreeCalls;

    // 模拟 SSE file_changed(addDir t1/t2) → reducer 标 structural('t1')
    useChatStore.getState().setLastWorkspaceEvent({
      type: 'session_workspace_file_changed',
      sessionId: 'sess-1',
      createdAt: new Date().toISOString(),
      data: { path: 't1/t2', kind: 'addDir', isDir: true },
    });

    // 50ms 防抖后 → refetch parentOf('t1')=''（root tree，无 parent 参数）
    await vi.waitFor(() => {
      expect(rootTreeCalls).toBeGreaterThan(rootCallsBefore);
    });
    // 刷新后 t1 出现（twisty 有 role=button）
    await screen.findByText('t1');
    const t1Item = screen.getByText('t1').closest('.ws-item')!;
    expect(t1Item.querySelector('[role="button"]')).toBeTruthy();

    // 触发后 structural 已清：不再重复 refetch（等 80ms 确认无新请求）
    const callsAfterFirst = rootTreeCalls;
    await new Promise((r) => setTimeout(r, 80));
    expect(rootTreeCalls).toBe(callsAfterFirst);
  });
});
