/**
 * component-classroom-tab-panels —— 教室详情 tab 面板（students 网格 / datasets+graders 资源表）
 * 参考: specs/ui/components/academy-page/section-classroom-detail.md（content-col tab）
 *       demo 02-classroom-detail.html（student-grid / res-table）
 *
 * 从 section-classroom-detail 拆出（保 section ≤300 行）：纯渲染 + 上抛交互。
 */
import { useTranslation } from 'react-i18next';
import type { StudentEntity } from '../../lib/academy-api';
import { ComponentStudentCard } from './component-student-card';
import { PrimitiveStatusBadge } from './primitive-status-badge';
import { BTN_PRIMARY, BTN_SM, CARD, INPUT } from './academy-styles';

/** 学生卡展示数据（students + 补拉 versions 派生）—— section 侧同型导出 */
export interface StudentCardData {
  student: StudentEntity;
  currentVersionLabel?: string;
  isInitialOnly: boolean;
  versionCount: number;
}

/** 学生网格（students tab：卡列表 + 末位虚线添加卡） */
export function StudentsGrid({ students, cards, gradients, statusOf, taskCountOf, adding, newName, addError, onNewNameChange, onSubmitAdd, onCancelAdd, onStartAdd, onOpenStudent }: {
  students: StudentEntity[];
  cards: Record<string, StudentCardData>;
  gradients: string[];
  statusOf: (sid: string) => 'training' | 'ready' | 'untrained';
  taskCountOf: (sid: string) => number;
  adding: boolean;
  newName: string;
  addError: string | null;
  onNewNameChange: (v: string) => void;
  onSubmitAdd: () => void;
  onCancelAdd: () => void;
  onStartAdd: () => void;
  onOpenStudent: (sid: string) => void;
}) {
  const { t } = useTranslation('academy');
  return (
    <>
      <div className="flex items-center justify-between mt-1 mb-3">
        <span className="text-[13.5px] font-semibold text-fg">{t('students.title', { count: students.length })}</span>
        <button type="button" data-action-key="academy.student.create" onClick={onStartAdd} className={`${BTN_PRIMARY} ${BTN_SM}`}>
          ＋ {t('students.add')}
        </button>
      </div>
      <div className="grid gap-[14px]" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(250px,1fr))' }}>
        {students.map((s, i) => {
          const c = cards[s.id];
          return (
            <ComponentStudentCard
              key={s.id}
              student={{
                id: s.id,
                name: s.name,
                avatarGradient: c?.isInitialOnly ? undefined : gradients[i % gradients.length],
                currentVersionLabel: c?.currentVersionLabel ? `v${c.currentVersionLabel}` : undefined,
                isInitialOnly: c?.isInitialOnly ?? true,
                status: statusOf(s.id),
                versionCount: c?.versionCount ?? 0,
                taskCount: taskCountOf(s.id),
                recentGain: null,
              }}
              onClick={() => onOpenStudent(s.id)}
            />
          );
        })}
        {/* 末位「+ 添加学生」虚线卡（点击变输入态） */}
        {adding ? (
          <div className={`${CARD} border-dashed p-[15px] flex flex-col gap-2 justify-center`}>
            <input
              autoFocus
              value={newName}
              placeholder={t('students.addPlaceholder')}
              onChange={(e) => onNewNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSubmitAdd();
                if (e.key === 'Escape') onCancelAdd();
              }}
              className={INPUT}
            />
            {addError && <div className="text-[11px] text-danger">{addError}</div>}
          </div>
        ) : (
          <button
            type="button"
            data-action-key="academy.student.create"
            onClick={onStartAdd}
            className="border-[1.5px] border-dashed border-border-2 bg-transparent rounded-xl flex flex-col items-center justify-center gap-1.5 text-muted min-h-[118px] cursor-pointer hover:border-accent hover:text-accent transition-colors"
          >
            <span className="text-[22px]">＋</span>
            <span className="text-[12.5px]">{t('students.add')}</span>
          </button>
        )}
      </div>
    </>
  );
}

/** 资源表（datasets/graders tab 共用：icon + 名/副 + badge 行列表） */
export function ResTable({ items, emptyText }: { items: Array<{ id: string; icon: string; iconBg: string; name: string; sub: string; badge: React.ReactNode }>; emptyText: string }) {
  return (
    <div className={`${CARD} overflow-hidden`}>
      {items.map((it, i) => (
        <div key={it.id} className={`flex items-center gap-3 px-4 py-[11px] ${i < items.length - 1 ? 'border-b border-border' : ''}`}>
          <span className="w-8 h-8 rounded-md flex items-center justify-center text-[15px]" style={{ background: it.iconBg }}>{it.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium text-fg truncate">{it.name}</div>
            <div className="text-[11px] text-muted truncate">{it.sub}</div>
          </div>
          {it.badge}
        </div>
      ))}
      {items.length === 0 && <div className="text-[12px] text-muted py-8 text-center">{emptyText}</div>}
    </div>
  );
}

/** datasets/graders tab 行组装（badge 用 PrimitiveStatusBadge，此处收敛两处重复） */
export function useResItems(kind: 'datasets' | 'graders', datasets: Array<{ id: string; name: string; description?: string; items: unknown[] }>, graders: Array<{ id: string; name: string; type: string }>) {
  const { t } = useTranslation('academy');
  if (kind === 'datasets') {
    return datasets.map((d) => ({
      id: d.id,
      icon: '📚',
      iconBg: 'var(--info-bg)',
      name: d.name,
      sub: d.description ?? t('create.datasetCaseCount', { count: d.items.length }),
      badge: <PrimitiveStatusBadge variant="pending" label={t('create.datasetCaseCount', { count: d.items.length })} />,
    }));
  }
  return graders.map((g) => ({
    id: g.id,
    icon: '⚖️',
    iconBg: 'var(--hue-violet-bg)',
    name: g.name,
    sub: g.type === 'llm-judge' ? t('create.graderJudge') : t('create.graderEm'),
    badge: <PrimitiveStatusBadge variant={g.type === 'llm-judge' ? 'train' : 'learn'} label={g.type} />,
  }));
}
