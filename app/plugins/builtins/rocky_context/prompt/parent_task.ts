/**
 * builtin rocky_context plugin — system_prompt_mapper: parent_task
 * 参考: specs/tech/version_logs/v0.0.33.2/change_log.md §2.D 改动2 + §2.K（subagent 迁统一框架）
 *       specs/tech/squad/[P1]prompt_sections.md §2（Option A 分流）+ §3 + §4.3（数据源）
 *       specs/tech/multi_agent/[P1]subagent_derivation.md §4（spawn 入参 task）
 *
 * 职责：贡献 parent task 片段（stable tier）。Option A 分流：subagent only —— subagent 是 forked
 * agent 干一次性子活，parent_task 给它「为什么被派出来」的上下文；其他 4 scope 不贡献
 *（mate 有 tasks section；leader/squad 不派自己出来）。D9 配套：与 identity D9 修共同支撑
 * subagent 迁统一 prompt builder。
 *
 * 数据源：spawn 时入参 task（SpawnAgentInput.task.content）→ 持久化进 SessionConfig 扩字段
 *（spec §4.3 实现注意：持久化字段名由 T2 在 subAgentConfig 扩字段时定）。mapper duck-typed
 * 读 config.parentTask；T2 持久化就位后自动接通，未就位 → 不贡献（不阻塞）。
 * EP: system_prompt_mapper，priority 700，tier=stable。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { readSessionType } from './squad_reminder_shared';

/**
 * parent_task mapper：sessionType !== 'subagent' → []；否则读 config.parentTask 渲染。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4）。
 */
export default class ParentTaskMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    // Option A 分流：subagent only
    const sessionType = readSessionType(ctx);
    if (sessionType !== 'subagent') return [];
    const task = readParentTask(ctx);
    if (!task) return [];
    const content = `## Parent Task\n\nYou were spawned by your parent agent to handle the following task:\n\n${task}`;
    return [
      {
        id: 'parent_task',
        tier: 'stable',
        content,
        priority: 700,
      },
    ];
  }
}


/**
 * duck-typed 读 spawn 入参 task（持久化字段名由 T2 定，本 mapper 兼容多种命名）。
 * 参考 subagent_derivation §4：spawn 入参 task.content 为任务正文 string。
 */
function readParentTask(ctx: PromptCtx): string | null {
  const cfg = ctx.config as { parentTask?: unknown; subAgentTask?: unknown };
  const candidates = [cfg.parentTask, cfg.subAgentTask];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
    // 兼容 { content: string } 形态（SpawnAgentInput.task）
    if (c && typeof c === 'object') {
      const content = (c as { content?: unknown }).content;
      if (typeof content === 'string' && content.trim()) return content.trim();
    }
  }
  return null;
}
