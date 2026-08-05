/**
 * builtin rocky_context plugin — system_prompt_mapper: team_roster
 * 参考: specs/tech/version_logs/v0.0.33.2/change_log.md §2.D 改动2
 *       specs/tech/squad/[P1]prompt_sections.md §2（Option A 分流）+ §3 + §4.2（数据源）
 *       specs/tech/squad/[P1]data_model.md §1.1（squad.memberIds）+ §1.2（Member.name/role/sessionId）
 *
 * 职责：贡献 squad 花名册片段（stable tier）。Option A 分流：subagent 不可见（subagent 拓扑硬约束
 * 只回 parent，见全队花名册无意义）；squad/leader/mate 均贡献（路由/协调/peer 协作都要）。
 *
 * 数据源：config.studioContext.squad.memberIds（含 leader）→ 每成员 {name, role, sessionId, intro}。
 *   [v0.0.114] intro（一句话介绍）随完整 MemberRecord 从 bootstrap→studioContext.members 流入，渲染进花名册行尾。
 *   benched（下岗）成员不进花名册（判据 state !== 'benched'；state 缺失按 deployed 兼容旧数据）。
 * mapper 不直接持 memberStore（依赖方向约束），数据来源：
 *   - 优先读 config.studioContext.members（bootstrap 注入的批量 member entity 数组，含 name/role/sessionId）
 *   - 兜底仅渲染 config.studioContext.member（当前 member）+ squad.memberIds 列出其余 id
 * hire/bench/edit 后 memberIds 由 service 维护，下次 assemble 即反映最新（不持久化到 RoleSpec）。
 * EP: system_prompt_mapper，priority 650，tier=stable。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { readSessionType } from './squad_reminder_shared';

/** member 摘要（渲染花名册用） */
interface MemberRef {
  id: string;
  name: string;
  role: string;
  sessionId: string;
  /** [v0.0.114] 一句话介绍（可空——旧 member 无此字段，渲染时优雅降级） */
  intro?: string;
  /** 成员状态（deployed|benched）；缺省按 deployed 对待（兼容无 state 的旧数据） */
  state?: string;
}

/**
 * team_roster mapper：sessionType === 'subagent' → []；否则渲染花名册。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4）。
 */
export default class TeamRosterMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    // Option A 分流：subagent 不可见
    const sessionType = readSessionType(ctx);
    if (!sessionType || sessionType === 'subagent') return [];
    const roster = readRoster(ctx);
    if (roster.length === 0) return [];
    const content = renderRoster(roster);
    return [
      {
        id: 'team_roster',
        tier: 'stable',
        content,
        priority: 650,
      },
    ];
  }
}


/** 读花名册：优先 studioContext.members 批量；兜底当前 member + memberIds。benched 成员单点过滤于此 */
function readRoster(ctx: PromptCtx): MemberRef[] {
  const sc = (ctx.config as {
    studioContext?: {
      squad?: { memberIds?: unknown };
      member?: unknown;
      members?: unknown;
    };
  }).studioContext;
  if (!sc) return [];

  // 优先批量 members（bootstrap 注入完整花名册）
  const arr = sc.members;
  if (Array.isArray(arr)) {
    const refs = arr.map(readMemberRef).filter((r): r is MemberRef => r !== null).filter(isDeployed);
    if (refs.length > 0) return refs;
  }

  // 兜底：当前 member 单条（同一过滤判据）
  const single = readMemberRef(sc.member);
  return single && isDeployed(single) ? [single] : [];
}

/** 在岗判据：显式 benched 才隐藏；state 缺失按 deployed 兼容（防旧数据全灭） */
function isDeployed(m: MemberRef): boolean {
  return m.state !== 'benched';
}

/** duck-typed 读单条 member entity → MemberRef（缺字段跳过；state 缺失不丢整条） */
function readMemberRef(raw: unknown): MemberRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as {
    id?: unknown;
    name?: unknown;
    role?: unknown;
    sessionId?: unknown;
    intro?: unknown;
    state?: unknown;
  };
  const id = typeof m.id === 'string' ? m.id : '';
  const name = typeof m.name === 'string' ? m.name : '';
  const role = typeof m.role === 'string' ? m.role : '';
  const sessionId = typeof m.sessionId === 'string' ? m.sessionId : '';
  const intro = typeof m.intro === 'string' ? m.intro.trim() : '';
  const state = typeof m.state === 'string' ? m.state : undefined;
  if (!name && !sessionId) return null;
  return { id, name, role, sessionId, ...(intro ? { intro } : {}), ...(state ? { state } : {}) };
}

/**
 * 花名册渲染：`- name(role) (sessionId: xxx) — intro`；按 role 优先级 leader 在前。
 * [v0.0.114] intro 一句话介绍追加行尾（用 `— ` 分隔）；intro 缺省时优雅降级不显示分隔符。
 */
function renderRoster(roster: MemberRef[]): string {
  const sorted = [...roster].sort((a, b) => {
    if (a.role === 'leader' && b.role !== 'leader') return -1;
    if (a.role !== 'leader' && b.role === 'leader') return 1;
    return 0;
  });
  const lines = sorted.map((m) => {
    const roleTag = m.role ? `(${m.role})` : '';
    const sid = m.sessionId ? ` (sessionId: ${m.sessionId})` : '';
    const intro = m.intro ? ` — ${m.intro}` : '';
    return `- ${m.name}${roleTag}${sid}${intro}`;
  });
  return `## Team Roster\n\n${lines.join('\n')}`;
}
