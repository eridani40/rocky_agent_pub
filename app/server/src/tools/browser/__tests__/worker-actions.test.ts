/**
 * worker-actions dispatchAction 单元测试（白盒，mock page，不起真 chrome）
 * 参考: specs/tech/version_logs/v0.0.226/change_plan.md（render waitUntil load→domcontentloaded）
 *       specs/tech/version_logs/v0.0.264/change_plan.md 行 13（dispatchAction 增 state 参数）
 *
 * 覆盖：
 *   - render action：page.goto(url, {waitUntil:'domcontentloaded'}) → page.content() 返回渲染后 HTML
 *   - render 缺 url → 抛错
 *   - navigate 回归（既有行为不变）
 *   - [v0.0.264] 跨 action state.lastRefs 保持：snapshot 后 click 同 ref 有效（常驻循环核心收益）
 *   - [v0.0.264] 单次调用传新建 state → 行为等价旧实现
 */
import { describe, it, expect, vi } from 'vitest';
import { dispatchAction } from '../worker-actions';
import type { WorkerSessionState } from '../types';

/** 构造 mock browser/page（page 暴露 goto/content/ariaSnapshot/getByRole 等最小面） */
function makeBrowser(pageOverrides: Record<string, unknown> = {}) {
  const page = {
    goto: vi.fn(async () => undefined),
    content: vi.fn(async () => '<html><body>rendered</body></html>'),
    ariaSnapshot: vi.fn(async () => ''),
    locator: vi.fn(() => ({ ariaSnapshot: vi.fn(async () => '') })),
    getByRole: vi.fn(() => ({
      nth: vi.fn(() => ({ click: vi.fn(async () => undefined), fill: vi.fn(async () => undefined) })),
    })),
    screenshot: vi.fn(async () => Buffer.from('png')),
    evaluate: vi.fn(async () => ({ ok: true })),
    ...pageOverrides,
  };
  const ctx = { pages: () => [page], newPage: async () => page };
  const browser = { contexts: () => [ctx], newContext: async () => ctx };
  return { browser, page };
}

/** 新建空 state（单次调用等价旧实现） */
function freshState(): WorkerSessionState {
  return { lastRefs: {} };
}

describe('dispatchAction render（web_fetch headless 一次性渲染）', () => {
  it('goto(url, {waitUntil:"domcontentloaded"}) → page.content() 返回渲染后 HTML', async () => {
    const { browser, page } = makeBrowser();
    const html = await dispatchAction(browser, 'render', { url: 'http://example.com/' }, freshState());
    // domcontentloaded（非 load）：load 对持续加载页面超时，domcontentloaded 后 DOM 就绪 JS 渲染内容已在
    expect(page.goto).toHaveBeenCalledWith('http://example.com/', {
      waitUntil: 'domcontentloaded',
    });
    expect(page.content).toHaveBeenCalled();
    expect(html).toBe('<html><body>rendered</body></html>');
  });

  it('render 的 goto 不再用 load（防回归：load 对持续加载页面超时）', async () => {
    const { browser, page } = makeBrowser();
    await dispatchAction(browser, 'render', { url: 'http://example.com/' }, freshState());
    const call = page.goto.mock.calls[0] as unknown as [unknown, { waitUntil: string }];
    const opts = call[1];
    expect(opts.waitUntil).not.toBe('load');
  });

  it('render 缺 url → 抛错', async () => {
    const { browser } = makeBrowser();
    await expect(dispatchAction(browser, 'render', {}, freshState())).rejects.toThrowError(/url 必填/);
  });

  it('render 的 goto 失败 → 抛错（worker main 转 failResult）', async () => {
    const { browser, page } = makeBrowser({
      goto: vi.fn(async () => {
        throw new Error('net::ERR_CONNECTION_REFUSED');
      }),
    });
    await expect(
      dispatchAction(browser, 'render', { url: 'http://example.com/' }, freshState()),
    ).rejects.toThrowError(/ERR_CONNECTION_REFUSED/);
    expect(page.content).not.toHaveBeenCalled();
  });
});

describe('dispatchAction navigate（回归）', () => {
  it('navigate 仍走 domcontentloaded（render 不影响既有 action）', async () => {
    const { browser, page } = makeBrowser();
    const r = await dispatchAction(browser, 'navigate', { url: 'http://example.com/' }, freshState());
    expect(page.goto).toHaveBeenCalledWith('http://example.com/', {
      waitUntil: 'domcontentloaded',
    });
    expect(r).toContain('navigated to http://example.com/');
  });
});

describe('dispatchAction 跨 action state 保持（v0.0.264 常驻循环）', () => {
  it('同 state 二次调用：snapshot 写 lastRefs → click 用同 ref 有效（跨 action 保持）', async () => {
    // snapshot 返回带 ref 的 a11y 文本
    const snapshotText = '- button [ref=btn-open] "Open"\n- link [ref=lnk-home] "Home"';
    const page = {
      locator: vi.fn(() => ({ ariaSnapshot: vi.fn(async () => snapshotText) })),
      getByRole: vi.fn(() => ({
        nth: vi.fn(() => ({ click: vi.fn(async () => undefined) })),
      })),
      goto: vi.fn(async () => undefined),
    };
    const ctx = { pages: () => [page], newPage: async () => page };
    const browser = { contexts: () => [ctx], newContext: async () => ctx };

    const state: WorkerSessionState = { lastRefs: {} };
    // 第一次：snapshot → state.lastRefs 写入 refs
    const snap = await dispatchAction(browser, 'snapshot', {}, state);
    expect(JSON.parse(snap).refs).toBeDefined();
    expect(Object.keys(state.lastRefs).length).toBeGreaterThan(0);

    // 第二次：click 用之前 snapshot 的 ref（同一 state → 命中）
    const firstRef = Object.keys(state.lastRefs)[0]!;
    await dispatchAction(browser, 'click', { ref: firstRef }, state);
    expect(page.getByRole).toHaveBeenCalled();
  });

  it('单次调用传新建 state → 行为等价旧实现（web_fetch 兼容）', async () => {
    const { browser } = makeBrowser();
    const state = freshState();
    const r = await dispatchAction(browser, 'navigate', { url: 'http://example.com/' }, state);
    expect(r).toContain('navigated');
    // state 不被污染（navigate 不改 lastRefs）
    expect(state.lastRefs).toEqual({});
  });
});
