/**
 * academy-hero —— Academy 空态 hero（demo 01：grad icon + 标题 + 3 卡 + CTA）
 * 参考: specs/ui/components/academy-page/page-academy.md（classroom-list 空态）
 *       demo index.html
 * 从 page-academy 拆出（保 page ≤300 行）。
 */
import { useTranslation } from 'react-i18next';
import { BTN_PRIMARY, CARD } from './academy-styles';

/** 空态 hero */
export function AcademyHero({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation('academy');
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-[14px] p-10 text-center bg-bg overflow-y-auto">
      <div className="w-[72px] h-[72px] rounded-[20px] flex items-center justify-center text-[36px] shadow-lg" style={{ background: 'var(--brand-grad)' }}>
        🎓
      </div>
      <h1 className="text-[20px] font-semibold text-fg">{t('hero.title')}</h1>
      <p className="text-[13px] text-muted max-w-[460px] leading-[1.7]">{t('hero.desc')}</p>
      <div className="flex gap-[14px] mt-2.5">
        {([
          { icon: '👩‍🏫', title: t('hero.card1Title'), desc: t('hero.card1Desc') },
          { icon: '📈', title: t('hero.card2Title'), desc: t('hero.card2Desc') },
          { icon: '🌳', title: t('hero.card3Title'), desc: t('hero.card3Desc') },
        ]).map((c) => (
          <div key={c.title} className={`${CARD} w-[220px] p-4 text-left`}>
            <div className="text-[22px] mb-2">{c.icon}</div>
            <h3 className="text-[13.5px] font-semibold text-fg mb-1">{c.title}</h3>
            <p className="text-[12px] text-muted leading-[1.55]">{c.desc}</p>
          </div>
        ))}
      </div>
      <button type="button" data-action-key="academy.classroom.create" onClick={onCreate} className={`${BTN_PRIMARY} mt-[18px] h-[34px] px-[18px]`}>
        {t('hero.createBtn')}
      </button>
    </div>
  );
}

/** 加载占位 */
export function LoadingHint({ text }: { text: string }) {
  return <div className="flex-1 flex items-center justify-center text-[12px] text-muted bg-bg">{text}</div>;
}
