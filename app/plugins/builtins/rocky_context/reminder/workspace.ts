/**
 * builtin rocky_context plugin — system_reminder provider: workspace
 * 参考: specs/tech/agent/context/[P0]extension point and implementations.md §3.6
 *       specs/tech/agent/context/[P0]system_reminder.md §3（workspace provider）
 *
 * 职责：贡献 workspace reminder（工作目录 + 绝对路径引导）。
 * 来源：config.workdir（**[v0.0.17] = session.workspaceDir**，由 loop 构造 SessionConfig 时接线注入，
 *   见 specs/tech/agent/session/[P0]session_workspace.md §1 + handlers/session-config.ts）。
 * 无 workdir → 空贡献（不报错）。
 * [v0.0.254] 移除 git branch 段（tryGitBranch 同步 execSync 起子进程，prod 卡顿元凶；git 信息无用）。
 * EP: system_reminder，priority 700。
 *
 * [v0.0.17] 零破 cache：workspace 路径稳定时 reminder 内容稳定（prompt cache 友好）；
 *   切换 workspaceDir 后下一轮 ingest 自动反映新路径（无需重启 session）。
 */
import * as path from 'node:path';
import {
  ContextImplBase,
  type ReminderCtx,
  type SystemReminder,
  type SystemReminderProvider,
} from '../types';

/**
 * workspace provider：聚合工作目录 + git 状态为单条 reminder。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4）。
 */
export default class WorkspaceReminderProvider
  extends ContextImplBase
  implements SystemReminderProvider
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  provide(ctx: ReminderCtx): SystemReminder[] {
    const wd = resolveWorkdir(ctx);
    if (!wd) return [];
    // 引导 LLM：file/bash 工具一律用绝对路径，基于此工作目录（代码已 isAbsolute 拒绝相对路径）
    // [v0.0.254] 去掉 git branch 段：tryGitBranch 用同步 execSync 起 git 子进程，
    //   每轮 ingest 在主线程干等，是 prod 卡顿元凶之一；且 git 信息对 agent 无实际用处（用户裁决）。
    const parts = [
      `Working directory: ${wd}`,
      'file/bash tools require absolute paths based on this working directory',
    ];
    return [
      {
        id: 'workspace',
        tier: 'info',
        content: parts.join(', ') + '.',
      },
    ];
  }
}

/**
 * 取 workdir —— 仅读 config.workdir（[v0.0.17] = session.workspaceDir，持久化真相源）。
 * 不再回退 cwd/环境默认值（spec §3 明确来源单一为 config.workdir）。
 * workdir 缺 → null（provider 空贡献）。
 */
function resolveWorkdir(ctx: ReminderCtx): string | null {
  const wd = (ctx.config as { workdir?: unknown }).workdir;
  return typeof wd === 'string' && wd.length > 0 ? path.resolve(wd) : null;
}
