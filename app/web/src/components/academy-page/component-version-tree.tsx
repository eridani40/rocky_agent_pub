/**
 * component-version-tree —— 学生详情左栏版本树（正式版 + 过程版平铺）
 * 参考: specs/ui/components/academy-page/component-version-tree.md
 *       demo 03-student-detail.html `.ver-row / .ver-tree-proc`（过程版缩进 22px + 左 2px 竖线）
 *
 * 平铺规范（对齐 _overview §2）：正式版行 + 过程版分组挂在其 parentFormalVersionId 下；
 * 正式版 vb-formal 黑底白字徽章、过程版 vb-proc violet 底徽章；当前正式版「当前」tag、
 * 训练中的过程版「训练中」gold tag。
 */
import { useTranslation } from 'react-i18next';
import { PrimitiveStatusBadge } from './primitive-status-badge';
import { SIDE_LABEL } from './academy-styles';

/** 版本节点（section 从 StudentVersionEntity + task 信息派生） */
export interface VersionNode {
  id: string;
  /** 版本号字面量（'0.0' / '1.0' / '1.2.3'） */
  label: string;
  kind: 'formal' | 'process';
  /** 主文案（'初始版本' / '第 1 正式版' / '任务 #2'） */
  name: string;
  /** 副文案（'全空 · 正式版' / '任务 #1 采纳 · 07-20' / '多轮 · 第 3/5 轮'） */
  subtitle?: string;
  /** 当前正式版（「当前」sage tag） */
  isCurrent?: boolean;
  /** 过程版状态（training → gold「训练中」；done → muted「已完成」） */
  status?: 'training' | 'done' | 'idle';
  /** 过程版挂到哪个正式版下（parentFormalVersionId） */
  parentVersionId?: string;
}

interface Props {
  versions: VersionNode[];
  selectedId?: string;
  onSelect: (versionId: string) => void;
  /**
   * 过程版「采纳」入口（UC-221-C）。
   * 传入时过程版行尾部显「采纳」按钮 → POST /adopt；不传则不显（如纯展示场景）。
   * 点击 adopt 不触发 select（stopPropagation）；formal 行不显（formal 已是归档产物）。
   */
  onAdopt?: (versionId: string) => void;
}

/** 单个版本行（demo .ver-row；sel 态 border + accent-light 底） */
function VersionRow({ node, selected, onSelect, onAdopt }: { node: VersionNode; selected: boolean; onSelect: () => void; onAdopt?: () => void }) {
  const { t } = useTranslation('academy');
  return (
    <div
      role="button"
      tabIndex={0}
      data-action-key="academy.version.select"
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(); }}
      className={
        'flex items-center gap-2.5 px-[11px] py-[9px] rounded-lg cursor-pointer border mb-1 transition-colors ' +
        (selected
          ? 'bg-accent-light border-border-2'
          : 'border-transparent hover:bg-accent-light')
      }
    >
      {/* 44×26 mono 徽章：formal 黑底白字 / process violet 底 */}
      <span
        className={
          'w-[44px] h-[26px] rounded-sm flex items-center justify-center text-[12px] font-semibold font-mono flex-shrink-0 ' +
          (node.kind === 'formal'
            ? 'bg-accent text-white'
            : 'bg-[var(--hue-violet-bg)] text-[var(--hue-violet)]')
        }
      >
        {node.label}
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center text-[12.5px] font-medium text-fg">
          <span className="truncate">{node.name}</span>
          {node.isCurrent && (
            <span className="ml-1.5"><PrimitiveStatusBadge variant="current" label={t('versionTree.current')} /></span>
          )}
          {node.status === 'training' && (
            <span className="ml-1.5"><PrimitiveStatusBadge variant="training" /></span>
          )}
        </span>
        {node.subtitle && <span className="block text-[10.5px] text-muted truncate">{node.subtitle}</span>}
      </span>
      {/* 过程版「采纳」按钮（UC-221-C）：走旁路 POST /adopt，不改 task 状态 */}
      {node.kind === 'process' && onAdopt && (
        <button
          type="button"
          data-action-key="academy.version.adopt"
          onClick={(e) => { e.stopPropagation(); onAdopt(); }}
          className="text-[11px] font-medium text-accent hover:text-accent-hover px-1.5 py-0.5 rounded shrink-0"
        >
          {t('versionTree.adoptBtn')}
        </button>
      )}
    </div>
  );
}

/** 版本树（平铺：正式版按序；每个正式版下挂其过程版分组，缩进 + 左竖线） */
export function ComponentVersionTree({ versions, selectedId, onSelect, onAdopt }: Props) {
  const { t } = useTranslation('academy');
  const formal = versions.filter((v) => v.kind === 'formal');
  const processOf = (formalId: string) => versions.filter((v) => v.kind === 'process' && v.parentVersionId === formalId);
  // 未挂到任何已知正式版下的过程版（数据异常兜底，挂列表尾）
  const orphanProc = versions.filter(
    (v) => v.kind === 'process' && (!v.parentVersionId || !formal.some((f) => f.id === v.parentVersionId)),
  );

  return (
    <div>
      <div className={`${SIDE_LABEL} mb-2 ml-0.5`}>{t('versionTree.title')}</div>
      {formal.map((f) => {
        const procs = processOf(f.id);
        return (
          <div key={f.id}>
            <VersionRow node={f} selected={selectedId === f.id} onSelect={() => onSelect(f.id)} />
            {procs.length > 0 && (
              /* 过程版分组（demo .ver-tree-proc：ml-22 + 左 2px border 竖线） */
              <div className="ml-[22px] border-l-2 border-border">
                {procs.map((p) => (
                  <VersionRow key={p.id} node={p} selected={selectedId === p.id} onSelect={() => onSelect(p.id)} onAdopt={onAdopt ? () => onAdopt(p.id) : undefined} />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {orphanProc.map((p) => (
        <VersionRow key={p.id} node={p} selected={selectedId === p.id} onSelect={() => onSelect(p.id)} onAdopt={onAdopt ? () => onAdopt(p.id) : undefined} />
      ))}
    </div>
  );
}

export default ComponentVersionTree;
