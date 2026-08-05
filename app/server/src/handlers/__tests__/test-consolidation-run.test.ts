/**
 * handleTestConsolidationRun UT —— test-only 同步触发端点。
 * 参考: specs/tech/scheduling/[P1]consolidation_job.md §7
 *       specs/api/version_logs/v0.0.151.t2_consolidate/change_log.md（请求/响应契约）
 *
 * 覆盖：
 *   T1: NODE_ENV!=='test' → 404，不调 runner（handler 层二次 gate）
 *   T2: 非 POST → 405
 *   T3: 成功 → 200 + 完整 result + 写 lastResult
 *   T4: 模型未配置（skippedReason）同样是 200（合法业务结果，非错误）
 *   T5: runner 抛异常（理论罕见）→ 500，不写 lastResult
 *
 * runConsolidationTier2 走 vi.mock（隔离 handler 自身逻辑）；adapter 用真实
 * ConsolidationPersistenceAdapter（tmpdir），验证真实落盘 lastResult。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock(require('path').resolve(__dirname, '../../agent/consolidation-tier2/runner'), async (importActual) => {
  const actual = await importActual<typeof import('../../agent/consolidation-tier2/runner')>();
  return { ...actual, runConsolidationTier2: vi.fn() };
});

import { handleTestConsolidationRun, type TestConsolidationRunDeps } from '../test-consolidation-run';
import { runConsolidationTier2 } from '../../agent/consolidation-tier2/runner';
import { ConsolidationPersistenceAdapter } from '../../scheduling/persistence/consolidation-adapter';
import type { AppConfigService } from '../../config/app-config-service';
import type { PluginManager } from '../../plugin/plugin-manager';
import type { AgentManagerImpl } from '../../agent/agent-manager';
import type { SessionStore } from '../../agent/session-store';

const mockRunner = runConsolidationTier2 as unknown as ReturnType<typeof vi.fn>;

let tmpRoot: string;
let adapter: ConsolidationPersistenceAdapter;
let savedNodeEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'test-consolidation-run-'));
  adapter = new ConsolidationPersistenceAdapter({ fsRoot: tmpRoot });
  savedNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  mockRunner.mockReset();
});

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function mkDeps(): TestConsolidationRunDeps {
  return {
    appConfig: {} as AppConfigService,
    pluginManager: {} as PluginManager,
    agentManager: {} as AgentManagerImpl,
    sessionStore: {} as SessionStore,
    dataDir: tmpRoot,
    adapter,
  };
}

describe('handleTestConsolidationRun', () => {
  it('T1: NODE_ENV!=="test" → 404，不调 runner', async () => {
    process.env.NODE_ENV = 'production';
    const req = new Request('http://x/test/consolidation/run', { method: 'POST' });
    const res = await handleTestConsolidationRun(req, 'POST', mkDeps());
    expect(res.status).toBe(404);
    expect(mockRunner).not.toHaveBeenCalled();
  });

  it('T2: 非 POST → 405', async () => {
    const req = new Request('http://x/test/consolidation/run', { method: 'GET' });
    const res = await handleTestConsolidationRun(req, 'GET', mkDeps());
    expect(res.status).toBe(405);
  });

  it('T3: 成功 → 200 + 完整 result + 写 lastResult', async () => {
    const result = {
      globalSkill: { action: 'merged', detail: 'x' },
      globalMemory: { action: 'no_change', detail: 'y' },
      sessions: [{ sessionId: 'S1', result: 'skipped_no_activity' as const }],
      summary: '全局 skill 归档 1 条 / memory 无变化 / 1 个 session 已跳过',
      skippedReason: null,
    };
    mockRunner.mockResolvedValue(result);
    const req = new Request('http://x/test/consolidation/run', { method: 'POST' });
    const res = await handleTestConsolidationRun(req, 'POST', mkDeps());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(result);
    const last = adapter.readLastResult();
    expect(last.summary).toBe(result.summary);
    expect(last.lastRunAt).not.toBeNull();
  });

  it('T4: 模型未配置（skippedReason）同样是 200', async () => {
    const result = {
      globalSkill: null, globalMemory: null, sessions: [],
      summary: '模型未配置，跳过本次整理', skippedReason: 'model_not_configured',
    };
    mockRunner.mockResolvedValue(result);
    const req = new Request('http://x/test/consolidation/run', { method: 'POST' });
    const res = await handleTestConsolidationRun(req, 'POST', mkDeps());
    expect(res.status).toBe(200);
    const body = await res.json() as { skippedReason: string | null };
    expect(body.skippedReason).toBe('model_not_configured');
  });

  it('T5: runner 抛异常（理论罕见）→ 500，不写 lastResult', async () => {
    mockRunner.mockRejectedValue(new Error('boom'));
    const req = new Request('http://x/test/consolidation/run', { method: 'POST' });
    const res = await handleTestConsolidationRun(req, 'POST', mkDeps());
    expect(res.status).toBe(500);
    const last = adapter.readLastResult();
    expect(last.summary).toBeNull();
  });
});
