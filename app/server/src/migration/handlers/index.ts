/**
 * handler 静态注册表（id → handler 函数引用）。
 * 参考: specs/tech/version_logs/v0.0.150/change_plan.md §A（handler registry 静态 map）
 *
 * **关键设计**：用静态 import map 而非 dynamic import。
 * dynamic import 在 packaged asar 中有坑（BUG-003 plugin 教训类比）—— 解析路径在 asar 内
 * 不稳定。静态 map 在编译期就把所有 handler 拉进 bundle，packaged 模式零路径解析风险。
 *
 * 新增 handler 步骤：
 *   1. 在 `handlers/<id>.ts` 实现 `export const xxxHandler = async (ctx) => { ... }`
 *   2. 在 `handlers.yaml` 加一条 `{ id, versionRange, module }`
 *   3. 在本文件 import + 加入 handlerRegistry map
 */
import { cleanDefaultModelsSummaryMigration } from './clean-default-models-summary';
import { cleanSquadSummaryModelDefaultMigration } from './clean-squad-summary-model-default';
import { dummyUpdate } from './dummy-update';
import { memoryIntroMigration } from './memory-intro';
import { memorySourceUpdatedMigration } from './memory-source-updated';
import { sessionDerivationMainToParentMigration } from './session-derivation-main-to-parent';
import { sessionMemoryPerEntryMigration } from './session-memory-per-entry';
import { squadRockyDirMigration } from './squad-rocky-dir';
import { channelBindingConfigIdMigration } from './channel-binding-config-id';
import type { HandlerEntry, MigrationHandlerContext } from '../ledger';

/** handler 函数签名 —— 接收 MigrationHandlerContext，返回 Promise<void>，失败抛错由 manager catch */
export type MigrationHandler = (ctx: MigrationHandlerContext) => Promise<void>;

/**
 * 静态 handler 注册表：handler id → 函数引用。
 *
 * MigrationManager.loadRegistry() 读 handlers.yaml 得 HandlerEntry[]，再用本 map
 * 把 entry.module 解析成实际函数引用。
 */
export const handlerRegistry: Record<string, MigrationHandler> = {
  'dummy-update': dummyUpdate,
  'memory-source-updated': memorySourceUpdatedMigration,
  'memory-intro': memoryIntroMigration,
  // v0.0.158 存量清理：删除「独立 summary 模型层」概念遗留数据
  'clean-default-models-summary': cleanDefaultModelsSummaryMigration,
  'clean-squad-summary-model-default': cleanSquadSummaryModelDefaultMigration,
  // v0.0.204 derivation 改名：存量 session record derivation 'main' → 'parent'
  //   （schema enumValues 改名后，老 record put 必崩——本迁移 load-bearing）
  'session-derivation-main-to-parent': sessionDerivationMainToParentMigration,
  // v0.0.205 存储模型统一：session memory 拆 per-entry + squad `.rocky_squad/`→`.rocky/` 平移
  'session-memory-per-entry': sessionMemoryPerEntryMigration,
  'squad-rocky-dir': squadRockyDirMigration,
  // v0.0.206 channel 无状态化：channel_bindings 记录 instanceId → configId 字段改名
  //   （不迁则 bootstrap 反向索引断链——load-bearing）
  'channel-binding-config-id': channelBindingConfigIdMigration,
};

/**
 * 从 HandlerEntry 查找 handler 函数。
 * @throws entry.id 未在 handlerRegistry 注册时抛错（manager 会 catch 进 summary.errors）
 */
export function resolveHandler(entry: HandlerEntry): MigrationHandler {
  const fn = handlerRegistry[entry.id];
  if (!fn) {
    throw new Error(`handler "${entry.id}" 未在 handlerRegistry 注册（handlers/index.ts）`);
  }
  return fn;
}

/** 重新导出方便 barrel */
export type { HandlerEntry };
