/**
 * studio-page 测试夹具 —— 构造 mock Member / SquadDetail / SquadSummary
 * （非 .test 文件，vitest 不当 suite 跑；供各组件单测复用，避免重复样板）
 */
import type { Member, SquadDetail, SquadSummary } from '../squad-types';

/** 构造一个 mock member */
export function mkMember(over: Partial<Member> = {}): Member {
  return {
    id: 'm1',
    squadId: 's1',
    sessionId: 'sess-m1',
    name: '张三',
    intro: '负责单元测试', // [v0.0.114] 一句话介绍（Team Roster）
    role: 'mate',
    tools: ['file', 'bash'],
    skillConfig: { mode: 'inherit', overrides: {} },
    // [v0.0.155] member.model 字段已硬删（A4：member 退管理概念，运行配置跟 session）
    state: 'deployed',
    version: 1,
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    ...over,
  };
}

/** 构造一个 mock squad detail（含 leader + 一个 mate） */
export function mkDetail(over: Partial<SquadDetail> = {}): SquadDetail {
  const leader = mkMember({ id: 'leader1', name: 'Rocky', role: 'leader', sessionId: 'sess-leader' });
  const mate = mkMember({ id: 'm2', name: '张三', role: 'mate', sessionId: 'sess-m2' });
  return {
    id: 's1',
    name: 'Alpha 小队',
    description: '负责 Auth 与核心服务',
    modelDefault: 'claude-sonnet',
    effortDefault: 'default',
    leaderId: 'leader1',
    memberIds: ['leader1', 'm2'],
    members: [leader, mate],
    squadChatSessionId: 'sess-group',
    budget: null,
    enableHeartBeat: false,
    enableGroupChat: true,
    timezone: 'Asia/Shanghai',
    version: 1,
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    ...over,
  };
}

/** 构造 squad summary */
export function mkSummary(over: Partial<SquadSummary> = {}): SquadSummary {
  return {
    id: 's1',
    name: 'Alpha 小队',
    description: '负责 Auth 与核心服务',
    modelDefault: 'claude-sonnet',
    leaderId: 'leader1',
    memberCount: 2,
    squadChatSessionId: 'sess-group',
    enableHeartBeat: false,
    enableGroupChat: true,
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    ...over,
  };
}
