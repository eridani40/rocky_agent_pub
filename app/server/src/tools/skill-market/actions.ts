/**
 * skill 市场 tool action —— search / install 执行 + 结果序列化（v0.0.166）
 * 参考: specs/tech/agent/skills/[P1]skill_market.md §5/§6/§7；change_plan v0.0.166 模块 ④
 *
 * skill_manage 工具的 search/install 两 action 委派到本文件（create/patch/... 6 action 在
 * skill-manage-actions.ts）。两者都先经 resolveSkillMarketProvider 拿到 exclusive 生效市场源：
 *   - search：provider.search → serializeMarketResult 成 markdown → textResult。
 *   - install：校验 ref 形状 → provider.fetchSkillFiles 取文件 → installer.stageAndInstallFiles
 *     落 app scope（治理 evolvable=false / productionMethod='download' 由 installer 核心硬编码）。
 *
 * 不变量：无 active provider → errorResult（不静默回退）；缺字段（description/stats）不造假、不报错。
 */
import type { ToolCtx, ToolInput, ToolRunResult } from '../types';
import { errorResult, textResult, ToolErrorCode } from '../types';
import { stageAndInstallFiles } from '../../skills/installer';
import { resolveSkillMarketProvider } from './resolve';
import type { SkillMarketSearchOptions, SkillMarketSearchResult } from './types';

/** ref 形状：`{owner}/{repo}/{slug}` 三段，每段仅字母数字与 . _ -（防路径遍历/注入的通用前置守卫） */
const REF_SHAPE_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * executeMarketSearch：搜索市场并序列化为 markdown。
 * 无 active provider / 不可用 → errorResult（不回退到本地或其他源）。
 */
export async function executeMarketSearch(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
  const query = String(input.query ?? '').trim();
  if (!query) return errorResult(`[${ToolErrorCode.INVALID_INPUT}] query is required for search`);

  const { provider, cfg } = resolveSkillMarketProvider(ctx);
  if (!provider) {
    return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] no skill market provider configured (skill_market group not selected)`);
  }
  if (!provider.isAvailable(cfg)) {
    return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] skill market provider ${provider.label} unavailable`);
  }

  // 只传 provider 声明支持的参数（skills.sh 仅认 owner/limit；其余能力门控参数缺省不传）
  const opts: SkillMarketSearchOptions = {};
  if (typeof input.owner === 'string' && input.owner.trim()) opts.owner = input.owner.trim();
  if (typeof input.limit === 'number' && input.limit > 0) opts.limit = Math.floor(input.limit);

  let result: SkillMarketSearchResult;
  try {
    result = await provider.search(query, opts, cfg, ctx.signal);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] skill market search failed: ${msg}`);
  }
  return textResult(serializeMarketResult(result));
}

/**
 * executeMarketInstall：从市场安装单个 skill 到 app scope。
 * 校验 ref 形状（owner/repo/slug）→ resolve provider → fetchSkillFiles → stageAndInstallFiles。
 * ref 非法 → INVALID_INPUT；无 provider → RUNTIME_ERROR；provider/落盘抛错 → 映射 error。
 */
export async function executeMarketInstall(
  input: ToolInput, ctx: ToolCtx, dataDir: string, _workdir: string | undefined,
): Promise<ToolRunResult> {
  const ref = String(input.ref ?? '').trim();
  if (!ref) return errorResult(`[${ToolErrorCode.INVALID_INPUT}] ref is required for install`);
  if (!REF_SHAPE_RE.test(ref)) {
    return errorResult(`[${ToolErrorCode.INVALID_INPUT}] invalid skill ref "${ref}" (expected owner/repo/slug)`);
  }

  const { provider, cfg } = resolveSkillMarketProvider(ctx);
  if (!provider) {
    return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] no skill market provider configured (skill_market group not selected)`);
  }
  if (!provider.isAvailable(cfg)) {
    return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] skill market provider ${provider.label} unavailable`);
  }

  // 1. provider 取文件（source-specific；ref 权威格式/防注入由 provider 内再校验）
  let fetched;
  try {
    fetched = await provider.fetchSkillFiles(ref, cfg, ctx.signal);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] fetch skill files failed: ${msg}`);
  }

  // 2. installer source-无关核心落盘（app scope；治理 evolvable=false + download 由核心硬编码）。
  //    v0.0.167：写来源三元数据（market_ref/market_source/installed_hash）与 HTTP 路径一致；
  //    但 agent 路径**不开放 overwrite**（省略=默认 false）——同名冲突仍 409，避免 agent 静默覆盖已装 skill。
  try {
    const { entry } = stageAndInstallFiles(
      fetched.files,
      dataDir,
      { scope: 'app' },
      { marketRef: ref, marketSource: provider.id, installedHash: fetched.hash },
    );
    return textResult(JSON.stringify({ ok: true, ref, skill: entry }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] install skill failed: ${msg}`);
  }
}

/**
 * 序列化 SkillMarketSearchResult 为 markdown。
 * 只渲染声明支持/存在的维度（capability negotiation）：每项固定 ref + name；
 * description / stats.installs 缺失则省略——不造假、不报错。
 */
export function serializeMarketResult(res: SkillMarketSearchResult): string {
  const lines: string[] = [];
  lines.push(`## Skills (provider: ${res.provider}, count: ${res.count})`);
  lines.push('');
  if (res.items.length === 0) {
    lines.push('（无结果）');
    return lines.join('\n');
  }
  res.items.forEach((item, i) => {
    const idx = i + 1;
    lines.push(`${idx}. **${item.name || '(no name)'}** \`${item.ref}\``);
    if (item.description) {
      lines.push(`   ${item.description.replace(/\n/g, ' ')}`);
    }
    if (typeof item.stats?.installs === 'number') {
      lines.push(`   installs: ${item.stats.installs}`);
    }
  });
  return lines.join('\n');
}
