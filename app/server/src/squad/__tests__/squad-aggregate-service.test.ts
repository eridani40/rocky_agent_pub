/**
 * squad-aggregate-service 单元测试（v0.0.305 T1）
 * 参考: specs/tech/version_logs/v0.0.305.squad-list-ui-upgrade/architecture.md D2（聚合口径）
 *       specs/api/overall/11a-squad-endpoints.md §1.2（SquadSummary 增量字段）
 *
 * 覆盖：
 *   - aggregateFromViews 纯函数：onlineCount=deployed 数 / inProgressCount=直连 session
 *     busy 数（含 suspended）/ lastActiveAt=max(session.updatedAt) ?? squad.updatedAt
 *   - 只认 squadChatSessionId + members[].sessionId 直连集合（subagent 派生会话不混入）
 *   - 空 session 集合 fallback squad.updatedAt
 *   - computeSquadAggregates 批量：一次 listSessions 全量分组 + 单 squad 失败降级跳过
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect } from 'vitest';
import type { Session } from '../../agent/session-store-types';
import type { SquadEntity, MemberEntity } from '../../stores/squad-store';
import { aggregateFromViews, computeSquadAggregates } from '../squad-aggregate-service';
import type { SquadAggregateDeps } from '../squad-aggregate-service';

function mkSquad(over: Partial<SquadEntity> = {}): SquadEntity {
  return {
    id: 'sq-1', name: 's1', description: null, modelDefault: 'm', leaderId: 'ld',
    memberIds: [], squadChatSessionId: 'chat-1', enableHeartBeat: false,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', version: 1,
    ...over,
  } as SquadEntity;
}

function mkMember(over: Partial<MemberEntity> = {}): MemberEntity {
  return {
    id: 'mb-1', squadId: 'sq-1', sessionId: 'sess-1', name: 'm1', role: 'mate',
    state: 'deployed', createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z', version: 1,
    ...over,
  } as MemberEntity;
}

function mkSession(id: string, state: Session['state'], updatedAt: string): Session {
  return {
    id, state, running: state === 'running' || state === 'interrupting',
    status: 'active', unread: false, currentRunId: null, updatedAt,
  } as Session;
}

describe('aggregateFromViews — 纯函数聚合口径（architecture D2）', () => {
  it('onlineCount = members state===\'deployed\' 数（benched 不计）', () => {
    const squad = mkSquad();
    const members = [
      mkMember({ id: 'a', sessionId: 'sa', state: 'deployed' }),
      mkMember({ id: 'b', sessionId: 'sb', state: 'deployed' }),
      mkMember({ id: 'c', sessionId: 'sc', state: 'benched' }),
    ];
    const agg = aggregateFromViews(squad, members, new Map());
    expect(agg.onlineCount).toBe(2);
  });

  it('inProgressCount = 直连 session（squadChat + members）state∈{running,interrupting,suspended} 数', () => {
    const squad = mkSquad();
    const members = [
      mkMember({ id: 'a', sessionId: 'sa' }),
      mkMember({ id: 'b', sessionId: 'sb' }),
      mkMember({ id: 'c', sessionId: 'sc' }),
    ];
    const sessionMap = new Map<string, Session>([
      ['chat-1', mkSession('chat-1', 'idle', '2026-08-01T01:00:00.000Z')],
      ['sa', mkSession('sa', 'running', '2026-08-01T02:00:00.000Z')],
      ['sb', mkSession('sb', 'suspended', '2026-08-01T03:00:00.000Z')],
      ['sc', mkSession('sc', 'idle', '2026-08-01T04:00:00.000Z')],
    ]);
    const agg = aggregateFromViews(squad, members, sessionMap);
    expect(agg.inProgressCount).toBe(2); // running + suspended
  });

  it('lastActiveAt = 直连 session updatedAt 最大值（interrupting 也算 busy 且推进 lastActiveAt）', () => {
    const squad = mkSquad();
    const members = [mkMember({ id: 'a', sessionId: 'sa' })];
    const sessionMap = new Map<string, Session>([
      ['chat-1', mkSession('chat-1', 'idle', '2026-08-01T01:00:00.000Z')],
      ['sa', mkSession('sa', 'interrupting', '2026-08-01T09:30:00.000Z')],
    ]);
    const agg = aggregateFromViews(squad, members, sessionMap);
    expect(agg.inProgressCount).toBe(1);
    expect(agg.lastActiveAt).toBe('2026-08-01T09:30:00.000Z');
  });

  it('subagent 派生会话（squadId 匹配但不在直连集合）不混入计数', () => {
    const squad = mkSquad();
    const members = [mkMember({ id: 'a', sessionId: 'sa' })];
    // subagent 会话：id 不在直连集合，但同样 squadId（模拟 squadId 全匹配会多算的场景）
    const sessionMap = new Map<string, Session>([
      ['chat-1', mkSession('chat-1', 'idle', '2026-08-01T01:00:00.000Z')],
      ['sa', mkSession('sa', 'idle', '2026-08-01T02:00:00.000Z')],
      ['sub-1', mkSession('sub-1', 'running', '2026-08-01T09:00:00.000Z')],
    ]);
    const agg = aggregateFromViews(squad, members, sessionMap);
    expect(agg.inProgressCount).toBe(0);
    expect(agg.lastActiveAt).toBe('2026-08-01T02:00:00.000Z');
  });

  it('空 session 集合（全缺失）→ lastActiveAt fallback squad.updatedAt（恒有值可排序）', () => {
    const squad = mkSquad({ updatedAt: '2026-08-01T05:00:00.000Z' });
    const agg = aggregateFromViews(squad, [], new Map());
    expect(agg.onlineCount).toBe(0);
    expect(agg.inProgressCount).toBe(0);
    expect(agg.lastActiveAt).toBe('2026-08-01T05:00:00.000Z');
    expect(agg.squadId).toBe('sq-1');
  });

  it('session 在 map 但不在直连集合（member 无 sessionId）不计数', () => {
    const squad = mkSquad();
    const members = [mkMember({ id: 'a', sessionId: undefined })];
    const sessionMap = new Map<string, Session>([
      ['chat-1', mkSession('chat-1', 'idle', '2026-08-01T01:00:00.000Z')],
      ['other', mkSession('other', 'running', '2026-08-01T09:00:00.000Z')],
    ]);
    const agg = aggregateFromViews(squad, members, sessionMap);
    expect(agg.inProgressCount).toBe(0);
    expect(agg.lastActiveAt).toBe('2026-08-01T01:00:00.000Z');
  });
});

describe('computeSquadAggregates — 批量聚合（一次 listSessions 全量，避免 N+1）', () => {
  it('多个 squad 一次聚合：sessions 按 squadId 内存分组', async () => {
    const deps: SquadAggregateDeps = {
      sessionStore: {
        listSessions: async () => [
          mkSession('chat-1', 'idle', '2026-08-01T01:00:00.000Z'),
          mkSession('sa', 'running', '2026-08-01T02:00:00.000Z'),
          mkSession('chat-2', 'suspended', '2026-08-01T03:00:00.000Z'),
          mkSession('sb', 'idle', '2026-08-01T04:00:00.000Z'),
        ].map((s) => ({ ...s, squadId: s.id.startsWith('chat-1') || s.id === 'sa' ? 'sq-1' : 'sq-2' })),
      } as never,
      squadStore: {
        getSquad: async (id: string) => (id === 'sq-1' ? mkSquad({ id: 'sq-1' }) : mkSquad({ id: 'sq-2', squadChatSessionId: 'chat-2' })),
      } as never,
      memberStore: {
        listMembers: async (id: string) => (id === 'sq-1'
          ? [mkMember({ id: 'a', sessionId: 'sa', state: 'deployed' })]
          : [mkMember({ id: 'b', sessionId: 'sb', state: 'deployed' })]),
      } as never,
    };

    const result = await computeSquadAggregates(deps, ['sq-1', 'sq-2']);
    expect(result.size).toBe(2);
    expect(result.get('sq-1')!.inProgressCount).toBe(1); // sa running
    expect(result.get('sq-1')!.onlineCount).toBe(1);
    expect(result.get('sq-2')!.inProgressCount).toBe(1); // chat-2 suspended
    expect(result.get('sq-2')!.lastActiveAt).toBe('2026-08-01T04:00:00.000Z');
  });

  it('squad 不存在（并发删除）→ 跳过不报错', async () => {
    const deps: SquadAggregateDeps = {
      sessionStore: { listSessions: async () => [] } as never,
      squadStore: { getSquad: async () => undefined } as never,
      memberStore: { listMembers: async () => [] } as never,
    };
    const result = await computeSquadAggregates(deps, ['gone-1']);
    expect(result.size).toBe(0);
  });

  it('单个 squad 聚合异常（listMembers 抛错）→ 降级跳过该 squad，不影响其他', async () => {
    const deps: SquadAggregateDeps = {
      sessionStore: { listSessions: async () => [] } as never,
      squadStore: { getSquad: async (id: string) => (id === 'bad' ? mkSquad({ id: 'bad' }) : mkSquad({ id: 'ok' })) } as never,
      memberStore: {
        listMembers: async (id: string) => {
          if (id === 'bad') throw new Error('member boom');
          return [mkMember({ id: 'a', sessionId: 'sa' })];
        },
      } as never,
    };
    const result = await computeSquadAggregates(deps, ['bad', 'ok']);
    expect(result.size).toBe(1);
    expect(result.has('bad')).toBe(false);
    expect(result.get('ok')).toBeDefined();
  });

  it('空 squadIds → 直接返回空 Map（不调 store）', async () => {
    let called = false;
    const deps: SquadAggregateDeps = {
      sessionStore: { listSessions: async () => { called = true; return []; } } as never,
      squadStore: {} as never,
      memberStore: {} as never,
    };
    const result = await computeSquadAggregates(deps, []);
    expect(result.size).toBe(0);
    expect(called).toBe(false);
  });
});
