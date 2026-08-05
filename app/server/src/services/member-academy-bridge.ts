/**
 * member-academy-bridge — squad ↔ academy 桥：预检 + 从学生版本目录 seed 团队 workspace。
 * 参考: specs/tech/academy/[P1]squad_derive.md §2.4 + [P1]derive_preview_conflict.md §2-§4（v0.0.233）。
 * 职责：derive_academy hire 把学生 workspace 关键内容复制到 squad 团队 workspace——
 *   AGENTS.md → .rocky/agents/{name}-{id}.md（个人差异）；.rocky/{skills,memory}/** → 团队层共享；
 *   源 = version.workspaceDir（INV-6）；返回写入路径列表供精确补偿（不 rm 团队根；同名默认 skip）。
 */
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AcademyStore } from '../academy/academy-store';

/**
 * derive_academy 源不可派生（classroom 不存在 / version 非 formal+active）。
 * member-service 捕获后转 DeriveSourceNotFoundError（对外错误契约统一）；
 * handler 按 mode='derive_academy' 转 400 invalid_academy_source（squad_derive §3）。
 */
export class InvalidAcademySourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAcademySourceError';
  }
}

/**
 * [v0.0.233] 同名裁决 per-item（derive_preview_conflict §3.1）。
 * action 闭合枚举 'skip' | 'overwrite'；前端预览面板同名项 toggle 产出。
 */
export type ResolutionItem = { name: string; action: 'skip' | 'overwrite' };

/**
 * [v0.0.233] hire body derive_academy 分支扩的可选裁决结果。
 * undefined = 默认全 skip 同名 + 不同名 merge（向后兼容，旧 client 不传 → 安全默认）。
 */
export interface DeriveResolution {
  skills?: ResolutionItem[];
  memory?: ResolutionItem[];
}

/**
 * [v0.0.233] 预检结果（derive_preview_conflict §2.2 / api 11a §2.5）。
 * AGENTS.md 无 sameNameConflict（个人差异文件名带 memberId，天然无同名概念）。
 */
export interface PreviewResult {
  agentsMd: { exists: boolean };
  skills: Array<{ name: string; sameNameConflict: boolean }>;
  memory: Array<{ name: string; sameNameConflict: boolean }>;
}

/**
 * derive_academy 入参校验 + 身份字段解析（squad_derive §2.2）。
 *
 * 校验顺序：
 *   1. academySource 三字段必填；与 deriveFrom 互斥（§5 INV-4）→ 普通 Error（handler 转 400 required）
 *   2. name 必填（member 要花名册名；版本内容复制不管名字）
 *   3. classroom 必须存在；version 必须 formal + active（process = 训练临时区不可派生，§5 INV-3）
 *      → InvalidAcademySourceError
 *
 * @returns 解析后的身份字段（name/intro/workStyle?；tools/skillConfig 由 member-service 补默认）
 */
export async function resolveAcademyDeriveIdentity(
  deps: { academyStore?: AcademyStore },
  input: {
    name?: string;
    intro?: string;
    workStyle?: string;
    deriveFrom?: string;
    academySource?: { classroomId: string; studentId: string; versionId: string };
  },
): Promise<{ name: string; intro: string; workStyle?: string }> {
  const src = input.academySource;
  if (!src || !src.classroomId || !src.studentId || !src.versionId) {
    throw new Error('academySource required (classroomId/studentId/versionId)');
  }
  if (input.deriveFrom !== undefined) {
    throw new Error('academySource and deriveFrom are mutually exclusive');
  }
  if (!input.name || input.name.length === 0) throw new Error('name required');
  const academyStore = deps.academyStore;
  if (!academyStore) throw new Error('academyStore not injected (required for derive_academy)');
  const classroom = await academyStore.getClassroom(src.classroomId);
  if (!classroom) throw new InvalidAcademySourceError(`academy classroom ${src.classroomId} not found`);
  const version = await academyStore.getVersion(src.classroomId, src.versionId);
  // status 缺省视为 'active'（schema：formal 默认 active）
  if (!version || version.type !== 'formal' || (version.status ?? 'active') !== 'active') {
    throw new InvalidAcademySourceError(
      `academy version ${src.versionId} not derivable (must be formal + active)`,
    );
  }
  return {
    name: input.name,
    intro: (input.intro ?? '').trim(),
    ...(input.workStyle !== undefined ? { workStyle: input.workStyle.trim() } : {}),
  };
}

/**
 * [v0.0.233 内部 helper] 枚举源侧顶层项（preview + seed 共用源枚举逻辑）。
 * 源 .rocky/skills / .rocky/memory 缺失 → 对应数组返空（与 seed 源缺失静默跳过口径一致）。
 * MUST NOT 抛错（源缺失返空，保证 preview/seed 源不可读时不炸）。
 */
async function enumerateVersionSource(sourceWorkspaceDir: string): Promise<{
  agentsMdExists: boolean;
  skillTopNames: string[];
  memoryTopNames: string[];
}> {
  const agentsMdExists = existsSync(join(sourceWorkspaceDir, 'AGENTS.md'));
  let skillTopNames: string[] = [];
  let memoryTopNames: string[] = [];
  try {
    skillTopNames = await readdir(join(sourceWorkspaceDir, '.rocky', 'skills'));
  } catch {
    // 源 .rocky/skills 缺失返空（学生 0.0 空版本可能无）
  }
  try {
    memoryTopNames = await readdir(join(sourceWorkspaceDir, '.rocky', 'memory'));
  } catch {
    // 源 .rocky/memory 缺失返空
  }
  return { agentsMdExists, skillTopNames, memoryTopNames };
}

/**
 * [v0.0.233] 预检：派生前纯只读探查，读源侧（version.workspaceDir）+ 目标侧（squad 团队盘）→ PreviewResult。
 *
 * 复用 resolveAcademyDeriveIdentity 做三字段 + classroom + version 校验（preview 无 name 概念，
 * 传占位 '__preview__' 满足 name 必填；返回的 identity 不被消费）。失败 throw InvalidAcademySourceError
 * → handler 转 400 invalid_academy_source（与 hire 错误码一致）。
 *
 * 纯只读无副作用（不写任何文件，只 existsSync/readdir 源和目标；derive_preview_conflict §2）。
 */
export async function previewDeriveAcademySeed(input: {
  academyStore: AcademyStore;
  classroomId: string;
  studentId: string;
  versionId: string;
  squadRoot: string;
}): Promise<PreviewResult> {
  await resolveAcademyDeriveIdentity(
    { academyStore: input.academyStore },
    {
      name: '__preview__', // 占位：preview 不建 member，name 不被消费；仅满足 resolveAcademyDeriveIdentity 必填
      academySource: {
        classroomId: input.classroomId,
        studentId: input.studentId,
        versionId: input.versionId,
      },
    },
  );
  const version = await input.academyStore.getVersion(input.classroomId, input.versionId);
  if (!version) throw new Error(`source version ${input.versionId} not found`);
  const sourceWorkspaceDir = version.workspaceDir;
  const { agentsMdExists, skillTopNames, memoryTopNames } = await enumerateVersionSource(sourceWorkspaceDir);
  // 目标侧只对源项 existsSync 检测同名（不列全目标目录）
  const skills = skillTopNames.map((name) => ({
    name,
    sameNameConflict: existsSync(join(input.squadRoot, '.rocky', 'skills', name)),
  }));
  const memory = memoryTopNames.map((name) => ({
    name,
    sameNameConflict: existsSync(join(input.squadRoot, '.rocky', 'memory', name)),
  }));
  return { agentsMd: { exists: agentsMdExists }, skills, memory };
}

/**
 * 从学生 formal 版本目录 seed 团队 workspace（落点重映射到团队层 + 个人差异文件）。
 *
 * [v0.0.233] 加 resolution?：同名项默认 skip（保留 squad 原有）/ 显式 overwrite（覆盖）/ 不同名 merge；
 * skip 项不入 written（补偿安全核心不变量，derive_preview_conflict §4）。
 *
 * @param resolution 可选裁决（undefined = 默认全 skip 同名 + 不同名 merge，向后兼容）
 * @returns 实际写入的顶层目标路径列表（个人差异文件 + 复制的 skills/memory 顶层项），
 *          供调用方失败补偿精确删除（只删自己写入的，MUST NOT rm 团队根）
 * @throws Error 版本不存在 / 非 formal / 已 rejected（防御；正常路径 resolveEffective 已拦截）
 */
export async function seedMemberWorkspaceFromVersion(input: {
  academyStore: AcademyStore;
  classroomId: string;
  sourceVersionId: string;
  squadRoot: string;
  memberName: string;
  memberId: string;
  resolution?: DeriveResolution;
}): Promise<string[]> {
  const version = await input.academyStore.getVersion(input.classroomId, input.sourceVersionId);
  if (!version) throw new Error(`source version ${input.sourceVersionId} not found`);
  if (version.type !== 'formal') throw new Error('cannot derive from process version (must be formal)');
  if (version.status === 'rejected') throw new Error('cannot derive from rejected version');

  // 源 = version.workspaceDir（INV-6 不可变字段，五元组落盘真相源）
  const sourceWorkspaceDir = version.workspaceDir;
  const written: string[] = [];

  // AGENTS.md → 个人差异文件 {squadRoot}/.rocky/agents/{memberName}-{memberId}.md
  // （无同名概念，复制不变；源缺失——0.0 空版本——静默跳过，不留空目录）
  const srcAgents = join(sourceWorkspaceDir, 'AGENTS.md');
  if (existsSync(srcAgents)) {
    const dstAgents = join(input.squadRoot, '.rocky', 'agents', `${input.memberName}-${input.memberId}.md`);
    try {
      await mkdir(join(input.squadRoot, '.rocky', 'agents'), { recursive: true });
      await copyFile(srcAgents, dstAgents);
      written.push(dstAgents);
    } catch {
      // 写失败静默跳过（与源缺失同口径；部分 seed 不视为事务失败）
    }
  }
  // .rocky/skills/** + .rocky/memory/** → 团队层 conditional copy（按 resolution 逐项 skip/overwrite/new）
  await copyDirTrackingConditional(
    join(sourceWorkspaceDir, '.rocky', 'skills'),
    join(input.squadRoot, '.rocky', 'skills'),
    written,
    input.resolution?.skills,
  );
  await copyDirTrackingConditional(
    join(sourceWorkspaceDir, '.rocky', 'memory'),
    join(input.squadRoot, '.rocky', 'memory'),
    written,
    input.resolution?.memory,
  );
  return written;
}

/**
 * [v0.0.233] 逐顶层项 conditional copy（替代原全量复制）：读 src 顶层 entries →
 * for each 项查 resolution + 目标 existsSync → skip/overwrite/new 分支；copied 项入 written（绝对路径）。
 *
 * - 同名 + 默认/显式 skip → 不动 squad 原有，不入 written（补偿安全核心不变量）
 * - 同名 + action='overwrite' 或不同名（new）→ 复制（目录 copyDirRecursive / 文件 copyFile）入 written
 * - 源 readdir 失败 → 直接 return（源缺失静默跳过，同原 copyDirTracking 口径）
 * - 单项复制失败 catch 不抛（部分复制失败容忍，已落盘项仍入 written）
 */
async function copyDirTrackingConditional(
  src: string,
  dst: string,
  written: string[],
  items: ResolutionItem[] | undefined,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(src, { withFileTypes: true });
  } catch {
    return; // 源缺失静默跳过（同原 copyDirTracking 口径，不回归）
  }
  for (const entry of entries) {
    const targetPath = join(dst, entry.name);
    const targetExists = existsSync(targetPath);
    const item = items?.find((it) => it.name === entry.name);
    // 同名 + 默认（item undefined）或显式 skip → 跳过不入 written
    if (targetExists && (item === undefined || item.action === 'skip')) {
      continue;
    }
    // overwrite（targetExists + action='overwrite'）或 new（!targetExists）：复制
    const srcPath = join(src, entry.name);
    try {
      if (entry.isDirectory()) {
        await copyDirRecursive(srcPath, targetPath);
      } else {
        await mkdir(dst, { recursive: true });
        await copyFile(srcPath, targetPath);
      }
      written.push(targetPath);
    } catch {
      // 部分复制失败容忍（同现状）—— 已落盘项仍入 written（补偿按实际写入删）
      if (existsSync(targetPath)) written.push(targetPath);
    }
  }
}

/** 递归复制目录（先 readdir 源——源不存在即抛错由调用方静默；源存在才 mkdir -p dst + 逐项 copyFile/递归，覆盖语义）。 */
export async function copyDirRecursive(src: string, dst: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dst, { recursive: true });
  for (const entry of entries) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) await copyDirRecursive(s, d);
    else await copyFile(s, d);
  }
}

/** [v0.0.250] derive（派生自成员）补齐：复制父成员个人差异 AGENTS.md → 子成员名下（data_model §5 step7.5；
 * 父无/失败 → 静默 no-op 不 throw，子继续用团队级 AGENTS.md 兜底）。源/目标路径按 {name}-{memberId}.md 字面拼。 */
export async function copyPersonalAgentsMd(input: {
  squadRoot: string;
  parentName: string;
  parentMemberId: string;
  childName: string;
  childMemberId: string;
}): Promise<void> {
  const agentsDir = join(input.squadRoot, '.rocky', 'agents');
  const src = join(agentsDir, `${input.parentName}-${input.parentMemberId}.md`);
  if (!existsSync(src)) return; // 父无个人 AGENTS.md → no-op
  try {
    await mkdir(agentsDir, { recursive: true });
    await copyFile(src, join(agentsDir, `${input.childName}-${input.childMemberId}.md`));
  } catch { /* 复制失败静默 no-op：不入 written、不 throw（同 derive_academy AGENTS.md 块口径） */ }
}
