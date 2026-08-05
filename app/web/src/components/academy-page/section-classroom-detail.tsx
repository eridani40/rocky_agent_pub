/**
 * section-classroom-detail —— 教室详情（左 head 对话列可拖宽 + 右 tab 内容区）
 * 参考: specs/ui/components/academy-page/section-classroom-detail.md
 *       specs/ui/components/academy-page/_overview.md §2（可拖宽列约定）
 *       demo 02-classroom-detail.html（cls-head tab / ht-col / student-grid / res-table）
 *
 * 学生卡数据：classroom detail 的 students 无版本 label → 逐学生补拉 student detail
 *   （N 小可接受）拿当前正式版 label + 版本数；status 从 tasks 派生（running→训练中；
 *   有 >0.0 正式版→可用；否则未训练）。recentGain 需跨任务 turn 历史，MVP 恒 null（显「—」）。
 * 渲染件拆 component-classroom-head / component-classroom-tab-panels（保本文件 ≤300 行）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createStudent,
  getStudentDetail,
  patchClassroom,
  type ClassroomDetail,
} from '../../lib/academy-api';
import { ModelPicker } from '../chat/ModelPicker';
import type { ModelSelection } from '../../lib/providers';
import { SectionChatSession } from '../chat-page/section-chat-session';
import { ComponentAcademyChatHeader } from './component-academy-chat-header';
import { ComponentClassroomHead } from './component-classroom-head';
import { ComponentColResizeHandle } from '../chat-page/component-col-resize-handle';
import { ACADEMY_COL } from './academy-col-widths';
import { usePersistentWidth } from '../common/use-persistent-width';
import { ResTable, StudentsGrid, useResItems, type StudentCardData } from './component-classroom-tab-panels';

interface Props {
  classroomId: string;
  detail: ClassroomDetail;
  /** 数据变化后父级重拉（加学生 / 改名后） */
  onRefresh: () => void;
  onOpenStudent: (studentId: string) => void;
}

/** 教室详情 section */
export function SectionClassroomDetail({ classroomId, detail, onRefresh, onOpenStudent }: Props) {
  const { t } = useTranslation('academy');
  const { classroom, students, tasks, datasets, graders } = detail;
  const [tab, setTab] = useState('students');
  const [cards, setCards] = useState<Record<string, StudentCardData>>({});
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(classroom.name);
  // ht-col 列宽（可拖 320~720，默认 480；persist localStorage academy-ht-col-width）
  const htCol = usePersistentWidth(ACADEMY_COL.ht);

  // 逐学生补拉 detail（当前正式版 label + 版本数）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, StudentCardData> = {};
      await Promise.all(
        students.map(async (s) => {
          try {
            const d = await getStudentDetail(classroomId, s.id);
            const cur = d.versions.find((v) => v.id === s.currentFormalVersionId);
            next[s.id] = {
              student: s,
              currentVersionLabel: cur?.versionLabel,
              isInitialOnly: !d.versions.some((v) => v.type === 'formal' && v.versionLabel !== '0.0'),
              versionCount: d.versions.length,
            };
          } catch {
            next[s.id] = { student: s, isInitialOnly: true, versionCount: s.versionIds?.length ?? 0 };
          }
        }),
      );
      if (!cancelled) setCards(next);
    })();
    return () => { cancelled = true; };
  }, [classroomId, students]);

  const tasksOf = (sid: string) => tasks.filter((tk) => tk.studentId === sid);
  const statusOf = (sid: string): 'training' | 'ready' | 'untrained' => {
    if (tasksOf(sid).some((tk) => ['running', 'pending', 'awaiting_confirm'].includes(tk.status))) return 'training';
    const c = cards[sid];
    return c && !c.isInitialOnly ? 'ready' : 'untrained';
  };

  const gradients = useMemo(
    () => ['linear-gradient(135deg,#ec4899,#f97316)', 'linear-gradient(135deg,#3b82f6,#8b5cf6)', 'linear-gradient(135deg,#14b8a6,#22c55e)', 'linear-gradient(135deg,#f59e0b,#f43f5e)'],
    [],
  );

  const submitAddStudent = async () => {
    const name = newName.trim();
    if (!name) return;
    setAddError(null);
    try {
      await createStudent(classroomId, { name });
      setNewName('');
      setAdding(false);
      onRefresh();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : t('students.createFail'));
    }
  };

  const submitRename = async () => {
    const name = renameVal.trim();
    setRenaming(false);
    if (!name || name === classroom.name) return;
    try {
      await patchClassroom(classroomId, { name });
      onRefresh();
    } catch { /* 失败静默回显旧名 */ }
  };

  // 教室级默认模型：ModelPicker form-style（对齐 squad manageTab 范式，无继承选项）。
  //   classroom.defaultModel 复合 → ModelSelection；未配 → null（picker 显 placeholder「选择 model」）。
  //   onChange 具体 model → PATCH classroom.defaultModel = sel（群体级必须选具体模型，无「跟随应用默认」）。
  const defaultModelSel: ModelSelection | null = classroom.defaultModel
    ? { providerId: classroom.defaultModel.providerId ?? '', modelId: classroom.defaultModel.modelId }
    : null;
  const handleDefaultModelChange = (sel: ModelSelection) => {
    void patchClassroom(classroomId, { defaultModel: sel }).catch((e) =>
      console.warn('[academy] patchClassroom defaultModel failed:', e),
    );
    onRefresh();
  };

  const tabs = [
    { id: 'students', label: t('tabs.students') },
    { id: 'datasets', label: t('tabs.datasets') },
    { id: 'graders', label: t('tabs.graders') },
  ];

  const datasetItems = useResItems('datasets', datasets, []);
  const graderItems = useResItems('graders', [], graders);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <ComponentClassroomHead
        logo={classroom.logo}
        name={classroom.name}
        studentCount={students.length}
        renaming={renaming}
        renameVal={renameVal}
        onRenameChange={setRenameVal}
        onRenameSubmit={() => void submitRename()}
        onRenameStart={() => { setRenameVal(classroom.name); setRenaming(true); }}
        onRenameCancel={() => setRenaming(false)}
        tabs={tabs}
        activeTab={tab}
        onTabChange={setTab}
        defaultModelSlot={
          <ModelPicker
            value={defaultModelSel}
            onChange={handleDefaultModelChange}
          />
        }
      />

      {/* 行容器 min-h-0：作为 flex-col 子项防 min-height:auto 撑破高度链（宿主高度链约束，_overview §2） */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* ht-col：head teacher 对话（宽度受控 + 右缘拖拽手柄，复用 chat-page 手柄组件）。
            水平 flex（非 flex-col）+ min-h-0 overflow-hidden：BaseChatPage 按 row 子项 stretch
            设计（page-chat / studio-chat-router 同款），垫 flex-col 会让其 min-height:auto 撑高、
            消息流失去滚动、输入条被顶出视口。relative 供 absolute 手柄定位。 */}
        <div
          style={{ width: htCol.width }}
          className="relative flex-shrink-0 flex min-h-0 overflow-hidden border-r border-border bg-surface"
        >
          <SectionChatSession
            sessionId={classroom.headTeacherSessionId}
            topbarLeft={() => (
              <ComponentAcademyChatHeader
                avatarText="班"
                title={`${t('head.teacher')} · ${classroom.name}`}
                statusLine={<div className="text-[11px] text-sage">{t('head.online')}</div>}
              />
            )}
            placeholder={t('head.placeholder')}
          />
          <ComponentColResizeHandle
            side="left"
            currentWidth={htCol.width}
            minWidth={htCol.minWidth}
            maxWidth={htCol.maxWidth}
            onResize={htCol.onResize}
            onResizeEnd={htCol.onResizeEnd}
            ariaLabel={t('resize.ariaLabel')}
            title={t('resize.title')}
          />
        </div>

        {/* content-col：tab 内容 */}
        <div className="flex-1 flex flex-col overflow-hidden bg-bg">
          <div className="flex-1 overflow-y-auto px-[22px] py-[18px]">
            {tab === 'students' && (
              <StudentsGrid
                students={students}
                cards={cards}
                gradients={gradients}
                statusOf={statusOf}
                taskCountOf={(sid) => tasksOf(sid).length}
                adding={adding}
                newName={newName}
                addError={addError}
                onNewNameChange={setNewName}
                onSubmitAdd={() => void submitAddStudent()}
                onCancelAdd={() => { setAdding(false); setNewName(''); }}
                onStartAdd={() => setAdding(true)}
                onOpenStudent={onOpenStudent}
              />
            )}

            {tab === 'datasets' && <ResTable items={datasetItems} emptyText={t('common.empty')} />}
            {tab === 'graders' && <ResTable items={graderItems} emptyText={t('common.empty')} />}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SectionClassroomDetail;
