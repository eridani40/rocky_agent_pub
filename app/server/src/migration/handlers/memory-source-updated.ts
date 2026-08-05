/**
 * memory-source-updated handler — 存量 memory entry 补 source/updatedAt 字段迁移。
 * 参考: specs/tech/agent/memory/[P0]memory_definition.md §3（entry schema：source/updatedAt）
 *       specs/tech/migration/[P0]migration_manager.md（handler 契约 + 失败由 manager catch）
 *
 * 两介质：
 *   (1) app_config record 'user_memory/default'.entries[]：逐条补 source(缺→'agent')/updatedAt(缺→now ISO)
 *   (2) {dataDir}/sessions/{sid}/session_memory.md：parse → 补 → serialize → atomicWrite
 *
 * 字段缺失 marker（per-entry）：
 *   - user_memory record：raw record.entries[] 每条 entry 直接判断 source/updatedAt 是否 undefined
 *   - session_memory.md：扫描 raw frontmatter 块，用 hasOwnProperty 在 gray-matter 解析后的 data
 *     上独立判定两字段是否缺失（parseMemoryFile 投影会填默认值，不能用作 marker）
 *
 * 非破坏：仅缺字段才补（source/updatedAt 独立判定；任一缺才补对应的字段）；
 *   不清其他字段（intro/type/body/why/howToApply/archived/evolvable 原样保留）；
 *   session_memory.md 块数 ≠ parseMemoryFile 投影 entries 数 → 跳过整个文件（不丢数据）。
 *
 * 幂等：二次运行所有 entry 已有两字段 → 无字段缺失 → no-op（不 set、不写盘）。
 * 失败抛错由 MigrationManager 统一 catch 记 ledger error（handler 内不再 catch）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import type { AppConfigService } from '../../config/app-config-service';
import { atomicWriteSync } from '../../persistence/fs-io';
import {
  parseMemoryFile,
  serializeMemoryFile,
  splitEntries,
  legacySessionMemoryFilePath,
} from './legacy-memory-format';
import type { MigrationHandlerContext } from '../ledger';

const USER_MEMORY_GROUP = 'user_memory';
const USER_MEMORY_KEY = 'default';

/** user_memory record entries 元素的 raw 形状（migration 关心 source/updatedAt，其他字段透传） */
interface UserMemoryRawEntry {
  name: string;
  intro?: string;
  description?: string; // 存量字段（读侧兜底，写不动）
  type: string;
  body: string;
  why?: string;
  howToApply?: string;
  archived?: boolean;
  evolvable?: boolean;
  source?: 'user' | 'agent';
  updatedAt?: string;
  [k: string]: unknown;
}

interface UserMemoryRawRecord {
  entries?: UserMemoryRawEntry[];
}

/**
 * 迁移 user_memory app_config record：逐条补 source(缺→'agent')/updatedAt(缺→now)。
 *
 * 直接操作 raw record.entries[]（不经 UserMemoryService.list 投影），独立判定每条 entry
 * 的 source/updatedAt 字段缺失。仅当至少一条 entry 被补才 set 回写；否则 no-op（幂等）。
 *
 * @returns 是否触发 set 回写
 */
function migrateUserMemoryRecord(
  appConfig: AppConfigService,
  nowIso: string,
): boolean {
  const raw = appConfig.get(USER_MEMORY_GROUP, USER_MEMORY_KEY);
  if (!raw || typeof raw !== 'object') return false;
  const rec = raw as UserMemoryRawRecord;
  if (!Array.isArray(rec.entries) || rec.entries.length === 0) return false;

  let changed = false;
  for (const e of rec.entries) {
    if (!e || typeof e !== 'object') continue;
    // 独立判定两字段缺失（非破坏：有就不动）
    if (e.source === undefined) {
      e.source = 'agent';
      changed = true;
    }
    if (e.updatedAt === undefined) {
      e.updatedAt = nowIso;
      changed = true;
    }
  }
  if (changed) {
    appConfig.set(USER_MEMORY_GROUP, USER_MEMORY_KEY, raw as Record<string, unknown>);
  }
  return changed;
}

/**
 * 迁移单个 session_memory.md：parse → 逐 entry 补 source/updatedAt → serialize → atomicWrite。
 *
 * 字段存在性基于 raw frontmatter 块独立 gray-matter 解析 + hasOwnProperty 判定
 * （parseMemoryFile 投影会把字段填默认值，无法判定原 frontmatter 是否含字段）。
 *
 * 非破坏保护：splitEntries 块数 ≠ parseMemoryFile 投影 entries 数
 *   → 含无法解析的 entry，跳过整个文件不写盘（不丢数据）。
 *
 * @returns 是否触发写盘
 */
function migrateSessionMemoryFile(filePath: string, nowIso: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }
  if (!raw || !raw.trim()) return false;

  const blocks = splitEntries(raw);
  const entries = parseMemoryFile(raw);
  if (entries.length === 0) return false;
  // 块数 ≠ 投影数 → 文件含无法解析的 entry → 跳过（不写盘，避免丢数据）
  if (blocks.length !== entries.length) return false;

  let changed = false;
  for (let k = 0; k < entries.length; k++) {
    const block = blocks[k]!;
    const entry = entries[k]!;
    let data: Record<string, unknown> = {};
    try {
      const m = matter(`---\n${block.fm}\n---\n${block.body}`);
      data = (m.data || {}) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(data, 'source')) {
      entry.source = 'agent';
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(data, 'updatedAt')) {
      entry.updatedAt = nowIso;
      changed = true;
    }
  }
  if (changed) {
    atomicWriteSync(filePath, serializeMemoryFile(entries));
  }
  return changed;
}

/**
 * 遍历 {dataDir}/sessions/{sid}/session_memory.md，对每个存在的 session memory 文件跑迁移。
 *
 * @returns 触发写盘的文件数
 */
function migrateAllSessionMemoryFiles(dataDir: string, nowIso: string): number {
  const sessionsDir = join(dataDir, 'sessions');
  if (!existsSync(sessionsDir)) return 0;
  let dirEntries: string[];
  try {
    dirEntries = readdirSync(sessionsDir);
  } catch {
    return 0;
  }
  let written = 0;
  for (const name of dirEntries) {
    const sidPath = join(sessionsDir, name);
    try {
      if (!statSync(sidPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const filePath = legacySessionMemoryFilePath(dataDir, name);
    if (!existsSync(filePath)) continue;
    if (migrateSessionMemoryFile(filePath, nowIso)) written++;
  }
  return written;
}

/**
 * memory-source-updated MigrationManager handler。
 *
 * 执行两介质迁移（user_memory record + session md）；任一介质失败抛错由 MigrationManager
 * 记 ledger error status，下次启动可重试（原 ad-hoc 顶层 try/catch warn 已移除）。
 *
 * @param ctx MigrationManager 注入（dataDir + appConfig）
 */
export const memorySourceUpdatedMigration = async (
  ctx: MigrationHandlerContext,
): Promise<void> => {
  const nowIso = new Date().toISOString();
  migrateUserMemoryRecord(ctx.appConfig, nowIso);
  migrateAllSessionMemoryFiles(ctx.dataDir, nowIso);
};
