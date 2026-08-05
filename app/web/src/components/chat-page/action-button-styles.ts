/**
 * action-button-styles —— chat input-bar 动作按钮统一尺寸 token
 * 参考: specs/ui/components/chat-page/component-input-model-picker.md §9.1（action-button 尺寸约定）
 *
 * chat 输入区（section-chat-session 统一装配层 + component-chat-session-input）
 * 的 picker + send + stop 按钮共用同一组尺寸 token，避免三处漂移。
 *
 * target h-[21px] w-[21px]。
 * icon 尺寸：BrainIcon=12（picker，纯图标）/ SendIcon=11 / StopIcon=11。
 * 各按钮自行叠加视觉样式（bg / rounded / color），本常量仅锁尺寸 + 布局基线。
 */

/** chat input-bar 动作按钮统一尺寸 + 布局基线（picker / send / stop 共用） */
export const CHAT_ACTION_BTN_CLS = 'h-[21px] w-[21px] flex items-center justify-center shrink-0';
