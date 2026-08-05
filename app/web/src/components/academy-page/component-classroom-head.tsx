/**
 * component-classroom-head —— 教室详情头部（logo + 名 + N 学生 tag + ⚙ + tabs）
 * 参考: specs/ui/components/academy-page/section-classroom-detail.md（cls-head）
 *       demo 02-classroom-detail.html
 *
 * 从 section-classroom-detail 拆出（保 section ≤300 行）；改名 inline input 状态由父级持。
 */
import { useTranslation } from 'react-i18next';
import { PrimitiveAcademyTab } from './primitive-academy-tab';
import { PrimitiveStatusBadge } from './primitive-status-badge';
import { BTN_SECONDARY, BTN_SM, INPUT } from './academy-styles';

/** 教室 logo 底色（与 sidebar 同款 violet） */
export const CLS_LOGO_BG = 'var(--hue-violet-bg)';

interface Props {
  logo?: string;
  name: string;
  studentCount: number;
  renaming: boolean;
  renameVal: string;
  onRenameChange: (v: string) => void;
  onRenameSubmit: () => void;
  onRenameStart: () => void;
  onRenameCancel: () => void;
  tabs: Array<{ id: string; label: string; countTag?: { text: string; tone: 'gold' } }>;
  activeTab: string;
  onTabChange: (id: string) => void;
  /**
   * 教室级默认模型 slot（可选；由父级填 InputModelPicker/ModelPicker 实例）。
   * 渲染位置：学生数 badge 之后、spacer 之前（demo 02 head 同款布局）。
   */
  defaultModelSlot?: React.ReactNode;
}

/** 教室头 */
export function ComponentClassroomHead({ logo, name, studentCount, renaming, renameVal, onRenameChange, onRenameSubmit, onRenameStart, onRenameCancel, tabs, activeTab, onTabChange, defaultModelSlot }: Props) {
  const { t } = useTranslation('academy');
  return (
    <div className="px-5 pt-[14px] border-b border-border bg-surface shrink-0">
      <div className="flex items-center gap-2.5 mb-3">
        <span className="w-[34px] h-[34px] rounded-md flex items-center justify-center text-[17px]" style={{ background: CLS_LOGO_BG }}>
          {logo ?? '🎓'}
        </span>
        {renaming ? (
          <input
            autoFocus
            value={renameVal}
            onChange={(e) => onRenameChange(e.target.value)}
            onBlur={onRenameSubmit}
            onKeyDown={(e) => { if (e.key === 'Enter') onRenameSubmit(); if (e.key === 'Escape') onRenameCancel(); }}
            className={INPUT + ' w-[220px]'}
          />
        ) : (
          <span className="text-[16px] font-semibold text-fg">{name}</span>
        )}
        <PrimitiveStatusBadge variant="train" label={t('classroom.studentCount', { count: studentCount })} />
        {/* 教室级默认模型入口（formal 教室可改；picker 顶部显「默认模型」项，对齐 squad manageTab） */}
        {defaultModelSlot && (
          <div className="flex items-center gap-1.5 ml-1">
            <span className="text-[11px] text-muted">{t('classroom.defaultModelLabel')}</span>
            {defaultModelSlot}
          </div>
        )}
        <div className="flex-1" />
        <button type="button" data-action-key="academy.classroom.settings" onClick={onRenameStart} className={`${BTN_SECONDARY} ${BTN_SM}`}>
          ⚙ {t('classroom.settings')}
        </button>
      </div>
      <PrimitiveAcademyTab tabs={tabs} activeId={activeTab} onChange={onTabChange} />
    </div>
  );
}

export default ComponentClassroomHead;
