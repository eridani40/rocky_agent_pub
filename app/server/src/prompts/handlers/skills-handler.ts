/**
 * SkillsHandler — skill L0 片段（读 content/skills.md 模板 + {{skills_list}}）。
 * 参考: specs/tech/agent/context/[P0]prompt_content_files.md §4
 *       specs/tech/agent/skills/[P0]skill_definition.md §3（progressive disclosure L0）
 *
 * 动态数据：vars.skills_list（调用方从 ctx.config.skills.entries 拼 `- name: description`）。
 * 空 list → 返空 content（mapper 不贡献 fragment）。
 */
import {
  PromptHandler,
  type PromptHandlerContext,
  type PromptHandlerResult,
} from '../prompt-handler';

/** SkillsHandler：读模板 + 替换 {{skills_list}} */
export class SkillsHandler extends PromptHandler {
  protected readonly contentFile = 'skills.md';

  build(ctx: PromptHandlerContext): PromptHandlerResult {
    const skillsList = ctx.vars?.skills_list ?? '';
    // 空 list → 不贡献（mapper 见空 content 返 []）
    if (!skillsList) return { content: '' };
    const template = this.readContent();
    const content = this.fillTemplate(template, { skills_list: skillsList });
    return { content };
  }
}

export default SkillsHandler;
