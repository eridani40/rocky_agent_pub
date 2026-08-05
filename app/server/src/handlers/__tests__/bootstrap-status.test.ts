/**
 * handleBootstrapStatus 单测 —— GET /bootstrap/status 响应 schema + 错误兜底。
 * 参考: specs/tech/version_logs/v0.0.150/change_plan.md §C（前后端报错通道）
 *       states/v0.0.150/verify/test-plan.md（UT 覆盖点：handleBootstrapStatus）
 *
 * 覆盖：
 *   1. 正常路径：返 200 + {appVersion, lastAppVersion, migrationErrors} 三字段
 *   2. migrationErrors 非空时仍返 200（统一放行语义）
 *   3. ledger 文件缺失（首次启动）→ lastAppVersion='0.0.0' 兜底
 *   4. ledger JSON 损坏 → lastAppVersion='0.0.0' 兜底
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach rmSync（不碰真实 ~/.rocky_agent_*）。
 *
 * getAppVersion mock（v0.0.158 补）：app-version.json 是 build 期生成物（.gitignore 排除，
 * 由 scripts/gen-version.ts 从 package.json 生成），UT 环境下不保证存在；本 UT 目的是测
 * handler 逻辑不是测 fs 读，mock 掉即可（选方案 A）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// vi.mock 被 vitest 提升到文件顶部（早于 import/const），故 path 用 vi.hoisted + require('node:path')
// + __dirname 派生（portable）；严禁硬编码 worktree 路径——merge 后失效
// （memory: test-vitest-mock-absolute-path）。相对路径在 bun 全量并发下静默失效。
const { appVersionPath } = vi.hoisted(() => {
  const { resolve } = require('node:path') as typeof import('node:path');
  return { appVersionPath: resolve(__dirname, '../../migration/app-version') };
});

vi.mock(appVersionPath, () => ({
  getAppVersion: () => '0.0.158',
}));

import { handleBootstrapStatus } from '../bootstrap-status';
import { getAppVersion } from '../../migration/app-version';
import type { BootstrapResult } from '../../bootstrap';

let tmpDataDir: string;

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-status-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

/** 构造最小 BootstrapResult mock（只测 migrationErrors 字段；其他字段用 unknown cast 绕过） */
function mockBootstrapResult(errors: Array<{ id: string; message: string; stack?: string }>): BootstrapResult {
  return { migrationErrors: errors } as unknown as BootstrapResult;
}

/** 写 ledger 到 tmpDataDir */
function writeLedger(ledger: unknown): void {
  fs.writeFileSync(
    path.join(tmpDataDir, 'migration_state.json'),
    JSON.stringify(ledger),
    'utf-8',
  );
}

describe('handleBootstrapStatus — 正常路径', () => {
  it('返 200 + {appVersion, lastAppVersion, migrationErrors} 三字段', async () => {
    writeLedger({ lastAppVersion: '0.0.147', handlers: {} });

    const res = handleBootstrapStatus(mockBootstrapResult([]), tmpDataDir);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = (await res.json()) as {
      appVersion: string;
      lastAppVersion: string;
      migrationErrors: Array<{ id: string; message: string }>;
    };
    expect(body.appVersion).toBe(getAppVersion());
    expect(body.lastAppVersion).toBe('0.0.147');
    expect(body.migrationErrors).toEqual([]);
  });
});

describe('handleBootstrapStatus — 即使有 errors 仍返 200（统一放行）', () => {
  it('migrationErrors 非空时仍 200', async () => {
    writeLedger({ lastAppVersion: '0.0.148', handlers: {} });
    const errors = [
      { id: '__manager__', message: 'migration lock held' },
      { id: 'dummy-update', message: 'boom' },
    ];

    const res = handleBootstrapStatus(mockBootstrapResult(errors), tmpDataDir);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { migrationErrors: unknown[] };
    expect(body.migrationErrors.length).toBe(2);
  });
});

describe('handleBootstrapStatus — lastAppVersion 兜底', () => {
  it('ledger 文件缺失（首次启动）→ lastAppVersion="0.0.0"', async () => {
    // 不写 ledger → 文件缺失
    const res = handleBootstrapStatus(mockBootstrapResult([]), tmpDataDir);
    const body = (await res.json()) as { lastAppVersion: string };
    expect(body.lastAppVersion).toBe('0.0.0');
  });

  it('ledger JSON 损坏 → lastAppVersion="0.0.0"', async () => {
    fs.writeFileSync(
      path.join(tmpDataDir, 'migration_state.json'),
      '{not valid json',
      'utf-8',
    );
    const res = handleBootstrapStatus(mockBootstrapResult([]), tmpDataDir);
    const body = (await res.json()) as { lastAppVersion: string };
    expect(body.lastAppVersion).toBe('0.0.0');
  });

  it('ledger 缺 lastAppVersion 字段 → 兜底 "0.0.0"', async () => {
    writeLedger({ handlers: {} });
    const res = handleBootstrapStatus(mockBootstrapResult([]), tmpDataDir);
    const body = (await res.json()) as { lastAppVersion: string };
    expect(body.lastAppVersion).toBe('0.0.0');
  });
});
