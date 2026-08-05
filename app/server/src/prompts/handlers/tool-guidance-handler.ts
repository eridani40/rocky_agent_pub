/**
 * ToolGuidanceHandler — 工具使用说明片段（读 content/tool_guidance.md 模板 + {{tool_list}}）。
 * 参考: specs/tech/agent/context/[P0]prompt_content_files.md §4
 *
 * 动态数据：vars.tool_list（调用方从 config.tools 拼 `- \`name\` — desc` 列表）。
 * 空 list → 返空 content（mapper 不贡献 fragment）。
 */
import {
  PromptHandler,
  type PromptHandlerContext,
  type PromptHandlerResult,
} from '../prompt-handler';

/** ToolGuidanceHandler：读模板 + 替换 {{tool_list}} */
export class ToolGuidanceHandler extends PromptHandler {
  protected readonly contentFile = 'tool_guidance.md';

  build(ctx: PromptHandlerContext): PromptHandlerResult {
    const toolList = ctx.vars?.tool_list ?? '';
    // 空 list → 不贡献（mapper 见空 content 返 []）
    if (!toolList) return { content: '' };
    const template = this.readContent();
    const content = this.fillTemplate(template, { tool_list: toolList });
    return { content };
  }
}

export default ToolGuidanceHandler;
