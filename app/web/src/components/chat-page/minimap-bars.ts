/**
 * minimap-bars —— 历史 query minimap bar 派生（纯函数，v0.0.131 新建）
 * 参考: specs/ui/components/chat-page/component-history-minimap.md §2（数据契约）
 *       specs/tech/version_logs/v0.0.131/change_plan.md A 组 + 影响面评估#2（spec↔code 漂移点）
 *
 * 从 flatten 后的 elements 中派生 minimap bar 列表：仅「渲染为右侧 user 气泡」的历史消息才产 bar
 * ——按 side 判定，非按 kind 裸判。a2a inbox 消息 role='user' 也会产 user-text 元素
 * （chat-actor-strategy.isA2aInbox），但群聊里 a2a inbox 渲染在左侧（assistant 侧），需靠
 * `sideResolver ?? sideOfMessage`（与 component-message-stream 同款判定）排除，才能保证
 * 「bar = 右侧 user 气泡」恒等（修正 PRD §2.2「a2a inbox 不产 user-text」的不准确表述）。
 */
import { sideOfMessage } from './component-message-stream';
import type { Message, ViewElement } from './types';

/** 单条历史 query minimap bar */
export interface MinimapBar {
  /** 该条 user 消息 ULID（= user-text.messageId），点击滚动锚定用 */
  messageId: string;
  /** 该条 query 文本（= user-text.text），预览第一行 */
  query: string;
  /** 其下第一个 agent-answer 文本头部（同一 query 后、下一个 user-text 前的首个 agent-answer.text）；
   *  无 answer（尚未生成 / 被 mute）→ undefined，预览第二行显占位 */
  preview?: string;
}

/** side 判定覆盖（不传 = 默认 sideOfMessage，与 message-stream 同源判定） */
type SideResolver = (msg: Message | undefined) => 'user' | 'assistant';

/** minimap bar 展示上限（时间序末尾 = 最近 N 条） */
const DEFAULT_MAX_BARS = 20;

/**
 * 派生 minimap bar 列表（纯函数，UT 覆盖 PRD §9 全部派生分支）。
 *
 * @param elements flatten 后的 ViewElement 序列（须与传给 ComponentMessageStream 的同一份 `useFlattenedView`
 *   结果，flatten 同源，保证 bar 数 = 可见右侧 user 气泡数）
 * @param messages 全量消息（按 messageId 查 side 判定输入）
 * @param sideResolver side 判定覆盖；不传 = 默认 `sideOfMessage`（单聊传 memberSideResolver 让 a2a inbox 产 bar）
 * @param max 展示上限；不传 = 20（取时间序末尾即最近 max 条）
 */
export function deriveMinimapBars(
  elements: ViewElement[],
  messages: Message[],
  sideResolver?: SideResolver,
  max: number = DEFAULT_MAX_BARS,
): MinimapBar[] {
  const msgById = new Map<string, Message>();
  for (const m of messages) msgById.set(m.id, m);
  const resolveSide = sideResolver ?? sideOfMessage;

  const bars: MinimapBar[] = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el || el.kind !== 'user-text') continue;
    // 仅 side==='user'（右侧气泡）才产 bar —— 排除群聊左侧 a2a inbox（MUST NOT 按 kind 裸判）
    if (resolveSide(msgById.get(el.messageId)) !== 'user') continue;

    // preview：从该 user-text 之后扫，遇首个 agent-answer 取其 text；
    // 遇下一个 user-text（任一侧）先于 agent-answer → 无 answer（preview 保持 undefined）；
    // tool-call-item 跳过继续扫。
    let preview: string | undefined;
    for (let j = i + 1; j < elements.length; j++) {
      const next = elements[j];
      if (!next) continue;
      if (next.kind === 'user-text') break;
      if (next.kind === 'agent-answer') {
        preview = next.text;
        break;
      }
      // tool-call-item：跳过继续扫
    }

    bars.push({ messageId: el.messageId, query: el.text, preview });
  }

  // 时间序末尾取最近 max 条
  return bars.slice(-max);
}
