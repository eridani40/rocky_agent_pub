/**
 * squad_team_status reminder provider UT（[v0.0.116] 新增）
 * 参考: specs/tech/squad/[P1]squad_reminder_providers.md §4.6（squad_team_status）
 *       specs/tech/version_logs/v0.0.116/change_plan-part2.md §7
 *
 * 覆盖：
 *   1. leader + 1 running 成员 + currentWork → 产出含 presence 文本的 reminder
 *   2. leader + 无 running 成员 → 产出「当前无成员在活跃工作」提示
 *   3. mate（非 leader）→ []（角色 filter）
 *   4. squad-chat（non-leader）→ []
 *   5. standalone（无 kind/sessionType）→ []
 *   6. 无 squadContext → []
 *   7. 无 squadId → []
 *   8. running 成员 currentWork=null → 显示「（未标记）」
 *   9. 仅 running 成员产出，非 running 不出（isSessionRunning=false）
 *   10. reminder id=squad_team_status，tier=info
 */
import { describe, it, expect } from 'vitest';
import SquadTeamStatusReminderProvider from '../squad_team_status';

import type { ReminderCtx, SquadContextService } from '../../types';

// ── helpers ─────────────────────────────────────────────────────────

interface FakeMember {
  id: string;
  sessionId?: string;
  name: string;
  role: string;
  currentWork?: { text: string; updatedAt: string } | null;
}

/**
 * 构造 ReminderCtx：config.kind 决定 readSessionType；squadContext mock 可控。
 */
function mkCtx(over: {
  sessionType?: string;
  squadId?: string;
  members?: FakeMember[];
  runningSessionIds?: string[];
  noSquadContext?: boolean;
}): ReminderCtx {
  const st = over.sessionType ?? 'leader';
  const isSubagent = st === 'subagent';
  const isStudio = ['leader', 'mate', 'squad'].includes(st);
  const kind = { role: st, isSubagent, isStudio };

  const config: Record<string, unknown> = { modelId: 'm', kind };
  if (over.squadId !== undefined) config.squadId = over.squadId;

  if (over.noSquadContext) {
    return { config } as unknown as ReminderCtx;
  }

  const members = over.members ?? [];
  const runningIds = new Set(over.runningSessionIds ?? []);

  const squadContext: SquadContextService = {
    getSquad: async () => null,
    listMembers: async () => members,
    listGoals: async () => [],
    listRequirements: async () => [],
    listTasks: async () => [],
    isSessionRunning: async (sessionId: string) => runningIds.has(sessionId),
  };

  return { config, squadContext } as unknown as ReminderCtx;
}

function mk(): SquadTeamStatusReminderProvider {
  return new SquadTeamStatusReminderProvider('squad_team_status', {});
}

// ── 正常路径 ────────────────────────────────────────────────────────

describe('squad_team_status provider — 正常路径', () => {
  it('leader + 1 running 成员 + currentWork → 产出含 presence 文本的 reminder', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      squadId: 'SQ-1',
      members: [{ id: 'M-1', sessionId: 'SID-1', name: 'alice', role: 'mate', currentWork: { text: '正在写 UT', updatedAt: '2026-01-01T00:00:00.000Z' } }],
      runningSessionIds: ['SID-1'],
    }));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('squad_team_status');
    expect(out[0]!.tier).toBe('info');
    expect(out[0]!.content).toContain('alice');
    expect(out[0]!.content).toContain('正在写 UT');
  });

  it('leader + 多 running 成员 → 多行（各自 presence）', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      squadId: 'SQ-1',
      members: [
        { id: 'M-1', sessionId: 'SID-1', name: 'alice', role: 'mate', currentWork: { text: '写代码', updatedAt: '' } },
        { id: 'M-2', sessionId: 'SID-2', name: 'bob', role: 'mate', currentWork: { text: '看文档', updatedAt: '' } },
      ],
      runningSessionIds: ['SID-1', 'SID-2'],
    }));
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('alice');
    expect(out[0]!.content).toContain('bob');
  });

  it('leader + 无 running 成员 → 产出「当前无成员在活跃工作」提示', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      squadId: 'SQ-1',
      members: [{ id: 'M-1', sessionId: 'SID-1', name: 'alice', role: 'mate', currentWork: null }],
      runningSessionIds: [],
    }));
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('当前无成员在活跃工作');
  });

  it('running 成员 currentWork=null → 显示「（未标记）」', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      squadId: 'SQ-1',
      members: [{ id: 'M-1', sessionId: 'SID-1', name: 'alice', role: 'mate', currentWork: null }],
      runningSessionIds: ['SID-1'],
    }));
    expect(out[0]!.content).toContain('（未标记）');
  });

  it('仅 running 成员产出，非 running 不出（isSessionRunning=false）', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      squadId: 'SQ-1',
      members: [
        { id: 'M-1', sessionId: 'SID-1', name: 'alice', role: 'mate', currentWork: { text: '工作中', updatedAt: '' } },
        { id: 'M-2', sessionId: 'SID-2', name: 'bob', role: 'mate', currentWork: { text: '也在工作', updatedAt: '' } },
      ],
      runningSessionIds: ['SID-1'],  // 只有 SID-1 running
    }));
    expect(out[0]!.content).toContain('alice');
    expect(out[0]!.content).not.toContain('bob');
  });
});

// ── 角色 filter ──────────────────────────────────────────────────────

describe('squad_team_status provider — 角色 filter（仅 leader）', () => {
  it('mate（非 leader）→ []', async () => {
    const out = await mk().provide(mkCtx({ sessionType: 'mate', squadId: 'SQ-1' }));
    expect(out).toEqual([]);
  });

  it('squad-chat（role=squad）→ []', async () => {
    const out = await mk().provide(mkCtx({ sessionType: 'squad', squadId: 'SQ-1' }));
    expect(out).toEqual([]);
  });

  it('standalone（无 kind，sessionType=undefined）→ []', async () => {
    // standalone 无 kind → readSessionType 返 undefined → filter
    const ctx: ReminderCtx = {
      config: { modelId: 'm', squadId: 'SQ-1' },
      squadContext: {
        getSquad: async () => null,
        listMembers: async () => [],
        listGoals: async () => [],
        listRequirements: async () => [],
        listTasks: async () => [],
        isSessionRunning: async () => false,
      },
    } as unknown as ReminderCtx;
    const out = await mk().provide(ctx);
    expect(out).toEqual([]);
  });

  it('subagent → []', async () => {
    const out = await mk().provide(mkCtx({ sessionType: 'subagent', squadId: 'SQ-1' }));
    expect(out).toEqual([]);
  });
});

// ── 缺失字段防御 ────────────────────────────────────────────────────

describe('squad_team_status provider — 缺失字段防御', () => {
  it('无 squadContext → []', async () => {
    const out = await mk().provide(mkCtx({ sessionType: 'leader', squadId: 'SQ-1', noSquadContext: true }));
    expect(out).toEqual([]);
  });

  it('无 squadId → []', async () => {
    // 不传 squadId
    const out = await mk().provide(mkCtx({ sessionType: 'leader', members: [] }));
    expect(out).toEqual([]);
  });

  it('成员无 sessionId → 跳过该成员（不 crash）', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      squadId: 'SQ-1',
      members: [{ id: 'M-1', name: 'alice', role: 'mate', currentWork: null }],  // 无 sessionId
      runningSessionIds: [],
    }));
    expect(out).toHaveLength(1);
    // alice 无 sessionId 跳过 → 无 running → 无成员在活跃工作
    expect(out[0]!.content).toContain('当前无成员在活跃工作');
  });
});
