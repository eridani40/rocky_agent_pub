/**
 * runtime-config 单测 — packaged Electron 运行时配置注入 + 白名单过滤
 * 参考: specs/tech/app/package/[P0]packaging_toolchain.md §3.5
 *       specs/tech/app/envs/[P0]environments.md §3.1
 *
 * 校验点（对应 task 要求）：
 *   ① 只注入白名单键，写回 env
 *   ② 不覆盖 env 里已有的值（dev/外部注入优先）
 *   ③ configPath 不存在 → 静默返回空、不抛错
 *   ④ config 混入密钥键（ANTHROPIC_API_KEY 等）也不注入 —— 白名单安全红线
 *
 * 文件隔离：用 os.tmpdir() + mkdtempSync，afterEach 清理，禁碰真实路径。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuntimeConfig, RUNTIME_CONFIG_WHITELIST } from '../runtime-config';

describe('loadRuntimeConfig', () => {
  const createdDirs: string[] = [];

  /** 在临时目录写一个 runtime-config.json，返回其绝对路径 */
  function writeConfig(obj: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-rtcfg-'));
    createdDirs.push(dir);
    const p = join(dir, 'runtime-config.json');
    writeFileSync(p, JSON.stringify(obj));
    return p;
  }

  afterEach(() => {
    while (createdDirs.length) {
      rmSync(createdDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('① 只注入白名单键，写回 env', () => {
    const env: NodeJS.ProcessEnv = {};
    const p = writeConfig({
      API_PORT: '3720',
      DATA_DIR: '~/.rocky_agent_prod',
      APP_NAME: 'rocky_agent',
      APP_ENV: 'prod',
      LOG_LEVEL: 'warn',
      HEALTH_ENDPOINT: '/health',
      EVENT_LOOP_MONITOR: '1',
      MAIN_EVENT_LOOP_MONITOR: '1',
    });

    const injected = loadRuntimeConfig(env, p);

    expect(new Set(injected)).toEqual(new Set(RUNTIME_CONFIG_WHITELIST));
    expect(env.API_PORT).toBe('3720');
    expect(env.DATA_DIR).toBe('~/.rocky_agent_prod');
    expect(env.APP_NAME).toBe('rocky_agent');
    expect(env.APP_ENV).toBe('prod');
    expect(env.LOG_LEVEL).toBe('warn');
    expect(env.HEALTH_ENDPOINT).toBe('/health');
    expect(env.EVENT_LOOP_MONITOR).toBe('1');
    expect(env.MAIN_EVENT_LOOP_MONITOR).toBe('1');
  });

  it('② 不覆盖 env 里已有的值（已有 API_PORT 时保留原值）', () => {
    const env: NodeJS.ProcessEnv = { API_PORT: '9999' };
    const p = writeConfig({ API_PORT: '3720', DATA_DIR: '/data' });

    const injected = loadRuntimeConfig(env, p);

    expect(env.API_PORT).toBe('9999'); // 原值保留，config 不覆盖
    expect(injected).not.toContain('API_PORT');
    expect(env.DATA_DIR).toBe('/data'); // 未占用的白名单键仍注入
    expect(injected).toContain('DATA_DIR');
  });

  it('③ configPath 不存在 → 静默返回空、不抛错', () => {
    const env: NodeJS.ProcessEnv = {};
    const missing = join(tmpdir(), 'rocky-rtcfg-no-such-dir', 'runtime-config.json');

    let injected: string[] = [];
    expect(() => {
      injected = loadRuntimeConfig(env, missing);
    }).not.toThrow();
    expect(injected).toEqual([]);
    expect(env.API_PORT).toBeUndefined();
  });

  it('④ config 混入密钥键也不注入（白名单安全红线）', () => {
    const env: NodeJS.ProcessEnv = {};
    const p = writeConfig({
      API_PORT: '3720',
      ANTHROPIC_API_KEY: 'sk-ant-leak',
      MINIMAX_API_KEY: 'mm-leak',
      GLM_API_KEY: 'glm-leak',
      LANGFUSE_SECRET_KEY: 'lf-leak',
      CSC_KEY_PASSWORD: 'pw',
      APPLE_ID: 'x@example.com',
    });

    const injected = loadRuntimeConfig(env, p);

    expect(env.API_PORT).toBe('3720'); // 白名单键正常注入
    expect(injected).toEqual(['API_PORT']); // 仅白名单键
    // 密钥键一律不注入
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.MINIMAX_API_KEY).toBeUndefined();
    expect(env.GLM_API_KEY).toBeUndefined();
    expect(env.LANGFUSE_SECRET_KEY).toBeUndefined();
    expect(env.CSC_KEY_PASSWORD).toBeUndefined();
    expect(env.APPLE_ID).toBeUndefined();
  });

  it('⑥ DATA_DIR 字面 ~ 原样注入，electron 层不展开（波浪号展开是 server config 层职责）', () => {
    const env: NodeJS.ProcessEnv = {};
    const p = writeConfig({ DATA_DIR: '~/.rocky_agent_prod' });

    loadRuntimeConfig(env, p);

    // 原样字面注入，不在 electron 层解析 ~（server config.ts expandTilde 按运行用户 home 展开）
    expect(env.DATA_DIR).toBe('~/.rocky_agent_prod');
  });

  it('⑤ config JSON 非法 → 静默返回空、不抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-rtcfg-'));
    createdDirs.push(dir);
    const p = join(dir, 'runtime-config.json');
    writeFileSync(p, '{ this is not valid json');

    const env: NodeJS.ProcessEnv = {};
    expect(() => loadRuntimeConfig(env, p)).not.toThrow();
    expect(loadRuntimeConfig(env, p)).toEqual([]);
    expect(env.API_PORT).toBeUndefined();
  });
});
