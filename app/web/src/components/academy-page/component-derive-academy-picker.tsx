/**
 * component-derive-academy-picker —— squad 派生「从教室派生」二级 select 面板
 * 参考: specs/ui/components/academy-page/component-derive-academy-picker.md
 *       demo 07-squad-derive.html（derive-panel / select-cols / pick-item / copy-note / src-chain）
 *
 * 只渲二级面板（mode-card 切换在 studio member-create 侧）；grid 2 列 ① 教室 ② 学生·版本；
 * 初始版学生（仅 0.0 空版本）dis 禁用「仅初始版 · 内容为空」。
 *
 * [v0.0.233] 加继承预览面板：选定 classroom/student/version 后调 preview endpoint 拉清单（hook 自包含）；
 *   同名项默认 skip（toggle off），用户逐项开 toggle = overwrite；onConfirm/上抛带 resolution。
 *   预览面板渲染拆 component-derive-academy-preview-panel（保本文件 ≤300 行）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AVATAR_BASE, BTN_PRIMARY, BTN_SECONDARY, SIDE_LABEL } from './academy-styles';
import { useDeriveAcademyPreview } from './use-derive-academy-preview';
import { ComponentDeriveAcademyPreviewPanel } from './component-derive-academy-preview-panel';
import type { DeriveResolution, ResolutionItem } from '../studio-page/squad-types';

/** 教室选项 */
export interface DeriveClassroomOption {
  id: string;
  name: string;
  logo?: string;
  logoBg?: string;
  studentCount: number;
}

/** 学生·版本选项（versionId = 派生源版本） */
export interface DeriveStudentOption {
  id: string;
  name: string;
  avatarGradient?: string;
  /** 最新正式版（推荐）；undefined → 仅初始版（禁用） */
  latestVersionId?: string;
  latestVersionLabel?: string;
  /** 是否推荐（当前教室第一个有正式版的学生标「最新正式版 · 推荐」） */
  recommended?: boolean;
}

interface Props {
  /** [v0.0.233] 目标 squad（preview endpoint path 参数） */
  squadId: string;
  classrooms: DeriveClassroomOption[];
  /** 当前选中教室的学生列表（父级按 selectedClassroomId 供） */
  students: DeriveStudentOption[];
  selectedClassroomId?: string;
  selectedStudentId?: string;
  onPickClassroom: (id: string) => void;
  onPickStudent: (id: string) => void;
  onCancel: () => void;
  /**
   * 确认派生（父级 POST /squad/:id/member {mode:'derive_academy', academySource, resolution}）。
   * [v0.0.233] 携 resolution（同名裁决 per-item 清单；无同名项时 undefined = 后端默认全 skip）。
   */
  onConfirm: (resolution?: DeriveResolution) => void;
  /**
   * [v0.0.233] 预览状态上抛（embedded 宿主据此 gate 提交按钮 + 收集 resolution）。
   * status = ready 时 resolution 有值（同名项 toggle 当前态）；其他态 undefined。
   */
  onPreviewStateChange?: (state: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    resolution?: DeriveResolution;
  }) => void;
  confirming?: boolean;
  /**
   * 嵌入模式（[v0.0.210] studio member-create 内嵌）：true → 去掉外框/head/foot 按钮组
   *   （卡片外壳与底部操作由宿主提供），只留 select-cols + copy-note + src-chain + 预览面板。
   */
  embedded?: boolean;
}

/** 版本号小徽章（demo .ver-badge-sm：mono 11px/600 黑底白字） */
function VerBadgeSm({ label, old }: { label: string; old?: boolean }) {
  return (
    <span className={`font-mono text-[11px] font-semibold px-1.5 py-0.5 rounded-sm ${old ? 'bg-muted-2' : 'bg-accent'} text-white`}>
      {label}
    </span>
  );
}

/** 派生二级 select 面板 */
export function ComponentDeriveAcademyPicker({
  squadId, classrooms, students, selectedClassroomId, selectedStudentId,
  onPickClassroom, onPickStudent, onCancel, onConfirm, onPreviewStateChange,
  confirming = false, embedded = false,
}: Props) {
  const { t } = useTranslation('academy');
  const selectedClassroom = classrooms.find((c) => c.id === selectedClassroomId);
  const selectedStudent = students.find((s) => s.id === selectedStudentId);
  const confirmValid = selectedClassroom && selectedStudent?.latestVersionId;

  // [v0.0.233] preview：选定三字段齐全才拉清单（避免无谓请求）
  const source = useMemo(() => {
    if (!selectedClassroomId || !selectedStudent?.latestVersionId) return undefined;
    return { classroomId: selectedClassroomId, studentId: selectedStudent.id, versionId: selectedStudent.latestVersionId };
  }, [selectedClassroomId, selectedStudent]);
  const preview = useDeriveAcademyPreview(squadId, source);

  // 同名项 toggle 状态（key=`${kind}:${name}`）；preview 数据变化时重置（新选择 → 新清单）
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setToggles({});
  }, [preview.data]);

  /** 按当前 toggle 态 build resolution（同名项 per-item；无同名项 → undefined） */
  const resolution = useMemo<DeriveResolution | undefined>(() => {
    const d = preview.data;
    if (!d) return undefined;
    const skills = d.skills.filter((s) => s.sameNameConflict);
    const memory = d.memory.filter((m) => m.sameNameConflict);
    if (skills.length === 0 && memory.length === 0) return undefined;
    const toItems = (kind: 'skill' | 'memory', items: { name: string }[]): ResolutionItem[] =>
      items.map((it) => ({ name: it.name, action: toggles[`${kind}:${it.name}`] ? 'overwrite' : 'skip' }));
    return {
      ...(skills.length ? { skills: toItems('skill', skills) } : {}),
      ...(memory.length ? { memory: toItems('memory', memory) } : {}),
    };
  }, [preview.data, toggles]);

  // 预览状态上抛（embedded 宿主 gate 提交按钮 + 收 resolution）
  useEffect(() => {
    onPreviewStateChange?.({ status: preview.status, resolution: preview.status === 'ready' ? resolution : undefined });
  }, [preview.status, resolution, onPreviewStateChange]);

  const handleToggle = (key: string) => setToggles((prev) => ({ ...prev, [key]: !prev[key] }));

  // 派生按钮：未选定 / confirming 中 / preview 加载或失败 → disabled（避免无裁决提交）
  const previewBlocking = preview.status === 'loading' || preview.status === 'error';
  const confirmDisabled = !confirmValid || confirming || previewBlocking;

  return (
    <div className={embedded ? '' : 'max-w-[760px] border border-border rounded-xl bg-surface overflow-hidden'}>
      {/* derive-head（embedded 由宿主卡片头提供） */}
      {!embedded && (
        <div className="px-[18px] py-[13px] border-b border-border bg-bg-warm text-[13px] font-semibold text-fg">
          {t('derive.head')}
        </div>
      )}

      {/* select-cols 两列 */}
      <div className="grid grid-cols-2">
        {/* ① 教室 */}
        <div className="p-3">
          <div className={`${SIDE_LABEL} mx-1 mb-2`}>{t('derive.step1')}</div>
          {classrooms.length === 0 && <div className="text-[12px] text-muted px-2">{t('derive.empty')}</div>}
          {classrooms.map((c) => {
            const sel = c.id === selectedClassroomId;
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                aria-pressed={sel}
                onClick={() => onPickClassroom(c.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onPickClassroom(c.id); }}
                className={
                  'flex items-center gap-2.5 px-[11px] py-[9px] rounded-lg cursor-pointer border-[1.5px] ' +
                  (sel ? 'bg-accent-light border-accent' : 'border-transparent hover:bg-accent-light')
                }
              >
                <span
                  className="w-[30px] h-[30px] rounded-md flex items-center justify-center text-[14px] flex-shrink-0"
                  style={{ background: c.logoBg ?? 'var(--hue-violet-bg)' }}
                >
                  {c.logo ?? '🎓'}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-fg truncate">{c.name}</div>
                  <div className="text-[11px] text-muted">{t('derive.studentCount', { count: c.studentCount })}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* ② 学生 · 版本 */}
        <div className="p-3 border-l border-border">
          <div className={`${SIDE_LABEL} mx-1 mb-2`}>{t('derive.step2')}</div>
          {students.map((s) => {
            const disabled = !s.latestVersionId;
            const sel = s.id === selectedStudentId;
            return (
              <div
                key={s.id}
                role="button"
                tabIndex={disabled ? -1 : 0}
                aria-pressed={sel}
                aria-disabled={disabled}
                onClick={() => { if (!disabled) onPickStudent(s.id); }}
                onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) onPickStudent(s.id); }}
                className={
                  'flex items-center gap-2.5 px-[11px] py-[9px] rounded-lg border-[1.5px] ' +
                  (disabled
                    ? 'opacity-50 cursor-default border-transparent'
                    : sel
                      ? 'bg-accent-light border-accent cursor-pointer'
                      : 'border-transparent cursor-pointer hover:bg-accent-light')
                }
              >
                <span
                  className={`${AVATAR_BASE} w-[30px] h-[30px] text-[13px]`}
                  style={{ background: s.avatarGradient ?? 'var(--color-muted-2)' }}
                >
                  {s.name.slice(0, 1)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-fg truncate">{s.name}</div>
                  <div className={`text-[11px] ${s.recommended ? 'text-sage' : 'text-muted'}`}>
                    {disabled
                      ? t('derive.emptyInitial')
                      : s.recommended
                        ? t('derive.latestRecommended')
                        : t('derive.latest')}
                  </div>
                </div>
                {s.latestVersionLabel && <VerBadgeSm label={s.latestVersionLabel} />}
              </div>
            );
          })}
        </div>
      </div>

      {/* copy-note */}
      <div className="flex gap-2 items-start mx-4 my-[14px] px-[14px] py-[11px] bg-[var(--info-bg)] rounded-md text-[12px] text-fg-2 leading-[1.55]">
        <span>ℹ️</span>
        <span>{t('derive.copyNote')}</span>
      </div>

      {/* [v0.0.233] 继承预览面板：preview ready 才渲染；loading/error 不渲染（避免半成品清单） */}
      {preview.status === 'ready' && preview.data && (
        <ComponentDeriveAcademyPreviewPanel
          data={preview.data}
          toggles={toggles}
          onToggle={handleToggle}
        />
      )}
      {/* preview error 兜底文案（不阻塞选择，仅提示派生暂不可用） */}
      {preview.status === 'error' && (
        <div className="mx-4 mb-[14px] px-[14px] py-[11px] text-[12px] text-danger">
          {t('derive.previewError')}
        </div>
      )}

      {/* derive-foot：src-chain + 按钮组（embedded 只留 src-chain，按钮走宿主） */}
      <div className={`flex items-center gap-[11px] px-[18px] py-[14px] ${embedded ? '' : 'border-t border-border'}`}>
        <div className="flex items-center gap-[7px] text-[12.5px] flex-wrap flex-1 min-w-0">
          <span className="text-[12px] text-muted">{t('derive.srcChain')}</span>
          {selectedClassroom && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-md bg-bg-warm border border-border font-medium">
              {selectedClassroom.logo ?? '🎓'} {selectedClassroom.name}
            </span>
          )}
          {selectedClassroom && selectedStudent && <span className="text-muted">→</span>}
          {selectedStudent && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-md bg-bg-warm border border-border font-medium">
              {selectedStudent.name}
            </span>
          )}
          {selectedStudent?.latestVersionLabel && (
            <>
              <span className="text-muted">→</span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-md bg-bg-warm border border-border">
                <VerBadgeSm label={selectedStudent.latestVersionLabel} />
              </span>
            </>
          )}
        </div>
        {!embedded && (
          <div className="flex gap-[9px] shrink-0">
            <button type="button" onClick={onCancel} className={BTN_SECONDARY}>{t('derive.cancel')}</button>
            <button
              type="button"
              disabled={confirmDisabled}
              onClick={() => onConfirm(resolution)}
              className={BTN_PRIMARY}
            >
              {t('derive.confirm')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ComponentDeriveAcademyPicker;
