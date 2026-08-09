/**
 * llm logical-view：业务 Message[] → LLM 视图 Message[] 公共 encoder（protocol 无关）
 * 参考: specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md §3（[P0]llm_logical_view.md）
 *       specs/tech/multi_agent/[P1]a2a_protocol.md §5（sender.source 分流表——前缀权威）
 *       specs/tech/agent/message/[P0]agent_message_interface.md §5（MessageSender 判别联合）
 *
 * 职责（§3.1/§3.6）：把结构化 sender 信封展平到首个 TextBlock 文本前缀
 * （`[User]:` / `[Message from ...]` / `[System (...)]:` / `[Approval result]:`），
 * 供任意 protocol.encode 消费。纯函数、零副作用、protocol 无关。
 *
 * 为什么抽公共层（§3.2）：sender 是结构化字段，LLM 不能理解结构；进 wire 前必须变成
 * 人类可读文本前缀（防幻觉、指示 a2a 回复方向）。抽为一层后所有 protocol.encode 上游
 * 统一调 toLogicalMessages；protocol 自身只做协议本身的合并/映射（role tool→user、
 * 相邻同 role 合并、system 顶层、cache_control 等）。
 *
 * 不变量（§3.4）：不 mutate 原数组；返回新数组；元素浅拷贝（{...m}）保留 sender/
 * metadata/id/role 等所有字段；仅 content 被替换为渲染后的新数组（首块 TextBlock 新对象）。
 *
 * 前缀表（§3.3）：
 *   - source='agent'    → `[Message from <ref.name> (<ref.type>, needReply=<bool>)]: `
 *   - source='user'     → `[User]: `
 *   - source='system' kind='heartbeat' → `[System (heartbeat tick)]: `
 *   - source='system' kind='reminder'  → `[System reminder]: `
 *   - source='system'（其他 kind）      → `[System (<kind>)]: `
 *   - source='approval' → `[Approval result]: `
 *   - 无 sender          → 空串（content 原样返回）
 */
import type { ContentBlock, Message, MessageSender, TextBlock } from '../message/types';

/**
 * 按 sender.source 渲染前缀字符串（无 sender / 未知 source → 空串）。
 *
 * @param sender 消息来源信封（判别联合，by source）
 * @returns 前缀字符串（含末尾 `: ` 分隔符）；无前缀时返回空串
 */
export function renderSenderPrefix(sender: MessageSender | undefined): string {
  if (!sender) return '';
  switch (sender.source) {
    case 'agent': {
      // a2a 消息：发送方 ref + needReply（接收方一眼见是否必回）
      const { ref, needReply } = sender.agent;
      return `[Message from ${ref.name} (${ref.type}, needReply=${needReply})]: `;
    }
    case 'user':
      // user 在本 session；想回出 final text
      return `[User]: `;
    case 'system': {
      // system 子类按 kind 渲染（heartbeat tick / reminder / 其他）
      const kind = sender.system.kind;
      if (kind === 'heartbeat') return `[System (heartbeat tick)]: `;
      if (kind === 'reminder') return `[System reminder]: `;
      return `[System (${kind})]: `;
    }
    case 'approval':
      // 用户审批回流
      return `[Approval result]: `;
    default:
      // 未知 source（防御）→ 无前缀
      return '';
  }
}

/**
 * 把前缀注入 message.content（返回新 content blocks，不改原 message）。
 *
 * [v0.0.294] per-block 前缀注入策略：
 *   - 遍历每个 block，独立计算前缀来源：
 *     1. block 有 sender 字段 → 用 block.sender
 *     2. block 无 sender 但 message 有 sender → 回退到 message.sender（向后兼容未合并的 message）
 *     3. 都没有 → 无前缀
 *   - text block：前缀拼到其 text 前（返回新 TextBlock，不 mutate 原 block）
 *   - 非 text block：prepend 一个新 TextBlock 承载前缀
 *   - 无前缀的 block 原样保留（不注入空前缀）
 *
 * @param message 业务 Message（读 sender + content）
 * @returns 渲染后的 content blocks（所有 block 无前缀时 === 原 content 引用）
 */
export function renderMessageContentWithPrefix(message: Message): ContentBlock[] {
  const result: ContentBlock[] = [];

  for (const block of message.content) {
    // 前缀来源：block.sender 优先，回退到 message.sender
    const sender = (block as TextBlock).sender ?? message.sender;
    const prefix = renderSenderPrefix(sender);
    if (!prefix) {
      // 无前缀：原样保留
      result.push(block);
      continue;
    }
    if (block.type === 'text') {
      // text block：前缀拼前（新对象，不 mutate 原 block）
      const merged: TextBlock = { type: 'text', text: prefix + block.text };
      result.push(merged);
    } else {
      // 非 text block：prepend 新 TextBlock 承载前缀 + 原 block
      const prefixBlock: TextBlock = { type: 'text', text: prefix };
      result.push(prefixBlock, block);
    }
  }

  // 所有 block 都无前缀 → 返回原 content 引用（向后兼容无 sender 场景）
  if (result.length === message.content.length) {
    const allSame = result.every((b, i) => b === message.content[i]);
    if (allSame) return message.content;
  }
  return result;
}

/**
 * 业务 Message[] → LLM 视图 Message[]（sender 展平入首块 TextBlock 前缀）。
 *
 * 公共 encoder（§3.1）：所有 protocol.encode 上游统一调本函数。返回新数组，不 mutate
 * 入参；每个元素是浅拷贝（{...m}）——sender/metadata/id/role/runId 等字段原样保留，
 * 仅 content 替换为 renderMessageContentWithPrefix 产出的新数组。
 *
 * @param messages 业务 Message[]（sender 结构化，可能混块含 reminder）
 * @returns LLM 视图 Message[]（sender 已展平入首块前缀，其他字段保留）
 */
export function toLogicalMessages(messages: Message[]): Message[] {
  return messages.map((m) => ({ ...m, content: renderMessageContentWithPrefix(m) }));
}
