/**
 * clean-default-models-summary handler — 存量 default_models record 清除 summary key。
 * 参考: specs/tech/version_logs/v0.0.158.compact_model_resolve/change_plan.md §H
 *       specs/tech/migration/[P0]migration_manager.md（handler 契约 + 失败由 manager catch）
 *
 * 背景：v0.0.158 删除「独立 summary 模型层」概念，收敛为「唯一 resolve 入口」。
 * 应用设置的默认模型 record（`default_models/default`）在旧版本可能含 `summary` key
 * （形如 `{ chat: {...}, summary: {...} }`）。本 handler 一次性清 `summary` key，
 * 保留 `chat` 及其他字段完整。
 *
 * 幂等（key 级 marker）：仅当 record 存在且含 `summary` 字段才 delete + set；record 不存在
 *   / 无 summary key → 静默 no-op。二次运行必然进 no-op 分支。
 *
 * 非破坏：只动 summary key，其他字段（chat / 未来可能新增的键）经 rest spread 原样保留。
 *
 * 走 AppConfigService.set 正规入口（禁裸 fs），复用 CrudStore.put 的信封 + 原子写。
 */
import type { MigrationHandlerContext } from '../ledger';

/** app_config `default_models` group 下 `default` key 的 record 形状 */
interface DefaultModelsRecord {
  /** 默认聊天模型 ModelRef（保留） */
  chat?: unknown;
  /** 存量：默认整理/压缩模型 ModelRef（v0.0.158 删除） */
  summary?: unknown;
  /** 其他未知字段（未来扩展或旧存量）——原样透传 */
  [k: string]: unknown;
}

const GROUP = 'default_models';
const KEY = 'default';

/**
 * default_models 存量 summary 清理 handler。
 * @param ctx MigrationManager 注入的上下文（本 handler 只用 appConfig）
 */
export const cleanDefaultModelsSummaryMigration = async (
  ctx: MigrationHandlerContext,
): Promise<void> => {
  const raw = ctx.appConfig.get(GROUP, KEY);
  // record 不存在 / 非对象 → 静默 no-op
  if (!raw || typeof raw !== 'object') return;

  const rec = raw as DefaultModelsRecord;
  // key 级 marker：无 summary 键 → 已是干净状态 → 静默 no-op（幂等）
  if (!Object.prototype.hasOwnProperty.call(rec, 'summary')) return;

  delete rec.summary;
  ctx.appConfig.set(GROUP, KEY, rec as Record<string, unknown>);
};
