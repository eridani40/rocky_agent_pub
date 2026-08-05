/**
 * base-chat-page —— chat 主区页级 base（骨架 + slot 注入）
 * 参考: specs/ui/components/chat-page/base-chat-page.md
 *       specs/tech/version_logs/v0.0.155/change_plan.md §3 + 段 E（INV-E1 只含骨架）
 *
 * 进 base（共用度 ~90%）：
 *   - 主区 <section>/<main> 容器 + flex 骨架（topbar / messages wrapper / input bar 垂直排）
 *   - topbar 容器（border-b + shrink-0；左 slot + 右 slot）
 *   - messages wrapper（flex-1 + relative + overflow-hidden；右缘 overlay 定位上下文）
 *   - clear modal 挂载（ComponentClearConfirmModal；三页同款）
 *   - chrome loading 占位（chat-loading testid，studio 用）
 *   - fadeIn 动画 wrapper
 *
 * 保留独立（slot / props 注入，不进 base）：
 *   - store biz 分流（playground useChatStore / 统一装配层 useChatChrome）→ 数据通过 props/slot 透传
 *   - chrome 数据源 → 消费方装配 area-hooks，results 投到 messagesSlot
 *   - 状态机开关（群聊无 run 态）→ 用 hideStopButton flag（input slot 内部消费）+ 消费方决定挂哪些 area-hook
 *   - 左/右栏 slot（playground 三栏 conv+chat+workspace / studio chat 单栏）→ base 只管 chat 主区
 *   - topbar 左/右内容、messages 内容、input bar 内容 → slot
 *   - model 持久化回调（session vs per-call）→ picker 在 input slot 内部
 *   - actor/filter/sideResolver → messagesSlot 内 ComponentMessageStream 配置
 *   - prefill / onOpenMember（studio 特有）→ 消费方局部 state
 *
 * 单文件 ≤300 行。
 */
import type { ReactNode } from 'react';
import { ComponentClearConfirmModal } from './component-clear-confirm-modal';

interface BaseChatPageProps {
  /** active session id（clear / compact 回调透传用） */
  sessionId: string | null;
  /** chrome / sessions 初始 loading（门控 chat-loading 占位；studio chrome 未到位时为 true） */
  loading?: boolean;
  /** topbar 左侧 slot（playground=空/标题；studio=avatar+tag；null/undefined → 不渲 topbar-left） */
  topbarLeft?: ReactNode;
  /** topbar 右侧 slot（UsagePanel+CompactBtn+ClearBtn 复合；消费方用 ComponentChatTopbarRight） */
  topbarRight?: ReactNode;
  /** 消息区 slot（ComponentMessageStream + empty fallback；消费方装配 area-hook 数据） */
  messagesSlot: ReactNode;
  /** 右缘 overlay slot（ComponentChatRightOverlay + ComponentChatFloatMenu；可选） */
  rightOverlaySlot?: ReactNode;
  /** input bar slot（BaseChatInputBar 消费方实例 / 群聊自定义） */
  inputSlot?: ReactNode;
  /** clear 行为（三页同形：打开 modal → 确认 → POST /session/:id/clear） */
  onClear?: () => void;
  /** clear modal 开关（消费方局部 state；base 不持） */
  clearModalOpen?: boolean;
  /** clear modal 开关变更（消费方局部 state setter；base 不持） */
  onClearModalChange?: (open: boolean) => void;
  /** 根元素 tagName（playground 用 <section> / studio 用 <main>）；缺省 'section' */
  rootTag?: 'section' | 'main';
  /** fadeIn 动画（studio 页用）；缺省 false */
  fadeIn?: boolean;
  /** 输入区显隐门控（playground idle/subagent readOnly 时为 false） */
  hideInputBar?: boolean;
}

/**
 * BaseChatPage：chat 主区骨架。
 *
 * 渲染结构：
 *   <$root flex-1 flex-col>
 *     {loading && <chat-loading>}
 *     {!loading && <>
 *       <div topbar> (border-b + shrink-0)
 *         <div left> {topbarLeft} </div>
 *         {topbarRight}
 *       </div>
 *       <div messages-wrapper flex-1 relative overflow-hidden>
 *         {messagesSlot}
 *         {rightOverlaySlot}
 *       </div>
 *       {!hideInputBar && inputSlot}
 *     </>}
 *     <ComponentClearConfirmModal open=clearModalOpen /> (modal；onClear 触发)
 *   </$root>
 *
 * loading 门控：true 时只渲 chat-loading 占位（不 mount topbar/messages/input/hooks；
 *   消费方 area-hooks 已在外层 chrome 门控 return 后才挂）。
 */
export function BaseChatPage({
  loading = false,
  topbarLeft,
  topbarRight,
  messagesSlot,
  rightOverlaySlot,
  inputSlot,
  onClear,
  clearModalOpen = false,
  onClearModalChange,
  rootTag = 'section',
  fadeIn = false,
  hideInputBar = false,
}: BaseChatPageProps) {
  // 根元素 className：flex-1 主区 + flex-col 垂直排 + relative（右缘 overlay 定位上下文）+ bg
  // v0.0.165：@keyframes fadeIn 已下线（严肃基调，无入场动效）；保留 fadeIn prop 兼容 caller 签名，
  //   但不再拼 animate class（INV-3 归零）。
  void fadeIn;
  const rootCls = 'flex-1 flex flex-col min-w-0 relative bg-bg';
  // 根元素 tagName 动态切（playground <section> / studio <main>；保持 testid 锚点稳定）
  const Root = rootTag;

  if (loading) {
    return (
      <Root className={rootCls}>
        <div className="flex flex-1 items-center justify-center text-[12px] text-muted">
          …
        </div>
      </Root>
    );
  }

  return (
    <Root className={rootCls}>
      {/* topbar：左 slot + 右 slot（border-b + shrink-0；右栏 ml-auto 推到右侧）。
          chat-topbar testid 保留 playground DOM 锚点（INV-A1-1，_overview §「沿用的 testid」） */}
      <div className="px-6 py-3 border-b border-border bg-surface-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">{topbarLeft}</div>
        {topbarRight}
      </div>

      {/* messages wrapper：flex-1 + relative + overflow-hidden（右缘 overlay 定位上下文） */}
      <div className="flex-1 flex flex-col relative min-h-0 min-w-0 overflow-hidden">
        {messagesSlot}
        {rightOverlaySlot}
      </div>

      {/* input bar slot（hideInputBar=true 时不渲；playground idle/subagent readOnly 用） */}
      {!hideInputBar && inputSlot}

      {/* clear 确认 modal（三页同款；onClearModalChange + onClear 由消费方注入） */}
      <ComponentClearConfirmModal
        open={clearModalOpen}
        onCancel={() => onClearModalChange?.(false)}
        onConfirm={() => {
          onClearModalChange?.(false);
          onClear?.();
        }}
      />
    </Root>
  );
}

export default BaseChatPage;
