/**
 * primitive-academy-tab —— 教室详情右栏 tab 切换（下划线式激活态）
 * 参考: specs/ui/components/academy-page/primitive-academy-tab.md
 *       demo 02-classroom-detail.html `.tabs / .tab`（h-34 + p-0/13 + border-b-2）
 *
 * 只切内容（本地 activeId 由父级受控），不改 route；纯文字 + 可选计数 tag。
 */

/** tab 项定义 */
export interface AcademyTab {
  id: string;
  label: string;
  /** 计数 tag（如「2 进行中」），tone 决定配色 */
  countTag?: { text: string; tone: 'gold' | 'muted' | 'sage' };
}

interface Props {
  tabs: AcademyTab[];
  activeId: string;
  onChange: (id: string) => void;
}

/** 计数 tag 配色（demo tag-gold/tag-muted/tag-sage） */
const TAG_TONE_CLS: Record<NonNullable<AcademyTab['countTag']>['tone'], string> = {
  gold: 'bg-gold-bg text-[#b45309]',
  muted: 'bg-surface-2 text-muted',
  sage: 'bg-sage-bg text-sage',
};

/** 教室详情右栏 tab 栏（demo .tabs：flex + gap-2 + bottom border） */
export function PrimitiveAcademyTab({ tabs, activeId, onChange }: Props) {
  return (
    <div className="flex gap-0.5 border-b border-border">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(tab.id)}
            className={
              'h-[34px] px-[13px] inline-flex items-center text-[13px] font-medium -mb-px border-b-2 transition-colors ' +
              (active
                ? 'text-fg border-accent'
                : 'text-muted border-transparent hover:text-fg')
            }
          >
            {tab.label}
            {tab.countTag && (
              <span className={`ml-1 inline-flex items-center h-5 px-[7px] rounded-sm text-[11px] font-medium ${TAG_TONE_CLS[tab.countTag.tone]}`}>
                {tab.countTag.text}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** 便于默认导入 */
export default PrimitiveAcademyTab;
