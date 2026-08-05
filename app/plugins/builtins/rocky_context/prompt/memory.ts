/**
 * builtin rocky_context plugin — system_prompt_mapper: memory_user + memory_session + memory_group
 * 参考: specs/tech/agent/memory/[P0]memory_injection.md §2/§3（L0 注入 + 读源表）
 *       specs/tech/agent/context/[P0]system_prompt.md §4（memory_user=stable / memory_session=context / memory_group=stable）
 *       specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A4（dir store 三源 + group 改名）
 *
 * 职责：贡献 memory 的 **L0 索引片段**（name + intro，不整文件注入正文）：
 *   - memory_user（`<dataDir>/memory/`）→ tier=stable，priority 450（跨 session 稳定，cache 友好）
 *   - memory_session（`<sessionWs>/.rocky/memory/`）→ tier=context，priority 350
 *   - memory_group（`<groupWs>/.rocky/memory/`，squad 共享）→ tier=stable，priority 400
 * L0 注入（不变量#5）：mapper 只注入 name+intro，正文经 `memory` 纯读工具按需读（L1）。
 *
 * 三源协同：三 mapper 各自读三源（global + session + group）后调同一 selectMemoriesByQuota
 *   得同一分层划分 `{global, session, group}`，各自只输出本 scope 切片。group 依赖缺失
 *   （无 squadId）→ group 源空 → memory_group mapper 空贡献 fragment（正确行为）。
 *
 * 分层配额：各 scope 独立计数独立截断（session ≤20 / group ≤30 / global ≤50，
 *   app_config session group 三 key 覆盖：maxMemoryInject→global / maxMemoryInjectGroup→group
 *   / maxMemoryInjectSession→session），覆盖旧「三源共享统一 maxMemoryInject」语义。
 *
 * EP: system_prompt_mapper。文件含三个 mapper 类；memory-user.ts / memory-session.ts / memory-group.ts
 *   均为 1 行 default re-export（manifest 一 impl 一 default 约定）。
 */
import {
  ContextImplBase,
  type PromptCtx,
  type PromptFragment,
  type SystemPromptMapper,
} from '../types';
import {
  globalMemoryDir,
  listMetas,
  wsMemoryDir,
  type MemoryEntryMeta,
} from '../../../../server/src/memory/memory-dir-store';
import {
  selectMemoriesByQuota,
  type MemoryEntryRow,
  type MemoryInjectQuotas,
} from '../../../../server/src/memory/inject-quota';
import { resolveGroupWsDir } from '../../../../server/src/agent/group-dir';
import type { AppConfigService } from '../../../../server/src/config/app-config-service';

/** 分层注入配额缺失时的默认值（app_config §3.14 可选覆盖调参组；分层 20/30/50） */
const DEFAULT_MEMORY_QUOTAS: MemoryInjectQuotas = { global: 50, group: 30, session: 20 };

// —— 共享 helpers ——

/** 从 ctx.config 取 dataDir（global/group memory 路径基；缺省 → null） */
function resolveDataDir(ctx: PromptCtx): string | null {
  const d = (ctx.config as { dataDir?: unknown }).dataDir;
  return typeof d === 'string' && d ? d : null;
}

/**
 * 从 ctx.config 取 workdir（session memory 介质定位 = session ws；缺省 → null）。
 * workdir 由 buildSessionConfigFromDeps 注入（session.workspaceDir，缺省回退 <dataDir>/workspace）。
 */
function resolveWorkdir(ctx: PromptCtx): string | null {
  const w = (ctx.config as { workdir?: unknown }).workdir;
  return typeof w === 'string' && w ? w : null;
}

/**
 * 从 ctx.config 解析 group ws 根（squadId；缺省 → null）。
 * 无 group 依赖 → memory_group mapper 空贡献 fragment（正确行为，不阻塞其他 mapper）。
 */
function resolveGroupWs(ctx: PromptCtx, dataDir: string): string | null {
  const squadId = (ctx.config as { squadId?: unknown }).squadId;
  const ws = resolveGroupWsDir(dataDir, {
    ...(typeof squadId === 'string' && squadId ? { squadId } : {}),
  });
  return ws ?? null;
}

/**
 * 从 ctx.config 取 AppConfigService（maxMemoryInject 配额读源；缺省 → null）。
 */
function resolveAppConfig(ctx: PromptCtx): AppConfigService | null {
  const ac = (ctx.config as { appConfig?: unknown }).appConfig;
  if (
    ac &&
    typeof ac === 'object' &&
    typeof (ac as { get?: unknown }).get === 'function' &&
    typeof (ac as { set?: unknown }).set === 'function'
  ) {
    return ac as AppConfigService;
  }
  return null;
}

/** L0 末尾读正文引导（对齐 skill catalog；引导 agent 用 memory 工具按需读全文） */
const L0_READ_HINT = "Use the `memory` tool to read a memory's full body by name.";

/** meta 投影 → 配额行（name/intro/source/updatedAt） */
function toRow(m: MemoryEntryMeta): MemoryEntryRow {
  return { name: m.name, intro: m.intro, source: m.source, updatedAt: m.updatedAt };
}

/**
 * 读三源（三源协同保三 mapper 同输入同输出）。
 * 任一源缺依赖（dataDir / workdir / group ws 未注入）→ 该源空，不影响其他源。
 * global 源 = `<dataDir>/memory/`；session 源 = `<workdir>/.rocky/memory/`；group 源 = `<groupWs>/.rocky/memory/`。
 *
 * v0.0.232 同址去重：squad session 删个人 ws 后 workdir == groupWs（都指向
 * `squads/{sid}/`）→ session 源与 group 源物理同目录。此时跳过 session 源（session=[]），
 * 同址目录只经 group 源读一次，避免 memory_session + memory_group 双注入同一批条目。
 * 写侧 resolveScopeDir / query.ts 自然同址（跨 scope search 不含 group）——本处不动写侧。
 */
function readMemorySources(
  ctx: PromptCtx,
): { global: MemoryEntryRow[]; session: MemoryEntryRow[]; group: MemoryEntryRow[] } {
  const global: MemoryEntryRow[] = [];
  const session: MemoryEntryRow[] = [];
  const group: MemoryEntryRow[] = [];

  const dataDir = resolveDataDir(ctx);
  if (dataDir) {
    for (const m of listMetas(globalMemoryDir(dataDir))) {
      if (!m.archived) global.push(toRow(m));
    }

    const groupWs = resolveGroupWs(ctx, dataDir);
    const workdir = resolveWorkdir(ctx);
    // 同址去重：workdir === groupWs（路径字符串相等，两边都经 resolveGroupWsDir 同 helper 产出无
    // trailing slash 分歧）→ 跳过 session 源，团队目录只经 group 源读一次。存量旧 session
    // （workdir≠groupWs）行为不变，session 源照常读。
    if (workdir && workdir !== groupWs) {
      for (const m of listMetas(wsMemoryDir(workdir))) {
        if (!m.archived) session.push(toRow(m));
      }
    }

    if (groupWs) {
      for (const m of listMetas(wsMemoryDir(groupWs))) {
        if (!m.archived) group.push(toRow(m));
      }
    }
  }

  return { global, session, group };
}

/**
 * 从 ctx 读 memory 分层注入配额（app_config session group，分层 20/30/50）。
 * key 语义：maxMemoryInject → global 层（旧「三源总量」key 语义转为 global 层）；
 *   maxMemoryInjectGroup → group 层；maxMemoryInjectSession → session 层。
 * 缺失（无 appConfig / 无 session record / 字段非 number）→ 各层独立回退 20/30/50。
 * 与 skills.ts resolveSkillQuotas 同模式。
 */
function resolveMemoryQuotas(ctx: PromptCtx): MemoryInjectQuotas {
  const appConfig = resolveAppConfig(ctx);
  if (!appConfig) return { ...DEFAULT_MEMORY_QUOTAS };
  const session = appConfig.get('session', 'default');
  if (!session || typeof session !== 'object') return { ...DEFAULT_MEMORY_QUOTAS };
  const rec = session as {
    maxMemoryInject?: unknown;
    maxMemoryInjectGroup?: unknown;
    maxMemoryInjectSession?: unknown;
  };
  return {
    global:
      typeof rec.maxMemoryInject === 'number' && Number.isFinite(rec.maxMemoryInject)
        ? rec.maxMemoryInject
        : DEFAULT_MEMORY_QUOTAS.global,
    group:
      typeof rec.maxMemoryInjectGroup === 'number' && Number.isFinite(rec.maxMemoryInjectGroup)
        ? rec.maxMemoryInjectGroup
        : DEFAULT_MEMORY_QUOTAS.group,
    session:
      typeof rec.maxMemoryInjectSession === 'number' && Number.isFinite(rec.maxMemoryInjectSession)
        ? rec.maxMemoryInjectSession
        : DEFAULT_MEMORY_QUOTAS.session,
  };
}

/**
 * 格式化 entries 为 **L0 注入** content string（name + intro）。
 * 只输出 header + `- <name>: <intro>` 列表 + 末尾读正文引导；
 * **不输出 body/why/howToApply**（不变量#5：注入只 L0，正文按需读）。
 * 空 → 返空串（caller 据此不贡献 fragment）。
 */
function formatL0(
  entries: Array<{ name: string; intro: string }>,
  header: string,
): string {
  if (entries.length === 0) return '';
  const lines: string[] = [header, ''];
  for (const entry of entries) {
    const summary = entry.intro ? `: ${entry.intro}` : '';
    lines.push(`- ${entry.name}${summary}`);
  }
  lines.push('', L0_READ_HINT);
  return lines.join('\n');
}

// —— memory_user mapper（`<dataDir>/memory/` → stable tier） ——

/**
 * memory_user mapper：global memory（`<dataDir>/memory/`）→ tier=stable fragment（priority 450）。
 * stable tier 不被 budget_truncate 裁（memory_injection §5），保 L0 索引完整注入。
 * 读三源 → 调 selectMemoriesByQuota → 输出 global 切片。
 */
export class MemoryUserMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    const { global, session, group } = readMemorySources(ctx);
    if (global.length === 0 && session.length === 0 && group.length === 0) return [];
    const quotas = resolveMemoryQuotas(ctx);
    const { global: selected } = selectMemoriesByQuota(global, session, group, quotas);
    const content = formatL0(selected, '# Long-term User Memory');
    if (!content) return [];
    return [{ id: 'memory_user', tier: 'stable', content, priority: 450 }];
  }
}

// —— memory_session mapper（session ws per-entry md → context tier） ——

/**
 * memory_session mapper：`<sessionWs>/.rocky/memory/` → tier=context fragment（priority 350）。
 * 读三源 → 调同一 selectMemoriesByQuota → 输出 session 切片。
 */
export class MemorySessionMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    const { global, session, group } = readMemorySources(ctx);
    if (global.length === 0 && session.length === 0 && group.length === 0) return [];
    const quotas = resolveMemoryQuotas(ctx);
    const { session: selected } = selectMemoriesByQuota(global, session, group, quotas);
    const content = formatL0(selected, '# Session Memory');
    if (!content) return [];
    return [{ id: 'memory_session', tier: 'context', content, priority: 350 }];
  }
}

// —— memory_group mapper（group ws per-entry md → stable tier） ——

/**
 * memory_group mapper：`<groupWs>/.rocky/memory/`（squad 共享）→ tier=stable fragment（priority 400）。
 * stable tier 与 memory_user 同（group memory 在团队会话内相对稳定，跨 session 保 cache 友好）。
 * 无 group 依赖（非 squad 会话）→ 空 group 源 → mapper 空贡献 fragment（正确行为）。
 * 读三源 → 调同一 selectMemoriesByQuota → 输出 group 切片。
 */
export class MemoryGroupMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    const { global, session, group } = readMemorySources(ctx);
    if (global.length === 0 && session.length === 0 && group.length === 0) return [];
    const quotas = resolveMemoryQuotas(ctx);
    const { group: selected } = selectMemoriesByQuota(global, session, group, quotas);
    const content = formatL0(selected, '# Group Memory');
    if (!content) return [];
    return [{ id: 'memory_group', tier: 'stable', content, priority: 400 }];
  }
}
