/**
 * CronPersistenceAdapter UT — loadJobs/upsertJob/removeJob/removeAllJobs + 原子写 + 续接。
 * 参考: specs/tech/scheduling/[P1]cron_subsystem.md §3（权威契约 + CronFile schema）
 *       states/v0.0.58.cron/verify/test-plan.md §5（UT 范围：cron.json 原子写续接）
 *
 * 覆盖（task.json T3 acceptanceCriteria §2/§3）：
 *   A1: loadJobs 无 cron.json → 空（首次场景）
 *   A2: loadJobs 有 cron.json → Job[]（id=`cron:${sid}:${entryId}` / squadId 派生）
 *   A3: loadJobs squadId 派生 — playground（resolveSquadId 返 null）→ payload.squadId=null
 *   A4: loadJobs squadId 派生 — squad session（返 'SQ-1'）→ payload.squadId='SQ-1'
 *   A5: upsertJob 新增 entry（read-modify-write 全量 + 原子写）
 *   A6: upsertJob 替换 entry（id 已存在 → 替换 lastFiredAt）
 *   A7: removeJob filter out + 原子写
 *   A8: removeJob 把最后一个 entry 删 → 整文件删（不留空 schema 文件）
 *   A9: removeAllJobs 直接删 cron.json（session 销毁 hook 用）
 *   A10: 重启续接（upsertJob 后 loadJobs 回填 lastFiredAt 不丢）
 *   A11: 原子写（tmp+fsync+rename；upsert 后文件存在 + 内容是合法 JSON）
 *   A12: CronFile schema {version:1, sessionId, jobs[]}（不漏字段）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CronPersistenceAdapter,
  type CronFile,
} from '../cron-adapter';
import { readDirSafeSync } from '../../../persistence/fs-io';
import type { Job } from '../../types';
import type { CronPayload } from '../../payloads';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cron-adapter-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────

function mkAdapter(
  resolveSquadId: (sid: string) => Promise<string | null> = async () => null,
): CronPersistenceAdapter {
  return new CronPersistenceAdapter({ fsRoot: tmpRoot, resolveSquadId });
}

function cronJsonPath(sessionId: string): string {
  return join(tmpRoot, 'sessions', sessionId, 'cron.json');
}

/** 构造 cron Job（payload squadId 与 schedule 用户决定；adapter 不读 squadId from payload） */
function mkJob(opts: {
  sessionId?: string;
  entryId?: string;
  cron?: string;
  tz?: string;
  name?: string;
  prompt?: string;
  enabled?: boolean;
  lastFiredAt?: string | null;
  createdAt?: string;
}): Job {
  const sessionId = opts.sessionId ?? 'SID-1';
  const entryId = opts.entryId ?? 'J-1';
  const payload: CronPayload = {
    sessionId,
    name: opts.name ?? 'check',
    prompt: opts.prompt ?? 'do work',
    squadId: null,  // adapter 不读 payload.squadId；loadJobs 派生时覆盖
  };
  return {
    id: `cron:${sessionId}:${entryId}`,
    type: 'cron',
    schedule: { kind: 'cron', expr: opts.cron ?? '*/30 * * * *', tz: opts.tz ?? 'UTC' },
    payload,
    lastFiredAt: opts.lastFiredAt ?? null,
    enabled: opts.enabled ?? true,
    createdAt: opts.createdAt ?? '2026-07-01T00:00:00.000Z',
    owner: sessionId,
  };
}

// ── A1/A2: loadJobs ───────────────────────────────────────────────────

describe('A1: loadJobs 无 cron.json → 空', () => {
  it('首次启动 / 无文件 → 返 []', async () => {
    const adapter = mkAdapter();
    const jobs = await adapter.loadJobs('SID-1');
    expect(jobs).toEqual([]);
  });
});

describe('A2: loadJobs 有 cron.json → Job[]', () => {
  it('回填 Job 字段（id/schedule/payload/lastFiredAt/enabled）', async () => {
    const adapter = mkAdapter();
    await adapter.upsertJob('SID-1', mkJob({ entryId: 'J-1', cron: '0 9 * * *', tz: 'Asia/Shanghai' }));
    const jobs = await adapter.loadJobs('SID-1');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: 'cron:SID-1:J-1',
      type: 'cron',
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
      owner: 'SID-1',
      enabled: true,
      lastFiredAt: null,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    expect(jobs[0]?.payload).toMatchObject({
      sessionId: 'SID-1',
      name: 'check',
      prompt: 'do work',
    });
  });
});

// ── A3/A4: squadId 派生 ────────────────────────────────────────────────

describe('A3: loadJobs squadId 派生 — playground (resolveSquadId 返 null)', () => {
  it('resolveSquadId=null → payload.squadId=null', async () => {
    const adapter = mkAdapter(async () => null);
    await adapter.upsertJob('SID-1', mkJob({}));
    const jobs = await adapter.loadJobs('SID-1');
    expect((jobs[0]?.payload as CronPayload).squadId).toBeNull();
  });
});

describe('A4: loadJobs squadId 派生 — squad session (返 SQ-1)', () => {
  it('resolveSquadId=SQ-1 → payload.squadId=SQ-1（与 resolveSquadId 入参 sessionId 对应）', async () => {
    const adapter = mkAdapter(async (sid) => (sid === 'SID-SQUAD' ? 'SQ-1' : null));
    await adapter.upsertJob('SID-SQUAD', mkJob({ sessionId: 'SID-SQUAD' }));
    const jobs = await adapter.loadJobs('SID-SQUAD');
    expect((jobs[0]?.payload as CronPayload).squadId).toBe('SQ-1');
    // resolveSquadId 入参是 sessionId
    expect(jobs[0]?.payload).toMatchObject({ sessionId: 'SID-SQUAD' });
  });
});

// ── A5/A6: upsertJob ──────────────────────────────────────────────────

describe('A5: upsertJob 新增 entry（read-modify-write）', () => {
  it('两次 upsert 不同 id → jobs 长度 2', async () => {
    const adapter = mkAdapter();
    await adapter.upsertJob('SID-1', mkJob({ entryId: 'J-1' }));
    await adapter.upsertJob('SID-1', mkJob({ entryId: 'J-2' }));
    const jobs = await adapter.loadJobs('SID-1');
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((j) => j.id))).toEqual(new Set(['cron:SID-1:J-1', 'cron:SID-1:J-2']));
  });
});

describe('A6: upsertJob 替换 entry（同 id）', () => {
  it('同 id 第二次 upsert → 替换（不新增）', async () => {
    const adapter = mkAdapter();
    await adapter.upsertJob('SID-1', mkJob({ entryId: 'J-1', lastFiredAt: null }));
    await adapter.upsertJob(
      'SID-1',
      mkJob({ entryId: 'J-1', lastFiredAt: '2026-07-03T10:00:00.000Z' }),
    );
    const jobs = await adapter.loadJobs('SID-1');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.lastFiredAt).toBe('2026-07-03T10:00:00.000Z');
  });
});

// ── A7/A8: removeJob ──────────────────────────────────────────────────

describe('A7: removeJob filter out + 原子写', () => {
  it('删中间 entry → 剩余 entry 保留', async () => {
    const adapter = mkAdapter();
    await adapter.upsertJob('SID-1', mkJob({ entryId: 'J-1' }));
    await adapter.upsertJob('SID-1', mkJob({ entryId: 'J-2' }));
    await adapter.removeJob('SID-1', 'cron:SID-1:J-1');
    const jobs = await adapter.loadJobs('SID-1');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe('cron:SID-1:J-2');
  });

  it('removeJob 不存在 jobId → no-op（不抛）', async () => {
    const adapter = mkAdapter();
    await adapter.upsertJob('SID-1', mkJob({ entryId: 'J-1' }));
    await expect(adapter.removeJob('SID-1', 'cron:SID-1:MISSING')).resolves.toBeUndefined();
    const jobs = await adapter.loadJobs('SID-1');
    expect(jobs).toHaveLength(1);
  });

  it('removeJob 文件不存在 → no-op（不抛）', async () => {
    const adapter = mkAdapter();
    await expect(adapter.removeJob('SID-NEW', 'cron:SID-NEW:X')).resolves.toBeUndefined();
  });
});

describe('A8: removeJob 删最后一个 → 删整文件（不留空 schema）', () => {
  it('单 entry remove → cron.json 不存在', async () => {
    const adapter = mkAdapter();
    await adapter.upsertJob('SID-1', mkJob({ entryId: 'J-1' }));
    expect(existsSync(cronJsonPath('SID-1'))).toBe(true);
    await adapter.removeJob('SID-1', 'cron:SID-1:J-1');
    expect(existsSync(cronJsonPath('SID-1'))).toBe(false);
  });
});

// ── A9: removeAllJobs ─────────────────────────────────────────────────

describe('A9: removeAllJobs 直接删 cron.json', () => {
  it('有文件 → 删；后续 loadJobs 返 []', async () => {
    const adapter = mkAdapter();
    await adapter.upsertJob('SID-1', mkJob({ entryId: 'J-1' }));
    await adapter.removeAllJobs('SID-1');
    expect(existsSync(cronJsonPath('SID-1'))).toBe(false);
    expect(await adapter.loadJobs('SID-1')).toEqual([]);
  });

  it('无文件 → no-op（不抛）', async () => {
    const adapter = mkAdapter();
    await expect(adapter.removeAllJobs('SID-NEW')).resolves.toBeUndefined();
  });
});

// ── A10: 重启续接 ─────────────────────────────────────────────────────

describe('A10: 重启续接（lastFiredAt 不丢）', () => {
  it('upsert(lastFiredAt=X) → new adapter loadJobs 回填 lastFiredAt=X', async () => {
    const adapter1 = mkAdapter(async () => 'SQ-1');
    await adapter1.upsertJob(
      'SID-1',
      mkJob({ entryId: 'J-1', lastFiredAt: '2026-07-03T10:00:00.000Z' }),
    );
    // 模拟重启：新 adapter 实例（无内存 cache）
    const adapter2 = mkAdapter(async () => 'SQ-1');
    const jobs = await adapter2.loadJobs('SID-1');
    expect(jobs[0]?.lastFiredAt).toBe('2026-07-03T10:00:00.000Z');
  });
});

// ── A11: 原子写 ───────────────────────────────────────────────────────

describe('A11: 原子写（atomicWriteSync：tmp+fsync+rename）', () => {
  it('upsert 后 cron.json 存在 + 内容是合法 JSON（无半写）', async () => {
    const adapter = mkAdapter();
    await adapter.upsertJob('SID-1', mkJob({ entryId: 'J-1' }));
    const raw = readFileSync(cronJsonPath('SID-1'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('并发 upsert 不留 .tmp 文件（rename 完成后 tmp 清理）', async () => {
    const adapter = mkAdapter();
    await adapter.upsertJob('SID-1', mkJob({ entryId: 'J-1' }));
    await adapter.upsertJob('SID-1', mkJob({ entryId: 'J-2' }));
    const dir = join(tmpRoot, 'sessions', 'SID-1');
    const files = readDirSafeSync(dir);
    expect(files).toEqual(['cron.json']);  // 无 cron.json.tmp
  });
});

// ── A12: CronFile schema ──────────────────────────────────────────────

describe('A12: CronFile schema {version:1, sessionId, jobs[]}', () => {
  it('落盘 JSON 含 version=1 + sessionId + jobs 数组', async () => {
    const adapter = mkAdapter();
    await adapter.upsertJob('SID-1', mkJob({ entryId: 'J-1' }));
    const file = JSON.parse(readFileSync(cronJsonPath('SID-1'), 'utf8')) as CronFile;
    expect(file.version).toBe(1);
    expect(file.sessionId).toBe('SID-1');
    expect(Array.isArray(file.jobs)).toBe(true);
    expect(file.jobs).toHaveLength(1);
    // entry 字段完整（id/cron/tz/name/prompt/enabled/createdAt/lastFiredAt）
    expect(file.jobs[0]).toMatchObject({
      id: 'J-1',
      cron: '*/30 * * * *',
      tz: 'UTC',
      name: 'check',
      prompt: 'do work',
      enabled: true,
      createdAt: '2026-07-01T00:00:00.000Z',
      lastFiredAt: null,
    });
  });
});
