/**
 * MigrationManager 的 ledger 数据形状 + handler 适用性判定 + handler 上下文类型。
 * 参考: specs/tech/version_logs/v0.0.150/change_plan.md §A（MigrationManager 核心）
 *
 * ledger = 持久化于 `<DATA_DIR>/migration_state.json` 的迁移状态记录，由 MigrationManager
 * 原子读写（writeFileSync tmp + renameSync），不走 CrudStore（避免循环依赖）。
 *
 * 设计原则：
 *   - applied 主防线：handler 一旦 status='done'，二次启动不再跑（即使 range 仍满足）
 *   - versionRange 兜底：range 不满足（升级过头）的 handler 也不再跑
 *   - forward-only：不记录回滚路径，error 状态不自动重试（由人工介入）
 *
 * MigrationHandlerContext 放此处（而非 migration-manager.ts）以避免 migration-manager ↔ handlers
 * 循环引用：handlers/index.ts 的 MigrationHandler 契约引用 MigrationHandlerContext，从 ledger.ts
 * 读类型即可，无需 import migration-manager.ts。
 */
import type { AppConfigService } from '../config/app-config-service';
import { satisfiesRange } from './version-range';

/** ledger 文件名（单一权威源；MigrationManager 写、handleBootstrapStatus 读，共用） */
export const LEDGER_FILENAME = 'migration_state.json';

/**
 * 单个 handler 在 ledger 中的状态条目。
 *   - status='done'：正常完成（主防线）
 *   - status='error'：上次执行抛错（error 字段必填）
 *   - status='na'：range 不满足，跳过
 */
export interface HandlerState {
  status: 'done' | 'error' | 'na';
  appliedAt: string;
  appVersion: string;
  error?: { message: string; stack?: string };
}

/**
 * handler 注册表（handlers.yaml）单条 schema。
 * module 字段为相对 `./handlers/` 的路径，由 handlerRegistry 静态 import map 解析。
 */
export interface HandlerEntry {
  id: string;
  versionRange: string;
  module: string;
}

/**
 * ledger 持久化数据形状。
 *   - lastAppVersion：上次成功跑完 MigrationManager 的 app 版本（'0.0.0' = 首次启动）
 *   - handlers：per-handler-id 的状态条目
 */
export interface MigrationLedger {
  lastAppVersion: string;
  handlers: Record<string, HandlerState>;
}

/**
 * MigrationManager.run() 的返回值，供 BootstrapResult.migrationErrors 收集。
 *   - ran：本次实际执行的 handler id 列表
 *   - skipped：因 applied 或 range 不满足而跳过的 id 列表
 *   - errors：执行抛错的 handler 错误列表（不阻塞 bootstrap）
 */
export interface MigrationSummary {
  ran: string[];
  skipped: string[];
  errors: Array<{ id: string; message: string; stack?: string }>;
}

/**
 * handler 执行上下文（MigrationManager 注入到每个 handler）。
 *   - dataDir：DATA_DIR 绝对路径（packaged cwd=/ 下必须绝对，由 bootstrap 走 resolveDataDir 传入）
 *   - appConfig：AppConfigService —— handler 可读 app_config（dummy-update 不用，预留）
 *
 * 放此处（非 migration-manager.ts）避免 handlers/index.ts ↔ migration-manager.ts 循环引用。
 */
export interface MigrationHandlerContext {
  dataDir: string;
  appConfig: AppConfigService;
}

/**
 * 判定 handler 是否应当执行。
 *
 * 双防线：
 *   1. **applied 主防线**：ledger 中 status !== 'done' 才考虑执行（done = 已完成不再跑）
 *   2. **range 兜底**：当前 app 版本必须满足 entry.versionRange（避免无谓跑或回滚误跑）
 *
 * 两条都过才返回 true。range 解析抛错视为不满足（保守：不执行未知 range 的 handler）。
 *
 * @param entry handler 注册表条目（含 versionRange）
 * @param ledger 当前 ledger（含已 applied 的 handler 状态）
 * @param currentVersion 当前 app 版本（从 app-version.json 读）
 */
export function isHandlerAppliable(
  entry: HandlerEntry,
  ledger: MigrationLedger,
  currentVersion: string,
): boolean {
  const state = ledger.handlers[entry.id];
  if (state?.status === 'done') return false; // applied 主防线
  try {
    return satisfiesRange(currentVersion, entry.versionRange);
  } catch {
    return false; // range 解析失败 → 保守不执行
  }
}
