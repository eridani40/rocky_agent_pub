/**
 * bash-engine spawn errno 透出 UT（v0.0.236 A 段）
 * 参考: specs/tech/version_logs/v0.0.236/change_plan.md A 段
 *       states/v0.0.236/research.md §4 A（spawn errno 诊断盲区）
 *
 * 覆盖：
 *   1. child 'error' 事件携 errno（EMFILE）→ ShellResult.spawnErrno=EMFILE + exitCode=1
 *   2. child 'error' 事件 errno 缺失（code=undefined）→ spawnErrno=undefined（兼容）
 *   3. 正常 close 路径 → spawnErrno=undefined
 *   4. bash.ts run 在 spawnErrno 存在时前置 [runtime_error] spawn XXX 文本
 *   5. bash.ts run 在 spawnErrno 缺失时走原 [non_zero_exit] 路径
 *
 * Mock 策略：vi.mock('node:child_process') 替换 spawn 返回 fake ChildProcess
 * （EventEmitter 风格），通过 emit('error'/'close') 驱动 wireChildLifecycle 完成。
 *参照 node-worker-driver.test.ts builtin mock 先例（builtin 模块非相对路径，
 *无需 __dirname 派生）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

// vi.hoisted 容器：vi.mock factory 提升到文件顶部执行，fakeSpawn 引用须走 hoisted（防 TDZ）
const hoisted = vi.hoisted(() => ({
  fakeSpawn: vi.fn(),
}));

// mock node:child_process 的 spawn，其余 API 保持真实
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: hoisted.fakeSpawn };
});

import { runShell } from '../bash-engine';
import { bashTool } from '../bash';
import { ChildProcessRegistry } from '../child-process-registry';
import type { ToolCtx } from '../types';

/**
 * 构造 fake ChildProcess（EventEmitter 风格，stdio pipe 挂 destroy mock）。
 * 用于 emit('error'/'close') 驱动 wireChildLifecycle 终局。
 */
function makeFakeChild(): ChildProcess {
  const stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 12345,
    killed: false,
    stdout,
    stderr,
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
  return child as unknown as ChildProcess;
}

beforeEach(() => {
  hoisted.fakeSpawn.mockReset();
});

describe('spawn errno 透出（A 段：ShellResult.spawnErrno）', () => {
  it('child error 携带 errno（EMFILE）→ spawnErrno=EMFILE + exitCode=1', async () => {
    const child = makeFakeChild();
    hoisted.fakeSpawn.mockReturnValue(child);

    const promise = runShell('test', '/tmp', 5000);
    // 触发 spawn error 事件，携带 errno code
    const err = Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' });
    child.emit('error', err);

    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.spawnErrno).toBe('EMFILE');
  });

  it('child error 无 code → spawnErrno=undefined（兼容旧路径）', async () => {
    const child = makeFakeChild();
    hoisted.fakeSpawn.mockReturnValue(child);

    const promise = runShell('test', '/tmp', 5000);
    child.emit('error', new Error('spawn failed without code'));

    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.spawnErrno).toBeUndefined();
  });

  it('正常 close 路径（code=0）→ spawnErrno=undefined', async () => {
    const child = makeFakeChild();
    hoisted.fakeSpawn.mockReturnValue(child);

    const promise = runShell('test', '/tmp', 5000);
    child.emit('close', 0);

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.spawnErrno).toBeUndefined();
  });
});

describe('bash.ts run：spawnErrno 文本透出', () => {
  function makeCtx(): ToolCtx {
    return {
      config: { tools: [], workdir: '/tmp' },
      workdir: '/tmp',
      childRegistry: new ChildProcessRegistry(),
    };
  }

  it('spawnErrno 存在 → 文本前置 [runtime_error] spawn XXX', async () => {
    const child = makeFakeChild();
    hoisted.fakeSpawn.mockReturnValue(child);

    const ctx = makeCtx();
    const promise = bashTool.run(
      { command: 'test', description: 'spawn errno test' },
      ctx,
    );

    const err = Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' });
    child.emit('error', err);

    const result = await promise;
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('[runtime_error] spawn EMFILE');
  });

  it('spawnErrno 缺失 → 走原 [non_zero_exit] 路径（文本含 exit code，无 RUNTIME_ERROR 前缀）', async () => {
    const child = makeFakeChild();
    hoisted.fakeSpawn.mockReturnValue(child);

    const ctx = makeCtx();
    const promise = bashTool.run(
      { command: 'test', description: 'no errno test' },
      ctx,
    );

    child.emit('error', new Error('spawn failed no code'));

    const result = await promise;
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('[non_zero_exit] exit code 1');
    expect(text).not.toContain('[runtime_error] spawn');
  });
});
