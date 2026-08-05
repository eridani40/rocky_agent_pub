/**
 * squad-token-stats-handler 单测（白盒）—— GET /squad/:id/token-stats
 * 参考: specs/api/overall/11c-token-stats.md §1-§6（端点完整契约）
 *       specs/tech/version_logs/v0.0.194/change_plan.md 模块 D
 *
 * 覆盖（availableModels 字段 + distinct model 注入）：
 *   - GET → 200 + TokenUsageQueryResult（含 series + availableModels）
 *   - availableModels 字段由 handler 调 aggregator.queryDistinctModels 派生填充
 *   - 404 squad 不存在
 *   - 503 sqlite 未就绪（tokenUsageAggregator undefined）
 *   - 400 query 参数非法（from>to / 日期格式错 / providerId 无 modelId）
 *   - 405 非 GET
 *
 * aggregator 用 mock 注入（不构造真 TokenUsageAggregator——query/queryDistinctModels 真逻辑由 aggregator UT 覆盖）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleTokenStatsRoute } from '../squad-token-stats-handler';
import type { SquadHandlerDeps, TokenUsageAggregatorPort } from '../squad';
import type { TokenUsageQueryResult } from '../../squad/token-usage/token-usage-aggregator';
import { createSquadService } from '../../services/squad-service';
import { SquadStore, MemberStore } from '../../stores/squad-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { AppConfigService } from '../../config/app-config-service';

let tmpRoot: string;
let sessionStore: SessionStore;
let squadId: string;
let queryMock: ReturnType<typeof vi.fn>;
let queryDistinctModelsMock: ReturnType<typeof vi.fn>;
let deps: SquadHandlerDeps;

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'token-stats-handler-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore().mount('session', fsEngine).mount('transcript', fsEngine)
    .mount('summary', fsEngine).mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  const squadStore = new SquadStore({ root: tmpRoot });
  const memberStore = new MemberStore({ root: tmpRoot });
  const created = await createSquadService(
    { sessionStore, squadStore, memberStore, dataDir: tmpRoot },
    { name: 'ts1', modelDefault: 'm', leader: { name: 'lead' } },
  );
  squadId = created.squad.id;
  queryMock = vi.fn();
  queryDistinctModelsMock = vi.fn();
  const agg: TokenUsageAggregatorPort = {
    query: queryMock,
    queryDistinctModels: queryDistinctModelsMock,
  };
  deps = { sessionStore, dataDir: tmpRoot, tokenUsageAggregator: agg };
});

afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

async function jsonBody(r: Response): Promise<any> { return JSON.parse(await r.text()); }

function fakeResult(over: Partial<TokenUsageQueryResult> = {}): TokenUsageQueryResult {
  return {
    squadId,
    granularity: 'day',
    scope: 'team',
    from: '2026-07-23',
    to: '2026-07-24',
    timezone: 'UTC',
    series: [],
    availableModels: [],
    ...over,
  };
}

describe('TokenStatsHandler — GET /token-stats（api §11c）', () => {
  it('200 + TokenUsageQueryResult（含 series + availableModels）', async () => {
    queryMock.mockReturnValue(fakeResult({ series: [{ bucket: '2026-07-23', input_no_cache: 100, cache_read: 50, cache_creation: 0, output_response: 200, output_reasoning: 0, cost: 0, llmCallCount: 1, total: 350, cacheRate: 50 / 150 }] }));
    queryDistinctModelsMock.mockReturnValue([
      { providerId: 'p1', modelId: 'sonnet', label: 'p1/sonnet' },
    ]);
    const r = await handleTokenStatsRoute(
      new Request(`http://t/squad/${squadId}/token-stats`),
      'GET',
      `/squad/${squadId}/token-stats`,
      deps,
    );
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.squadId).toBe(squadId);
    expect(Array.isArray(body.series)).toBe(true);
    expect(body.series).toHaveLength(1);
    // availableModels 字段透传
    expect(Array.isArray(body.availableModels)).toBe(true);
    expect(body.availableModels).toEqual([{ providerId: 'p1', modelId: 'sonnet', label: 'p1/sonnet' }]);
  });

  it('handler 调 aggregator.queryDistinctModels（一次请求拿数据 + model 列表）', async () => {
    queryMock.mockReturnValue(fakeResult());
    queryDistinctModelsMock.mockReturnValue([]);
    await handleTokenStatsRoute(
      new Request(`http://t/squad/${squadId}/token-stats`),
      'GET',
      `/squad/${squadId}/token-stats`,
      deps,
    );
    expect(queryDistinctModelsMock).toHaveBeenCalledTimes(1);
    // 第 1 参数 = squadId；第 2 参数 = range 对象（含 from/to 或 undefined）
    expect(queryDistinctModelsMock.mock.calls[0]![0]).toBe(squadId);
  });

  it('404 squad 不存在', async () => {
    const fakeId = '01ARZ3NDEKTSV4RRFFQ69G5FAZ';
    const r = await handleTokenStatsRoute(
      new Request(`http://t/squad/${fakeId}/token-stats`),
      'GET',
      `/squad/${fakeId}/token-stats`,
      deps,
    );
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error).toContain('not found');
  });

  it('503 sqlite 未就绪（tokenUsageAggregator undefined）', async () => {
    const r = await handleTokenStatsRoute(
      new Request(`http://t/squad/${squadId}/token-stats`),
      'GET',
      `/squad/${squadId}/token-stats`,
      { ...deps, tokenUsageAggregator: undefined },
    );
    expect(r.status).toBe(503);
  });

  it('400 from>to', async () => {
    const r = await handleTokenStatsRoute(
      new Request(`http://t/squad/${squadId}/token-stats?from=2026-07-25&to=2026-07-23`),
      'GET',
      `/squad/${squadId}/token-stats`,
      deps,
    );
    expect(r.status).toBe(400);
  });

  it('400 from 格式非法', async () => {
    const r = await handleTokenStatsRoute(
      new Request(`http://t/squad/${squadId}/token-stats?from=20260725`),
      'GET',
      `/squad/${squadId}/token-stats`,
      deps,
    );
    expect(r.status).toBe(400);
  });

  it('400 providerId 单独提供（无 modelId）', async () => {
    const r = await handleTokenStatsRoute(
      new Request(`http://t/squad/${squadId}/token-stats?providerId=p1`),
      'GET',
      `/squad/${squadId}/token-stats`,
      deps,
    );
    expect(r.status).toBe(400);
  });

  it('405 非 GET（POST）', async () => {
    const r = await handleTokenStatsRoute(
      new Request(`http://t/squad/${squadId}/token-stats`, { method: 'POST' }),
      'POST',
      `/squad/${squadId}/token-stats`,
      deps,
    );
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET');
  });
});

describe('TokenStatsHandler — availableModels label 改写（providerId → provider 名字）', () => {
  it('appConfig 有 provider label → label 改为「provider 名字 / modelId」', async () => {
    const appConfig = new AppConfigService({ root: tmpRoot });
    appConfig.set('providers', 'p1', {
      id: 'p1', label: 'minimax', name: 'anthropic_compatible', enabled: true, models: [],
    });
    queryMock.mockReturnValue(fakeResult());
    queryDistinctModelsMock.mockReturnValue([
      { providerId: 'p1', modelId: 'MiniMax-M3', label: 'p1/MiniMax-M3' },
    ]);
    const r = await handleTokenStatsRoute(
      new Request(`http://t/squad/${squadId}/token-stats`),
      'GET',
      `/squad/${squadId}/token-stats`,
      { ...deps, appConfig },
    );
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.availableModels).toEqual([
      { providerId: 'p1', modelId: 'MiniMax-M3', label: 'minimax / MiniMax-M3' },
    ]);
  });

  it('providerId 未命中 appConfig → 保持原 label（fallback）', async () => {
    const appConfig = new AppConfigService({ root: tmpRoot });
    appConfig.set('providers', 'other', {
      id: 'other', label: 'glm', enabled: true, models: [],
    });
    queryMock.mockReturnValue(fakeResult());
    queryDistinctModelsMock.mockReturnValue([
      { providerId: 'p-gone', modelId: 'm1', label: 'p-gone/m1' },
      { providerId: '__unknown__', modelId: '__unknown__', label: '未知模型' },
    ]);
    const r = await handleTokenStatsRoute(
      new Request(`http://t/squad/${squadId}/token-stats`),
      'GET',
      `/squad/${squadId}/token-stats`,
      { ...deps, appConfig },
    );
    const body = await jsonBody(r);
    // 未命中 + __unknown__ 都保持原 label
    expect(body.availableModels).toEqual([
      { providerId: 'p-gone', modelId: 'm1', label: 'p-gone/m1' },
      { providerId: '__unknown__', modelId: '__unknown__', label: '未知模型' },
    ]);
  });

  it('disabled provider 仍映射名字（历史统计可能引用已停用 provider）；_deleted 墓碑跳过', async () => {
    const appConfig = new AppConfigService({ root: tmpRoot });
    appConfig.set('providers', 'p-disabled', {
      id: 'p-disabled', label: 'volcengine', enabled: false, models: [],
    });
    appConfig.set('providers', 'p-deleted', {
      id: 'p-deleted', label: 'old', enabled: true, _deleted: true, models: [],
    });
    queryMock.mockReturnValue(fakeResult());
    queryDistinctModelsMock.mockReturnValue([
      { providerId: 'p-disabled', modelId: 'm1', label: 'p-disabled/m1' },
      { providerId: 'p-deleted', modelId: 'm2', label: 'p-deleted/m2' },
    ]);
    const r = await handleTokenStatsRoute(
      new Request(`http://t/squad/${squadId}/token-stats`),
      'GET',
      `/squad/${squadId}/token-stats`,
      { ...deps, appConfig },
    );
    const body = await jsonBody(r);
    expect(body.availableModels).toEqual([
      { providerId: 'p-disabled', modelId: 'm1', label: 'volcengine / m1' },
      { providerId: 'p-deleted', modelId: 'm2', label: 'p-deleted/m2' },
    ]);
  });

  it('appConfig 未注入 → 原样透传（兼容旧装配）', async () => {
    queryMock.mockReturnValue(fakeResult());
    queryDistinctModelsMock.mockReturnValue([
      { providerId: 'p1', modelId: 'sonnet', label: 'p1/sonnet' },
    ]);
    const r = await handleTokenStatsRoute(
      new Request(`http://t/squad/${squadId}/token-stats`),
      'GET',
      `/squad/${squadId}/token-stats`,
      deps, // 无 appConfig
    );
    const body = await jsonBody(r);
    expect(body.availableModels).toEqual([
      { providerId: 'p1', modelId: 'sonnet', label: 'p1/sonnet' },
    ]);
  });
});
