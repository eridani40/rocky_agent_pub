/**
 * team-sync-import-service — 团队同步导入：zip 解包 → 校验 → 建队（v0.0.319）
 * 参考: specs/prd/v0.0.319-team-sync.md §2.4（导入建队机制）
 *       specs/tech/version_logs/v0.0.319/change_plan.md D2
 *
 * 职责：
 *   - validateZipEntries：zip entry 路径安全校验（拒 ../绝对路径/盘符，防 path traversal）
 *   - parseManifestFromDir：从已解包目录找 manifest.json 并校验必填字段
 *   - unpackToTemp：解包 zip 到 os.tmpdir()/rocky-import-{ulid}
 *   - importSquadFromTempDir：createSquadService + 批量 createMemberService + copyTemplateFiles
 *   - ImportKeyStore：preview→execute 两阶段的 importKey → 临时目录映射（5min TTL 自动清理）
 *
 * 约束：MUST finally 清理临时目录；MUST best-effort hire（失败记 failed 不中断）。
 */
import AdmZip from 'adm-zip';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { ulid } from '../config/ulid';
import type { ManifestSchema } from './squad-template-service';
import { copyTemplateFiles } from './squad-template-service';
import { squadRootDir } from '../stores/squad-store';
import { createSquadService, type SquadServiceDeps } from './squad-service';
import { createMemberService, type CreateMemberDeps } from './member-service';

/** ImportKeyStore TTL：5 分钟（preview 后用户迟迟不 execute → 自动清理临时目录） */
const IMPORT_KEY_TTL_MS = 5 * 60 * 1000;

// ── 自定义错误（handler 映射 HTTP 状态码 + 可读文案）──

/** zip 格式/安全校验失败（→ 400） */
export class InvalidZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidZipError';
  }
}

/** importKey 过期/不存在（→ 400） */
export class ImportKeyExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportKeyExpiredError';
  }
}

/**
 * 校验 zip entries 路径安全（MANDATORY，防 path traversal）：
 * 拒绝含 `..`、绝对路径（/ 开头）、Windows 盘符（C:）的 entry。
 *
 * @throws InvalidZipError 含不安全 entry
 */
export function validateZipEntries(zip: AdmZip): void {
  for (const entry of zip.getEntries()) {
    const name = entry.entryName;
    if (name.startsWith('/') || name.includes('..') || /^[A-Za-z]:/.test(name)) {
      throw new InvalidZipError(`invalid zip entry: path traversal detected (${name})`);
    }
  }
}

/** manifest 必填字段校验（缺字段 → InvalidZipError 带字段名） */
function assertManifestShape(m: Record<string, unknown>): void {
  for (const field of ['slug', 'name', 'description', 'leaderName', 'members'] as const) {
    if (!(field in m) || m[field] === undefined || m[field] === null) {
      throw new InvalidZipError(`文件格式不正确：manifest 缺少 ${field}`);
    }
  }
  if (!Array.isArray(m.members)) {
    throw new InvalidZipError('文件格式不正确：manifest 结构无效（members 非数组）');
  }
}

/**
 * 在已解包目录下找 manifest.json 并解析校验。
 * zip 根可能是扁平结构，也可能有一层 {squadName}/ 子目录（风险点 §4）——两处都找。
 *
 * @returns { manifest, srcDir } srcDir = 含 manifest.json 的目录（建队复制配置的源）
 * @throws InvalidZipError manifest 缺失 / JSON 损坏 / 结构不合法
 */
export function parseManifestFromDir(tmpDir: string): { manifest: ManifestSchema; srcDir: string } {
  let manifestPath = path.join(tmpDir, 'manifest.json');
  let srcDir = tmpDir;
  if (!existsSync(manifestPath)) {
    // 一层子目录兜底（导出 zip 根目录为 {squadName}/）
    const sub = readdirSync(tmpDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .find((name) => existsSync(path.join(tmpDir, name, 'manifest.json')));
    if (!sub) throw new InvalidZipError('文件格式不正确：缺少 manifest.json');
    srcDir = path.join(tmpDir, sub);
    manifestPath = path.join(srcDir, 'manifest.json');
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new InvalidZipError('文件已损坏：manifest.json 无法解析');
  }
  assertManifestShape(parsed);
  return { manifest: parsed as unknown as ManifestSchema, srcDir };
}

/**
 * 解包 zip buffer 到临时目录 os.tmpdir()/rocky-import-{ulid}。
 * 调用前 MUST 已 validateZipEntries。调用方负责用完 rmSync 清理。
 */
export function unpackToTemp(zipBuffer: Buffer): string {
  const zip = new AdmZip(zipBuffer);
  validateZipEntries(zip);
  const tmpDir = path.join(os.tmpdir(), `rocky-import-${ulid()}`);
  zip.extractAllTo(tmpDir, true);
  return tmpDir;
}

/** 导入结果（201 响应 body） */
export interface ImportResult {
  squadId: string;
  created: string[];
  failed: string[];
}

/**
 * 从已解包临时目录建队（execute 阶段主体）。
 *
 * 步骤（PRD §2.4）：
 *   1. createSquadService（用户填的 name + manifest.description + 继承 modelDefault + leaderName）
 *   2. 遍历 manifest.members best-effort hire（失败记 failed 不中断）
 *   3. copyTemplateFiles（srcDir → 新 squad 目录；agents 按 nameToId 关联新 memberId）
 */
export async function importSquadFromTempDir(
  tmpDir: string,
  manifest: ManifestSchema,
  srcDir: string,
  input: { name: string; modelDefault: string; modelDefaultProviderId?: string },
  deps: SquadServiceDeps & CreateMemberDeps,
): Promise<ImportResult> {
  const { squad, leaderMember } = await createSquadService(deps, {
    name: input.name,
    description: manifest.description,
    modelDefault: input.modelDefault,
    ...(input.modelDefaultProviderId ? { modelDefaultProviderId: input.modelDefaultProviderId } : {}),
    leader: { name: manifest.leaderName },
  });

  // 批量 hire（best-effort：MemberNameConflictError 等失败记 failed 不中断，PRD §5.3）
  const nameToId = new Map<string, string>();
  // [v0.0.319-fix] leader 不在 manifest.members 里，但导出 zip 的 .rocky/agents/ 含 leader.md
  //   （导出时 leader-{memberId}.md 被 stripMemberIdSuffix 还原为 leader.md）
  //   → 补 `leader` → leaderMember.id 映射，copyTemplateFiles 才能命中改名 leader-{memberId}.md
  nameToId.set('leader', leaderMember.id as string);
  const created: string[] = [];
  const failed: string[] = [];
  for (const spec of manifest.members) {
    try {
      const result = await createMemberService(deps, {
        squadId: squad.id as string,
        mode: 'fresh',
        name: spec.name,
        intro: spec.intro,
        skillConfig: spec.skillConfig,
      });
      nameToId.set(spec.name, result.member.id as string);
      created.push(spec.name);
    } catch (e) {
      console.warn(`[team-sync-import] hire member "${spec.name}" failed:`, e);
      failed.push(spec.name);
    }
  }

  // 复制配置文件（复用 squad-template-service 的复制策略；内部 best-effort）
  // [v0.0.321] 传 manifest.leaderName → leader 文件产出 {leaderName}-{memberId}.md 实名格式
  copyTemplateFiles(srcDir, squadRootDir(deps.dataDir, squad.id as string), nameToId, manifest.leaderName);

  return { squadId: squad.id as string, created, failed };
}

/** preview 阶段登记项（importKey → 临时目录 + manifest） */
interface ImportKeyEntry {
  tmpDir: string;
  manifest: ManifestSchema;
  srcDir: string;
  createdAt: number;
  timer: NodeJS.Timeout;
}

/**
 * ImportKeyStore — preview→execute 两阶段的 importKey 映射（server 端内存 Map）。
 * set 时挂 5min TTL setTimeout 兜底清理（用户 preview 后不 execute 的泄漏防护）；
 * take（execute 消费）时清 timer。进程重启则丢失（tmpdir 由 OS 兜底清理，可接受）。
 */
export class ImportKeyStore {
  private readonly map = new Map<string, ImportKeyEntry>();

  /** 登记 preview 解包结果，返回 importKey */
  set(entry: { tmpDir: string; manifest: ManifestSchema; srcDir: string }): string {
    const importKey = ulid();
    const timer = setTimeout(() => {
      this.map.delete(importKey);
      rmSync(entry.tmpDir, { recursive: true, force: true });
    }, IMPORT_KEY_TTL_MS);
    timer.unref?.(); // 不阻塞进程退出
    this.map.set(importKey, { ...entry, createdAt: Date.now(), timer });
    return importKey;
  }

  /** 消费 importKey（execute）：取出并从 Map 删除 + 清 TTL timer；不存在返 undefined */
  take(importKey: string): ImportKeyEntry | undefined {
    const entry = this.map.get(importKey);
    if (!entry) return undefined;
    this.map.delete(importKey);
    clearTimeout(entry.timer);
    return entry;
  }
}
