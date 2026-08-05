/**
 * component-impl-config-btn — impl 卡片的齿轮配置入口（radio/checkbox/ordered 共用）
 * 参考: 设计稿视觉基线 reqs/v0.0.5/easy-opc-config-center-v4.html .impl-config-btn（§9）
 *       specs/ui/components/plugin-config-page/component-impl-config-btn.md
 *
 * 职责：impl 带 configSchema 时，卡片右侧显示 28×28 齿轮按钮，点击触发父级 onConfig
 * （父级挂载 component-schema-config-modal）。testid 沿用 ext-impl-config-btn-{implId}（ET 锚点）。
 * 边界：只管点击转发 + 视觉；不感知 modal 开合（父级管）。
 *
 * 视觉基线（.impl-config-btn）：28×28，rounded-md，border border-2 + bg-surface + muted-2 齿轮；
 * hover → accent 边框/字/accent-surface 底。
 *
 * [v0.0.71 D4] 父级 component-ext-impl-{radio,checkbox,ordered} 在 disabled=true 时容器带
 *   `opacity-60 pointer-events-none`（v0.0.67 整页只读化）。
 *
 *   齿轮按钮可点击性根因（ET P3 hard fail 修正）：
 *   - Playwright `enabled` actionability 检查 = `getAriaDisabled(element)`，**不看 CSS
 *     pointer-events**，看 `hasExplicitAriaDisabled` 祖先链。`<button>` 的 role="button" 在
 *     `kAriaDisabledRoles` 列表 → 读自身 `aria-disabled` 属性；本按钮无该属性 → 函数递归
 *     向上找祖先。祖先 `<label aria-disabled={disabled || undefined}>`（v0.0.67 整页只读
 *     disabled=true 时设 `aria-disabled="true"`）→ 递归命中 → 返回 true → 齿轮按钮被判
 *     disabled → click 失败。
 *   - `hasExplicitAriaDisabled` 在 `aria-disabled="false"` 时**短路 return false**（不递归
 *     祖先）。故本按钮自身显式 `aria-disabled="false"` 即可阻断祖先 label 的
 *     `aria-disabled="true"` 污染。
 *   - `pointer-events-auto` 仅覆盖父级 CSS `pointer-events:none` 让真实鼠标点击可触发
 *     （Playwright enabled 不看 CSS pointer-events，但保留此 className 仍对真实鼠标有意义）。
 *   点击事件本身已 preventDefault + stopPropagation 隔离冒泡，不会触发父级 label/input 的 onChange。
 */
import { useTranslation } from 'react-i18next';

export interface ComponentImplConfigBtnProps {
  implId: string;
  /** 点击齿轮 → 父级打开 schema config modal */
  onClick: (implId: string) => void;
}

/** 齿轮配置按钮（radio/checkbox/ordered impl 卡片共用）。 */
export function ComponentImplConfigBtn({ implId, onClick }: ComponentImplConfigBtnProps) {
  // [v0.0.62 i18n] aria/title 走 plugin-config ns
  const { t } = useTranslation('plugin-config');
  return (
    <button
      type="button"
      data-action-key="plugin.impl.configure"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(implId);
      }}
      aria-label={t('implConfig.ariaLabel')}
      title={t('implConfig.title')}
      // [v0.0.71 T6] aria-disabled="false"：显式短路 Playwright hasExplicitAriaDisabled 祖先链。
      //   祖先 label 在 v0.0.67 整页只读（disabled=true）时带 aria-disabled="true"，会污染本按钮
      //   的 enabled 判定（getAriaDisabled 递归祖先）；自身显式 aria-disabled="false" 阻断递归。
      //   开 readOnly modal 的入口本身不能 disabled（modal 内字段才 readOnly）。
      aria-disabled={false}
      // [v0.0.71 D4] pointer-events-auto：覆盖父级 pointer-events-none（v0.0.67 整页只读）让真实鼠标可点击。
      className="shrink-0 pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md border border-border-2 bg-surface text-muted-2 hover:border-accent hover:text-accent hover:bg-accent-surface transition-colors"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </button>
  );
}

export default ComponentImplConfigBtn;
