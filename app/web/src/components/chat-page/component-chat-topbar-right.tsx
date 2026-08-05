/**
 * component-chat-topbar-right —— topbar 右侧复合（UsagePanel + 分隔符 + CompactBtn + ClearBtn）
 * 参考: specs/ui/components/chat-page/_overview.md §4.4（topbar 右侧布局）
 *       specs/tech/version_logs/v0.0.155/change_plan.md 段 E（INV-E4 topbar-right DRY）
 *
 * 三 chat 页（playground / studio 单聊 / studio 群聊）共用：右侧 token 用量 + compact + clear
 * 三件套。biz（按钮 click handler）由消费方注入；本组件不含任何 store / chrome 逻辑。
 *
 * 约定：
 *   - readOnly 分支由消费方通过 `hideClear` 控制（playground subagent 只读页隐藏 ClearBtn）
 *   - 群聊不订 summaryTask → 消费方传 summaryTask=null, sessionBusy=false（CompactBtn disabled 仅看 summaryTask.running）
 *   - ClearBtn 点击只回调，不开 modal（modal 由 BaseChatPage 统一挂）
 */
import type { SessionUsageView, SummaryTaskStatus } from './types';
import { emptyUsage } from './empty-usage';
import { ComponentUsagePanel, CompactBtn, ClearBtn } from './component-usage-panel';

interface ComponentChatTopbarRightProps {
  /** usage 快照（null 用 emptyUsage 占位，避免圆环崩） */
  usage: SessionUsageView | null;
  /** summaryTask 快照（null = idle 兜底；群聊不订，固定 null） */
  summaryTask: SummaryTaskStatus | null;
  /**
   * session.state ∈ {running, interrupting}（兼容 caller 透传，CompactBtn 内部忽略——任何
   * session.state 都能 compact）。保留入参维持调用签名稳定。
   */
  sessionBusy: boolean;
  /** 点 compact → POST /session/:id/compact（caller 实现并注入） */
  onCompact: () => void;
  /** 点 clear → 弹确认 modal（由 BaseChatPage 统一挂载；本组件只回调） */
  onClear: () => void;
  /** 隐藏 ClearBtn（readOnly 分支：playground subagent 只读页不可清空） */
  hideClear?: boolean;
}

/**
 * topbar 右侧复合组件：UsagePanel + 分隔符 + CompactBtn + ClearBtn。
 * 三 chat 页共用（INV-E4），biz 由消费方注入。
 */
export function ComponentChatTopbarRight({
  usage,
  summaryTask,
  sessionBusy,
  onCompact,
  onClear,
  hideClear = false,
}: ComponentChatTopbarRightProps) {
  return (
    <div className="ml-auto flex items-center gap-2 shrink-0">
      <ComponentUsagePanel usage={usage ?? emptyUsage} />
      <div className="w-px h-[18px] bg-border mx-1 shrink-0" />
      <CompactBtn summaryTask={summaryTask} sessionBusy={sessionBusy} onClick={onCompact} />
      {!hideClear && <ClearBtn onClick={onClear} />}
    </div>
  );
}

export default ComponentChatTopbarRight;
