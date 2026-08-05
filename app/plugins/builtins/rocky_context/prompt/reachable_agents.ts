/**
 * builtin rocky_context plugin — system_reminder provider: reachable_agents
 * 参考: specs/tech/version_logs/v0.0.33.2/change_log.md §2.D 改动3（D7 reachable_agents 走 reminder）
 *       specs/tech/squad/[P1]prompt_sections.md §5（volatile reminder + 派生表 + user 永不在）
 *       specs/tech/multi_agent/[P1]a2a_protocol.md §2（AgentRef）+ §3（reachable_agents 派生表 1:1）
 *       specs/tech/agent/context/[P0]system_reminder.md §3（provider EP）
 *
 * 职责：贡献 reachable_agents reminder（每 turn 派生，注入最后一条 user message，保 system prompt cache）。
 * 为什么走 reminder 而非 system_prompt（D7）：reachable_agents 在 hire/bench/edit 后即变，放 system_prompt
 * 破 cache；放 reminder 只影响该 turn，system prompt cache 保留。
 *
 * 派生表（与 a2a §3 1:1，硬约束：user 永不在任何列表）：
 *   squad    → [leader, ...all mates]（群聊路由对端；squad 自身即 squadchat 不含自己）
 *   leader   → [squadchat, ...all mates]（协调；不含自己）
 *   mate     → [squadchat, leader, ...peers]（peer = 同 squad 其他 mate，不含自己）
 *   subagent → [parent]（拓扑硬约束仅 parent）
 *   standalone（!sessionType）→ []（顶层独立 session 无 a2a 对端）
 *
 * 数据源：config.studioContext.squad（leaderId/memberIds/squadChatSessionId）+ members 批量；
 * subagent 读 config.agentToolContext.parent（parent AgentRef，含 type/name/sessionId）。
 * benched（下岗）成员不可达（判据 state !== 'benched'；state 缺失按 deployed 兼容旧数据）——
 * bench 无心跳不运行，列为 send_message 对端无意义。
 * EP: system_reminder，tier=info。
 */
import { ContextImplBase, type ReminderCtx, type SystemReminder, type SystemReminderProvider } from '../types';
import { readSessionType } from './squad_reminder_shared';

/** a2a §2 AgentRef（不含 user —— user 不在 a2a 拓扑里） */
interface AgentRef {
  type: 'leader' | 'mate' | 'subagent' | 'squad';
  sessionId: string;
  name: string;
}

/** member entity 摘要（派生用） */
interface MemberRef {
  id: string;
  name: string;
  role: string;
  sessionId: string;
  /** 成员状态（deployed|benched）；缺省按 deployed 对待（兼容无 state 的旧数据） */
  state?: string;
}

/**
 * reachable_agents reminder provider：按 sessionType 派生对端列表（user 永不在）。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4）。
 */
export default class ReachableAgentsReminderProvider
  extends ContextImplBase
  implements SystemReminderProvider
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  provide(ctx: ReminderCtx): SystemReminder[] {
    const sessionType = readSessionType(ctx);
    // standalone（!sessionType）→ 无 a2a 对端
    if (!sessionType) return [];
    const refs = derive(sessionType, ctx);
    if (refs.length === 0) return [];
    const content = formatReachable(refs);
    return [{ id: 'reachable_agents', tier: 'info', content }];
  }
}


/** 按 a2a §3 表派生 reachable_agents（user 永不在） */
function derive(sessionType: string, ctx: ReminderCtx): AgentRef[] {
  // subagent → [parent]（拓扑硬约束）
  if (sessionType === 'subagent') return deriveSubagent(ctx);
  // squad/leader/mate → 从 squad entity + members 派生
  return deriveSquadScoped(sessionType, ctx);
}

/** subagent：读 parent AgentRef（agentToolContext.parent 已 canonical 化） */
function deriveSubagent(ctx: ReminderCtx): AgentRef[] {
  const atc = (ctx.config as { agentToolContext?: { parentSessionId?: unknown; parent?: unknown } })
    .agentToolContext;
  if (!atc) return [];
  // 优先 parent AgentRef（含 type/name）；兜底仅 parentSessionId
  const parent = readAgentRef(atc.parent);
  if (parent) return [parent];
  const sid = typeof atc.parentSessionId === 'string' ? atc.parentSessionId : '';
  return sid ? [{ type: 'subagent', sessionId: sid, name: 'parent' }] : [];
}

/** squad/leader/mate：按 squad entity + members 派生 */
function deriveSquadScoped(sessionType: string, ctx: ReminderCtx): AgentRef[] {
  const sc = (ctx.config as {
    studioContext?: {
      squad?: { leaderId?: unknown; memberIds?: unknown; squadChatSessionId?: unknown };
      members?: unknown;
    };
    memberId?: unknown;
  }).studioContext;
  const squad = sc?.squad;
  if (!squad) return [];

  const members = readMembers(sc);
  const selfMemberId = readSelfMemberId(ctx);
  const squadChatSid = typeof squad.squadChatSessionId === 'string' ? squad.squadChatSessionId : '';
  const squadChatRef: AgentRef | null = squadChatSid
    ? { type: 'squad', sessionId: squadChatSid, name: 'SquadChat' }
    : null;

  const leader = members.find((m) => m.role === 'leader') ?? null;
  const leaderRef = leader ? toRef(leader, 'leader') : null;
  // peers = 所有 mate（排除当前 member 自己；squad sessionType 无 self member → 全含）
  const peerRefs = members
    .filter((m) => m.role === 'mate' && (!selfMemberId || m.id !== selfMemberId))
    .map((m) => toRef(m, 'mate'));

  if (sessionType === 'squad') {
    // squad = 群聊路由器，自身即 squadchat → 列 [leader, ...all mates]（不含 squadchat）
    return compact([leaderRef, ...peerRefs]);
  }
  if (sessionType === 'leader') {
    // leader → [squadchat, ...mates]（不含 leader 自己）
    return compact([squadChatRef, ...peerRefs]);
  }
  // mate → [squadchat, leader, ...peers]（不含 mate 自己，已 filter）
  return compact([squadChatRef, leaderRef, ...peerRefs]);
}

/** 读 members 批量（bootstrap 注入完整花名册；兜底空）。benched 成员单点过滤于此（派生表自动收缩） */
function readMembers(sc: {
  members?: unknown;
}): MemberRef[] {
  const arr = sc.members;
  if (!Array.isArray(arr)) return [];
  return arr
    .map(readMemberRef)
    .filter((r): r is MemberRef => r !== null)
    .filter((r) => r.state !== 'benched');
}

/** duck-typed 读单条 member entity → MemberRef（state 缺失不丢整条） */
function readMemberRef(raw: unknown): MemberRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as { id?: unknown; name?: unknown; role?: unknown; sessionId?: unknown; state?: unknown };
  const id = typeof m.id === 'string' ? m.id : '';
  const name = typeof m.name === 'string' ? m.name : '';
  const role = typeof m.role === 'string' ? m.role : '';
  const sessionId = typeof m.sessionId === 'string' ? m.sessionId : '';
  const state = typeof m.state === 'string' ? m.state : undefined;
  if (!name && !sessionId) return null;
  return { id, name, role, sessionId, ...(state ? { state } : {}) };
}

/** 读 self member id（leader/mate 排除自己用） */
function readSelfMemberId(ctx: ReminderCtx): string | undefined {
  const mid = (ctx.config as { memberId?: unknown }).memberId;
  return typeof mid === 'string' ? mid : undefined;
}

/** duck-typed 读 AgentRef（parent 已 canonical 化，含 type/name/sessionId） */
function readAgentRef(raw: unknown): AgentRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { type?: unknown; sessionId?: unknown; name?: unknown };
  const type = typeof r.type === 'string' ? r.type : '';
  const sessionId = typeof r.sessionId === 'string' ? r.sessionId : '';
  if (!sessionId) return null;
  if (type !== 'leader' && type !== 'mate' && type !== 'subagent' && type !== 'squad') return null;
  const name = typeof r.name === 'string' ? r.name : '';
  return { type, sessionId, name };
}

/** MemberRef → AgentRef（role 即 type，leader|mate 均 a2a 合法 type） */
function toRef(m: MemberRef, type: 'leader' | 'mate'): AgentRef {
  return { type, sessionId: m.sessionId, name: m.name };
}

/** 过滤 null */
function compact<T>(arr: Array<T | null>): T[] {
  return arr.filter((x): x is T => x !== null);
}

/** 渲染 reachable_agents 板块（a2a §3 格式） */
function formatReachable(refs: AgentRef[]): string {
  const lines = refs.map((r) => `- ${r.name} (${r.type}, sessionId: ${r.sessionId})`);
  return `[Reachable agents — you can \`send_message\` to:]\n${lines.join('\n')}`;
}
