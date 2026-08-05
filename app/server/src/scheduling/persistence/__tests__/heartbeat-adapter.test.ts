/**
 * HeartbeatPersistenceAdapter UT — loadJobs/upsertJob/removeJob/removeAllJobs。
 * 参考: specs/tech/scheduling/[P1]heartbeat_handler.md §3（权威契约）
 *       specs/tech/scheduling/[P0]job_registry.md §1（PersistenceAdapter 接口）
 *
 * [v0.0.116] squad 级 API（旧 per-member RoleHeartbeat/writeRole/readRole 已删）。
 *
 * 覆盖：
 *   - loadJobs：getHeartbeatConfig=null → []（squad 不存在）
 *   - loadJobs：返 1 squad 级 job（id=heartbeat:{squadId}，payload={squadId}）
 *   - loadJobs：未持久化 → lastFiredAt=null
 *   - loadJobs：已持久化 → 回填 lastFiredAt（readSquad）
 *   - upsertJob：落盘 writeSquad（lastResult=fired）
 *   - removeJob / removeAllJobs：no-op（保 lastFiredAt 续接语义）
 *
 * 文件系统隔离：os.tmpdir + mkdtempSync + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeartbeatPersistenceAdapter } from '../heartbeat-adapter';
import { SchedulerStateStore } from '../../../squad/scheduler/scheduler-state';
import type { SquadHeartbeatConfig } from '../../../squad/scheduler/types';
import type { Job } from '../../types';

let tmpRoot: string;
let stateStore: SchedulerStateStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'hb-adapter-'));
  stateStore = new SchedulerStateStore(tmpRoot);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SquadHeartbeatConfig = {
  interval: 15,
  activeWindows: [],
  scope: { mode: 'all', memberIds: [] },
};

function mkAdapter(getHeartbeatConfig: (squadId: string) => Promise<{ config: SquadHeartbeatConfig; tz: string } | null>) {
  return new HeartbeatPersistenceAdapter({ stateStore, getHeartbeatConfig });
}

function mkJob(opts: { squadId?: string; lastFiredAt?: string | null }): Job {
  const squadId = opts.squadId ?? 'SQ-1';
  return {
    id: `heartbeat:${squadId}`,
    type: 'heartbeat',
    schedule: { kind: 'interval', ms: 900_000, tz: 'UTC' },
    payload: { squadId },
    lastFiredAt: opts.lastFiredAt ?? null,
    enabled: true,
    createdAt: '2026-01-15T00:00:00.000Z',
    owner: squadId,
  };
}

// ── loadJobs ─────────────────────────────────────────────────────────

describe('loadJobs(squadId)', () => {
  it('getHeartbeatConfig=null（squad 不存在）→ 返 []', async () => {
    const adapter = mkAdapter(async () => null);
    const jobs = await adapter.loadJobs('SQ-1');
    expect(jobs).toEqual([]);
  });

  it('squad 存在 → 返 1 squad 级 job（id=heartbeat:SQ-1）', async () => {
    const adapter = mkAdapter(async () => ({ config: DEFAULT_CONFIG, tz: 'UTC' }));
    const jobs = await adapter.loadJobs('SQ-1');
    expect(jobs).toHaveLength(1);
    const j = jobs[0]!;
    expect(j.id).toBe('heartbeat:SQ-1');
    expect(j.type).toBe('heartbeat');
    expect(j.payload).toEqual({ squadId: 'SQ-1' });
    expect(j.owner).toBe('SQ-1');
    expect(j.enabled).toBe(true);
  });

  it('interval 转 ms（config.interval=60 → ms=3_600_000）', async () => {
    const config: SquadHeartbeatConfig = { ...DEFAULT_CONFIG, interval: 60 };
    const adapter = mkAdapter(async () => ({ config, tz: 'UTC' }));
    const jobs = await adapter.loadJobs('SQ-1');
    expect(jobs[0]!.schedule).toMatchObject({ kind: 'interval', ms: 3_600_000 });
  });

  it('未持久化 → lastFiredAt=null（首次场景）', async () => {
    const adapter = mkAdapter(async () => ({ config: DEFAULT_CONFIG, tz: 'UTC' }));
    const jobs = await adapter.loadJobs('SQ-1');
    expect(jobs[0]!.lastFiredAt).toBeNull();
  });

  it('已持久化 → 回填 lastFiredAt（readSquad，重启续接）', async () => {
    stateStore.writeSquad('SQ-1', { lastFiredAt: '2026-01-15T09:30:00.000Z', lastResult: 'fired' });
    const adapter = mkAdapter(async () => ({ config: DEFAULT_CONFIG, tz: 'UTC' }));
    const jobs = await adapter.loadJobs('SQ-1');
    expect(jobs[0]!.lastFiredAt).toBe('2026-01-15T09:30:00.000Z');
  });
});

// ── upsertJob ────────────────────────────────────────────────────────

describe('upsertJob(owner, job)', () => {
  it('写 writeSquad（lastResult=fired）', async () => {
    const adapter = mkAdapter(async () => null);
    const job = mkJob({ lastFiredAt: '2026-01-15T10:30:00.000Z' });
    await adapter.upsertJob('SQ-1', job);
    const entry = stateStore.readSquad('SQ-1');
    expect(entry?.lastFiredAt).toBe('2026-01-15T10:30:00.000Z');
    expect(entry?.lastResult).toBe('fired');
  });
});

// ── removeJob / removeAllJobs ─────────────────────────────────────────

describe('removeJob / removeAllJobs（no-op，保 lastFiredAt）', () => {
  it('removeJob：no-op（stateStore 不删 entry）', async () => {
    stateStore.writeSquad('SQ-1', { lastFiredAt: '2026-01-15T10:30:00.000Z', lastResult: 'fired' });
    const adapter = mkAdapter(async () => null);
    await adapter.removeJob('SQ-1', 'heartbeat:SQ-1');
    expect(stateStore.readSquad('SQ-1')?.lastFiredAt).toBe('2026-01-15T10:30:00.000Z');
  });

  it('removeAllJobs：no-op（squad 不可删）', async () => {
    stateStore.writeSquad('SQ-1', { lastFiredAt: '2026-01-15T10:30:00.000Z', lastResult: 'fired' });
    const adapter = mkAdapter(async () => null);
    await expect(adapter.removeAllJobs('SQ-1')).resolves.toBeUndefined();
    expect(stateStore.readSquad('SQ-1')?.lastFiredAt).toBe('2026-01-15T10:30:00.000Z');
  });
});
