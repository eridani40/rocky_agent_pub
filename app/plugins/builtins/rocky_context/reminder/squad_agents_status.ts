/**
 * builtin rocky_context plugin — system_reminder provider: squad_agents_status（[v0.0.273] NEW）
 * 参考: specs/tech/squad/[P1]squad_reminder_providers.md §3/§4（统一全员状态块 [squad:agents]）
 *       specs/tech/squad/[P1]prompt_sections.md §5（volatile reminder + 派生表 + user 永不在）
 *       specs/tech/multi_agent/[P1]a2a_protocol.md §2（AgentRef）+ §3（可达性派生表 1:1）
 *       specs/tech/version_logs/v0.0.273/change_plan.md 裁决 R6-R8
 *
 * 职责：统一全员状态块 `[squad:agents]`——取代旧 reachable_agents（有可达性无状态）+
 * squad_team_status（只列 running）两个 provider（老板 2026-08-07 拍板「统一设计」）。
 * 三合一：agent 列表（可达性 name+sessionId）+ running/idle 状态 + presence 标记。
 *
 * **产出规则（readSessionType 分派，R7）**：
 *   squad    → leader + 全部 mate（群聊路由对端；squad 自身即 squadchat 不含自己）
 *   leader   → SquadChat（enableGroupChat 门控）+ 全部 mate（不含 leader 自己）
 *   mate     → SquadChat（门控）+ leader + peers（peer = 同 squad 其他 mate，不含自己）
 *   subagent → [parent]（拓扑硬约束仅 parent，reachable 语义保持）
 *   standalone（!sessionType）→ []（顶层独立 session 无 a2a 对端）
 *
 * **关键保留**：全员列出（不按 running 过滤——做完的 mate 不消失；idle + presence = 疑似卡住可见）；
 *   benched 过滤（state !== 'benched'；state 缺失按 deployed 兼容旧数据）；270 enableGroupChat 门控
 *   （SquadChat 行随门控显隐）；mate 对端可达性不丢（name+sessionId 仍输出，a2a 语义不变）。
 *
 * **数据源**：squadContext（listMembers 返回 MemberEntity 含 name/role/sessionId/currentWork/state +
 *   isSessionRunning + getSquad 取 enableGroupChat/squadChatSessionId）；subagent 读
 *   config.agentToolContext.parent（canonical AgentRef）。
 * EP: system_reminder，tier=info。provide 为 async（isSessionRunning await）。
 */
import {
  ContextImplBase,
  type ReminderCtx,
  type SystemReminder,
  type SystemReminderProvider,
} from '../types';
import { readSessionType } from '../prompt/squad_reminder_shared';

/** a2a §2 AgentRef（不含 user —— user 不在 a2a 拓扑里） */
interface AgentRef {
  type: 'leader' | 'mate' | 'subagent' | 'squad';
  sessionId: string;
  name: string;
}

/** member entity 摘要（squadContext.listMembers 返回，含状态 + presence） */
interface MemberRef {
  id: string;
  name: string;
  role: string;
  sessionId: string;
  /** 成员状态（deployed|benched）；缺省按 deployed 对待（兼容无 state 的旧数据） */
  state?: string;
  /** presence 标记（currentWork.text，可空） */
  currentWork?: { text?: string; updatedAt?: string } | null;
}

/**
 * squad_agents_status reminder provider：统一全员状态块（agent 列表 + running/idle + presence）。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4）。
 */
export default class SquadAgentsStatusReminderProvider
  extends ContextImplBase
  implements SystemReminderProvider
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  async provide(ctx: ReminderCtx): Promise<SystemReminder[]> {
    const sessionType = readSessionType(ctx);
    // standalone（!sessionType）→ 无 a2a 对端
    if (!sessionType) return [];
    // subagent → [parent]（拓扑硬约束，reachable 语义保持，不需 squadContext）
    if (sessionType === 'subagent') {
      const parent = deriveSubagent(ctx);
      if (!parent) return [];
      return [{ id: 'squad_agents_status', tier: 'info', content: formatParent(parent) }];
    }
    // squad/leader/mate → 从 squadContext（listMembers + isSessionRunning + getSquad）派生
    return this.deriveSquadScoped(sessionType, ctx);
  }

  /** squad/leader/mate：squadContext 动态数据源（全员列出 + 状态 + presence） */
  private async deriveSquadScoped(sessionType: string, ctx: ReminderCtx): Promise<SystemReminder[]> {
    const squadContext = ctx.squadContext;
    if (!squadContext) return [];
    const cfg = ctx.config as { squadId?: unknown; memberId?: unknown };
    const squadId = cfg.squadId;
    if (typeof squadId !== 'string' || squadId.length === 0) return [];

    // 取 squad entity（enableGroupChat 门控 + squadChatSessionId）
    const squadRaw = await squadContext.getSquad(squadId);
    const squad = readSquad(squadRaw);
    const squadChatSid = squad.squadChatSessionId;
    // [v0.0.270] 群聊可见性门控单点：enableGroupChat !== false（undefined=旧 record=开，与 toDetail ?? true 语义一致）。
    const squadChatEnabled = squadChatSid && squad.enableGroupChat !== false;

    // 列全部 member（benched 过滤；含 currentWork/state）
    const allMembers = await squadContext.listMembers(squadId);
    const members = readMembers(allMembers);
    const selfMemberId = typeof cfg.memberId === 'string' ? cfg.memberId : undefined;

    // 按 sessionType 过滤可见成员（可达性派生表迁移）：
    //   squad → 全部（leader + mates）；leader → 仅 mates（不含自己）；
    //   mate → leader + peers（不含自己）
    let visible = members;
    if (sessionType === 'leader') {
      visible = members.filter((m) => m.role !== 'leader');
    } else if (sessionType === 'mate') {
      visible = members.filter((m) => m.id !== selfMemberId);
    }

    // 逐 member 查 running 状态（全员列出，不 running 过滤——idle 也保留）
    const rows: string[] = [];
    for (const m of visible) {
      const running = m.sessionId ? await squadContext.isSessionRunning(m.sessionId) : false;
      rows.push(formatMember(m, running));
    }

    // 组装（可达性语义迁移 reachable_agents 派生表）
    const lines: string[] = [];
    // 空 squad（无可见成员）→ 降级「当前无成员」（SquadChat 行也无意义——无成员可协作）
    if (rows.length > 0 && sessionType !== 'squad' && squadChatEnabled) {
      // leader/mate → SquadChat（门控）在最前；squad 自身即 squadchat 不含
      lines.push(`- SquadChat (squad, sessionId: ${squadChatSid}) · 群聊`);
    }
    lines.push(...rows);

    let content: string;
    if (lines.length === 0) {
      content = '[squad:agents] 团队当前状态：\n当前无成员';
    } else {
      content = `[squad:agents] 团队当前状态：\n${lines.join('\n')}`;
    }
    return [{ id: 'squad_agents_status', tier: 'info', content }];
  }
}

/** duck-typed 读 squad entity（enableGroupChat/squadChatSessionId） */
function readSquad(raw: unknown): { squadChatSessionId: string; enableGroupChat?: boolean } {
  if (!raw || typeof raw !== 'object') return { squadChatSessionId: '' };
  const s = raw as { squadChatSessionId?: unknown; enableGroupChat?: unknown };
  const sid = typeof s.squadChatSessionId === 'string' ? s.squadChatSessionId : '';
  const enableGroupChat = typeof s.enableGroupChat === 'boolean' ? s.enableGroupChat : undefined;
  return { squadChatSessionId: sid, ...(enableGroupChat !== undefined ? { enableGroupChat } : {}) };
}

/** 读 members 批量（squadContext.listMembers）。benched 成员单点过滤于此（派生表自动收缩） */
function readMembers(raw: unknown[]): MemberRef[] {
  return raw
    .map(readMemberRef)
    .filter((r): r is MemberRef => r !== null)
    .filter((r) => r.state !== 'benched');
}

/** duck-typed 读单条 member entity → MemberRef（state 缺失不丢整条） */
function readMemberRef(raw: unknown): MemberRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as {
    id?: unknown; name?: unknown; role?: unknown; sessionId?: unknown; state?: unknown; currentWork?: unknown;
  };
  const id = typeof m.id === 'string' ? m.id : '';
  const name = typeof m.name === 'string' ? m.name : '';
  const role = typeof m.role === 'string' ? m.role : '';
  const sessionId = typeof m.sessionId === 'string' ? m.sessionId : '';
  const state = typeof m.state === 'string' ? m.state : undefined;
  const currentWork = readCurrentWork(m.currentWork);
  if (!name && !sessionId) return null;
  return {
    id,
    name,
    role,
    sessionId,
    ...(state ? { state } : {}),
    ...(currentWork ? { currentWork } : {}),
  };
}

/** duck-typed 读 currentWork（presence 标记，可空） */
function readCurrentWork(raw: unknown): { text?: string; updatedAt?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const cw = raw as { text?: unknown; updatedAt?: unknown };
  const text = typeof cw.text === 'string' ? cw.text : undefined;
  const updatedAt = typeof cw.updatedAt === 'string' ? cw.updatedAt : undefined;
  if (text === undefined && updatedAt === undefined) return null;
  return { ...(text !== undefined ? { text } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}) };
}

/** subagent：读 parent AgentRef（agentToolContext.parent 已 canonical 化） */
function deriveSubagent(ctx: ReminderCtx): AgentRef | null {
  const atc = (ctx.config as { agentToolContext?: { parentSessionId?: unknown; parent?: unknown } })
    .agentToolContext;
  if (!atc) return null;
  const parent = readAgentRef(atc.parent);
  if (parent) return parent;
  const sid = typeof atc.parentSessionId === 'string' ? atc.parentSessionId : '';
  return sid ? { type: 'subagent', sessionId: sid, name: 'parent' } : null;
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

/** 成员行格式（R8）：`- {name} ({role}, sessionId: {sid}) · {running|idle} · presence: {text|(无 presence)}` */
function formatMember(m: MemberRef, running: boolean): string {
  const status = running ? 'running' : 'idle';
  const presenceText =
    m.currentWork && typeof m.currentWork.text === 'string' && m.currentWork.text.trim()
      ? m.currentWork.text.trim()
      : '(无 presence)';
  return `- ${m.name} (${m.role}, sessionId: ${m.sessionId}) · ${status} · presence: ${presenceText}`;
}

/** subagent parent 行（reachable 语义保持：无 squad 状态可查，仅可达性） */
function formatParent(p: AgentRef): string {
  return `[squad:agents] 当前可达：\n- ${p.name} (${p.type}, sessionId: ${p.sessionId})`;
}
