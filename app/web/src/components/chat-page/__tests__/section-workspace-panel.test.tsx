// @vitest-environment jsdom
/**
 * section-workspace-panel 懒监听接线单测（v0.0.139 T3）
 * 参考: specs/api/overall/04-agent-session.md §2.6.5（watch/unwatch 请求契约）
 *       specs/ui/components/chat-page/component-workspace-panel.md §4.3.1（展开=watch/收起=unwatch/卸载=release-all）
 *
 * 覆盖 acceptanceCriteria：
 *   - 挂载 → 根 watch(path:'') 被调（sid 正确 + clientId 为字符串）
 *   - clientId 跨展开/收起稳定（同一 clientId 出现在根 watch + 展开 watch + 收起 unwatch）
 *   - 展开文件夹 → watchWorkspaceDir(path) 被调
 *   - 收起文件夹 → unwatchWorkspaceDir(path) 被调
 *   - 卸载组件 → unwatchWorkspaceDir release-all 被调（不带 path，clientId 与挂载时一致）
 *   - GET tree（多次刷新）不触发额外 watch 调用（红线③：GET tree 绝不隐式 watch）
 *   - [review 补丁] session_workspace_dir_changed 事件 → 重新 watch(path:'') 新根
 *     （api §2.5：后端 recycleSession 切目录清光旧监听不自动重启，前端须重新 POST watch）
 *
 * mock 策略（MEMORY test-vitest-mock-absolute-path）：vi.hoisted + __dirname 派生绝对路径 mock chat-api，
 * 严禁相对/硬编码绝对路径（bun+jsdom 全量并发下相对路径 mock 会静默失效）。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';

const { getWorkspaceTreeMock, watchMock, unwatchMock, chatApiPath } = vi.hoisted(() => ({
  getWorkspaceTreeMock: vi.fn(),
  watchMock: vi.fn(),
  unwatchMock: vi.fn(),
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
}));

vi.mock(chatApiPath, () => ({
  getWorkspaceTree: (...args: unknown[]) => getWorkspaceTreeMock(...args),
  openWorkspaceItem: vi.fn(async () => ({ ok: true })),
  pickWorkspaceDirectory: vi.fn(async () => ({ path: null })),
  updateSession: vi.fn(async () => ({})),
  watchWorkspaceDir: (...args: unknown[]) => watchMock(...args),
  unwatchWorkspaceDir: (...args: unknown[]) => unwatchMock(...args),
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
  tree: [{ name: 'main.ts', path: 'src/main.ts', type: 'file' as const, hasChildren: false }],
};

beforeAll(async () => {
  await initI18n('zh-CN');
});

beforeEach(() => {
  getWorkspaceTreeMock.mockReset();
  watchMock.mockReset();
  unwatchMock.mockReset();
  getWorkspaceTreeMock.mockImplementation(async (_sid: string, opts?: { parent?: string }) => {
    if (opts?.parent === 'src') return SRC_CHILDREN;
    return ROOT_TREE;
  });
  watchMock.mockResolvedValue({ ok: true });
  unwatchMock.mockResolvedValue({ ok: true });
  // store 单例跨 test 复用：清掉上个 test 遗留的 lastWorkspaceEvent，避免误触发
  useChatStore.getState().setLastWorkspaceEvent(null);
});

afterEach(() => {
  cleanup();
});

/** src 树项的 twisty（role=button span；展开/收起 label 随态切换，故按结构定位） */
function getSrcTwisty(): HTMLElement {
  const item = screen.getByText('src').closest('.ws-item')!;
  return item.querySelector('[role="button"]') as HTMLElement;
}

describe('SectionWorkspacePanel 懒监听接线（v0.0.139）', () => {
  it('挂载 → 根 watch(clientId, path:"") 被调一次（sid 正确）', async () => {
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await screen.findByLabelText('拖动调节工作区宽度');
    await vi.waitFor(() => expect(watchMock).toHaveBeenCalledTimes(1));
    const [sid, body] = watchMock.mock.calls[0]!;
    expect(sid).toBe('sess-1');
    expect(body.path).toBe('');
    expect(typeof body.clientId).toBe('string');
    expect(body.clientId.length).toBeGreaterThan(0);
  });

  it('展开文件夹 → watchWorkspaceDir(path) 被调，clientId 与根 watch 一致', async () => {
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await screen.findByText('src');
    await vi.waitFor(() => expect(watchMock).toHaveBeenCalledTimes(1));
    const rootClientId = watchMock.mock.calls[0]![1].clientId;

    fireEvent.click(getSrcTwisty());
    await vi.waitFor(() => {
      const call = watchMock.mock.calls.find((c) => c[1]?.path === 'src');
      expect(call).toBeTruthy();
    });
    const expandCall = watchMock.mock.calls.find((c) => c[1]?.path === 'src')!;
    expect(expandCall[0]).toBe('sess-1');
    expect(expandCall[1].clientId).toBe(rootClientId);
  });

  it('收起文件夹 → unwatchWorkspaceDir(path) 被调，clientId 与根 watch 一致', async () => {
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await screen.findByText('src');
    await vi.waitFor(() => expect(watchMock).toHaveBeenCalledTimes(1));
    const rootClientId = watchMock.mock.calls[0]![1].clientId;

    // 先展开
    fireEvent.click(getSrcTwisty());
    await vi.waitFor(() => {
      expect(watchMock.mock.calls.some((c) => c[1]?.path === 'src')).toBe(true);
    });
    // 再收起（同一按钮 toggle）
    fireEvent.click(getSrcTwisty());
    await vi.waitFor(() => {
      const call = unwatchMock.mock.calls.find((c) => c[1]?.path === 'src');
      expect(call).toBeTruthy();
    });
    const collapseCall = unwatchMock.mock.calls.find((c) => c[1]?.path === 'src')!;
    expect(collapseCall[0]).toBe('sess-1');
    expect(collapseCall[1].clientId).toBe(rootClientId);
  });

  it('卸载组件 → unwatchWorkspaceDir release-all 被调（不带 path，clientId 与挂载时一致）', async () => {
    const { unmount } = render(<SectionWorkspacePanel sessionId="sess-1" />);
    await screen.findByLabelText('拖动调节工作区宽度');
    await vi.waitFor(() => expect(watchMock).toHaveBeenCalledTimes(1));
    const rootClientId = watchMock.mock.calls[0]![1].clientId;

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

  it('GET tree（多次刷新）不触发额外 watch 调用（红线③：GET tree 绝不隐式 watch）', async () => {
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await screen.findByLabelText('拖动调节工作区宽度');
    await vi.waitFor(() => expect(watchMock).toHaveBeenCalledTimes(1));
    // [v0.0.139 T4 修复] ws-refresh-btn 的 disabled=state.loading（component-ws-tab-bar.tsx）；
    // 挂载后的初始 GET tree 是异步的，全量 suite 高并发调度延迟下点击时 loading 可能仍 true
    // → 按钮 disabled → fireEvent.click 在 jsdom 对 disabled 元素是 no-op → 断言必然 fail
    // （非随机噪音，是真实竞态）。须等按钮变为可点击（初始加载完成）才点。
    await vi.waitFor(() => {
      expect((screen.getByRole('button', { name: '刷新工作区' }) as HTMLButtonElement).disabled).toBe(false);
    });
    const callsBeforeRefresh = getWorkspaceTreeMock.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: '刷新工作区' }));
    await vi.waitFor(() => {
      expect(getWorkspaceTreeMock.mock.calls.length).toBeGreaterThan(callsBeforeRefresh);
    });
    // 刷新多次触发了额外 GET tree，但 watch 调用数仍只有挂载时的根 watch 一次
    expect(watchMock).toHaveBeenCalledTimes(1);
  });

  it('session_workspace_dir_changed 事件 → 重新 watch(path:"") 新根（review 补丁：切目录后端清光旧监听不自动重启）', async () => {
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await screen.findByLabelText('拖动调节工作区宽度');
    await vi.waitFor(() => expect(watchMock).toHaveBeenCalledTimes(1));
    const rootClientId = watchMock.mock.calls[0]![1].clientId;
    watchMock.mockClear();

    // 模拟 chat-slice fan-out 收到 dir_changed（覆盖「别的 tab 切了目录」场景：本 tab 未调用 handleSwitchDir）
    useChatStore.getState().setLastWorkspaceEvent({
      type: 'session_workspace_dir_changed',
      sessionId: 'sess-1',
      createdAt: '2026-07-14T10:00:00.000Z',
      data: { workspaceDir: '/tmp/ws-new', prevDir: '/tmp/ws' },
    });

    await vi.waitFor(() => {
      const call = watchMock.mock.calls.find((c) => c[1]?.path === '');
      expect(call).toBeTruthy();
    });
    const rewatchCall = watchMock.mock.calls.find((c) => c[1]?.path === '')!;
    expect(rewatchCall[0]).toBe('sess-1');
    // clientId 未因切目录变化（同一 tab 身份）
    expect(rewatchCall[1].clientId).toBe(rootClientId);
  });
});
