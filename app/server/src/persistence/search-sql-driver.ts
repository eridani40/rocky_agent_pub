/**
 * SqlDriver 抽象 + 3 实现 + 工厂 — search.sqlite 引擎无关 SQLite 访问层
 * 参考: specs/tech/persistence/[P1]search_engine.md §3.1（SqlDriver 抽象设计）
 *       specs/tech/persistence/[P0]sqlite_engine_packaged_promotion.md（CrudStore 复用）
 *
 * 设计要点：
 *   - 引擎无关最小契约：SqlDriver（prepare/exec/close）+ SqlStatement（get/all/run）
 *   - 三实现按 runtime 二选一：dev=BunSqlDriver(bun:sqlite) / packaged=NodeSqlDriver(node:sqlite)
 *     或 BetterSqlite3Driver fallback（node:sqlite 缺 FTS5 时启用）
 *   - 三实现统一动态 import（顶层零 sqlite import，PACKAGED-GUARD：Node 无 bun:sqlite）
 *
 * 路径约定（PACKAGED-GUARD-2）：调用方传 `join(resolveDataDir(), 'search.sqlite')`，
 * 禁字面 `~` / 相对路径（packaged cwd=/ 下崩 EACCES）。本文件只接收 path 不展开。
 */

// ============================================================
// 引擎无关契约（SqlDriver / SqlStatement）
// ============================================================

/**
 * 预编译语句契约（对齐 bun:sqlite / node:sqlite / better-sqlite3 共同 API 子集）。
 * 泛型入口两处择一：`prepare<Row>(sql)` 声明行形状；或 `prepare(sql).all<Row>(...)`（原 bun 风格）。
 * `get` 用于按主键读单行（sqlite-rows readMeta/selectRow）。
 */
export interface SqlStatement<T = unknown> {
  /** 取所有匹配行（形状由 SqlStatement<T> 或 all<U> 的泛型决定） */
  all<U = T>(...params: unknown[]): U[];
  /** 执行写操作，返回 changes + lastInsertRowid */
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  /** 取首条匹配行（单行查询，如按主键读）；无结果返 undefined（三实现原生 .get() 支持） */
  get<U = T>(...params: unknown[]): U | undefined;
}

/**
 * 引擎无关最小 SQLite 访问契约（spec §3.1）。
 * prepare 返回的 SqlStatement 可重复执行；exec 用于 DDL/PRAGMA/事务（含 BEGIN/COMMIT/ROLLBACK）。
 */
export interface SqlDriver {
  /** 预编译 SQL 返回 SqlStatement（多次调同名 SQL 由实现决定是否缓存） */
  prepare<T = unknown>(sql: string): SqlStatement<T>;
  /** 直接执行 SQL（建表/PRAGMA/事务），无返回行 */
  exec(sql: string): void;
  /** 关闭数据库连接（测试 cleanup / 关闭前 flush 用） */
  close(): void;
}

// ============================================================
// BunSqlDriver — dev runtime 包装 bun:sqlite
// ============================================================

/**
 * bun:sqlite 最小本地 interface（仅 driver 用到的 prepare/exec/close + get/all/run）。
 * PACKAGED-GUARD：顶层 `import 'bun:sqlite'` 在 packaged Node 下崩；走动态 import + 本地 interface。
 * ambient module 声明在 bun-sqlite-shim.d.ts（dev typecheck 解析 import('bun:sqlite') 需要）。
 */
interface BunSqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
}
interface BunSqliteDatabase {
  prepare(sql: string): BunSqliteStatement;
  exec(sql: string): void;
  close(): void;
}

/**
 * dev 实现：包装 `bun:sqlite` 的 Database。
 * 仅 dev/Bun runtime 用；packaged 走 NodeSqlDriver/BetterSqlite3Driver。
 *
 * 动态 import 模式（对齐 NodeSqlDriver/BetterSqlite3Driver）：
 *   - 顶层 import bun:sqlite 会在 packaged 编译成 require 崩（PACKAGED-GUARD）
 *   - `static async create` 内部 `await import('bun:sqlite')`，仅 dev 执行
 *   - constructor private，强制走 create 工厂（保证不在构造期顶层 import）
 */
export class BunSqlDriver implements SqlDriver {
  /**
   * 异步工厂：动态 import bun:sqlite（仅 dev/Bun runtime 可用，packaged 不走此分支）。
   * @param path db 文件路径（或 ':memory:'）
   * @returns 包装好 bun:sqlite Database 的 BunSqlDriver 实例
   */
  static async create(path: string): Promise<BunSqlDriver> {
    // 动态 import：bun:sqlite 仅 dev/Bun runtime 可用，types=node tsconfig 下由 ambient
    // bun-sqlite-shim.d.ts 提供 module 声明（packaged 不走此分支）。
    // @vite-ignore 防 vitest 解析（dev-only 模块，vitest 不应 transform）
    const mod = await import(/* @vite-ignore */ 'bun:sqlite') as {
      Database: new (path: string) => BunSqliteDatabase;
    };
    return new BunSqlDriver(mod.Database, path);
  }

  private constructor(
    Ctor: new (path: string) => BunSqliteDatabase,
    path: string,
  ) {
    this.db = new Ctor(path);
  }

  private readonly db: BunSqliteDatabase;

  prepare<T = unknown>(sql: string): SqlStatement<T> {
    const stmt = this.db.prepare(sql);
    return {
      all: <U = T>(...params: unknown[]): U[] => stmt.all(...params) as U[],
      run: (...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } =>
        stmt.run(...params),
      get: <U = T>(...params: unknown[]): U | undefined =>
        (stmt.get(...params) as U | null) ?? undefined,
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

// ============================================================
// NodeSqlDriver — packaged 首选，包装 node:sqlite DatabaseSync（Node 22+ 内置）
// ============================================================

/**
 * node:sqlite DatabaseSync 最小类型声明（本地 declare，避免顶层 import 未装包）。
 * 仅 packaged runtime 用，dev 不实例化（NodeSqlDriver 实例化走动态 import）。
 */
interface NodeSqliteStatementSync {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
}
interface NodeSqliteDatabaseSync {
  prepare(sql: string): NodeSqliteStatementSync;
  exec(sql: string): void;
  close(): void;
}

/**
 * packaged 首选实现：包装 `node:sqlite` 的 DatabaseSync（Node 22+ 内置）。
 * MUST 仅当 packaged spike 验证 node:sqlite 含 FTS5 才启用（spec §3.1 + §6 [PACKAGED-SPIKE]）。
 * 动态 import 避免 dev typecheck 找不到 node:sqlite 模块。
 */
export class NodeSqlDriver implements SqlDriver {
  static async create(path: string): Promise<NodeSqlDriver> {
    // 动态 import：dev 不激活（packaged 才走此分支）；@ts-ignore 因 node:sqlite 在 dev tsdk 无类型
    const mod = await import(/* @vite-ignore */ 'node:sqlite') as {
      DatabaseSync: new (path: string) => NodeSqliteDatabaseSync;
    };
    return new NodeSqlDriver(mod.DatabaseSync, path);
  }

  private constructor(
    private readonly Ctor: new (path: string) => NodeSqliteDatabaseSync,
    path: string,
  ) {
    this.db = new Ctor(path);
  }

  private readonly db: NodeSqliteDatabaseSync;

  prepare<T = unknown>(sql: string): SqlStatement<T> {
    const stmt = this.db.prepare(sql);
    return {
      all: <U = T>(...params: unknown[]): U[] => stmt.all(...params) as U[],
      run: (...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } =>
        stmt.run(...params),
      get: <U = T>(...params: unknown[]): U | undefined =>
        (stmt.get(...params) as U | null) ?? undefined,
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

// ============================================================
// BetterSqlite3Driver — packaged fallback，包装 better-sqlite3（native prebuilt）
// ============================================================

/**
 * better-sqlite3 Database/Statement 最小类型声明（本地 declare）。
 * 仅当 node:sqlite 缺 FTS5 时启用（PACKAGED-SPIKE 输出 go/no-go）。
 */
interface BetterSqlite3Statement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
}
interface BetterSqlite3Database {
  prepare(sql: string): BetterSqlite3Statement;
  exec(sql: string): void;
  close(): void;
}

/**
 * packaged fallback 实现：包装 `better-sqlite3`（native prebuilt）。
 * MUST 声明进 app/server/package.json deps + asarUnpack + Electron ABI rebuild
 * （PACKAGED-GUARD-1，CLAUDE.md 持续可打包护栏）。
 * 动态 import 避免 dev typecheck 找到未装的 better-sqlite3。
 */
export class BetterSqlite3Driver implements SqlDriver {
  static async create(path: string): Promise<BetterSqlite3Driver> {
    // @ts-expect-error better-sqlite3 在 dev 不装包（packaged fallback only，PACKAGED-SPIKE 验证）；
    // 运行时 `await import` 失败会 reject（dev 不实例化 BetterSqlite3Driver）
    const mod = await import(/* @vite-ignore */ 'better-sqlite3') as {
      default: new (path: string) => BetterSqlite3Database;
    };
    return new BetterSqlite3Driver(mod.default, path);
  }

  private constructor(
    Ctor: new (path: string) => BetterSqlite3Database,
    path: string,
  ) {
    this.db = new Ctor(path);
  }

  private readonly db: BetterSqlite3Database;

  prepare<T = unknown>(sql: string): SqlStatement<T> {
    const stmt = this.db.prepare(sql);
    return {
      all: <U = T>(...params: unknown[]): U[] => stmt.all(...params) as U[],
      run: (...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } =>
        stmt.run(...params),
      get: <U = T>(...params: unknown[]): U | undefined =>
        (stmt.get(...params) as U | null | undefined) ?? undefined,
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

// ============================================================
// 工厂 createSqlDriver — 按 runtime 选实现
// ============================================================

/**
 * packaged spike 选择 flag：一期 dev 不激活；packaged 验证阶段由 bootstrap
 * 显式置 'node' 或 'better-sqlite3'（spike 结果决定）。
 * 默认 'node'（node:sqlite 首选，spec §3.1 + §6）。
 */
export type PackagedSqlDriverKind = 'node' | 'better-sqlite3';

let packagedKind: PackagedSqlDriverKind = 'node';

/**
 * 覆盖 packaged 选型（仅在 packaged runtime + spike 结论出来后调）。
 * dev 调无效（dev 永远走 BunSqlDriver）。
 */
export function setPackagedSqlDriverKind(kind: PackagedSqlDriverKind): void {
  packagedKind = kind;
}

/**
 * 按 runtime 选实现：
 *   - `process.versions.bun` 存在（dev/Bun runtime）→ BunSqlDriver
 *   - 否则（packaged Electron/Node）→ 按 packagedKind 选 Node/BetterSqlite3
 *
 * @param path db 文件路径；**调用方**须走 `join(resolveDataDir(), 'search.sqlite')`
 *             （config.ts:50 resolveDataDir 单一展开权威，PACKAGED-GUARD-2）
 * @returns SqlDriver 实例（dev 同步返 BunSqlDriver；packaged 异步返 Node/Better）
 */
export async function createSqlDriver(path: string): Promise<SqlDriver> {
  // dev / Bun runtime：走 BunSqlDriver.create（动态 import bun:sqlite，仅 dev 执行）
  if (typeof process !== 'undefined' && (process as { versions?: { bun?: string } }).versions?.bun) {
    return BunSqlDriver.create(path);
  }
  // packaged：按 spike flag 选 Node / BetterSqlite3
  if (packagedKind === 'better-sqlite3') {
    return BetterSqlite3Driver.create(path);
  }
  return NodeSqlDriver.create(path);
}
