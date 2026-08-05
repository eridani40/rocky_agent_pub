/**
 * builtin rocky_context plugin — system_prompt_mapper: identity
 * 参考: specs/tech/agent/context/[P0]extension point and implementations.md §3.4
 *       specs/tech/agent/context/[P0]system_prompt.md §4（identity / stable tier）
 *       specs/tech/agent/context/[P0]prompt_content_files.md §4（委托 IdentityHandler）
 *       specs/tech/version_logs/v0.0.33.2/change_log.md §2.D 改动1（D9 修）+ §2.K
 *       specs/tech/squad/[P1]prompt_sections.md §2（Option A 分流）
 *
 * 职责：贡献 agent 身份片段（stable tier）。
 * - [v0.0.22] 正文来源改为委托 IdentityHandler 读 prompts/content/identity.md。
 * - 按 config.sessionType 分流（Option A）——
 *   · standalone（!sessionType，bizType=playground + type 空）→ 委托 IdentityHandler 落 Rocky identity。
 *   · studio 三 scope（leader/mate/squad）→ 返空，身份正文由 squad_role mapper 注入（content fragment）。
 *   · subagent → 读 subAgentConfig.systemPrompt（explorer 模板人设），直接生效。
 *   修前 subagent 的 explorer 人设被 Rocky identity 覆盖（隐性 bug）；修后全 case 回归 PASS。
 * EP: system_prompt_mapper，priority 1000，tier=stable。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { IdentityHandler } from '../../../../server/src/prompts/handlers/identity-handler';
import { readSessionType } from './squad_reminder_shared';

/**
 * identity mapper：按 sessionType 分流取 content → 包 PromptFragment。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4）。
 */
export default class IdentityMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    // Option A 分流（v0.0.33.3 step2 迁移）：
    //   - standalone（!sessionType）→ Rocky identity（委托 IdentityHandler）
    //   - subagent → subAgentConfig.systemPrompt（explorer 模板人设，D9 修不变）
    //   - studio 三 scope（leader/mate/squad）→ 返空（squad_role mapper 接管身份正文）
    const sessionType = readSessionType(ctx);
    let content: string;
    if (!sessionType) {
      // standalone → Rocky identity
      content = new IdentityHandler().build({}).content;
    } else if (sessionType === 'subagent') {
      // subagent → explorer 模板人设（subAgentConfig.systemPrompt → config.systemPrompt）
      content = ctx.config.systemPrompt ?? '';
    } else {
      // leader/mate/squad → squad_role mapper 接管身份正文 → 这里返空（不污染 prompt）
      content = '';
    }
    return [
      {
        id: 'identity',
        tier: 'stable',
        content,
        priority: 1000,
      },
    ];
  }
}

