/**
 * IdentityHandler — agent 身份片段正文（读 content/identity.md，无动态数据）。
 * 参考: specs/tech/agent/context/[P0]prompt_content_files.md §4
 *       specs/research/v0.0.22-system-prompt-and-compact.md §4.1
 */
import {
  PromptHandler,
  type PromptHandlerContext,
  type PromptHandlerResult,
} from '../prompt-handler';

/** IdentityHandler：读 content/identity.md 正文（5 要素），无动态数据 */
export class IdentityHandler extends PromptHandler {
  protected readonly contentFile = 'identity.md';

  build(_ctx: PromptHandlerContext): PromptHandlerResult {
    return { content: this.readContent() };
  }
}

export default IdentityHandler;
