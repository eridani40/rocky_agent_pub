/**
 * academy-styles —— academy-page 共享 tailwind 样式常量（对齐 demo `_tokens.css` 通用元素）
 * 参考: demo `_tokens.css`（.btn / .btn-primary / .btn-sm / .btn-ghost / .card / .icon-btn）
 *       specs/ui/regulation/01-tokens.md（银灰 token 权威）
 *
 * 与 studio-styles.ts 同范式：纯字符串常量，组件内拼接，避免每处重写 btn/card 长类串。
 */

/** btn 基座（demo .btn：h-30 p-0/12 rounded-md 12.5px/500 border surface → hover accent-light） */
const BTN_BASE =
  'inline-flex items-center justify-center gap-1.5 h-[30px] px-3 rounded-md text-[12.5px] font-medium transition-colors whitespace-nowrap cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed';

/** 次按钮（白底边框；demo .btn 默认态） */
export const BTN_SECONDARY = `${BTN_BASE} border border-border bg-surface text-fg hover:bg-accent-light hover:border-border-2`;

/** 主按钮（黑底白字；demo .btn-primary） */
export const BTN_PRIMARY = `${BTN_BASE} border border-accent bg-accent text-white hover:bg-accent-hover hover:border-accent-hover`;

/** ghost 按钮（无边框 muted；demo .btn-ghost） */
export const BTN_GHOST = `${BTN_BASE} border border-transparent bg-transparent text-muted hover:bg-accent-light hover:text-fg`;

/** danger ghost（demo .btn-danger-ghost） */
export const BTN_DANGER_GHOST = `${BTN_BASE} border border-transparent bg-transparent text-danger hover:bg-danger-light`;

/** sm 尺寸修饰（demo .btn-sm：h-26 p-0/9 12px） */
export const BTN_SM = 'h-[26px] px-[9px] text-[12px]';

/** icon-btn（demo .icon-btn：28×28 rounded-md muted → hover accent-light） */
export const ICON_BTN =
  'w-7 h-7 rounded-md inline-flex items-center justify-center text-muted transition-colors flex-shrink-0 cursor-pointer hover:bg-accent-light hover:text-fg';

/** card 容器（demo .card：surface + 1px border + rounded-xl） */
export const CARD = 'bg-surface border border-border rounded-xl';

/** 输入框（demo .input：h-32 p-0/10 border rounded-md；focus accent + shadow-focus） */
export const INPUT =
  'w-full h-8 px-2.5 border border-border rounded-md bg-surface text-[13px] text-fg transition-[border-color,box-shadow] duration-150 focus:outline-none focus:border-accent focus:shadow-[var(--shadow-focus)]';

/** 多行输入（demo .textarea） */
export const TEXTAREA =
  'w-full px-2.5 py-2 border border-border rounded-md bg-surface text-[13px] text-fg leading-normal resize-y transition-[border-color,box-shadow] duration-150 focus:outline-none focus:border-accent focus:shadow-[var(--shadow-focus)]';

/** 分组 label（demo .side-label：11px/600 muted-2 uppercase） */
export const SIDE_LABEL = 'text-[11px] font-semibold text-muted-2 uppercase tracking-wider';

/** avatar 基座（demo .avatar：圆形白字 600；尺寸/背景由调用方补） */
export const AVATAR_BASE =
  'rounded-full inline-flex items-center justify-center text-white font-semibold flex-shrink-0';
