/**
 * component-empty-state —— 会话空态（v0.0.165 严肃化 idle hero）
 * 参考: specs/ui/components/chat-page/component-empty-state.md（v0.0.165 契约）
 *       specs/ui/regulation/03-principles.md §3（严肃基调：无 mascot / 无动画 / 无 emoji）
 *       reqs/[working] v0.0.165.ui_upgrade/design/playground-idle.html（视觉权威源，main :85-105 + 顶部 style）
 *       specs/tech/version_logs/v0.0.165/change_plan.md §5
 *
 * 视觉结构（对齐设计稿）：
 *   hero-orb (80×80 --brand-grad + 36px 白色 ChatIcon)
 *   ↓ mb-7
 *   hero-eyebrow ("Playground" mono 11px uppercase muted-2 tracking 0.24em)
 *   ↓ mb-2.5
 *   hero-sub (14px muted 居中 max-w-[400px])
 *   ↓ mb-6
 *   CTA h-[46px] 黑底白字 + PlusIcon（testid `idle-new-conv-cta` 沿用）
 *   ↓ mt-7
 *   quick-row：3 个胶囊（分析一个文件 / 查资料并总结 / 帮我写代码，彩点分别 blue/green/violet）
 *
 * 严肃基调守则（INV-3/INV-4）：无 animate class、无 emoji、无 font-serif、无装饰性动效；orb 是静态渐变块。
 * 交互决策（coder 定位）：quick-chip 点击 = 触发 onNewConversation（等同主 CTA）——用户裁决「点等同主 CTA 或纯展示皆可，不发明新功能」，取功能一致更利用户。
 */
import { useTranslation } from 'react-i18next';
import { ChatIcon, PlusIcon } from './icons';

export interface ComponentEmptyStateProps {
  /** 点击 CTA / quick-chip 时触发（= conv-new-btn 同 handler → page-chat handleCreate） */
  onNewConversation: () => void;
}

interface QuickChipDef {
  id: 'file' | 'research' | 'code';
  labelKey: 'chipFile' | 'chipResearch' | 'chipCode';
  dotColorVar: string; // 走 var(--hue-*) 语义色，不用 hex
}

const QUICK_CHIPS: readonly QuickChipDef[] = [
  { id: 'file', labelKey: 'chipFile', dotColorVar: 'var(--hue-blue)' },
  { id: 'research', labelKey: 'chipResearch', dotColorVar: 'var(--hue-green)' },
  { id: 'code', labelKey: 'chipCode', dotColorVar: 'var(--hue-violet)' },
];

/**
 * 会话空态：idle hero（orb + eyebrow + sub + CTA + quick-row）。
 * 严肃基调（regulation 03 §3）：无装饰动画、无 emoji；orb 是静态渐变块非动效。
 */
export function ComponentEmptyState({ onNewConversation }: ComponentEmptyStateProps) {
  const { t } = useTranslation('chat');
  return (
    <div

      className="flex-1 flex flex-col items-center justify-center px-8 py-8"
    >
      {/* hero-orb 80×80，brand 渐变 + 白色 ChatIcon 36px（品牌唯一大彩色区） */}
      <div

        className="w-20 h-20 rounded-[22px] flex items-center justify-center mb-7"
        style={{
          background: 'var(--brand-grad)',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        <ChatIcon size={36} className="text-white" aria-hidden />
      </div>

      {/* hero-eyebrow：Playground（品牌 mono 小字） */}
      <div

        className="font-mono text-[11px] uppercase mb-2.5"
        style={{
          color: 'var(--muted-2)',
          letterSpacing: '0.24em',
        }}
      >
        {t('emptyState.eyebrow')}
      </div>

      {/* hero-sub：引导副文案（14px muted 居中） */}
      <div

        className="text-[14px] text-center max-w-[400px] mb-6"
        style={{ color: 'var(--muted)' }}
      >
        {t('emptyState.subtitle')}
      </div>

      {/* CTA：主动作（黑底白字 + PlusIcon，testid 沿用 ET 兼容） */}
      <button
        type="button"
        data-action-key="chat.session.create"
        aria-label={t('emptyState.newConversation')}
        onClick={onNewConversation}
        className="inline-flex items-center gap-2 h-[46px] px-6 rounded-lg text-[14px] font-semibold cursor-pointer border-none transition-colors"
        style={{
          background: 'var(--btn-primary-bg)',
          color: 'var(--btn-primary-fg)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--btn-primary-hover)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'var(--btn-primary-bg)';
        }}
      >
        <PlusIcon size={16} strokeWidth={2.4} />
        {t('emptyState.newConversation')}
      </button>

      {/* quick-row：3 个胶囊快捷入口（彩点点缀 + 文案）；点击等同新建会话 */}
      <div

        className="flex gap-2.5 mt-7"
      >
        {QUICK_CHIPS.map((chip) => (
          <button
            key={chip.id}
            type="button"

            onClick={onNewConversation}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[12.5px] cursor-pointer transition-[border-color,box-shadow]"
            style={{
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--fg-3)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-2)';
              e.currentTarget.style.boxShadow = 'var(--shadow-xs)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--border)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            <span
              aria-hidden
              className="inline-block w-2 h-2 rounded-[3px]"
              style={{ background: chip.dotColorVar }}
            />
            {t(`emptyState.${chip.labelKey}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

export default ComponentEmptyState;
