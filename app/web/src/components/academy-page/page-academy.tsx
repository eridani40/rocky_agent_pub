/**
 * page-academy —— Academy 板块根组件（路由分发 + modal 顶层挂载）
 * 参考: specs/ui/components/academy-page/page-academy.md
 *       specs/ui/overall/12-academy.md §2（左 sidebar 常驻 + 右主区多态互斥）
 *
 * 职责：按 academy-slice route 分发 section；持 md-editor / skill-browser / training-create modal state
 *   （spec：modal 由本页顶层挂载，避免 section 重挂丢 state）；聚合教室 details
 *   （sidebar 统计 + classroom-detail + student-detail 任务卡共用一份，防 N 处重复拉）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAcademyStore, type AcademyRoute } from '../../store/academy-slice';
import { useViewStore } from '../../store/view-store';
import type { ModelSelection } from '../../lib/providers';
import {
  createClassroom,
  createTrainingTask,
  getClassroomDetail,
  type ClassroomDetail,
} from '../../lib/academy-api';
import { SectionClassroomList } from './section-classroom-list';
import { SectionClassroomDetail } from './section-classroom-detail';
import { SectionStudentDetail, type MdEditorTarget, type SkillBrowserTarget, type VersionMemoryTarget } from './section-student-detail';
import { SectionTrainingObserve } from './section-training-observe';
import { SectionVersionChat } from './section-version-chat';
import { SessionReadonlyView } from './component-session-readonly';
import { ComponentAcademyModals } from './component-academy-modals';
import { ComponentVersionMemoryModal } from './component-version-memory-modal';
import { ComponentTrainingCreateModal, toCreateTaskBody, type TrainingFormConfig } from './component-training-create-modal';
import { useAcademySessions, useClassrooms, useStudentDetail, useVersionContent } from './use-academy-data';
import { useTrainingTask } from './use-training-task';
import { AcademyHero, LoadingHint } from './academy-hero';

interface TrainingCreateTarget {
  classroomId: string;
  studentId: string;
  studentName: string;
  defaultBaseVersionId: string;
}

/** Academy 板块入口 */
export function PageAcademy() {
  const { t } = useTranslation('academy');
  const route = useAcademyStore((s) => s.route);
  const setRoute = useAcademyStore((s) => s.setRoute);
  const setView = useViewStore((s) => s.setView);
  const setStudioDerivePrefill = useViewStore((s) => s.setStudioDerivePrefill);

  // —— 数据：教室列表 + 全量 details 聚合（sidebar 统计/详情/任务卡共用） ——
  const classrooms = useClassrooms();
  const [detailsMap, setDetailsMap] = useState<Record<string, ClassroomDetail>>({});
  const refreshDetail = useCallback(async (cid: string) => {
    try {
      const d = await getClassroomDetail(cid);
      setDetailsMap((m) => ({ ...m, [cid]: d }));
    } catch { /* 单教室失败保留旧数据 */ }
  }, []);
  useEffect(() => {
    const list = classrooms.data ?? [];
    for (const c of list) void refreshDetail(c.id);
  }, [classrooms.data, refreshDetail]);

  // —— 路由派生 id ——
  const classroomId = 'classroomId' in route ? route.classroomId : '';
  const studentId = 'studentId' in route ? (route.studentId ?? '') : '';
  // BUG-003：route.kind 作 refetchKey——back-nav 回 student-detail 时触发软刷新（训练 paused 停轮询后版本树陈旧）
  const studentDetailHook = useStudentDetail(classroomId, studentId, route.kind);
  const studentDetail = studentDetailHook.data;
  const selectedVersionId = useMemo(() => {
    if (route.kind === 'student-detail' && route.versionId) return route.versionId;
    if (route.kind === 'version-chat') return route.versionId;
    return studentDetail?.student.currentFormalVersionId ?? '';
  }, [route, studentDetail]);
  const versionContentHook = useVersionContent(classroomId, studentId, route.kind === 'student-detail' ? selectedVersionId : '');
  const taskId = route.kind === 'training-observe' ? route.taskId : '';
  const taskHook = useTrainingTask(taskId);
  const sessionsHook = useAcademySessions(route.kind === 'version-chat' ? route.classroomId : undefined);

  // —— modal state（spec：本页顶层挂载） ——
  const [mdEditor, setMdEditor] = useState<MdEditorTarget | null>(null);
  const [skillBrowser, setSkillBrowser] = useState<SkillBrowserTarget | null>(null);
  const [memoryModal, setMemoryModal] = useState<VersionMemoryTarget | null>(null);
  const [trainingCreate, setTrainingCreate] = useState<TrainingCreateTarget | null>(null);
  // sidebar 命名输入展开态（hero CTA 也触发）
  const [createOpen, setCreateOpen] = useState(false);

  // —— 行为 ——
  const handleCreateClassroom = useCallback(async (name: string, defaultModel: ModelSelection) => {
    const r = await createClassroom({ name, defaultModel });
    await classrooms.reload();
    setRoute({ kind: 'classroom-detail', classroomId: r.classroom.id });
  }, [classrooms, setRoute]);

  const refreshStudentAndClassroom = useCallback(() => {
    void studentDetailHook.reload();
    if (classroomId) void refreshDetail(classroomId);
  }, [studentDetailHook, classroomId, refreshDetail]);

  const handleStartTraining = useCallback((defaultBaseId?: string) => {
    if (!studentDetail) return;
    const currentFormalId = studentDetail.student.currentFormalVersionId ?? '';
    const defaultBaseVersionId = defaultBaseId ?? currentFormalId;
    if (!defaultBaseVersionId) return;
    setTrainingCreate({
      classroomId,
      studentId,
      studentName: studentDetail.student.name,
      defaultBaseVersionId,
    });
  }, [studentDetail, classroomId, studentId]);

  const handleSubmitTraining = useCallback(async (baseVersionId: string, config: TrainingFormConfig) => {
    if (!trainingCreate) return;
    const r = await createTrainingTask(trainingCreate.classroomId, trainingCreate.studentId, toCreateTaskBody(baseVersionId, config));
    setTrainingCreate(null);
    void refreshDetail(trainingCreate.classroomId);
    setRoute({ kind: 'training-observe', classroomId: trainingCreate.classroomId, studentId: trainingCreate.studentId, taskId: r.task.id });
  }, [trainingCreate, refreshDetail, setRoute]);

  const handleDeriveToStudio = useCallback((versionId: string) => {
    if (!studentDetail) return;
    setStudioDerivePrefill({
      academySource: { classroomId, studentId, versionId },
      name: studentDetail.student.name,
    });
    setView('studio');
  }, [studentDetail, classroomId, studentId, setStudioDerivePrefill, setView]);

  const openSubagentReadonly = useCallback((sessionId: string) => {
    setRoute({ kind: 'session-readonly', sessionId, backTo: route });
  }, [route, setRoute]);

  // —— 主区分发 ——
  const detail = detailsMap[classroomId];
  let main: React.ReactNode;
  if (route.kind === 'classroom-list') {
    main = <AcademyHero onCreate={() => setCreateOpen(true)} />;
  } else if (route.kind === 'classroom-detail') {
    main = detail ? (
      <SectionClassroomDetail
        classroomId={route.classroomId}
        detail={detail}
        onRefresh={() => void refreshDetail(route.classroomId)}
        onOpenStudent={(sid) => setRoute({ kind: 'student-detail', classroomId: route.classroomId, studentId: sid })}
      />
    ) : (
      <LoadingHint text={t('common.loading')} />
    );
  } else if (route.kind === 'student-detail') {
    main = studentDetail ? (
      <SectionStudentDetail
        classroomId={route.classroomId}
        studentId={route.studentId}
        detail={studentDetail}
        classroomDetail={detail}
        versionContent={versionContentHook.data}
        selectedVersionId={selectedVersionId || undefined}
        onSelectVersion={(vid) => setRoute({ ...route, versionId: vid })}
        onBack={() => setRoute({ kind: 'classroom-detail', classroomId: route.classroomId })}
        onOpenTrainingObserve={(tid) => setRoute({ kind: 'training-observe', classroomId: route.classroomId, studentId: route.studentId, taskId: tid })}
        onStartSession={(vid) => setRoute({ kind: 'version-chat', classroomId: route.classroomId, studentId: route.studentId, versionId: vid })}
        onDeriveToStudio={handleDeriveToStudio}
        onStartTraining={handleStartTraining}
        onEditVersion={setMdEditor}
        onOpenSkillBrowser={setSkillBrowser}
        onOpenMemoryModal={setMemoryModal}
        onRefreshContent={() => void versionContentHook.reload()}
        onAdopted={() => {
          refreshStudentAndClassroom();
          void versionContentHook.reload();
        }}
      />
    ) : (
      <LoadingHint text={t('common.loading')} />
    );
  } else if (route.kind === 'training-observe') {
    main = taskHook.data && studentDetail ? (
      <SectionTrainingObserve
        classroomId={route.classroomId}
        taskId={route.taskId}
        taskDetail={taskHook.data}
        onReloadTask={() => void taskHook.reload()}
        studentDetail={studentDetail}
        onBack={() => setRoute({ kind: 'student-detail', classroomId: route.classroomId, studentId: route.studentId })}
        onOpenSubagent={openSubagentReadonly}
      />
    ) : (
      <LoadingHint text={t('common.loading')} />
    );
  } else if (route.kind === 'version-chat') {
    const versionSessions = (sessionsHook.data ?? []).filter(
      (s) => s.academyVersionId === route.versionId && s.derivation !== 'subagent',
    );
    const ver = studentDetail?.versions.find((v) => v.id === route.versionId);
    main = (
      <SectionVersionChat
        classroomId={route.classroomId}
        studentId={route.studentId}
        versionId={route.versionId}
        versionLabel={ver ? `v${ver.versionLabel}` : ''}
        studentName={studentDetail?.student.name ?? ''}
        sessions={versionSessions}
        sessionId={route.sessionId}
        onSelectSession={(sid) => setRoute({ ...route, sessionId: sid })}
        onSessionCreated={(sid) => {
          void sessionsHook.reload();
          setRoute({ ...route, sessionId: sid });
        }}
        onBack={() => setRoute({ kind: 'student-detail', classroomId: route.classroomId, studentId: route.studentId })}
      />
    );
  } else {
    // session-readonly：subagent 只读 transcript（design §8.8）
    const ro = route as Extract<AcademyRoute, { kind: 'session-readonly' }>;
    main = <SessionReadonlyView route={ro} onBack={() => setRoute(ro.backTo)} />;
  }

  // 训练发起弹层派生值（tcDetail 复用避免重复 detailsMap 查）
  const tcDetail = trainingCreate ? detailsMap[trainingCreate.classroomId] : undefined;
  const formalVersions = studentDetail?.versions.filter((v) => v.type === 'formal').map((v) => ({ id: v.id, label: v.versionLabel })) ?? [];
  const nextTaskSeq = tcDetail && trainingCreate
    ? Math.max(0, ...tcDetail.tasks.filter((tk) => tk.studentId === trainingCreate.studentId).map((tk) => tk.taskSeq)) + 1
    : 1;

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <SectionClassroomList
        classrooms={classrooms.data ?? []}
        statsOf={(cid) => {
          const d = detailsMap[cid];
          return {
            studentCount: d?.students.length ?? 0,
            activeTaskCount: d?.tasks.filter((tk) => ['running', 'pending'].includes(tk.status)).length ?? 0,
          };
        }}
        selectedId={classroomId || undefined}
        onSelect={(cid) => setRoute({ kind: 'classroom-detail', classroomId: cid })}
        onCreated={() => void classrooms.reload()}
        onCreateClassroom={handleCreateClassroom}
        createOpen={createOpen}
        onCreateOpenChange={setCreateOpen}
      />
      {main}

      {/* 版本内容弹层（md 编辑器 / skill browser；挂载 + 保存接线在 component-academy-modals） */}
      <ComponentAcademyModals
        classroomId={classroomId}
        studentId={studentId}
        studentName={studentDetail?.student.name ?? ''}
        mdEditor={mdEditor}
        skillBrowser={skillBrowser}
        onCloseMdEditor={() => setMdEditor(null)}
        onCloseSkillBrowser={() => setSkillBrowser(null)}
        onSaved={() => void versionContentHook.reload()}
      />

      {/* 版本 memory 只读弹层（四元组 Memory 卡「查看」入口；顶层挂载避免 section 重挂丢 state） */}
      {memoryModal && (
        <ComponentVersionMemoryModal
          entries={memoryModal.entries}
          versionLabel={memoryModal.versionLabel}
          onClose={() => setMemoryModal(null)}
        />
      )}

      {/* 训练发起弹层（顶层挂载） */}
      {trainingCreate && studentDetail && (
        <ComponentTrainingCreateModal
          open
          student={{ id: trainingCreate.studentId, name: trainingCreate.studentName }}
          formalVersions={formalVersions}
          defaultBaseVersionId={trainingCreate.defaultBaseVersionId}
          datasets={tcDetail?.datasets ?? []}
          graders={tcDetail?.graders ?? []}
          hasEvaluationCapability={(tcDetail?.datasets.length ?? 0) > 0 && (tcDetail?.graders.length ?? 0) > 0}
          nextTaskSeq={nextTaskSeq}
          onCancel={() => setTrainingCreate(null)}
          onSubmit={handleSubmitTraining}
        />
      )}
    </div>
  );
}

export default PageAcademy;
