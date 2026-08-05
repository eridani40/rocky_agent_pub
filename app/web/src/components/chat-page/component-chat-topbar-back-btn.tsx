/**
 * component-chat-topbar-back-btn —— chat-topbar 「返回」按钮 primitive（共享 chat 基质）
 * 参考: specs/ui/components/chat-page/component-chat-topbar-back-btn.md
 *
 * 职责：
 *   ghost 型按钮 = ChevronLeftIcon + i18n `common:action.back`；由各板块 chat topbar
 *   （studio section-studio-chat / component-studio-board-route 等）
 *   消费方 topbarLeft slot 前置渲染。
 * 边界：
 *   纯 stateless UI + onClick 回调；不感知板块语义；不管布局环境（父 slot 用 flex 序列）。
 *   icon 走 chat-page/icons ChevronLeftIcon（与 chat-page 基质同源，不跨板块依赖）。
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeftIcon } from './icons';

export interface ChatTopbarBackBtnProps {
  onClick: () => void;
  /** testid，缺省 'chat-topbar-back-btn'（regulation 02 §9 契约） */
  testId?: string;
  /** ET 稳定语义锚点 data-action-key（命名见 specs/ui/components/_conventions.md §12）。
   *  共享基质被 studio/academy 多板块消费，固定 key 会误标板块 → 由消费方按语义传入，缺省不渲染属性 */
  actionKey?: string;
}

/**
 * chat-topbar 返回按钮。
 * 视觉基线（regulation 02 §9 + design/studio-console.html）：
 *   h-8 px-2 rounded-md ghost 型 灰底 + ChevronLeftIcon 14px + 12px 文本。
 *   布局稳定 INV-6：本身固定尺寸；消费方 slot 用 flex 序列前置，title 不位移。
 */
export function ChatTopbarBackBtn({ onClick, testId, actionKey }: ChatTopbarBackBtnProps): ReactNode {
  const { t } = useTranslation('common');
  return (
    <button
      type="button"
      data-action-key={actionKey}
      onClick={onClick}
      className="mr-2 flex items-center gap-1 rounded-md px-2 h-8 text-[12px] font-medium text-muted-2 transition-colors hover:bg-bg-warm hover:text-fg"
    >
      <ChevronLeftIcon size={14} />
      <span>{t('action.back')}</span>
    </button>
  );
}

export default ChatTopbarBackBtn;
