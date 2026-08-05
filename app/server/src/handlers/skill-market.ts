/**
 * skill 市场 HTTP handlers（/skills/market/*）—— 给未来 UI 的后端接口
 * 参考: specs/tech/agent/skills/[P1]skill_market.md §9
 *       specs/tech/version_logs/v0.0.166.skill_market/change_plan.md 模块 ⑥
 *
 * 4 个端点（全部先经 resolveSkillMarketProvider 取 exclusive 生效市场源，无 active → 503）：
 *   - GET  /skills/market/capabilities            → { id, label, capabilities }（UI 能力协商）
 *   - GET  /skills/market/search?q=&owner=&limit=&cursor=  → provider.search → 200 JSON
 *   - GET  /skills/market/detail?ref=<provider ref>       → provider.getDetail → 200 JSON（ref 走 query，含 /）
 *   - POST /skills/market/install  body {ref,scope?}       → fetchSkillFiles → stageAndInstallFiles → 202 SkillEntry
 *
 * handler 与 tool action（skill-market/actions.ts）共用 resolveSkillMarketProvider：handler 侧无 ToolCtx，
 * 构造等价 `{ config: { pluginManager, appConfig } }` 鸭子类型传入（resolve 只吃这两个字段）。
 * install 校验/落盘/治理走 installer source-无关核心（不变量#2/#4：协议不含 install，治理 evolvable=false
 * + productionMethod='download' 由核心硬编码）；InstallError → 状态码映射。
 */
import type { AppConfigService } from '../config/app-config-service';
import type { PluginManager } from '../plugin/plugin-manager';
import type { ToolCtx } from '../tools/types';
import { resolveSkillMarketProvider } from '../tools/skill-market/resolve';
import { InstallError, stageAndInstallFiles } from '../skills/installer';
import type {
  SkillMarketCfg,
  SkillMarketProvider,
  SkillMarketSearchOptions,
} from '../tools/skill-market/types';

/** ref 形状：`{owner}/{repo}/{slug}` 三段，每段仅字母数字与 . _ -（通用前置守卫；provider 内再做权威校验） */
const REF_SHAPE_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** 构造 JSON Response */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** InstallError.code → HTTP 状态码（对齐 handlers/skill.ts installStatus） */
function installStatus(code: InstallError['code']): number {
  switch (code) {
    case 'bad_request':
      return 400;
    case 'conflict':
      return 409;
    case 'workspace_not_found':
      return 404;
    case 'too_large':
      return 413;
  }
}

/** handler 侧构造等价 ToolCtx 复用 resolveSkillMarketProvider（只吃 config.pluginManager + config.appConfig） */
function resolveProvider(
  appConfig: AppConfigService,
  pluginManager: PluginManager,
): { provider?: SkillMarketProvider; cfg: SkillMarketCfg } {
  const ctx = { config: { pluginManager, appConfig } } as unknown as ToolCtx;
  return resolveSkillMarketProvider(ctx);
}

/**
 * 分发 /skills/market/* 路由。先解析 exclusive 生效市场源，无 active → 503（所有端点统一门槛）。
 * @param req 原始 Request（install 读 body）
 * @param method HTTP method（大写）
 * @param path pathname
 * @param url URL（query 透传）
 * @param appConfig app_config 服务（凭证路由）
 * @param pluginManager 插件管理器（取 EP active impl）
 * @param dataDir app 数据根（install 落盘）
 */
export async function handleSkillMarketRoute(
  req: Request,
  method: string,
  path: string,
  url: URL,
  appConfig: AppConfigService,
  pluginManager: PluginManager,
  dataDir: string,
): Promise<Response> {
  try {
    const { provider, cfg } = resolveProvider(appConfig, pluginManager);
    if (!provider) {
      return json(503, { error: 'no skill market provider configured (skill_market group not selected)' });
    }

    if (method === 'GET' && path === '/skills/market/capabilities') {
      return handleMarketCapabilities(provider);
    }
    if (method === 'GET' && path === '/skills/market/search') {
      return await handleMarketSearch(url, provider, cfg);
    }
    if (method === 'GET' && path === '/skills/market/detail') {
      return await handleMarketDetail(url, provider, cfg);
    }
    if (method === 'POST' && path === '/skills/market/install') {
      return await handleMarketInstall(req, provider, cfg, dataDir);
    }
    return json(404, { error: 'Not Found' });
  } catch (e) {
    if (e instanceof InstallError) return json(installStatus(e.code), { error: e.message });
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { error: msg });
  }
}

/** GET /skills/market/capabilities → 当前生效 provider 的 { id, label, capabilities }（UI 据此协商渲染/传参） */
function handleMarketCapabilities(provider: SkillMarketProvider): Response {
  return json(200, {
    id: provider.id,
    label: provider.label,
    capabilities: provider.capabilities,
  });
}

/** GET /skills/market/search?q=&owner=&limit=&cursor= → provider.search → 200（只传 provider 认的能力门控参数） */
async function handleMarketSearch(
  url: URL,
  provider: SkillMarketProvider,
  cfg: SkillMarketCfg,
): Promise<Response> {
  const query = (url.searchParams.get('q') ?? '').trim();
  if (!query) return json(400, { error: 'q is required' });

  const opts: SkillMarketSearchOptions = {};
  const owner = url.searchParams.get('owner');
  if (owner && owner.trim()) opts.owner = owner.trim();
  const limitRaw = url.searchParams.get('limit');
  if (limitRaw) {
    const n = Number(limitRaw);
    if (Number.isFinite(n) && n > 0) opts.limit = Math.floor(n);
  }
  const cursor = url.searchParams.get('cursor');
  if (cursor) opts.cursor = cursor;

  const result = await provider.search(query, opts, cfg);
  return json(200, result);
}

/** GET /skills/market/detail?ref=<provider ref> → provider.getDetail → 200（ref 含 / 走 query，不走路径段） */
async function handleMarketDetail(
  url: URL,
  provider: SkillMarketProvider,
  cfg: SkillMarketCfg,
): Promise<Response> {
  const ref = (url.searchParams.get('ref') ?? '').trim();
  if (!ref) return json(400, { error: 'ref is required' });
  const detail = await provider.getDetail(ref, cfg);
  return json(200, detail);
}

/**
 * POST /skills/market/install  body {ref,scope?,overwrite?} → 202 SkillEntry。
 * 先做 ref 形状守卫（owner/repo/slug，非法 → 400）→ provider.fetchSkillFiles 取文件 →
 * installer.stageAndInstallFiles 落 app scope（治理由核心硬编码 + v0.0.167 写来源三元数据
 * market_ref/market_source/installed_hash）。market 安装仅支持 app scope。
 * v0.0.167：body.overwrite=true 触发同源更新重装（同源守卫在 finalizeStagedSkill，读磁盘 frontmatter）。
 */
async function handleMarketInstall(
  req: Request,
  provider: SkillMarketProvider,
  cfg: SkillMarketCfg,
  dataDir: string,
): Promise<Response> {
  let body: { ref?: unknown; scope?: unknown; overwrite?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
  if (!ref) return json(400, { error: 'ref is required' });
  if (!REF_SHAPE_RE.test(ref)) {
    return json(400, { error: `invalid skill ref "${ref}" (expected owner/repo/slug)` });
  }
  // market 安装落 app scope（治理 evolvable=false + productionMethod='download' 由 installer 核心硬编码）
  if (body.scope !== undefined && body.scope !== 'app') {
    return json(400, { error: 'only app scope is supported for market install' });
  }
  // v0.0.167：overwrite=true 触发同源更新重装（仅当磁盘同名 skill 的 market_ref===本次 ref 才覆盖，
  // 由 finalizeStagedSkill 守卫，读磁盘 frontmatter 不信前端）；默认 false=保持 409 语义。
  const overwrite = body.overwrite === true;

  // 1. provider 取文件（source-specific；ref 权威格式/防注入由 provider 内再校验）
  const fetched = await provider.fetchSkillFiles(ref, cfg);
  // 2. installer source-无关核心落盘：透传 overwrite + 写来源三元数据（market_ref/market_source/installed_hash）。
  //    InstallError（conflict 等）→ 外层 catch 映射状态码（invariant#7：成功仍 202 {skill}）。
  const { entry } = stageAndInstallFiles(
    fetched.files,
    dataDir,
    { scope: 'app', overwrite },
    { marketRef: ref, marketSource: provider.id, installedHash: fetched.hash },
  );
  return json(202, { skill: entry });
}
