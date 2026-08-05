/**
 * message-preview —— message_enqueued content 拍平为预览纯文本（从 chat-slice-reducer.ts 拆出）
 * 参考: specs/tech/version_logs/v0.0.12/change_plan.md §T1 BUG-007（enqueue content 类型对齐）
 *
 * 纯函数 leaf（仅依赖 ContentBlock 类型）；被 apply-agent-event.ts 的 message_enqueued case 调用。
 * v0.0.156 拆分重构：从原单文件 chat-slice-reducer.ts move，**实现 100% 等价**（INV-G1）。
 */
import type { ContentBlock } from '../../components/chat-page/types';

/**
 * 把后端 message_enqueued 的 content（ContentBlock[]，与 Message.content 同构）
 * 拍平为 enqueue-view 预览用的纯文本。
 *
 * BUG-007：真 LLM / 真实 user message 的 content 永远是 ContentBlock[]
 * （user 文本 = [{type:'text',text:'...'}]）。mock 路径历史上有直接传 string 的兼容场景，
 * 故同时兼容两种输入：string 直通；ContentBlock[] 拼接所有 text block 的文本（其余类型忽略）。
 */
export function contentBlocksToPreviewText(content: ContentBlock[] | string): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // 只取 TextBlock.text 拼接（tool_call / reasoning / usage / tool_result 不属于 user query 预览）
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('');
}
