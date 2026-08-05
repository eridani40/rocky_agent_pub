/**
 * SQLite 行级操作（INSERT / UPDATE / 信封读取 / 行合并）
 * 参考: specs/tech/persistence/[P0]sqlite_crud_store_engine.md §4（操作映射）
 *       specs/tech/persistence/[P0]sqlite_engine_packaged_promotion.md §2.2（SqlStatement.get 扩展）
 *
 * 把 SqliteCrudStore 的底层 SQL 执行抽成模块级函数，主类只做编排。
 * 所有函数接收 SqlDriver / PrepareFn（SqlStatement 产出）+ 参数，无状态，便于复用与测试。
 *
 * `PrepareFn` 返回类型是 `SqlStatement`（search-sql-driver 契约）；`readRawRowSafe` 入参为 `SqlDriver`。
 *
 * SQL 拼接：表名由调用方先经 safeTableName 校验（已白名单），列名固定信封列。
 * 值全部走 `?` 占位符参数化，防注入。
 */
import type { SqlStatement, SqlDriver } from './search-sql-driver';
import type { SchemaDef } from './schema-types';
import type { PutOptions, RecordMeta, StoredRecord } from './crud-types';
import { VersionConflictError } from './errors';
import { ENV_CREATED_AT, ENV_UPDATED_AT, ENV_VERSION } from './sqlite-schema';

/** 行记录（信封列 + data blob），从 SQLite 读出的原始形态 */
export interface RawRow {
  id: string;
  data: string;
  [ENV_CREATED_AT]: string;
  [ENV_UPDATED_AT]: string;
  [ENV_VERSION]: number;
}

/** prepare 函数类型：由主类提供（带 stmtCache），行操作通过它复用预编译语句 */
export type PrepareFn = (sql: string) => SqlStatement;

/**
 * 读 existing 信封（不解析 data，仅 version 基线，供 computeEnvelope 用）。
 * 不存在返回 undefined。
 */
export function readMeta(
  prepare: PrepareFn,
  table: string,
  id: string,
): RecordMeta | undefined {
  const row = prepare(
    `SELECT ${ENV_CREATED_AT}, ${ENV_UPDATED_AT}, ${ENV_VERSION} FROM ${table} WHERE id = ?`,
  ).get<{
    [ENV_CREATED_AT]: string;
    [ENV_UPDATED_AT]: string;
    [ENV_VERSION]: number;
  }>(id);
  if (!row) return undefined;
  return {
    createdAt: row[ENV_CREATED_AT],
    updatedAt: row[ENV_UPDATED_AT],
    version: row[ENV_VERSION],
  };
}

/** 把 RawRow 的 data(JSON) 解析后与信封列合并成 StoredRecord */
export function mergeRow<S extends SchemaDef>(row: RawRow): StoredRecord<S> {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  const merged = {
    ...data,
    createdAt: row[ENV_CREATED_AT],
    updatedAt: row[ENV_UPDATED_AT],
    version: row[ENV_VERSION],
  };
  return merged as unknown as StoredRecord<S>;
}

/** SELECT 列片段（data + 信封列），多处复用 */
const SELECT_COLS = `data, ${ENV_CREATED_AT}, ${ENV_UPDATED_AT}, ${ENV_VERSION}`;

/** 按 id 读原始行（含 data blob），存在返回 RawRow */
export function selectRow(
  prepare: PrepareFn,
  table: string,
  id: string,
): RawRow | undefined {
  const row = prepare(
    `SELECT ${SELECT_COLS} FROM ${table} WHERE id = ?`,
  ).get<RawRow>(id);
  return row ?? undefined;
}

/** INSERT 新记录 */
export function execInsert(
  prepare: PrepareFn,
  table: string,
  id: string,
  dataJson: string,
  meta: RecordMeta,
): void {
  prepare(
    `INSERT INTO ${table} (id, data, ${ENV_CREATED_AT}, ${ENV_UPDATED_AT}, ${ENV_VERSION}) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, dataJson, meta.createdAt, meta.updatedAt, meta.version);
}

/**
 * UPDATE 已存在记录（mode=replace 或 upsert 的 update 分支）。
 * ifVersion：在 WHERE 加 version = ?，affected=0 → VersionConflictError 并发兜底。
 * （computeEnvelope 已对齐 expected/actual，此处兜底事务窗口内的竞态。）
 */
export function execUpdate(
  prepare: PrepareFn,
  table: string,
  id: string,
  dataJson: string,
  meta: RecordMeta,
  opts?: PutOptions,
): void {
  if (opts?.ifVersion !== undefined) {
    const result = prepare(
      `UPDATE ${table} SET data = ?, ${ENV_UPDATED_AT} = ?, ${ENV_VERSION} = ? WHERE id = ? AND ${ENV_VERSION} = ?`,
    ).run(dataJson, meta.updatedAt, meta.version, id, opts.ifVersion) as { changes: number };
    if (result.changes === 0) {
      const actual = readMeta(prepare, table, id)?.version ?? 0;
      throw new VersionConflictError({ expected: opts.ifVersion, actual, id });
    }
  } else {
    prepare(
      `UPDATE ${table} SET data = ?, ${ENV_UPDATED_AT} = ?, ${ENV_VERSION} = ? WHERE id = ?`,
    ).run(dataJson, meta.updatedAt, meta.version, id);
  }
}

/**
 * upsert：首次 INSERT，已存在 UPDATE（含 ifVersion 兜底）（spec §4）。
 * @param existing 已读到的信封；undefined=首次写
 */
export function execUpsert(
  prepare: PrepareFn,
  table: string,
  id: string,
  dataJson: string,
  meta: RecordMeta,
  existing: RecordMeta | undefined,
  opts?: PutOptions,
): void {
  if (existing === undefined) {
    execInsert(prepare, table, id, dataJson, meta);
    return;
  }
  execUpdate(prepare, table, id, dataJson, meta, opts);
}

/**
 * 白盒读取原始行（测试辅助）。
 * 表不存在（如事务回滚后 DDL 撤销）返回 undefined，便于断言「回滚后无落盘」。
 * 不走 stmtCache：事务回滚后缓存的 stmt 会失效，白盒查询每次新 prepare。
 */
export function readRawRowSafe(
  driver: SqlDriver,
  table: string,
  id: string,
): RawRow | undefined {
  let row: RawRow | undefined;
  try {
    row = driver.prepare(
      `SELECT id, ${SELECT_COLS} FROM ${table} WHERE id = ?`,
    ).get<RawRow>(id);
  } catch {
    return undefined; // 表不存在 → 视为无行
  }
  return row ?? undefined;
}

/** 供 query 用：SELECT 列片段常量复用 */
export { SELECT_COLS as QUERY_SELECT_COLS };
