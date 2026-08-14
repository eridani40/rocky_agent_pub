/**
 * instance-ledger —— BrowserInstanceLedger：浏览器实例资源生命周期 sqlite 台账
 * 参考: specs/tech/version_logs/v0.0.334/change_plan.md B1（sqlite 台账替代 browser-instances.json）
 *       specs/tech/agent/tools/[P1]browser_instance_manager.md §4.7（记录文件→台账）
 *
 * 职责：launch insert（INSERT OR REPLACE 幂等）/ close delete（硬删，非 soft）/
 * listAll（启动自检数据源）/ clearAll（启动一次性清空）。全部同步 API
 * （SqlDriver prepare/exec 同步）；失败 catch 记 warn（best-effort 不抛，
 * 对齐旧 instance-record 语义，不阻塞 launch/close 主流程）。
 *
 * 表 schema（change_plan 方案总览 B）：
 *   key TEXT PRIMARY KEY（${sessionId}:${mode}）/ mode / profile_name /
 *   user_data_dir / cdp_port / worker_pid NOT NULL / chrome_pid / created_at NOT NULL。
 *
 * 生命周期：launch ready → insert；close/releaseSession/releaseAll/cleanupOrphan → delete；
 * 启动自检 = listAll 逐条 cleanup → clearAll（启动时无合法实例，全部记录=残留）。
 * attach 的 MCP 子进程 pid 也入台账（mode=attach, worker_pid=mcpPid）。
 */
import type { SqlDriver } from '../../persistence/search-sql-driver';
import type { BrowserMode, PersistedInstanceRecord } from './types';
import { errMsg } from './instance-record';

/** browser_instances 建表 DDL（IF NOT EXISTS 幂等；构造期执行） */
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS browser_instances (
    key TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    profile_name TEXT,
    user_data_dir TEXT,
    cdp_port INTEGER,
    worker_pid INTEGER NOT NULL,
    chrome_pid INTEGER,
    created_at INTEGER NOT NULL
  );
`;

/** 台账行形态（snake_case，对应表列） */
interface LedgerRow {
  key: string;
  mode: string;
  profile_name: string | null;
  user_data_dir: string | null;
  cdp_port: number | null;
  worker_pid: number;
  chrome_pid: number | null;
  created_at: number;
}

/** 台账记录（camelCase，对齐 PersistedInstanceRecord；attach 允许 userDataDir/cdpPort 空） */

/**
 * BrowserInstanceLedger —— sqlite 台账（构造建表；方法全同步 + best-effort）。
 * 单实例由 bootstrap 装配（createSqlDriver(join(resolveDataDir(),'browser.sqlite'))）。
 */
export class BrowserInstanceLedger {
  private readonly driver: SqlDriver;

  constructor(driver: SqlDriver) {
    this.driver = driver;
    try {
      this.driver.exec(CREATE_TABLE_SQL);
    } catch (e) {
      // 建表失败（磁盘/权限）→ 台账不可用；后续方法各自 catch warn，不抛构造
      console.warn(`[browser-instance-ledger] 建表失败（best-effort，台账不可用）: ${errMsg(e)}`);
    }
  }

  /**
   * 插入/覆盖一条记录（INSERT OR REPLACE，同 key 幂等）。
   * attach 记录仅 key/mode/workerPid(mcpPid)/createdAt，userDataDir/cdpPort 空。
   */
  insert(rec: PersistedInstanceRecord): void {
    try {
      this.driver
        .prepare(
          `INSERT OR REPLACE INTO browser_instances
             (key, mode, profile_name, user_data_dir, cdp_port, worker_pid, chrome_pid, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          rec.key,
          rec.mode,
          rec.profileName ?? null,
          rec.userDataDir ?? null,
          rec.cdpPort ?? null,
          rec.workerPid,
          rec.chromePid ?? null,
          rec.createdAt,
        );
    } catch (e) {
      console.warn(`[browser-instance-ledger] insert 失败（best-effort）: ${rec.key}: ${errMsg(e)}`);
    }
  }

  /** 硬删（DELETE 非 soft）。key 不存在 → no-op（幂等） */
  delete(key: string): void {
    try {
      this.driver.prepare('DELETE FROM browser_instances WHERE key = ?').run(key);
    } catch (e) {
      console.warn(`[browser-instance-ledger] delete 失败（best-effort）: ${key}: ${errMsg(e)}`);
    }
  }

  /** 读全部记录（启动自检数据源）。查询失败 → []（不阻塞启动） */
  listAll(): PersistedInstanceRecord[] {
    try {
      const rows = this.driver.prepare<LedgerRow>('SELECT * FROM browser_instances').all();
      return rows.map((r) => ({
        key: r.key,
        mode: r.mode as BrowserMode,
        ...(r.profile_name ? { profileName: r.profile_name } : {}),
        ...(r.user_data_dir ? { userDataDir: r.user_data_dir } : {}),
        ...(r.cdp_port != null ? { cdpPort: r.cdp_port } : {}),
        workerPid: r.worker_pid,
        ...(r.chrome_pid != null ? { chromePid: r.chrome_pid } : {}),
        createdAt: r.created_at,
      }));
    } catch (e) {
      console.warn(`[browser-instance-ledger] listAll 失败（best-effort）: ${errMsg(e)}`);
      return [];
    }
  }

  /** 清空全部（启动自检收尾：处理完残留后全清，幂等） */
  clearAll(): void {
    try {
      this.driver.exec('DELETE FROM browser_instances');
    } catch (e) {
      console.warn(`[browser-instance-ledger] clearAll 失败（best-effort）: ${errMsg(e)}`);
    }
  }
}
