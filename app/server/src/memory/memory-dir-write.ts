/**
 * memory-dir-write — memory per-entry md 目录存储（写侧：writeEntry / createEntry / archiveEntry）
 * 参考: specs/tech/agent/memory/[P0]memory_definition.md §5/§5.1（长度硬限 + evolvable 治理）
 *       app/server/src/memory/memory-dir-store.ts（读侧 + 类型/parse/serialize 共享层）
 *       specs/tech/version_logs/v0.0.238/change_plan.md 模块 F（字符口径 intro≤50 / body≤500）
 *       specs/tech/version_logs/v0.0.247/change_plan.md（存储数量硬上限 — writeLocked create 分支）
 *
 * 写侧契约：
 *   - per-entry 文件锁串行化（withFileLock 锁 `<dir>/<name>.md` 全期持锁）
 *   - intro ≤50 / body ≤500 字符硬限 + evolvable gate（policy 单点）在锁内原子执行（防 TOCTOU）
 *   - source/updatedAt 盖戳：create 盖 source（opts.source ?? 'agent'），update 保留既有 source
 *     （origin 不可变）；updatedAt create/update 始终刷新为 now；archive 不刷戳
 *   - write 语义不归档复活（archived 恒写 false）；archive 置标不删文件（可恢复）
 *
 * v0.0.247 存储数量硬上限（补 v0.0.238 注入配额存储侧缺口）：
 *   - 仅 create 路径（!existing 分支）查配额（不变量#1）；update / archiveEntry 不查（archive 不自锁）
 *   - count+check+write 在 dir 级虚拟锁（path.resolve(dir,'.quota.lock')）内原子（防并发 TOCTOU race）
 *   - 嵌套顺序固定：entry 锁（外）→ dir 锁（内，仅 create 分支），全路径一致无死锁
 *   - opts.store 可选（向后兼容存量 caller / UT 直接 writeLocked）
 */
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteSync } from '../persistence/fs-io';
import { withFileLock } from '../persistence/file-lock';
import {
  INTRO_CHAR_LIMIT,
  BODY_CHAR_LIMIT,
  MemoryCharLimitError,
  MemoryNonEvolvableError,
  resolvePersistedEvolvable,
  type MemoryWriteOpts,
} from './policy';
import {
  assertEntryName,
  assertType,
  entryFilePath,
  listMetas,
  parseEntryFile,
  readRaw,
  serializeEntryFile,
  type MemoryEntry,
  type MemoryWriteInput,
} from './memory-dir-store';
import { checkMemoryStoreQuota, resolveMemoryStoreQuotas } from './store-quota';

/**
 * 锁内写入共享实现（writeEntry / createEntry 共用）。
 * intro≤50 / body≤500 字符硬限 + evolvable gate + source/updatedAt 盖戳全在 per-entry 文件锁内原子执行。
 * @param forbidExisting true=create 语义（已存在抛 `already exists`，承载 UI POST 409）
 */
async function writeLocked(
  dir: string,
  input: MemoryWriteInput,
  opts: MemoryWriteOpts,
  forbidExisting: boolean,
): Promise<MemoryEntry> {
  const name = assertEntryName(input.name);
  const intro = String(input.intro ?? '').trim();
  const type = assertType(input.type);
  const body = String(input.body ?? '');
  if (!intro) throw new Error('memory entry intro is required');
  if (!body) throw new Error('memory entry body is required');

  const filePath = entryFilePath(dir, name);
  return withFileLock(filePath, async () => {
    // intro≤50 / body≤500 字符硬限（policy 单点；service 层单点，agent 工具 + UI HTTP 同款）
    const introLen = intro.length;
    if (introLen > INTRO_CHAR_LIMIT) throw new MemoryCharLimitError('intro', introLen, INTRO_CHAR_LIMIT);
    const bodyLen = body.trim().length;
    if (bodyLen > BODY_CHAR_LIMIT) throw new MemoryCharLimitError('body', bodyLen, BODY_CHAR_LIMIT);

    const existing = parseEntryFile(readRaw(filePath));
    if (forbidExisting && existing) {
      throw new Error(`memory entry already exists: ${name}`);
    }
    const existingEvolvable = existing ? existing.evolvable : undefined; // parse 已缺省 true

    // evolvable gate（进化性写 = 更新既有）：命中 evolvable=false 拒绝
    if (opts.enforceEvolvable && existingEvolvable === false) {
      throw new MemoryNonEvolvableError(name);
    }
    const evolvable = resolvePersistedEvolvable(opts, existingEvolvable);

    // source：create 盖（opts.source ?? 'agent' 存量默认）；update 保留既有 source（origin 不可变）
    const source: 'user' | 'agent' = existing ? existing.source : (opts.source ?? 'agent');
    // updatedAt：create/update 始终刷新为 now
    const updatedAt = new Date().toISOString();

    const next: MemoryEntry = {
      name,
      intro,
      type,
      archived: false, // write 语义：归档不被静默复活
      evolvable,
      source,
      updatedAt,
      body,
      ...(typeof input.why === 'string' && input.why.trim() ? { why: input.why.trim() } : {}),
      ...(typeof input.howToApply === 'string' && input.howToApply.trim() ? { howToApply: input.howToApply.trim() } : {}),
    };

    /** 落盘（mkdir + atomic write）—— create/update 共用 */
    const doWrite = (): MemoryEntry => {
      mkdirSync(dir, { recursive: true });
      atomicWriteSync(filePath, serializeEntryFile(next));
      return next;
    };

    // create 分支配额检查（v0.0.247）：opts.store 缺省 = 不查（向后兼容）
    // count+check+write 全部在 dir 级虚拟锁内原子（防并发 TOCTOU race）；嵌套顺序 entry 外/dir 内无死锁
    if (!existing && opts.store) {
      const quotaLockPath = path.resolve(dir, '.quota.lock');
      return withFileLock(quotaLockPath, async () => {
        const quotas = resolveMemoryStoreQuotas(opts.store!.appConfig);
        // 锁内扫描 listMetas 取 evolvable=false 计数（错误文案用；避免 checkMemoryStoreQuota 内再扫一次 listMetas）。
        // count 由 checkMemoryStoreQuota 内 listEntries({includeArchived:false}) 独立负责（不变量#2 archived 不计）。
        const evolvableFalseCount = listMetas(dir).filter((m) => !m.archived && m.evolvable === false).length;
        checkMemoryStoreQuota(dir, opts.store!.scope, quotas, { evolvableFalseCount });
        return doWrite();
      });
    }

    return doWrite();
  });
}

/**
 * writeEntry：upsert 单 entry 文件（同 name 更新）。
 * per-entry 文件锁全期持锁；intro/body 字符硬限 + evolvable gate + source/updatedAt 盖戳锁内原子执行。
 * @returns 写入后的 entry 全文形态
 */
export async function writeEntry(
  dir: string,
  input: MemoryWriteInput,
  opts: MemoryWriteOpts = {},
): Promise<MemoryEntry> {
  return writeLocked(dir, input, opts, false);
}

/**
 * createEntry：仅新建（name 已存在 → 抛 `already exists`，承载 UI POST 409 语义）。
 * exists 判定 + 写同一锁内完成（防 TOCTOU）。
 */
export async function createEntry(
  dir: string,
  input: MemoryWriteInput,
  opts: MemoryWriteOpts = {},
): Promise<MemoryEntry> {
  return writeLocked(dir, input, opts, true);
}

/**
 * archiveEntry：`archived=true` 置标（不删文件，可恢复）。
 * 未命中抛 not found；evolvable gate 锁内原子执行。
 * 非 write 路径不刷 source/updatedAt（保留既有戳）。
 */
export async function archiveEntry(
  dir: string,
  name: string,
  opts: { enforceEvolvable?: boolean } = {},
): Promise<MemoryEntry> {
  const nm = assertEntryName(name);
  const filePath = entryFilePath(dir, nm);
  return withFileLock(filePath, async () => {
    const cur = parseEntryFile(readRaw(filePath));
    if (!cur) throw new Error(`memory entry not found: ${nm}`);
    if (opts.enforceEvolvable && cur.evolvable === false) {
      throw new MemoryNonEvolvableError(nm);
    }
    const updated: MemoryEntry = { ...cur, archived: true };
    mkdirSync(dir, { recursive: true });
    atomicWriteSync(filePath, serializeEntryFile(updated));
    return updated;
  });
}
