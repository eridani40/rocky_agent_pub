/**
 * skill-diff —— 两级 skill diff 的派生纯函数（skill 目录 × 目录内文件）
 * 参考: specs/ui/components/academy-page/component-skill-diff-list.md
 *       specs/api/overall/18-academy.md §1.8（SkillSummary = 目录 + 文件树 + per-file hash）
 *       specs/tech/agent/skills/[P0]skill_definition.md §1/§2（skill = 目录 + SKILL.md + 任意附属文件）
 *
 * 判定口径（三条硬约束）：
 *   1. 文件是否修改**只看后端 per-file hash**（sha1 前 12）——不看 size，同长度改动用 size 会漏判。
 *   2. 只在 base 侧出现的 skill / 文件是 `removed`（不是「不变」）。
 *   3. 内容不可比对的文件（后端 hash 缺失 = 读失败，或读到二进制）标 `binary`：
 *      不参与内容取用、不进行级 diff，渲染层只显「二进制变更」+ size 变化。
 *
 * 全部纯函数、无 IO：需要哪些文件的两侧内容由 `collectDiffFileRefs` 列清单，
 * 异步取用在 section 层完成后用 `applySkillFileContents` 回填。
 */
import type { AcademySkillFileNode, SkillSummary } from '../../lib/academy-api';
import type { SkillDirDiff, SkillFileDiff } from './component-diff-viewer';

/** 单次 diff 最多取多少个文件的内容（防一次 fork 改几十文件时的请求风暴） */
export const DEFAULT_DIFF_FILE_LIMIT = 20;

/** 需要取内容的文件引用（section 层按此清单并发拉取） */
export interface SkillFileRef {
  skillName: string;
  /** 相对 skill 目录的路径 */
  path: string;
  /** 需要 base 版本内容（added 文件不需要） */
  needBase: boolean;
  /** 需要候选版本内容（removed 文件不需要） */
  needCand: boolean;
}

/** 取回的文件内容（回填入参） */
export interface LoadedSkillFile {
  skillName: string;
  path: string;
  baseContent?: string;
  candContent?: string;
  /** 后端标记的二进制目标（content 恒 ''） */
  binary?: boolean;
}

/** 扁平文件树 → path→节点 映射；只收 file 节点（dir 节点无内容可比对） */
function fileMap(files: AcademySkillFileNode[]): Map<string, AcademySkillFileNode> {
  const m = new Map<string, AcademySkillFileNode>();
  for (const f of files) {
    if (f.type === 'file') m.set(f.path, f);
  }
  return m;
}

/**
 * 单个文件的四态判定。
 *
 * 双侧都有时用 hash 比对；任一侧 hash 缺失（后端读失败）= 无法证明相同 →
 * 保守判 `modified` 并标 `binary`（不可行级比对，渲染层只显标签）。
 */
function toFileDiff(path: string, bf?: AcademySkillFileNode, cf?: AcademySkillFileNode): SkillFileDiff {
  const d: SkillFileDiff = { path, changeKind: 'unchanged' };
  if (bf?.size !== undefined) d.baseSize = bf.size;
  if (cf?.size !== undefined) d.candSize = cf.size;
  if (!bf) d.changeKind = 'added';
  else if (!cf) d.changeKind = 'removed';
  else if (!bf.hash || !cf.hash) d.changeKind = 'modified';
  else d.changeKind = bf.hash === cf.hash ? 'unchanged' : 'modified';
  // 存在侧的 hash 缺失 → 内容不可比对
  if ((bf !== undefined && bf.hash === undefined) || (cf !== undefined && cf.hash === undefined)) d.binary = true;
  return d;
}

/** 两侧 skill 摘要 → 文件级 diff 列表（path asc 稳定序） */
function diffFiles(base: SkillSummary | undefined, cand: SkillSummary | undefined): SkillFileDiff[] {
  const b = fileMap(base?.files ?? []);
  const c = fileMap(cand?.files ?? []);
  const paths = [...new Set([...b.keys(), ...c.keys()])].sort();
  return paths.map((p) => toFileDiff(p, b.get(p), c.get(p)));
}

/**
 * 两个版本的 skills 摘要 → 两级 diff（skill 目录 asc × 文件 path asc 稳定序）。
 *
 * 目录级四态：仅候选有 = `added`；仅 base 有 = `removed`；两侧都有且任一文件非 unchanged
 * = `modified`（含 SKILL.md 之外的附属文件改动）；否则 `unchanged`。
 *
 * @param baseSkills base 版本 `content.skills`
 * @param candSkills 候选版本 `content.skills`
 */
export function buildSkillDirDiffs(baseSkills: SkillSummary[], candSkills: SkillSummary[]): SkillDirDiff[] {
  const b = new Map(baseSkills.map((s) => [s.name, s]));
  const c = new Map(candSkills.map((s) => [s.name, s]));
  const names = [...new Set([...b.keys(), ...c.keys()])].sort();
  return names.map((skillName) => {
    const bs = b.get(skillName);
    const cs = c.get(skillName);
    const files = diffFiles(bs, cs);
    const changeKind: SkillDirDiff['changeKind'] = !bs
      ? 'added'
      : !cs
        ? 'removed'
        : files.some((f) => f.changeKind !== 'unchanged')
          ? 'modified'
          : 'unchanged';
    return { skillName, changeKind, files };
  });
}

/**
 * 从两级 diff 中摘出「需要取内容」的文件清单：`changeKind !== 'unchanged'` 且非 binary。
 *
 * 超过 `limit` 的候选一律不取（`truncated=true` → 渲染层显 `diff.filesTruncated`）：
 * 行级 diff 是锦上添花，不值得为它打几十个请求。
 *
 * @param dirs  buildSkillDirDiffs 的产出
 * @param limit 最多取多少个文件（默认 20）
 */
export function collectDiffFileRefs(
  dirs: SkillDirDiff[],
  limit: number = DEFAULT_DIFF_FILE_LIMIT,
): { refs: SkillFileRef[]; truncated: boolean } {
  const refs: SkillFileRef[] = [];
  let truncated = false;
  for (const dir of dirs) {
    for (const f of dir.files) {
      if (f.changeKind === 'unchanged' || f.binary === true) continue;
      if (refs.length >= limit) {
        truncated = true;
        continue;
      }
      refs.push({
        skillName: dir.skillName,
        path: f.path,
        needBase: f.changeKind !== 'added',
        needCand: f.changeKind !== 'removed',
      });
    }
  }
  return { refs, truncated };
}

/** 回填用的键（skillName + path，用 NUL 分隔避免路径拼接歧义） */
function refKey(skillName: string, path: string): string {
  return `${skillName}\u0000${path}`;
}

/**
 * 把取回的两侧内容回填进两级 diff（返回新数组，入参不变）。
 *
 * 后端标 binary 的文件只落 `binary=true` 且**清空两侧内容**——保证渲染层
 * 无论如何都不会把二进制内容塞进 `computeLineDiff`。取内容失败的文件不在
 * `loaded` 里，保持无 `baseContent/candContent` → 渲染层自然降级为「无行级 diff」。
 */
export function applySkillFileContents(dirs: SkillDirDiff[], loaded: LoadedSkillFile[]): SkillDirDiff[] {
  if (loaded.length === 0) return dirs;
  const m = new Map(loaded.map((l) => [refKey(l.skillName, l.path), l]));
  return dirs.map((dir) => ({
    ...dir,
    files: dir.files.map((f) => {
      const hit = m.get(refKey(dir.skillName, f.path));
      if (!hit) return f;
      if (hit.binary === true) return { ...f, binary: true, baseContent: undefined, candContent: undefined };
      const next: SkillFileDiff = { ...f };
      if (hit.baseContent !== undefined) next.baseContent = hit.baseContent;
      if (hit.candContent !== undefined) next.candContent = hit.candContent;
      return next;
    }),
  }));
}
