/**
 * SessionWorkspaceManager F2 单元测试 —— chokidar ready 竞态 + manager 端到端 await-ready 语义
 * 参考: specs/tech/agent/session/[P0]session_workspace_manager.md §3.1/§6/§7
 *       specs/tech/version_logs/v0.0.139/change_plan.md 模块1/模块5
 *
 * [v0.0.139 适配] 本文件原覆盖「addDir listener → watcher.add 自动递归子目录」（F2 BUG-006
 * 修复）——v0.0.139 懒监听重构**显式禁止**该行为（红线①：MUST NOT 注册 addDir→watcher.add，
 * 否则退化回递归、re-introduce 扫描风暴）。该测试已删除，反向断言（新建子目录不自动被递归
 * 监听）改由 workspace-dir-watcher.test.ts「运行时新建子目录不自动被递归监听」覆盖。
 *
 * waitForChokidarReady 的 once(ready)/超时 resolve 基础断言已迁至
 * workspace-dir-watcher.test.ts（该函数现从那里 export，非本文件）；本文件只保留其
 * 「ready 与超时竞争」唯一未被覆盖的时序断言 + manager 端到端 watch() await-ready 集成验证。
 *
 * 文件系统隔离：os.tmpdir + mkdtempSync + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { ReplayableEventBus } from '../event-bus';
import { EventHub } from '../event-hub';
import { SessionWorkspaceManager } from '../session-workspace-manager';
import { waitForChokidarReady } from '../workspace-dir-watcher';
import { collectEvents, waitForFileEvent } from '../__helpers__/workspace-test-helpers';

let statusBus: ReplayableEventBus;
let manager: SessionWorkspaceManager;
let tmpRoot: string;

beforeEach(() => {
  EventHub.resetForTest();
  statusBus = new ReplayableEventBus({ replayable: false });
  manager = new SessionWorkspaceManager({ statusBus });
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-wsm-f2-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 1. waitForChokidarReady：ready 与超时竞争（唯一未被 dir-watcher.test.ts 覆盖的断言） ----------

describe('waitForChokidarReady — ready 与超时竞争：先到的生效', () => {
  it('done 标记防双 resolve：ready 先触发后，二次 emit + 超时均不再重复 resolve', async () => {
    const ee = new EventEmitter();
    let resolvedCount = 0;
    const p = waitForChokidarReady(ee as unknown as { once(event: string, cb: () => void): unknown }, 200);
    p.then(() => { resolvedCount++; });
    ee.emit('ready'); // 同步 emit
    await sleep(20);
    expect(resolvedCount).toBe(1);
    ee.emit('ready'); // 二次 emit（once 已消费，仅防御性验证不影响计数）
    await sleep(220); // 超时窗口过去，不应二次 resolve
    expect(resolvedCount).toBe(1);
  });
});

// ---------- 2. manager.watch() 端到端 await-ready（懒监听 acquire 完整链路） ----------

describe('SessionWorkspaceManager.watch — 端到端 await chokidar ready', () => {
  it(
    'watch() resolve 后立即写文件 → 事件被捕获（不落在 ignoreInitial 扫描窗口）',
    { retry: 2, timeout: 10000 },
    async () => {
      const sid = '01TESTF200000000000000000001';
      const dir = resolve(tmpRoot, 'ws', sid);
      mkdirSync(dir, { recursive: true });
      const col = collectEvents(sid, statusBus);

      await manager.watch(sid, 'c1', dir, ''); // 内部 await dir-watcher ready → resolve 后立即写不丢
      writeFileSync(join(dir, 'immediate.txt'), 'x');
      // 内层 poll 上限 8000 + 外层 it() 超时 10000（默认各 2000/5000）：本用例故意零 warm-up
      // 立即写，是对 ready-window 边界的最紧张测试，全量 suite 高并发 CPU 争用下 chokidar
      // emit 时序可能被拉伸——bounded poll 到期前先给外层足够窗口；仍偶发 flaky 时 vitest
      // retry:2（v0.0.158 加）自动重跑，避免全量并发下的偶发争用触发假 fail（单跑 100% 通过）。
      await waitForFileEvent(
        col,
        (e) => e.type === 'session_workspace_file_changed' && e.data.path === 'immediate.txt',
        8000,
      );

      col.sub.cancel();
      const fileEvents = (col.events as { type: string; data: { path: string; kind: string } }[])
        .filter((e) => e.type === 'session_workspace_file_changed');
      expect(fileEvents.length).toBeGreaterThanOrEqual(1);
      const last = fileEvents[fileEvents.length - 1]!;
      expect(last.data.path).toBe('immediate.txt');
      expect(last.data.kind).toBe('add');
    },
  );

  it('watch() 在物理 watcher ready 前不 resolve（await 阻塞至真正就绪，非靠超时兜底）', async () => {
    const sid = '01TESTF200000000000000000002';
    const dir = resolve(tmpRoot, 'ws', sid);
    mkdirSync(dir, { recursive: true });

    const t0 = Date.now();
    await manager.watch(sid, 'c1', dir, '');
    const elapsed = Date.now() - t0;
    // 5s 超时兜底远大于小目录 ready 时间；elapsed 应远小于超时窗口（验 ready 正常触发而非靠超时）
    expect(elapsed).toBeLessThan(2000);
    const status = manager.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]?.sessionId).toBe(sid);
    expect(status[0]?.ready).toBe(true);
  });
});

// ---------- 3. SseChannel.setSubscribeHooks async + await（lazy 时序，与 manager 无强耦合但同链路） ----------

describe('SseChannel — setSubscribeHooks async + await 时序', () => {
  it('onSubscribe 改 async 后 subscribe 内部 await（hook 完成后才返）', async () => {
    const { SseChannel } = await import('../../sse/sse-channel');
    const channel = new SseChannel(EventHub.singleton());

    let hookResolved = false;
    let resolveHook: () => void;
    const hookDone = new Promise<void>((r) => { resolveHook = r; });
    const callOrder: string[] = [];

    channel.setSubscribeHooks({
      onSubscribe: async () => {
        callOrder.push('hook-start');
        await hookDone;
        callOrder.push('hook-end');
        hookResolved = true;
      },
    });

    const subPromise = channel.subscribe('session_panel', 'session_id:01TESTF2HOOK0000000000001');
    await sleep(5);
    expect(hookResolved).toBe(false);
    callOrder.push('after-subscribe-await-sleep');

    resolveHook!();
    await subPromise;
    callOrder.push('sub-promise-resolved');

    expect(hookResolved).toBe(true);
    expect(callOrder.indexOf('hook-start')).toBeLessThan(callOrder.indexOf('sub-promise-resolved'));
    expect(callOrder.indexOf('after-subscribe-await-sleep')).toBeLessThan(callOrder.indexOf('hook-end'));
  });

  it('hook 抛错不影响订阅本身（subs Map 已登记，try/catch 兜底）', async () => {
    const { SseChannel } = await import('../../sse/sse-channel');
    const channel = new SseChannel(EventHub.singleton());

    channel.setSubscribeHooks({
      onSubscribe: async () => {
        throw new Error('hook boom');
      },
    });

    await expect(
      channel.subscribe('session_panel', 'session_id:01TESTF2HOOK0000000000004'),
    ).resolves.toBeUndefined();
    expect(channel.activeSubscriptionCount()).toBe(1);
  });

  it('lazy 兜底链路集成：onUnsubscribe(1→0) → await manager.recycleSession 完成后才返', async () => {
    // 模拟 bootstrap.ts 真实链路（manager §6②兜底）：SseChannel.unsubscribe →
    // onUnsubscribe hook → SessionWorkspaceManager.recycleSession（awaits 串行 close）
    const { SseChannel } = await import('../../sse/sse-channel');
    const channel = new SseChannel(EventHub.singleton());
    const wm = new SessionWorkspaceManager({ statusBus });

    const sid = '01TESTF2LAZY000000000000005';
    const dir = resolve(tmpRoot, 'wmlazy', sid);
    mkdirSync(dir, { recursive: true });

    // 前置：先建立一个物理监听（模拟前端已 watch 根）
    await wm.watch(sid, 'c1', dir, '');
    expect(wm.getStatus()).toHaveLength(1);

    channel.setSubscribeHooks({
      onUnsubscribe: async (topic, group) => {
        if (topic !== 'session_panel') return;
        const sidFromGroup = group.split(':')[1];
        if (!sidFromGroup) return;
        await wm.recycleSession(sidFromGroup);
      },
    });

    await channel.subscribe('session_panel', `session_id:${sid}`);
    await channel.unsubscribe('session_panel', `session_id:${sid}`);

    // unsubscribe 返回时 recycleSession 已完成（await 时序保证）→ 无泄漏
    expect(wm.getStatus()).toHaveLength(0);

    await wm.stopAll();
  });
});
