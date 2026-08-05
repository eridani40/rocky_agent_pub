/**
 * BudgetAggregator 单测（白盒，注入 now + mock deps）
 * 参考: specs/tech/squad/[P1]scheduler.md §5（budget helper 契约 + Display/Gate 分离）
 *       specs/api/version_logs/v0.0.33.4/change_log.md §4（BudgetUsage schema）
 *       states/v0.0.33.4/verify/test-plan.md §2 budget-aggregator UT（P5 跨日回血）
 *
 * 覆盖：
 *   - 横向 Σ team sessions total.total_tokens（leader/mate + squadChat）
 *   - daily 窗口分桶按 squad.timezone（注入 now 跨 0 点 → 窗口切换 consumed 重置[P5]）
 *   - budget=null → limit=-1/remaining=-1 consumed 仍算（Display）
 *   - squadBudgetRemaining（Gate）假设 budget!==null，被 null 调用则抛错
 *   - perSession 明细 role/consumed
 *   - startOfDayInTz / nextDayStartInTz（UTC+8 / 跨日 / DST 无关单 tz）
 */
import { describe, it, expect } from 'vitest';
import {
  BudgetAggregator,
  startOfDayInTz,
  nextDayStartInTz,
  type BudgetAggregatorDeps,
  type SquadBudgetConfig,
} from '../budget-aggregator';
import type { SquadEntity, MemberEntity } from '../../../stores/squad-store';

// ── fixture helpers ──────────────────────────────────────────────────────

/** 构造 squad entity（含信封；timezone 为 T5 字段，此处前向兼容注入） */
function makeSquad(opts: {
  id?: string;
  budget?: SquadBudgetConfig | null;
  squadChatSessionId?: string;
  timezone?: string;
}): SquadEntity {
  return {
    id: opts.id ?? 'SQUAD-1',
    name: 'alpha',
    description: '',
    modelDefault: 'm1',
    leaderId: 'MID-LEADER',
    memberIds: ['MID-LEADER', 'MID-MATE-1', 'MID-MATE-2'],
    squadChatSessionId: opts.squadChatSessionId ?? 'SID-SC',
    charter: { goals: '', workingStyle: '', collaboration: '', escalation: '' },
    budget: opts.budget ?? null,
    enableHeartBeat: false,
    // T5 字段前向兼容（schema 未声明，cast 注入；BudgetAggregator 经 cast 读取）
    timezone: opts.timezone ?? 'Asia/Shanghai',
    // 信封字段
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    version: 1,
  } as unknown as SquadEntity;
}

/** 构造 member entity */
function makeMember(opts: {
  id: string;
  sessionId: string;
  role: 'leader' | 'mate';
  name?: string;
}): MemberEntity {
  return {
    id: opts.id,
    squadId: 'SQUAD-1',
    sessionId: opts.sessionId,
    name: opts.name ?? opts.id,
    role: opts.role,
    tools: [],
    skills: [],
    model: 'm1',
    state: 'deployed',
  } as unknown as MemberEntity;
}

/** 默认 team：leader + 2 mates + squadChat */
function defaultMembers(): MemberEntity[] {
  return [
    makeMember({ id: 'MID-LEADER', sessionId: 'SID-LEADER', role: 'leader', name: 'Alice' }),
    makeMember({ id: 'MID-MATE-1', sessionId: 'SID-MATE-1', role: 'mate', name: 'Bob' }),
    makeMember({ id: 'MID-MATE-2', sessionId: 'SID-MATE-2', role: 'mate', name: 'Carol' }),
  ];
}

/** 构造 BudgetAggregator with mock deps；getUsageTotalTokens 可定制 */
function makeAggregator(opts: {
  squad: SquadEntity;
  members?: MemberEntity[];
  usageBySession?: Record<string, number>;
  /** 覆盖 usageBySession（用于 daily 窗口分桶测试） */
  getUsageTotalTokens?: (sid: string, windowStart: Date) => Promise<number>;
}): BudgetAggregator {
  const defaultUsage: Record<string, number> = {
    'SID-LEADER': 100,
    'SID-MATE-1': 200,
    'SID-MATE-2': 300,
    'SID-SC': 50,
  };
  const usageMap = opts.usageBySession ?? defaultUsage;
  const deps: BudgetAggregatorDeps = {
    squadStore: {
      getSquad: async () => opts.squad,
    },
    memberStore: {
      listMembers: async () => opts.members ?? defaultMembers(),
    },
    getUsageTotalTokens: opts.getUsageTotalTokens ?? (async (sid: string) => usageMap[sid] ?? 0),
  };
  return new BudgetAggregator(deps);
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('BudgetAggregator', () => {
  describe('横向 Σ team sessions total.total_tokens', () => {
    it('Σ = leader + mates + squadChat（默认 100+200+300+50=650）', async () => {
      const agg = makeAggregator({ squad: makeSquad({ budget: { limit: 1000, window: 'daily', scope: 'team' } }) });
      const usage = await agg.displayUsage('SQUAD-1', new Date('2026-06-29T10:00:00Z'));
      expect(usage.consumed).toBe(650);
    });

    it('perSession 明细：role/consumed 对齐 member.role + squadChat=squad', async () => {
      const agg = makeAggregator({ squad: makeSquad({ budget: { limit: 1000, window: 'daily', scope: 'team' } }) });
      const usage = await agg.displayUsage('SQUAD-1', new Date('2026-06-29T10:00:00Z'));
      const map = new Map(usage.perSession.map(p => [p.sessionId, p]));
      expect(map.get('SID-LEADER')).toEqual({ sessionId: 'SID-LEADER', role: 'leader', consumed: 100 });
      expect(map.get('SID-MATE-1')).toEqual({ sessionId: 'SID-MATE-1', role: 'mate', consumed: 200 });
      expect(map.get('SID-MATE-2')).toEqual({ sessionId: 'SID-MATE-2', role: 'mate', consumed: 300 });
      expect(map.get('SID-SC')).toEqual({ sessionId: 'SID-SC', role: 'squad', consumed: 50 });
    });

    it('无 member（仅 squadChat）→ consumed = squadChat 单值', async () => {
      const agg = makeAggregator({
        squad: makeSquad({ budget: { limit: 100, window: 'daily', scope: 'team' } }),
        members: [],
        usageBySession: { 'SID-SC': 42 },
      });
      const usage = await agg.displayUsage('SQUAD-1', new Date('2026-06-29T10:00:00Z'));
      expect(usage.consumed).toBe(42);
      expect(usage.perSession).toHaveLength(1);
      expect(usage.perSession[0]).toEqual({ sessionId: 'SID-SC', role: 'squad', consumed: 42 });
    });
  });

  describe('squadBudgetRemaining（Gate 用，前提 budget!==null）', () => {
    it('limit=1000 consumed=650 → remaining=350', async () => {
      const agg = makeAggregator({ squad: makeSquad({ budget: { limit: 1000, window: 'daily', scope: 'team' } }) });
      const remaining = await agg.squadBudgetRemaining('SQUAD-1', new Date('2026-06-29T10:00:00Z'));
      expect(remaining).toBe(350);
    });

    it('limit=500 consumed=650 → remaining=-150（超限，caller check <=0 即 skip）', async () => {
      const agg = makeAggregator({ squad: makeSquad({ budget: { limit: 500, window: 'daily', scope: 'team' } }) });
      const remaining = await agg.squadBudgetRemaining('SQUAD-1', new Date('2026-06-29T10:00:00Z'));
      expect(remaining).toBe(-150);
    });

    it('budget=null 被调用 → 抛错（caller 须 short-circuit null）', async () => {
      const agg = makeAggregator({ squad: makeSquad({ budget: null }) });
      await expect(
        agg.squadBudgetRemaining('SQUAD-1', new Date('2026-06-29T10:00:00Z')),
      ).rejects.toThrow(/null\/undefined budget/);
    });

    it('squad 不存在 → 抛错', async () => {
      // 覆盖 getSquad 返 undefined 路径
      const agg = new BudgetAggregator({
        squadStore: { getSquad: async () => undefined },
        memberStore: { listMembers: async () => [] },
        getUsageTotalTokens: async () => 0,
      });
      await expect(
        agg.displayUsage('NOPE', new Date('2026-06-29T10:00:00Z')),
      ).rejects.toThrow(/squad not found/);
    });
  });

  describe('Display/Gate 分离（budget=null）', () => {
    it('displayUsage budget=null → limit=-1 remaining=-1 consumed 照算', async () => {
      const agg = makeAggregator({ squad: makeSquad({ budget: null }) });
      const usage = await agg.displayUsage('SQUAD-1', new Date('2026-06-29T10:00:00Z'));
      expect(usage.limit).toBe(-1);
      expect(usage.remaining).toBe(-1);
      // consumed 仍照算（Display 仅展示，不进 gate）
      expect(usage.consumed).toBe(650);
      expect(usage.window).toBe('daily');
      expect(usage.timezone).toBe('Asia/Shanghai');
    });

    it('displayUsage budget 配置 → limit/remaining 正常计算', async () => {
      const agg = makeAggregator({ squad: makeSquad({ budget: { limit: 1000, window: 'daily', scope: 'team' } }) });
      const usage = await agg.displayUsage('SQUAD-1', new Date('2026-06-29T10:00:00Z'));
      expect(usage.limit).toBe(1000);
      expect(usage.remaining).toBe(350);
      expect(usage.consumed).toBe(650);
    });
  });

  describe('daily 窗口分桶按 squad.timezone（P5 跨日回血）', () => {
    it('now 跨 squad.timezone 当日 0 点 → windowStart 切换 → consumed 重置', async () => {
      // Asia/Shanghai UTC+8：当日 0 点 Shanghai = 前一日 16:00 UTC
      // mock：windowStart=06-28 16:00 UTC（= 06-29 SH 当日）→ 返 100/session
      //       windowStart=06-29 16:00 UTC（= 06-30 SH 当日）→ 返 0（已跨日回血重置）
      const callLog: Array<{ sid: string; windowStart: string }> = [];
      const agg = makeAggregator({
        squad: makeSquad({
          budget: { limit: 1000, window: 'daily', scope: 'team' },
          timezone: 'Asia/Shanghai',
        }),
        getUsageTotalTokens: async (sid, windowStart) => {
          const ws = windowStart.toISOString();
          callLog.push({ sid, windowStart: ws });
          if (ws === '2026-06-28T16:00:00.000Z') return 100; // 06-29 SH 当日窗口：未回血，返满额
          if (ws === '2026-06-29T16:00:00.000Z') return 0; // 06-30 SH 当日窗口：已跨日回血
          return 0;
        },
      });

      // tick1：06-29 SH 18:00（= 06-29 10:00 UTC）→ SH 当日=06-29 → 窗口左界=06-28 16:00 UTC
      const usage1 = await agg.displayUsage('SQUAD-1', new Date('2026-06-29T10:00:00Z'));
      // 4 sessions × 100 = 400
      expect(usage1.consumed).toBe(400);
      expect(usage1.windowStart).toBe('2026-06-28T16:00:00.000Z');
      expect(usage1.windowEnd).toBe('2026-06-29T16:00:00.000Z');

      // tick2：06-30 SH 02:00（= 06-29 18:00 UTC）→ SH 当日=06-30 → 窗口左界=06-29 16:00 UTC（跨日切换）
      const usage2 = await agg.displayUsage('SQUAD-1', new Date('2026-06-29T18:00:00Z'));
      // mock 该窗口返 0 → consumed=0（P5 跨日回血，remaining 重置为 limit）
      expect(usage2.consumed).toBe(0);
      expect(usage2.windowStart).toBe('2026-06-29T16:00:00.000Z');
      expect(usage2.windowEnd).toBe('2026-06-30T16:00:00.000Z');
      expect(usage2.remaining).toBe(1000); // limit=1000，consumed=0 → remaining=1000（满血）

      // 验证：同一 squad，now 跨 SH 0 点 → 不同 windowStart → consumed 不同（P5 回血生效）
      expect(usage1.windowStart).not.toBe(usage2.windowStart);
      expect(usage1.consumed).not.toBe(usage2.consumed);

      // callLog 中两种 windowStart 都出现过（跨日分桶生效）
      const windowStarts = new Set(callLog.map(c => c.windowStart));
      expect(windowStarts.has('2026-06-28T16:00:00.000Z')).toBe(true);
      expect(windowStarts.has('2026-06-29T16:00:00.000Z')).toBe(true);
    });

    it('windowStart/windowEnd ISO 对齐 squad.timezone 当日 / 次日 0 点', async () => {
      const agg = makeAggregator({
        squad: makeSquad({ budget: { limit: 1000, window: 'daily', scope: 'team' }, timezone: 'Asia/Shanghai' }),
      });
      // 06-29 10:00 UTC = 06-29 18:00 Shanghai → 当日 = 06-29 → 窗口左界 = 06-28 16:00 UTC
      const usage = await agg.displayUsage('SQUAD-1', new Date('2026-06-29T10:00:00Z'));
      expect(usage.windowStart).toBe('2026-06-28T16:00:00.000Z'); // 06-29 00:00 Shanghai
      expect(usage.windowEnd).toBe('2026-06-29T16:00:00.000Z'); // 06-30 00:00 Shanghai（回血时刻）
      expect(usage.timezone).toBe('Asia/Shanghai');
    });

    it('UTC tz：当日 0 点 = 00:00 UTC（无偏移）', async () => {
      const agg = makeAggregator({
        squad: makeSquad({ budget: { limit: 1000, window: 'daily', scope: 'team' }, timezone: 'UTC' }),
      });
      const usage = await agg.displayUsage('SQUAD-1', new Date('2026-06-29T10:00:00Z'));
      expect(usage.windowStart).toBe('2026-06-29T00:00:00.000Z');
      expect(usage.windowEnd).toBe('2026-06-30T00:00:00.000Z');
    });
  });
});

// ── startOfDayInTz / nextDayStartInTz 纯函数 ────────────────────────────

describe('startOfDayInTz / nextDayStartInTz', () => {
  it('Asia/Shanghai (UTC+8)：当日 0 点 = 前一日 16:00 UTC', () => {
    expect(startOfDayInTz(new Date('2026-06-29T10:00:00Z'), 'Asia/Shanghai').toISOString())
      .toBe('2026-06-28T16:00:00.000Z');
  });

  it('UTC tz：当日 0 点 = 00:00 UTC', () => {
    expect(startOfDayInTz(new Date('2026-06-29T23:59:59Z'), 'UTC').toISOString())
      .toBe('2026-06-29T00:00:00.000Z');
  });

  it('America/New_York：夏令时（EDT UTC-4）vs 标准时（EST UTC-5）当日 0 点偏移', () => {
    // 06-15 夏令时（EDT）：00:00 NY = 04:00 UTC
    expect(startOfDayInTz(new Date('2026-06-15T10:00:00Z'), 'America/New_York').toISOString())
      .toBe('2026-06-15T04:00:00.000Z');
    // 12-15 标准时（EST）：00:00 NY = 05:00 UTC
    expect(startOfDayInTz(new Date('2026-12-15T10:00:00Z'), 'America/New_York').toISOString())
      .toBe('2026-12-15T05:00:00.000Z');
  });

  it('nextDayStartInTz：次日 0 点（windowEnd = 回血时刻）', () => {
    expect(nextDayStartInTz(new Date('2026-06-29T10:00:00Z'), 'Asia/Shanghai').toISOString())
      .toBe('2026-06-29T16:00:00.000Z'); // 06-30 00:00 Shanghai
  });

  it('DST 切换日（03-08 spring forward）：startOfDay 用当日 0 点 offset（EST），次日已切 EDT', () => {
    // 2026-03-08 02:00→03:00 NY spring forward。03-08 12:00 UTC = 08:00 EDT（已切），但当日 0 点 NY 仍是 EST
    // 03-08 00:00 NY = 03-08 05:00 UTC（EST pre-transition）；03-09 00:00 NY = 03-09 04:00 UTC（EDT）
    expect(startOfDayInTz(new Date('2026-03-08T12:00:00Z'), 'America/New_York').toISOString())
      .toBe('2026-03-08T05:00:00.000Z');
    expect(nextDayStartInTz(new Date('2026-03-08T12:00:00Z'), 'America/New_York').toISOString())
      .toBe('2026-03-09T04:00:00.000Z');
  });
});
