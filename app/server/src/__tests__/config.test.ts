/**
 * config loader 单测
 * 参考: specs/tech/app/envs/[P0]environments.md §3.1/§4.6（DATA_DIR 回退规则、端口键名）
 *
 * 校验点：
 *   - 从 process.env 解析 API_PORT / WEB_PORT / DATA_DIR / APP_NAME / APP_ENV
 *   - DATA_DIR 未设时回退 ~/.{APP_NAME}_{APP_ENV}
 *   - 默认 APP_NAME=rocky_agent
 */
import { mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { loadConfig } from '../config';

/** 把指定键集合从 process.env 摘出，便于断言前快照/恢复 */
function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of keys) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const ENV_KEYS = ['APP_NAME', 'APP_ENV', 'API_PORT', 'WEB_PORT', 'DATA_DIR', 'HEALTH_ENDPOINT'];

describe('config loader (loadConfig)', () => {
  let snap: Record<string, string | undefined>;
  beforeEach(() => {
    snap = snapshotEnv(ENV_KEYS);
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => restoreEnv(snap));

  it('从 env 解析 API_PORT / WEB_PORT 为数字', () => {
    process.env.API_PORT = '3700';
    process.env.WEB_PORT = '8787';
    process.env.APP_ENV = 'test';
    const cfg = loadConfig();
    expect(cfg.apiPort).toBe(3700);
    expect(cfg.webPort).toBe(8787);
  });

  it('DATA_DIR 显式设置时直接使用', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rocky-cfg-'));
    process.env.API_PORT = '3700';
    process.env.WEB_PORT = '8787';
    process.env.DATA_DIR = tmp;
    process.env.APP_ENV = 'test';
    const cfg = loadConfig();
    expect(cfg.dataDir).toBe(tmp);
  });

  it('DATA_DIR 以 ~ 开头时展开为 home（与 shell source 字面 ~ 兼容，spec §3.5）', () => {
    process.env.API_PORT = '3700';
    process.env.WEB_PORT = '8787';
    process.env.APP_ENV = 'test';
    process.env.DATA_DIR = '~/.rocky_agent_test';
    const cfg = loadConfig();
    expect(cfg.dataDir).toBe(join(homedir(), '.rocky_agent_test'));
  });

  it('DATA_DIR 未设时回退 ~/.{APP_NAME}_{APP_ENV}', () => {
    process.env.API_PORT = '3700';
    process.env.WEB_PORT = '8787';
    process.env.APP_NAME = 'rocky_agent';
    process.env.APP_ENV = 'test';
    const cfg = loadConfig();
    expect(cfg.dataDir).toBe(join(homedir(), '.rocky_agent_test'));
  });

  it('DATA_DIR 未设且 APP_ENV=dev 时回退 dev 目录', () => {
    process.env.API_PORT = '3710';
    process.env.WEB_PORT = '8788';
    process.env.APP_ENV = 'dev';
    const cfg = loadConfig();
    expect(cfg.dataDir).toBe(join(homedir(), '.rocky_agent_dev'));
  });

  it('读 HEALTH_ENDPOINT', () => {
    process.env.API_PORT = '3700';
    process.env.WEB_PORT = '8787';
    process.env.HEALTH_ENDPOINT = '/health';
    process.env.APP_ENV = 'test';
    const cfg = loadConfig();
    expect(cfg.healthEndpoint).toBe('/health');
  });

  it('默认 APP_NAME=rocky_agent', () => {
    process.env.API_PORT = '3700';
    process.env.WEB_PORT = '8787';
    process.env.APP_ENV = 'test';
    const cfg = loadConfig();
    expect(cfg.appName).toBe('rocky_agent');
  });
});
