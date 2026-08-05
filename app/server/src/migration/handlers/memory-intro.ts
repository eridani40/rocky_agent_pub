/**
 * memory-intro handler — memory entry frontmatter/record 的 `description` → `intro` 字段重命名。
 * 参考: specs/tech/agent/memory/[P0]memory_definition.md §3（entry schema）
 *       specs/tech/migration/[P0]migration_manager.md（handler 契约 + 失败由 manager catch）
 *
 * 覆盖两介质：
 *   1. session memory：<dataDir>/sessions/<sid>/session_memory.md（frontmatter description → intro）
 *   2. user memory：app_config record user_memory/default 的 entries[].description → intro
 *
 * 幂等（字段级 marker）：扫描 raw frontmatter 块独立 gray-matter 解析，判定 description 字段是否存在；
 *   任一存在才迁，全部已迁则 no-op（可安全重跑）。parseMemoryFile 投影会把 description 读成 intro（compat），
 *   无法从投影值判定原字段存在性，故扫描 raw 块独立判定。
 * 非破坏：intro 承接 description 原值；改前备份原文件 `.pre-intro.bak`（不覆盖既有备份）。
 *
 * 仅迁 active dataDir（bootstrap 传入，非扫多环境）；失败抛错由 MigrationManager 统一 catch 记
 * ledger error（handler 内不再 catch）。
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import type { AppConfigService } from '../../config/app-config-service';
import {
  parseMemoryFile,
  serializeMemoryFile,
  splitEntries,
} from './legacy-memory-format';
import type { MigrationHandlerContext } from '../ledger';

const USER_MEMORY_GROUP = 'user_memory';
const USER_MEMORY_KEY = 'default';
const BACKUP_SUFFIX = '.pre-intro.bak';

/** app_config user_memory record 形状（迁移读写用；description 为存量字段） */
interface UserMemoryRecordShape {
  entries: Array<Record<string, unknown>>;
}

/**
 * 迁移所有 session_memory.md 的 frontmatter description → intro。
 *
 * 幂等：块数 ≠ parseMemoryFile 投影 entries 数 → 文件含无法解析的 entry → 跳过整个文件（不丢数据）。
 * 非破坏：改前备份原文件 `.pre-intro.bak`（不覆盖既有备份，保首次原貌）。
 *
 * @returns 被改写的文件数
 */
function migrateSessionMemories(dataDir: string): number {
  const sessionsRoot = join(dataDir, 'sessions');
  if (!existsSync(sessionsRoot)) return 0;

  let migrated = 0;
  for (const sid of readdirSync(sessionsRoot)) {
    const filePath = join(sessionsRoot, sid, 'session_memory.md');
    if (!existsSync(filePath)) continue;

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    if (!raw.trim()) continue;

    const entries = parseMemoryFile(raw);
    if (entries.length === 0) continue;

    // 字段级 marker：raw 块独立解析，判定是否含 description 字段
    const blocks = splitEntries(raw);
    if (blocks.length !== entries.length) continue; // 含无法解析 entry → 跳过

    let needsMigrate = false;
    for (let k = 0; k < entries.length; k++) {
      const block = blocks[k]!;
      let data: Record<string, unknown> = {};
      try {
        const m = matter(`---\n${block.fm}\n---\n${block.body}`);
        data = (m.data || {}) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(data, 'description')) {
        needsMigrate = true;
        break;
      }
    }
    if (!needsMigrate) continue; // 已是 intro（无 description）→ 幂等不改

    const rewritten = serializeMemoryFile(entries);

    // 非破坏性：改前备份原文件（已存在则不覆盖）
    const backupPath = `${filePath}${BACKUP_SUFFIX}`;
    if (!existsSync(backupPath)) {
      try {
        copyFileSync(filePath, backupPath);
      } catch {
        // 备份失败 → 跳过此文件（保留原状，不丢数据）
        continue;
      }
    }
    writeFileSync(filePath, rewritten, 'utf8');
    migrated++;
  }
  return migrated;
}

/**
 * 迁移 user_memory record 的 entries[].description → intro。
 *
 * 幂等：仅对含 `description` 字段的 entry 迁移（intro 缺失时承接其值，随后删 description）；
 *   record 无任何 description → 不写回（可安全重跑）。
 *
 * @returns 被改写的 entry 数
 */
function migrateUserMemory(appConfig: AppConfigService): number {
  const rec = appConfig.get(USER_MEMORY_GROUP, USER_MEMORY_KEY) as
    | UserMemoryRecordShape
    | undefined;
  if (!rec || !Array.isArray(rec.entries)) return 0;

  let changed = 0;
  for (const entry of rec.entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (!('description' in entry)) continue; // 已迁 / 无存量字段 → 跳过
    // intro 缺失才承接 description（存量优先保 intro）
    if (entry.intro === undefined || entry.intro === null || entry.intro === '') {
      entry.intro = entry.description;
    }
    delete entry.description;
    changed++;
  }

  if (changed > 0) {
    appConfig.set(
      USER_MEMORY_GROUP,
      USER_MEMORY_KEY,
      rec as unknown as Record<string, unknown>,
    );
  }
  return changed;
}

/**
 * memory-intro MigrationManager handler。
 *
 * 执行两介质迁移（session md + user_memory record）；任一介质失败抛错由 MigrationManager
 * 记 ledger error status，下次启动可重试（原 ad-hoc 顶层 try/catch warn 已移除）。
 *
 * @param ctx MigrationManager 注入（dataDir + appConfig）
 */
export const memoryIntroMigration = async (
  ctx: MigrationHandlerContext,
): Promise<void> => {
  migrateSessionMemories(ctx.dataDir);
  migrateUserMemory(ctx.appConfig);
};
