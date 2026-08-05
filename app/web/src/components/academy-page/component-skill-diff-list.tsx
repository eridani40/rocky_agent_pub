/**
 * component-skill-diff-list —— 版本 diff skills 段的两级渲染（skill 目录 × 目录内文件）
 * 参考: specs/ui/components/academy-page/component-skill-diff-list.md
 *       specs/ui/overall/12-academy.md §11（diff badge 配色）
 *       视觉基线沿用早期 training-result demo 的 `.skill-file`（外层卡沿用其视觉）
 *
 * skill 的载体是「目录 + SKILL.md + 任意附属文件」（skill_definition §1/§2），故 diff 必须两级：
 *   外层 = skill 目录（整体新增 / 已移除 / 文件修改 / 不变，可折叠；非「不变」默认展开）
 *   内层 = 目录内文件行（新增文件 / 删除文件 / 修改 / 二进制变更 / 不变）
 *
 * 纯展示：数据（四态判定 + 内容取用）全部由 `skill-diff.ts` + section 层准备好；
 * 行级 diff 复用 `line-diff.ts computeLineDiff` 与 diff-viewer 的 CmpCols/ColTag/DiffLines，
 * 本文件不自写 diff 算法与对比样式。二进制文件**绝不进 computeLineDiff**（只显标签 + 字节变化）。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { computeLineDiff } from './line-diff';
// 与 component-diff-viewer 互相引用（它渲染本组件、本组件复用它的对比原语）：
// 引用只在渲染期解析，模块初始化期不触达，ESM 循环安全——换成复制一份样式才是真问题。
import { CmpCols, ColTag, DiffLines, type SkillDirDiff, type SkillFileDiff } from './component-diff-viewer';

interface Props {
  /** 两级 diff（skill 名 asc，文件 path asc；由 skill-diff.ts buildSkillDirDiffs 产出） */
  dirs: SkillDirDiff[];
  /** base / 候选版本号（cmp-col-tag 文案，如 'base · v1.0'） */
  baseLabel: string;
  candLabel: string;
}

/** badge 通用样式（demo new-badge / mod-badge 尺寸） */
const BADGE = 'text-[10.5px] px-1.5 py-px rounded-sm font-semibold';

/** 字节数人类可读（二进制文件的变化表达；B/KB 为通用单位不入 i18n） */
function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** 目录级 badge（配色按 12-academy §11：新增 sage / 移除 danger / 修改 gold / 不变 muted） */
function DirBadge({ kind }: { kind: SkillDirDiff['changeKind'] }) {
  const { t } = useTranslation('academy');
  if (kind === 'added') return <span className={`${BADGE} bg-sage-bg text-sage`}>{t('diff.newSkill')}</span>;
  if (kind === 'removed') return <span className={`${BADGE} bg-danger-light text-danger`}>{t('diff.removedSkill')}</span>;
  if (kind === 'modified') return <span className={`${BADGE} bg-gold-bg text-[#b45309]`}>{t('diff.modSkill')}</span>;
  return <span className="text-[10.5px] text-muted">{t('diff.unchanged')}</span>;
}

/** 文件级 badge；binary 且有变更时统一显「二进制变更」（不可行级比对） */
function FileBadge({ file }: { file: SkillFileDiff }) {
  const { t } = useTranslation('academy');
  if (file.binary === true && file.changeKind !== 'unchanged') {
    return <span className={`${BADGE} bg-gold-bg text-[#b45309]`}>{t('diff.fileBinary')}</span>;
  }
  if (file.changeKind === 'added') return <span className={`${BADGE} bg-sage-bg text-sage`}>{t('diff.fileAdded')}</span>;
  if (file.changeKind === 'removed') return <span className={`${BADGE} bg-danger-light text-danger`}>{t('diff.fileRemoved')}</span>;
  if (file.changeKind === 'modified') return <span className={`${BADGE} bg-gold-bg text-[#b45309]`}>{t('diff.fileModified')}</span>;
  return <span className="text-[10.5px] text-muted">{t('diff.fileUnchanged')}</span>;
}

/** 单个文件行：可展开的行级 diff（仅「有变更 + 非 binary + 至少一侧有内容」时可展开） */
function SkillFileRow({ file, baseLabel, candLabel }: { file: SkillFileDiff; baseLabel: string; candLabel: string }) {
  // 二进制 / 不变 / 两侧都没取到内容 → 无行级 diff（降级为只显 badge，不整行报错）
  const diff = useMemo(() => {
    if (file.binary === true || file.changeKind === 'unchanged') return null;
    if (file.baseContent === undefined && file.candContent === undefined) return null;
    return computeLineDiff(file.baseContent ?? '', file.candContent ?? '');
  }, [file.binary, file.changeKind, file.baseContent, file.candContent]);
  const [open, setOpen] = useState(file.changeKind === 'modified');
  const expandable = diff !== null;
  const sizeText =
    file.binary === true
      ? [file.baseSize, file.candSize].some((s) => s !== undefined)
        ? `${file.baseSize !== undefined ? formatBytes(file.baseSize) : '—'} → ${file.candSize !== undefined ? formatBytes(file.candSize) : '—'}`
        : ''
      : '';

  return (
    <div className="mx-3 mb-1.5 last:mb-0 border border-border rounded-sm overflow-hidden">
      <div
        {...(expandable ? { role: 'button', tabIndex: 0 } : {})}
        onClick={expandable ? () => setOpen((o) => !o) : undefined}
        onKeyDown={
          expandable
            ? (e) => { if (e.key === 'Enter' || e.key === ' ') setOpen((o) => !o); }
            : undefined
        }
        className={`flex items-center gap-2 px-2.5 py-1.5 text-[11.5px] bg-surface ${expandable ? 'cursor-pointer hover:bg-accent-light' : ''}`}
      >
        <span className="font-mono text-fg truncate">{file.path}</span>
        <FileBadge file={file} />
        {sizeText !== '' && <span className="text-[10.5px] text-muted-2 font-mono">{sizeText}</span>}
        {/* caret 恒占位（不可展开时 opacity-0）——出现/消失不得挤动同行元素 */}
        <span className={`ml-auto text-muted-2 ${expandable ? '' : 'opacity-0'}`}>{open && expandable ? '▼' : '▶'}</span>
      </div>
      {expandable && open && diff && (
        <div className="border-t border-border">
          <CmpCols
            left={<><ColTag kind="base" label={baseLabel} /><DiffLines lines={diff.left} side="left" /></>}
            right={<><ColTag kind="cand" label={candLabel} /><DiffLines lines={diff.right} side="right" /></>}
          />
        </div>
      )}
    </div>
  );
}

/** 单个 skill 目录卡（demo .skill-file 视觉）：head 可折叠，body 是目录内文件行 */
function SkillDirCard({ dir, baseLabel, candLabel }: { dir: SkillDirDiff; baseLabel: string; candLabel: string }) {
  // 有变更（新增/移除/文件修改）默认展开；不变默认折叠
  const [open, setOpen] = useState(dir.changeKind !== 'unchanged');
  return (
    <div className="border border-border rounded-md mx-[15px] mb-3 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOpen((o) => !o); }}
        className="flex items-center gap-2 px-3 py-2 bg-bg-warm text-[12px] cursor-pointer hover:bg-accent-light"
      >
        <span className="text-fg">🧩 {dir.skillName}</span>
        <DirBadge kind={dir.changeKind} />
        <span className="ml-auto text-muted-2">{open ? '▼' : '▶'}</span>
      </div>
      {open && (
        <div className="border-t border-border py-2 bg-bg">
          {dir.files.map((f) => (
            <SkillFileRow key={f.path} file={f} baseLabel={baseLabel} candLabel={candLabel} />
          ))}
        </div>
      )}
    </div>
  );
}

/** skills 段两级 diff 列表（被 component-diff-viewer 的 skills 分支渲染） */
export function ComponentSkillDiffList({ dirs, baseLabel, candLabel }: Props) {
  const { t } = useTranslation('academy');
  if (dirs.length === 0) {
    return <div className="px-[15px] pb-3 text-[12px] text-muted">{t('skillBrowser.emptyTree')}</div>;
  }
  return (
    <div>
      {dirs.map((d) => (
        <SkillDirCard key={d.skillName} dir={d} baseLabel={baseLabel} candLabel={candLabel} />
      ))}
    </div>
  );
}

export default ComponentSkillDiffList;
