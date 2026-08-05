/**
 * component-diff-viewer —— 版本逐项 diff（system/memory/skills/model 折叠卡）
 * 参考: specs/ui/components/academy-page/component-diff-viewer.md
 *       视觉基线沿用早期 training-result demo 的 `.diff-item / .cmp-cols / .skill-file / .diff-add / .diff-del`
 *
 * 每个 diff-item 一个 itemKind：head 折叠/展开（caret 90° 旋转），body 是 base vs 候选 cmp-cols；
 * skills 段是两级结构（skill 目录 × 目录内文件），渲染委托 `component-skill-diff-list`。
 */
import { useMemo, useState } from 'react';
import { computeLineDiff, type DiffLine } from './line-diff';
import { ComponentSkillDiffList } from './component-skill-diff-list';

/** diff 项类别 */
export type DiffItemKind = 'system' | 'memory' | 'skills' | 'model';

/** 两级 skill diff 的内层：skill 目录内单个文件 */
export interface SkillFileDiff {
  /** 相对 skill 目录的路径（如 SKILL.md / references/audit.py） */
  path: string;
  changeKind: 'added' | 'removed' | 'modified' | 'unchanged';
  /** 内容不可行级比对（后端读到二进制 / hash 缺失）→ 只显「二进制变更」+ size 变化 */
  binary?: boolean;
  /** 两侧内容（按需取用；缺省 = 无行级 diff，降级只显 badge） */
  baseContent?: string;
  candContent?: string;
  /** 两侧字节数（binary 文件的变化表达） */
  baseSize?: number;
  candSize?: number;
}

/** 两级 skill diff 的外层：一个 skill 目录 */
export interface SkillDirDiff {
  /** skill 目录名（= .rocky/skills/<name>/） */
  skillName: string;
  changeKind: 'added' | 'removed' | 'modified' | 'unchanged';
  files: SkillFileDiff[];
}

/** 一个 diff 项（折叠卡） */
export interface DiffItem {
  kind: DiffItemKind;
  icon: string;
  name: string;
  /** head 右侧摘要（如「AGENTS.md · 2 处增 1 处删」「未变」） */
  summary: string;
  defaultOpen?: boolean;
  /** system：AGENTS.md 两侧内容 */
  system?: { baseContent: string; candContent: string };
  /** memory：两侧条目列表（条目级对照） */
  memory?: { baseEntries: string[]; candEntries: string[] };
  /** skills：两级 diff（skill 目录 × 目录内文件） */
  skills?: { skills: SkillDirDiff[] };
  /** model：两侧展示文案 + 是否变化 */
  model?: { baseText: string; candText: string; changed: boolean };
}

interface Props {
  items: DiffItem[];
  /** base / 候选版本号（cmp-col-tag 文案用，如 'v1.0' / 'v2.0'） */
  baseLabel: string;
  candLabel: string;
}

/** 单侧行渲染（demo .code-block + .diff-add sage 底 / .diff-del danger 底线划）；供 skill diff 列表复用 */
export function DiffLines({ lines, side }: { lines: DiffLine[]; side: 'left' | 'right' }) {
  return (
    <div className="font-mono text-[12px] leading-[1.7] whitespace-pre-wrap break-words text-fg-2">
      {lines.map((l, i) => {
        if (l.type === 'same') return <div key={i}>{l.text || ' '}</div>;
        if (side === 'left' && l.type === 'del') {
          return (
            <div key={i}>
              <span className="bg-danger-light text-muted line-through rounded-[3px] px-[3px] py-px">{l.text || ' '}</span>
            </div>
          );
        }
        if (side === 'right' && l.type === 'add') {
          return (
            <div key={i}>
              <span className="bg-sage-bg rounded-[3px] px-[3px] py-px">{l.text || ' '}</span>
            </div>
          );
        }
        // 对侧不存在的行（左 add / 右 del 理论上不落该侧；跳过）
        if ((side === 'left' && l.type === 'add') || (side === 'right' && l.type === 'del')) return null;
        return <div key={i}>{l.text || ' '}</div>;
      })}
    </div>
  );
}

/** cmp-col-tag（demo：base muted / cand sage）；供 skill diff 列表复用 */
export function ColTag({ kind, label }: { kind: 'base' | 'cand'; label: string }) {
  return (
    <span
      className={
        'inline-block text-[11px] font-semibold mb-2 px-2 py-0.5 rounded-sm ' +
        (kind === 'base' ? 'bg-surface-2 text-muted' : 'bg-sage-bg text-sage')
      }
    >
      {label}
    </span>
  );
}

/** 双列对比容器（demo .cmp-cols：grid 1:1 + 之间 1px border）；供 skill diff 列表复用 */
export function CmpCols({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2">
      <div className="p-[13px_15px]">{left}</div>
      <div className="p-[13px_15px] border-l border-border">{right}</div>
    </div>
  );
}

/** 单项 diff 卡（折叠/展开） */
function DiffItemCard({ item, baseLabel, candLabel }: { item: DiffItem; baseLabel: string; candLabel: string }) {
  const [open, setOpen] = useState(item.defaultOpen === true);
  const systemDiff = useMemo(
    () => (item.system ? computeLineDiff(item.system.baseContent, item.system.candContent) : null),
    [item.system],
  );
  // memory 条目级对照：仅 cand 有 = add；仅 base 有 = del；共有 = same
  const memoryDiff = useMemo(() => {
    if (!item.memory) return null;
    const baseSet = new Set(item.memory.baseEntries);
    const candSet = new Set(item.memory.candEntries);
    const left: DiffLine[] = item.memory.baseEntries.map((e) => ({ type: candSet.has(e) ? 'same' : 'del', text: e }));
    const right: DiffLine[] = item.memory.candEntries.map((e) => ({ type: baseSet.has(e) ? 'same' : 'add', text: e }));
    return { left, right };
  }, [item.memory]);

  return (
    <div className={`border border-border rounded-xl bg-surface mb-3 overflow-hidden ${open ? 'open' : ''}`}>
      {/* diff-item-head（demo：p-12/16 cursor-pointer hover bg-warm + caret 旋转） */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOpen((o) => !o); }}
        className="flex items-center gap-2.5 px-4 py-3 cursor-pointer hover:bg-bg-warm"
      >
        <span className="text-[16px]">{item.icon}</span>
        <span className="text-[13.5px] font-semibold text-fg">{item.name}</span>
        <span className="ml-auto text-[11.5px] text-muted">{item.summary}</span>
        <span className={`text-muted-2 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>▶</span>
      </div>

      {open && (
        <div className="border-t border-border">
          {item.kind === 'system' && systemDiff && (
            <CmpCols
              left={<><ColTag kind="base" label={baseLabel} /><DiffLines lines={systemDiff.left} side="left" /></>}
              right={<><ColTag kind="cand" label={candLabel} /><DiffLines lines={systemDiff.right} side="right" /></>}
            />
          )}
          {item.kind === 'memory' && memoryDiff && (
            <CmpCols
              left={<><ColTag kind="base" label={baseLabel} /><DiffLines lines={memoryDiff.left} side="left" /></>}
              right={<><ColTag kind="cand" label={candLabel} /><DiffLines lines={memoryDiff.right} side="right" /></>}
            />
          )}
          {item.kind === 'skills' && item.skills && (
            <div className="pt-3">
              <ComponentSkillDiffList dirs={item.skills.skills} baseLabel={baseLabel} candLabel={candLabel} />
            </div>
          )}
          {item.kind === 'model' && item.model && (
            <CmpCols
              left={<><ColTag kind="base" label={baseLabel} /><div className="text-[12.5px] text-fg">{item.model.baseText}</div></>}
              right={
                <>
                  <ColTag kind="cand" label={candLabel} />
                  <div className="text-[12.5px] text-fg">
                    {item.model.candText}
                    {!item.model.changed && <span className="text-muted"> · {item.summary}</span>}
                  </div>
                </>
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

/** 逐项 diff 容器（itemKind 组合 × 4：system/memory/skills/model） */
export function ComponentDiffViewer({ items, baseLabel, candLabel }: Props) {
  return (
    <div>
      {items.map((item) => (
        <DiffItemCard key={item.kind} item={item} baseLabel={baseLabel} candLabel={candLabel} />
      ))}
    </div>
  );
}

export default ComponentDiffViewer;
