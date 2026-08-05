/**
 * PlaywrightSession —— BrowserSession 协议的 Playwright 实现（mode ①②）
 * 参考: specs/tech/agent/tools/[P1]browser_tool.md §2 §6
 *
 * 底层持有 playwright Browser + 当前选中 Page，操作通过 page.locator/getByRole 实现。
 * snapshot 用 page.locator('body').ariaSnapshot() 取 a11y 文本 + 自建 ref 表（snapshot-ref.ts）。
 * click/type 按 ref 反查 RefInfo → page.getByRole(role,{name,exact}).nth(n)。
 * close 调用 launchResult.kill() 杀 chrome 进程（mode ①② 自启的）。
 */
import type {
  BrowserSession,
  PageInfo,
  SnapshotResult,
  RefInfo,
} from './types';
import { BrowserError } from './types';
import { buildSnapshotResult, lookupRef } from './snapshot-ref';

// playwright 类型最小依赖（用 any 避免无 playwright 环境的 typecheck 失败）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PWBrowser = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PWPage = any;

/**
 * PlaywrightSession 工厂：注入 playwright Browser + kill 钩子。
 * browser 由 chrome-launcher.ts launchChromeAndConnect 产出（已 connectOverCDP）。
 */
export class PlaywrightSession implements BrowserSession {
  private browser: PWBrowser;
  private kill: () => Promise<void>;
  private currentPage: PWPage | undefined;
  /** 最近一次 snapshot 的 refs（click/type 反查用） */
  private lastRefs: Record<string, RefInfo> = {};
  private closed = false;

  constructor(browser: PWBrowser, kill: () => Promise<void>) {
    this.browser = browser;
    this.kill = kill;
  }

  async listPages(): Promise<PageInfo[]> {
    const ctx = await this.ensureContext();
    const pages = ctx.pages() as PWPage[];
    return pages.map((p, i) => ({
      id: String(p.url ? p.url() : `page-${i}`),
      url: p.url ? p.url() : '',
      selected: i === 0,
    }));
  }

  async selectPage(pageId: string): Promise<void> {
    const ctx = await this.ensureContext();
    const pages = ctx.pages() as PWPage[];
    // pageId 在 listPages 用 url 占位；这里按 url 匹配回 page
    const found = pages.find((p) => (p.url ? p.url() : '') === pageId) ?? pages[0];
    if (!found) throw new BrowserError('unknown', `page "${pageId}" 未找到`);
    this.currentPage = found;
  }

  async navigate(url: string): Promise<void> {
    const page = await this.ensurePage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async snapshot(opts?: { format?: 'aria' | 'ai' }): Promise<SnapshotResult> {
    const page = await this.ensurePage();
    const format = opts?.format ?? 'aria';
    const mode = format === 'ai' ? 'ai' : 'default';
    // playwright ariaSnapshot 在 locator 上；fallback 到 page 本身
    let text: string;
    try {
      text = await page.locator('body').ariaSnapshot({ mode });
    } catch {
      text = await page.ariaSnapshot({ mode });
    }
    const result = buildSnapshotResult(text, format);
    this.lastRefs = result.refs;
    return result;
  }

  async click(ref: string): Promise<void> {
    const info = lookupRef(this.lastRefs, ref);
    const page = await this.ensurePage();
    const locator = this.refLocator(page, info);
    await locator.click({ timeout: 5000 });
  }

  async type(ref: string, text: string): Promise<void> {
    const info = lookupRef(this.lastRefs, ref);
    const page = await this.ensurePage();
    const locator = this.refLocator(page, info);
    await locator.fill(text, { timeout: 5000 });
  }

  async evaluate(script: string): Promise<unknown> {
    const page = await this.ensurePage();
    return page.evaluate(script);
  }

  async screenshot(): Promise<{ mime: string; data: Buffer }> {
    const page = await this.ensurePage();
    const data: Buffer = await page.screenshot({ type: 'png' });
    return { mime: 'image/png', data };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.browser.close?.();
    } catch {
      /* ignore */
    }
    await this.kill();
  }

  // ---- 内部 helpers ----

  private async ensureContext(): Promise<PWBrowser> {
    if (this.closed) throw new BrowserError('unknown', 'session 已关闭');
    const contexts = this.browser.contexts();
    return contexts[0] ?? (await this.browser.newContext());
  }

  private async ensurePage(): Promise<PWPage> {
    if (this.currentPage) return this.currentPage;
    const ctx = await this.ensureContext();
    const pages = ctx.pages();
    this.currentPage = pages[0] ?? (await ctx.newPage());
    return this.currentPage;
  }

  /** RefInfo → getByRole locator（精度高，按 role+name+nth） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private refLocator(page: PWPage, info: RefInfo): any {
    return page.getByRole(info.role, { name: info.name, exact: true }).nth(info.nth);
  }
}
