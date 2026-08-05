/**
 * search.sqlite 文本提取共享 util — ContentBlock[] → 纯文本副本
 * 参考: specs/tech/persistence/[P1]search_engine.md §3.5 + §3.6（副本语义）+ §3.3（文本来源时序）
 *
 * 设计要点：
 *   - indexer 写 chunks.text + search engine 副本语义 都需要把 ContentBlock[] 压成纯文本
 *   - 一期策略：仅取 type=text 的 TextBlock.text 拼接（剥 image/tool_use/tool_result/reasoning/usage/tool_reply）
 *   - 本 util 是这两个模块的共享实现（消除 history-indexer.extractTextFromContent
 *     + search-engine.extractPlainText 的重复，v0.0.126 doc-sync）
 */
import type { ContentBlock, TextBlock } from '../message/types';

/**
 * 从 ContentBlock[] 提取纯文本副本（spec §3.5 + §3.6）。
 *
 * 仅取 type=text 的 TextBlock.text 拼接（\n 分隔），其他 block 类型
 * （image/tool_use/tool_result/reasoning/usage/tool_reply）一律剥除。
 * 用于 indexer 写 chunks.text 和 search engine 的副本语义。
 *
 * @param content 消息的 content blocks 数组；非数组 / 空数组 / 全无 text 块均返回空串
 * @returns 拼接后的纯文本（不含非 text 块内容）
 */
export function extractPlainText(content: ContentBlock[] | unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as TextBlock).text;
      if (typeof text === 'string' && text.length > 0) parts.push(text);
    }
  }
  return parts.join('\n');
}
