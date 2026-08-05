/**
 * bash-engine 子进程组杀 UT（v0.0.130.hang 模块 B-1）
 * 参考: specs/tech/version_logs/v0.0.130.hang/change_plan.md 模块 B-1
 *
 * 覆盖：
 *   1. killProcessGroup — 负 pid 组杀 / ESRCH fallback / 无 pid 或已 killed 短路 / 全 catch 不抛
 *   2. 真 spawn 集成：孙进程持 pipe 场景（`sh -c 'sleep N | cat'`）超时后
 *      —— close 触发（exec 在 timeout 附近 resolve，修复前会一直 hang 到真实进程退出）
 *      —— timedOut=true + 统一超时文案（`[timeout] bash exceeded`）
 *      —— 进程组已全灭（无孤儿孙进程，pgrep 有界轮询验证）
 *   3. abort 场景：ctx.signal 中途 abort → 进程组死 + exec resolve
 *   4. registry 挂载：exec 后 registry.size 归零（close/error 均 unregister）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { killProcessGroup, runShell, getBashEngine } from '../bash-engine';
import { bashTool } from '../bash';
import { ChildProcessRegistry } from '../child-process-registry';
import type { ToolCtx } from '../types';

/** 假 ChildProcess：只覆盖 killProcessGroup 用到的字段 */
function fakeChild(pid: number | undefined, killed = false): ChildProcess {
  return {
    pid,
    killed,
    kill: vi.fn(() => true),
  } as unknown as ChildProcess;
}

/** 用 pgrep -f 探测宿主机上是否还有匹配 marker 的进程（无匹配时 pgrep 非零退出） */
function markerAlive(marker: string): boolean {
  try {
    execSync(`pgrep -f ${JSON.stringify(marker)}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** 有界轮询直到 predicate 为真或超时（禁固定长 sleep 等结果） */
async function waitUntil(predicate: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

// 每个 marker 用 Date.now() 派生的唯一小数秒，避免与宿主机上无关 sleep 进程 / 并发测试碰撞
function uniqueMarker(prefix: string): string {
  return `${prefix}.${Date.now() % 100000}`;
}

describe('killProcessGroup（负 pid 组杀 + ESRCH fallback，白盒 mock）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('无 pid（spawn 失败）→ 直接返回，不调用 process.kill', () => {
    const killSpy = vi.spyOn(process, 'kill');
    const child = fakeChild(undefined);
    expect(() => killProcessGroup(child, 'SIGTERM')).not.toThrow();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('已 killed → 直接返回，不调用 process.kill', () => {
    const killSpy = vi.spyOn(process, 'kill');
    const child = fakeChild(12345, true);
    killProcessGroup(child, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('正常路径：用负 pid 调用 process.kill(-pid, sig)（组杀整个进程组）', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = fakeChild(54321);
    killProcessGroup(child, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(-54321, 'SIGKILL');
  });

  it('组杀失败（ESRCH，进程组已不存在）→ fallback child.kill(sig)，不抛错', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    const child = fakeChild(9999);
    expect(() => killProcessGroup(child, 'SIGTERM')).not.toThrow();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('组杀 + fallback 均失败 → 全 catch 不抛错', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('boom');
    });
    const child = fakeChild(8888);
    (child.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('boom2');
    });
    expect(() => killProcessGroup(child, 'SIGKILL')).not.toThrow();
  });
});

describe('真 spawn 集成：孙进程持 pipe 场景（sh -c "sleep N | cat"）', () => {
  const cleanupMarkers: string[] = [];

  afterEach(() => {
    // 兜底清理：测试失败时避免残留孤儿进程（精确 marker，非宽匹配 pkill）
    for (const marker of cleanupMarkers) {
      try {
        execSync(`pkill -f ${JSON.stringify(marker)}`, { stdio: 'pipe' });
      } catch {
        /* 已死或无匹配，忽略 */
      }
    }
    cleanupMarkers.length = 0;
  });

  it('bash 工具跑超时命令 → 在 timeout 附近 resolve（不 hang 到真实进程退出）+ timedOut 文案 + 无孤儿', async () => {
    const marker = uniqueMarker('30');
    cleanupMarkers.push(marker);
    const registry = new ChildProcessRegistry();
    const ctx: ToolCtx = {
      config: { tools: [], workdir: '/tmp' },
      workdir: '/tmp',
      childRegistry: registry,
    };

    const start = Date.now();
    const result = await bashTool.run(
      {
        command: `sh -c 'sleep ${marker} | cat'`,
        description: 'grandchild pipe timeout test',
        timeout: 1200,
      },
      ctx,
    );
    const elapsed = Date.now() - start;

    // (a) 在 timeout 附近 resolve——修复前孙进程持 pipe 会让 close 永不触发，
    // 这里断言远小于 sleep 的真实时长（30s 量级），证明 close 确实被触发
    expect(elapsed).toBeLessThan(8000);

    // (b) timedOut=true → isError
    expect(result.isError).toBe(true);

    // (c) 结果文本以统一超时文案开头（drift 裁决①）
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/^\[timeout\] bash exceeded 1200ms/);

    // (d) 孙进程组已死（有界轮询 pgrep，验证无孤儿残留）
    const dead = await waitUntil(() => !markerAlive(`sleep ${marker}`));
    expect(dead).toBe(true);

    // registry 挂载：close 触发 unregister，size 归零
    expect(registry.size).toBe(0);
  }, 15000);
});

describe('abort 场景：ctx.signal 中途 abort → 进程组死 + exec resolve', () => {
  const cleanupMarkers: string[] = [];

  afterEach(() => {
    for (const marker of cleanupMarkers) {
      try {
        execSync(`pkill -f ${JSON.stringify(marker)}`, { stdio: 'pipe' });
      } catch {
        /* 已死或无匹配 */
      }
    }
    cleanupMarkers.length = 0;
  });

  it('runShell 收到外部 abort signal → 组杀孙进程 + resolve（timedOut=true）', async () => {
    const marker = uniqueMarker('31');
    cleanupMarkers.push(marker);
    const registry = new ChildProcessRegistry();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);

    const start = Date.now();
    const result = await runShell(`sh -c 'sleep ${marker} | cat'`, '/tmp', 30000, ctrl.signal, registry);
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    // abort 触发后应很快 resolve（远小于 30000ms 的完整 sleep 时长）
    expect(elapsed).toBeLessThan(3000);

    const dead = await waitUntil(() => !markerAlive(`sleep ${marker}`));
    expect(dead).toBe(true);
    expect(registry.size).toBe(0);
  }, 10000);
});

describe('registry 挂载：正常退出路径也 unregister（非仅超时/abort）', () => {
  it('SecureBashEngine.exec 正常执行完成后 registry.size 归零', async () => {
    const registry = new ChildProcessRegistry();
    const result = await getBashEngine().exec('echo group-kill-mount-test', {
      cwd: '/tmp',
      timeoutMs: 5000,
      childRegistry: registry,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(registry.size).toBe(0);
  }, 10000);
});
