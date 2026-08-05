/**
 * ChildProcessRegistry 单测（白盒）
 * 参考: specs/tech/version_logs/v0.0.130.hang/change_plan.md 模块 B-2
 *
 * 覆盖：
 *   1. register/unregister 幂等 + 无 pid（spawn 失败）容错
 *   2. killAll 全 catch（ESRCH 容错）+ 单个失败不阻断其余 + 幂等（二次调用无害）
 *   3. killAll 真杀验证：真实 spawn detached 进程组（含孙进程 `sh -c 'sleep 30 | cat'`），
 *      有界轮询验证整组已死、无孤儿（禁固定长 sleep）
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { ChildProcessRegistry } from '../child-process-registry';

/** 假 ChildProcess：模拟 spawn 失败（无 pid）等边界场景 */
function fakeChild(pid: number | undefined): ChildProcess {
  return {
    pid,
    killed: false,
    kill: () => true,
  } as unknown as ChildProcess;
}

/** 探测某 pid 是否存活（signal 0 不发信号只探测，ESRCH=已死） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 有界轮询直到 predicate 为真或超时，避免固定长 sleep（见 memory: 禁固定 sleep 等结果） */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

describe('ChildProcessRegistry', () => {
  // 本文件真实 spawn 出的 pid，afterEach 兜底精确清理（不用 pkill 宽匹配，防误杀其他进程）
  const spawnedPids: number[] = [];

  afterEach(() => {
    for (const pid of spawnedPids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* 已死或组已清理 */
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* 已死 */
      }
    }
    spawnedPids.length = 0;
  });

  describe('register/unregister', () => {
    it('register 记录 pid，size 增加', () => {
      const registry = new ChildProcessRegistry();
      registry.register(fakeChild(11111));
      expect(registry.size).toBe(1);
    });

    it('register 无 pid（spawn 失败）容错跳过，不抛错', () => {
      const registry = new ChildProcessRegistry();
      expect(() => registry.register(fakeChild(undefined))).not.toThrow();
      expect(registry.size).toBe(0);
    });

    it('unregister 幂等：重复调用/不存在的 pid/null/undefined 均不报错', () => {
      const registry = new ChildProcessRegistry();
      registry.register(fakeChild(22222));
      registry.unregister(22222);
      expect(registry.size).toBe(0);
      expect(() => registry.unregister(22222)).not.toThrow();
      expect(() => registry.unregister(99999)).not.toThrow();
      expect(() => registry.unregister(null)).not.toThrow();
      expect(() => registry.unregister(undefined)).not.toThrow();
    });
  });

  describe('killAll 容错 + 幂等（mock process.kill）', () => {
    it('ESRCH（进程已退出）容错，不抛错', async () => {
      const registry = new ChildProcessRegistry();
      registry.register(fakeChild(33333));
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      });
      try {
        await expect(registry.killAll()).resolves.toBeUndefined();
      } finally {
        killSpy.mockRestore();
      }
    });

    it('单个失败不阻断其余：混合成功/失败仍处理完全部登记项', async () => {
      const registry = new ChildProcessRegistry();
      registry.register(fakeChild(44444));
      registry.register(fakeChild(55555));
      const calledPids: number[] = [];
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
        calledPids.push(pid);
        if (pid === -44444) throw new Error('boom');
        return true;
      }) as typeof process.kill);
      try {
        await registry.killAll();
        expect(calledPids).toContain(-44444);
        expect(calledPids).toContain(-55555);
      } finally {
        killSpy.mockRestore();
      }
    });

    it('killAll 后 size 归零；二次调用无害（幂等）', async () => {
      const registry = new ChildProcessRegistry();
      registry.register(fakeChild(66666));
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        await registry.killAll();
        expect(registry.size).toBe(0);
        await expect(registry.killAll()).resolves.toBeUndefined();
        expect(registry.size).toBe(0);
      } finally {
        killSpy.mockRestore();
      }
    });
  });

  describe('killAll 真杀验证（真实 spawn detached 进程组）', () => {
    it('杀掉简单 sleep 进程', async () => {
      const registry = new ChildProcessRegistry();
      const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
      expect(child.pid).toBeDefined();
      const pid = child.pid!;
      spawnedPids.push(pid);
      registry.register(child);

      expect(isAlive(pid)).toBe(true);
      await registry.killAll();

      const dead = await waitUntil(() => !isAlive(pid));
      expect(dead).toBe(true);
    }, 10000);

    it('杀掉含孙进程的进程组（sh -c "sleep 30 | cat"），无孤儿残留', async () => {
      const registry = new ChildProcessRegistry();
      const child = spawn('sh', ['-c', 'sleep 30 | cat'], { detached: true, stdio: 'ignore' });
      expect(child.pid).toBeDefined();
      const pid = child.pid!;
      spawnedPids.push(pid);
      registry.register(child);

      // 等孙进程（sh fork sleep/cat）真正起来，避免过早 killAll 打空
      await waitUntil(() => isAlive(pid), 2000, 20);

      await registry.killAll();

      // 有界轮询整个进程组已清空（负 pgid 探测：ESRCH = 组内已无存活进程）
      const groupDead = await waitUntil(() => {
        try {
          process.kill(-pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      expect(groupDead).toBe(true);
      expect(isAlive(pid)).toBe(false);
    }, 10000);
  });
});
