/**
 * ChromeMcpSession —— BrowserSession 的 chrome-devtools-mcp MCP 实现。
 * 参考: refs/openclaw/extensions/browser/src/browser/chrome-mcp.ts:1470-1766（callTool 站点）
 *       node_modules/chrome-devtools-mcp/build/src/tools/*.js（1.4.0 实际 schema）
 *       states/v0.0.29/bugs/BUG-006（旧映射用过时契约，attach 连上但操作全失败）
 *
 * 工具映射对齐 chrome-devtools-mcp 1.4.0 实际 schema（已从 node_modules 源码核实）
 * + openclaw callTool 站点：
 *   - list_pages {} → structuredContent.pages[{id:number,url,selected}]
 *   - select_page {pageId:number} → 设 active page
 *   - navigate_page {type:'url',url,pageId}（chrome-devtools-mcp 1.4.0 schema 字段名是 type 不是 action；
 *     handler 在仅给 url 时也会默认 type='url'，但显式传 type:'url' 最明确且避免未知参数错误）
 *   - take_snapshot {pageId} → structuredContent.snapshot = a11y 树（节点 id 即 uid）
 *   - click {uid,pageId}（uid = snapshot 节点 id）
 *   - fill {uid,value,pageId}（不是 type）
 *   - evaluate_script {function,pageId}（不是 script；function 是 JS 函数体字符串）
 *
 * activePageId(number) 跟踪当前选中页：listPages 取 selected 页 / selectPage 显式设。
 * 每个 page-scoped 调用注入 pageId；未设时先 listPages 兜底取 selected 页。
 * close 只清 emulation（detach），不杀用户 chrome（attach 语义）。
 *
 * 从 chrome-mcp-driver.ts 抽出（保持 driver ≤300 行硬规则）。
 */
import type {
  BrowserSession,
  PageInfo,
  SnapshotResult,
} from './types';
import { BrowserError } from './types';
import type { McpClient } from './mcp-types';
import { parseChromeMcpSnapshot } from './chrome-mcp-snapshot';

/** ChromeMcpSession：BrowserSession 的 MCP 实现，差异全封装在此（driver/tool.ts 不感知）。 */
export class ChromeMcpSession implements BrowserSession {
  /** 当前 active page 的数字 id（list_pages/select_page 维护；page-scoped 工具用） */
  private activePageId: number | undefined;

  constructor(private readonly client: McpClient) {}

  async listPages(): Promise<PageInfo[]> {
    // arguments:{} 必传——chrome-devtools-mcp 1.4.0 ToolHandler 要求 arguments 是 object
    // （哪怕空 schema），漏了报 "Invalid arguments: expected object, received undefined"
    // → structuredContent 缺失 → extractPages 返 [] → listPages 永远空（BUG-006 真因）。
    const res = await this.client.callTool({ name: 'list_pages', arguments: {} });
    const pages = extractPages(res.structuredContent);
    // 缓存 selected 页的数字 id，供后续 page-scoped 调用注入
    const selected = pages.find((p) => p.selected);
    if (selected) {
      this.activePageId = parsePageIdNumber(selected.id);
    } else if (pages.length > 0) {
      // 无 selected 标记时取第一页（chrome-devtools-mcp 总有一个 active page）
      this.activePageId = parsePageIdNumber(pages[0]!.id);
    }
    return pages;
  }

  async selectPage(pageId: string): Promise<void> {
    const num = parsePageIdNumber(pageId);
    await this.client.callTool({
      name: 'select_page',
      arguments: { pageId: num },
    });
    this.activePageId = num;
  }

  async navigate(url: string): Promise<void> {
    const pageId = await this.ensurePageId();
    await this.client.callTool({
      name: 'navigate_page',
      // chrome-devtools-mcp 1.4.0 pages.js:178 schema = type:zod.enum(['url','back','forward','reload'])；
      // 不是 action（action 是 handle_dialog 的字段）。ToolHandler unknownArgumentNames 会拒绝 action。
      arguments: { type: 'url', url, pageId },
    });
  }

  async snapshot(): Promise<SnapshotResult> {
    const pageId = await this.ensurePageId();
    const res = await this.client.callTool({
      name: 'take_snapshot',
      arguments: { pageId },
    });
    // take_snapshot structuredContent.snapshot = a11y 树根节点；parseChromeMcpSnapshot 遍历产出
    // rocky 的 {snapshot:文本树, refs:uid→RefInfo}。结构化缺失时返回空 snapshot。
    return parseChromeMcpSnapshot(res.structuredContent);
  }

  async click(ref: string): Promise<void> {
    const pageId = await this.ensurePageId();
    // ref 即 uid（snapshot 节点 id）；chrome-devtools-mcp click schema = {uid,pageId}
    await this.client.callTool({
      name: 'click',
      arguments: { uid: ref, pageId },
    });
  }

  async type(ref: string, text: string): Promise<void> {
    const pageId = await this.ensurePageId();
    // chrome-devtools-mcp fill schema = {uid,value,pageId}（无 type 工具）
    await this.client.callTool({
      name: 'fill',
      arguments: { uid: ref, value: text, pageId },
    });
  }

  async evaluate(script: string): Promise<unknown> {
    const pageId = await this.ensurePageId();
    // chrome-devtools-mcp evaluate_script schema = {function,pageId}（字段名是 function 不是 script）
    const res = await this.client.callTool({
      name: 'evaluate_script',
      arguments: { function: script, pageId },
    });
    return res.structuredContent ?? res.content?.[0]?.text;
  }

  async close(): Promise<void> {
    // no-op: attach 模式不杀用户 chrome（attach 语义）。
    // chrome-devtools-mcp 不暴露显式 detach tool，真正的关闭（transport.close）由
    // driver.disconnect() 在 ConnectorManager toggle off 时调用——这里仅占位以满足
    // BrowserSession 协议，避免误杀用户已打开的浏览器进程。
  }

  /**
   * 确保 page-scoped 调用有 pageId：activePageId 已设直接用；
   * 未设时调 listPages 兜底取 selected/首页（参 openclaw 的 lazy resolve 模式）。
   * 兜底仍无页 → 抛 attach_failed 引导先 selectPage（不让 chrome-devtools-mcp 报模糊的 pageId Required）。
   */
  private async ensurePageId(): Promise<number> {
    if (this.activePageId !== undefined) return this.activePageId;
    await this.listPages();
    if (this.activePageId !== undefined) return this.activePageId;
    throw new BrowserError(
      'attach_failed',
      '无 active page：先调用 listPages/selectPage 选中一个页面',
    );
  }
}

/**
 * 从 list_pages 响应解析 PageInfo[]。
 * chrome-devtools-mcp structuredContent.pages = [{id:number,url:string,selected?:boolean,title?}]。
 * rocky PageInfo.id 是 string，故 String(id) 转换（对齐 openclaw toBrowserTabs 的 targetId=String(page.id)）。
 * @internal 导出仅供 UT
 */
export function extractPages(structuredContent: unknown): PageInfo[] {
  const sc = structuredContent as { pages?: unknown } | null | undefined;
  const raw = sc?.pages;
  if (!Array.isArray(raw)) return [];
  const out: PageInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as { id?: unknown; url?: unknown; selected?: unknown };
    // id 必须是 number（chrome-devtools-mcp pageIdSchema = zod.number()）
    if (typeof r.id !== 'number') continue;
    if (typeof r.url !== 'string') continue;
    out.push({
      id: String(r.id),
      url: r.url,
      selected: r.selected === true,
    });
  }
  return out;
}

/**
 * 把 pageId(string) 解析为 number（chrome-devtools-mcp 要求 strict positive integer）。
 * 参 openclaw parsePageId + parseStrictPositiveInteger。无效 → 抛 attach_failed。
 * @internal 导出仅供 UT
 */
export function parsePageIdNumber(pageId: string): number {
  const n = Number(pageId);
  if (!Number.isInteger(n) || n < 1) {
    throw new BrowserError(
      'attach_failed',
      `pageId 必须是正整数，收到: ${pageId}`,
    );
  }
  return n;
}
