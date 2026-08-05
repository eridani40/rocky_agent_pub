/**
 * main-event-monitor 单测 — Electron 主进程事件循环卡顿监控接线（v0.0.254）
 * 参考: app/electron/src/main-event-monitor.ts 模块头（设计要点）
 *
 * 校验点：
 *   - 注入 spy：startMonitor 收到 source='electron-main' + envFlag='MAIN_EVENT_LOOP_MONITOR'
 *     + profileDir=<resolveDataDir 返回值>/profiles + env 透传
 *   - 写盘路径经 resolveDataDir 派生（真身 @app/server/src/config）：DATA_DIR 带 ~ 时
 *     profileDir 已展开为 home 下绝对路径，绝不含字面 ~（BUG-004 护栏回归）
 *   - 失败静默：startMonitor 抛错 / resolveDataDir 抛错均不 throw、不影响调用方
 *
 * 依赖注入：所有用例注入 startMonitor/resolveDataDir 替身（或真身 resolveDataDir 走源码），
 *   故 electron 单测无需 server dist 构建（对齐 backend-bootstrap.test.ts 既有模式）。
 */
import { describe, it, expect, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
// 复用 server 端唯一权威（源码路径，vitest 走 src，不依赖 dist 构建）
import { resolveDataDir } from '@app/server/src/config';
import { startMainEventLoopMonitor } from '../main-event-monitor';
import type { EventLoopMonitorOptions } from '@app/server';

describe('startMainEventLoopMonitor — 接线参数', () => {
  it('startMonitor 收到 electron-main 来源 + MAIN_EVENT_LOOP_MONITOR 开关 + profiles 目录 + env 透传', () => {
    const startMonitor = vi.fn();
    const env = { DATA_DIR: '/tmp/x-data', MAIN_EVENT_LOOP_MONITOR: '1' };
    startMainEventLoopMonitor(env, { startMonitor, resolveDataDir: () => '/tmp/x-data' });
    expect(startMonitor).toHaveBeenCalledTimes(1);
    const opts = startMonitor.mock.calls[0]?.[0] as EventLoopMonitorOptions;
    expect(opts.source).toBe('electron-main');
    expect(opts.envFlag).toBe('MAIN_EVENT_LOOP_MONITOR');
    expect(opts.profileDir).toBe(join('/tmp/x-data', 'profiles'));
    // env 走 deps 通道（与真身 startEventLoopMonitor 的读取位置一致）
    expect(opts.deps?.env).toBe(env);
  });

  it('profileDir 经真身 resolveDataDir 派生：DATA_DIR=~/... 展开为绝对路径（无字面 ~）', () => {
    const startMonitor = vi.fn();
    startMainEventLoopMonitor(
      { DATA_DIR: '~/.x-elm-test', APP_NAME: 'rocky_agent', APP_ENV: 'test' },
      { startMonitor, resolveDataDir },
    );
    const opts = startMonitor.mock.calls[0]?.[0] as { profileDir: string };
    expect(opts.profileDir).toBe(join(homedir(), '.x-elm-test', 'profiles'));
    expect(opts.profileDir.startsWith('~')).toBe(false);
  });

  it('DATA_DIR 未设 → 回退 ~/.{APP_NAME}_{APP_ENV}/profiles 并展开', () => {
    const startMonitor = vi.fn();
    startMainEventLoopMonitor({ APP_NAME: 'rocky_agent', APP_ENV: 'prod' }, {
      startMonitor,
      resolveDataDir,
    });
    const opts = startMonitor.mock.calls[0]?.[0] as { profileDir: string };
    expect(opts.profileDir).toBe(join(homedir(), '.rocky_agent_prod', 'profiles'));
  });
});

describe('startMainEventLoopMonitor — 失败静默', () => {
  it('startMonitor 抛错 → 捕获 + error 日志，不向调用方 throw', () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const startMonitor = vi.fn(() => {
      throw new Error('dist broken');
    });
    expect(() =>
      startMainEventLoopMonitor({}, { startMonitor, resolveDataDir: () => '/tmp/x', log }),
    ).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('start failed'),
      expect.any(Error),
    );
  });

  it('resolveDataDir 抛错 → 同样静默不 throw', () => {
    const log = { info: vi.fn(), error: vi.fn() };
    expect(() =>
      startMainEventLoopMonitor(
        {},
        {
          startMonitor: vi.fn(),
          resolveDataDir: () => {
            throw new Error('no home');
          },
          log,
        },
      ),
    ).not.toThrow();
    expect(log.error).toHaveBeenCalled();
  });
});
