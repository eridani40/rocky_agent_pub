/**
 * component-session-readonly —— subagent 只读 transcript 视图（gold banner + chat 列 readOnly）
 * 参考: specs/ui/components/academy-page/page-academy.md（session-readonly 路由，design §8.8）
 * chat 列 = SectionChatSession：chrome.readOnly（derivation==='subagent'）自动只读，
 * prop readOnly 冗余保留作双保险（无输入区/picker/HITL/stop）。
 * 从 page-academy 拆出（保 page ≤300 行）。
 */
import { useTranslation } from 'react-i18next';
import type { AcademyRoute } from '../../store/academy-slice';
import { SectionChatSession } from '../chat-page/section-chat-session';
import { ComponentAcademyChatHeader } from './component-academy-chat-header';

/** subagent 只读 transcript */
export function SessionReadonlyView({ route, onBack }: {
  route: Extract<AcademyRoute, { kind: 'session-readonly' }>;
  onBack: () => void;
}) {
  const { t } = useTranslation('academy');
  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
      <div className="px-[18px] py-2 bg-gold-bg text-[#b45309] text-[12px] flex items-center gap-2 shrink-0">
        {t('readonly.banner')}
      </div>
      {/* chat 包装：水平 flex + min-h-0——BaseChatPage 按 row 子项 stretch 设计，
          直接作 flex-col 子项会 min-height:auto 撑高致 transcript 失去滚动（_overview §2） */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <SectionChatSession
          sessionId={route.sessionId}
          readOnly
          onBack={onBack}
          backActionKey="academy.chat.back"
          topbarLeft={() => (
            <ComponentAcademyChatHeader
              avatarText="S"
              avatarBg="var(--color-indigo)"
              title={route.title ?? t('readonly.title')}
            />
          )}
        />
      </div>
    </div>
  );
}

export default SessionReadonlyView;
