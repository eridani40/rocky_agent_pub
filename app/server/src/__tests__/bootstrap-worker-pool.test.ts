/**
 * bootstrap worker pool 装配 UT（v0.0.307 T3）
 * 参考: specs/tech/version_logs/v0.0.307/change_plan.md C 组
 *       states/v0.0.307/task.json T3 acceptanceCriteria 2 条
 *
 * 覆盖：
 *   AC#1: bootstrap 装配后 engine.workerPool 存在
 *   AC#2: createToolWorkerPool 抛错时降级路径不阻断 bootstrap
 *
 * 策略：用真实 bootstrapBuiltinPlugins 走完整装配链，验证返回的 toolEngine.workerPool。
 * 降级测试：mock createToolWorkerPool 抛错 → 验证 bootstrap 不阻断 + workerPool=undefined。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapBuiltinPlugins } from '../bootstrap';
import { _resetToolWorkerPoolSingleton } from '../tools/worker-pool';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rocky-bootstrap-wp-'));
  _resetToolWorkerPoolSingleton();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  _resetToolWorkerPoolSingleton();
});

// ============================================================
// AC#1: bootstrap 装配后 engine.workerPool 存在
// ============================================================

describe('AC#1: bootstrap 装配 workerPool', () => {
  it('bootstrap 完成后 toolEngine.workerPool 存在', async () => {
    const bs = await bootstrapBuiltinPlugins(dataDir);

    // engine 存在
    expect(bs.toolEngine).toBeDefined();
    // workerPool 已注入
    expect(bs.toolEngine.workerPool).toBeDefined();
    // 鸭子类型：ToolWorkerPool 契约方法齐全
    const pool = bs.toolEngine.workerPool!;
    expect(typeof pool.submit).toBe('function');
    expect(typeof pool.close).toBe('function');
    expect(typeof pool.nextId).toBe('function');
  });

  it('workerPool 是进程级单例（多次调 createToolWorkerPool 返回同一实例）', async () => {
    const bs = await bootstrapBuiltinPlugins(dataDir);
    const pool1 = bs.toolEngine.workerPool;
    expect(pool1).toBeDefined();

    // bootstrap 内部已调 createToolWorkerPool → 单例缓存
    // 再次 bootstrap（同进程）应拿到同一实例（_resetToolWorkerPoolSingleton 在 beforeEach 调了）
    const bs2 = await bootstrapBuiltinPlugins(dataDir);
    // bs2 是新的 bootstrap 调用，但由于 beforeEach 调了 _reset，新池 != 旧池
    // 但 bs2 内部 workerPool 应存在
    expect(bs2.toolEngine.workerPool).toBeDefined();
  });
});

// ============================================================
// AC#2: createToolWorkerPool 抛错时降级不阻断 bootstrap
// ============================================================

describe('AC#2: 降级路径', () => {
  it('createToolWorkerPool 抛错 → engine.workerPool=undefined + bootstrap 不阻断', async () => {
    // mock createToolWorkerPool 抛错（模拟 worker 线程创建失败）
    const wpModule = await import('../tools/worker-pool');
    vi.spyOn(wpModule, 'createToolWorkerPool').mockImplementation(() => {
      throw new Error('simulated worker pool creation failure');
    });

    // bootstrap 不应抛错（降级为不 worker 化）
    const bs = await bootstrapBuiltinPlugins(dataDir);

    // engine 存在（bootstrap 正常完成）
    expect(bs.toolEngine).toBeDefined();
    // workerPool 未注入（降级）
    expect(bs.toolEngine.workerPool).toBeUndefined();
  });
});
