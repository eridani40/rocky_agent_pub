/**
 * message-flatten —— 视图层合并核心（§2 rule5/6）
 * 参考: specs/ui/components/chat-page/_overview.md §2
 *       specs/ui/components/studio-page/squad-chat-page.md「渲染策略契约」（过滤策略）
 *
 * 纯函数：把 Message[]（按 createdAt 升序）拍平为 view-element 序列，
 * 连续 tool-call-item 合并为 tool-batch（跨消息边界，遇非 tool 元素断开）。
 * part key = messageId + toolCallId/text-index（§2 rule6，SSE 乱序不抖动）。
 *
 * 两级过滤（为 squad 群聊白名单 + reminder 块级标记设计）：
 *   - messageFilter（消息级白名单）：群聊用 m => isUser(m) || isA2aInbox(m)
 *   - blockFilter（block 级，默认滤 isSystemReminder text block）：内核默认全局过滤 reminder
 * 默认行为向后兼容：不传 filter 时，仅 reminder block（isSystemReminder=true）被滤，其他全展示
 * （旧数据无此字段 = falsy = 全保留，零回归）。
 */

import type {
  ContentBlock,
  FlattenedView,
  Message,
  ToolResultContentBlock,
  ViewElement,
} from './types';

/** block 级过滤谓词：(block, 所属 message) => boolean，false 则该 block 不进 view 序列 */
export type BlockFilter = (block: ContentBlock, msg: Message) => boolean;

/** 消息级白名单谓词：false 则整条 message 跳过（含其全部 block） */
export type MessageFilter = (msg: Message) => boolean;

/** flatten 选项 */
export interface FlattenOptions {
  /** 消息级白名单（群聊用） */
  messageFilter?: MessageFilter;
  /** block 级过滤；不传 = 用 DEFAULT_BLOCK_FILTER（滤 isSystemReminder text block） */
  blockFilter?: BlockFilter;
}

/**
 * 默认 block 过滤：隐藏 isSystemReminder=true 的 text block（reminder 不渲染，但仍发 LLM）。
 * 两场景（playground/studio 单聊/群聊）都 deny（全局不渲染），故设为内核默认。
 */
export const DEFAULT_BLOCK_FILTER: BlockFilter = (b) =>
  !(b.type === 'text' && b.isSystemReminder === true);

/**
 * 扫所有 role='tool' 消息，建 Map<toolCallId, ToolResultBlock>。
 * tool-batch 内每个 tool-call-item 用 ToolCallBlock.id 查此 map 绑定 result（§2 rule4）。
 */
export function buildToolResultMap(messages: Message[]): Map<
  string,
  { content: ToolResultContentBlock[]; isError: boolean }
> {
  const map = new Map<string, { content: ToolResultContentBlock[]; isError: boolean }>();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        map.set(b.toolCallId, { content: b.content, isError: b.isError });
      }
    }
  }
  return map;
}

/**
 * 把 Message[] 拍平为 view-element 序列（§2 rule5）。
 * 规则：
 *  - user 消息 → user-text（TextBlock.text）
 *  - assistant 消息 → 逐 block 产出 view-element：
 *      TextBlock → agent-answer（text-index = 该 message 内累计的 text block 序号）
 *      ToolCallBlock → tool-call-item（绑定 result from toolResultMap）
 *      ReasoningBlock → 跳过不渲染
 *      UsageBlock → 跳过（不展示）
 *  - system 消息（如 system prompt 本身）不进 transcript，跳过
 *  - tool 消息（role='tool'）本身不直接产出 view-element（其 result 已绑定到 call）
 *
 * blockFilter 参数：默认用 DEFAULT_BLOCK_FILTER（滤 isSystemReminder text block）。
 *   每条 message 的 block 先过 blockFilter，被否决的 block 不进 view 序列（但仍计入 text-index
 *   编号以保持 part key 稳定——避免 reminder 滤掉后其他 text block 的 key 跳变）。
 *
 * @param messages 升序消息
 * @param blockFilter block 级过滤；不传 = DEFAULT_BLOCK_FILTER
 */
export function flattenMessages(messages: Message[], blockFilter: BlockFilter = DEFAULT_BLOCK_FILTER): ViewElement[] {
  const resultMap = buildToolResultMap(messages);
  const elements: ViewElement[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      // [v0.0.107] 来源徽标 name：非 client channel（如 feishu）→ 原始 type（渲染层拼「来自」+ i18n）；
      //   client / 无 channel（web 自发）→ undefined（无徽标噪声）。flatten 只产语义 type，单一职责。
      const ch = m.sender?.source === 'user' ? m.sender.channel : undefined;
      const originName = ch && ch.type !== 'client' ? ch.type : undefined;
      // 先过 blockFilter，但 text-index 按原 text block 总数编号（key 稳定，reminder 滤掉不抖动）
      const allTexts = m.content.filter((b) => b.type === 'text');
      for (let i = 0; i < allTexts.length; i++) {
        const t = allTexts[i];
        if (!t || t.type !== 'text') continue;
        if (!blockFilter(t, m)) continue;
        elements.push({
          kind: 'user-text',
          key: `${m.id}:u${i}`,
          messageId: m.id,
          text: t.text,
          name: originName,
        });
      }
    } else if (m.role === 'assistant') {
      let textIdx = 0;
      for (const b of m.content) {
        if (b.type === 'text') {
          if (!blockFilter(b, m)) continue;
          elements.push({
            kind: 'agent-answer',
            key: `${m.id}:t${textIdx}`,
            messageId: m.id,
            textIndex: textIdx,
            text: b.text,
          });
          textIdx++;
        } else if (b.type === 'tool_call') {
          // tool_call 不过 blockFilter（非 reminder 载体）；群聊靠 messageFilter 整条 mute
          elements.push({
            kind: 'tool-call-item',
            key: `${m.id}:c:${b.id}`,
            messageId: m.id,
            toolCallId: b.id,
            name: b.name,
            arguments: b.arguments,
            result: resultMap.get(b.id),
          });
        }
        // reasoning / usage 跳过
      }
    }
    // system 消息本就不进 transcript，无需特判 → 跳过所有 system 消息。
    // tool 消息不直接产出 view-element（result 已绑定到 call）
  }
  return elements;
}

/**
 * 对拍平后的视图元素做 tool-batch 连续合并分组（§2 rule5）。
 * 任意连续的 tool-call-item 合并为一个 batch；遇非 tool 元素断开、开新 batch。
 * 跨消息边界但位置连续的 tool_call 并入同一 batch。
 */
export function groupToolBatches(elements: ViewElement[]): FlattenedView {
  const batches: { key: string; elementKeys: string[] }[] = [];
  const elementBatch = new Map<string, string | null>();
  let currentBatch: { key: string; elementKeys: string[] } | null = null;
  let batchIdx = 0;

  const flush = () => {
    if (currentBatch && currentBatch.elementKeys.length > 0) {
      batches.push(currentBatch);
    }
    currentBatch = null;
  };

  for (const el of elements) {
    if (el.kind === 'tool-call-item') {
      if (!currentBatch) {
        currentBatch = { key: `batch-${batchIdx++}`, elementKeys: [] };
      }
      currentBatch.elementKeys.push(el.key);
      elementBatch.set(el.key, currentBatch.key);
    } else {
      // 非 tool 元素断开
      flush();
      elementBatch.set(el.key, null);
    }
  }
  flush();

  return { elements, batches, elementBatch };
}

/**
 * 一站式：拍平 + 分组（带过滤选项）。
 *
 * 过滤顺序：messageFilter 先筛 messages（白名单），再 blockFilter 逐 block 过滤。
 * buildToolResultMap 在筛后 messages 上跑——群聊 mute tool 消息后 result map 也空（与全 mute
 * tool-call 一致，无副作用）；单聊不传 messageFilter = 全集，行为不变。
 *
 * @param messages 升序消息
 * @param opts.messageFilter 消息级白名单（群聊用）；不传 = 全展示
 * @param opts.blockFilter block 级过滤；不传 = DEFAULT_BLOCK_FILTER（滤 reminder）
 */
export function flattenAndGroup(messages: Message[], opts: FlattenOptions = {}): FlattenedView {
  const msgs = opts.messageFilter ? messages.filter(opts.messageFilter) : messages;
  const blockFilter = opts.blockFilter ?? DEFAULT_BLOCK_FILTER;
  return groupToolBatches(flattenMessages(msgs, blockFilter));
}
