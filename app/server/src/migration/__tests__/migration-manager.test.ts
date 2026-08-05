/**
 * MigrationManager 单测 —— 覆盖 acceptanceCriteria 4 条。
 * 参考: specs/tech/version_logs/v0.0.150/change_plan.md §A（UT：applied 主防线 + range 兜底 + lock + 不阻塞）
 *
 * 覆盖点：
 *   1. 首次启动 ledger 缺失 → 跑所有 handler → done + lastAppVersion 更新
 *   2. 二次启动 applied → skip
 *   3. error handler 进 summary 不抛
 *   4. lock 冲突 throw 被 run catch 进 summary
 *   5. applied 主防线 + range 兜底语义
 *
 * Registry（v0.0.150 步骤2 起）：dummy-update / memory-source-updated / memory-intro 三条，
 *   全部 range=`<0.0.151`。memory-* handler 在空 dataDir 上为 no-op（无 sessions、无 record），
 *   不影响 dummy-update 的语义验证；用 real AppConfigService 而非 fake（memory handler 需 .get/.set）。
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach rmSync（不碰真实 ~/.rocky_agent_*）。
 *
 * 版本号：mock getAppVersion 返回 '0.0.150'（v0.0.158 补）。
 *   历史（v0.0.150 写就）曾用 real app-version.json——彼时 real 版本 <0.0.151 满足所有 handler range；
 *   随版本号单调递增到 0.0.157+，real 版本 >0.0.151 后所有 handler 不再匹配 range，全部 skip → 测试
 *   assertion（期望 ran）全 fail。改为 mock 固定 '0.0.150' 保测试语义稳定不受版本推进影响。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// vi.mock 被 vitest 提升到文件顶部（早于 import/const），故 path 用 vi.hoisted + require('node:path')
// + __dirname 派生（portable）；严禁硬编码 worktree 路径——merge 后失效
// （memory: test-vitest-mock-absolute-path）。相对路径在 bun 全量并发下静默失效。
const { appVersionPath } = vi.hoisted(() => {
  const { resolve } = require('node:path') as typeof import('node:path');
  return { appVersionPath: resolve(__dirname, '../app-version') };
});

vi.mock(appVersionPath, () => ({
  getAppVersion: () => '0.0.150',
}));

import { MigrationManager, MigrationLockHeldError } from '../migration-manager';
import { getAppVersion } from '../app-version';
import * as appVersionModule from '../app-version';
import { AppConfigService } from '../../config/app-config-service';
import type { MigrationLedger } from '../ledger';
import { handlerRegistry } from '../handlers';

let tmpDataDir: string;
let appConfig: AppConfigService;
/** 当前 app 版本（mock 返回 '0.0.150'，稳定满足 handler range `<0.0.151`） */
const CURRENT_VERSION = getAppVersion();

/**
 * Registry 全量 id（YAML 顺序）—— 用于断言 ran/skipped 数组。
 * v0.0.158 新增两 handler（range `<0.0.158`）：clean-default-models-summary
 * + clean-squad-summary-model-default，mock 版本 0.0.150 满足两 range。
 * v0.0.204 新增 handler（range `<0.0.205`）：session-derivation-main-to-parent
 * （derivation main→parent 改名，存量 session record 改写；空 dataDir 上为 no-op）。
 * v0.0.205 新增两 handler（range `<0.0.206`）：session-memory-per-entry
 * + squad-rocky-dir（存储模型统一；空 dataDir 上为 no-op）。
 * v0.0.206 新增 handler（range `<0.0.207`）：channel-binding-config-id
 * （channel_bindings instanceId→configId；空 dataDir 上为 no-op）。
 */
const ALL_HANDLER_IDS = [
  'dummy-update',
  'memory-source-updated',
  'memory-intro',
  'clean-default-models-summary',
  'clean-squad-summary-model-default',
  'session-derivation-main-to-parent',
  'session-memory-per-entry',
  'squad-rocky-dir',
  'channel-binding-config-id',
];

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'migration-mgr-test-'));
  appConfig = new AppConfigService({ root: tmpDataDir });
});

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
});

/** 读 tmpDataDir 下 ledger（不存在返回 null） */
function readLedgerOrNull(): MigrationLedger | null {
  const fp = join(tmpDataDir, 'migration_state.json');
  if (!existsSync(fp)) return null;
  return JSON.parse(readFileSync(fp, 'utf-8')) as MigrationLedger;
}

/** 模拟 lock 被活跃进程持有：创建 lock 目录 + 写当前 process.pid */
function seedActiveLock(): void {
  const lockDir = join(tmpDataDir, 'migration.lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'pid'), String(process.pid), 'utf-8');
  writeFileSync(join(lockDir, 'startedAt'), new Date().toISOString(), 'utf-8');
}

/** 模拟 stale lock：写一个几乎不存在的 pid（如 999999） */
function seedStaleLock(): void {
  const lockDir = join(tmpDataDir, 'migration.lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'pid'), '999999', 'utf-8');
}

describe('MigrationManager.run — 首次启动 ledger 缺失', () => {
  it('跑所有 handler → ledger 记 done + lastAppVersion=当前版本', async () => {
    const mgr = new MigrationManager({ dataDir: tmpDataDir, appConfig: appConfig });
    const summary = await mgr.run();

    expect(summary.ran).toEqual(ALL_HANDLER_IDS);
    expect(summary.skipped).toEqual([]);
    expect(summary.errors).toEqual([]);

    const ledger = readLedgerOrNull();
    expect(ledger).not.toBeNull();
    expect(ledger!.lastAppVersion).toBe(CURRENT_VERSION);
    expect(ledger!.handlers['dummy-update']!.status).toBe('done');
    expect(ledger!.handlers['dummy-update']!.appVersion).toBe(CURRENT_VERSION);
    expect(ledger!.handlers['dummy-update']!.appliedAt).toBeTruthy();
  });

  it('跑完后 lock 目录被释放', async () => {
    const mgr = new MigrationManager({ dataDir: tmpDataDir, appConfig: appConfig });
    await mgr.run();
    expect(existsSync(join(tmpDataDir, 'migration.lock'))).toBe(false);
  });
});

describe('MigrationManager.run — 二次启动 applied → skip', () => {
  it('ledger 中 status=done 的 handler 不再跑', async () => {
    // 预置 ledger：dummy-update 已 done；其余 handler 未 applied 仍会跑（空 dataDir → no-op）
    const ledger: MigrationLedger = {
      lastAppVersion: '0.0.147',
      handlers: {
        'dummy-update': {
          status: 'done',
          appliedAt: '2025-01-01T00:00:00.000Z',
          appVersion: '0.0.147',
        },
      },
    };
    writeFileSync(join(tmpDataDir, 'migration_state.json'), JSON.stringify(ledger), 'utf-8');

    const mgr = new MigrationManager({ dataDir: tmpDataDir, appConfig: appConfig });
    const summary = await mgr.run();

    // 除 dummy-update 外其余全跑（含 v0.0.158/v0.0.203/v0.0.204/v0.0.205 新增 handler，range 满足当前版本）
    expect(summary.ran).toEqual(ALL_HANDLER_IDS.slice(1));
    expect(summary.skipped).toEqual(['dummy-update']);
    expect(summary.errors).toEqual([]);

    // lastAppVersion 仍更新为当前版本
    const after = readLedgerOrNull();
    expect(after!.lastAppVersion).toBe(CURRENT_VERSION);
    // handler 状态保留 done（不被覆盖）
    expect(after!.handlers['dummy-update']!.status).toBe('done');
  });

  it('applied 主防线：range 仍满足但 done → 不跑', async () => {
    // dummy-update range='<0.0.151'，当前版本满足 range
    // 但 handler 已 done → applied 主防线优先，skip；memory-* 仍会跑
    const ledger: MigrationLedger = {
      lastAppVersion: '0.0.146',
      handlers: {
        'dummy-update': {
          status: 'done',
          appliedAt: '2025-01-01T00:00:00.000Z',
          appVersion: '0.0.146',
        },
      },
    };
    writeFileSync(join(tmpDataDir, 'migration_state.json'), JSON.stringify(ledger), 'utf-8');

    const mgr = new MigrationManager({ dataDir: tmpDataDir, appConfig: appConfig });
    const summary = await mgr.run();
    // 除 dummy-update 外其余全跑（含 v0.0.158/v0.0.203/v0.0.204/v0.0.205 新增 handler）
    expect(summary.ran).toEqual(ALL_HANDLER_IDS.slice(1));
    expect(summary.skipped).toEqual(['dummy-update']);
  });
});

describe('MigrationManager.run — error handler 进 summary 不抛', () => {
  it('handler throw → 记 error 状态 + summary.errors 有该 id，不抛出', async () => {
    // 临时替换 dummy-update 为抛错版本（memory-* 仍正常跑空 dataDir）
    const orig = handlerRegistry['dummy-update']!;
    handlerRegistry['dummy-update'] = async () => {
      throw new Error('boom from test handler');
    };

    try {
      const mgr = new MigrationManager({ dataDir: tmpDataDir, appConfig: appConfig });
      const summary = await mgr.run();

      // 不抛出（run 正常返回）；ran 含全部（dummy 抛错前已 push）
      expect(summary.ran).toEqual(ALL_HANDLER_IDS);
      expect(summary.errors.length).toBe(1);
      expect(summary.errors[0]!.id).toBe('dummy-update');
      expect(summary.errors[0]!.message).toContain('boom from test handler');

      // ledger 记 error 状态
      const ledger = readLedgerOrNull();
      expect(ledger!.handlers['dummy-update']!.status).toBe('error');
      expect(ledger!.handlers['dummy-update']!.error?.message).toContain('boom from test handler');
      // lastAppVersion 仍更新（即使有 error，本次跑过即标记）
      expect(ledger!.lastAppVersion).toBe(CURRENT_VERSION);
    } finally {
      handlerRegistry['dummy-update'] = orig;
    }
  });
});

describe('MigrationManager.run — lock 冲突', () => {
  it('lock 被活跃 pid 持有 → MigrationLockHeldError 被 run catch 进 summary.errors，不抛', async () => {
    seedActiveLock();

    const mgr = new MigrationManager({ dataDir: tmpDataDir, appConfig: appConfig });
    const summary = await mgr.run();

    // lock 错误进 summary.errors（id='__manager__'），不抛出
    expect(summary.ran).toEqual([]);
    expect(summary.errors.length).toBe(1);
    expect(summary.errors[0]!.id).toBe('__manager__');
    expect(summary.errors[0]!.message).toMatch(/lock|PID/i);

    // ledger 未被写（lock 失败 → 流程早退，未到 writeLedger）
    const ledger = readLedgerOrNull();
    // 首次缺失 → 仍 null（writeLedger 未执行）
    expect(ledger).toBeNull();
  });

  it('lock 被 stale pid 持有 → 清旧锁重建，流程正常完成', async () => {
    seedStaleLock();

    const mgr = new MigrationManager({ dataDir: tmpDataDir, appConfig: appConfig });
    const summary = await mgr.run();

    // stale 锁被清，正常跑完
    expect(summary.ran).toEqual(ALL_HANDLER_IDS);
    expect(summary.errors).toEqual([]);
    expect(summary.skipped).toEqual([]);

    // 跑完释放锁
    expect(existsSync(join(tmpDataDir, 'migration.lock'))).toBe(false);

    const ledger = readLedgerOrNull();
    expect(ledger!.handlers['dummy-update']!.status).toBe('done');
  });
});

describe('MigrationManager.run — range 兜底 + error 重试', () => {
  it('status=error（非 done）+ range 满足 → 重试一次', async () => {
    // dummy-update range='<0.0.151'，当前版本满足 → error 状态会重试
    // memory-* 未 applied 也会跑（空 dataDir → no-op）
    const ledger: MigrationLedger = {
      lastAppVersion: '0.0.147',
      handlers: {
        'dummy-update': {
          status: 'error',
          appliedAt: '2025-01-01T00:00:00.000Z',
          appVersion: '0.0.147',
          error: { message: 'prev fail' },
        },
      },
    };
    writeFileSync(join(tmpDataDir, 'migration_state.json'), JSON.stringify(ledger), 'utf-8');

    const mgr = new MigrationManager({ dataDir: tmpDataDir, appConfig: appConfig });
    const summary = await mgr.run();

    // status='error'（非 done）+ range 满足 → 重试一次；memory-* 也跑
    expect(summary.ran).toEqual(ALL_HANDLER_IDS);
    expect(summary.skipped).toEqual([]);
    // dummy-update 不抛 → done
    const after = readLedgerOrNull();
    expect(after!.handlers['dummy-update']!.status).toBe('done');
  });
});

describe('MigrationManager.run — na 持久化（未 applied + range 不满足）', () => {
  it('未 applied + range 不满足 → 持久化 na + 进 skipped', async () => {
    // mock getAppVersion 返 '0.0.207'（不满足任一 handler range：老 3 条 '<0.0.151' + v0.0.158 两条
    // '<0.0.158' + v0.0.203 两条 '<0.0.204' + v0.0.204 一条 '<0.0.205' + v0.0.205 两条 '<0.0.206'
    // + v0.0.206 一条 '<0.0.207'）
    const spy = vi.spyOn(appVersionModule, 'getAppVersion').mockReturnValue('0.0.207');
    try {
      const mgr = new MigrationManager({ dataDir: tmpDataDir, appConfig: appConfig });
      const summary = await mgr.run();

      expect(summary.ran).toEqual([]);
      expect(summary.skipped).toEqual(ALL_HANDLER_IDS);
      expect(summary.errors).toEqual([]);

      // ledger 持久化 na 状态（未 applied + range 不满足）
      const ledger = readLedgerOrNull();
      expect(ledger).not.toBeNull();
      expect(ledger!.lastAppVersion).toBe('0.0.207');
      expect(ledger!.handlers['dummy-update']!.status).toBe('na');
      expect(ledger!.handlers['dummy-update']!.appVersion).toBe('0.0.207');
      expect(ledger!.handlers['dummy-update']!.appliedAt).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('na handler 二次启动 range 仍不满足 → 幂等覆盖 na', async () => {
    // 预置 dummy-update 为 na；其余 handler 未 applied（仍会被 range 评估）
    const ledger: MigrationLedger = {
      lastAppVersion: '0.0.207',
      handlers: {
        'dummy-update': {
          status: 'na',
          appliedAt: '2025-01-01T00:00:00.000Z',
          appVersion: '0.0.207',
        },
      },
    };
    writeFileSync(join(tmpDataDir, 'migration_state.json'), JSON.stringify(ledger), 'utf-8');

    const spy = vi.spyOn(appVersionModule, 'getAppVersion').mockReturnValue('0.0.207');
    try {
      const mgr = new MigrationManager({ dataDir: tmpDataDir, appConfig: appConfig });
      const summary = await mgr.run();

      // na handler 仍被 range 兜底重评估 → 跳过 + 幂等覆盖 na（全部 handler range 不满足）
      expect(summary.ran).toEqual([]);
      expect(summary.skipped).toEqual(ALL_HANDLER_IDS);
      expect(summary.errors).toEqual([]);

      const after = readLedgerOrNull();
      expect(after!.handlers['dummy-update']!.status).toBe('na');
    } finally {
      spy.mockRestore();
    }
  });

  it('na handler 二次启动 range 变满足 → 重评估执行 → done', async () => {
    // 预置 dummy-update 为 na（之前版本 0.0.151 不满足 range）
    const ledger: MigrationLedger = {
      lastAppVersion: '0.0.151',
      handlers: {
        'dummy-update': {
          status: 'na',
          appliedAt: '2025-01-01T00:00:00.000Z',
          appVersion: '0.0.151',
        },
      },
    };
    writeFileSync(join(tmpDataDir, 'migration_state.json'), JSON.stringify(ledger), 'utf-8');

    // 当前版本回退到 0.0.150（满足 range '<0.0.151'）——na 仍会被重评估；memory-* 同跑
    const spy = vi.spyOn(appVersionModule, 'getAppVersion').mockReturnValue('0.0.150');
    try {
      const mgr = new MigrationManager({ dataDir: tmpDataDir, appConfig: appConfig });
      const summary = await mgr.run();

      expect(summary.ran).toEqual(ALL_HANDLER_IDS);
      expect(summary.skipped).toEqual([]);
      const after = readLedgerOrNull();
      expect(after!.handlers['dummy-update']!.status).toBe('done');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('MigrationManager.run — 原子写 ledger', () => {
  it('写完后无 .tmp 残留', async () => {
    const mgr = new MigrationManager({ dataDir: tmpDataDir, appConfig: appConfig });
    await mgr.run();
    expect(existsSync(join(tmpDataDir, 'migration_state.json'))).toBe(true);
    expect(existsSync(join(tmpDataDir, 'migration_state.json.tmp'))).toBe(false);
  });
});

describe('MigrationLockHeldError', () => {
  it('可被实例化 + name 正确', () => {
    const err = new MigrationLockHeldError('/tmp/lock', 'held');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MigrationLockHeldError');
    expect(err.lockPath).toBe('/tmp/lock');
    expect(err.message).toBe('held');
  });
});
