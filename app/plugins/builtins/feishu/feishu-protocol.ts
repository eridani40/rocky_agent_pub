/**
 * 飞书协议适配层 —— 解析入站事件 / 格式化出站消息
 * 参考: reqs/[done] v0.0.103.channel/design-feishu.md §2/§3/§5
 *       refs/openclaw/extensions/feishu/src/event-types.ts（事件结构）
 *       refs/openclaw/extensions/feishu/src/mention.ts（@bot 剥离参考）
 *
 * 飞书字段对照官方文档（编码期已对照 SDK types/index.d.ts §298843 im.message.receive_v1）：
 *   - 事件 data.message.{message_id, chat_id, chat_type, message_type, content, mentions}
 *   - data.sender.sender_id.{open_id, user_id, union_id}
 *   - chat_type: "p2p" | "group" | "topic_group" | "private"
 *   - content: JSON 字符串，文本消息为 { text: "..." }
 *   - mentions[].{key, id.open_id, name} —— key 形如 "@_user_1" 在 content.text 中占位
 *
 * 与 design-feishu §9 对照结论：字段名与官方一致（无 drift）。
 */

/** 飞书 chat_type 合法值（SDK event-types.ts:21） */
export type FeishuChatType = 'p2p' | 'group' | 'topic_group' | 'private';

/** 飞书消息事件最小形状（im.message.receive_v1 的 data 子集） */
export interface FeishuMessageEvent {
  sender: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    /** JSON 字符串（文本消息 {"text":"..."}） */
    content: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; user_id?: string; union_id?: string };
      name: string;
    }>;
  };
}

/** parseFeishuMessage 输出：投递 agent 所需的最小数据 */
export interface ParsedFeishuInbound {
  /** 群聊=chat_id / 私聊=open_id（D2 conversationId 无 scope 编码） */
  conversationId: string;
  /** 群 vs 私聊判定（私聊→receive_id_type=open_id 发送回执） */
  chatType: FeishuChatType;
  /** 剥离 @bot 后的纯文本（斜杠前缀保留在首位） */
  text: string;
  /** 原始消息 id（用于 reply / 状态回执） */
  messageId: string;
  /** 发送者 open_id（私聊发送消息时作为 receive_id） */
  imUserId: string;
  /** 发送者展示名（mentions 里非 bot 的用户 / 兜底用 open_id 前缀） */
  imUserName: string;
  /** receive_id_type 用于 im.message.create：群=chat_id / 私聊=open_id */
  receiveIdType: 'chat_id' | 'open_id';
}

/**
 * 从飞书原始事件中提取 inbound 信息。
 * 剥离 @bot mention：把 content.text 中的 `@_user_N` 占位符（mentions.key）替换为空。
 * bot open_id 用于识别哪个 mention 是 @bot。
 *
 * @param raw SDK 回调原始 data
 * @param botOpenId 当前 bot 的 open_id（用于识别 @bot）
 * @returns 解析结果；解析失败返回 null（malformed event，上层 drop）
 */
export function parseFeishuMessage(
  raw: unknown,
  botOpenId?: string,
): ParsedFeishuInbound | null {
  if (!raw || typeof raw !== 'object') return null;
  const evt = raw as Partial<FeishuMessageEvent>;
  const sender = evt.sender;
  const message = evt.message;
  if (!sender || !message) return null;

  const messageId = message.message_id?.trim();
  const chatId = message.chat_id?.trim();
  const chatTypeRaw = message.chat_type?.trim();
  const messageType = message.message_type?.trim();
  const content = message.content?.trim();
  if (!messageId || !chatId || !chatTypeRaw || !messageType || !content) {
    return null;
  }

  const chatType = normalizeChatType(chatTypeRaw);
  if (!chatType) return null;

  // conversationId：群=chatId，私聊=发送者 openId（D2 无 scope 编码）
  const senderOpenId = sender.sender_id?.open_id?.trim() || '';
  const isGroup = chatType === 'group' || chatType === 'topic_group';
  const conversationId = isGroup ? chatId : senderOpenId;
  if (!conversationId) return null;

  // 解析 content（文本消息 {"text":"..."}）
  const text = extractText(messageType, content);
  if (text === null) return null;

  // 剥离 @bot mention（仅群聊有效）
  const mentions = message.mentions ?? [];
  const strippedText = stripBotMention(text, mentions, botOpenId).trim();

  // imUserName：优先用非 @all 非 @bot 的 mention.name，否则兜底 sender.open_id 前 12 位
  const userName = resolveDisplayName(mentions, botOpenId, senderOpenId);

  return {
    conversationId,
    chatType,
    text: strippedText,
    messageId,
    imUserId: senderOpenId,
    imUserName: userName,
    receiveIdType: isGroup ? 'chat_id' : 'open_id',
  };
}

function normalizeChatType(v: string): FeishuChatType | undefined {
  return v === 'p2p' || v === 'group' || v === 'topic_group' || v === 'private'
    ? (v as FeishuChatType)
    : undefined;
}

/** 提取 text：文本消息 {"text":"..."}；非文本返回 null（本期不支持图片入站） */
function extractText(messageType: string, content: string): string | null {
  if (messageType !== 'text') return null;
  try {
    const obj = JSON.parse(content) as { text?: unknown };
    return typeof obj.text === 'string' ? obj.text : null;
  } catch {
    return null;
  }
}

/**
 * 剥离 @bot mention。
 * 飞书 content.text 中 @bot 显示为 `@_user_N` 占位符，N 对应 mentions[].key。
 * 策略：找 mentions 中 id.open_id === botOpenId 的项，把它的 key 从 text 中删除。
 */
function stripBotMention(
  text: string,
  mentions: FeishuMessageEvent['message']['mentions'],
  botOpenId?: string,
): string {
  if (!botOpenId || !mentions?.length) return text;
  const botMention = mentions.find((m) => m.id.open_id === botOpenId);
  if (!botMention?.key) return text;
  // 移除 @bot 占位符 + 收尾多余空白
  const stripped = text.split(botMention.key).join('').replace(/\s+/g, ' ').trim();
  return stripped;
}

function resolveDisplayName(
  mentions: FeishuMessageEvent['message']['mentions'],
  botOpenId: string | undefined,
  senderOpenId: string,
): string {
  // 群聊消息里 sender 通常在 mentions 里没有自己；这里用 mentions 找非 bot 非 @all 的人
  for (const m of mentions ?? []) {
    const key = m.key?.toLowerCase();
    if (key === '@all' || key === '@_all') continue;
    if (botOpenId && m.id.open_id === botOpenId) continue;
    return m.name?.trim() || senderOpenId.slice(0, 12);
  }
  return senderOpenId.slice(0, 12) || 'feishu-user';
}

// ============================================================
// 出站消息格式化（content blocks → 飞书 msg_type + content）
// ============================================================

import type { ContentBlock, Message } from '../../../server/src/message/types';

/** 单条飞书发送 payload（msg_type + content JSON 字符串 + receive_id_type） */
export interface FeishuOutboundPayload {
  msg_type: 'text';
  /** JSON 字符串（text 消息为 {"text":"..."}） */
  content: string;
  /** 用于 im.message.create params.receive_id_type */
  receive_id_type: 'chat_id' | 'open_id';
}

/** 单条出站消息长度上限（飞书 text 约 30k，本版按 markdown 边界 ~4000 切，保守） */
const FEISHU_CHUNK_LIMIT = 4000;

/**
 * 把 assistant Message 的 content blocks 格式化为飞书可发送的 payload 列表。
 * D3：sendOutbound 收到完整 Message，不感知累积过程。
 *
 * - TextBlock → 文本（拼接 + 超长分块）
 * - ToolCallBlock/ToolResultBlock/UsageBlock/ReasoningBlock → 跳过（不出站）
 * - 多块 text 拼接为一条，再按 ~4000 字符切（保 markdown 完整性尽量在 \n\n 处切）
 *
 * 空内容返回空数组（不发送）。receive_id（=conversationId）由 caller 在 im.message.create.data 填。
 */
export function formatFeishuOutbound(
  msg: Message,
  chatType: FeishuChatType,
): FeishuOutboundPayload[] {
  const receiveIdType: 'chat_id' | 'open_id' =
    chatType === 'group' || chatType === 'topic_group' ? 'chat_id' : 'open_id';

  const textParts: string[] = [];
  for (const block of msg.content) {
    if (block.type === 'text') {
      const t = block.text;
      if (t) textParts.push(t);
    }
    // 其他 block 类型（tool_call/tool_result/usage/reasoning）不发飞书
  }

  const fullText = textParts.join('\n\n').trim();
  if (!fullText) return [];

  const chunks = chunkTextForOutbound(fullText, FEISHU_CHUNK_LIMIT);
  return chunks.map((chunk) => ({
    msg_type: 'text' as const,
    content: JSON.stringify({ text: chunk }),
    receive_id_type: receiveIdType,
  }));
}

/**
 * 超长文本分块。
 * 在 limit 内尽量在 \n\n（段落边界）切，无法切则硬切。
 */
export function chunkTextForOutbound(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cutAt = rest.lastIndexOf('\n\n', limit);
    if (cutAt <= 0) cutAt = rest.lastIndexOf('\n', limit);
    if (cutAt <= 0) cutAt = limit;
    chunks.push(rest.slice(0, cutAt).trim());
    rest = rest.slice(cutAt).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
