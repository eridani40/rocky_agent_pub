/**
 * component-group-chat-toggle —— squad 群聊可见性开关（enableGroupChat）
 * 参考: specs/tech/version_logs/v0.0.270/change_plan.md（ui-autowork GroupChatToggle）
 *       specs/tech/version_logs/v0.0.316/change_plan.md P0（受控化——攒入 ManageTab dirty/save）
 *
 * 职责：开/关 squad.enableGroupChat。开（默认）→ agents 注入 SquadChat + UI 群聊入口可见；
 *   关 → reachable_agents squadChatRef 不构造（system prompt + system_reminder 两头无 SquadChat）
 *   + SeatCard 群聊按钮隐藏 + send_message('squadchat') 报错。squad 实体恒存在，仅控可见性。
 * v0.0.316: 改为受控组件——去掉 squadId/onPatch/pending/error，由 ManageTab 管理状态 + 统一 save。
 */
import { useTranslation } from 'react-i18next';
import { FIELD_LABEL, FIELD_HINT } from './studio-styles';

interface GroupChatToggleProps {
  /** 当前开关状态（由 ManageTab draft state 控制） */
  enableGroupChat: boolean;
  /** 切换回调（ManageTab 更新 draft state → 攒入 dirty → 统一 save） */
  onChange: (enableGroupChat: boolean) => void;
}

/** 群聊可见性开关（受控） */
export function GroupChatToggle({ enableGroupChat, onChange }: GroupChatToggleProps) {
  const { t } = useTranslation('studio');

  const on = enableGroupChat;

  return (
    <div className="flex flex-col gap-1.5">
      <label className={FIELD_LABEL}>{t('groupChat.label')}</label>
      <div className="flex items-center gap-3">
        {/* toggle 控件本体（点击目标） */}
        <button
          type="button"
          data-action-key="studio.squad.toggle-group-chat"
          role="switch"
          aria-checked={on}
          onClick={() => onChange(!on)}
          className={
            'relative inline-flex h-5 w-9 items-center rounded-full transition-colors ' +
            (on ? 'bg-accent' : 'bg-border-strong')
          }
        >
          <span
            className={
              'inline-block h-4 w-4 transform rounded-full bg-white transition-transform ' +
              (on ? 'translate-x-4' : 'translate-x-0.5')
            }
          />
        </button>
        <span className={FIELD_HINT + ' mt-0'}>
          {on ? t('groupChat.on') : t('groupChat.off')}
        </span>
      </div>
      {/* hint 说明行（关闭影响：注入 + UI 入口 + send_message 门控） */}
      <span className={FIELD_HINT}>{t('groupChat.hint')}</span>
    </div>
  );
}

export default GroupChatToggle;
