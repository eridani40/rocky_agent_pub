/**
 * ZhipuSeeImageProvider（智谱 GLM 视觉 REST 直调，单图约束）单测（白盒）
 * 参考: specs/tech/agent/tools/[P1]see_image_tool.md §5.2
 *       PRD SI-2（zhipu 图数≠1 报错，change_log.md §3）
 *
 * 覆盖：
 *   - 单图约束（PRD SI-2）：imagePaths.length!==1 → 抛错含实际张数，首行校验优先于 apiKey 检查
 *   - isAvailable(cfg)：cfg.apiKey 非空→true / 空/缺省/非 string→false（无 I/O）
 *   - understand：base64 data URL 拼装（OpenAI 兼容多模态）+ 写死常量断言；HTTP 错误传播
 *   - 出参（SeeImageResult）只含 provider/text/count/tookMs，无 base64 特征（硬约束）
 *
 * mock 同 minimax-provider.test.ts 模式（vi.hoisted 绝对路径，memory: test-vitest-mock-absolute-path）。
 * 不调真实智谱 API。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock(IMAGE_UTILS_ABS, () => ({
  readImageAsBase64: vi.fn(async (absPath: string) => `b64:${absPath}`),
  inferMediaType: vi.fn(() => 'image/png'),
}));

import { proxyFetch as mockProxyFetch } from '../../../../server/src/tools/web-fetch/proxy';
import ZhipuSeeImageProvider from '../zhipu-image-provider';

describe('单图约束（PRD SI-2）：imagePaths.length!==1 → 抛错', () => {
  const mockFetch = mockProxyFetch as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => vi.clearAllMocks());

  it('0 张图 → 抛错含「当前传入 0 张」，不调 fetch', async () => {
    const p = new ZhipuSeeImageProvider('zhipu_image');
    await expect(p.understand('q', [], { apiKey: 'sk-x' })).rejects.toThrow(
      /智谱视觉 vender 仅支持 1 张图片，当前传入 0 张/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('2 张图 → 抛错含「当前传入 2 张」，不调 fetch', async () => {
    const p = new ZhipuSeeImageProvider('zhipu_image');
    await expect(
      p.understand('q', ['/abs/a.png', '/abs/b.png'], { apiKey: 'sk-x' }),
    ).rejects.toThrow(/智谱视觉 vender 仅支持 1 张图片，当前传入 2 张/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('图数≠1 优先于 apiKey 校验（首行校验，图数错 + apiKey 空仍报图数错）', async () => {
    const p = new ZhipuSeeImageProvider('zhipu_image');
    await expect(p.understand('q', [], {})).rejects.toThrow(/当前传入 0 张/);
  });
});

describe('isAvailable(cfg): 无 I/O（仅查 cfg.apiKey）', () => {
  it('cfg.apiKey 非空 → true / 空/缺省/非 string → false', () => {
    const p = new ZhipuSeeImageProvider('zhipu_image');
    expect(p.isAvailable({ apiKey: 'sk-real' })).toBe(true);
    expect(p.isAvailable({ apiKey: '' })).toBe(false);
    expect(p.isAvailable({})).toBe(false);
    expect(p.isAvailable({ apiKey: 123 })).toBe(false);
    expect(p.isAvailable()).toBe(false);
  });

  it('label = 智谱 · GLM 视觉（单图）', () => {
    const p = new ZhipuSeeImageProvider('zhipu_image');
    expect(p.label).toBe('智谱 · GLM 视觉（单图）');
  });
});

describe('understand: 单图 base64 data URL 拼装 + 写死常量 + HTTP 错误传播', () => {
  const mockFetch = mockProxyFetch as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('单图 data URL 拼装 + 写死 endpoint/model；响应取 choices[0].message.content', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '这是一张红色图片' } }] }),
    });
    const p = new ZhipuSeeImageProvider('zhipu_image');
    const res = await p.understand('这是什么', ['/abs/red.png'], { apiKey: 'sk-x' });

    expect(res.provider).toBe('zhipu_image');
    expect(res.text).toBe('这是一张红色图片');
    expect(res.count).toBe(1);
    expect(res.tookMs).toBeGreaterThanOrEqual(0);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    const init = call[1] as { method: string; headers: Record<string, string>; body: string };
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-x');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('glm-4.5v');
    const content = body.messages[0].content;
    expect(content[0]).toEqual({ type: 'text', text: '这是什么' });
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,b64:/abs/red.png' },
    });
  });

  it('cfg.apiKey 空 → 抛错「未配置 apiKey」，不调 fetch', async () => {
    const p = new ZhipuSeeImageProvider('zhipu_image');
    await expect(p.understand('q', ['/abs/a.png'], {})).rejects.toThrow(/未配置 apiKey/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('HTTP 非 2xx → 抛错含 status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    });
    const p = new ZhipuSeeImageProvider('zhipu_image');
    await expect(p.understand('q', ['/abs/a.png'], { apiKey: 'bad' })).rejects.toThrow(/401/);
  });

  it('出参 key 集只含 provider/text/count/tookMs，无 base64 特征（硬约束）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '纯文字理解结果' } }] }),
    });
    const p = new ZhipuSeeImageProvider('zhipu_image');
    const res = await p.understand('q', ['/abs/a.png'], { apiKey: 'sk-x' });
    expect(Object.keys(res).sort()).toEqual(['count', 'provider', 'text', 'tookMs'].sort());
    expect(JSON.stringify(res)).not.toContain('data:image');
  });
});
