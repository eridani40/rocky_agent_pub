/**
 * SQLite 表结构管理（建表 / 索引 / PRAGMA / 表名安全）
 * 参考: specs/tech/persistence/[P0]sqlite_crud_store_engine.md §2（表结构）§3.5（WAL）
 *       specs/tech/persistence/[P0]sqlite_engine_packaged_promotion.md §2.4（SqlDriver 注入）
 *
 * 设计（spec §2）：
 *   - blob-first：每 entity 一张表，列 = id(pk) + data(JSON blob) + 信封列
 *     （created_at/updated_at/version）
 *   - entity → 表名（schema.entity），首次写入惰性建表 IF NOT EXISTS
 *   - 信封列开真实列支撑索引与排序；业务字段一律进 data blob（spec §3.2）
 *   - id 列值 = data.id（去规范化便于 SQL 直查主键，engine 保证一致）
 *
 * 入参为 `SqlDriver`（search-sql-driver 抽象），内部走 `driver.exec()`；函数体零 bun:sqlite 依赖。
 *
 * 表名安全：entity 来自 SchemaDef（注册时校验过），但仍做白名单转义防 SQL 注入，
 * 只允许 [A-Za-z0-9_]。
 */
import type { SqlDriver } from './search-sql-driver';

/** 信封列名（与 crud-types RecordMeta 对应，snake_case 适配 SQL 惯例） */
export const ENV_CREATED_AT = 'created_at';
export const ENV_UPDATED_AT = 'updated_at';
export const ENV_VERSION = 'version';

/** 合法表名（仅字母数字下划线），非法抛错防注入 */
export function safeTableName(entity: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entity)) {
    throw new Error(`非法 entity/表名: ${entity}（仅允许字母数字下划线）`);
  }
  return entity;
}

/**
 * 惰性建表（spec §2）：首次写入 entity 时调用，IF NOT EXISTS 幂等。
 * 同时建 created_at 索引（spec §2 idx_<entity>_created_at）。
 */
export function ensureTable(driver: SqlDriver, entity: string): void {
  const table = safeTableName(entity);
  // 注：表名已在白名单内，安全拼接；列名固定
  driver.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (
       id          TEXT PRIMARY KEY,
       data        TEXT NOT NULL,
       ${ENV_CREATED_AT}  TEXT NOT NULL,
       ${ENV_UPDATED_AT}  TEXT NOT NULL,
       ${ENV_VERSION}     INTEGER NOT NULL
     )`,
  );
  driver.exec(
    `CREATE INDEX IF NOT EXISTS idx_${table}_${ENV_CREATED_AT} ON ${table} (${ENV_CREATED_AT})`,
  );
}

/**
 * 打开库时设置 WAL（spec §3.5）。
 * WAL 让读不阻塞写，适合单机多读少写；与乐观锁配合避免长事务持锁。
 */
export function applyWal(driver: SqlDriver): void {
  driver.exec('PRAGMA journal_mode = WAL');
}
