/**
 * ToolExecutionEngine worker pool 分流 UT（v0.0.307 T2）
 * 参考: specs/tech/version_logs/v0.0.307/change_plan.md B 组
 *       states/v0.0.307/task.json T2 acceptanceCriteria 5 条
 *
 * 覆盖：
 *   AC#1: 注入 fake workerPool → 白名单工具 submit 被调、readSetAdditions apply 进 config._readSet
 *   AC#2: 非白名单工具不 submit、走原 tool.run
 *   AC#3: workerPool undefined → 全部走原路径（向后兼容）
 *   AC#4: submit reject → [RUNTIME_ERROR] isError，execute 继续
 *   AC#5: 白名单工具超时仍走既有 backstop race
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolExecutionEngine, isWorkerableTool } from '../engine';
import { defaultTools } from '../registry';
import type { ToolCallBlock, ToolResultBlock } from '../../message/types';
import type { ToolSessionConfigLike } from '../types';
import type { WorkerPoolTask, WorkerPoolResult } from '../worker-pool/types';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-engine-wp-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 取 ToolResultBlock 的首个 text block 文本 */
function textOf(r: ToolResultBlock | undefined): string {
  if (!r || !r.content || r.content.length === 0) return '';
  const first = r.content[0];
  return first && typeof first === 'object' && first.type === 'text' ? first.text : '';
}

/** 构造最小 config（只含白名单 + 一个非白名单工具） */
function makeConfig(workdir: string): ToolSessionConfigLike {
  return {
    tools: defaultTools(),
    workdir,
  };
}

/** 构造 ToolCallBlock */
function makeCall(name: string, args: Record<string, unknown>): ToolCallBlock {
  return { type: 'tool_call', id: `call-${name}-${Date.now()}`, name, arguments: args };
}

/**
 * Fake worker pool：记录 submit 调用 + 可控返回值。
 * 用于验证 engine 分流逻辑（不跑真实 worker 线程）。
 */
function makeFakePool(
  submitImpl: (task: WorkerPoolTask) => Promise<WorkerPoolResult>,
): {
  pool: { submit: (t: WorkerPoolTask) => Promise<WorkerPoolResult> };
  calls: WorkerPoolTask[];
} {
  const calls: WorkerPoolTask[] = [];
  return {
    pool: {
      async submit(task: WorkerPoolTask): Promise<WorkerPoolResult> {
        calls.push(task);
        return submitImpl(task);
      },
    },
    calls,
  };
}

// ============================================================
// AC#1: 注入 fake workerPool → 白名单工具 submit 被调 + readSetAdditions apply
// ============================================================

describe('AC#1: 白名单工具走 worker pool', () => {
  it('read 工具 → submit 被调 + readSetAdditions apply 到 config._readSet', async () => {
    const testFile = join(tmpRoot, 'hello.txt');
    writeFileSync(testFile, 'hello world\n');

    const { pool, calls } = makeFakePool(async (task) => ({
      id: task.id,
      ok: true,
      content: [{ type: 'text' as const, text: 'fake worker read result' }],
      isError: false,
      readSetAdditions: [testFile],
    }));

    const engine = new ToolExecutionEngine(undefined, pool as never);
    const config = makeConfig(tmpRoot);
    const call = makeCall('read', { filePath: testFile });

    const { results } = await engine.execute(config, [call]);

    // submit 被调
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe('read');
    expect(calls[0]!.input).toEqual({ filePath: testFile });

    // readSetAdditions apply 到 config._readSet
    expect(config._readSet).toBeDefined();
    expect(config._readSet!.has(testFile)).toBe(true);

    // result 来自 fake pool（非真实 read）
    expect(textOf(results[0])).toBe('fake worker read result');
    expect(results[0]!.isError).toBe(false);
  });

  it('grep 工具也走 submit', async () => {
    const { pool, calls } = makeFakePool(async (task) => ({
      id: task.id,
      ok: true,
      content: [{ type: 'text' as const, text: 'fake grep' }],
      isError: false,
      readSetAdditions: [],
    }));

    const engine = new ToolExecutionEngine(undefined, pool as never);
    const config = makeConfig(tmpRoot);
    const call = makeCall('grep', { pattern: 'test', path: tmpRoot });

    await engine.execute(config, [call]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe('grep');
  });
});

// ============================================================
// AC#2: 非白名单工具不 submit、走原 tool.run
// ============================================================

describe('AC#2: 非白名单工具走原路径', () => {
  it('非白名单工具不调 submit', async () => {
    const { pool, calls } = makeFakePool(async () => ({
      id: '',
      ok: true,
      content: [],
      isError: false,
      readSetAdditions: [],
    }));

    const engine = new ToolExecutionEngine(undefined, pool as never);
    const config = makeConfig(tmpRoot);

    // 用 read（白名单）+ 另一个简单工具
    // 用 skill-manage 不太方便，改用 read + glob 组合验证：glob 白名单 submit，非白名单 tool 不 submit
    // bash 需要真实进程，用一个更简单的：skill-manage 是非白名单的纯逻辑工具
    // 但它需要 ctx.config.dataDir，这里简化：只验证白名单不误触
    // 验证策略：构造一个非白名单 tool name → resolveTool 返回 undefined → rejectToolCall（不 submit）
    const call = makeCall('memory', { action: 'list' });

    const { results } = await engine.execute(config, [call]);

    // memory 不在 allowedTools（不传 = 全集），但 memory 需要特殊 ctx
    // 这里验证的是：即使 pool 注入，非白名单也不 submit
    expect(calls).toHaveLength(0);
    // memory 是真实工具但可能因 ctx 缺字段而 isError
    expect(results[0]).toBeDefined();
  });

  it('混合批次：白名单 submit + 非白名单不 submit', async () => {
    const testFile = join(tmpRoot, 'mix.txt');
    writeFileSync(testFile, 'data\n');

    const { pool, calls } = makeFakePool(async (task) => ({
      id: task.id,
      ok: true,
      content: [{ type: 'text' as const, text: 'worker result' }],
      isError: false,
      readSetAdditions: task.toolName === 'read' ? [testFile] : [],
    }));

    const engine = new ToolExecutionEngine(undefined, pool as never);
    const config = makeConfig(tmpRoot);

    // read（白名单）→ submit；memory（非白名单）→ 不 submit
    const calls2: ToolCallBlock[] = [
      makeCall('read', { filePath: testFile }),
      makeCall('memory', { action: 'list' }),
    ];

    await engine.execute(config, calls2);

    // 只有 read 被 submit（memory 非白名单）
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe('read');
  });
});

// ============================================================
// AC#3: workerPool undefined → 全部走原路径（向后兼容）
// ============================================================

describe('AC#3: workerPool 未注入（向后兼容）', () => {
  it('undefined workerPool → read 走原 tool.run 路径', async () => {
    const testFile = join(tmpRoot, 'compat.txt');
    writeFileSync(testFile, 'original path\n');

    const engine = new ToolExecutionEngine(); // 无 workerPool
    const config = makeConfig(tmpRoot);
    const call = makeCall('read', { filePath: testFile });

    const { results } = await engine.execute(config, [call]);

    // 真实 read 结果（非 worker 返回）——应包含文件内容
    expect(results[0]!.isError).toBe(false);
    expect(textOf(results[0])).toContain('original path');
    // readSet 正常工作
    expect(config._readSet!.has(testFile)).toBe(true);
  });
});

// ============================================================
// AC#4: submit reject → [RUNTIME_ERROR] isError，execute 继续
// ============================================================

describe('AC#4: submit reject 处理', () => {
  it('worker submit reject → [RUNTIME_ERROR] + execute 继续后续工具', async () => {
    const nextFile = join(tmpRoot, 'next.txt');
    writeFileSync(nextFile, 'survives\n');

    // 第一个 submit reject，第二个 submit 正常返回
    let callCount = 0;
    const { pool } = makeFakePool(async (task) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('worker crashed');
      }
      return {
        id: task.id,
        ok: true,
        content: [{ type: 'text' as const, text: 'recovered' }],
        isError: false,
        readSetAdditions: [],
      };
    });

    const engine = new ToolExecutionEngine(undefined, pool as never);
    const config = makeConfig(tmpRoot);

    const batch: ToolCallBlock[] = [
      makeCall('read', { filePath: join(tmpRoot, 'crash.txt') }),
      makeCall('read', { filePath: nextFile }),
    ];

    const { results } = await engine.execute(config, batch);

    // 第一个 → [RUNTIME_ERROR]
    expect(results[0]!.isError).toBe(true);
    expect(textOf(results[0])).toContain('[runtime_error]');
    expect(textOf(results[0])).toContain('worker crashed');

    // 第二个 → 正常（execute 不中断）
    expect(results[1]!.isError).toBe(false);
    expect(textOf(results[1])).toBe('recovered');
  });
});

// ============================================================
// AC#5: 白名单工具超时仍走既有 backstop race
// ============================================================

describe('AC#5: 白名单工具超时 race', () => {
  it('worker submit 超时 → 产 [timeout] 前缀 isError result', async () => {
    // submit 永不 resolve（模拟 worker 卡住）
    const { pool } = makeFakePool(
      () => new Promise<WorkerPoolResult>(() => {}), // 永不 resolve
    );

    const engine = new ToolExecutionEngine(undefined, pool as never);
    const config = makeConfig(tmpRoot);
    // timeout=1ms → effective 1ms + GRACE 5000ms = backstop 5001ms
    // 但 TIMEOUT_GRACE_MS 是 5000，总 backstop 太长。
    // 用 read 工具（defaultTimeoutMs=10000），per-call timeout 覆盖为 1ms → backstop=5001ms
    const call = makeCall('read', { filePath: join(tmpRoot, 'timeout.txt'), timeout: 1 });

    const { results } = await engine.execute(config, [call]);

    // 超时 → [timeout] 前缀
    expect(results[0]!.isError).toBe(true);
    expect(textOf(results[0])).toContain('[timeout]');
  }, 15000); // 给 15s testTimeout（backstop ≈ 5s + 余量）
});

// ============================================================
// 补充：isWorkerableTool 单元
// ============================================================

describe('isWorkerableTool', () => {
  it('白名单工具返回 true', () => {
    expect(isWorkerableTool('read')).toBe(true);
    expect(isWorkerableTool('write')).toBe(true);
    expect(isWorkerableTool('edit')).toBe(true);
    expect(isWorkerableTool('glob')).toBe(true);
    expect(isWorkerableTool('grep')).toBe(true);
  });

  it('非白名单工具返回 false', () => {
    expect(isWorkerableTool('bash')).toBe(false);
    expect(isWorkerableTool('memory')).toBe(false);
    expect(isWorkerableTool('web_search')).toBe(false);
    expect(isWorkerableTool('browser')).toBe(false);
    expect(isWorkerableTool('skill')).toBe(false); // skill 依赖 config.skills，不可序列化进 worker
    expect(isWorkerableTool('unknown_tool')).toBe(false);
  });
});

// ============================================================
// v0.0.309: readSet 跨线程传递 — fake pool 验证 submit 传参 + 真实 pool read→edit 链路
// ============================================================

describe('v0.0.309: readSet 快照跨线程传递', () => {
  it('fake pool submit task 中含 readSet 字段（验证快照传入）', async () => {
    const testFile = join(tmpRoot, 'snap.txt');
    writeFileSync(testFile, 'snap content\n');

    const { pool, calls } = makeFakePool(async (task) => ({
      id: task.id,
      ok: true,
      content: [{ type: 'text' as const, text: 'ok' }],
      isError: false,
      readSetAdditions: [testFile],
    }));

    const engine = new ToolExecutionEngine(undefined, pool as never);
    const config = makeConfig(tmpRoot);

    // 先 read 让 config._readSet 有值
    await engine.execute(config, [makeCall('read', { filePath: testFile })]);

    // 第一次 submit 的 task 必须含 readSet 字段（初始为空数组）
    expect(calls[0]!.readSet).toEqual([]);

    // 再 read 一次——此时 config._readSet 已有 testFile
    await engine.execute(config, [makeCall('read', { filePath: testFile })]);

    // 第二次 submit 的 task readSet 应含 testFile（主线程快照传入）
    expect(calls[1]!.readSet).toContain(testFile);
  });

  it('真实 ToolWorkerPool read→edit 同一文件不报 [not_read]（核心 bug 复现路径）', async () => {
    // 动态 import 避免影响其他 test case（真实 pool 会 spawn worker 线程）
    const { ToolWorkerPool } = await import('../worker-pool/pool');

    const testFile = join(tmpRoot, 'read-edit.txt');
    writeFileSync(testFile, 'line1\nline2\n');

    const pool = new ToolWorkerPool({ maxWorkers: 1 });
    const engine = new ToolExecutionEngine(undefined, pool as never);
    const config = makeConfig(tmpRoot);

    try {
      // step1: read（走真实 worker → readSetAdditions 回传 → config._readSet apply）
      const { results: readResults } = await engine.execute(config, [
        makeCall('read', { filePath: testFile }),
      ]);
      expect(readResults[0]!.isError).toBe(false);
      expect(config._readSet!.has(testFile)).toBe(true);

      // step2: edit 同一文件（走真实 worker，此时 submit 应传入含 testFile 的 readSet 快照）
      const { results: editResults } = await engine.execute(config, [
        makeCall('edit', {
          filePath: testFile,
          oldString: 'line1',
          newString: 'LINE1',
        }),
      ]);

      // 核心：edit 不应报 [not_read]（v0.0.309 bug 的复现验证）
      expect(editResults[0]!.isError).toBe(false);
      const editText = textOf(editResults[0]);
      expect(editText).not.toContain('[not_read]');

      // 验证文件确实被修改
      expect(readFileSync(testFile, 'utf-8')).toContain('LINE1');
    } finally {
      pool.close();
    }
  }, 15000);
});
