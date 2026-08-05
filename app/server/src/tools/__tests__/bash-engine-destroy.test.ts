/**
 * bash-engine wireChildLifecycle 句柄回收 UT（v0.0.236 C 段）
 * 参考: specs/tech/version_logs/v0.0.236/change_plan.md C 段
 *       states/v0.0.236/research-2.md §排查 2（escaped-grandchild pipe +2/run 铁证）
 *
 * 覆盖：
 *   1. escaped-grandchild（close 永不触发）→ timer SIGKILL 兜底后调 reclaimStreams
 *      （stdout.destroy + stderr.destroy 被调 + child.unref 被调）
 *   2. destroy 抛错（流已销毁场景）→ reclaimStreams try/catch 兜住，不传染外层
 *   3. 正常 close 路径（close 自然触发）→ 不调 reclaimStreams
 *
 * Mock 策略：vi.mock('node:child_process') 替换 spawn；fake child 不 emit close
 * （模拟 escaped-grandchild 持写端）；用小 timeoutMs（50ms）+ 等 800ms 触发 SIGKILL
 * 兜底路径（50 + 500 = 550ms）。参照 node-worker-driver.test.ts builtin mock 先例。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const hoisted = vi.hoisted(() => ({
  fakeSpawn: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: hoisted.fakeSpawn };
});

import { runShell } from '../bash-engine';

/**
 * fake ChildProcess 类型：stdout/stderr 非 null（ChildProcess.stdout: Readable|null，
 * 测试中恒设），便于直接断言 destroy；其余字段对齐 wireChildLifecycle 用到的子集。
 */
interface FakeChild {
  pid: number;
  killed: boolean;
  stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  on: EventEmitter['on'];
  emit: EventEmitter['emit'];
}

/** 构造 fake ChildProcess（EventEmitter 风格 + stdio destroy mock + kill/unref mock） */
function makeFakeChild(): FakeChild {
  const stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 999999, // 不存在的 pgid，killProcessGroup 内 catch 兜底（不会真杀进程）
    killed: false,
    stdout,
    stderr,
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
  return child as unknown as FakeChild;
}

beforeEach(() => {
  hoisted.fakeSpawn.mockReset();
  // killProcessGroup 调 process.kill(-pid, sig)：spy 成 true 避免 ESRCH 噪音（不影响 reclaimStreams 断言）
  vi.spyOn(process, 'kill').mockImplementation(() => true);
});

describe('wireChildLifecycle 句柄回收（C 段）', () => {
  it('escaped-grandchild（close 永不触发）→ SIGKILL 兜底后调 stdout/stderr.destroy + child.unref', async () => {
    const child = makeFakeChild();
    hoisted.fakeSpawn.mockReturnValue(child);

    const promise = runShell('test', '/tmp', 50); // 50ms timeout
    // 等到 SIGKILL 兜底（50ms timeout + 500ms 优雅窗口 = 550ms）
    await new Promise((r) => setTimeout(r, 800));

    // 验证 reclaimStreams 调 destroy + unref 兜底
    expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
    expect(child.stderr.destroy).toHaveBeenCalledTimes(1);
    expect(child.unref).toHaveBeenCalledTimes(1);

    // 触发 close 让 promise resolve（模拟 destroy 后 stdio 关闭触发 close，证明不 hang）
    child.emit('close', 1);
    const result = await promise;
    expect(result.timedOut).toBe(true);
  });

  it('destroy 抛错（流已销毁）→ reclaimStreams try/catch 兜住，不传染外层', async () => {
    const child = makeFakeChild();
    (child.stdout.destroy as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('ERR_STREAM_DESTROYED');
    });
    (child.stderr.destroy as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('ERR_STREAM_DESTROYED');
    });
    hoisted.fakeSpawn.mockReturnValue(child);

    const promise = runShell('test', '/tmp', 50);
    // 若 reclaimStreams 未 try/catch，destroy 抛错会传染到 timer 回调；
    // 这里能跑到 expect 本身就证明 try/catch 兜住了（unhandled error 会让测试崩）
    await new Promise((r) => setTimeout(r, 800));

    expect(child.stdout.destroy).toHaveBeenCalled();

    child.emit('close', 1);
    const result = await promise;
    expect(result.timedOut).toBe(true);
  });

  it('正常 close 路径（close 自然触发）→ 不调 reclaimStreams', async () => {
    const child = makeFakeChild();
    hoisted.fakeSpawn.mockReturnValue(child);

    const promise = runShell('test', '/tmp', 5000); // 长超时，不进 SIGKILL 兜底
    child.emit('close', 0); // 立即正常退出 → finish 清掉 timer

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    // close 正常路径不调 reclaimStreams（防丢最后字节输出）
    expect(child.stdout.destroy).not.toHaveBeenCalled();
    expect(child.stderr.destroy).not.toHaveBeenCalled();
    expect(child.unref).not.toHaveBeenCalled();
  });
});
