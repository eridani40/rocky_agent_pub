/**
 * worker-actions dispatchAction 单元测试（白盒，mock page，不起真 chrome）
 * 参考: specs/tech/version_logs/v0.0.226/change_plan.md（render waitUntil load→domcontentloaded）
 *
 * 覆盖：
 *   - render action：page.goto(url, {waitUntil:'domcontentloaded'}) → page.content() 返回渲染后 HTML
 *   - render 缺 url → 抛错
 *   - navigate 回归（既有行为不变）
 */
import { describe, it, expect, vi } from 'vitest';
import { dispatchAction } from '../worker-actions';

/** 构造 mock browser/page（page 暴露 goto/content 等最小面） */
function makeBrowser(pageOverrides: Record<string, unknown> = {}) {
  const page = {
    goto: vi.fn(async () => undefined),
    content: vi.fn(async () => '<html><body>rendered</body></html>'),
    ...pageOverrides,
  };
  const ctx = { pages: () => [page], newPage: async () => page };
  const browser = { contexts: () => [ctx], newContext: async () => ctx };
  return { browser, page };
}

describe('dispatchAction render（web_fetch headless 一次性渲染）', () => {
  it('goto(url, {waitUntil:"domcontentloaded"}) → page.content() 返回渲染后 HTML', async () => {
    const { browser, page } = makeBrowser();
    const html = await dispatchAction(browser, 'render', { url: 'http://example.com/' });
    // domcontentloaded（非 load）：load 对持续加载页面超时，domcontentloaded 后 DOM 就绪 JS 渲染内容已在
    expect(page.goto).toHaveBeenCalledWith('http://example.com/', {
      waitUntil: 'domcontentloaded',
    });
    expect(page.content).toHaveBeenCalled();
    expect(html).toBe('<html><body>rendered</body></html>');
  });

  it('render 的 goto 不再用 load（防回归：load 对持续加载页面超时）', async () => {
    const { browser, page } = makeBrowser();
    await dispatchAction(browser, 'render', { url: 'http://example.com/' });
    const call = page.goto.mock.calls[0] as unknown as [unknown, { waitUntil: string }];
    const opts = call[1];
    expect(opts.waitUntil).not.toBe('load');
  });

  it('render 缺 url → 抛错', async () => {
    const { browser } = makeBrowser();
    await expect(dispatchAction(browser, 'render', {})).rejects.toThrowError(/url 必填/);
  });

  it('render 的 goto 失败 → 抛错（worker main 转 failResult）', async () => {
    const { browser, page } = makeBrowser({
      goto: vi.fn(async () => {
        throw new Error('net::ERR_CONNECTION_REFUSED');
      }),
    });
    await expect(
      dispatchAction(browser, 'render', { url: 'http://example.com/' }),
    ).rejects.toThrowError(/ERR_CONNECTION_REFUSED/);
    expect(page.content).not.toHaveBeenCalled();
  });
});

describe('dispatchAction navigate（回归）', () => {
  it('navigate 仍走 domcontentloaded（render 不影响既有 action）', async () => {
    const { browser, page } = makeBrowser();
    const r = await dispatchAction(browser, 'navigate', { url: 'http://example.com/' });
    expect(page.goto).toHaveBeenCalledWith('http://example.com/', {
      waitUntil: 'domcontentloaded',
    });
    expect(r).toContain('navigated to http://example.com/');
  });
});
