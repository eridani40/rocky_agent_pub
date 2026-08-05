/**
 * builtin rocky_context plugin — system_prompt_mapper: rules
 * 参考: specs/tech/agent/context/[P0]extension point and implementations.md §3.4
 *       specs/tech/agent/context/[P0]system_prompt.md §4（rules / stable tier）
 *       specs/tech/agent/context/[P0]prompt_content_files.md §4（委托 RulesHandler）
 *
 * 职责：贡献行为规则片段（stable tier）。v0.0.22 起正文来源改为委托 RulesHandler
 * 读 prompts/content/rules.md（3 section：Operating Rules / Doing Tasks / Tool Use）。
 * - [v0.0.33.3 step2 迁移] studio 三 scope（leader/mate/squad）返空：角色规则迁到 squad_role
 *   mapper（content fragment，含 mate 不创建 task / leader 不直接编码 / SquadChat 永不创作 等角色规则
 *   + 协作规则 + 工具↔OKF 关系），不再委托通用 rules.md（避免与 squad_role content 重复）。
 *   standalone/subagent 不变（继续落通用 rules.md）。
 * EP: system_prompt_mapper，priority 800，tier=stable。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { RulesHandler } from '../../../../server/src/prompts/handlers/rules-handler';
import { readSessionType } from './squad_reminder_shared';

/**
 * rules mapper：按 sessionType 分流取 content → 包 PromptFragment。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4）。
 */
export default class RulesMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    // v0.0.33.3 step2：studio 三 scope（leader/mate/squad）返空（squad_role mapper 接管角色规则）
    const sessionType = readSessionType(ctx);
    if (sessionType === 'leader' || sessionType === 'mate' || sessionType === 'squad') {
      return [
        {
          id: 'rules',
          tier: 'stable',
          content: '',
          priority: 800,
        },
      ];
    }
    // standalone / subagent → 委托通用 rules.md（不变）
    const content = new RulesHandler().build({}).content;
    return [
      {
        id: 'rules',
        tier: 'stable',
        content,
        priority: 800,
      },
    ];
  }
}

