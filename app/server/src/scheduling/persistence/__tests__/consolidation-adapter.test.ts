/**
 * ConsolidationPersistenceAdapter UT —— consolidation/state.json 持久化（app 级单例）。
 * 参考: specs/tech/scheduling/[P1]consolidation_job.md §2.1（两处分离存储设计）
 *
 * 覆盖：
 *   A1: loadJobs 无文件 → 空数组
 *   A2: upsertJob 落盘 → loadJobs 读回同一 job（round-trip）
 *   A3: upsertJob 覆盖同 id job（不重复 push）
 *   A4: loadJobs 按 owner 过滤
 *   A5: removeJob 删单条；removeAllJobs 按 owner 删全部
 *   A6: readLastResult 无历史 → {lastRunAt:null, summary:null}
 *   A7: writeLastResult + readLastResult round-trip
 *   A8: writeLastResult 不清空 jobs[]；upsertJob 不清空 lastResult（两处分离持久化互不覆盖）
 *
 * 文件系统隔离：os.tmpdir + mkdtempSync + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsolidationPersistenceAdapter } from '../consolidation-adapter';
import type { Job } from '../../types';

let tmpRoot: string;
let adapter: ConsolidationPersistenceAdapter;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'consolidation-adapter-'));
  adapter = new ConsolidationPersistenceAdapter({ fsRoot: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function mkJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'consolidation:app',
    type: 'consolidation',
    schedule: { kind: 'cron', expr: '0 4 * * *', tz: 'UTC' },
    payload: {},
    lastFiredAt: null,
    enabled: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    owner: 'app',
    ...overrides,
  };
}

describe('ConsolidationPersistenceAdapter — jobs', () => {
  it('A1: loadJobs 无文件 → 空数组', async () => {
    expect(await adapter.loadJobs('app')).toEqual([]);
  });

  it('A2: upsertJob 落盘 → loadJobs 读回同一 job', async () => {
    const job = mkJob();
    await adapter.upsertJob('app', job);
    const loaded = await adapter.loadJobs('app');
    expect(loaded).toEqual([job]);
  });

  it('A3: upsertJob 覆盖同 id job（不重复 push）', async () => {
    const job = mkJob({ lastFiredAt: null });
    await adapter.upsertJob('app', job);
    const updated = { ...job, lastFiredAt: '2026-07-15T04:00:00.000Z' };
    await adapter.upsertJob('app', updated);
    const loaded = await adapter.loadJobs('app');
    expect(loaded).toEqual([updated]);
  });

  it('A4: loadJobs 按 owner 过滤', async () => {
    await adapter.upsertJob('app', mkJob({ owner: 'app' }));
    await adapter.upsertJob('other', mkJob({ id: 'x:other', owner: 'other' }));
    const loaded = await adapter.loadJobs('app');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.owner).toBe('app');
  });

  it('A5: removeJob 删单条；removeAllJobs 按 owner 删全部', async () => {
    await adapter.upsertJob('app', mkJob({ id: 'j1' }));
    await adapter.upsertJob('app', mkJob({ id: 'j2' }));
    await adapter.removeJob('app', 'j1');
    expect((await adapter.loadJobs('app')).map((j) => j.id)).toEqual(['j2']);
    await adapter.removeAllJobs('app');
    expect(await adapter.loadJobs('app')).toEqual([]);
  });
});

describe('ConsolidationPersistenceAdapter — lastResult', () => {
  it('A6: readLastResult 无历史 → {lastRunAt:null, summary:null}', () => {
    expect(adapter.readLastResult()).toEqual({ lastRunAt: null, summary: null });
  });

  it('A7: writeLastResult + readLastResult round-trip', () => {
    adapter.writeLastResult({ lastRunAt: '2026-07-15T04:00:05.000Z', summary: '全局 skill 归档 1 条' });
    expect(adapter.readLastResult()).toEqual({
      lastRunAt: '2026-07-15T04:00:05.000Z',
      summary: '全局 skill 归档 1 条',
    });
  });

  it('A8a: writeLastResult 不清空已持久化的 jobs[]', async () => {
    const job = mkJob();
    await adapter.upsertJob('app', job);
    adapter.writeLastResult({ lastRunAt: '2026-07-15T04:00:00.000Z', summary: 's' });
    expect(await adapter.loadJobs('app')).toEqual([job]);
  });

  it('A8b: upsertJob 不清空已写入的 lastResult', async () => {
    adapter.writeLastResult({ lastRunAt: '2026-07-15T04:00:00.000Z', summary: 's' });
    await adapter.upsertJob('app', mkJob());
    expect(adapter.readLastResult()).toEqual({ lastRunAt: '2026-07-15T04:00:00.000Z', summary: 's' });
  });
});
