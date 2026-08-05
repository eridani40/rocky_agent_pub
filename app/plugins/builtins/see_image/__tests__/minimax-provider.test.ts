/**
 * MinimaxSeeImageProvider（MiniMax-M3 anthropic 兼容端点）单测（白盒）
 * 参考: specs/tech/agent/tools/[P1]see_image_tool.md §5.1
 *
 * 覆盖：
 *   - isAvailable(cfg)：cfg.apiKey 非空→true / 空/缺省/非 string→false（无 I/O）
 *   - understand：多图按 imagePaths 顺序拼 base64 image block（顺序即模型理解顺序）+ text block 收尾；
 *     写死常量断言（endpoint/model/temperature/max_tokens）；HTTP 错误传播
 *   - 出参（SeeImageResult）只含 provider/text/count/tookMs，无 base64 特征（硬约束）
 *
 * mock proxyFetch + image-utils（vi.hoisted 内 require('path') 派生绝对路径，
 * 避免 Bun+jsdom 并发下相对路径 mock 静默失效；memory: test-vitest-mock-absolute-path）。
 * 不调真实 MiniMax API。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted 在 mock 提升之前执行；用 require() 而非 ESM import（ESM import 被提升后 path 尚未初始化）
const { PROXY_ABS, IMAGE_UTILS_ABS } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');
  return {
    PROXY_ABS: path.resolve(__dirname, '../../../../server/src/tools/web-fetch/proxy'),
    IMAGE_UTILS_ABS: path.resolve(__dirname, '../image-utils'),
  };
});

vi.mock(PROXY_ABS, () => ({
  proxyFetch: vi.fn(),
}));

// mock base64 helper：返回确定性标记值，避免依赖真实文件系统读取
vi.mock(IMAGE_UTILS_ABS, () => ({
  readImageAsBase64: vi.fn(async (absPath: string) => `b64:${absPath}`),
  inferMediaType: vi.fn((absPath: string) => (absPath.endsWith('.png') ? 'image/png' : 'image/jpeg')),
}));

import { proxyFetch as mockProxyFetch } from '../../../../server/src/tools/web-fetch/proxy';
import MinimaxSeeImageProvider from '../minimax-provider';

describe('isAvailable(cfg): 无 I/O（仅查 cfg.apiKey）', () => {
  it('cfg.apiKey 非空 → true', () => {
    const p = new MinimaxSeeImageProvider('minimax_m3');
    expect(p.isAvailable({ apiKey: 'sk-real' })).toBe(true);
  });

  it('cfg.apiKey 空串/缺省/非 string → false', () => {
    const p = new MinimaxSeeImageProvider('minimax_m3');
    expect(p.isAvailable({ apiKey: '' })).toBe(false);
    expect(p.isAvailable({})).toBe(false);
    expect(p.isAvailable({ apiKey: 123 })).toBe(false);
    expect(p.isAvailable()).toBe(false);
  });

  it('构造器 cfg.apiKey 非空 + 运行时无入参 cfg → false（构造器 cfg 不用于凭证）', () => {
    const p = new MinimaxSeeImageProvider('minimax_m3', { apiKey: 'sk-from-ctor' });
    expect(p.isAvailable()).toBe(false);
    expect(p.isAvailable({})).toBe(false);
    expect(p.isAvailable({ apiKey: 'sk-runtime' })).toBe(true);
  });

  it('label = MiniMax · M3（多图视觉理解）', () => {
    const p = new MinimaxSeeImageProvider('minimax_m3');
    expect(p.label).toBe('MiniMax · M3（多图视觉理解）');
  });
});

describe('understand: 多图有序 + 写死常量 + HTTP 错误传播', () => {
  const mockFetch = mockProxyFetch as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('多图按 imagePaths 顺序拼 image block + text block 收尾；写死 endpoint/model/temperature/max_tokens', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: '图1是红色，图2是蓝色' }] }),
    });
    const p = new MinimaxSeeImageProvider('minimax_m3');
    const res = await p.understand('请描述这些图片', ['/abs/red.png', '/abs/blue.jpg'], {
      apiKey: 'sk-x',
    });

    expect(res.provider).toBe('minimax_m3');
    expect(res.text).toBe('图1是红色，图2是蓝色');
    expect(res.count).toBe(2);
    expect(res.tookMs).toBeGreaterThanOrEqual(0);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe('https://api.minimaxi.com/anthropic/v1/messages');
    const init = call[1] as { method: string; headers: Record<string, string>; body: string };
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-x');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('MiniMax-M3');
    expect(body.temperature).toBe(1.0);
    expect(body.max_tokens).toBe(2048);
    // 顺序：2 个 image block（按 imagePaths 顺序）+ 1 个 text block 收尾
    const content = body.messages[0].content;
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'b64:/abs/red.png' },
    });
    expect(content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'b64:/abs/blue.jpg' },
    });
    expect(content[2]).toEqual({ type: 'text', text: '请描述这些图片' });
  });

  it('cfg.apiKey 空 → 抛错「未配置 apiKey」，不调 fetch', async () => {
    const p = new MinimaxSeeImageProvider('minimax_m3');
    await expect(p.understand('q', ['/abs/a.png'], {})).rejects.toThrow(/未配置 apiKey/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('HTTP 非 2xx → 抛错含 status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    });
    const p = new MinimaxSeeImageProvider('minimax_m3');
    await expect(p.understand('q', ['/abs/a.png'], { apiKey: 'bad' })).rejects.toThrow(/401/);
  });

  it('出参 key 集只含 provider/text/count/tookMs，无 base64 特征（硬约束）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: '纯文字理解结果' }] }),
    });
    const p = new MinimaxSeeImageProvider('minimax_m3');
    const res = await p.understand('q', ['/abs/a.png'], { apiKey: 'sk-x' });
    expect(Object.keys(res).sort()).toEqual(['count', 'provider', 'text', 'tookMs'].sort());
    expect(JSON.stringify(res)).not.toContain('data:image');
    expect(JSON.stringify(res)).not.toContain('b64:'); // mock base64 标记不应泄漏到出参
  });
});
