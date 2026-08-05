/**
 * clean-squad-summary-model-default handler — 存量 squad record 清除 summary 模型字段。
 * 参考: specs/tech/version_logs/v0.0.158.compact_model_resolve/change_plan.md §H
 *       specs/tech/migration/[P0]migration_manager.md（handler 契约）
 *       specs/tech/squad/[P1]data_model.md §1.1（SquadSchema 字段表——v0.0.158 已删两字段）
 *
 * 背景：v0.0.158 SquadSchema 删除 `summaryModelDefault` + `summaryModelDefaultProviderId`
 * 两字段（Task-2 §G）。存量 squad record 的落盘 json 里仍带这两字段——虽然 CrudStore
 * 的 validateRecord 不拒收未定义字段（会被 spread 原样透传持久化），但 record 层遗留
 * 已废弃概念会长期污染磁盘 + 让读侧的 as unknown 类型断言隐藏 bug。本 handler 一次性 unset。
 *
 * 幂等（字段级 marker）：仅当 squad record 含 `summaryModelDefault` 或
 *   `summaryModelDefaultProviderId` 任一字段才走 delete + putSquad 回写；无 squad / 无字段
 *   → 静默 no-op。二次运行必然进 no-op 分支。
 *
 * 非破坏：只 delete 这两个 summary 字段 + 剥离 CrudStore 信封（createdAt/updatedAt/version
 *   由 store 注入，record 自带会被 validateRecord 拒收）；其他字段（name/modelDefault/
 *   modelDefaultProviderId/leaderId/memberIds/squadChatSessionId/lastWriteMessageId/
 *   budget/enableHeartBeat/timezone/heartbeatConfig 等）经 rest spread 原样保留。
 *
 * 写路径：走 `squadStore.putSquad`（AsyncPut + withFileLock 串行）——禁裸 fs。
 * 版本推进：CrudStore.putSquad 走 upsert 语义（version +1，updatedAt 推进 now）。
 * 存量 record 若缺 required 字段（历史不完整数据）→ validateRecord 抛 →
 * 由 MigrationManager 统一 catch 记 ledger error，不阻塞 bootstrap（handler 内不 catch）。
 */
import { SquadStore } from '../../stores/squad-store';
import type { MigrationHandlerContext } from '../ledger';

/** squad record 的 raw 形状（migration 关心的字段——两 summary 字段 v0.0.158 已从 schema 删除） */
interface SquadRawShape {
  /** 存量：默认整理模型 modelId（v0.0.158 删除） */
  summaryModelDefault?: unknown;
  /** 存量：默认整理模型 providerId（v0.0.158 删除） */
  summaryModelDefaultProviderId?: unknown;
  [k: string]: unknown;
}

/**
 * squad 存量 summary 字段清理 handler。
 * @param ctx MigrationManager 注入（dataDir 用于新建 SquadStore）
 */
export const cleanSquadSummaryModelDefaultMigration = async (
  ctx: MigrationHandlerContext,
): Promise<void> => {
  const squadStore = new SquadStore({ root: ctx.dataDir });
  const squads = await squadStore.listSquads();

  for (const squad of squads) {
    const raw = squad as unknown as SquadRawShape;
    const hasField =
      Object.prototype.hasOwnProperty.call(raw, 'summaryModelDefault') ||
      Object.prototype.hasOwnProperty.call(raw, 'summaryModelDefaultProviderId');
    // 字段级 marker：无 summary 字段 → 已是干净状态 → 跳过（幂等）
    if (!hasField) continue;

    // 剥信封字段 + 两 summary 字段（在 raw 浅拷贝上 delete，不影响原 raw）。
    // put 不允许 record 自带 createdAt/updatedAt/version——validateRecord 抛 SchemaValidationError。
    const rest: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    delete rest.createdAt;
    delete rest.updatedAt;
    delete rest.version;
    delete rest.summaryModelDefault;
    delete rest.summaryModelDefaultProviderId;

    // 走正规 putSquad（withFileLock + 信封重算，version+1）
    await squadStore.putSquad(rest as Parameters<typeof squadStore.putSquad>[0]);
  }
};
