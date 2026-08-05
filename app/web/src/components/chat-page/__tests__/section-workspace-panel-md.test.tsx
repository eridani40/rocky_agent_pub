// @vitest-environment jsdom
/**
 * section-workspace-panel 文件拦截单测（v0.0.227 起，v0.0.241 扩到 12 格式）
 * 参考: specs/prd/version_logs/v0.0.227.md §2.1（.md 拦截走内置 editor）
 *       + specs/prd/version_logs/v0.0.241.md §2.1（扩到 11 格式 + md = 12 FileFormat）+ §5 决策5（拦截范围）
 *       + specs/ui/components/chat-page/component-workspace-panel.md §4.4（isBuiltinEditable 拦截分支）
 *
 * 覆盖 acceptanceCriteria：
 *   - .md 文件点击 → setFileEditorTarget（readWorkspaceFile 被调）+ openWorkspaceItem 不调
 *   - .MD / .Md 均命中拦截（大小写不区分）
 *   - [v0.0.241] .json / .yaml / .csv 等结构化格式 → 命中 isBuiltinEditable 走内置 editor
 *   - .png / .markdown（不在 EXT_TO_FORMAT 表）→ 走 openWorkspaceItem（未支持回归保护）
 *   - 文件夹（dir）→ 走 openWorkspaceItem（回归保护）
 *
 * mock 策略（MEMORY test-vitest-mock-absolute-path）：vi.hoisted + __dirname 派生绝对路径 mock chat-api。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';

const {
  getWorkspaceTreeMock,
  openWorkspaceItemMock,
  readWorkspaceFileMock,
  saveWorkspaceFileMock,
  watchMock,
  unwatchMock,
  chatApiPath,
} = vi.hoisted(() => ({
  getWorkspaceTreeMock: vi.fn(),
  openWorkspaceItemMock: vi.fn(),
  readWorkspaceFileMock: vi.fn(),
  saveWorkspaceFileMock: vi.fn(),
  watchMock: vi.fn(),
  unwatchMock: vi.fn(),
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
}));

vi.mock(chatApiPath, () => ({
  getWorkspaceTree: (...args: unknown[]) => getWorkspaceTreeMock(...args),
  openWorkspaceItem: (...args: unknown[]) => openWorkspaceItemMock(...args),
  readWorkspaceFile: (...args: unknown[]) => readWorkspaceFileMock(...args),
  saveWorkspaceFile: (...args: unknown[]) => saveWorkspaceFileMock(...args),
  pickWorkspaceDirectory: vi.fn(async () => ({ path: null })),
  updateSession: vi.fn(async () => ({})),
  watchWorkspaceDir: (...args: unknown[]) => watchMock(...args),
  unwatchWorkspaceDir: (...args: unknown[]) => unwatchMock(...args),
}));

import { SectionWorkspacePanel } from '../section-workspace-panel';
import { useChatStore } from '../../../store/chat-slice';

/** 构造单文件 tree */
function treeWith(node: { name: string; path: string; type: 'file' | 'dir'; hasChildren?: boolean }) {
  return {
    workspaceDir: '/tmp/ws',
    tree: [{ hasChildren: false, ...node }],
  };
}

beforeAll(async () => {
  await initI18n('zh-CN');
});

beforeEach(() => {
  getWorkspaceTreeMock.mockReset();
  openWorkspaceItemMock.mockReset();
  readWorkspaceFileMock.mockReset();
  saveWorkspaceFileMock.mockReset();
  watchMock.mockReset();
  unwatchMock.mockReset();
  watchMock.mockResolvedValue({ ok: true });
  unwatchMock.mockResolvedValue({ ok: true });
  readWorkspaceFileMock.mockResolvedValue({ content: '# hi' });
  openWorkspaceItemMock.mockResolvedValue({ ok: true });
  useChatStore.getState().setLastWorkspaceEvent(null);
});

afterEach(() => cleanup());

/** 触发某文件节点的打开（点 ws-tree-item 的「打开文件」按钮） */
async function clickOpenFile() {
  await screen.findByRole('button', { name: '打开文件' });
  fireEvent.click(screen.getByRole('button', { name: '打开文件' }));
}

describe('SectionWorkspacePanel .md 拦截（v0.0.227）', () => {
  it('.md 文件 → readWorkspaceFile 被调 + openWorkspaceItem 不调（拦截走内置 editor）', async () => {
    getWorkspaceTreeMock.mockResolvedValue(treeWith({ name: 'notes.md', path: 'notes.md', type: 'file' }));
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await clickOpenFile();
    await vi.waitFor(() => expect(readWorkspaceFileMock).toHaveBeenCalledTimes(1));
    expect(readWorkspaceFileMock.mock.calls[0]![0]).toBe('sess-1');
    expect(readWorkspaceFileMock.mock.calls[0]![1]).toEqual({ path: 'notes.md' });
    expect(openWorkspaceItemMock).not.toHaveBeenCalled();
  });

  it('.MD 大写后缀 → 同样命中拦截（大小写不区分，PRD §6.4）', async () => {
    getWorkspaceTreeMock.mockResolvedValue(treeWith({ name: 'NOTES.MD', path: 'NOTES.MD', type: 'file' }));
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await clickOpenFile();
    await vi.waitFor(() => expect(readWorkspaceFileMock).toHaveBeenCalledWith('sess-1', { path: 'NOTES.MD' }));
    expect(openWorkspaceItemMock).not.toHaveBeenCalled();
  });

  it('.Md 混合大小写 → 同样命中拦截', async () => {
    getWorkspaceTreeMock.mockResolvedValue(treeWith({ name: 'Readme.Md', path: 'Readme.Md', type: 'file' }));
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await clickOpenFile();
    await vi.waitFor(() => expect(readWorkspaceFileMock).toHaveBeenCalledWith('sess-1', { path: 'Readme.Md' }));
    expect(openWorkspaceItemMock).not.toHaveBeenCalled();
  });

  it('嵌套路径 .md（docs/notes.md）→ readWorkspaceFile 收到完整相对路径', async () => {
    getWorkspaceTreeMock.mockResolvedValue(
      treeWith({ name: 'notes.md', path: 'docs/notes.md', type: 'file' }),
    );
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await clickOpenFile();
    await vi.waitFor(() => expect(readWorkspaceFileMock).toHaveBeenCalledWith('sess-1', { path: 'docs/notes.md' }));
    expect(openWorkspaceItemMock).not.toHaveBeenCalled();
  });
});

describe('SectionWorkspacePanel v0.0.241 多格式拦截扩展', () => {
  it('.json 文件 → readWorkspaceFile 被调（v0.0.241 扩拦截，原 v0.0.227 走系统打开的契约已废）', async () => {
    getWorkspaceTreeMock.mockResolvedValue(treeWith({ name: 'pkg.json', path: 'pkg.json', type: 'file' }));
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await clickOpenFile();
    await vi.waitFor(() => expect(readWorkspaceFileMock).toHaveBeenCalledWith('sess-1', { path: 'pkg.json' }));
    expect(openWorkspaceItemMock).not.toHaveBeenCalled();
  });

  it('.yaml 文件 → 命中拦截走内置 editor（结构化格式）', async () => {
    getWorkspaceTreeMock.mockResolvedValue(treeWith({ name: 'config.yaml', path: 'config.yaml', type: 'file' }));
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await clickOpenFile();
    await vi.waitFor(() => expect(readWorkspaceFileMock).toHaveBeenCalledWith('sess-1', { path: 'config.yaml' }));
    expect(openWorkspaceItemMock).not.toHaveBeenCalled();
  });

  it('.csv 文件 → 命中拦截走内置 editor（结构化格式）', async () => {
    getWorkspaceTreeMock.mockResolvedValue(treeWith({ name: 'data.csv', path: 'data.csv', type: 'file' }));
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await clickOpenFile();
    await vi.waitFor(() => expect(readWorkspaceFileMock).toHaveBeenCalledWith('sess-1', { path: 'data.csv' }));
    expect(openWorkspaceItemMock).not.toHaveBeenCalled();
  });

  it('.env 文件 → 命中拦截（特判 basename 整体匹配 .env）', async () => {
    getWorkspaceTreeMock.mockResolvedValue(treeWith({ name: '.env', path: '.env', type: 'file' }));
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await clickOpenFile();
    await vi.waitFor(() => expect(readWorkspaceFileMock).toHaveBeenCalledWith('sess-1', { path: '.env' }));
    expect(openWorkspaceItemMock).not.toHaveBeenCalled();
  });

  it('.env.local 文件 → 命中拦截（.env.* 前缀特判）', async () => {
    getWorkspaceTreeMock.mockResolvedValue(treeWith({ name: '.env.local', path: '.env.local', type: 'file' }));
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await clickOpenFile();
    await vi.waitFor(() => expect(readWorkspaceFileMock).toHaveBeenCalledWith('sess-1', { path: '.env.local' }));
    expect(openWorkspaceItemMock).not.toHaveBeenCalled();
  });
});

describe('SectionWorkspacePanel 未支持扩展名回归保护（UC-241-REG 系统打开）', () => {
  it('.png 文件 → openWorkspaceItem 被调（系统打开）+ readWorkspaceFile 不调', async () => {
    getWorkspaceTreeMock.mockResolvedValue(treeWith({ name: 'logo.png', path: 'logo.png', type: 'file' }));
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await clickOpenFile();
    await vi.waitFor(() => expect(openWorkspaceItemMock).toHaveBeenCalledTimes(1));
    expect(openWorkspaceItemMock.mock.calls[0]![0]).toBe('sess-1');
    expect(openWorkspaceItemMock.mock.calls[0]![1]).toEqual({ path: 'logo.png', kind: 'file' });
    expect(readWorkspaceFileMock).not.toHaveBeenCalled();
  });

  it('.markdown（非 .md 后缀，不在 EXT_TO_FORMAT）→ 走系统打开（仅 .md 命中，不误扩）', async () => {
    getWorkspaceTreeMock.mockResolvedValue(treeWith({ name: 'a.markdown', path: 'a.markdown', type: 'file' }));
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await clickOpenFile();
    await vi.waitFor(() => expect(openWorkspaceItemMock).toHaveBeenCalledWith('sess-1', { path: 'a.markdown', kind: 'file' }));
    expect(readWorkspaceFileMock).not.toHaveBeenCalled();
  });

  it('.py 文件（编程语言，用户铁律不做）→ 走系统打开', async () => {
    getWorkspaceTreeMock.mockResolvedValue(treeWith({ name: 'main.py', path: 'main.py', type: 'file' }));
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    await clickOpenFile();
    await vi.waitFor(() => expect(openWorkspaceItemMock).toHaveBeenCalledWith('sess-1', { path: 'main.py', kind: 'file' }));
    expect(readWorkspaceFileMock).not.toHaveBeenCalled();
  });

  it('文件夹 → openWorkspaceItem 被调（kind=folder，系统打开）', async () => {
    getWorkspaceTreeMock.mockResolvedValue(treeWith({ name: 'src', path: 'src', type: 'dir', hasChildren: true }));
    const { container } = render(<SectionWorkspacePanel sessionId="sess-1" />);
    await screen.findByText('src');
    // 文件夹行有两个「打开文件夹」按钮（twisty + ws-act），按 ws-act 类精确定位打开动作按钮
    const openAct = container.querySelector('.ws-act') as HTMLElement;
    expect(openAct).toBeTruthy();
    fireEvent.click(openAct);
    await vi.waitFor(() => expect(openWorkspaceItemMock).toHaveBeenCalledWith('sess-1', { path: 'src', kind: 'folder' }));
    expect(readWorkspaceFileMock).not.toHaveBeenCalled();
  });
});
