/**
 * component-student-card —— 教室详情学生 tab 网格中的学生卡
 * 参考: specs/ui/components/academy-page/component-student-card.md
 *       demo 02-classroom-detail.html `.student-card`（p-15 hover border-strong+shadow-md；三栏统计）
 */
import { useTranslation } from 'react-i18next';
import { PrimitiveStatusBadge } from './primitive-status-badge';
import { AVATAR_BASE, CARD } from './academy-styles';

interface Props {
  student: {
    id: string;
    name: string;
    /** avatar 渐变（CSS background 值）；缺省 muted-2 灰 */
    avatarGradient?: string;
    /** 当前版文案（如 'v1.0' / '初始版 v0.0' 的 label 部分） */
    currentVersionLabel?: string;
    /** true → 「初始版 vX」文案；false/undefined → 「当前正式版 vX」 */
    isInitialOnly?: boolean;
    status: 'training' | 'ready' | 'untrained';
    versionCount: number;
    taskCount: number;
    /** 最近提升百分比（18 → +18%；null/undefined → 「—」） */
    recentGain?: number | null;
  };
  onClick?: () => void;
}

/** 学生卡（demo .student-card；avatar 字 = 名首字符） */
export function ComponentStudentCard({ student, onClick }: Props) {
  const { t } = useTranslation('academy');
  const versionText = student.currentVersionLabel
    ? student.isInitialOnly
      ? t('students.initialVersion', { label: student.currentVersionLabel })
      : t('students.currentFormal', { label: student.currentVersionLabel })
    : '—';
  return (
    <div
      role="button"
      tabIndex={0}
      data-action-key="academy.student.select"
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick?.(); }}
      className={`${CARD} p-[15px] cursor-pointer transition-all duration-150 hover:border-border-strong hover:shadow-md`}
    >
      {/* stu-top：avatar + 名 + 当前版 + 状态 tag */}
      <div className="flex items-center gap-[11px] mb-[11px]">
        <span
          className={`${AVATAR_BASE} w-[38px] h-[38px] text-[16px]`}
          style={{ background: student.avatarGradient ?? 'var(--color-muted-2)' }}
        >
          {student.name.slice(0, 1)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-semibold text-fg truncate">{student.name}</div>
          <div className="text-[11px] text-muted truncate">{versionText}</div>
        </div>
        <PrimitiveStatusBadge variant={student.status} />
      </div>
      {/* stu-stats：三栏（版本 / 训练任务 / 最近提升） */}
      <div className="flex gap-[14px] pt-[11px] border-t border-border">
        <div className="flex flex-col">
          <b className="text-[15px] font-semibold text-fg">{student.versionCount}</b>
          <span className="text-[10.5px] text-muted">{t('students.statVersions')}</span>
        </div>
        <div className="flex flex-col">
          <b className="text-[15px] font-semibold text-fg">{student.taskCount}</b>
          <span className="text-[10.5px] text-muted">{t('students.statTasks')}</span>
        </div>
        <div className="flex flex-col">
          <b className={`text-[15px] font-semibold ${student.recentGain != null ? 'text-sage' : 'text-fg'}`}>
            {student.recentGain != null ? `+${student.recentGain}%` : '—'}
          </b>
          <span className="text-[10.5px] text-muted">{t('students.statGain')}</span>
        </div>
      </div>
    </div>
  );
}

export default ComponentStudentCard;
