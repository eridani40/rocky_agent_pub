/**
 * bootstrap-status HTTP Handler —— GET /bootstrap/status
 * 参考: specs/tech/version_logs/v0.0.150/change_plan.md §C（前后端报错通道）
 *
 * 职责：
 *   - 返回 200 + JSON `{ appVersion, lastAppVersion, migrationErrors }`
 *   - appVersion：当前 app 版本（getAppVersion 读 app-version.json）
 *   - lastAppVersion：上次跑完 MigrationManager 的版本（重读 ledger 拿，避免 bs 多一字段）
 *   - migrationErrors：bootstrap 期收集的迁移错误（lock 冲突 + handler 抛错；空数组表示无错）
 *
 * 语义：
 *   - 即使有 errors 仍返 200（统一放行——errors 是「迁移有失败但不阻塞启动」的提示信号，非 HTTP 错误）
 *   - 不在此 handler 抛错（所有异常 catch 后仍返 200 + 兜底字段）
 *
 * lastAppVersion 重读 ledger（非 bs 字段）：
 *   - change_plan §C 倾向「避免 bs 多一字段」，故 handleBootstrapStatus 重读 ledger 文件
 *   - ledger 文件缺失/损坏 → 兜底 '0.0.0'（首次启动语义）
 *   - dataDir 已由 router 传入（resolveDataDir 解析过，packaged 安全）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BootstrapResult } from '../bootstrap';
import { getAppVersion } from '../migration/app-version';
import { type MigrationLedger, LEDGER_FILENAME } from '../migration/ledger';

/** 构造 JSON Response */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 读 ledger 拿 lastAppVersion（文件缺失/损坏 → '0.0.0' 兜底）。
 * 不走 MigrationManager 实例（run() 已跑完，单次使用）；直接 fs 读。
 */
function readLastAppVersion(dataDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(dataDir, LEDGER_FILENAME), 'utf-8');
    const parsed = JSON.parse(raw) as MigrationLedger;
    return parsed.lastAppVersion ?? '0.0.0';
  } catch {
    // 文件缺失（首次启动）或 JSON 损坏 → 兜底 '0.0.0'
    return '0.0.0';
  }
}

/**
 * GET /bootstrap/status handler。
 *
 * @param bs bootstrap 共享实例（读 migrationErrors 字段）
 * @param dataDir 数据根目录绝对路径（读 ledger 拿 lastAppVersion）
 * @returns 200 + JSON `{ appVersion, lastAppVersion, migrationErrors }`（即使有 errors 仍 200）
 */
export function handleBootstrapStatus(bs: BootstrapResult, dataDir: string): Response {
  const appVersion = getAppVersion();
  const lastAppVersion = readLastAppVersion(dataDir);
  return json(200, {
    appVersion,
    lastAppVersion,
    migrationErrors: bs.migrationErrors ?? [],
  });
}
