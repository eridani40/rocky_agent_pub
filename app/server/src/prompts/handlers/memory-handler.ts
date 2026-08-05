/**
 * MemoryHandler — 记忆快照片段（no-op，记忆源未建）。
 * 参考: specs/tech/agent/context/[P0]prompt_content_files.md §4
 *       specs/tech/agent/context/[P0]system_prompt.md §4（memory / volatile tier D1.1）
 *
 * [D1.1] long_term_memory 记忆源未建 → no-op 返空 content。
 * handler 存在仅为占位 + 后续记忆源就位后填肉（行为对齐既有 memory mapper）。
 */
import {
  PromptHandler,
  type PromptHandlerContext,
  type PromptHandlerResult,
} from '../prompt-handler';

/** MemoryHandler：no-op（记忆源未建），build() 返空 content */
export class MemoryHandler extends PromptHandler {
  // 无 contentFile（no-op）

  build(_ctx: PromptHandlerContext): PromptHandlerResult {
    // D1.1 no-op：long_term_memory 记忆源未建，返空 content（mapper 据此不贡献）
    // TODO(memory): long_term_memory 就位后读快照生成片段
    return { content: '' };
  }
}

export default MemoryHandler;
