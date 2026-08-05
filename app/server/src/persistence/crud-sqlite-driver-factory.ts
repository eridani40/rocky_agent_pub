/**
 * createCrudSqlDriver — SqliteCrudStore + SqlDriver 双产物工厂
 * 参考: specs/tech/persistence/[P0]sqlite_engine_packaged_promotion.md §2.5（注入而非 new）
 *       specs/tech/persistence/[P1]token_usage_stat.md §2.6（读写分离：store 写 + driver 读聚合）
 *
 * 职责：封装「createSqlDriver + applyWal + new SqliteCrudStore」样板，bootstrap 一行调用；
 * **双产物**（store + driver）—— store 给 CrudStore 体系写入（subscriber/stat-store putAsync），
 * driver 给 aggregator raw SQL GROUP BY 聚合查询共享（读写分离 §2.6，同一 SqlDriver 实例）。
 *
 * 路径约定（PACKAGED-GUARD-2）：调用方传 `join(resolveDataDir(), 'crud.sqlite')`（绝对路径，
 * config.ts:50 resolveDataDir 单一展开权威，禁字面 `~` / 相对路径）。
 *
 * 异常向上抛（不吞，由 bootstrap 决定是否容忍——对齐 bootstrap-search-phase 异常容忍范式）。
 */
import { createSqlDriver, type SqlDriver } from './search-sql-driver';
import { applyWal } from './sqlite-schema';
import { SqliteCrudStore } from './sqlite-store';

/**
 * 工厂：构造 SqliteCrudStore + 共享 SqlDriver。
 *
 * @param path db 文件路径；**调用方**保证绝对路径（resolveDataDir 展开）
 * @returns `{store, driver}`：
 *   - store: 用于 CrudStore 体系写入（mount entity + putAsync）
 *   - driver: 同一 SqlDriver 实例，供 aggregator raw SQL 聚合查询共享（读写分离）
 */
export async function createCrudSqlDriver(
  path: string,
): Promise<{ store: SqliteCrudStore; driver: SqlDriver }> {
  const driver = await createSqlDriver(path);
  // WAL 让读不阻塞写（spec §3.5；与 search.sqlite 同款）
  applyWal(driver);
  const store = new SqliteCrudStore(driver);
  return { store, driver };
}
