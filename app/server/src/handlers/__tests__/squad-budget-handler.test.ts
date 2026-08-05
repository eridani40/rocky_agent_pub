/**
 * squad-budget-handler 单测（白盒）—— GET /squad/:id/budget/usage
 * 参考: specs/api/version_logs/v0.0.33.4/change_log.md §4（BudgetUsage schema + budget=null→-1）
 *
 * 覆盖：
 *   - GET → 200 + BudgetUsage 全字段（squadId/limit/window/consumed/remaining/windowStart/windowEnd/perSession/timezone）
 *   - budget=null → limit=-1/remaining=-1 consumed 照算（mock displayUsage 返 -1）
 *   - perSession[].role ∈ {leader,mate,squad}
 *   - 404 squad 不存在
 *   - 500 budgetAggregator 未注入（旧 deps）
 *   - 405 非 GET
 *
 * budgetAggregator 用 mock 注入（不构造真 BudgetAggregator——displayUsage 真逻辑由 T2 UT 覆盖）。
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleBudgetUsageRoute } from '../squad-budget-handler';
import type { SquadHandlerDeps, BudgetAggregatorPort } from '../squad';
import type { BudgetUsage } from '../../squad/budget/budget-aggregator';
import { createSquadService } from '../../services/squad-service';
import { SquadStore, MemberStore } from '../../stores/squad-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';

let tmpRoot: string;
let sessionStore: SessionStore;
let squadId: string;
let displayUsageMock: ReturnType<typeof vi.fn>;
let deps: SquadHandlerDeps;

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-handler-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore().mount('session', fsEngine).mount('transcript', fsEngine)
    .mount('summary', fsEngine).mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  const squadStore = new SquadStore({ root: tmpRoot });
  const memberStore = new MemberStore({ root: tmpRoot });
  const created = await createSquadService(
    { sessionStore, squadStore, memberStore, dataDir: tmpRoot },
    { name: 'b1', modelDefault: 'm', leader: { name: 'lead' } },
  );
  squadId = created.squad.id;
  displayUsageMock = vi.fn();
  const agg: BudgetAggregatorPort = { displayUsage: displayUsageMock };
  deps = { sessionStore, dataDir: tmpRoot, budgetAggregator: agg };
});

afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

async function jsonBody(r: Response): Promise<any> { return JSON.parse(await r.text()); }

function fakeUsage(over: Partial<BudgetUsage> = {}): BudgetUsage {
  return {
    squadId,
    limit: 5000,
    window: 'daily',
    consumed: 1200,
    remaining: 3800,
    windowStart: '2026-06-29T00:00:00.000Z',
    windowEnd: '2026-06-30T00:00:00.000Z',
    perSession: [
      { sessionId: 'sess-leader', role: 'leader', consumed: 700 },
      { sessionId: 'sess-mate', role: 'mate', consumed: 300 },
      { sessionId: 'sess-squad', role: 'squad', consumed: 200 },
    ],
    timezone: 'Asia/Shanghai',
    ...over,
  };
}

describe('BudgetHandler — GET /budget/usage（api §4）', () => {
  it('200 + BudgetUsage 全字段', async () => {
    displayUsageMock.mockResolvedValue(fakeUsage());
    const r = await handleBudgetUsageRoute(new Request(`http://t/squad/${squadId}/budget/usage`),
      'GET', `/squad/${squadId}/budget/usage`, deps);
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b).toMatchObject({
      squadId, limit: 5000, window: 'daily', consumed: 1200, remaining: 3800, timezone: 'Asia/Shanghai',
    });
    expect(b.windowStart).toBe('2026-06-29T00:00:00.000Z');
    expect(b.windowEnd).toBe('2026-06-30T00:00:00.000Z');
    expect(b.perSession).toHaveLength(3);
  });

  it('perSession[].role ∈ {leader,mate,squad}', async () => {
    displayUsageMock.mockResolvedValue(fakeUsage());
    const r = await handleBudgetUsageRoute(new Request(`http://t/squad/${squadId}/budget/usage`),
      'GET', `/squad/${squadId}/budget/usage`, deps);
    const b = await jsonBody(r);
    for (const p of b.perSession) {
      expect(['leader', 'mate', 'squad']).toContain(p.role);
    }
  });

  it('budget=null → limit=-1/remaining=-1 consumed 仍算', async () => {
    displayUsageMock.mockResolvedValue(fakeUsage({ limit: -1, remaining: -1, consumed: 1200 }));
    const r = await handleBudgetUsageRoute(new Request(`http://t/squad/${squadId}/budget/usage`),
      'GET', `/squad/${squadId}/budget/usage`, deps);
    const b = await jsonBody(r);
    expect(b.limit).toBe(-1);
    expect(b.remaining).toBe(-1);
    expect(b.consumed).toBe(1200);
  });

  it('displayUsage 收到 new Date() + squadId', async () => {
    displayUsageMock.mockResolvedValue(fakeUsage());
    await handleBudgetUsageRoute(new Request(`http://t/squad/${squadId}/budget/usage`),
      'GET', `/squad/${squadId}/budget/usage`, deps);
    expect(displayUsageMock).toHaveBeenCalledTimes(1);
    expect(displayUsageMock.mock.calls[0]![0]).toBe(squadId);
    expect(displayUsageMock.mock.calls[0]![1]).toBeInstanceOf(Date);
  });

  it('404 squad 不存在', async () => {
    const r = await handleBudgetUsageRoute(new Request('http://t/squad/bogus/budget/usage'),
      'GET', '/squad/bogus/budget/usage', deps);
    expect(r.status).toBe(404);
    expect(displayUsageMock).not.toHaveBeenCalled();
  });

  it('500 budgetAggregator 未注入（旧 deps）', async () => {
    const noAggDeps: SquadHandlerDeps = { sessionStore, dataDir: tmpRoot };
    const r = await handleBudgetUsageRoute(new Request(`http://t/squad/${squadId}/budget/usage`),
      'GET', `/squad/${squadId}/budget/usage`, noAggDeps);
    expect(r.status).toBe(500);
  });

  it('500 displayUsage 抛错（聚合内部失败）', async () => {
    displayUsageMock.mockRejectedValue(new Error('compute blew up'));
    const r = await handleBudgetUsageRoute(new Request(`http://t/squad/${squadId}/budget/usage`),
      'GET', `/squad/${squadId}/budget/usage`, deps);
    expect(r.status).toBe(500);
    const b = await jsonBody(r);
    expect(b.error).toContain('compute budget usage failed');
  });

  it('405 非 GET', async () => {
    const r = await handleBudgetUsageRoute(new Request(`http://t/squad/${squadId}/budget/usage`, { method: 'POST' }),
      'POST', `/squad/${squadId}/budget/usage`, deps);
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET');
  });
});
