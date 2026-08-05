/**
 * backend-bootstrap 单测 — Electron 主进程后端启动决策 + server 参数派生
 * 参考: specs/tech/app/package/[P0]package_structure.md §4.3
 *       states/v0.0.108/bugs/BUG-004-datadir-tilde-not-expanded-500（dataDir 未展开 ~ → 500）
 *
 * 校验点：
 *   - dev（VITE_DEV_SERVER_URL 非空）→ shouldStartBackend=false（外部 bun 进程跑后端）
 *   - packaged（无 VITE_DEV_SERVER_URL）→ shouldStartBackend=true（主进程 node:http 跑）
 *   - resolveServerOpts 的 dataDir 复用 @app/server config.resolveDataDir：
 *       前导 ~ 展开为 home / 未设时回退派生并展开 / 绝对路径原样（BUG-004 回归）
 *   - startBackend 用依赖注入的 startServer + resolveDataDir，传入 env 派生的 apiPort/dataDir
 *
 * 依赖注入：所有用例注入 resolveDataDir（真身来自 @app/server/src/config，走源码不依赖
 *   server dist 构建），故 electron 包单测无需先 build server（保持现有单测能力）。
 */
import { describe, it, expect, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
// 复用 server 端唯一权威（源码路径，vitest 走 src，不依赖 dist 构建）
import { resolveDataDir } from '@app/server/src/config';
import {
  shouldStartBackend,
  startBackend,
  resolveServerOpts,
  type ServerStarter,
} from '../backend-bootstrap';

describe('shouldStartBackend', () => {
  it('dev 模式：VITE_DEV_SERVER_URL 非空 → false（外部 bun 跑后端）', () => {
    expect(shouldStartBackend({ VITE_DEV_SERVER_URL: 'http://127.0.0.1:8788' })).toBe(false);
  });

  it('packaged 模式：无 VITE_DEV_SERVER_URL → true（主进程起 node:http）', () => {
    expect(shouldStartBackend({})).toBe(true);
  });

  it('packaged 模式：VITE_DEV_SERVER_URL 空串 → true', () => {
    expect(shouldStartBackend({ VITE_DEV_SERVER_URL: '' })).toBe(true);
  });
});

describe('resolveServerOpts — dataDir 展开（BUG-004 回归）', () => {
  it('DATA_DIR 前导 ~ 展开为 home 下绝对路径（不再是字面 ~）', () => {
    const opts = resolveServerOpts({ API_PORT: '3720', DATA_DIR: '~/.x' }, resolveDataDir);
    expect(opts.dataDir).toBe(join(homedir(), '.x'));
    // 契约：绝不返回字面 ~（packaged cwd=/ 下建目录会 EACCES → 500）
    expect(opts.dataDir.startsWith('~')).toBe(false);
  });

  it('DATA_DIR 未设 → 回退 ~/.{APP_NAME}_{APP_ENV} 并展开为绝对路径', () => {
    const opts = resolveServerOpts(
      { API_PORT: '3720', APP_NAME: 'rocky_agent', APP_ENV: 'prod' },
      resolveDataDir,
    );
    expect(opts.dataDir).toBe(join(homedir(), '.rocky_agent_prod'));
    expect(opts.dataDir.startsWith('~')).toBe(false);
  });

  it('DATA_DIR 已是绝对路径 → 原样返回', () => {
    const opts = resolveServerOpts({ API_PORT: '3720', DATA_DIR: '/tmp/prod-data' }, resolveDataDir);
    expect(opts.dataDir).toBe('/tmp/prod-data');
  });

  it('dataDir 委派给注入的解析器（不再自行拼接）', () => {
    const spy = vi.fn(() => '/injected/data');
    const opts = resolveServerOpts({ API_PORT: '3720', DATA_DIR: '~/ignored' }, spy);
    expect(spy).toHaveBeenCalledWith({ API_PORT: '3720', DATA_DIR: '~/ignored' });
    expect(opts.dataDir).toBe('/injected/data');
  });

  it('缺 API_PORT 时抛错（在解析 dataDir 之前）', () => {
    const spy = vi.fn(() => '/should/not/be/called');
    expect(() => resolveServerOpts({ DATA_DIR: '~/.x' }, spy)).toThrow(/API_PORT/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('API_PORT 非法端口时抛错', () => {
    expect(() => resolveServerOpts({ API_PORT: '99999', DATA_DIR: '/x' }, resolveDataDir)).toThrow(
      /合法端口/,
    );
  });
});

describe('startBackend', () => {
  it('用 env 派生的 apiPort/dataDir 调用注入的 startServer', async () => {
    const fakeStart: ServerStarter = vi.fn(async (opts) => ({
      port: opts.apiPort,
      close: () => undefined,
    }));

    await startBackend(
      {
        API_PORT: '3720',
        APP_NAME: 'rocky_agent',
        APP_ENV: 'prod',
        DATA_DIR: '~/.rocky_agent_prod',
      },
      fakeStart,
      resolveDataDir,
    );

    // dataDir 展开为绝对 home 路径后传给 startServer（BUG-004：不再传字面 ~）
    expect(fakeStart).toHaveBeenCalledWith({
      apiPort: 3720,
      dataDir: join(homedir(), '.rocky_agent_prod'),
    });
  });

  it('缺失 API_PORT 时抛错（不让进程静默用错端口）', async () => {
    const fakeStart: ServerStarter = vi.fn();
    await expect(
      startBackend({ APP_NAME: 'rocky_agent', APP_ENV: 'prod' }, fakeStart, resolveDataDir),
    ).rejects.toThrow(/API_PORT/);
    expect(fakeStart).not.toHaveBeenCalled();
  });
});
