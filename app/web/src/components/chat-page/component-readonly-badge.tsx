/**
 * component-readonly-badge —— subagent 只读标识 tag
 * 参考: specs/ui/components/chat-page/_overview.md §4.3（readOnly mode topbar 视觉标识）+ §8（id-tag.id-subagent 视觉基线）
 *       reqs/v0.0.28/easy-opc-squad-v10.html .id-tag.id-subagent（设计稿视觉权威源）
 *
 * 仅统一装配层（SectionChatSession）readOnly mode（session.type==='subagent'）时在 topbar chat-title 后渲染。
 * 视觉契约（对照设计稿 .id-tag.id-subagent，_overview §4.3/§8）：
 *   - 底色 var(--info-bg) / 文字 var(--info)（regulation §1.5 info 语义蓝）
 *   - JetBrains Mono 9px/600 uppercase
 *   - 文案走 i18n（chat.readonlyBadge，zh「子AGENT · 只读」/ en「SUBAGENT · READ-ONLY」）
 *
 * testid: chat-readonly-badge（_overview §7，ET UC-28.2 锚点）
 */
import { useTranslation } from 'react-i18next';

interface ReadonlyBadgeProps {
  /** 可覆盖文案（缺省走 chat.readonlyBadge i18n key） */
  label?: string;
}

/**
 * subagent 只读标识 tag。
 * readOnly mode 时由 SectionChatSession topbar 挂载（chat-title 后）。
 */
export function ComponentReadonlyBadge({ label }: ReadonlyBadgeProps) {
  const { t } = useTranslation('chat');
  const text = label ?? t('readonlyBadge');
  return (
    <span

      className="id-tag id-subagent inline-flex items-center font-mono font-semibold uppercase ml-2 px-1.5 py-0.5 rounded text-[9px] leading-none tracking-wide shrink-0"
      style={{
        // info 语义色底 + 字（regulation 01 §1.5）
        backgroundColor: 'var(--info-bg)',
        color: 'var(--info)',
      }}
    >
      {text}
    </span>
  );
}

export default ComponentReadonlyBadge;
