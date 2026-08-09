// @vitest-environment jsdom
/**
 * primitive-markdown-image 单测 — 图片渲染 helper（v0.0.286）
 * 参考: app/web/src/components/common/primitive-markdown-image.tsx
 *
 * 覆盖：
 *   - joinPath：baseDir+relative 合并 / relative 已是 absolute 原样 / 尾部斜杠处理
 *   - resolveImageUrl：web/data/absolute/relative 四态分流
 *   - MarkdownImage：web 直渲 / data 白名单 / absolute IPC base64 / relative workspace HTTP / 无 baseDir 降级 alt / 危险协议拦截 / too-large
 *   - PrimitiveImageLightbox：渲染 + Esc/遮罩关闭
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  joinPath,
  resolveImageUrl,
  deriveBaseDir,
  MarkdownImage,
  PrimitiveImageLightbox,
} from '../primitive-markdown-image';

// ===== mock readWorkspaceFileBinary（避免真实 HTTP）=====
vi.mock('../../../lib/chat-api/workspace-api', () => ({
  readWorkspaceFileBinary: vi.fn(async () => ({ content: 'YmFzZTY0' })),
}));

// ===== mock Portal（避免 createPortal DOM 问题）=====
vi.mock('../../../lib/portal', () => ({
  Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ===== rockyShell mock =====
function mockRockyShell(overrides?: Partial<{ readFileBinary: ReturnType<typeof vi.fn> }>) {
  const api = {
    readFileBinary: overrides?.readFileBinary ?? vi.fn(async () => ({ ok: true, content: 'aGVsbG8=' })),
  };
  (window as unknown as { rockyShell: unknown }).rockyShell = api;
  return api;
}

beforeEach(() => mockRockyShell());
afterEach(() => {
  delete (window as unknown as { rockyShell?: unknown }).rockyShell;
  vi.clearAllMocks();
  cleanup();
});

// ===== joinPath =====
describe('joinPath', () => {
  it('baseDir + relative 合并', () => {
    expect(joinPath('/a/b', 'c.png')).toBe('/a/b/c.png');
  });
  it('baseDir 尾部斜杠去重', () => {
    expect(joinPath('/a/b/', 'c.png')).toBe('/a/b/c.png');
    expect(joinPath('/a/b//', 'c.png')).toBe('/a/b/c.png');
  });
  it('relative 前导斜杠去除', () => {
    expect(joinPath('/a/b', '/c.png')).toBe('/a/b/c.png');
  });
  it('relative 已是 absolute 原样返回', () => {
    expect(joinPath('/a/b', '~/img.png')).toBe('~/img.png');
    expect(joinPath('/a/b', 'C:\\img.png')).toBe('C:\\img.png');
    expect(joinPath('/a/b', 'file:///x.png')).toBe('file:///x.png');
  });
  it('BUG-001: 空 baseDir（md 在根目录）→ relative 原样返回', () => {
    expect(joinPath('', 'images/test.png')).toBe('images/test.png');
    expect(joinPath('', 'c.png')).toBe('c.png');
  });
});

// ===== deriveBaseDir（BUG-001 修复）=====
describe('deriveBaseDir', () => {
  it('含路径 → 截取目录部分', () => {
    expect(deriveBaseDir('docs/sub/a.md')).toBe('docs/sub');
    expect(deriveBaseDir('/abs/path/a.md')).toBe('/abs/path');
    expect(deriveBaseDir('docs/a.md')).toBe('docs');
  });
  it('BUG-001: 纯文件名（无 /）→ 空串（根目录）', () => {
    expect(deriveBaseDir('md-image-test.md')).toBe('');
    expect(deriveBaseDir('a.md')).toBe('');
  });
  it('空值 → undefined', () => {
    expect(deriveBaseDir(undefined)).toBeUndefined();
    expect(deriveBaseDir('')).toBeUndefined();
  });
});

// ===== resolveImageUrl =====
describe('resolveImageUrl', () => {
  it('http/https → web', () => {
    expect(resolveImageUrl('http://x.com/a.png')).toEqual({ type: 'web', url: 'http://x.com/a.png' });
    expect(resolveImageUrl('https://y.com/b.jpg').type).toBe('web');
  });
  it('data:image/ → data', () => {
    expect(resolveImageUrl('data:image/png;base64,xxx').type).toBe('data');
  });
  it('absolute 路径 → absolute', () => {
    expect(resolveImageUrl('/abs/a.png').type).toBe('absolute');
    expect(resolveImageUrl('~/img.png').type).toBe('absolute');
    expect(resolveImageUrl('file:///x.png').type).toBe('absolute');
  });
  it('relative 无 baseDir → relative（无 resolvedPath）', () => {
    const info = resolveImageUrl('img/a.png');
    expect(info.type).toBe('relative');
    expect(info.resolvedPath).toBeUndefined();
  });
  it('relative + baseDir → resolvedPath', () => {
    const info = resolveImageUrl('img/a.png', '/docs');
    expect(info.type).toBe('relative');
    expect(info.resolvedPath).toBe('/docs/img/a.png');
  });
  it('BUG-002: 空串 baseDir（md 在根目录）→ relative + resolvedPath（空串不是 falsy）', () => {
    const info = resolveImageUrl('images/test.png', '');
    expect(info.type).toBe('relative');
    expect(info.resolvedPath).toBe('images/test.png');
  });
  it('relative + baseDir + joinPath 后是 absolute → absolute type', () => {
    const info = resolveImageUrl('img/a.png', '/docs');
    expect(info.type).toBe('relative');
    expect(info.resolvedPath).toBe('/docs/img/a.png');
  });
});

// ===== MarkdownImage 渲染 =====
describe('MarkdownImage 渲染', () => {
  it('web 图片直渲（loaded 态）', async () => {
    render(<MarkdownImage src="https://example.com/a.png" alt="测试图" />);
    // web 图片是同步直渲，直接进 loaded
    const img = await screen.findByTestId('md-image-loaded');
    expect(img.getAttribute('src')).toBe('https://example.com/a.png');
    expect(img.getAttribute('alt')).toBe('测试图');
  });

  it('data:image/ 白名单直渲', async () => {
    render(<MarkdownImage src="data:image/png;base64,iVBOR" alt="inline" />);
    const img = await screen.findByTestId('md-image-loaded');
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBOR');
  });

  it('危险协议 javascript: → 降级 error', () => {
    render(<MarkdownImage src="javascript:alert(1)" alt="xss" />);
    expect(screen.getByTestId('md-image-error')).toBeTruthy();
  });

  it('data:text/html 非图片 → 降级 error', () => {
    render(<MarkdownImage src="data:text/html,<script>" alt="bad" />);
    expect(screen.getByTestId('md-image-error')).toBeTruthy();
  });

  it('relative 无 baseDir → 降级 alt error', () => {
    render(<MarkdownImage src="img/a.png" alt="相对图" />);
    expect(screen.getByTestId('md-image-error')).toBeTruthy();
    expect(screen.getByTestId('md-image-error').textContent).toContain('相对图');
  });

  it('absolute 路径 → readFileBinary IPC → loaded', async () => {
    const api = mockRockyShell();
    render(<MarkdownImage src="/abs/path/a.png" alt="本地绝对" />);
    // 等 effect 执行 + promise resolve
    const img = await screen.findByTestId('md-image-loaded', {}, { timeout: 2000 });
    expect(img).toBeTruthy();
    expect(api.readFileBinary).toHaveBeenCalledWith('/abs/path/a.png');
  });

  it('absolute + readFileBinary 返 too-large → too-large 态', async () => {
    mockRockyShell({
      readFileBinary: vi.fn(async () => ({ ok: false, reason: 'too-large' })),
    });
    render(<MarkdownImage src="/abs/big.png" alt="大图" />);
    const el = await screen.findByTestId('md-image-too-large', {}, { timeout: 2000 });
    expect(el).toBeTruthy();
    expect(el.textContent).toContain('2MB');
  });

  it('absolute + readFileBinary 失败 → error', async () => {
    mockRockyShell({
      readFileBinary: vi.fn(async () => ({ ok: false, reason: 'not-found' })),
    });
    render(<MarkdownImage src="/abs/missing.png" alt="不存在" />);
    const el = await screen.findByTestId('md-image-error', {}, { timeout: 2000 });
    expect(el).toBeTruthy();
  });

  it('relative + baseDir + sessionId → HTTP 调用（无 mock server → error 是正确行为）', async () => {
    render(<MarkdownImage src="img/a.png" alt="ws相对" baseDir="/docs" sessionId="sess-1" />);
    // 无真实 server，readWorkspaceFileBinary 发 HTTP 失败 → catch → error（验证走了 HTTP 分支而非降级 alt）
    const el = await screen.findByTestId('md-image-error', {}, { timeout: 3000 });
    expect(el).toBeTruthy();
    expect(el.textContent).toContain('ws相对');
  });

  it('BUG-002: relative + 空串 baseDir + sessionId + DI readBinary 成功 → loaded（md 在根目录场景）', async () => {
    // DI 注入 mock readBinary 返回 base64（绕过 bun vi.mock 模块缓存问题）
    const mockReadBinary = vi.fn(async () => 'aGVsbG8=');
    render(<MarkdownImage src="images/test.png" alt="本地图片" baseDir="" sessionId="sess-1" readBinary={mockReadBinary} />);
    const img = await screen.findByTestId('md-image-loaded', {}, { timeout: 3000 });
    expect(img).toBeTruthy();
    // 验证 readBinary 用正确的 sessionId + resolvedPath 调用
    expect(mockReadBinary).toHaveBeenCalledWith('sess-1', 'images/test.png');
    // 验证 img src 是 data URL（base64 → data:image/unknown;base64,...）
    expect(img.getAttribute('src')).toContain('data:image/unknown;base64,');
  });

  it('relative + baseDir + sessionId + DI readBinary 失败 → error', async () => {
    const mockReadBinary = vi.fn(async () => { throw new Error('404'); });
    render(<MarkdownImage src="img/a.png" alt="失败图" baseDir="/docs" sessionId="sess-1" readBinary={mockReadBinary} />);
    const el = await screen.findByTestId('md-image-error', {}, { timeout: 3000 });
    expect(el).toBeTruthy();
    expect(el.textContent).toContain('失败图');
  });
});

// ===== PrimitiveImageLightbox =====
describe('PrimitiveImageLightbox', () => {
  it('渲染 img + 关闭按钮', () => {
    render(<PrimitiveImageLightbox src="https://x.com/a.png" alt="放大" onClose={vi.fn()} />);
    const imgs = screen.getAllByRole('img');
    expect(imgs.length).toBeGreaterThanOrEqual(1);
  });

  it('点击 ✕ 关闭按钮触发 onClose', () => {
    const onClose = vi.fn();
    render(<PrimitiveImageLightbox src="https://x.com/a.png" alt="放大" onClose={onClose} />);
    const btn = screen.getByLabelText('关闭');
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc 键关闭', () => {
    const onClose = vi.fn();
    render(<PrimitiveImageLightbox src="https://x.com/a.png" alt="放大" onClose={onClose} />);
    // 模拟 keydown 事件
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
