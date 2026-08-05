/**
 * CompactHandler — compact 压缩指令模板（读 content/compact.md，纯 directive）。
 * 参考: specs/tech/agent/context/[P0]prompt_content_files.md §4 §5
 *       specs/tech/agent/context/[P0]context_compact_detail.md §3（CC 口径完整版）
 *
 * [v0.0.54] 回归 forked 不变量：compact prompt 是**纯 directive**——
 * snapshot 是唯一信息源（system + messages + reminder 已在 buffer），prompt 只下
 * 「概括上面对话历史」的指令，**不复述 serialized_transcript、不注入 old_summary**。
 * 故 build() 不再接任何动态 vars，直接读 compact.md 返回。
 *
 * compact.md 模板内含 NO_TOOLS preamble + 9 板块 + 输出约束 + identifier 保留 +
 * NO_TOOLS trailer，无任何占位符。
 */
import {
  PromptHandler,
  type PromptHandlerContext,
  type PromptHandlerResult,
} from '../prompt-handler';

/** CompactHandler：读 compact.md 模板（纯 directive，无占位符替换） */
export class CompactHandler extends PromptHandler {
  protected readonly contentFile = 'compact.md';

  build(_ctx?: PromptHandlerContext): PromptHandlerResult {
    // [v0.0.54] 无占位符：compact prompt 是纯指令，对话历史由 forked buffer 提供
    // （snapshot.messages 已在 buffer 中，prompt 不复述——forked 不变量）
    // _ctx 保留以满足父类 build(ctx) 签名，本 handler 不读 vars
    return { content: this.readContent() };
  }
}

export default CompactHandler;
