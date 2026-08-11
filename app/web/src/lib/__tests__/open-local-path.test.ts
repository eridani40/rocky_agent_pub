// @vitest-environment jsdom
/**
 * open-local-path 单测 — 共享本地文件分发 lib（v0.0.280）
 * 参考: app/web/src/lib/open-local-path.ts
 *       specs/tech/version_logs/v0.0.280/change_plan.md 行 40（UT 行）
 *
 * 覆盖 5 分支 × 2 source（workspace/absolute）× kind（file/folder/undefined）：
 *   folder→openWorkspaceItem/openPath；.url 命中→openRemoteLink/readFileText+openLinkTarget；
 *   .url 未命中→onEditor txt；image→onImageViewer；12 格式→onEditor(format)；其余→系统打开。
 *
 * mock 策略（MEMORY test-vitest-mock-absolute-path）：vi.hoisted + __dirname 派生绝对路径 mock
 * workspace-api / remote-link / link-target（bun+jsdom 全量并发下相对路径 mock 会静默失效）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  openWorkspaceItemMock,
  openRemoteLinkMock,
  openWebUrlMock,
  chatApiPath,
  remoteLinkPath,
} = vi.hoisted(() => ({
  openWorkspaceItemMock: vi.fn(async () => ({ ok: true })),
  openRemoteLinkMock: vi.fn(),
  openWebUrlMock: vi.fn(),
  chatApiPath: require('node:path').resolve(__dirname, '../chat-api.ts'),
  remoteLinkPath: require('node:path').resolve(__dirname, '../remote-link.ts'),
}));

// workspace-api（仅 openWorkspaceItem 被 open-local-path 消费；直接引用 mock——
// 包装 spread unknown[] 会触发 TS2556：带实现后 mock 为无参签名）
vi.mock(chatApiPath, () => ({
  openWorkspaceItem: openWorkspaceItemMock,
}));

// remote-link（openRemoteLink + openWebUrl mock；parseUrlFileContent 用真实现副本——纯函数，absolute .url 嗅探链路复用）
vi.mock(remoteLinkPath, () => ({
  parseUrlFileContent: (content: string) => {
    const m = /(https?:\/\/[^\s]+)/i.exec(content);
    return m ? m[1]! : null;
  },
  openRemoteLink: (...args: unknown[]) => openRemoteLinkMock(...args),
  // openWebUrlMock 直接引用（包装 spread unknown[] 会触发 TS2556；mock 调用签名兼容）
  openWebUrl: openWebUrlMock,
}));

import { openLocalPath, type OpenLocalTarget } from '../open-local-path';

/** 造 window.rockyShell mock（openPath / readFileText / readFileBinary） */
function mockRockyShell() {
  const api = {
    openExternal: vi.fn(async () => ({ ok: true })),
    openPath: vi.fn(async () => ({ ok: true })),
    readFileText: vi.fn(async () => ({ ok: true, content: '' })),
    readFileBinary: vi.fn(async () => ({ ok: true, content: '' })),
  };
  (window as unknown as { rockyShell: unknown }).rockyShell = api;
  return api;
}

/** 冲刷微任务（.url 嗅探异步链路 fire-and-forget） */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  // 注意：用 mockClear 而非 mockReset —— openWorkspaceItemMock 需保留 async 默认实现，
  // mockReset 会清掉实现导致 openSystemWorkspace 里 `openWorkspaceItem(...).catch` 崩（undefined.catch）
  openWorkspaceItemMock.mockClear();
  openRemoteLinkMock.mockClear();
  openWebUrlMock.mockClear();
  mockRockyShell();
});

afterEach(() => {
  delete (window as unknown as { rockyShell?: unknown }).rockyShell;
});

describe('openLocalPath — workspace 源', () => {
  it('① folder → openWorkspaceItem kind=folder（不调回调）', () => {
    const onEditor = vi.fn();
    const onImageViewer = vi.fn();
    openLocalPath('src', { sessionId: 's1', source: 'workspace', kind: 'folder', onEditor, onImageViewer });
    expect(openWorkspaceItemMock).toHaveBeenCalledWith('s1', { path: 'src', kind: 'folder' });
    expect(onEditor).not.toHaveBeenCalled();
    expect(onImageViewer).not.toHaveBeenCalled();
  });

  it('② .url 命中 → openRemoteLink（不降级 editor）', async () => {
    openRemoteLinkMock.mockResolvedValue({ opened: true });
    const onEditor = vi.fn();
    openLocalPath('link.url', { sessionId: 's1', source: 'workspace', onEditor, onImageViewer: vi.fn() });
    await flush();
    expect(openRemoteLinkMock).toHaveBeenCalledWith('s1', 'link.url');
    expect(onEditor).not.toHaveBeenCalled();
  });

  it('② .url 未命中 → 降级 onEditor format=txt（source=workspace）', async () => {
    openRemoteLinkMock.mockResolvedValue({ opened: false });
    const onEditor = vi.fn();
    openLocalPath('link.url', { sessionId: 's1', source: 'workspace', onEditor, onImageViewer: vi.fn() });
    await flush();
    expect(onEditor).toHaveBeenCalledTimes(1);
    const t = onEditor.mock.calls[0]![0] as OpenLocalTarget;
    expect(t.path).toBe('link.url');
    expect(t.format).toBe('txt');
    expect(t.source).toBe('workspace');
    expect(t.fileName).toBe('link.url');
  });

  it('② .url 读失败 → 降级 onEditor txt（不 unhandled rejection）', async () => {
    openRemoteLinkMock.mockRejectedValue(new Error('404'));
    const onEditor = vi.fn();
    openLocalPath('link.url', { sessionId: 's1', source: 'workspace', onEditor, onImageViewer: vi.fn() });
    await flush();
    expect(onEditor).toHaveBeenCalledTimes(1);
    expect((onEditor.mock.calls[0]![0] as OpenLocalTarget).format).toBe('txt');
  });

  it('③ image → onImageViewer format=null（不进 editor）', () => {
    const onImageViewer = vi.fn();
    const onEditor = vi.fn();
    openLocalPath('img/logo.png', { sessionId: 's1', source: 'workspace', onEditor, onImageViewer });
    expect(onImageViewer).toHaveBeenCalledTimes(1);
    const t = onImageViewer.mock.calls[0]![0] as OpenLocalTarget;
    expect(t.path).toBe('img/logo.png');
    expect(t.format).toBeNull();
    expect(t.source).toBe('workspace');
    expect(onEditor).not.toHaveBeenCalled();
  });

  it('④ 12 格式 → onEditor format 命中', () => {
    const onEditor = vi.fn();
    openLocalPath('config.json', { sessionId: 's1', source: 'workspace', onEditor, onImageViewer: vi.fn() });
    expect(onEditor).toHaveBeenCalledTimes(1);
    const t = onEditor.mock.calls[0]![0] as OpenLocalTarget;
    expect(t.format).toBe('json');
    expect(t.fileName).toBe('config.json');
    expect(openWorkspaceItemMock).not.toHaveBeenCalled();
  });

  it('⑤ 其余（不认识扩展名）→ openWorkspaceItem kind=file', () => {
    const onEditor = vi.fn();
    // [v0.0.328] readme.bak 词干 readme ∈ KNOWN_TEXT_STEMS → 已识别 txt；换真正不认识的 app.unknownext
    //   （扩展名不在表 + 词干 app 不在白名单）→ 仍走 openWorkspaceItem kind=file
    openLocalPath('app.unknownext', { sessionId: 's1', source: 'workspace', onEditor, onImageViewer: vi.fn() });
    expect(openWorkspaceItemMock).toHaveBeenCalledWith('s1', { path: 'app.unknownext', kind: 'file' });
    expect(onEditor).not.toHaveBeenCalled();
  });
});

describe('openLocalPath — absolute 源', () => {
  it('① folder → rockyShell.openPath', () => {
    const api = mockRockyShell();
    openLocalPath('/Users/x/src', { source: 'absolute', kind: 'folder', onEditor: vi.fn(), onImageViewer: vi.fn() });
    expect(api.openPath).toHaveBeenCalledWith('/Users/x/src');
  });

  it('② .url 命中 → readFileText + parseUrlFileContent + openWebUrl（remote-link 共享 web 打开）', async () => {
    const api = mockRockyShell();
    api.readFileText.mockResolvedValue({ ok: true, content: '[InternetShortcut]\nURL=https://example.com/path' });
    const onEditor = vi.fn();
    openLocalPath('/abs/link.url', { source: 'absolute', onEditor, onImageViewer: vi.fn() });
    await flush();
    expect(api.readFileText).toHaveBeenCalledWith('/abs/link.url');
    expect(openWebUrlMock).toHaveBeenCalledWith('https://example.com/path');
    expect(onEditor).not.toHaveBeenCalled();
  });

  it('② .url 未命中（无 URL）→ 降级 onEditor txt', async () => {
    const api = mockRockyShell();
    api.readFileText.mockResolvedValue({ ok: true, content: 'no url here' });
    const onEditor = vi.fn();
    openLocalPath('/abs/link.url', { source: 'absolute', onEditor, onImageViewer: vi.fn() });
    await flush();
    expect(api.openExternal).not.toHaveBeenCalled();
    expect(onEditor).toHaveBeenCalledTimes(1);
    const t = onEditor.mock.calls[0]![0] as OpenLocalTarget;
    expect(t.format).toBe('txt');
    expect(t.source).toBe('absolute');
  });

  it('② .url 非 Electron（无 rockyShell）→ 降级 onEditor txt（不调 readFileText/openExternal）', async () => {
    delete (window as unknown as { rockyShell?: unknown }).rockyShell;
    const onEditor = vi.fn();
    openLocalPath('/abs/link.url', { source: 'absolute', onEditor, onImageViewer: vi.fn() });
    await flush();
    expect(onEditor).toHaveBeenCalledTimes(1);
    expect((onEditor.mock.calls[0]![0] as OpenLocalTarget).format).toBe('txt');
  });

  it('③ image → onImageViewer format=null source=absolute', () => {
    const onImageViewer = vi.fn();
    openLocalPath('/abs/logo.png', { source: 'absolute', onEditor: vi.fn(), onImageViewer });
    const t = onImageViewer.mock.calls[0]![0] as OpenLocalTarget;
    expect(t.format).toBeNull();
    expect(t.source).toBe('absolute');
  });

  it('④ 12 格式 → onEditor format 命中 source=absolute', () => {
    const onEditor = vi.fn();
    openLocalPath('/abs/notes.md', { source: 'absolute', onEditor, onImageViewer: vi.fn() });
    const t = onEditor.mock.calls[0]![0] as OpenLocalTarget;
    expect(t.format).toBe('md');
    expect(t.source).toBe('absolute');
    expect(t.fileName).toBe('notes.md');
  });

  it('⑤ 其余（不认识扩展名）→ rockyShell.openPath', () => {
    const api = mockRockyShell();
    openLocalPath('/abs/app.exe', { source: 'absolute', onEditor: vi.fn(), onImageViewer: vi.fn() });
    expect(api.openPath).toHaveBeenCalledWith('/abs/app.exe');
  });
});

describe('openLocalPath — kind=undefined（聊天链）', () => {
  it('目录路径（无扩展名）→ 跳过 folder 分支 → 系统打开（openPath 行为等价）', () => {
    const api = mockRockyShell();
    openLocalPath('/Users/x/dir', { source: 'absolute', onEditor: vi.fn(), onImageViewer: vi.fn() });
    expect(api.openPath).toHaveBeenCalledWith('/Users/x/dir');
  });

  it('workspace 目录路径（无扩展名）→ openWorkspaceItem kind=file', () => {
    openLocalPath('some_dir', { sessionId: 's1', source: 'workspace', onEditor: vi.fn(), onImageViewer: vi.fn() });
    expect(openWorkspaceItemMock).toHaveBeenCalledWith('s1', { path: 'some_dir', kind: 'file' });
  });
});
