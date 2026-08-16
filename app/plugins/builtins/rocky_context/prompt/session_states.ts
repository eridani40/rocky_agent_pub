/**
 * builtin rocky_context plugin — system_prompt_mapper: session_states（v0.0.361 NEW）
 * 参考: specs/tech/version_logs/v0.0.361/change_plan.md §1.1/§1.6/§1.7（静态半迁移）
 *       specs/tech/agent/context_and_memory/[P0]system_prompt.md（mapper 契约）
 *
 * 职责：session states 静态段——env / workspace / 团队盘路径三小节进 system prompt（tier=stable，
 * run 间字节稳定进缓存段）。渲染逻辑自三个退役 reminder provider 平移（输出行文等价，平移非重写）：
 *   - env：reminder/env.ts → `Environment: app=..., platform=..., model=...`
 *   - workspace：reminder/workspace.ts → `Working directory: ..., file/bash tools require absolute paths...`
 *   - squad_workspace：reminder/squad_workspace.ts → `Team workspace: {dataDir}/squads/{squadId}`（leader/mate）
 * member 名单静态半由既有 team_roster mapper 承载（零改动，不重复渲染）。
 * 不拼装动态项（task/todo/member 状态走 reminder 体系）。
 *
 * 数据源（与原 provider 相同）：process.env.APP_ENV + os.platform + config.modelId /
 * config.workdir / config.{dataDir,squadId}。缺项跳过；全缺 → 空贡献。
 * 构建时机不变（session 启动 / summary 重建），run 间稳定 → prompt cache 命中。
 * EP: system_prompt_mapper，priority 810，tier=stable（rules 之后，squad_role 之前）。
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { readSessionType } from './squad_reminder_shared';

/**
 * session_states mapper：env / workspace / 团队盘路径静态三小节 → system prompt 稳定段。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4）。
 */
export default class SessionStatesMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    const lines = [renderEnv(ctx), renderWorkspace(ctx), renderSquadWorkspace(ctx)].filter(
      (l): l is string => l !== null,
    );
    if (lines.length === 0) return [];
    return [
      {
        id: 'session_states',
        tier: 'stable',
        content: `## Session States\n\n${lines.map((l) => `- ${l}`).join('\n')}`,
        priority: 810,
      },
    ];
  }
}

/** env 小节（平移自 reminder/env.ts provide）：进程 env + 平台 + 模型 */
function renderEnv(ctx: PromptCtx): string | null {
  const appEnv = (process.env.APP_ENV ?? 'dev').trim() || 'dev';
  const platform = os.platform();
  const model = ctx.config.modelId ?? 'unknown';
  return `Environment: app=${appEnv}, platform=${platform}, model=${model}.`;
}

/** workspace 小节（平移自 reminder/workspace.ts provide）：工作目录 + 绝对路径引导；无 workdir → 跳过 */
function renderWorkspace(ctx: PromptCtx): string | null {
  const wd = (ctx.config as { workdir?: unknown }).workdir;
  if (typeof wd !== 'string' || wd.length === 0) return null;
  const resolved = path.resolve(wd);
  // 引导行平移：file/bash 工具一律用绝对路径（代码已 isAbsolute 拒绝相对路径）
  return `Working directory: ${resolved}, file/bash tools require absolute paths based on this working directory.`;
}

/** 团队盘路径小节（平移自 reminder/squad_workspace.ts provide）：leader/mate 才有；任一缺 → 跳过 */
function renderSquadWorkspace(ctx: PromptCtx): string | null {
  // 角色 filter：leader + mate（standalone/subagent 无 squadId 天然跳过）
  const sessionType = readSessionType(ctx);
  if (sessionType !== 'leader' && sessionType !== 'mate') return null;

  const cfg = ctx.config as { dataDir?: unknown; squadId?: unknown };
  const dataDir = cfg.dataDir;
  const squadId = cfg.squadId;
  if (typeof dataDir !== 'string' || dataDir.length === 0) return null;
  if (typeof squadId !== 'string' || squadId.length === 0) return null;

  // 团队根 = <dataDir>/squads/<squadId>（等价 squad-store.ts squadRootDir）
  return `Team workspace: ${path.join(dataDir, 'squads', squadId)}`;
}
