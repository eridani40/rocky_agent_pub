/**
 * handleConsolidationRun UT —— 生产端点 POST /consolidation/run（v0.0.164.memory_opt 新建）。
 * 参考: specs/tech/version_logs/v0.0.164.memory_opt/change_plan.md 模块 G
 *       specs/tech/agent/session/[P0]app_task_lock.md §4
 *
 * 覆盖（acceptanceCriteria 3 分支）：
 *   R1: 非 POST → 405
 *   R2: acquire 成功 → 202 + {ok, runId} + fire-and-forget spawn；then markDone + writeLastResult
 *   R3: acquire 失败（已 running）→ 409 {error:'consolidation_in_progress'}，不 spawn runner
 *   R4: runId 形态 = 'manual:<ulid>'（观测契约）
 *   R5: 后台 runner 抛错 → catch markFailed（锁释放，不阻塞未来 acquire）
 *   R6: skip 语义透传（skippedReason='model_not_configured'）：202 立即返 + 后台仍 markDone
 *
 * runConsolidationTier2 走 vi.mock（隔离 handler 自身逻辑）；adapter 用真实
 * ConsolidationPersistenceAdapter（tmpdir），验证真实落盘 lastResult；appTaskLock 用真实
 * AppTaskLock 单例，验证 CAS + emit 完整链。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock(require('path').resolve(__dirname, '../../agent/consolidation-tier2/runner'), async (importActual) => {
  const actual = await importActual<typeof import('../../agent/consolidation-tier2/runner')>();
  return { ...actual, runConsolidationTier2: vi.fn() };
});

import { handleConsolidationRun, type ConsolidationRunDeps } from '../consolidation-run';
import { runConsolidationTier2 } from '../../agent/consolidation-tier2/runner';
import { ConsolidationPersistenceAdapter } from '../../scheduling/persistence/consolidation-adapter';
import { AppTaskLock } from '../../agent/app-task-lock';
import type { AppConfigService } from '../../config/app-config-service';
import type { PluginManager } from '../../plugin/plugin-manager';
import type { AgentManagerImpl } from '../../agent/agent-manager';
import type { SessionStore } from '../../agent/session-store';

const mockRunner = runConsolidationTier2 as unknown as ReturnType<typeof vi.fn>;
const CONSOLIDATION_TASK_TYPE = 'tier2_consolidation';

let tmpRoot: string;
let adapter: ConsolidationPersistenceAdapter;
let appTaskLock: AppTaskLock;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'consolidation-run-'));
  adapter = new ConsolidationPersistenceAdapter({ fsRoot: tmpRoot });
  appTaskLock = new AppTaskLock();
  mockRunner.mockReset();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function mkDeps(): ConsolidationRunDeps {
  return {
    appConfig: {} as AppConfigService,
    pluginManager: {} as PluginManager,
    agentManager: {} as AgentManagerImpl,
    sessionStore: {} as SessionStore,
    dataDir: tmpRoot,
    adapter,
    appTaskLock,
  };
}

/** 等待 fire-and-forget promise 结算：runner mock 返值 → then/catch 微任务 */
async function drainMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe('handleConsolidationRun', () => {
  it('R1: 非 POST → 405，不 acquire 锁', () => {
    const req = new Request('http://x/consolidation/run', { method: 'GET' });
    const res = handleConsolidationRun(req, 'GET', mkDeps());
    expect(res.status).toBe(405);
    expect(appTaskLock.getState(CONSOLIDATION_TASK_TYPE).status).toBe('idle');
    expect(mockRunner).not.toHaveBeenCalled();
  });

  it('R2: acquire 成功 → 202 + {ok, runId} + fire-and-forget spawn + then markDone + writeLastResult', async () => {
    const result = {
      globalSkill: { action: 'merged', detail: 'x' },
      globalMemory: null,
      sessions: [],
      summary: '手动整理: 全局 skill 归档 1 条',
      skippedReason: null,
    };
    // 手动 pending promise：验证 202 立即返 + 锁进 running（runner 未 settle 时）
    let resolveRunner: (v: unknown) => void = () => {};
    const pending = new Promise((r) => { resolveRunner = r; });
    mockRunner.mockReturnValue(pending);

    const req = new Request('http://x/consolidation/run', { method: 'POST' });
    const res = handleConsolidationRun(req, 'POST', mkDeps());
    expect(res.status).toBe(202);
    const body = await res.json() as { ok: true; runId: string };
    expect(body.ok).toBe(true);
    expect(body.runId).toBeTruthy();
    // runner 尚未 settle → lock 仍 running（fire-and-forget 未完成）
    expect(appTaskLock.getState(CONSOLIDATION_TASK_TYPE).status).toBe('running');
    expect(appTaskLock.getState(CONSOLIDATION_TASK_TYPE).runId).toBe(body.runId);

    // 手动 resolve runner → markDone + writeLastResult
    resolveRunner(result);
    await drainMicrotasks();
    expect(mockRunner).toHaveBeenCalledTimes(1);
    expect(appTaskLock.getState(CONSOLIDATION_TASK_TYPE).status).toBe('done');
    const last = adapter.readLastResult();
    expect(last.summary).toBe(result.summary);
    expect(last.lastRunAt).not.toBeNull();
  });

  it('R3: acquire 失败（已 running）→ 409 consolidation_in_progress，不 spawn runner', async () => {
    // 预置 lock 已 running（模拟 cron 或另一手动触发正在跑）
    appTaskLock.acquire(CONSOLIDATION_TASK_TYPE, 'cron:2026-07-17T04:00:00.000Z');

    const req = new Request('http://x/consolidation/run', { method: 'POST' });
    const res = handleConsolidationRun(req, 'POST', mkDeps());
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('consolidation_in_progress');

    await drainMicrotasks();
    expect(mockRunner).not.toHaveBeenCalled();
    // 原 lock 状态不变（cron 仍在跑）
    expect(appTaskLock.getState(CONSOLIDATION_TASK_TYPE).runId).toBe('cron:2026-07-17T04:00:00.000Z');
  });

  it('R4: runId 形态 = "manual:<ulid>"（观测契约）', async () => {
    mockRunner.mockResolvedValue({
      globalSkill: null, globalMemory: null, sessions: [], summary: 's', skippedReason: null,
    });
    const req = new Request('http://x/consolidation/run', { method: 'POST' });
    const res = handleConsolidationRun(req, 'POST', mkDeps());
    const body = await res.json() as { runId: string };
    expect(body.runId).toMatch(/^manual:[0-9A-HJKMNP-TV-Z]{26}$/); // ULID = 26 字符 crockford32
    await drainMicrotasks();
  });

  it('R5: 后台 runner 抛错 → catch markFailed 释放锁；lastResult 不写', async () => {
    mockRunner.mockRejectedValue(new Error('boom'));

    const req = new Request('http://x/consolidation/run', { method: 'POST' });
    const res = handleConsolidationRun(req, 'POST', mkDeps());
    expect(res.status).toBe(202); // 立即 202（fire-and-forget UX）

    await drainMicrotasks();
    // 锁必须释放（否则下次 acquire 永远 409）
    expect(appTaskLock.getState(CONSOLIDATION_TASK_TYPE).status).toBe('failed');
    expect(appTaskLock.getState(CONSOLIDATION_TASK_TYPE).error).toBe('boom');
    // lastResult 不写（错误路径）
    const last = adapter.readLastResult();
    expect(last.summary).toBeNull();

    // failed 后可以重新 acquire（CAS 放行集合含 failed）
    mockRunner.mockResolvedValue({
      globalSkill: null, globalMemory: null, sessions: [], summary: 'retry ok', skippedReason: null,
    });
    const res2 = handleConsolidationRun(req, 'POST', mkDeps());
    expect(res2.status).toBe(202);
  });

  it('R6: skip 语义透传（skippedReason=model_not_configured）→ 仍 202 + markDone + 写 lastResult', async () => {
    // tier2 runner 遇到"模型未配置"直接秒回 skip（合法业务结果，非错误）
    mockRunner.mockResolvedValue({
      globalSkill: null,
      globalMemory: null,
      sessions: [],
      summary: '模型未配置，跳过本次整理',
      skippedReason: 'model_not_configured',
    });

    const req = new Request('http://x/consolidation/run', { method: 'POST' });
    const res = handleConsolidationRun(req, 'POST', mkDeps());
    expect(res.status).toBe(202);

    await drainMicrotasks();
    expect(appTaskLock.getState(CONSOLIDATION_TASK_TYPE).status).toBe('done');
    const last = adapter.readLastResult();
    expect(last.summary).toBe('模型未配置，跳过本次整理');
  });

  it('R7: writeLastResult 抛错时仍 markDone（锁必须释放，best-effort 写入）', async () => {
    mockRunner.mockResolvedValue({
      globalSkill: null, globalMemory: null, sessions: [], summary: 'x', skippedReason: null,
    });
    // adapter mock：writeLastResult 抛错
    const brokenAdapter = {
      writeLastResult: () => {
        throw new Error('disk full');
      },
      readLastResult: () => ({ lastRunAt: null, summary: null }),
    } as unknown as ConsolidationPersistenceAdapter;
    const deps: ConsolidationRunDeps = { ...mkDeps(), adapter: brokenAdapter };

    const req = new Request('http://x/consolidation/run', { method: 'POST' });
    const res = handleConsolidationRun(req, 'POST', deps);
    expect(res.status).toBe(202);

    await drainMicrotasks();
    // 写落盘失败但锁仍必须释放
    expect(appTaskLock.getState(CONSOLIDATION_TASK_TYPE).status).toBe('done');
  });
});
