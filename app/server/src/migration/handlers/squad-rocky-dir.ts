/**
 * squad-rocky-dir handler — squad 目录 `.rocky_squad/` 全量平移为 `.rocky/`。
 * 参考: specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A3
 *       states/v0.0.205.t2_cons/context.md（存储模型定稿：.rocky 收口 memory/skill/state）
 *
 * 行为（遍历 `<dataDir>/squads/<squadId>/`，仅当 `.rocky_squad/` 存在）：
 *   ① `.rocky_squad/memory.md` 经 frozen legacy parser 拆 entry → per-entry 写 `.rocky/memory/<name>.md`
 *   ② `.rocky_squad/state/`  递归复制 → `.rocky/state/`
 *   ③ `.rocky_squad/skills/` 递归复制 → `.rocky/skills/`
 *   ④ 三段迁完删旧段；`.rocky_squad/` 全空后删目录（有未知残留 → warn 保留不丢数据）
 *
 * 约束：
 *   - squad memory/state/skills 是有效数据 MUST 迁移（区别于 global memory 全删，PRD 定案 4）
 *   - memory 保留原 entry 全部字段戳（不刷新 source/updatedAt）；不过 长度硬限（存量豁免）
 *   - name 含路径分隔符的 entry 跳过 + warn（不阻塞整体迁移）
 *   - 目标段已存在时复制覆盖同路径文件（幂等重跑安全；force:true）
 *
 * 幂等：无 `.rocky_squad/` 即 skip；二次运行 no-op。失败抛错由 MigrationManager 记 ledger error。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteSync } from '../../persistence/fs-io';
import { serializeEntryFile, type MemoryEntry } from '../../memory/memory-dir-store';
import { parseMemoryFile, type LegacyMemoryEntry } from './legacy-memory-format';
import type { MigrationHandlerContext } from '../ledger';

/** legacy entry → per-entry MemoryEntry（剥 scope——位置即 scope） */
function toPerEntry(e: LegacyMemoryEntry): MemoryEntry {
  return {
    name: e.name,
    intro: e.intro,
    type: e.type,
    archived: e.archived,
    evolvable: e.evolvable,
    source: e.source,
    updatedAt: e.updatedAt,
    body: e.body,
    ...(e.why ? { why: e.why } : {}),
    ...(e.howToApply ? { howToApply: e.howToApply } : {}),
  };
}

/** name 是否可作 per-entry 文件名（无路径分隔符、非路径别名） */
function isValidEntryFileName(name: string): boolean {
  return Boolean(name) && !/[\/\\\n\r\t]/.test(name) && name !== '.' && name !== '..';
}

/** ① memory.md 拆 per-entry → <newRoot>/memory/；迁完删旧 memory.md */
function migrateMemoryMd(oldRoot: string, newRoot: string, squadId: string): void {
  const oldPath = join(oldRoot, 'memory.md');
  if (!existsSync(oldPath)) return;
  let raw = '';
  try {
    raw = readFileSync(oldPath, 'utf8');
  } catch {
    /* 读失败按空处理，走删除 */
  }
  const entries = raw.trim() ? parseMemoryFile(raw, 'squad') : [];
  if (raw.trim() && entries.length === 0) {
    // 非空但完全无法解析 → 保留旧文件不丢数据（warn；.rocky_squad 因残留保留）
    console.warn(`[squad-rocky-dir] squad=${squadId} memory.md 无法解析，保留旧文件不迁移`);
    return;
  }
  const destDir = join(newRoot, 'memory');
  mkdirSync(destDir, { recursive: true });
  for (const e of entries) {
    if (!isValidEntryFileName(e.name)) {
      console.warn(`[squad-rocky-dir] 跳过非法 name 的 entry（含路径分隔符）: ${JSON.stringify(e.name)} (squad=${squadId})`);
      continue;
    }
    atomicWriteSync(join(destDir, `${e.name}.md`), serializeEntryFile(toPerEntry(e)));
  }
  rmSync(oldPath, { force: true });
}

/** ②③ 目录段递归复制（state/skills）；迁完删旧段。目标已存在 → 覆盖同路径文件（幂等）。 */
function migrateDirSegment(oldRoot: string, newRoot: string, segment: 'state' | 'skills'): void {
  const src = join(oldRoot, segment);
  if (!existsSync(src)) return;
  try {
    if (!statSync(src).isDirectory()) return;
  } catch {
    return;
  }
  cpSync(src, join(newRoot, segment), { recursive: true, force: true });
  rmSync(src, { recursive: true, force: true });
}

/** 迁移单个 squad 目录；无 `.rocky_squad/` → skip */
function migrateOneSquad(dataDir: string, squadId: string): void {
  const squadDir = join(dataDir, 'squads', squadId);
  const oldRoot = join(squadDir, '.rocky_squad');
  if (!existsSync(oldRoot)) return;
  const newRoot = join(squadDir, '.rocky');

  migrateMemoryMd(oldRoot, newRoot, squadId);
  migrateDirSegment(oldRoot, newRoot, 'state');
  migrateDirSegment(oldRoot, newRoot, 'skills');

  // ④ 全空后删 `.rocky_squad/`；有未知残留 → warn 保留（不丢数据）
  let remaining: string[] = [];
  try {
    remaining = readdirSync(oldRoot);
  } catch {
    return; // 目录已不存在
  }
  if (remaining.length === 0) {
    rmSync(oldRoot, { recursive: true, force: true });
  } else {
    console.warn(`[squad-rocky-dir] squad=${squadId} .rocky_squad 有未知残留 ${JSON.stringify(remaining)}，保留目录`);
  }
}

/**
 * squad-rocky-dir MigrationManager handler。
 * @param ctx MigrationManager 注入（dataDir + appConfig；本 handler 只用 dataDir）
 */
export const squadRockyDirMigration = async (
  ctx: MigrationHandlerContext,
): Promise<void> => {
  const squadsRoot = join(ctx.dataDir, 'squads');
  if (!existsSync(squadsRoot)) return;
  let squadIds: string[];
  try {
    squadIds = readdirSync(squadsRoot);
  } catch {
    return;
  }
  for (const squadId of squadIds) {
    try {
      if (!statSync(join(squadsRoot, squadId)).isDirectory()) continue;
    } catch {
      continue;
    }
    migrateOneSquad(ctx.dataDir, squadId);
  }
};
