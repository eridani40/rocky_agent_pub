/**
 * handleConsolidationStatus UT —— GET /consolidation/status 只读状态端点。
 * 参考: specs/api/overall/03-config-center.md §2.7（端点契约）
 *       specs/tech/agent/session/[P0]app_task_lock.md §3.1（status/startedAt 源自 AppTaskLock）
 *
 * 覆盖：
 *   T1: 从未整理过（无历史）→ 200 + {lastRunAt:null, summary:null, status:'idle', startedAt:null}
 *   T2: 已有 lastResult → 200 + lastResult 原样透传 + status/startedAt 合入
 *   T3: 状态文件损坏（非法 JSON）→ 500，不抛异常给上层
 *   T4-T7（[v0.0.205.t2_cons] 三态映射）：lock running→'running'+startedAt 透传；
 *     failed→'failed'+startedAt=null；done→'idle'（done 归 idle，完成态由 lastRunAt 承载）；
 *     idle→'idle'+startedAt=null
 *
 * adapter 用真实 ConsolidationPersistenceAdapter（tmpdir 隔离），T3 直接写坏文件模拟损坏；
 * appTaskLock 用真实 AppTaskLock 实例（内存 only，无需 mock）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleConsolidationStatus } from '../consolidation-status';
import { ConsolidationPersistenceAdapter } from '../../scheduling/persistence/consolidation-adapter';
import { AppTaskLock } from '../../agent/app-task-lock';

let tmpRoot: string;
let adapter: ConsolidationPersistenceAdapter;
let appTaskLock: AppTaskLock;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'consolidation-status-'));
  adapter = new ConsolidationPersistenceAdapter({ fsRoot: tmpRoot });
  appTaskLock = new AppTaskLock();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('handleConsolidationStatus', () => {
  it('T1: 从未整理过 → 200 + {lastRunAt:null, summary:null, status:idle, startedAt:null}', async () => {
    const res = handleConsolidationStatus(adapter, appTaskLock);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ lastRunAt: null, summary: null, status: 'idle', startedAt: null });
  });

  it('T2: 已有 lastResult → 200 + lastResult 原样透传 + status/startedAt 合入', async () => {
    adapter.writeLastResult({
      lastRunAt: '2026-07-15T04:00:03.211Z',
      summary: '全局 skill 归档 2 条 / memory 无变化 / 3 个 session 已整理',
    });
    const res = handleConsolidationStatus(adapter, appTaskLock);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      lastRunAt: '2026-07-15T04:00:03.211Z',
      summary: '全局 skill 归档 2 条 / memory 无变化 / 3 个 session 已整理',
      status: 'idle',
      startedAt: null,
    });
  });

  it('T3: 状态文件损坏（非法 JSON）→ 500，不抛异常', async () => {
    const dir = join(tmpRoot, 'consolidation');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), '{not valid json', 'utf8');
    const res = handleConsolidationStatus(adapter, appTaskLock);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('internal_error');
  });
});

describe('handleConsolidationStatus — status 三态映射（[v0.0.205.t2_cons] spec §2.7）', () => {
  it('T4: lock running → status=running + startedAt 透传（ISO 非空）', async () => {
    appTaskLock.acquire('tier2_consolidation', 'manual:abc');
    const expectedStartedAt = appTaskLock.getState('tier2_consolidation').startedAt;

    const res = handleConsolidationStatus(adapter, appTaskLock);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      lastRunAt: null,
      summary: null,
      status: 'running',
      startedAt: expectedStartedAt,
    });
  });

  it('T5: lock failed → status=failed + startedAt=null（markFailed 已清 startedAt）', async () => {
    appTaskLock.acquire('tier2_consolidation', 'cron:x');
    appTaskLock.markFailed('tier2_consolidation', 'LLM timeout');

    const res = handleConsolidationStatus(adapter, appTaskLock);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'failed', startedAt: null });
  });

  it('T6: lock done → status 归 idle（完成态由 lastResult.lastRunAt 承载）', async () => {
    adapter.writeLastResult({ lastRunAt: '2026-07-26T04:00:00.000Z', summary: 'done run' });
    appTaskLock.acquire('tier2_consolidation', 'manual:y');
    appTaskLock.markDone('tier2_consolidation');

    const res = handleConsolidationStatus(adapter, appTaskLock);
    const body = await res.json();
    expect(body).toEqual({
      lastRunAt: '2026-07-26T04:00:00.000Z',
      summary: 'done run',
      status: 'idle',
      startedAt: null,
    });
  });

  it('T7: lock idle（从未 acquire）→ status=idle + startedAt=null', async () => {
    const res = handleConsolidationStatus(adapter, appTaskLock);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'idle', startedAt: null });
  });
});
