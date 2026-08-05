/**
 * web_fetch 工具：抓单 URL → SSRF 校验 → race（jina ∥ local 含 headless 子分支）→ markdown
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §2 §6（Tool 层 + 决策）
 *       specs/api/overall/08-web-tools.md §3（ToolDefinition + isError 分支）
 *
 * 流程（spec §1 管线）：
 *   input.url → assertSsrfSafe（命中 → isError「SSRF 拒绝」，不抓取不发往 jina）
 *             → fetchContent（§3 race runner：构造注入 2 个 ContentFetcher，
 *                              jina ∥ local（local 内部静态 → 不足起 headless 子分支），
 *                              Promise.any 首合格胜出 → raceController.abort 其他 → detached cleanup）
 *             → 全失败 → isError
 *             → wrapExternalContent（untrusted）→ truncate(maxChars)
 *
 * 依赖注入（经 ctx.config，与 web_search/browser 同模式）：
 *   - appConfig：读 web group（jinaEnabled/jinaApiKey/jinaTimeoutMs）。
 *   - browserDriverRegistry：headless 子分支渲染用（Local 内部，取 PlaywrightDriver headless mode）。
 *
 * 单测策略：mock fetchContent（或注入 appConfig + mock proxyFetch）；
 *   真实 URL/jina/headless 不在 UT（API case 由 verifier 跑）。
 */
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from '../types';
import { errorResult, textResult } from '../types';
import { truncate, wrapExternalContent, WEB_TOOLS_MAX_CHARS } from '../web-tools-utils';
import { assertSsrfSafe, SsrfError, type ResolveDnsFn } from './ssrf';
import { fetchContent, type FetchContentOptions, type FetchFailure } from './race-runner';
import type { HeadlessRenderer } from './local-fetcher';

/** web_fetch 输入形状 */
interface WebFetchInput {
  url?: unknown;
  maxChars?: unknown;
  /** 强制 headless 渲染（render=true）：跳过静态直起 headless，用于已知 JS 页或静态内容不全时 */
  render?: unknown;
}

/** AppConfigLike（仅 get 路径，鸭子类型）—— 避免本文件耦合 config 模块 */
interface AppConfigLike {
  get(group: string, key: string): unknown;
}

/** BrowserDriverRegistry 最小接口（headless 兜底用；对齐 InMemoryDriverRegistry.get） */
interface DriverRegistryLike {
  get(mode: string): unknown;
}

/** 默认 maxChars（与 WEB_TOOLS_MAX_CHARS 一致 ~100k） */
const DEFAULT_MAX_CHARS = WEB_TOOLS_MAX_CHARS;

/**
 * 创建 web_fetch Tool（依赖注入，UT 可覆盖 appConfig / driverRegistry / fetchContent）。
 * 默认实现从 ctx.config 读依赖（与 web_search/browser 同模式）。
 */
export interface WebFetchToolDeps {
  /** app_config 读取服务（缺省→读 ctx.config.appConfig） */
  appConfig?: AppConfigLike;
  /** driver registry（缺省→读 ctx.config.browserDriverRegistry；headless 兜底用） */
  driverRegistry?: DriverRegistryLike;
  /** fetchContent 注入点（UT 用；默认真实 fetchContent） */
  fetchContentImpl?: typeof fetchContent;
  /** DNS 解析注入（UT 用 mock） */
  resolveDns?: ResolveDnsFn;
}

/**
 * web_fetch 工具入口（默认单例，registry defaultTools 引用）。
 * 默认从 ctx.config 读 appConfig / driverRegistry；UT 可 createWebFetchTool({...}) 覆盖。
 */
export const webFetchTool: Tool = createWebFetchTool();

/**
 * 构造 web_fetch Tool。
 * @param deps 依赖注入（UT 覆盖 appConfig/driverRegistry/fetchContentImpl）
 */
export function createWebFetchTool(deps: WebFetchToolDeps = {}): Tool {
  const tool: Tool = {
    definition: {
      name: 'web_fetch',
      description:
        'Fetch a URL, return main content as clean markdown. Races 2 ContentFetchers (jina-reader ∥ local incl. headless sub-branch), first adequate wins. System-proxy aware, SSRF-guarded.',
      intro: 'Fetch a URL and return its main content as markdown.',
      inputSchema: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', description: '待抓取 URL' },
          maxChars: {
            type: 'number',
            default: DEFAULT_MAX_CHARS,
            description: '输出正文截断长度（默认 100000）',
          },
          render: {
            type: 'boolean',
            default: false,
            description:
              '强制 headless 渲染（已知 JS 页或静态内容不全时；跳过静态直起 headless）',
          },
        },
      },
    },
    // [v0.0.130.hang] per-tool 默认超时：网络类工具，30s（见 change_plan.md 模块 A）
    defaultTimeoutMs: 30000,

    // [v0.0.101] HITL 钩子：当前 web_fetch 不悬挂（实现 interaction 即可启用，本版未启用）
    // 旧 needsApproval 已退役（O7），改为可选 interaction（未实现 → 引擎立即调 run）

    async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
      const typed = input as WebFetchInput;
      const url = typeof typed.url === 'string' ? typed.url.trim() : '';
      if (!url) return errorResult('web_fetch: url is required');
      const maxChars =
        typeof typed.maxChars === 'number' && typed.maxChars > 0
          ? Math.floor(typed.maxChars)
          : DEFAULT_MAX_CHARS;

      // 1. SSRF 先行（jina 之前；命中 → isError，不抓取）
      const resolveDns = deps.resolveDns;
      try {
        if (resolveDns) await assertSsrfSafe(url, resolveDns);
        else await assertSsrfSafe(url);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeWebFetchErrorLog(ctx.config.logWriter, {
          tool: 'web_fetch',
          url,
          stage: 'ssrf',
          reason: msg,
        });
        if (e instanceof SsrfError) {
          return errorResult(`web_fetch: SSRF 拒绝 — ${e.message}`);
        }
        return errorResult(`web_fetch: SSRF 校验异常 — ${msg}`);
      }

      // 2. 读 app_config web group（注入或从 ctx.config）
      const appConfigService = deps.appConfig ?? (ctx.config.appConfig as AppConfigLike | undefined);
      const appConfig = readWebAppConfig(appConfigService);

      // 3. headless 兜底 renderer（从 driverRegistry 取 headless driver 的一次性 render）
      const registry =
        deps.driverRegistry ??
        (ctx.config.browserDriverRegistry as DriverRegistryLike | undefined);
      const headlessRenderer = buildHeadlessRenderer(registry);

      // 4. fetchContent（§3 race runner：构造注入 2 ContentFetcher，首合格 abort 其他）
      const fetchImpl = deps.fetchContentImpl ?? fetchContent;
      // render=true → 强制 headless（跳过静态直起 headless）
      const forceHeadless = typed.render === true;
      // 两路皆空时 race runner 经 onFailure 透出各 fetcher 失败归因（写 error.log 定位）
      let raceFailures: FetchFailure[] = [];
      const options: FetchContentOptions = {
        signal: ctx.signal,
        appConfig,
        headlessRenderer,
        forceHeadless,
        resolveDns,
        onFailure: (failures) => {
          raceFailures = failures;
        },
      };
      let result: { title: string; content: string; source: string } | null = null;
      try {
        result = await fetchImpl(url, options);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeWebFetchErrorLog(ctx.config.logWriter, {
          tool: 'web_fetch',
          url,
          stage: 'race',
          reason: msg,
        });
        return errorResult(`web_fetch: 抓取失败 — ${msg}`);
      }
      if (!result || !result.content) {
        writeWebFetchErrorLog(ctx.config.logWriter, {
          tool: 'web_fetch',
          url,
          stage: 'race',
          reason: '所有抓取路线均无充足内容',
          failures: raceFailures,
        });
        return errorResult('web_fetch: 所有抓取路线（jina ∥ local 含 headless 子分支）均无充足内容');
      }

      // 5. 序列化 markdown + wrapExternalContent（untrusted）+ 截断
      const body = serializeBody(result.title, result.content, url, result.source);
      const wrapped = wrapExternalContent(body);
      return textResult(truncate(wrapped, maxChars));
    },
  };
  return tool;
}

/**
 * 从 app_config service 读 web group 的 jina 配置（缺省回退代码默认）。
 * 返回 undefined → fetchContent 内部用默认。
 */
function readWebAppConfig(
  svc: AppConfigLike | undefined,
): FetchContentOptions['appConfig'] {
  if (!svc || typeof svc.get !== 'function') return undefined;
  const jinaEnabled = svc.get('web', 'jinaEnabled');
  const jinaApiKey = svc.get('web', 'jinaApiKey');
  const jinaTimeoutMs = svc.get('web', 'jinaTimeoutMs');
  return {
    jinaEnabled: typeof jinaEnabled === 'boolean' ? jinaEnabled : true,
    jinaApiKey: typeof jinaApiKey === 'string' ? jinaApiKey : undefined,
    jinaTimeoutMs: typeof jinaTimeoutMs === 'number' ? jinaTimeoutMs : undefined,
  };
}

/**
 * 把 driver registry 包装成 headlessRenderer(url) → 渲染后 HTML。
 * registry 缺省 / driver 无 executeOnce → 返回 undefined（跳过 headless，优雅降级）。
 *
 * 走「一次性 render」模型：prod registry 注册的 NodeWorkerDriver 只实现 executeOnce
 * （一次性 spawn node worker，无 connect 长 session——绕 Bun connectOverCDP hang
 * 的既有设计），故检测 executeOnce 而非 connect；
 * renderer 内部调 worker 的 'render' action（page.goto waitUntil:domcontentloaded → page.content()）
 * 取渲染后 HTML。
 */
function buildHeadlessRenderer(
  registry: DriverRegistryLike | undefined,
): HeadlessRenderer | undefined {
  if (!registry) return undefined;
  // 鸭子类型：registry 为 InMemoryDriverRegistry（browser/pick-driver），用 get(mode) 取 driver
  const driver = registry.get('headless') as {
    executeOnce?: (
      opts: { headless?: boolean },
      action: string,
      params: { url?: string },
      signal?: AbortSignal,
    ) => Promise<{ ok: boolean; text?: string; error?: { kind?: string; message: string } }>;
  };
  // 无 executeOnce（如 PlaywrightDriver 长 session 模型）→ 跳过 headless（静态/jina 兜底）
  if (typeof driver?.executeOnce !== 'function') return undefined;
  const renderer: HeadlessRenderer = async (url, signal) => {
    if (!driver.executeOnce) throw new Error('headless driver 无 executeOnce');
    const r = await driver.executeOnce({ headless: true }, 'render', { url }, signal);
    if (!r.ok || typeof r.text !== 'string') {
      throw new Error(`headless render 失败: ${r.error?.message ?? '无渲染结果'}`);
    }
    return r.text;
  };
  return renderer;
}

/**
 * web_fetch 失败路径写 error.log（url / 阶段 / 失败原因 + 各 fetcher 归因）。
 * 复用 ctx.config.logWriter（unknown 鸭子类型），能力探测有 write 方法才调——
 * 对齐 engine.ts writeToolLog 模式；enableErrorLog 开关由 LogWriter 内部控制，
 * 缺省 undefined → no-op。日志任何异常绝不冒泡进工具主流程（失败静默）。
 */
function writeWebFetchErrorLog(logWriter: unknown, record: Record<string, unknown>): void {
  try {
    if (!logWriter || typeof logWriter !== 'object') return;
    const w = logWriter as { write?: (type: string, rec: Record<string, unknown>) => void };
    if (typeof w.write !== 'function') return;
    w.write('error', record);
  } catch {
    /* 日志失败绝不影响工具返回 */
  }
}

/**
 * 序列化抓取结果为 markdown（标题 + 正文 + 元数据 footer）。
 */
function serializeBody(
  title: string,
  content: string,
  url: string,
  source: string,
): string {
  const lines: string[] = [];
  if (title) lines.push(`# ${title}`, '');
  lines.push(content);
  lines.push('', '---', `source: ${source} · url: ${url}`);
  return lines.join('\n');
}
