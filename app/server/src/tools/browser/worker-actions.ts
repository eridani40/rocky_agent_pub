/**
 * worker-actions —— 一次性 browser worker 的 action 分发（纯 playwright page 操作）
 *
 * 从 worker-entry.ts 拆出：worker-entry.ts 模块级 `void main()` 有副作用（读 stdin/exit），
 * UT 不能直接 import；本模块无副作用，UT 可 mock page 直接测 dispatchAction。
 * 参照 playwright-session.ts 实现，无 bun-only API（bun build --target=node 打包）。
 */
import { buildSnapshotResult, lookupRef } from './snapshot-ref';
import type { BrowserActionParams } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PWBrowser = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PWPage = any;

/**
 * dispatch action —— 纯 playwright page 操作。
 * @returns action 结果文本（写入 WorkerResult.text）
 */
export async function dispatchAction(
  browser: PWBrowser,
  action: string,
  params: BrowserActionParams,
): Promise<string> {
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  let page: PWPage = ctx.pages()[0];
  if (!page) page = await ctx.newPage();
  let lastRefs: Record<string, { role: string; name: string; nth: number }> = {};

  switch (action) {
    case 'navigate': {
      const url = params.url ?? '';
      if (!url) throw new Error('browser navigate: url 必填');
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return `navigated to ${url}`;
    }
    case 'render': {
      // 一次性渲染（web_fetch headless 子分支用）：goto 等 domcontentloaded（DOM 就绪，JS 渲染内容已在）→
      // page.content() 返回渲染后 HTML。
      // 用 'domcontentloaded' 而非 'load'：load 等所有资源（广告/统计）对持续加载页面超时；
      // domcontentloaded 后 DOM 就绪即可取渲染内容（实证 ixdzs8：domcontentloaded 1.5s 拿到同等 DOM，load 20s+ 超时）。
      const url = params.url ?? '';
      if (!url) throw new Error('browser render: url 必填');
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return await page.content();
    }
    case 'snapshot': {
      const format = params.format ?? 'aria';
      const mode = format === 'ai' ? 'ai' : 'default';
      let text: string;
      try {
        text = await page.locator('body').ariaSnapshot({ mode });
      } catch {
        text = await page.ariaSnapshot({ mode });
      }
      const result = buildSnapshotResult(text, format);
      lastRefs = result.refs;
      return JSON.stringify(result);
    }
    case 'click': {
      const ref = params.ref ?? '';
      if (!ref) throw new Error('browser click: ref 必填');
      const info = lookupRef(lastRefs, ref); // 跨调用 lastRefs 重置 = pre-existing 限制
      const locator = page.getByRole(info.role, { name: info.name, exact: true }).nth(info.nth);
      await locator.click({ timeout: 5000 });
      return `clicked ${ref}`;
    }
    case 'type': {
      const ref = params.ref ?? '';
      const text = params.text ?? '';
      if (!ref) throw new Error('browser type: ref 必填');
      const info = lookupRef(lastRefs, ref);
      const locator = page.getByRole(info.role, { name: info.name, exact: true }).nth(info.nth);
      await locator.fill(text, { timeout: 5000 });
      return `typed into ${ref}`;
    }
    case 'listPages': {
      const pages = ctx.pages();
      const out = pages.map((p: PWPage, i: number) => ({
        id: String(p.url ? p.url() : `page-${i}`),
        url: p.url ? p.url() : '',
        selected: i === 0,
      }));
      return JSON.stringify(out);
    }
    case 'selectPage': {
      // 简化：selectPage 在一次性 worker 内无实际副作用（page 选择不持久跨调用）
      return `selected page ${params.ref ?? ''}`;
    }
    case 'evaluate': {
      const script = params.text ?? '';
      const r = await page.evaluate(script);
      return JSON.stringify(r);
    }
    case 'screenshot': {
      const data: Buffer = await page.screenshot({ type: 'png' });
      return JSON.stringify({ mime: 'image/png', data: data.toString('base64') });
    }
    default:
      throw new Error(`browser: 未知 action "${action}"`);
  }
}
