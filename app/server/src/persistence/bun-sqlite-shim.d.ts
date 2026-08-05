/**
 * bun:sqlite 最小 ambient 类型声明。
 *
 * 为什么保留：search-sql-driver.ts 的 BunSqlDriver.create 内 `await import('bun:sqlite')`
 * 在 dev typecheck（server tsconfig types=node）下需 ambient module 声明才能解析；
 * `declare module` 在已 module 的 .ts 文件会被 TS 视作 augmentation 报错（module 找不到），
 * 故必须放 .d.ts（ambient）。
 *
 * 仅声明 driver 用到的方法（prepare/exec/close + Statement.get/all/run），不再含 transaction
 * （CrudStore 事务走手动 BEGIN/COMMIT/ROLLBACK via driver.exec，见 sqlite-store.ts）。
 *
 * PACKAGED-GUARD：仅 dev typecheck 需要，packaged Electron Node 不消费 bun:sqlite
 * （search-sql-driver 的 BunSqlDriver 仅 dev/Bun runtime 实例化）。
 */
declare module 'bun:sqlite' {
  /** 预编译语句（仅声明 driver 用到的方法） */
  export interface Statement {
    /** 绑定参数并取首行（无结果返 null） */
    get(...params: unknown[]): unknown;
    /** 绑定参数并取所有行 */
    all(...params: unknown[]): unknown[];
    /** 绑定参数并执行，返回受影响行数 */
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }

  /** Database 实例（仅声明 driver 用到的方法；transaction 由 CrudStore 走手动 BEGIN/COMMIT/ROLLBACK） */
  export interface DatabaseInstance {
    /** 预编译 SQL 并返回 Statement */
    prepare(sql: string): Statement;
    /** 直接执行单条 SQL（无返回行），用于 PRAGMA / DDL / BEGIN / COMMIT / ROLLBACK */
    exec(sql: string): void;
    /** 关闭数据库连接 */
    close(): void;
  }

  /**
   * Database 构造器：`new Database(path)` 返回 DatabaseInstance。
   * path=':memory:' 为内存库。
   */
  export const Database: new (path: string) => DatabaseInstance;
}
