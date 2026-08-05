// @vitest-environment jsdom
/**
 * paste-image-handler 单测 —— 粘贴图片拦截 / 落盘 / 插 pill（v0.0.177）
 * 参考: specs/prd/version_logs/v0.0.177.md（产品逻辑）
 *       specs/ui/components/chat-page/chat-composer.md（handlePaste，doc-modifier 阶段补）
 *       specs/tech/version_logs/v0.0.177/change_plan.md（method 级合同）
 *
 * 覆盖 test-plan UT 必覆盖清单：
 *   - image/* item → 拦截 / 无 image item（纯文本）→ 不拦截（返 false）
 *   - Blob → base64 → POST saveImage → relPath
 *   - insertMention({type:'file', path:relPath, icon:'file', label:filename}) 在当前 selection
 *   - 多图：依次处理（顺序 await，禁 Promise.all）
 *   - 上传失败：不插 pill + 不阻塞（其他成功的继续）
 *
 * mock 策略：
 *   - saveImage 整个模块 mock（避免真实 HTTP + 提供 stubbed relPath + 注入失败）
 *   - editor 是带 chain().focus().insertMention().run() 的纯 stub（不接 Tiptap）
 *   - DataTransfer / Blob / FileReader 用 jsdom 原生 + fake 实现（jsdom 的 FileReader 支持 readAsDataURL）
 *   - vi.mock 用 __dirname 派生的绝对路径（vitest 相对路径 mock 在 bun+jsdom 下静默失效）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// 用 __dirname 派生的绝对路径 mock（memory: test-vitest-mock-absolute-path）。
// vi.mock 被 hoist 到文件顶部，必须用 vi.hoisted 才能在 factory 内拿到 path。
const workspaceApiPath = vi.hoisted(() => {
  const { resolve } = require('node:path');
  return resolve(__dirname, '../../../lib/chat-api/workspace-api.ts');
});

vi.mock(workspaceApiPath, () => ({
  saveImage: vi.fn(async (_sid: string, body: { mediaType: string; base64: string }) => {
    const ext =
      body.mediaType === 'image/png' ? 'png'
      : body.mediaType === 'image/jpeg' ? 'jpg'
      : body.mediaType === 'image/gif' ? 'gif'
      : 'webp';
    // 用 base64 长度作 id 以便测试断言区分
    const id = String(body.base64.length).padStart(26, '0');
    return { path: `images/image-${id}.${ext}` };
  }),
}));

import { processImagePaste, blobToBase64 } from '../paste-image-handler';
import { saveImage } from '../../../lib/chat-api/workspace-api';

/** 拿到 typed mock 句柄 */
const saveImageMock = vi.mocked(saveImage);

/** 构造 mock editor，记录 insertMention 调用 */
function makeMockEditor() {
  const calls: Array<{ type: string; path: string; icon: string; label: string }> = [];
  const api = {
    focus: () => api,
    insertMention: (attrs: { type: string; path: string; icon: string; label: string }) => {
      calls.push(attrs);
      return api;
    },
    run: () => undefined,
  };
  const editor = { chain: () => api };
  return { editor: editor as any, calls };
}

/** 构造 fake DataTransfer.items */
function makeClipboard(items: Array<{ kind: string; type: string; data?: string }>): DataTransfer {
  const fileItems = items.map((it) => ({
    kind: it.kind,
    type: it.type,
    getAsFile: () => {
      if (it.kind !== 'file') return null;
      const text = it.data ?? `fake-image-data-for-${it.type}`;
      return new Blob([text], { type: it.type });
    },
    getAsString: (cb: (s: string) => void) => {
      if (it.kind === 'string') cb(it.data ?? 'plain-text');
    },
  }));
  return { items: fileItems as any } as unknown as DataTransfer;
}

beforeEach(() => {
  saveImageMock.mockClear();
  // 重新设置默认实现（防御性，clearAllMocks 不应清除但保险起见）
  saveImageMock.mockImplementation(async (_sid, body) => {
    const ext =
      body.mediaType === 'image/png' ? 'png'
      : body.mediaType === 'image/jpeg' ? 'jpg'
      : body.mediaType === 'image/gif' ? 'gif'
      : 'webp';
    const id = String(body.base64.length).padStart(26, '0');
    return { path: `images/image-${id}.${ext}` };
  });
});

describe('processImagePaste', () => {
  it('image/* item → 拦截（返 true）+ 调 saveImage + insertMention', async () => {
    const { editor, calls } = makeMockEditor();
    const clipboard = makeClipboard([
      { kind: 'file', type: 'image/png', data: 'png-bytes' },
    ]);
    const handled = await processImagePaste(editor, 'S1', clipboard);
    expect(handled).toBe(true);
    expect(saveImageMock).toHaveBeenCalledTimes(1);
    const [sid, body] = saveImageMock.mock.calls[0]!;
    expect(sid).toBe('S1');
    expect(body.mediaType).toBe('image/png');
    expect(typeof body.base64).toBe('string');
    expect(body.base64.length).toBeGreaterThan(0);
    // insertMention 调用一次，type=file/icon=file/path 来自 server
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({
      type: 'file',
      icon: 'file',
      path: expect.stringMatching(/^images\/image-\d+\.(png|jpg|gif|webp)$/),
    });
    // label = basename(relPath)
    const relPath = calls[0]!.path;
    const expectedLabel = relPath.slice(relPath.lastIndexOf('/') + 1);
    expect(calls[0]!.label).toBe(expectedLabel);
  });

  it('无 image item（纯文本）→ 不拦截（返 false）+ 不调 saveImage', async () => {
    const { editor, calls } = makeMockEditor();
    const clipboard = makeClipboard([
      { kind: 'string', type: 'text/plain', data: 'hello' },
    ]);
    const handled = await processImagePaste(editor, 'S1', clipboard);
    expect(handled).toBe(false);
    expect(saveImageMock).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);
  });

  it('图片 + 文本混合 → 只处理图片（文本由 Tiptap 默认或被 handlePaste preventDefault 拦掉）', async () => {
    const { editor, calls } = makeMockEditor();
    const clipboard = makeClipboard([
      { kind: 'string', type: 'text/plain', data: 'hello' },
      { kind: 'file', type: 'image/png', data: 'png-data' },
      { kind: 'string', type: 'text/plain', data: 'world' },
    ]);
    const handled = await processImagePaste(editor, 'S1', clipboard);
    expect(handled).toBe(true);
    expect(saveImageMock).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(1);
  });

  it('Blob → base64 转换（剥 data URL 前缀，传纯 base64 给 saveImage）', async () => {
    const { editor } = makeMockEditor();
    const clipboard = makeClipboard([
      { kind: 'file', type: 'image/png', data: 'abc' },
    ]);
    await processImagePaste(editor, 'S1', clipboard);
    const body = saveImageMock.mock.calls[0]![1];
    // base64 应是 'abc' 的 base64 编码（不含 data: 前缀）
    const expected = btoa('abc');
    expect(body.base64).toBe(expected);
    expect(body.base64).not.toContain('data:');
  });

  it('多图：依次顺序处理（不并发），保 pill DOM 顺序与 items 一致', async () => {
    const { editor, calls } = makeMockEditor();
    const clipboard = makeClipboard([
      { kind: 'file', type: 'image/png', data: 'first' },
      { kind: 'file', type: 'image/jpeg', data: 'second' },
      { kind: 'file', type: 'image/gif', data: 'third' },
    ]);
    const handled = await processImagePaste(editor, 'S1', clipboard);
    expect(handled).toBe(true);
    expect(saveImageMock).toHaveBeenCalledTimes(3);
    expect(calls.length).toBe(3);
    // 顺序保证：第一张 png / 第二张 jpg / 第三张 gif
    expect(calls[0]!.path.endsWith('.png')).toBe(true);
    expect(calls[1]!.path.endsWith('.jpg')).toBe(true);
    expect(calls[2]!.path.endsWith('.gif')).toBe(true);
  });

  it('上传失败：不插对应 pill，其他成功的不阻塞', async () => {
    // 第二张图 saveImage 抛错
    saveImageMock.mockImplementation(async (_sid, body) => {
      if (body.mediaType === 'image/jpeg') throw new Error('upload failed');
      return { path: 'images/image-stub.png' };
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { editor, calls } = makeMockEditor();
    const clipboard = makeClipboard([
      { kind: 'file', type: 'image/png', data: 'ok1' },
      { kind: 'file', type: 'image/jpeg', data: 'fail' },
      { kind: 'file', type: 'image/gif', data: 'ok3' },
    ]);
    const handled = await processImagePaste(editor, 'S1', clipboard);
    // 处理过 image（true），但只插了 2 个 pill（png + gif，跳过 jpg）
    expect(handled).toBe(true);
    expect(calls.length).toBe(2);
    // warn 记录失败
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('全部 image 上传失败 → 返 false（无 pill 插入）', async () => {
    saveImageMock.mockRejectedValue(new Error('all fail'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { editor, calls } = makeMockEditor();
    const clipboard = makeClipboard([
      { kind: 'file', type: 'image/png', data: 'fail1' },
    ]);
    const handled = await processImagePaste(editor, 'S1', clipboard);
    expect(handled).toBe(false);
    expect(calls.length).toBe(0);
    warnSpy.mockRestore();
  });
});

describe('blobToBase64', () => {
  it('Blob → 纯 base64 字符串（剥 data 前缀）', async () => {
    const blob = new Blob(['hello'], { type: 'text/plain' });
    const b64 = await blobToBase64(blob);
    expect(b64).toBe(btoa('hello'));
    expect(b64).not.toContain('data:');
    expect(b64).not.toContain(',');
  });

  it('空 Blob → 空 base64（非异常）', async () => {
    const blob = new Blob([], { type: 'image/png' });
    const b64 = await blobToBase64(blob);
    expect(b64).toBe('');
  });
});
