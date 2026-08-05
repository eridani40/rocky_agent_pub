/**
 * academy-version-dir — 版本工作区目录 IO 原语（spec §6.1 + §8 INV-5/INV-6）
 * 参考: specs/tech/academy/[P0]data_model.md §6.1 + §3.1（version.json 内容）
 *
 * 职责：版本工作区（workspaceDir）的 IO 原语——创建目录骨架 + 复制（fork）+ 读内容。
 * entity record 落盘走 CrudStore；workspace 内容（AGENTS.md + .rocky/ + version.json）走这里。
 *
 * skill 读侧（.rocky/skills/ 的目录 + 文件树 + hash）抽离到 academy-version-skills.ts。
 *
 * 不变量：
 *   - INV-5 fork/adopt 原子性：copyVersionDir dst 非空抛错（防覆盖）
 *   - INV-6 workspaceDir 不可变：fork/adopt 都复制不 rename 原 process 目录
 *   - 0.0 空版本 graceful：缺 AGENTS.md/skills 不报错（resolveVersionContent 静默跳过）
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { skillsRoot, listVersionSkillNames } from './academy-version-skills';

/** version.json 内容快照（五元组 a/d/e 部分） */
export interface VersionJson {
  /** 版本号字面量（冗余，便于离线工具识别） */
  versionLabel: string;
  /** a 模型快照 */
  model: { providerId?: string; modelId: string };
  /** e 工具白名单（可选；缺省 = student profile bound 全集） */
  tools?: string[];
}

/** writeVersionDirFiles 入参 */
export interface WriteVersionDirInput {
  /** 版本号字面量（versionLabel 必填） */
  versionLabel: string;
  /** a 模型 */
  model: { providerId?: string; modelId: string };
  /** b system prompt（AGENTS.md 全文；可选，0.0 空版本可缺） */
  agentsMd?: string;
  /** e 工具白名单（可选） */
  tools?: string[];
}

/** resolveVersionContent 出参：版本全量内容（五元组中 a/b/c/d/e 部分） */
export interface ResolvedVersionContent {
  /** b system prompt（AGENTS.md 全文；不存在 = ''） */
  agentsMd: string;
  /** d skills 目录名列表（.rocky/skills/<name>/，仅名字；内容按需读） */
  skillNames: string[];
  /** c memory 目录路径（.rocky/memory/，装配方用） */
  memoryDir: string;
  /** d skills 目录路径（.rocky/skills/，装配方用） */
  skillsDir: string;
  /** version.json（a/e 部分；不存在返 null） */
  versionJson: VersionJson | null;
  /** c memory 条目摘要（.rocky/memory/*.md，缺目录返 []，api §1.8） */
  memoryEntries: MemoryEntrySummary[];
}

/** memory md 文件摘要（api §1.8 MemoryEntrySummary）：name + 字节数 size + 前 200 字符 preview */
export interface MemoryEntrySummary {
  name: string;
  size: number;
  preview: string;
}

/** memory 根目录（ws/.rocky/memory） */
function memoryRoot(wsDir: string): string {
  return join(wsDir, '.rocky', 'memory');
}

/**
 * 写版本工作区目录骨架（幂等 recursive）：
 *   {wsDir}/
 *   ├── AGENTS.md                （若 agentsMd 提供；不提供则不创建，留 0.0 空版本空间）
 *   ├── version.json             （versionLabel + model + tools）
 *   └── .rocky/{skills,memory}/  （空目录骨架，后续 fork 写内容）
 *
 * 原子性 best-effort：先写子文件，version.json 最后写（存在 = 内容已齐的标记）。
 *
 * 注：fork/adopt 后如需调整 versionLabel，**MUST NOT** 调本函数（会重写 AGENTS.md 丢 skill/memory），
 * 改用 patchVersionJsonLabel 仅 patch version.json 单字段。
 */
export async function writeVersionDirFiles(
  wsDir: string,
  input: WriteVersionDirInput,
): Promise<void> {
  await fs.mkdir(wsDir, { recursive: true });
  await fs.mkdir(skillsRoot(wsDir), { recursive: true });
  await fs.mkdir(memoryRoot(wsDir), { recursive: true });

  if (input.agentsMd !== undefined && input.agentsMd.length > 0) {
    await fs.writeFile(join(wsDir, 'AGENTS.md'), input.agentsMd, 'utf8');
  }

  const versionJson: VersionJson = {
    versionLabel: input.versionLabel,
    model: input.model,
    ...(input.tools ? { tools: input.tools } : {}),
  };
  await fs.writeFile(join(wsDir, 'version.json'), JSON.stringify(versionJson, null, 2), 'utf8');
}

/**
 * 仅 patch version.json 的 versionLabel 字段（fork/adopt 后修复 BUG：record.versionLabel
 * 与 workspace 内 version.json.versionLabel 不一致）。
 *
 * **MUST NOT 用 writeVersionDirFiles**（会重写 AGENTS.md，丢 skill/memory 已有内容）；
 * 本函数只 patch version.json 单字段，不动其他。
 *
 * 容错：缺 version.json → 创建最小 `{versionLabel, model:{}}`（避免后续 resolveVersionContent 返 null）。
 *
 * @param wsDir    workspace 目录绝对路径（必须存在）
 * @param newLabel 新 versionLabel 字面量
 */
export async function patchVersionJsonLabel(
  wsDir: string,
  newLabel: string,
): Promise<void> {
  const vjPath = join(wsDir, 'version.json');
  let current: VersionJson;
  try {
    const raw = await fs.readFile(vjPath, 'utf8');
    current = JSON.parse(raw) as VersionJson;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    // 缺 version.json → 创建最小骨架（容错）
    current = { versionLabel: newLabel, model: { modelId: '' } };
  }
  current.versionLabel = newLabel;
  await fs.writeFile(vjPath, JSON.stringify(current, null, 2), 'utf8');
}

/**
 * 复制版本工作区目录（fork 原语，spec INV-5 原子性）。
 * 用 fs.cp recursive 整目录复制（含 AGENTS.md + .rocky/skills/memory + version.json）。
 * MUST NOT 覆盖已存在非空 dst（防二次 fork 撞目录）——dst 存在且非空则抛错。
 *
 * @param srcDir 源 workspace 目录（必须存在）
 * @param dstDir 目标 workspace 目录（必须不存在或为空）
 * @throws Error dst 已存在且非空
 */
export async function copyVersionDir(srcDir: string, dstDir: string): Promise<void> {
  // 检查 src 存在
  if (!existsSync(srcDir)) {
    throw new Error(`copyVersionDir: src ${srcDir} 不存在`);
  }
  // 检查 dst 非空（防覆盖）
  try {
    const existing = await fs.readdir(dstDir);
    if (existing.length > 0) {
      throw new Error(`copyVersionDir: dst ${dstDir} already exists and is not empty`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  // 确保 dst 父目录存在
  await fs.mkdir(dstDir, { recursive: true });
  // 递归复制
  await fs.cp(srcDir, dstDir, { recursive: true });
}

/**
 * 读版本工作区全量内容（spec §3 读路径单点 / INV-V1）。
 * 缺 AGENTS.md 返空串（0.0 空版本 graceful）；缺 version.json 返 null。
 *
 * @param wsDir workspace 绝对目录
 */
export async function resolveVersionContent(wsDir: string): Promise<ResolvedVersionContent> {
  // AGENTS.md（不存在 = ''，0.0 空版本允许）
  let agentsMd = '';
  try {
    agentsMd = await fs.readFile(join(wsDir, 'AGENTS.md'), 'utf8');
  } catch {
    // 不存在 = 空
  }

  const skillNames = await listVersionSkillNames(wsDir);

  // version.json（不存在 = null）
  let versionJson: VersionJson | null = null;
  try {
    const raw = await fs.readFile(join(wsDir, 'version.json'), 'utf8');
    versionJson = JSON.parse(raw) as VersionJson;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // 坏 JSON 不静默吞
  }

  // memory 条目摘要（.rocky/memory/*.md；缺目录返 []）
  const memoryEntries = await listMemoryEntries(wsDir);

  return {
    agentsMd,
    skillNames,
    memoryDir: memoryRoot(wsDir),
    skillsDir: skillsRoot(wsDir),
    versionJson,
    memoryEntries,
  };
}

/**
 * 列 `.rocky/memory/` 下 md 文件摘要（api §1.8）。
 * 仅读 `*.md` 文件（跳过子目录 / 非 md）；preview = 前 200 字符，size = 字节数。
 * 缺目录 / 读失败 graceful 返 []（0.0 空版本 / IO 错误均不抛）。本版只读。
 */
export async function listMemoryEntries(wsDir: string): Promise<MemoryEntrySummary[]> {
  const memDir = memoryRoot(wsDir);
  let entries;
  try {
    entries = await fs.readdir(memDir, { withFileTypes: true });
  } catch {
    return []; // .rocky/memory 不存在 = 无 memory（0.0 graceful）
  }
  const out: MemoryEntrySummary[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    try {
      const buf = await fs.readFile(join(memDir, e.name));
      out.push({ name: e.name, size: buf.byteLength, preview: buf.toString('utf8').slice(0, 200) });
    } catch { /* 单文件读失败跳过（best-effort） */ }
  }
  return out;
}
