/**
 * studio-styles —— Studio 页共享 Tailwind class 常量（消除跨表单的重复长串）
 * 参考: reqs/[done] v0.0.33.1/studio-main.html / role-panel.html / charter-editor.html 的 .input/.textarea/.btn/.choice
 *       specs/tech/app/frontend/[P0]design_system.md（token）
 *
 * 全部用 design token（accent/border/surface 等），不硬编码 hex（focus 光晕用 --shadow-focus）。
 * 纯字符串常量模块（无组件），供 studio-page 下各表单组件复用，保证视觉一致。
 */

/** 字段 label：mono 小字 + 大写 + 字距（设计稿 .field-label） */
export const FIELD_LABEL = 'mb-1.5 block font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-2';

/** 字段副提示（设计稿 .field-hint） */
export const FIELD_HINT = 'mt-1.5 font-mono text-[11px] text-muted';

/** 文本输入（设计稿 .input：10px 圆角 + surface-2 底 + border-2 + focus accent 光晕） */
export const INPUT =
  'w-full rounded-lg border border-border-2 bg-surface-2 px-3 py-2.5 text-[13px] text-fg outline-none transition-colors focus:border-accent focus:shadow-[var(--shadow-focus)] disabled:opacity-55 disabled:cursor-not-allowed';

/** 多行文本（设计稿 .textarea：mono + 自适应高度） */
export const TEXTAREA =
  'w-full min-h-16 resize-y rounded-lg border border-border-2 bg-surface-2 px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-fg outline-none transition-colors focus:border-accent focus:shadow-[var(--shadow-focus)] disabled:opacity-55 disabled:cursor-not-allowed';

/** 按钮基类（设计稿 .btn：border-radius:8px → rounded-md） */
const BTN_BASE =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3.5 py-2 text-xs font-semibold transition-colors';

/** 主 CTA（accent 实底，设计稿 .btn-primary） */
export const BTN_PRIMARY = `${BTN_BASE} bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed`;

/** 次按钮（描边，设计稿 .btn-secondary） */
export const BTN_SECONDARY = `${BTN_BASE} border border-border-2 bg-surface-2 text-fg-3 hover:border-accent hover:text-accent`;

/** 危险按钮（bench/确认下岗，设计稿 .btn-danger） */
export const BTN_DANGER = `${BTN_BASE} bg-danger text-white hover:brightness-110`;

/** 幽灵按钮（编辑/链接式，设计稿 .btn-ghost） */
export const BTN_GHOST =
  'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-2 transition-colors hover:bg-bg-warm hover:text-fg-2';

/** 选项卡片基类（设计稿 .choice，单选/多选共用） */
export const CHOICE_BASE =
  'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-[12.5px] transition-colors';

/** 选项卡片选中态（accent 边 + 浅底） */
export const CHOICE_ON = 'border-accent bg-accent-surface text-accent font-semibold';

/** 选项卡片未选态 */
export const CHOICE_OFF = 'border-border-2 bg-surface-2 text-fg-2 hover:border-border-strong';
