/**
 * migration 子系统 barrel re-export。
 * 参考: specs/tech/version_logs/v0.0.150/change_plan.md §A
 */
export { MigrationManager } from './migration-manager';
export { getAppVersion } from './app-version';
export { satisfiesRange } from './version-range';
export {
  isHandlerAppliable,
  type MigrationLedger,
  type HandlerState,
  type HandlerEntry,
  type MigrationSummary,
  type MigrationHandlerContext,
} from './ledger';
