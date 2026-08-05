/**
 * primitive-mention-pill —— 内联 mention 胶囊渲染（输入区 + 消息区复用）
 * 参考: specs/ui/components/chat-page/mention-pill.md（v0.0.86 重写权威源）
 *       specs/tech/mention/message-content.md §3（display flat 属性）
 *
 * 职责：
 *   - 完全 type-agnostic（INV-2：无 if(type===) 分支）
 *   - 按 { icon, label, badge? } 三字段渲染，icon → Glyph registry → SVG
 *   - 内部把 label 视觉前置 "@" 前缀；data-mention-label 存裸名（E2E 断言契约）
 */

import type { ReactNode } from 'react';

/** MentionPill Props */
export interface MentionPillProps {
  /** glyph key（Glyph registry 已注册的 SVG key；如 'file' / 'skill' / 'goal' / 'member'） */
  icon: string;
  /** 显示文本（不含 @ 前缀，如 'helper.ts'；@ 前缀由本组件渲染时加） */
  label: string;
  /** 徽标 key（可空；当前仅 'leader' → 皇冠 SVG） */
  badge?: string;
  /** 删除回调（仅输入区 pill 需要；消息区 pill 只读不传） */
  onRemove?: () => void;
}

/**
 * Glyph registry —— icon key → SVG ReactNode 工厂（module 单例）。
 * 7 个 key：file/skill/member + goal/kr/requirement/task。
 * 视觉一致性：size 12×12 / strokeWidth 1.5 / currentColor，4 workitem 形状可区分。
 */
const GLYPHS: Record<string, () => ReactNode> = {
  // 文件 icon
  file: () => (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M9 1v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  ),
  // skill = 闪电
  skill: () => (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9 1L4 9h4l-1 6 5-8H8l1-6z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  ),
  // member = 头像
  member: () => (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M2.5 14c.5-2.5 2.7-4 5.5-4s5 1.5 5.5 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  // goal = 同心圆靶心
  goal: () => (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
    </svg>
  ),
  // kr = 条形进度
  kr: () => (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="3" width="13" height="3.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="1.5" y="9.5" width="13" height="3.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 4.75h7M3 11.25h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  // requirement = 清单
  requirement: () => (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 4l1.5 1.5L6 3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8 4h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="M2 10.5l1.5 1.5L6 9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8 10.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  // task = 卡片
  task: () => (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5 6.5h6M5 9h6M5 11.5h4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
};

/** Badge registry —— badge key → SVG（leader 皇冠） */
const BADGES: Record<string, () => ReactNode> = {
  leader: () => (
    <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2 5l3 2 3-4 3 4 3-2v7H2V5z" />
      <rect x="2" y="12.5" width="12" height="1.5" />
    </svg>
  ),
};

/**
 * Glyph helper：取注册的 SVG；未注册 key → fallback `<span>@</span>`（不抛错、不 crash）。
 */
export function Glyph({ name }: { name: string }): ReactNode {
  const factory = GLYPHS[name];
  if (factory) return factory();
  return <span className="text-[10px] font-bold leading-none">@</span>;
}

/**
 * Badge helper：取注册的徽标 SVG；未注册 → null（不渲染）。
 */
function Badge({ name }: { name: string }): ReactNode | null {
  const factory = BADGES[name];
  return factory ? factory() : null;
}

/**
 * 内联 mention 胶囊——输入区（Tiptap node view）和消息区（历史回放）共用。
 * 显示 `@{label}` 文本（@ 前缀由本组件加，data-mention-label 存裸名）。
 */
export function MentionPill({ icon, label, badge, onRemove }: MentionPillProps) {
  return (
    <span

      data-mention-icon={icon}
      data-mention-label={label}
      {...(badge ? { 'data-mention-badge': badge } : {})}
      className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent-surface)] px-2 py-0.5 text-[var(--color-accent)] align-baseline"
      // 输入区 pill 整颗删除由 Tiptap atom node 管理；onRemove 仅语义标记
      {...(onRemove ? { 'data-removable': 'true' } : {})}
    >
      <Glyph name={icon} />
      {badge ? <Badge name={badge} /> : null}
      <span className="text-xs font-medium leading-none">@{label}</span>
    </span>
  );
}

export default MentionPill;
