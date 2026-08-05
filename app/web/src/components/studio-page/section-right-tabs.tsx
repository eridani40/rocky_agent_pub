/**
 * section-right-tabs —— studio leader/mate/squad chat 右侧区域（薄 wrapper）
 * 参考: specs/ui/components/studio-page/section-right-tabs.md（契约权威）
 *
 * 职责：
 *   - 仅保留外层 <aside> wrapper（squad-right-tabs testid + data-workspace-semantic 标记）
 *   - 无条件渲染 <SectionWorkspacePanel>——后者自带 ComponentWsTabBar（唯一 tab bar，
 *     仅「工作区」单栏；记忆/定时任务在右上悬浮菜单）
 *   - 透传三栏引擎 4 可选 props 到 SectionWorkspacePanel（与 playground page-chat 同套）
 *
 * 注：workspace 语义 prop 仅作 AT 断言/UI 提示用（不影响渲染）。
 */
import { SectionWorkspacePanel } from '../chat-page/section-workspace-panel';

export interface SectionRightTabsProps {
  /** 当前 session id（leader / mate / squad 各自 sessionId） */
  sessionId: string;
  /**
   * workspace 语义（仅 AT 断言/UI 提示用，不影响渲染分支）：
   *   - 'team'（leader/squad 群聊）= 团队工作区
   *   - 'personal'（mate）= 个人工作区
   */
  workspaceSemantic: 'team' | 'personal';
  // ── 三栏引擎接线（4 可选 props，原样透传 SectionWorkspacePanel） ──
  /** 父引擎钳制后的渲染宽（优先于 ws-panel 内部 width state） */
  renderWidth?: number;
  /** 拖宽动态上限（dragDynMax(available, leftCurrent)，缺省回退静态 WS_WIDTH_MAX） */
  dragMaxWidth?: number;
  /** 上报 {settingWidth, collapsed}（父用回收设定宽 + 切场景 B 时 hold） */
  onLayoutChange?: (report: { settingWidth: number; collapsed: boolean }) => void;
  /** 拖拽模式切换（父挂 setDragging('right') 进场景 A） */
  onDragModeChange?: (dragging: boolean) => void;
}

/**
 * Studio 右侧区域薄 wrapper（leader/mate/squad chat 共用）。
 * tab bar + 内容全交由 SectionWorkspacePanel 提供（仅工作区单栏）。
 *
 * 4 可选 props 原样透传 SectionWorkspacePanel——未传时 ws-panel 内部 state 自管。
 */
export function SectionRightTabs({
  sessionId,
  workspaceSemantic,
  renderWidth,
  dragMaxWidth,
  onLayoutChange,
  onDragModeChange,
}: SectionRightTabsProps) {
  return (
    <aside

      data-workspace-semantic={workspaceSemantic}
      className="flex shrink-0 min-w-0"
    >
      <SectionWorkspacePanel
        sessionId={sessionId}
        renderWidth={renderWidth}
        dragMaxWidth={dragMaxWidth}
        onLayoutChange={onLayoutChange}
        onDragModeChange={onDragModeChange}
      />
    </aside>
  );
}

export default SectionRightTabs;
