/**
 * SkillInstaller 落盘核心 —— source-无关的 staging→校验→落盘通用范式（v0.0.166 抽出）
 * 参考: specs/tech/agent/skills/[P0]skill_architecture.md §5
 *       specs/tech/agent/skills/[P1]skill_market.md §7
 *       specs/api/overall/06-skill.md §2
 *
 * 背景：install 有两个来源——① multipart 上传（zip/folder/单 md，见 installer.ts）；
 * ② 市场下载（provider.fetchSkillFiles 取回 files:[{path,contents}]）。两路的
 * 「取文件/staging」各自独立，但「locateSkillRoot→parseSkillDir 校验→体积→冲突→
 * 原子 rename→重读」这段落盘核心完全相同 → 抽成本文件 source-无关核心，两路共用。
 *
 * 原子性（arch §5.4）：调用方先把文件 staging 到 dataDir 下的 tmp 目录，本核心校验后
 * rename 到目标；目标已存在不覆盖（抛 InstallError('conflict')，caller 映射 409）。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { parseSkillDir, builtinSkillRoot } from './resolver';
import { applyGovernance, readInstalledMarketRef } from './installer-frontmatter';
import type { SkillEntry, SkillScope } from './types';

/** 安装结果（成功落盘后的 SkillEntry） */
export interface InstallResult {
  entry: SkillEntry;
}

/** 安装请求参数 */
export interface InstallParams {
  scope: SkillScope;
  workspaceDir?: string;
  /**
   * v0.0.167：同源覆盖开关（默认 false=保持现 409 语义）。仅市场 HTTP install 传 true（更新重装）；
   * agent（skill_manage install）/ multipart 上传路径不开放，避免误覆盖。实际覆盖还须过 finalizeStagedSkill
   * 的同源守卫（overwrite=true 且磁盘 market_ref===本次 ref 才覆盖）。
   */
  overwrite?: boolean;
}

/**
 * 治理字段覆盖（落盘前写入 SKILL.md frontmatter，确保重扫一致）。
 * 市场下载路径用 `{ productionMethod:'download', evolvable:false }` + v0.0.167 来源三字段；
 * multipart 上传不传（保留源 frontmatter，行为不变）。
 */
export interface SkillGovernanceOverride {
  productionMethod?: SkillEntry['productionMethod'];
  evolvable?: boolean;
  // —— v0.0.167 市场来源锚点（applyGovernance 写 frontmatter market_ref/market_source/installed_hash；
  //    同源覆盖守卫读 marketRef 判同源）。全可选：multipart 不传 → 不写这些键 ——
  /** 安装用的 provider ref（如 github/awesome-copilot/git-commit）；同源判定 + 覆盖守卫依据 */
  marketRef?: string;
  /** provider id（如 skills_sh）；来源展示 */
  marketSource?: string;
  /** 安装时内容哈希（可更新惰性比对锚点） */
  installedHash?: string;
}

/** 安装错误（caller 映射 HTTP 状态码） */
export class InstallError extends Error {
  constructor(
    message: string,
    public code: 'bad_request' | 'conflict' | 'workspace_not_found' | 'too_large',
  ) {
    super(message);
    this.name = 'InstallError';
  }
}

/** skill 体积上限（50MB，api §2.3 §413） */
export const MAX_SKILL_BYTES = 50 * 1024 * 1024;

/** 取目标 scope 的 skill 根目录（v0.0.33.3 加 builtin 分支）。install(POST) 只用 app/workspace；builtin 供 read/toggle 复用。 */
export function scopeRoot(dataDir: string, params: InstallParams): string {
  if (params.scope === 'workspace') return join(params.workspaceDir!, '.rocky', 'skills');
  if (params.scope === 'builtin') return builtinSkillRoot();
  return join(dataDir, 'skills');
}

/**
 * source-无关落盘核心：从 staging tmp 目录校验并落盘（v0.0.166 从 installSkill 抽出）。
 * multipart 与市场下载两路共用；调用方负责先把文件 staging 到 tmpRoot、并在 finally 清理 tmpRoot。
 *
 * 流程：locateSkillRoot（含 SKILL.md 的根，兼容多一层顶层目录）→ parseSkillDir 校验 name →
 * subDir/name 一致性 → [governance 改写 frontmatter] → 体积 → 冲突（已存在→conflict）→
 * 原子 rename → 重读返回权威 SkillEntry。
 *
 * @param tmpRoot staging 区（调用方 mkdtemp + 写好文件）
 * @param dataDir app 数据根
 * @param params scope + workspaceDir
 * @param governance 可选治理覆盖（下载路径传 download/evolvable=false；multipart 不传）
 * @throws InstallError 校验/冲突/超限
 */
export function finalizeStagedSkill(
  tmpRoot: string,
  dataDir: string,
  params: InstallParams,
  governance?: SkillGovernanceOverride,
): InstallResult {
  const root = scopeRoot(dataDir, params);
  // 找含 SKILL.md 的根（zip 解压后可能多一层顶层目录；folder 多 part 时 tmpRoot 本身可能就是 skill 根）
  const staged = locateSkillRoot(tmpRoot);
  if (!staged) {
    throw new InstallError('SKILL.md not found in upload', 'bad_request');
  }
  // 校验 frontmatter name 合法 + 与目录名一致（api §10）
  const entry = parseSkillDir(staged.skillRoot, params.scope);
  if (!entry) {
    throw new InstallError('SKILL.md frontmatter missing valid name (kebab-case ≤64)', 'bad_request');
  }
  // name 与最终目录名（用 frontmatter name，非 staged 子目录名）
  if (staged.subDir && staged.subDir !== entry.name) {
    throw new InstallError(
      `directory name "${staged.subDir}" does not match frontmatter name "${entry.name}"`,
      'bad_request',
    );
  }

  // 治理覆盖（下载路径）：改写 staged SKILL.md frontmatter，使落盘后重扫（resolver）也一致
  if (governance) {
    applyGovernance(join(staged.skillRoot, 'SKILL.md'), governance);
  }

  // 体积校验
  const size = dirSize(staged.skillRoot);
  if (size > MAX_SKILL_BYTES) {
    throw new InstallError('skill too large (>50MB)', 'too_large');
  }

  // 目标路径 + 冲突检查（api §2.3 409）+ 同源覆盖守卫（v0.0.167，correctness-critical，invariant#1）
  const target = join(root, entry.name);
  if (existsSync(target)) {
    // 仅当：本次开启 overwrite + 本次为市场安装（governance.marketRef 有值）+ 磁盘已装 skill 的
    // frontmatter market_ref 与本次 ref **精确相等**（= 同源）→ 删旧目录后覆盖；否则一律 409。
    // 守卫**读磁盘 frontmatter，不信前端传参**：MUST NOT 覆盖本地（无 market_ref）或异源（market_ref 不同）同名 skill——误覆盖=数据丢失级 bug。
    const sameSource =
      params.overwrite === true &&
      !!governance?.marketRef &&
      readInstalledMarketRef(join(target, 'SKILL.md')) === governance.marketRef;
    if (!sameSource) {
      throw new InstallError('skill already exists', 'conflict');
    }
    rmSync(target, { recursive: true, force: true });
  }

  // 原子 rename（staged skillRoot → target）
  mkdirSync(root, { recursive: true });
  renameSync(staged.skillRoot, target);

  // 重读校验 frontmatter（落盘后权威）
  const finalEntry = parseSkillDir(target, params.scope);
  if (!finalEntry) {
    throw new InstallError('failed to parse installed skill', 'bad_request');
  }
  return { entry: { ...finalEntry, enabled: true } };
}

/**
 * 从 provider 取好的 files 落盘（市场安装路径，v0.0.166）。source-无关：不含 fetch / ref 解析 /
 * zipball / adm-zip（那是 provider 与 multipart 各自的职责）。
 *
 * 流程：mkdtemp staging → 逐个按 path 写盘（复用 assertWithinTmp 防路径遍历/注入）→
 * finalizeStagedSkill（治理强制 productionMethod='download' + evolvable=false，下载资产不给 agent 自改；
 * v0.0.167 若传 market 则并入 governance 追加 market_ref/market_source/installed_hash 来源锚点）。
 *
 * @param files provider.fetchSkillFiles 返回的内联文件（path 相对 skill 根，contents=utf-8 文本）
 * @param dataDir app 数据根
 * @param params scope + workspaceDir（市场安装落 app scope）；params.overwrite 透传同源覆盖守卫
 * @param market 可选市场来源元数据（marketRef/marketSource + 可选 installedHash）；不传 → 行为等价现状（仍 download/evolvable=false，不写来源键）
 * @throws InstallError 空 files / 路径非法 / 校验 / 冲突 / 超限
 */
export function stageAndInstallFiles(
  files: Array<{ path: string; contents: string }>,
  dataDir: string,
  params: InstallParams,
  market?: { marketRef: string; marketSource: string; installedHash?: string },
): InstallResult {
  if (!Array.isArray(files) || files.length === 0) {
    throw new InstallError('no files to install', 'bad_request');
  }
  // workspace 校验（与 installSkill 一致；市场安装通常 app scope，但仍支持 workspace）
  if (params.scope === 'workspace') {
    if (!params.workspaceDir || !isDirectory(params.workspaceDir)) {
      throw new InstallError('workspace not found', 'workspace_not_found');
    }
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-skill-install-'));
  try {
    for (const f of files) {
      const rel = typeof f?.path === 'string' ? f.path : '';
      if (!rel) throw new InstallError('invalid file path (empty)', 'bad_request');
      assertWithinTmp(tmpRoot, rel);
      const target = join(tmpRoot, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, typeof f.contents === 'string' ? f.contents : '', 'utf8');
    }
    return finalizeStagedSkill(tmpRoot, dataDir, params, {
      productionMethod: 'download',
      evolvable: false,
      ...market,
    });
  } finally {
    // 清理 tmp（无论成功失败）
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * 校验相对路径 rel 落在 tmpRoot 之内（防 zip-slip / 路径遍历越界写）。
 * 镜像 skill.ts handleFile 的越界检测写法。
 * @throws InstallError rel 为绝对路径 / 含 .. 段 / resolve 后不在 tmpRoot 树内
 */
export function assertWithinTmp(tmpRoot: string, rel: string): void {
  // 绝对路径直接拒（resolve 把它当 CWD 绝对，挡不住 /etc/x）
  if (isAbsolute(rel)) throw new InstallError('invalid path (absolute)', 'bad_request');
  // 含 .. 段显式拒（resolve+startsWith 也能挡，但显式拒更清晰）
  if (rel.split(/[/\\]/).includes('..')) throw new InstallError('invalid path (traversal)', 'bad_request');
  const resolved = resolve(tmpRoot, rel);
  const tmpRootSep = tmpRoot.endsWith(sep) ? tmpRoot : tmpRoot + sep;
  if (resolved !== tmpRoot && !resolved.startsWith(tmpRootSep)) {
    throw new InstallError('invalid path (out of staging root)', 'bad_request');
  }
}

/** staging 区内 skill 根定位结果 */
export interface StagedSkill {
  skillRoot: string;
  /** 若 skill 在子目录下（如 zip 顶层有 demo-skill/），子目录名 */
  subDir?: string;
}

/** 在 staging 区找含 SKILL.md 的根：先看 tmpRoot 自身，再看单层子目录 */
export function locateSkillRoot(tmpRoot: string): StagedSkill | null {
  if (existsSync(join(tmpRoot, 'SKILL.md'))) return { skillRoot: tmpRoot };
  let entries: string[];
  try {
    entries = readdirSync(tmpRoot);
  } catch {
    return null;
  }
  for (const n of entries) {
    const dir = join(tmpRoot, n);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(dir, 'SKILL.md'))) {
      return { skillRoot: dir, subDir: n };
    }
  }
  return null;
}

/** 判断路径是否目录（不存在/出错返 false） */
export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 计算目录总字节数（递归） */
export function dirSize(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const n of entries) {
    const p = join(dir, n);
    try {
      const st = statSync(p);
      if (st.isDirectory()) total += dirSize(p);
      else total += st.size;
    } catch {
      /* skip */
    }
  }
  return total;
}
