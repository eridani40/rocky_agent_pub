// @vitest-environment jsdom
/**
 * component-chat-link-viewer 单测 —— chat markdown 链接 viewer 挂载层（v0.0.253 / v0.0.280 去只读）
 * 参考: app/web/src/components/chat-page/component-chat-link-viewer.tsx
 *       specs/tech/version_logs/v0.0.280/change_plan.md 行 29（去 readOnly + image/.url 分支 + onSave 双源）
 *
 * 覆盖 acceptanceCriteria：
 *   - workspace 源 .md → readWorkspaceFile → ModalMdEditor 可编辑（onSave → saveWorkspaceFile + toast）
 *   - absolute 源 .md → rockyShell.readFileText → ModalMdEditor（onSave → writeFileText + toast）
 *   - image 6 格式 → ComponentWsImageViewer（source 透传：workspace/absolute）
 *   - .url 降级 txt → ModalMdEditor format='txt'
 *   - target=null → 不渲染
 *
 * mock 策略（MEMORY test-vitest-mock-absolute-path）：vi.hoisted + __dirname 派生绝对路径 mock chat-api；
 *   ModalMdEditor / WsImageViewer 用相对路径 mock（manage-tab 范式）——本测试只验挂载层分流逻辑。
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import type { ChatLinkTarget } from '../../../lib/link-target';

const {
  readWorkspaceFileMock,
  saveWorkspaceFileMock,
  chatApiPath,
  modalMdEditorPath,
  wsImageViewerPath,
} = vi.hoisted(() => ({
  readWorkspaceFileMock: vi.fn(),
  saveWorkspaceFileMock: vi.fn(),
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
  modalMdEditorPath: require('node:path').resolve(__dirname, '../../common/component-modal-md-editor.tsx'),
  wsImageViewerPath: require('node:path').resolve(__dirname, '../component-ws-image-viewer.tsx'),
}));

vi.mock(chatApiPath, () => ({
  readWorkspaceFile: (...args: unknown[]) => readWorkspaceFileMock(...args),
  saveWorkspaceFile: (...args: unknown[]) => saveWorkspaceFileMock(...args),
}));

// mock 子组件：ModalMdEditor（可编辑 + onSave 回调暴露）/ WsImageViewer（source 透传断言）
// 必须用 __dirname 派生绝对路径（MEMORY test-vitest-mock-absolute-path）：
// bun+jsdom 全量并发下相对路径 mock 静默失效 → 真实组件被渲染（缺 readWorkspaceFileBinary/readFileBinary mock 报错）
vi.mock(modalMdEditorPath, () => ({
  ComponentModalMdEditor: ({
    format,
    fileName,
    onSave,
    onClose,
  }: {
    format?: string;
    fileName?: string;
    onSave?: (v: string) => void;
    onClose?: () => void;
  }) => (
    <div data-testid="md-editor-mock" data-format={format ?? ''} data-file={fileName ?? ''}>
      <button type="button" onClick={() => onSave?.('new content')}>
        save
      </button>
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

vi.mock(wsImageViewerPath, () => ({
  ComponentWsImageViewer: ({
    target,
    onClose,
  }: {
    target: { source?: 'workspace' | 'absolute' } | null;
    onClose?: () => void;
  }) => (
    <div data-testid="img-viewer-mock" data-source={target?.source ?? ''}>
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

import { ComponentChatLinkViewer } from '../component-chat-link-viewer';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => {
  cleanup();
  readWorkspaceFileMock.mockReset();
  saveWorkspaceFileMock.mockReset();
  delete (window as unknown as { rockyShell?: unknown }).rockyShell;
});

/** 造 window.rockyShell mock（absolute 源读/写 IPC） */
function mockRockyShell() {
  const api = {
    readFileText: vi.fn(async () => ({ ok: true, content: '# abs' })),
    writeFileText: vi.fn(async () => ({ ok: true })),
    openExternal: vi.fn(async () => ({ ok: true })),
    openPath: vi.fn(async () => ({ ok: true })),
  };
  (window as unknown as { rockyShell: unknown }).rockyShell = api;
  return api;
}

function renderViewer(target: ChatLinkTarget | null) {
  const onClose = vi.fn();
  render(<ComponentChatLinkViewer target={target} sessionId="s1" onClose={onClose} />);
  return { onClose };
}

describe('ComponentChatLinkViewer — workspace 源（v0.0.280 去只读）', () => {
  it('workspace .md → readWorkspaceFile → ModalMdEditor 可编辑（format=md）', async () => {
    readWorkspaceFileMock.mockResolvedValue({ content: '# hi' });
    renderViewer({ path: 'notes.md', source: 'workspace', fileName: 'notes.md' });
    await waitFor(() => expect(screen.getByTestId('md-editor-mock')).toBeTruthy());
    expect(readWorkspaceFileMock).toHaveBeenCalledWith('s1', { path: 'notes.md' });
    expect(screen.getByTestId('md-editor-mock').getAttribute('data-format')).toBe('md');
    expect(screen.getByTestId('md-editor-mock').getAttribute('data-file')).toBe('notes.md');
  });

  it('workspace 保存 → saveWorkspaceFile + toast 已保存', async () => {
    readWorkspaceFileMock.mockResolvedValue({ content: '# hi' });
    saveWorkspaceFileMock.mockResolvedValue({ ok: true });
    renderViewer({ path: 'notes.md', source: 'workspace', fileName: 'notes.md' });
    await waitFor(() => expect(screen.getByTestId('md-editor-mock')).toBeTruthy());
    fireEvent.click(screen.getByText('save'));
    await waitFor(() => expect(saveWorkspaceFileMock).toHaveBeenCalledWith('s1', { path: 'notes.md', content: 'new content' }));
    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy());
  });
});

describe('ComponentChatLinkViewer — absolute 源（v0.0.280 IPC）', () => {
  it('absolute .md → rockyShell.readFileText → ModalMdEditor', async () => {
    const api = mockRockyShell();
    renderViewer({ path: '/abs/notes.md', source: 'absolute', fileName: 'notes.md' });
    await waitFor(() => expect(screen.getByTestId('md-editor-mock')).toBeTruthy());
    expect(api.readFileText).toHaveBeenCalledWith('/abs/notes.md');
    expect(readWorkspaceFileMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('md-editor-mock').getAttribute('data-format')).toBe('md');
  });

  it('absolute 保存 → rockyShell.writeFileText + toast 已保存', async () => {
    const api = mockRockyShell();
    renderViewer({ path: '/abs/notes.md', source: 'absolute', fileName: 'notes.md' });
    await waitFor(() => expect(screen.getByTestId('md-editor-mock')).toBeTruthy());
    fireEvent.click(screen.getByText('save'));
    await waitFor(() => expect(api.writeFileText).toHaveBeenCalledWith('/abs/notes.md', 'new content'));
    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy());
    expect(saveWorkspaceFileMock).not.toHaveBeenCalled();
  });

  it('absolute 非 Electron（无 rockyShell）→ 友好错误 pill，不渲染 editor', async () => {
    renderViewer({ path: '/abs/notes.md', source: 'absolute', fileName: 'notes.md' });
    await waitFor(() => expect(screen.getByText('打开失败')).toBeTruthy());
    expect(screen.queryByTestId('md-editor-mock')).toBeNull();
  });
});

describe('ComponentChatLinkViewer — image / .url 分支（v0.0.280）', () => {
  it('image .png workspace → WsImageViewer source=workspace', async () => {
    readWorkspaceFileMock.mockResolvedValue({ content: '' });
    renderViewer({ path: 'img/logo.png', source: 'workspace', fileName: 'logo.png' });
    await waitFor(() => expect(screen.getByTestId('img-viewer-mock')).toBeTruthy());
    expect(screen.getByTestId('img-viewer-mock').getAttribute('data-source')).toBe('workspace');
    expect(screen.queryByTestId('md-editor-mock')).toBeNull();
  });

  it('image .png absolute → WsImageViewer source=absolute（IPC 读二进制）', async () => {
    const api = mockRockyShell();
    renderViewer({ path: '/abs/logo.png', source: 'absolute', fileName: 'logo.png' });
    await waitFor(() => expect(screen.getByTestId('img-viewer-mock')).toBeTruthy());
    expect(screen.getByTestId('img-viewer-mock').getAttribute('data-source')).toBe('absolute');
    expect(api.readFileText).not.toHaveBeenCalled();
  });

  it('.url 降级 txt → ModalMdEditor format=txt（getFileFormat 返 null）', async () => {
    readWorkspaceFileMock.mockResolvedValue({ content: '[InternetShortcut]' });
    renderViewer({ path: 'link.url', source: 'workspace', fileName: 'link.url' });
    await waitFor(() => expect(screen.getByTestId('md-editor-mock')).toBeTruthy());
    expect(screen.getByTestId('md-editor-mock').getAttribute('data-format')).toBe('txt');
  });

  it('target=null → 不渲染', () => {
    const { container } = render(<ComponentChatLinkViewer target={null} sessionId="s1" onClose={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});
