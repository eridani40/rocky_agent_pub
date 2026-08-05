/**
 * builtin rocky_context plugin — clean_view_reducer: fill_empty_text
 * 参考: specs/tech/agent/context/[P0]context_assemble_detail.md §5b
 *       specs/tech/agent/context/[P0]extension point and implementations.md §3.10
 *
 * 职责（§5b 表）：把 user / tool(success) message 里 text==='' 的 content block
 * 兜底成 "empty"，防止空 text content block 发给 LLM 撞 Anthropic 400
 * "text content is empty"。
 *
 * 处理范围（两层结构）：
 *   - user message：`message.content[i]` 里 `type==='text' && text===''` → text='empty'
 *   - tool message（role==='tool'）：进到 `tool_result` block（isError:false 的 success）的
 *     `.content[j]` 里，`type==='text' && text===''` → text='empty'（嵌套一层）
 *
 * 不动：
 *   - assistant message（按设计不处理）
 *   - error tool_result（isError:true）的嵌套 text
 *   - 非空 text block / 非 text 类型 block
 *
 * 命中（有 block 被填）时：经 ctx.config.logWriter 写一条 error 级日志（鸭子类型能力探测，
 * enableErrorLog 开关由 LogWriter 内部 TYPE_TO_KEY 门禁控制，此处不重复判）。
 * 日志写入 fail-silent：try/catch 吞掉任何异常，绝不影响 assembly 主流程
 * （参照 tools/engine.ts writeToolLog 模式）。
 *
 * EP: context_clean_view_reducer，order 4（插在 think_remove 之后、empty_message 之前；
 * 由 ContextEngine.getCleanSnapshot 在深克隆副本上跑）。
 */
import type { ContentBlock, Message } from '../../../../server/src/message/types';
import { AssembleData, AssembleCtx, AssembleReducer, ContextImplBase } from '../types';

/**
 * fill_empty_text reducer：填充空 text content block 为 "empty"。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class FillEmptyTextReducer
  extends ContextImplBase
  implements AssembleReducer
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  reduce(_data: AssembleData, input: Message[] | null, ctx: AssembleCtx): Message[] {
    if (input === null) return [];

    let hitCount = 0;
    const out = input.map((m) => {
      if (m.role === 'user') {
        // user：直接在 message.content 上填
        const { content, hits } = fillEmptyTextBlocks(m.content);
        hitCount += hits;
        return hits > 0 ? { ...m, content } : m;
      }
      if (m.role === 'tool') {
        // tool：进每个 tool_result（isError:false 的 success）的 .content 嵌套一层
        let msgHits = 0;
        const newContent = m.content.map((b) => {
          if (b.type !== 'tool_result') return b;
          if (b.isError) return b; // error tool_result 不动
          const { content: nestedFilled, hits } = fillEmptyTextBlocks(b.content);
          msgHits += hits;
          return hits > 0 ? { ...b, content: nestedFilled } : b;
        });
        hitCount += msgHits;
        return msgHits > 0 ? { ...m, content: newContent } : m;
      }
      return m; // assistant / system 不动
    });

    if (hitCount > 0) {
      writeErrorLog(ctx, {
        reducer: 'fill_empty_text',
        sessionId: ctx.config?.sessionId,
        hits: hitCount,
      });
    }
    return out;
  }
}

/**
 * 把 blocks 里 `type==='text' && text===''` 的 block 兜底为 text='empty'。
 * 返回新数组 + 命中数（不可变处理，原数组不变）。
 */
function fillEmptyTextBlocks(blocks: ContentBlock[]): { content: ContentBlock[]; hits: number } {
  let hits = 0;
  const content = blocks.map((b) => {
    if (b.type === 'text' && b.text === '') {
      hits++;
      return { ...b, text: 'empty' };
    }
    return b;
  });
  return { content, hits };
}

/**
 * 经 ctx.config.logWriter 写一条 error 级日志（鸭子类型能力探测 + fail-silent）。
 * enableErrorLog 开关由 LogWriter.write 内部 TYPE_TO_KEY 门禁控制（appConfig.get('logs','enableErrorLog')）。
 * 与 tools/engine.ts writeToolLog 同模式：try/catch 吞异常，绝不影响 assembly 主流程。
 */
function writeErrorLog(ctx: AssembleCtx, record: Record<string, unknown>): void {
  try {
    const config = ctx.config as { logWriter?: unknown };
    if (!config || !config.logWriter || typeof config.logWriter !== 'object') return;
    const w = config.logWriter as { write?: (type: string, rec: Record<string, unknown>) => void };
    if (typeof w.write !== 'function') return;
    w.write('error', record);
  } catch {
    // 日志失败绝不影响 assembly 主流程
  }
}
