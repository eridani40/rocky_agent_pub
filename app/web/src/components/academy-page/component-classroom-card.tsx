/**
 * component-classroom-card —— sidebar 教室单行卡（logo + 名 + 学生/任务摘要）
 * 参考: specs/ui/components/academy-page/component-classroom-card.md
 *       demo 01-classroom-list.html `.classroom-item`（p-8/10 rounded-lg hover/active accent-light）
 */
import { useTranslation } from 'react-i18next';

interface Props {
  classroom: {
    id: string;
    name: string;
    /** emoji logo（demo 体现，如 ✍️）；缺省显 🎓 */
    logo?: string;
    /** logo 底色（token 值，如 var(--hue-violet-bg)） */
    logoBg?: string;
    studentCount: number;
    activeTaskCount: number;
  };
  active?: boolean;
  onClick: () => void;
}

/** sidebar 教室行（demo .classroom-item：行 hover/active 仅底色变化，无边框） */
export function ComponentClassroomCard({ classroom, active = false, onClick }: Props) {
  const { t } = useTranslation('academy');
  // 「N 学生 · M 任务中」（M=0 时省略任务段——component spec 契约）
  const sub =
    classroom.activeTaskCount > 0
      ? `${t('sidebar.studentCount', { count: classroom.studentCount })} · ${t('sidebar.taskActive', { count: classroom.activeTaskCount })}`
      : t('sidebar.studentCount', { count: classroom.studentCount });
  return (
    <button
      type="button"
      data-action-key="academy.classroom.select"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={
        'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer text-left transition-colors ' +
        (active ? 'bg-accent-light' : 'hover:bg-accent-light')
      }
    >
      {/* 30×30 logo 方块（demo .classroom-logo；底色 prop 派生，缺省 violet-bg） */}
      <span
        className="w-[30px] h-[30px] rounded-md flex items-center justify-center text-[15px] flex-shrink-0"
        style={{ background: classroom.logoBg ?? 'var(--hue-violet-bg)' }}
      >
        {classroom.logo ?? '🎓'}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] font-medium text-fg truncate">{classroom.name}</span>
        <span className="block text-[11px] text-muted truncate">{sub}</span>
      </span>
    </button>
  );
}

export default ComponentClassroomCard;
