/**
 * AutoNamingHandler — session 自动起名提示词（读 content/auto_naming.md + {{query}} 占位符）。
 * 参考: specs/tech/agent/auto_naming/[P0]auto_naming_service.md
 *       specs/tech/version_logs/v0.0.153/change_plan.md T3-a
 *
 * 原 auto-naming-service.ts 内置的 NAMING_PROMPT 常量正文迁移至此，措辞逐字不变，
 * 唯一动态段（用户问题原文）改用 {{query}} 占位符。
 *
 * 逐字一致细节：md 文件遵循仓库惯例以换行结尾，但原 NAMING_PROMPT 常量在「用户问题：」
 * 之后无换行即直接拼接 plainText —— 故 build() 内先 trimEnd() 去掉文件的结尾换行，
 * 再做占位符替换，还原成与原常量完全相同的拼接结果。
 */
import {
  PromptHandler,
  type PromptHandlerContext,
  type PromptHandlerResult,
} from '../prompt-handler';

/** AutoNamingHandler：读 content/auto_naming.md，{{query}} 替换为用户首条 query 原文 */
export class AutoNamingHandler extends PromptHandler {
  protected readonly contentFile = 'auto_naming.md';

  build(ctx: PromptHandlerContext): PromptHandlerResult {
    const template = this.readContent().trimEnd();
    const content = this.fillTemplate(template, { query: ctx.vars?.query ?? '' });
    return { content };
  }
}

export default AutoNamingHandler;
