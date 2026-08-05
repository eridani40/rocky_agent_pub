/**
 * section-classroom-list —— Academy 常驻左 sidebar（教室列表）
 * 参考: specs/ui/components/academy-page/section-classroom-list.md
 *       demo 01-classroom-list.html（220px sidebar / foot 文案）
 *
 * v0.0.230：新建教室表单加「默认模型」必选 ModelPicker（对齐 squad wizard modelDefault required，
 *   群体级必须选具体模型、无继承选项；未选模型提交被表单层拦截）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClassroomEntity } from '../../lib/academy-api';
import { ComponentClassroomCard } from './component-classroom-card';
import { ModelPicker } from '../chat/ModelPicker';
import type { ModelSelection } from '../../lib/providers';
import { ICON_BTN, INPUT } from './academy-styles';

interface Props {
  classrooms: ClassroomEntity[];
  /** 各教室学生数/任务中数（父级从 details 聚合；缺省显 0） */
  statsOf: (classroomId: string) => { studentCount: number; activeTaskCount: number };
  selectedId?: string;
  onSelect: (classroomId: string) => void;
  onCreated: () => void;
  /** 创建教室（父级调 POST /academy/classroom 后 onCreated 刷新）；defaultModel 必选（群体级必须选具体模型） */
  onCreateClassroom: (name: string, defaultModel: ModelSelection) => Promise<void>;
  /** 命名输入展开态（父级受控；hero CTA 也能触发） */
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}

/** logo 底色轮换（demo violet/indigo；按序取模） */
const LOGO_BGS = ['var(--hue-violet-bg)', 'var(--info-bg)', 'var(--hue-pink-bg)', 'var(--success-bg)', 'var(--warning-bg)'];

/** Academy 左 sidebar */
export function SectionClassroomList({ classrooms, statsOf, selectedId, onSelect, onCreated, onCreateClassroom, createOpen, onCreateOpenChange }: Props) {
  const { t } = useTranslation('academy');
  const [name, setName] = useState('');
  const [defaultModelSel, setDefaultModelSel] = useState<ModelSelection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submitCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // 必填校验：未选默认模型 → 表单层拦截（不调父级回调；对齐 squad wizard modelDefault required）
    if (!defaultModelSel) {
      setError(t('classroom.createRequireModel'));
      return;
    }
    setError(null);
    try {
      await onCreateClassroom(trimmed, defaultModelSel);
      setName('');
      setDefaultModelSel(null);
      onCreateOpenChange(false);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('classroom.createFail'));
    }
  };

  return (
    <aside className="w-[220px] flex-shrink-0 flex flex-col border-r border-border bg-surface overflow-hidden">
      {/* sidebar-head：标题 + ＋ */}
      <div className="flex items-center justify-between px-[14px] pt-[14px] pb-2.5 shrink-0">
        <span className="text-[13.5px] font-semibold text-fg">{t('sidebar.title')}</span>
        <button
          type="button"
          title={t('sidebar.create')}
          aria-label={t('sidebar.create')}
          data-action-key="academy.classroom.create"
          onClick={() => onCreateOpenChange(!createOpen)}
          className={ICON_BTN}
        >
          ＋
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {/* 简易命名输入（＋ 展开；Enter 创建 / Esc 取消） */}
        {createOpen && (
          <div className="px-0.5 pb-2">
            <input
              autoFocus
              value={name}
              placeholder={t('sidebar.createPlaceholder')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitCreate();
                if (e.key === 'Escape') { onCreateOpenChange(false); setName(''); setDefaultModelSel(null); }
              }}
              className={INPUT}
            />
            {/* 默认模型必选（群体级必须选具体模型、无继承选项；对齐 manageTab 形态） */}
            <div className="mt-1.5">
              <span className="text-[11px] text-muted">{t('classroom.defaultModelLabel')}</span>
              <div className="mt-1">
                <ModelPicker
                  value={defaultModelSel}
                  onChange={(sel) => setDefaultModelSel(sel)}
                />
              </div>
            </div>
            {error && <div className="mt-1 text-[11px] text-danger">{error}</div>}
          </div>
        )}

        {classrooms.map((c, i) => (
          <ComponentClassroomCard
            key={c.id}
            classroom={{
              id: c.id,
              name: c.name,
              logo: c.logo,
              logoBg: LOGO_BGS[i % LOGO_BGS.length],
              ...statsOf(c.id),
            }}
            active={selectedId === c.id}
            onClick={() => onSelect(c.id)}
          />
        ))}
      </div>

      <div className="shrink-0 px-3 py-2.5 border-t border-border text-[11px] text-muted-2">
        {t('sidebar.foot')}
      </div>
    </aside>
  );
}

export default SectionClassroomList;
