/**
 * useFlattenedView —— 单次 flatten 记忆化 hook（v0.0.131 新建）
 * 参考: specs/ui/components/chat-page/component-history-minimap.md §2/§7（数据契约：单次 flatten 分发）
 *       specs/tech/version_logs/v0.0.131/change_plan.md A 组
 *
 * chat root（section-chat-session，7 消费方共用）用本 hook
 * 单次 flatten，结果同时分发给 ComponentMessageStream（flattened prop）+ deriveMinimapBars
 * （elements），保证 minimap bar 与可见气泡同源（change_plan「flatten 单次分发」架构决策：
 * bar 数 = 可见右侧 user 气泡数 恒等）。
 *
 * 纯 useMemo 包裹既有 flattenAndGroup（不自写 flatten 逻辑），无副作用。
 */
import { useMemo } from 'react';
import type { BlockFilter, MessageFilter } from './message-flatten';
import { flattenAndGroup } from './message-flatten';
import type { FlattenedView, Message } from './types';

export interface UseFlattenedViewOptions {
  /** 消息级白名单（群聊用）；不传 = 全展示 */
  messageFilter?: MessageFilter;
  /** block 级过滤；不传 = 默认滤 isSystemReminder text block */
  blockFilter?: BlockFilter;
}

/**
 * 记忆化单次 flatten：messages/messageFilter/blockFilter 引用不变时不重算。
 *
 * @param messages 当前 session 全量消息（升序）
 * @param opts messageFilter/blockFilter —— **必须**与传给同一 root 下 `ComponentMessageStream`
 *   的选项完全一致（否则 bar 与气泡不同源，见 change_plan 风险点1）
 */
export function useFlattenedView(
  messages: Message[],
  opts: UseFlattenedViewOptions = {},
): FlattenedView {
  const { messageFilter, blockFilter } = opts;
  return useMemo(
    () => flattenAndGroup(messages, { messageFilter, blockFilter }),
    [messages, messageFilter, blockFilter],
  );
}
