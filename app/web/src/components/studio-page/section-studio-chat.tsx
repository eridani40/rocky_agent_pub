/**
 * section-studio-chat —— Studio 单/群聊薄壳（身份 header + 透传，会话能力全归 SectionChatSession）
 * 参考: specs/ui/components/studio-page/section-studio-chat.md（本组件契约）
 *       specs/ui/components/chat-page/section-chat-session.md（会话能力权威）
 *       specs/api/overall/04a-session-chrome.md（chrome 接口契约）
 *
 * 职责：单/群差异只剩 topbarLeft 身份 header（chrome.memberId 数据驱动，零 kind 分支）：
 *   - 单聊（memberId 命中 members）→ MemberAvatar(纯展示) + name + tag
 *   - 群聊（memberId 空/member 缺失兜底）→ 缺省 ChatSessionTopbarLeft（chrome.title=squad 名 + tag）
 *   群聊无 stop/两 picker 由后端 studio_group capabilities 驱动（v0.0.152 裁决），本组件不写分支。
 *
 * 边界：不挂 area-hooks/handler/HITL 接线；chrome 由 router 注入（防双拉，须稳定引用）；
 *   布局/SectionRightTabs 归 component-studio-chat-router.tsx。
 */
import { useTranslation } from 'react-i18next';
import type { SessionChromeView } from '../../lib/chat-api';
import type { MentionAttrs } from '../chat-page/chat-composer-extension';
import { SectionChatSession } from '../chat-page/section-chat-session';
import { MemberAvatar, type MemberAvatarRole } from '../common/member-avatar';

interface SectionStudioChatProps {
  /** studio chat session id（单聊 member session / 群聊 squadChat session） */
  sessionId: string;
  /** router 已拉的 chrome（注入 SectionChatSession 防双拉；useChatChrome ctx state 对象=稳定引用） */
  chrome: SessionChromeView;
  /** 初始内容预填（mention pill 数组 / 纯文本字符串，mount-time 注入；业务全景引导入口） */
  prefill?: MentionAttrs[] | string;
  /** 返回坐席面板回调；存在即渲返回键 */
  onBack?: () => void;
}

/**
 * Studio chat 薄壳：身份 header 两形态 + SectionChatSession 透传。
 * key={sessionId} remount 语义由 router 保证（本组件无自有 state）。
 */
export function SectionStudioChat({ sessionId, chrome, prefill, onBack }: SectionStudioChatProps) {
  const { t } = useTranslation('studio');
  // 对端 member：memberId 命中 members = 单聊；否则（群聊/数据不一致）走缺省 header 兜底
  const member = chrome.memberId ? chrome.members.find((m) => m.id === chrome.memberId) : undefined;

  // 单聊身份 header：角色头像纯展示（非编辑入口，不可点）+ name + tag
  const topbarLeft = member
    ? () => (
        <>
          <div className="flex items-center gap-2 px-2 py-1">
            <MemberAvatar
              name={member.name}
              role={member.role as MemberAvatarRole}
              id={member.id}
              size="sm"
              showName={false}
            />
            <span className="text-[13px] font-semibold text-fg">{member.name}</span>
          </div>
          {chrome.tag && (
            <span className="rounded-xs bg-bg-warm px-2 py-0.5 font-mono text-[11px] text-muted">{chrome.tag}</span>
          )}
        </>
      )
    : undefined; // 群聊：缺省 ChatSessionTopbarLeft（chrome.title=squad 名 + tag）

  return (
    <SectionChatSession
      sessionId={sessionId}
      chrome={chrome}
      topbarLeft={topbarLeft}
      onBack={onBack}
      backActionKey={member ? 'studio.member-chat.back' : 'studio.group-chat.back'}
      prefill={prefill}
      fadeIn
      rootTag="main"
      emptyStateSlot={
        <div className="flex-1 overflow-y-auto px-8 py-6">
          <div className="py-10 text-center text-[12.5px] text-muted">{t('chat.emptyHint')}</div>
        </div>
      }
    />
  );
}

export default SectionStudioChat;
