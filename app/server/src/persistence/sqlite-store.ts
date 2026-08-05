/**
 * SqliteCrudStore — CrudStore 契约在 SQLite 上的实现（blob-first）
 * 参考: specs/tech/persistence/[P0]sqlite_crud_store_engine.md §2-§5
 *       specs/tech/persistence/[P0]sqlite_engine_packaged_promotion.md（扶正：SqlDriver 注入 + 手动事务）
 *
 * 设计要点：
 *   - 底座 SqlDriver 抽象（search-sql-driver.ts 三实现 + 动态 import，dev=BunSqlDriver /
 *     packaged=Node/BetterSqlite3）；PACKAGED-GUARD 顶层零 bun:sqlite import（packaged 不崩）
 *   - WAL 由工厂 createCrudSqlDriver(path) 在构造前经 applyWal(driver) 打开，本类不再管
 *   - blob-first：每 entity 一张表，列 = id(pk) + data(JSON blob 不含信封) + 信封列
 *   - put 主线：校验(T1 validateRecord) → 算信封(T2 computeEnvelope 复用)
 *     → 按 mode/ifVersion 发 SQL（行级执行见 sqlite-rows.ts）→ 返回 data+信封合并
 *   - id 全局索引：get(id) 无需 shardKey（SQLite 不分片，id 是 pk，O(1)）
 *   - 事务（engine 专有）：手动 BEGIN/COMMIT/ROLLBACK via driver.exec（跨 driver 共识，
 *     禁 bun 式 db.transaction() 高阶函数 — node:sqlite 无此 API）
 *   - json_extract 扩展查询（engine 专有，不跨 engine 可移植，spec §4）
 *
 * 行级 SQL 执行（INSERT/UPDATE/信封读取/行合并）在 sqlite-rows.ts，本类只做编排。
 */
import type { SqlDriver, SqlStatement } from './search-sql-driver';
import type { InferRecord, SchemaDef } from './schema-types';
import type {
  CrudStore,
  PutOptions,
  QueryFilter,
  StoredRecord,
} from './crud-types';
import { validateRecord } from './schema-validation';
import { computeEnvelope } from './envelope';
import { ensureTable, safeTableName } from './sqlite-schema';
import { buildJsonExtractWhere, buildQuery } from './sqlite-query';
import {
  execUpsert,
  mergeRow,
  QUERY_SELECT_COLS,
  readMeta,
  readRawRowSafe,
  selectRow,
  type PrepareFn,
} from './sqlite-rows';
import { queryWithSlowLog } from './slow-query';

// ============================================================
// 注：applyWal 由工厂 createCrudSqlDriver(path) 在构造前调用（见 crud-sqlite-driver-factory.ts）
// ============================================================

/**
 * SQLite engine 实现 CrudStore 契约。
 *
 * 构造接收 SqlDriver 实例（注入），不再内部 new Database；WAL 由调用方（工厂）在构造前开。
 *
 * 同时提供 engine 专有能力：
 *   - transaction(fn)：跨记录 ACID 事务（手动 BEGIN/COMMIT/ROLLBACK，FS engine 不提供）
 *   - queryByJsonExtract(schema, field, value, filter?)：业务字段过滤（spec §4 末段）
 *   - readRawRow(entity, id)：测试用白盒断言原始行（data blob 不含信封）
 */
export class SqliteCrudStore implements CrudStore {
  private readonly driver: SqlDriver;
  /** 预编译语句缓存：key = SQL 文本，复用避免重复 prepare（spec §3.5） */
  private readonly stmtCache = new Map<string, SqlStatement>();
  /** 已建表的 entity 集合，惰性建表去重 */
  private readonly ensuredEntities = new Set<string>();
  /** 毫秒时钟（query 慢查询计时，UT 可注入；缺省 Date.now） */
  private readonly nowMs: () => number;

  /**
   * @param driver 已开 WAL 的 SqlDriver 实例（由 createCrudSqlDriver 工厂注入）
   * @param opts   可选项：nowMs = query 慢查询计时时钟（engine 专有扩展，UT 控制用）
   */
  constructor(driver: SqlDriver, opts?: { nowMs?: () => number }) {
    this.driver = driver;
    this.nowMs = opts?.nowMs ?? Date.now;
  }

  /** 关闭数据库连接（转发给 driver；测试 cleanup 用） */
  close(): void {
    this.driver.close();
  }

  /** 暴露 driver（aggregator 等共享同一 SqlDriver 实例做 raw SQL 聚合查询，读写分离 §2.6） */
  getDriver(): SqlDriver {
    return this.driver;
  }

  /** prepare 函数（带 stmtCache），传给 sqlite-rows 模块函数复用 */
  private readonly prepareFn: PrepareFn = (sql: string): SqlStatement => {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.driver.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  };

  /** 惰性建表（首次访问 entity 时） */
  private ensureEntity(entity: string): void {
    if (this.ensuredEntities.has(entity)) return;
    ensureTable(this.driver, entity);
    this.ensuredEntities.add(entity);
  }

  // ============================================================
  // CrudStore 契约实现
  // ============================================================

  put<S extends SchemaDef>(
    schema: S,
    record: InferRecord<S>,
    opts?: PutOptions,
  ): StoredRecord<S> {
    // 1) 校验（T1）：必填/类型/enum/ULID/信封保留字段
    validateRecord(schema, record as Record<string, unknown>);

    const entity = schema.entity;
    this.ensureEntity(entity);
    const table = safeTableName(entity);
    // validateRecord 已保证 record.id 是合法 ULID；泛型 InferRecord<S> 不暴露 id
    const id = (record as Record<string, unknown>).id as string;
    const now = new Date().toISOString();

    // 2) 读 existing 信封（为 computeEnvelope 提供 version 基线）
    const existing = readMeta(this.prepareFn, table, id);

    // 3) 算信封（T2 复用纯逻辑：mode/ifVersion 冲突在此抛错）
    const meta = computeEnvelope({ existing, opts, now, id });

    // 4) data blob：实体字段 JSON（不含信封，validateRecord 已保证 record 无信封字段）
    const dataJson = JSON.stringify(record);

    // 5) 按 mode 发 SQL（spec §4 操作映射）；
    //    mode=insert 已存在 / mode=replace 不存在 已被 computeEnvelope 抛错拦截，
    //    此处只需 upsert 式执行（首次 INSERT / 已存在 UPDATE 含 ifVersion 兜底）
    execUpsert(this.prepareFn, table, id, dataJson, meta, existing, opts);

    // 6) 返回 data + 信封合并
    return { ...(record as object), ...meta } as StoredRecord<S>;
  }

  get<S extends SchemaDef>(
    schema: S,
    id: string,
    _shardKey?: string,
  ): StoredRecord<S> | undefined {
    // id 是 pk，全局索引 O(1)，无需 shardKey（_shardKey 忽略：SQLite 不分片）
    const entity = schema.entity;
    if (!this.ensuredEntities.has(entity)) return undefined;
    const table = safeTableName(entity);
    const row = selectRow(this.prepareFn, table, id);
    return row ? mergeRow<S>(row) : undefined;
  }

  delete<S extends SchemaDef>(schema: S, id: string, _shardKey?: string): boolean {
    const entity = schema.entity;
    if (!this.ensuredEntities.has(entity)) return false;
    const table = safeTableName(entity);
    // 先查存在性再删（返回值语义清晰：实际删除了一行才 true）
    if (!selectRow(this.prepareFn, table, id)) return false;
    this.prepareFn(`DELETE FROM ${table} WHERE id = ?`).run(id);
    return true;
  }

  query<S extends SchemaDef>(schema: S, filter: QueryFilter): StoredRecord<S>[] {
    // 慢查询性能日志埋点：计时包原查询，超阈值经模块级 sink 上报
    // （sink 未注册/开关 false 均零副作用，见 slow-query.ts）
    return queryWithSlowLog('sqlite', schema, filter, () => {
      const entity = schema.entity;
      if (!this.ensuredEntities.has(entity)) return [];
      const table = safeTableName(entity);
      const built = buildQuery(filter);
      // 注：shardKey 被 buildQuery 忽略（SQLite 不分片，spec §4）
      const sql = `SELECT ${QUERY_SELECT_COLS} FROM ${table} ${built.whereSql} ${built.tailSql}`;
      const rows = this.prepareFn(sql).all<ReturnType<typeof selectRow>>(...built.params);
      return rows.map((r) => mergeRow<S>(r!));
    }, this.nowMs);
  }

  // ============================================================
  // engine 专有：事务（spec §5）
  // ============================================================

  /**
   * 多操作打包成 ACID 事务（engine 专有，FS engine 不提供）。
   * fn 内任一异常自动回滚；正常返回则提交。
   *
   * 实现：手动 BEGIN/COMMIT/ROLLBACK via driver.exec —— 跨 driver 共识
   * （node:sqlite 无 db.transaction() 高阶函数；bun:sqlite 与 better-sqlite3 有但语义不一）。
   * CrudStore 事务只有 1 层（无嵌套 caller），手动实现等价无嵌套语义损失。
   *
   * @param fn 接收 tx（指向本 store，事务内操作作用于同一连接）
   */
  transaction<T>(fn: (tx: CrudStore) => T): T {
    this.driver.exec('BEGIN');
    try {
      const result = fn(this);
      this.driver.exec('COMMIT');
      return result;
    } catch (e) {
      // 异常路径 ROLLBACK（best-effort：ROLLBACK 本身抛错时原异常仍向上抛）
      try {
        this.driver.exec('ROLLBACK');
      } catch {
        // ignore: 事务可能已被 fn 内部隐式回滚（如连接断）
      }
      throw e;
    }
  }

  // ============================================================
  // engine 专有：json_extract 扩展查询（spec §4 末段，不跨 engine 可移植）
  // ============================================================

  /**
   * 按 data blob 内业务字段过滤（engine 专有扩展）。
   * ⚠️ 不在 CrudStore 契约保证范围，FS engine 无此能力，调用方自负可移植性。
   */
  queryByJsonExtract<S extends SchemaDef>(
    schema: S,
    field: string,
    value: unknown,
    filter?: QueryFilter,
  ): StoredRecord<S>[] {
    const entity = schema.entity;
    if (!this.ensuredEntities.has(entity)) return [];
    const table = safeTableName(entity);
    const built = buildJsonExtractWhere(field, value, filter);
    const sql = `SELECT ${QUERY_SELECT_COLS} FROM ${table} ${built.whereSql} ${built.tailSql}`;
    const rows = this.prepareFn(sql).all<ReturnType<typeof selectRow>>(...built.params);
    return rows.map((r) => mergeRow<S>(r!));
  }

  // ============================================================
  // 测试辅助：读原始行（白盒断言 data blob 不含信封）
  // ============================================================

  /** 读原始行（含 id/data/信封列），测试用；表不存在返回 undefined */
  readRawRow(entity: string, id: string): ReturnType<typeof readRawRowSafe> {
    return readRawRowSafe(this.driver, safeTableName(entity), id);
  }
}
