/**
 * session-memory-per-entry handler — 旧 per-session 单文件 session_memory.md 拆分为 per-entry md。
 * 参考: specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A3
 *       states/v0.0.205.t2_cons/context.md（存储模型定稿：session memory 跟 session.workspaceDir/.rocky/memory/）
 *
 * 行为：
 *   - 遍历 `<dataDir>/sessions/<sid>/session_memory.md`（旧介质，v0.0.205 前）
 *   - 经 frozen legacy parser 拆 entry → 逐条写 `<wsDir>/.rocky/memory/<name>.md`
 *     （wsDir = session record 的 workspaceDir；record 缺失/无 workspaceDir → 回退 `<dataDir>/workspace`）
 *   - 全部有效 entry 写完 → 删旧 session_memory.md
 *
 * 约束：
 *   - 保留原 entry 全部字段戳（source/updatedAt/evolvable/archived 原样，不刷新——迁移非 write 路径）
 *   - 不过 长度硬限 / evolvable gate（存量豁免 grandfather，memory_definition §5）
 *   - name 含路径分隔符的 entry 跳过 + warn（per-entry 文件名不能含分隔符；不阻塞整体迁移）
 *   - 同 ws 两 session 同名冲突 = 后者覆盖（一份不阻止，context.md 定稿接受）
 *   - MUST NOT 触碰 app_config user_memory（global 不迁移，PRD 定案 4 全删）
 *
 * 幂等：无旧文件即 skip；二次运行无旧文件 → no-op。失败抛错由 MigrationManager 记 ledger error。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteSync } from '../../persistence/fs-io';
import {
  wsMemoryDir,
  serializeEntryFile,
  type MemoryEntry,
} from '../../memory/memory-dir-store';
import { parseMemoryFile, type LegacyMemoryEntry } from './legacy-memory-format';
import type { MigrationHandlerContext } from '../ledger';

/** session record 落盘路径（SessionSchema：{root}/session/<id>.json，单数目录） */
function sessionRecordPath(dataDir: string, sid: string): string {
  return join(dataDir, 'session', `${sid}.json`);
}

/** 从 session record 读 workspaceDir；record 缺失/损坏/字段空 → undefined（caller 回退默认 ws） */
function readWorkspaceDir(dataDir: string, sid: string): string | undefined {
  try {
    const raw = readFileSync(sessionRecordPath(dataDir, sid), 'utf8');
    const rec = JSON.parse(raw) as { workspaceDir?: unknown };
    const ws = typeof rec.workspaceDir === 'string' ? rec.workspaceDir.trim() : '';
    return ws || undefined;
  } catch {
    return undefined;
  }
}

/** legacy entry → per-entry MemoryEntry（剥 scope——位置即 scope，不落 frontmatter） */
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

/**
 * 迁移单个 session 的旧 memory 文件 → per-entry。
 * @returns true=发生了迁移（旧文件已删）；false=skip（无旧文件/空文件/无可解析 entry）
 */
function migrateOneSession(dataDir: string, sid: string): boolean {
  const oldPath = join(dataDir, 'sessions', sid, 'session_memory.md');
  if (!existsSync(oldPath)) return false;
  let raw: string;
  try {
    raw = readFileSync(oldPath, 'utf8');
  } catch {
    return false;
  }
  if (!raw.trim()) {
    // 空旧文件：直接删（无数据可迁）
    rmSync(oldPath, { force: true });
    return true;
  }
  const entries = parseMemoryFile(raw);
  if (entries.length === 0) return false; // 无法解析 → 保留原文件不丢数据（warn 由 manager 层面观察）

  const wsDir = readWorkspaceDir(dataDir, sid) ?? join(dataDir, 'workspace');
  const destDir = wsMemoryDir(wsDir);
  mkdirSync(destDir, { recursive: true });
  for (const e of entries) {
    if (!isValidEntryFileName(e.name)) {
      console.warn(`[session-memory-per-entry] 跳过非法 name 的 entry（含路径分隔符）: ${JSON.stringify(e.name)} (session=${sid})`);
      continue;
    }
    // 直写 per-entry 文件（保留原戳；同名冲突后者覆盖——一份不阻止）
    atomicWriteSync(join(destDir, `${e.name}.md`), serializeEntryFile(toPerEntry(e)));
  }
  rmSync(oldPath, { force: true });
  return true;
}

/**
 * session-memory-per-entry MigrationManager handler。
 * @param ctx MigrationManager 注入（dataDir + appConfig；本 handler 只用 dataDir）
 */
export const sessionMemoryPerEntryMigration = async (
  ctx: MigrationHandlerContext,
): Promise<void> => {
  const sessionsRoot = join(ctx.dataDir, 'sessions');
  if (!existsSync(sessionsRoot)) return;
  let sids: string[];
  try {
    sids = readdirSync(sessionsRoot);
  } catch {
    return;
  }
  for (const sid of sids) {
    try {
      if (!statSync(join(sessionsRoot, sid)).isDirectory()) continue;
    } catch {
      continue;
    }
    migrateOneSession(ctx.dataDir, sid);
  }
};
