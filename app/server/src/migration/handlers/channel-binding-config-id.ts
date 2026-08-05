/**
 * channel-binding-config-id handler — channel_bindings 落盘记录 instanceId → configId 字段改名。
 * 参考: specs/tech/version_logs/v0.0.206/change_plan.md 模块九（用户裁决「改+做迁移」）
 *       specs/tech/migration/[P0]migration_manager.md（handler 契约 + 失败由 manager catch）
 *
 * 背景：v0.0.206 channel 无状态化重构把 ChannelBinding.instanceId 改名 configId（store schema
 *   同步改名）。未迁移的存量 binding 记录读不出 configId（undefined）→ bootstrap
 *   rebuildReverseIndex 建的反向索引全坏，binding 查找/echo 屏蔽/解绑全断（load-bearing）。
 *
 * 幂等（字段级 marker）：仅当记录顶层有 `instanceId` 字段才迁（configId 承接原值 + 删
 *   instanceId + atomicWriteSync 写回）；已迁（有 configId 无 instanceId）→ 跳过。二次运行
 *   扫描自然得空集 → 静默 no-op（ledger done 主防线之外的字段级保险）。
 *
 * 非破坏：信封字段（createdAt/updatedAt/version）不动；改前整目录一次性备份到
 *   `{dataDir}/channel_bindings.pre-configid.bak/`（已存在则不覆盖，保首次原貌——
 *   memory-intro 先例）。
 *
 * 边界（change_plan 模块九表）：仅迁 active dataDir 的 channel_bindings/*.json；
 *   历史 transcript 的 sender.channel 与 SSE origin 不迁（append-only 不可变历史 /
 *   运行时派生不落盘）。失败抛错由 MigrationManager 统一记 ledger error（handler 内不 catch）。
 */
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicWriteSync } from '../../persistence/fs-io';
import type { MigrationHandlerContext } from '../ledger';

/** channel_bindings 域目录名（FsCrudStore entity 布局：{dataDir}/channel_bindings/<id>.json） */
const BINDINGS_DIR = 'channel_bindings';
/** 备份目录名（不覆盖既有备份） */
const BACKUP_DIR = 'channel_bindings.pre-configid.bak';

/**
 * channel_bindings instanceId → configId 迁移 handler。
 * @param ctx MigrationManager 注入的上下文（dataDir 已 resolveDataDir 展开成绝对路径）
 */
export const channelBindingConfigIdMigration = async (
  ctx: MigrationHandlerContext,
): Promise<void> => {
  const dir = join(ctx.dataDir, BINDINGS_DIR);
  if (!existsSync(dir)) return; // 无 channel_bindings 目录 → no-op

  // 扫 *.json，逐文件读 JSON；字段级 marker = 顶层 instanceId 存在性
  const legacy: { file: string; record: Record<string, unknown> }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, 'instanceId')) {
      legacy.push({ file, record });
    }
  }
  if (legacy.length === 0) return; // 全量已迁 / 空目录 → no-op（幂等）

  // 非破坏：改前整目录一次性备份（已存在则不覆盖，保首次原貌）
  const backupDir = join(ctx.dataDir, BACKUP_DIR);
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      copyFileSync(join(dir, name), join(backupDir, name));
    }
  }

  // 逐文件迁移：configId 承接 instanceId 原值 + 删 instanceId + 原子写回（信封不动）
  for (const { file, record } of legacy) {
    record.configId = record.instanceId;
    delete record.instanceId;
    atomicWriteSync(file, JSON.stringify(record, null, 2));
  }
};
