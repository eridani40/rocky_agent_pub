/**
 * section-student-detail —— 学生详情（左版本树 300px / 右 ver-hero+四元组卡）
 * 参考: specs/ui/components/academy-page/section-student-detail.md
 *       demo 03-student-detail.html（stu-head / ver-row / tuple-grid）
 *
 * 版本树：formal 按 label 数值升序、process 按 label major 段匹配父 formal 下（平铺规范，v0.0.219）；
 * 四元组卡数据源 = GET version content（skills = 目录 + 文件树，查看走 skill browser 弹层；
 *   memory = .rocky/memory/*.md 摘要 → 显条目数 + 「查看」开 version-memory-modal）。
 *   模型卡（ComponentTupleCards 内）复用 InputModelPicker（PATCH versionJson.model）。
 *   modal state 一律归 page-academy，本 section 只上抛 target。
 *
 * v0.0.220 ver-hero 改造：正式版编辑走下方四元组卡（readOnly 由 openMdEditor 控），槽位留空；
 *   过程版原 readonly badge → 「进入观察」按钮（createdFromTaskId 定位 task → onOpenTrainingObserve）。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  adoptTaskVersion,
  patchVersion,
  type ClassroomDetail,
  type SkillSummary,
  type StudentDetail,
  type StudentVersionEntity,
  type VersionContent,
} from '../../lib/academy-api';
import { ComponentVersionTree, type VersionNode } from './component-version-tree';
import { buildVersionNodes } from './version-tree-nodes';
import { PrimitiveStatusBadge } from './primitive-status-badge';
import { ComponentTupleCards } from './component-tuple-cards';
import type { ModelSelection } from '../../lib/providers';
import { AVATAR_BASE, BTN_PRIMARY, BTN_SECONDARY, BTN_SM } from './academy-styles';

/** md-editor 目标（父级 page-academy 持 modal state） */
export interface MdEditorTarget {
  fileName: string;
  subtitle: string;
  value: string;
  versionId: string;
  versionLabel: string;
  /** formal 可编辑 / process 只读 */
  readOnly: boolean;
  /** 保存通道：agentsMd 走 PATCH agentsMd；tools 走 PATCH versionJson.tools（换行分隔） */
  saveKind: 'agentsMd' | 'tools';
}

/** md-editor 打开参数（component-tuple-cards 上抛用） */
export interface MdEditorOpenArgs {
  fileName: string;
  field: string;
  value: string;
  saveKind: MdEditorTarget['saveKind'];
}

/**
 * skill browser 弹层目标（与 MdEditorTarget **并列且互不复用**——
 * Skills 走独立的版本 skill 文件端点，绝不经 md 编辑器的 agentsMd/tools 保存通道）。
 */
export interface SkillBrowserTarget {
  /** 版本内 skill 列表（目录 + 文件树） */
  skills: SkillSummary[];
  versionId: string;
  /** 展示用版本号（如 'v2.0'） */
  versionLabel: string;
  /** process 版本只读 */
  readOnly: boolean;
}

/** 版本 memory 弹层目标（只读；entries 来自 VersionContent.content.memory） */
export interface VersionMemoryTarget {
  entries: NonNullable<NonNullable<VersionContent['content']['memory']>>;
  versionLabel: string;
}

interface Props {
  classroomId: string;
  studentId: string;
  detail: StudentDetail;
  /** 教室聚合（v0.0.219 tasks 改用 detail.tasks 后此 prop 保留兼容，暂不再派生） */
  classroomDetail?: ClassroomDetail | null;
  versionContent: VersionContent | null;
  /** 当前选中版本 id（route 驱动） */
  selectedVersionId?: string;
  onSelectVersion: (versionId: string) => void;
  onBack: () => void;
  onOpenTrainingObserve: (taskId: string) => void;
  onStartSession: (versionId: string) => void;
  onDeriveToStudio: (versionId: string) => void;
  /** 发起训练；默认基线 hint 可选（不传则由 page-academy 取 currentFormal，PRD §2.4 baseline picker） */
  onStartTraining: (baseVersionIdHint?: string) => void;
  onEditVersion: (target: MdEditorTarget) => void;
  /** 打开 skill browser 弹层（target 由本 section 组装，state 归 page-academy） */
  onOpenSkillBrowser: (target: SkillBrowserTarget) => void;
  /** 打开版本 memory 弹层（只读；target 由本 section 组装，state 归 page-academy） */
  onOpenMemoryModal: (target: VersionMemoryTarget) => void;
  onRefreshContent: () => void;
  /** 版本树采纳成功后回刷学生详情（formal 列表新增 + 当前指针可能更新） */
  onAdopted?: () => void;
}

/** 学生详情 section */
export function SectionStudentDetail({
  classroomId, studentId, detail, versionContent, selectedVersionId,
  onSelectVersion, onBack, onOpenTrainingObserve, onStartSession, onDeriveToStudio, onStartTraining, onEditVersion, onOpenSkillBrowser, onOpenMemoryModal, onRefreshContent, onAdopted,
}: Props) {
  const { t } = useTranslation('academy');
  const { student, versions, tasks } = detail;
  const [adoptBusyId, setAdoptBusyId] = useState<string | null>(null);
  const [adoptError, setAdoptError] = useState<string | null>(null);

  const currentFormal = versions.find((v) => v.id === student.currentFormalVersionId);
  const selectedVersion = versions.find((v) => v.id === selectedVersionId) ?? currentFormal;

  // 版本树节点派生（纯函数 version-tree-nodes：formal 升序 + process 按 major 匹配父 + 模式取 task.mode）
  const nodes = useMemo<VersionNode[]>(
    () => buildVersionNodes({ versions, tasks, currentFormalVersionId: student.currentFormalVersionId, t }),
    [versions, tasks, student.currentFormalVersionId, t],
  );

  const selectedIsFormal = selectedVersion?.type === 'formal';
  const selLabel = selectedVersion?.versionLabel ?? '';
  const content = versionContent?.content;
  const versionJson = content?.versionJson;
  const modelSel: ModelSelection | null = versionJson?.model?.modelId
    ? { providerId: versionJson.model.providerId ?? '', modelId: versionJson.model.modelId }
    : null;

  const openMdEditor = ({ fileName, field, value, saveKind }: MdEditorOpenArgs) => {
    if (!selectedVersion) return;
    onEditVersion({
      fileName,
      subtitle: t('mdEditor.subtitle', { student: student.name, label: `v${selLabel}`, field }),
      value,
      versionId: selectedVersion.id,
      versionLabel: `v${selLabel}`,
      readOnly: !selectedIsFormal,
      saveKind,
    });
  };

  const openSkillBrowser = () => {
    if (!selectedVersion) return;
    onOpenSkillBrowser({
      skills: content?.skills ?? [],
      versionId: selectedVersion.id,
      versionLabel: `v${selLabel}`,
      readOnly: !selectedIsFormal,
    });
  };

  const openMemoryModal = () => {
    onOpenMemoryModal({
      entries: content?.memory ?? [],
      versionLabel: `v${selLabel}`,
    });
  };

  const handleModelChange = async (sel: ModelSelection) => {
    if (!selectedVersion || !selectedIsFormal) return;
    await patchVersion(classroomId, studentId, selectedVersion.id, { versionJson: { model: sel } }).catch(() => {});
    onRefreshContent();
  };

  /**
   * 过程版「采纳」入口（UC-221-C，POST /academy/training-task/:tid/adopt）。
   * 旁路：不改 task 状态（仍在产）；可重复。taskId 取该过程版的 createdFromTaskId。
   * adopt 后回刷学生详情（formal 列表新增 + currentFormalVersionId 指针同步）。
   */
  const handleAdopt = async (versionId: string) => {
    if (adoptBusyId) return;
    const ver = versions.find((v) => v.id === versionId);
    const tid = ver?.createdFromTaskId;
    if (!tid) {
      setAdoptError(t('student.adoptNoTask'));
      return;
    }
    setAdoptBusyId(versionId);
    setAdoptError(null);
    try {
      await adoptTaskVersion(tid, versionId);
      onAdopted?.();
    } catch (e) {
      setAdoptError(e instanceof Error ? e.message : t('student.adoptFail'));
    } finally {
      setAdoptBusyId(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* stu-head */}
      <div className="flex items-center gap-3 px-5 py-[13px] border-b border-border bg-surface shrink-0">
        <button type="button" onClick={onBack} className="text-[13px] text-muted hover:text-fg cursor-pointer">
          ← {t('student.back')}
        </button>
        <div className="w-px h-[22px] bg-border" />
        <span className={`${AVATAR_BASE} w-9 h-9 text-[15px]`} style={{ background: 'linear-gradient(135deg,#ec4899,#f97316)' }}>
          {student.name.slice(0, 1)}
        </span>
        <div className="min-w-0">
          <div className="flex items-center text-[15px] font-semibold text-fg">
            <span className="truncate">{student.name}</span>
            {currentFormal && (
              <span className="ml-2">
                <PrimitiveStatusBadge variant="ready" label={t('student.formalTag', { label: `v${currentFormal.versionLabel}` })} />
              </span>
            )}
          </div>
          <div className="text-[11.5px] text-muted">{t('student.heroSub')}</div>
        </div>
        <div className="ml-auto flex gap-[9px]">
          <button type="button" onClick={() => selectedVersion && onStartSession(selectedVersion.id)} className={BTN_SECONDARY}>
            {t('student.startChat')}
          </button>
          <button type="button" data-action-key="academy.student.derive" onClick={() => currentFormal && onDeriveToStudio(currentFormal.id)} className={BTN_SECONDARY}>
            {t('student.derive')}
          </button>
          <button type="button" data-action-key="academy.training.start" onClick={() => onStartTraining()} className={BTN_PRIMARY}>
            {t('student.startTraining')}
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* left-col 300px：版本树（formal 升序 + process 按 major 匹配父） */}
        <div className="w-[300px] flex-shrink-0 border-r border-border bg-surface flex flex-col">
          <div className="flex-1 overflow-y-auto p-[14px]">
            <ComponentVersionTree
              versions={nodes}
              selectedId={selectedVersion?.id}
              onSelect={onSelectVersion}
              onAdopt={(vid) => void handleAdopt(vid)}
            />
            {adoptError && <div className="text-[11px] text-danger mt-2 px-1">{adoptError}</div>}
          </div>
        </div>

        {/* right-col：ver-hero + 四元组 */}
        <div className="flex-1 flex flex-col overflow-hidden bg-bg">
          <div className="flex-1 overflow-y-auto px-[22px] py-[18px]">
            {selectedVersion && (
              <>
                <div className="flex items-center gap-[14px] mb-4">
                  <span className="w-[60px] h-[60px] rounded-lg flex items-center justify-center text-[20px] font-bold font-mono text-white bg-accent shadow-md">
                    {selLabel}
                  </span>
                  <div>
                    <div className="text-[15px] font-semibold text-fg">
                      {selectedIsFormal ? t('verHero.title', { label: `v${selLabel}` }) : t('verHero.processTitle', { label: `v${selLabel}` })}
                    </div>
                    <div className="text-[12px] text-muted">{t('verHero.sub')}</div>
                  </div>
                  <div className="ml-auto">
                    {/* v0.0.220：正式版编辑走下方四元组卡（readOnly 由 openMdEditor 控），槽位留空；
                        过程版显「进入观察」按钮——createdFromTaskId 定位 task → onOpenTrainingObserve；
                        createdFromTaskId 缺失（异常）则不显按钮。 */}
                    {!selectedIsFormal && selectedVersion.createdFromTaskId && (
                      <button
                        type="button"
                        data-action-key="academy.version.enterObserve"
                        onClick={() => onOpenTrainingObserve(selectedVersion.createdFromTaskId!)}
                        className={`${BTN_SECONDARY} ${BTN_SM}`}
                      >
                        {t('tasks.enterObserve')}
                      </button>
                    )}
                  </div>
                </div>

                <ComponentTupleCards
                  studentName={student.name}
                  selLabel={selLabel}
                  selectedIsFormal={selectedIsFormal}
                  content={content}
                  modelSel={modelSel}
                  onOpenMdEditor={openMdEditor}
                  onOpenSkillBrowser={openSkillBrowser}
                  onOpenMemoryModal={openMemoryModal}
                  onModelChange={(sel) => void handleModelChange(sel)}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SectionStudentDetail;
