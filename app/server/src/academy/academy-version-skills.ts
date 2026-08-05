/**
 * academy-version-skills — 版本工作区 skill 读侧（spec §6.1 + api §1.8）
 * 参考: specs/tech/academy/[P0]data_model.md §6.1（路径）+ specs/api/overall/18-academy.md §1.8
 *
 * 职责：版本工作区（workspaceDir）下 `.rocky/skills/` 的读侧——列目录名、列文件树 +
 * 每文件 hash、解析单个 skill 目录路径。
 *
 * 复用 skills/ 子系统原语（buildFileTree / parseSkillDir），不重造遍历与 frontmatter 解析。
 *
 * 与 /skill 域的差异：**无 SKILL.md 的目录仍进列表**（description=undefined）——
 * 版本工作区是用户资产，不能因缺 frontmatter 就在 UI 里凭空消失。
 *
 * 从 academy-version-dir.ts 抽离（2026-07-30，≤300 行硬规则拆分）。
 */
import { promises as fs, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { buildFileTree } from '../skills/tree';
import { isValidSkillName, parseSkillDir } from '../skills/resolver';
import type { SkillFileNode } from '../skills/types';

/** skills 根目录（ws/.rocky/skills） */
export function skillsRoot(wsDir: string): string {
  return join(wsDir, '.rocky', 'skills');
}

/**
 * 版本 skill 文件树节点（api 18-academy §1.8）。
 * = /skill 域的 SkillFileNode + hash（file 才有）；两版本 diff 靠 hash 判「文件是否修改」。
 */
export interface AcademySkillFileNode extends SkillFileNode {
  /** file 内容哈希 = sha1(bytes) 前 12 hex；dir 无、读失败 undefined */
  hash?: string;
}

/**
 * 版本 skill 摘要（api 18-academy §1.8 的 content.skills 元素）。
 * skill 的载体是「目录 + SKILL.md + 任意附属文件」（skill_definition §1/§2），
 * 故本类型是目录 + 文件树，不是目录名。
 */
export interface SkillSummary {
  /** skill 目录名（= .rocky/skills/<name>/） */
  name: string;
  /** SKILL.md frontmatter description；无 SKILL.md / 无该字段 → undefined */
  description?: string;
  /** 目录内文件总数（递归，只数 file 不数 dir） */
  fileCount: number;
  /** 目录内文件树（扁平数组，path 相对 skill 目录） */
  files: AcademySkillFileNode[];
}

/**
 * 列 .rocky/skills/ 下 skill 目录名（asc 稳定序；目录不存在返 []）。
 *
 * 注：会话启动路径（handleStartStudentSession）与 resolveVersionContent 用它——
 * 只要名字，不付文件树/哈希的 IO 成本。UI 读侧要文件树用 listVersionSkills。
 */
export async function listVersionSkillNames(wsDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(skillsRoot(wsDir), { withFileTypes: true });
  } catch {
    return []; // .rocky/skills 不存在 = 无 skills（0.0 空版本 graceful）
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * 版本工作区内单个 skill 的目录路径（`<wsDir>/.rocky/skills/<name>`）。
 * skillName 非法（非 kebab-case / 含 `/`、`..` / 空 / 过长）返 null——
 * 绝不 join 未校验入参（路径穿越面）。
 *
 * @param wsDir     版本 workspace 绝对目录
 * @param skillName skill 目录名（HTTP 入参）
 */
export function versionSkillDir(wsDir: string, skillName: string): string | null {
  if (!isValidSkillName(skillName)) return null;
  return join(skillsRoot(wsDir), skillName);
}

/**
 * 列版本工作区全部 skill 的目录 + 文件树 + 每文件 hash（读侧契约，api §1.8）。
 *
 * 复用而非重造：文件树走 `skills/tree.ts buildFileTree`，description 走
 * `skills/resolver.ts parseSkillDir`（只取 description——版本资产不属四层 scope 语义，
 * scope/enabled/governance 字段丢弃）。
 *
 * @param wsDir 版本 workspace 绝对目录（.rocky/skills 不存在返 []，0.0 空版本 graceful）
 */
export async function listVersionSkills(wsDir: string): Promise<SkillSummary[]> {
  const names = await listVersionSkillNames(wsDir);
  const out: SkillSummary[] = [];
  for (const name of names) {
    const dir = join(skillsRoot(wsDir), name);
    const files: AcademySkillFileNode[] = buildFileTree(dir).map((node) =>
      node.type === 'file' ? { ...node, ...withHash(join(dir, node.path)) } : node,
    );
    const description = parseSkillDir(dir, 'workspace')?.description || undefined;
    out.push({
      name,
      ...(description ? { description } : {}),
      fileCount: files.filter((f) => f.type === 'file').length,
      files,
    });
  }
  return out;
}

/** 算文件内容哈希（sha1 前 12 hex）；读失败返空对象（节点仍进树，只是无 hash） */
function withHash(absPath: string): { hash?: string } {
  try {
    const hash = createHash('sha1').update(readFileSync(absPath)).digest('hex').slice(0, 12);
    return { hash };
  } catch {
    return {};
  }
}
