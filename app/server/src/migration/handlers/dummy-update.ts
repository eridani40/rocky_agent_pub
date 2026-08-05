/**
 * dummy-update handler —— 空操作 handler，验证 MigrationManager / ledger 链路。
 * 参考: specs/tech/version_logs/v0.0.150/change_plan.md §A（dummy-update）
 *
 * 约束：
 *   - 真空操作（不读不写 fs、不改 config）—— 仅验证 ledger 记录链路通
 *   - 幂等：重复调用零副作用
 *   - 不抛错（让 manager 验证 done 记录路径）
 */
import type { MigrationHandlerContext } from '../ledger';

/**
 * 空操作迁移 handler。
 * @param _ctx MigrationManager 注入的上下文（dataDir / appConfig；本 handler 不使用）
 */
export const dummyUpdate = async (_ctx: MigrationHandlerContext): Promise<void> => {
  // 真空操作——仅验证 ledger 记录链路
};
