/**
 * ReminderQueueStore UT — write/drain/clearAll + 锁序 + 原子写 + 路径。
 * 参考: specs/tech/version_logs/v0.0.361/change_plan.md §1.2（queue 设计）
 *       states/v0.0.361/task.json T1（acceptanceCriteria：queue 有序/同 key 去重/锁序/drain 清空/原子写）
 *
 * 覆盖：
 *   - write 新增 + 同 key 删旧追队尾（有序队列语义：最新变化总在队尾）
 *   - drain 按队列顺序读 value + 清空（「只记变化」）
 *   - clearAll 清空（full 模式；幂等）
 *   - 锁序：并发 write/drain 串行（per-sid Promise mutex）
 *   - 原子写（tmp+fsync+rename；.tmp 不残留）
 *   - 路径 {fsRoot}/sessions/{sid}/reminder_queue.json（packaged cwd=/ 护栏）
 *   - schema 异常降级空队列（防半损坏文件阻断注入链）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReminderQueueStore } from '../system-reminder-queue';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'reminder-queue-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function mkStore(): ReminderQueueStore {
  return new ReminderQueueStore({ fsRoot: tmpRoot });
}

function queueJsonPath(sessionId: string): string {
  return join(tmpRoot, 'sessions', sessionId, 'reminder_queue.json');
}

// ── 用例 ─────────────────────────────────────────────────────────────

describe('ReminderQueueStore — write', () => {
  it('write 新增条目（无文件 → 建文件；entries 追加队尾）', async () => {
    const store = mkStore();
    await store.write('sess-a', 'todo:T1', 'T1 进行中');

    const { readJsonFileSync } = await import('../../persistence/fs-io');
    const file = readJsonFileSync<{ version: number; sessionId: string; entries: Array<{ key: string; value: string; recordedAt: string }> }>(queueJsonPath('sess-a'));
    expect(file).toBeDefined();
    expect(file!.version).toBe(1);
    expect(file!.sessionId).toBe('sess-a');
    expect(file!.entries).toHaveLength(1);
    expect(file!.entries[0]!.key).toBe('todo:T1');
    expect(file!.entries[0]!.value).toBe('T1 进行中');
    expect(typeof file!.entries[0]!.recordedAt).toBe('string');
  });

  it('同 key 写入 = 删旧 + 新 value 追加队尾（有序队列语义）', async () => {
    const store = mkStore();
    await store.write('sess-a', 'todo:T1', 'v1');
    await store.write('sess-a', 'presence:u1', 'u1 running');
    await store.write('sess-a', 'todo:T1', 'v2'); // 同 key 覆盖

    const { readJsonFileSync } = await import('../../persistence/fs-io');
    const file = readJsonFileSync<{ entries: Array<{ key: string; value: string }> }>(queueJsonPath('sess-a'));
    expect(file!.entries).toHaveLength(2);
    // 同 key 删旧后新条目在队尾：presence 在前（原序），todo 新值在后
    expect(file!.entries[0]!.key).toBe('presence:u1');
    expect(file!.entries[0]!.value).toBe('u1 running');
    expect(file!.entries[1]!.key).toBe('todo:T1');
    expect(file!.entries[1]!.value).toBe('v2');
  });

  it('多条目保持写入顺序（队尾追加，不重排）', async () => {
    const store = mkStore();
    await store.write('sess-a', 'k1', 'v1');
    await store.write('sess-a', 'k2', 'v2');
    await store.write('sess-a', 'k3', 'v3');

    const values = await store.drain('sess-a');
    expect(values).toEqual(['v1', 'v2', 'v3']);
  });
});

describe('ReminderQueueStore — drain', () => {
  it('drain 按队列顺序读 value + 清空（「只记变化」）', async () => {
    const store = mkStore();
    await store.write('sess-a', 'k1', 'v1');
    await store.write('sess-a', 'k2', 'v2');

    const values = await store.drain('sess-a');
    expect(values).toEqual(['v1', 'v2']);

    // 清空后二次 drain → 空
    const again = await store.drain('sess-a');
    expect(again).toEqual([]);
  });

  it('空队列 drain → 空数组（不写盘，无副作用）', async () => {
    const store = mkStore();
    const values = await store.drain('sess-a');
    expect(values).toEqual([]);
    expect(existsSync(queueJsonPath('sess-a'))).toBe(false);
  });
});

describe('ReminderQueueStore — clearAll', () => {
  it('clearAll 清空队列（full 模式消费）', async () => {
    const store = mkStore();
    await store.write('sess-a', 'k1', 'v1');
    await store.write('sess-a', 'k2', 'v2');

    await store.clearAll('sess-a');
    expect(await store.drain('sess-a')).toEqual([]);
  });

  it('clearAll 幂等（空队列不写盘）', async () => {
    const store = mkStore();
    await store.clearAll('sess-a');
    await store.clearAll('sess-a');
    expect(existsSync(queueJsonPath('sess-a'))).toBe(false);
  });
});

describe('ReminderQueueStore — 锁序（per-sid Promise mutex）', () => {
  it('并发 write 串行：同 key 最终只有一条、值 = 最后一次写入（无竞态丢失）', async () => {
    const store = mkStore();
    // 并发 10 次同 key write（不 await 中间结果，模拟并发写入方）
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.write('sess-a', 'task:T1', `v${i}`)),
    );

    const values = await store.drain('sess-a');
    expect(values).toHaveLength(1);
    expect(values[0]).toBe('v9'); // 最后一次写入胜出（队尾）
  });

  it('并发 write 不同 key：全部保留且按完成序', async () => {
    const store = mkStore();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.write('sess-a', `k${i}`, `v${i}`)),
    );

    const values = await store.drain('sess-a');
    expect(values).toHaveLength(5);
    expect(new Set(values)).toEqual(new Set(['v0', 'v1', 'v2', 'v3', 'v4']));
  });
});

describe('ReminderQueueStore — 原子写 + 路径', () => {
  it('写盘后无 .tmp 残留（tmp+fsync+rename 原子写）', async () => {
    const store = mkStore();
    await store.write('sess-a', 'k1', 'v1');

    const dir = join(tmpRoot, 'sessions', 'sess-a');
    const files = readdirSync(dir);
    expect(files).toEqual(['reminder_queue.json']);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('路径 = {fsRoot}/sessions/{sid}/reminder_queue.json', async () => {
    const store = mkStore();
    await store.write('sess-a', 'k1', 'v1');
    expect(existsSync(queueJsonPath('sess-a'))).toBe(true);
  });

  it('schema 异常降级空队列（防半损坏文件阻断注入链）', async () => {
    const store = mkStore();
    const { atomicWriteSync } = await import('../../persistence/fs-io');
    atomicWriteSync(queueJsonPath('sess-x'), JSON.stringify({ version: 1, sessionId: 'sess-x', entries: 'not-array' }));

    const values = await store.drain('sess-x');
    expect(values).toEqual([]);
    // 降级后仍可正常写入（不残留坏状态）
    await store.write('sess-x', 'k1', 'v1');
    expect(await store.drain('sess-x')).toEqual(['v1']);
  });
});
