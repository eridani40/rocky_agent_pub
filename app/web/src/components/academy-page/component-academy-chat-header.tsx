/**
 * component-academy-chat-header —— academy 会话身份 header（SectionChatSession topbarLeft 注入用）
 * 参考: specs/ui/components/academy-page/component-academy-chat-header.md
 *
 * 纯展示：渐变 avatar 字 + 标题 + 可选状态行 + 可选右侧 mono tag，
 * markup 与旧 academy chat 列（v0.0.216 已删）的 topbarLeft 段逐行等价（视觉零变化）。
 */
import type { ReactNode } from 'react';
import { AVATAR_BASE } from './academy-styles';

interface AcademyChatHeaderProps {
  /** avatar 单字（'班' / '教' / 学生首字 / 'S'） */
  avatarText: string;
  /** avatar 背景渐变；缺省 var(--brand-grad) */
  avatarBg?: string;
  title: string;
  /** 状态行（如「● 在线」sage）；缺省不渲 */
  statusLine?: ReactNode;
  /** 右侧 mono tag（如 'academy-coach'）；缺省不渲 */
  tag?: string;
}

/** academy 会话身份 header（纯展示，四 chat 消费方共用） */
export function ComponentAcademyChatHeader({ avatarText, avatarBg, title, statusLine, tag }: AcademyChatHeaderProps) {
  return (
    <>
      <span
        className={`${AVATAR_BASE} w-7 h-7 text-[12px]`}
        style={{ background: avatarBg ?? 'var(--brand-grad)' }}
      >
        {avatarText}
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-fg truncate">{title}</div>
        {statusLine}
      </div>
      {tag && (
        <span className="ml-auto inline-flex items-center h-5 px-[7px] rounded-sm text-[11px] font-medium font-mono bg-surface-2 text-muted">
          {tag}
        </span>
      )}
    </>
  );
}

export default ComponentAcademyChatHeader;
