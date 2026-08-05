/**
 * RulesHandler — 行为规则片段正文（读 content/rules.md，3 section，无动态数据）。
 * 参考: specs/tech/agent/context/[P0]prompt_content_files.md §4
 *       specs/research/v0.0.22-system-prompt-and-compact.md §4.2
 */
import {
  PromptHandler,
  type PromptHandlerContext,
  type PromptHandlerResult,
} from '../prompt-handler';

/** RulesHandler：读 content/rules.md 正文（3 section），无动态数据 */
export class RulesHandler extends PromptHandler {
  protected readonly contentFile = 'rules.md';

  build(_ctx: PromptHandlerContext): PromptHandlerResult {
    return { content: this.readContent() };
  }
}

export default RulesHandler;
