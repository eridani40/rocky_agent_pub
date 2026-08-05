/**
 * picker-menu-header —— chat-input 三个 picker click 菜单顶部的统一题目行
 * 参考: specs/ui/components/chat-page/component-input-{model,effort,approval-mode}-picker.md
 *
 * 统一 UI（v0.0.148 picker UI 统一优化）：三个 input picker 的 click 菜单
 *   顶部各加一行题目（模型选择 / 推理强度 / 审批模式），解决「只有选项不知道选的啥」。
 *   样式单点定义于此，所有 picker 共用以保证视觉一致。
 *
 * 职责：渲染一行 muted 小字题目 + 底部分割线，与下方选项视觉分离。
 *   仅用于 click 菜单（hover 预览是单条当前项，不加题目保持轻量）。
 */

interface PickerMenuHeaderProps {
  /** 题目文案（caller 已用 t() 解析后传入） */
  title: string;
}

/**
 * 题目行统一样式：
 *   text-xs muted（视觉弱于选项 text-sm text-fg）+ 底部分割线 border-b + mb-1 与选项留白。
 *   select-none 题目不可选中（非交互项）。
 */
const HEADER_CLS = 'px-3 py-1.5 text-xs text-muted select-none border-b border-border mb-1';

/** PickerMenuHeader —— picker click 菜单顶部统一题目行 */
export function PickerMenuHeader({ title }: PickerMenuHeaderProps) {
  return (
    <div className={HEADER_CLS} role="heading" aria-level={2}>
      {title}
    </div>
  );
}

export default PickerMenuHeader;
