/**
 * MigrationManager —— 启动期数据迁移主控。
 * 参考: specs/tech/version_logs/v0.0.150/change_plan.md §A / §核心设计要点
 *
 * 流程（§A）：
 *   acquireLock → loadRegistry(yaml) → readLedger →
 *     对每 handler 判 done(已 applied) / range(兜底) / 执行 →
 *     记 done/error/na → 更新 lastAppVersion=当前 →
 *     原子 writeLedger → releaseLock(finally)。
 *
 * 硬约束：
 *   - handler MUST 幂等（applied 主防线 + 自身幂等兜底）
 *   - MUST NOT 清用户配置（仅格式升级）
 *   - forward-only 不回滚
 *   - 任一 handler throw → catch 进 summary.errors，不阻塞 bootstrap
 *   - lock 持有期 < 整个 bootstrap（finally 释放）
 *
 * 文件锁：mkdir + pid 自实现（**不引新依赖**）；stale 检测 = pid 不存活则清。
 * 所有 DATA_DIR 路径走调用方传入的 dataDir（已由 bootstrap 走 resolveDataDir 解析）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AppConfigService } from '../config/app-config-service';
import { getAppVersion } from './app-version';
import { satisfiesRange } from './version-range';
import {
  type HandlerEntry,
  type HandlerState,
  type MigrationLedger,
  type MigrationSummary,
  type MigrationHandlerContext,
  LEDGER_FILENAME,
} from './ledger';
import { resolveHandler } from './handlers';

/** 文件锁冲突错误（pid 仍存活）—— 由 run() catch 转 summary.error */
export class MigrationLockHeldError extends Error {
  constructor(public readonly lockPath: string, message: string) {
    super(message);
    this.name = 'MigrationLockHeldError';
  }
}

/** MigrationManager 构造参数 */
export interface MigrationManagerOptions {
  /** DATA_DIR 绝对路径（packaged cwd=/ 下必须绝对，由 bootstrap 走 resolveDataDir 传入） */
  dataDir: string;
  /** AppConfigService —— handler 注入用（dummy-update 不用，预留） */
  appConfig: AppConfigService;
}

const LOCK_DIRNAME = 'migration.lock';
const PID_FILENAME = 'pid';
const STARTED_AT_FILENAME = 'startedAt';

/**
 * 启动期数据迁移主控。
 * 单次使用（每次 bootstrap new 一个实例）；run() 跑完即废弃。
 */
export class MigrationManager {
  private readonly dataDir: string;
  private readonly appConfig: AppConfigService;
  private readonly ledgerPath: string;
  private readonly lockDir: string;

  constructor(opts: MigrationManagerOptions) {
    this.dataDir = opts.dataDir;
    this.appConfig = opts.appConfig;
    this.ledgerPath = path.join(this.dataDir, LEDGER_FILENAME);
    this.lockDir = path.join(this.dataDir, LOCK_DIRNAME);
  }

  /**
   * 跑完整迁移流程。
   *
   * 任一 handler throw 被 catch 进 summary.errors，**不抛出**（不阻塞 bootstrap）。
   * 唯一会抛的是 acquireLock 失败 → 也 catch 进 summary.errors（lock 冲突视为迁移失败，不阻塞）。
   */
  async run(): Promise<MigrationSummary> {
    const summary: MigrationSummary = { ran: [], skipped: [], errors: [] };
    let locked = false;
    try {
      this.acquireLock();
      locked = true;

      const currentVersion = getAppVersion();
      const registry = this.loadRegistry();
      const ledger = this.readLedger();

      for (const entry of registry) {
        await this.processEntry(entry, ledger, currentVersion, summary);
      }

      // 更新 lastAppVersion（无论 handler 跑没跑，都标记当前版本已处理）
      ledger.lastAppVersion = currentVersion;
      this.writeLedger(ledger);
    } catch (err) {
      // lock 冲突 / loadRegistry / readLedger / writeLedger 抛错都进这里
      const e = err as Error;
      summary.errors.push({ id: '__manager__', message: e.message, stack: e.stack });
    } finally {
      if (locked) {
        try {
          this.releaseLock();
        } catch {
          // 释放锁失败不阻塞（锁目录可能已被外部清；下次启动 stale 检测会清）
        }
      }
    }
    return summary;
  }

  /**
   * 处理单个 handler entry —— applied 判定 + 执行 + 记录到 ledger/summary。
   *
   * 分支：
   *   1. status='done'（已 applied）→ skip（保持 done，不覆盖）
   *   2. 未 applied + range 不满足 → 持久化 'na'（幂等覆盖）+ 进 skipped
   *   3. 未 applied + range 满足 → 执行 → 记 done / error
   *
   * 'na' 持久化：让 ledger 完整记录三种终态（done/error/na）；na handler 下次启动
   * 仍走 range 兜底重评估（幂等覆盖）。
   */
  private async processEntry(
    entry: HandlerEntry,
    ledger: MigrationLedger,
    currentVersion: string,
    summary: MigrationSummary,
  ): Promise<void> {
    const state = ledger.handlers[entry.id];
    if (state?.status === 'done') {
      summary.skipped.push(entry.id);
      return;
    }
    // range 兜底判定（解析失败视为不满足）
    let rangeOk = false;
    try { rangeOk = satisfiesRange(currentVersion, entry.versionRange); } catch { /* 保守不执行 */ }
    if (!rangeOk) {
      // 未 applied + range 不满足 → 持久化 na + 进 skipped
      ledger.handlers[entry.id] = {
        status: 'na', appliedAt: new Date().toISOString(), appVersion: currentVersion,
      };
      summary.skipped.push(entry.id);
      return;
    }
    // 执行 handler
    summary.ran.push(entry.id);
    const ctx: MigrationHandlerContext = { dataDir: this.dataDir, appConfig: this.appConfig };
    try {
      const handlerFn = resolveHandler(entry);
      await handlerFn(ctx);
      ledger.handlers[entry.id] = {
        status: 'done', appliedAt: new Date().toISOString(), appVersion: currentVersion,
      };
    } catch (err) {
      const e = err as Error;
      ledger.handlers[entry.id] = {
        status: 'error', appliedAt: new Date().toISOString(), appVersion: currentVersion,
        error: { message: e.message, stack: e.stack },
      };
      summary.errors.push({ id: entry.id, message: e.message, stack: e.stack });
    }
  }

  /**
   * 获取文件锁：mkdir 原子操作（已存在 → EEXIST → 检测 pid 是否存活）。
   * pid 仍存活 → throw MigrationLockHeldError；pid 死 → 清旧锁重建。
   */
  private acquireLock(): void {
    try {
      fs.mkdirSync(this.lockDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // 锁已存在：检测是否 stale（pid 是否存活）
      if (this.isLockHeld()) {
        throw new MigrationLockHeldError(
          this.lockDir,
          `migration lock 被 PID ${this.readPid()} 持有（${this.lockDir}）`,
        );
      }
      // stale 锁 → 清旧重建
      this.clearLockDir();
      fs.mkdirSync(this.lockDir);
    }
    // 写 pid + startedAt
    fs.writeFileSync(path.join(this.lockDir, PID_FILENAME), String(process.pid), 'utf-8');
    fs.writeFileSync(
      path.join(this.lockDir, STARTED_AT_FILENAME),
      new Date().toISOString(),
      'utf-8',
    );
  }

  /** 释放锁（rmdir 递归；catch 吞错） */
  private releaseLock(): void {
    this.clearLockDir();
  }

  /** 检测锁是否被活跃进程持有（pid 文件存在且进程存活） */
  private isLockHeld(): boolean {
    const pid = this.readPid();
    if (pid === null) return false;
    return isPidAlive(pid);
  }

  private readPid(): number | null {
    try {
      const raw = fs.readFileSync(path.join(this.lockDir, PID_FILENAME), 'utf-8').trim();
      const pid = Number.parseInt(raw, 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  /** 清空锁目录内容并删除（rmdir recursive） */
  private clearLockDir(): void {
    fs.rmSync(this.lockDir, { recursive: true, force: true });
  }

  /**
   * 读 handlers/handlers.yaml → HandlerEntry[]。
   * @throws yaml 文件不存在或解析失败（运行时硬失败）
   */
  private loadRegistry(): HandlerEntry[] {
    const yamlPath = path.resolve(__dirname, './handlers/handlers.yaml');
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    const parsed = parseYaml(raw) as { handlers?: HandlerEntry[] };
    if (!parsed || !Array.isArray(parsed.handlers)) {
      throw new Error(`migration: ${yamlPath} 缺失 handlers 数组`);
    }
    return parsed.handlers;
  }

  /**
   * 读 ledger 文件。首次启动（文件缺失）返回 { lastAppVersion: '0.0.0', handlers: {} }。
   * @throws JSON 解析失败（污染数据）—— 由 run() catch 进 summary.errors
   */
  private readLedger(): MigrationLedger {
    try {
      const raw = fs.readFileSync(this.ledgerPath, 'utf-8');
      const parsed = JSON.parse(raw) as MigrationLedger;
      // 兜底：旧 ledger 可能缺字段
      return {
        lastAppVersion: parsed.lastAppVersion ?? '0.0.0',
        handlers: parsed.handlers ?? {},
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { lastAppVersion: '0.0.0', handlers: {} };
      }
      throw err; // JSON.parse 失败等 → 上抛
    }
  }

  /**
   * 原子写 ledger（writeFileSync tmp + renameSync）。
   * 不走 CrudStore（避免循环依赖）。
   */
  private writeLedger(ledger: MigrationLedger): void {
    const tmpPath = this.ledgerPath + '.tmp';
    const data = JSON.stringify(ledger, null, 2) + '\n';
    fs.writeFileSync(tmpPath, data, 'utf-8');
    fs.renameSync(tmpPath, this.ledgerPath);
  }
}

/**
 * 检测 pid 是否存活（跨平台 best-effort）。
 *   - process.kill(pid, 0) 不实际发信号，仅检查进程是否存在
 *   - EPERM（macOS 权限不足）：进程存在但当前用户无权 signal → 视为 alive
 *   - ESRCH：进程不存在 → stale
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true; // 进程存在但权限不足
    return false; // ESRCH 或其他 → 视为 stale
  }
}
