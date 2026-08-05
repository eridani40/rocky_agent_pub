/**
 * builtin rocky_context plugin — system_prompt_mapper: context_files
 * 参考: specs/tech/agent/context/[P0]extension point and implementations.md §3.4
 *       specs/tech/agent/context/[P0]system_prompt.md §4（context_files / context tier）
 *       specs/tech/agent/context/[P0]prompt_content_files.md §4 §7.7（委托 ContextFilesHandler）
 *       specs/prd/overall/13-agent-definition.md §13.2.2（团队 + 个人两级注入）
 *
 * 职责：贡献项目上下文片段（context tier）。读文件逻辑在 ContextFilesHandler
 * （CANDIDATE_FILES / MAX_FILE_CHARS / readFirst / readPersonalFile 全在 handler），
 * mapper 仅做 cwd 解析 + studio leader/mate 个人差异文件后缀扫描 + 委托 handler.build。
 * 路径来源：config.workdir（SessionConfig 实际字段；spec §4 写「config.cwd」= cwd 同义）。
 * 文件不存在 / 无 cwd → 返回空数组（不报错；project 可能无 AGENTS.md）。
 *
 * 两级注入（v0.0.232）：studio leader/mate 且 memberId 存在时，扫
 * `{cwd}/.rocky/agents/*-{memberId}.md`（后缀锚 = memberId ULID 不变量，防 member 改名断链），
 * 命中 → 传 personalContextFile 给 handler（团队段在前、个人段在后叠加注入）。
 * 非 studio leader·mate / 无 memberId → 维持单份读取（academy/playground 不回归）。
 *
 * EP: system_prompt_mapper，priority 400，tier=context。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { ContextFilesHandler } from '../../../../server/src/prompts/handlers/context-files-handler';

/**
 * context_files mapper：委托 ContextFilesHandler 读项目根 AGENTS.md/CLAUDE.md
 * （+ studio leader/mate 个人差异文件）→ 包 fragment。
 * 找不到文件 / 无 cwd → 返回空数组（不报错）。
 */
export default class ContextFilesMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    const cwd = resolveCwd(ctx);
    if (!cwd) return [];
    // studio leader/mate 且 memberId 存在 → 扫个人差异文件（其余 kind 单份读取不回归）
    const memberId = resolveStudioMemberId(ctx);
    const personalContextFile = memberId
      ? (findPersonalAgentsFile(cwd, memberId) ?? undefined)
      : undefined;
    const content = new ContextFilesHandler().build({ cwd, personalContextFile }).content;
    if (!content) return [];
    return [
      {
        id: 'context_files',
        tier: 'context',
        content,
        priority: 400,
      },
    ];
  }
}

/** 从 ctx.config 取 cwd（workdir 字段优先，cwd 字段次之；duck-typed） */
function resolveCwd(ctx: PromptCtx): string | null {
  const c = ctx.config as { workdir?: unknown; cwd?: unknown };
  const wd = typeof c.workdir === 'string' ? c.workdir : null;
  if (wd) return wd;
  const cwd = typeof c.cwd === 'string' ? c.cwd : null;
  return cwd;
}

/**
 * studio leader/mate 的 memberId（duck-typed；非该 kind / 无 memberId → null）。
 * memberId 读 sessionContext（v0.0.204 实例 ID 投影），顶层 legacy 字段兜底。
 */
function resolveStudioMemberId(ctx: PromptCtx): string | null {
  const c = ctx.config as {
    kind?: { biz?: unknown; role?: unknown };
    sessionContext?: { memberId?: unknown };
    memberId?: unknown;
  };
  const kind = c.kind;
  if (!kind || kind.biz !== 'studio') return null;
  if (kind.role !== 'leader' && kind.role !== 'mate') return null;
  const fromCtx = c.sessionContext?.memberId;
  if (typeof fromCtx === 'string' && fromCtx) return fromCtx;
  const legacy = c.memberId;
  return typeof legacy === 'string' && legacy ? legacy : null;
}

/**
 * 扫 `{cwd}/.rocky/agents/` 下 `*-{memberId}.md` 后缀匹配的个人差异文件（纯函数 helper）。
 * 后缀锚 = memberId（ULID 不变量，防 member 改名断链）；命中返回绝对路径。
 * 目录不存在 / 读失败 / 无命中 → null。agent_profile mapper 复用本 helper 判「已配置」。
 */
export function findPersonalAgentsFile(cwd: string, memberId: string): string | null {
  try {
    const dir = path.join(cwd, '.rocky', 'agents');
    if (!fs.existsSync(dir)) return null;
    const suffix = `-${memberId}.md`;
    const hit = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(suffix))
      .sort()[0];
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}
