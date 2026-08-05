/**
 * AgentToolRuntimeContext —— agent 工具运行时上下文权威类型（v0.0.28 task-2）
 * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §4/§5/§6/§7
 *       specs/tech/multi_agent/[P1]a2a_protocol.md §2.2（别名解析）+ §3/§6（squad clique 校验）
 *       specs/tech/agent/tools/[P1]agent_tools.md §1
 *       specs/tech/squad/[P1]squad_tools.md §2（team 工具）
 *
 * 设计：agent-tool / send-message-tool / team-tool 经 ctx.config.agentToolContext（unknown）读出本结构。
 * 由 agent-loop 构造期注入（this.runId + session.id + session.type + session.title 派生 parentRef），
 * manager / store / sessionDeps 句柄由 bootstrap 注入 agent-loop。
 *
 * 集中定义运行时依赖，避免 agent-tool.ts 散落读取 ctx.config.agentManager / .store 等字段。
 *
 * [v0.0.33.2] 加 selfSquadId / parentSquadId / squadStore / memberStore 4 字段——
 * squad clique 校验（send_message）+ squad 别名解析（'squadchat'/'leader'/name）+
 * team 工具（list/query 等）共用。架构 §2.F 改动 2 + §2.H + §7 风险 3。
 *
 * 单文件 ≤300 行（纯类型 + factory + squad 别名解析包装）。
 */
import type { AgentManagerImpl } from '../agent-manager';
import type { SessionStore } from '../session-store';
import type { SessionHandlerDeps } from '../../handlers/session';
import type { LoadTemplateFn } from './template-loader';
// SessionKind + SessionContext（身份 + 实例 ID 拆分；工具 rtc 读这两字段做 caller 校验）
import type { SessionKind, SessionContext } from '@app/shared';
// [v0.0.33.2] SquadStore/MemberStore 句柄（squad clique 校验 + team 工具 + squad 别名解析用）。
// squad-store.ts 是叶子封装（无循环依赖），可直接 import 类型。
import type { SquadStore, MemberStore } from '../../stores/squad-store';
// [v0.0.189] ReplayableEventBus 句柄（panorama 工具写后 emit SSE 用）。
import type { ReplayableEventBus } from '../event-hub';
// [v0.0.210] AcademyStore + TrainingEngine 句柄（train-student / manage-classroom 工具用）。
import type { AcademyStore } from '../../academy/academy-store';
import type { TrainingEngine } from '../../academy/training-engine';

/**
 * spawn 子会话创建依赖（createChildSession 注入实现用）。
 * 封装 createSession + buildSessionConfigFromDeps 调用，agent-tool 不直接耦合 SessionHandlerDeps。
 */
export interface CreateChildSessionFn {
  (input: {
    childSid: string;
    childConfig: {
      systemPrompt: string;
      modelId: string;
      tools?: string[];
      skills?: string[];
      maxIter: number;
      scope: 'subagent';
      parentSessionId: string;
      subAgentTemplateType: string | null;
      origin: { spawnRunId: string; toolCallId: string };
    };
  }): Promise<{ sessionId: string }>;
}

/**
 * agent 工具运行时上下文（spawn/query/abort + send_message 注入依赖全集）。
 * agent-loop 构造期注入到 this.config.agentToolContext；工具 run 时取出 cast。
 *
 * 字段语义（BUG-032 修复后明确二分，禁止混用）：
 *   - parent*  = caller 的「父 session」身份（spawn 首任务 sender.agent.ref 用：
 *                spawn 投递方=parent，正确）。顶层 standalone 时 fallback 自身 sid。
 *   - self*    = caller 自己的身份（send_message 的 sender.agent.ref 用：
 *                发送方=caller self，不能误用 parent）。
 */
export interface AgentToolRuntimeContext {
  /** parent session.id（caller 的父 session；顶层 fallback 自身 sid） */
  parentSessionId: string;
  /** parent runId（origin.spawnRunId 审计 + abort child 取 runId 用） */
  parentRunId: string;
  /** parent session.type（派生 spawn 首任务 AgentRef.type 用） */
  // [v0.0.33.1] member→mate（B 方案命名统一）
  parentType: 'leader' | 'mate' | 'subagent' | 'squad' | undefined;
  /** parent session.title / name（spawn 首任务 AgentRef.name 用） */
  parentName: string;
  /** parent scope（spawn 仅 session scope——subagent 工具不注册，门控前置；此处只读） */
  parentScope: 'session' | 'subagent' | undefined;
  /**
   * [BUG-032] caller self session.id（运行 session 自己的 sid）。
   * send_message 的 sender.agent.ref 用此（发送方身份），禁止误用 parentSessionId。
   */
  selfSessionId: string;
  /**
   * [BUG-032] caller self session.type（运行 session.type）。
   * 顶层 standalone 时为 undefined（enrichForInbox 反查会兜底成 'session'）。
   */
  selfType: 'leader' | 'mate' | 'subagent' | 'squad' | undefined;
  /**
   * [BUG-032] caller self session.title / name（运行 session.title）。
   */
  selfName: string;
  /**
   * [v0.0.33.2] caller 所属 squad id（squad/leader/mate session 填；standalone/subagent 不填）。
   * send_message squad clique 校验（selfSquadId vs target.squadId）+ squad 别名解析
   * （'squadchat'/'leader'/name）+ team 工具 list/query 共用。
   * 由 bootstrap setBuildAgentToolContext 闭包从 session.squadId 注入。
   */
  selfSquadId?: string;
  /**
   * [v0.0.116] caller 自己的 member id（leader/mate session 填；standalone/subagent/squad 不填）。
   * presence 工具写自己 currentWork 用（UC-14 越权防护：只写 selfMemberId，不接受 memberId 入参）。
   * 由 bootstrap setBuildAgentToolContext 闭包从 session.memberId 注入。
   */
  selfMemberId?: string;
  /**
   * [v0.0.33.2] caller parent 所属 squad id（保留字段：subagent→parent squad 路径备用，本版未启用）。
   * 拓扑上 subagent 不在 squad clique 内（走 parentScope='subagent' 分支），故本字段本版未消费。
   */
  parentSquadId?: string;
  /**
   * [v0.0.33.2] SquadStore 句柄（squad clique 校验时反查 target session.squadId 不需要；
   * squad 别名解析 'squadchat'/'leader' 用）。
   * 由 bootstrap setBuildAgentToolContext 注入；缺省 undefined → squad 相关别名/工具不可用。
   */
  squadStore?: SquadStore;
  /**
   * [v0.0.33.2] MemberStore 句柄（squad 别名 'leader'/name 解析 + team 工具 list/query 用）。
   * 由 bootstrap setBuildAgentToolContext 注入；缺省 undefined → member 相关操作不可用。
   */
  memberStore?: MemberStore;
  /**
   * [v0.0.33.3] 当前 message ulid（caller 不直传 lastWriteMessageId，工具从此自动取，squad_tools §0）。
   * 由 agent-loop stageLLM 每轮注入（assistant messageId）；写 store 时填各 record 的 lastWriteMessageId，
   * 驱动 reminder 变化检测（squad_reminder_providers §5）。可变字段——loop 每轮覆写。
   */
  currentMessageId?: string;
  /**
   * [v0.0.189] panorama topic bus（panorama 工具 create/update/transition/define 写后 emit SSE）。
   * 由 bootstrap-agent-phase 注入；缺省 undefined → 工具静默跳过 emit（不阻塞写操作）。
   */
  panoramaBus?: ReplayableEventBus;
  /**
   * [v0.0.210] AcademyStore 句柄（manage-task / manage-classroom 工具读写 academy 7 entity 用）。
   * 由 bootstrap-agent-phase 注入；缺省 undefined → academy 工具不可用。
   */
  academyStore?: AcademyStore;
  /**
   * [v0.0.210] TrainingEngine 句柄（manage-task 工具 evaluate/revise/fork/adopt/pause/resume 委派用）。
   * 由 bootstrap-agent-phase 注入；缺省 undefined → manage-task 不可用。
   */
  trainingEngine?: TrainingEngine;
  /**
   * caller session 的 SessionKind（身份维度：biz/role/derivation/runKind）。
   * 由 bootstrap setBuildAgentToolContext 闭包从 session record 投影注入（runKind 缺省 'main'）。
   */
  kind?: SessionKind;
  /**
   * caller session 的 SessionContext（实例 ID 投影；与 kind 同构造点产出）。
   */
  sessionContext?: SessionContext;
  /** AgentManager 句柄（deliverTo / abort / children） */
  agentManager: AgentManagerImpl;
  /** SessionStore 句柄（listChildren / getSession / getUsageView） */
  store: SessionStore;
  /** SessionHandlerDeps（buildSessionConfigFromDeps 构造 child config 用） */
  sessionDeps: SessionHandlerDeps;
  /** loadTemplate（task-3 完成后注入真实；默认 fallback null） */
  loadTemplate?: LoadTemplateFn;
}

/**
 * 从 unknown ctx 读出 AgentToolRuntimeContext（agent-tool / send-message-tool 用）。
 * @returns ctx 或 undefined（未注入——agent 工具 run 时抛「未注入」）
 */
export function readRuntimeContext(ctxConfig: unknown): AgentToolRuntimeContext {
  const ctx = (ctxConfig as { agentToolContext?: AgentToolRuntimeContext }).agentToolContext;
  if (!ctx) {
    throw new Error('agent tool: agentToolContext not injected (bootstrap/agent-loop 未注入)');
  }
  return ctx;
}

/**
 * 从 runtime context 派生 parent AgentRef（仅 spawn 首任务 sender.agent.ref 用）。
 *
 * 语义：spawn 投递方=parent（caller 的父 session），首任务 sender 必须是 parent。
 * 顶层 standalone 时 parentSessionId fallback 自身 sid（spawn-action.ts ctx.parentRef）。
 *
 * ⚠️ BUG-032 教训：禁止把本函数用于 send_message 的 sender.agent.ref——
 *    send_message 的发送方是 caller self，必须用 selfAgentRef。parentAgentRef 对
 *    subagent caller 会返回 parentSessionId（=接收方），导致 enrich 反查错向。
 *
 * type 从 parentType 取（顶层 standalone type=undefined → 默认 'subagent' 占位，不影响路由）。
 */
export function parentAgentRef(ctx: AgentToolRuntimeContext): {
  type: 'leader' | 'mate' | 'subagent' | 'squad';
  sessionId: string;
  name: string;
} {
  return {
    type: ctx.parentType ?? 'subagent',
    sessionId: ctx.parentSessionId,
    name: ctx.parentName,
  };
}

/**
 * [BUG-032] 从 runtime context 派生 caller self AgentRef（send_message 的 sender.agent.ref 用）。
 *
 * 语义：send_message 发送方=caller 自己（运行 session self），sender.agent.ref 必须是
 * self 身份。enrichForInbox 会用 ref.sessionId 反查 sender session record（caller self），
 * 反查结果权威覆盖 type/name——所以 sessionId 正确即可让 enrich 得到正确发送方 type/name。
 *
 * type 从 selfType 取（顶层 standalone type=undefined → 默认 'subagent' 占位；
 *   enrich 反查会按 session 真实 type 覆盖，不影响路由）。
 */
export function selfAgentRef(ctx: AgentToolRuntimeContext): {
  type: 'leader' | 'mate' | 'subagent' | 'squad';
  sessionId: string;
  name: string;
} {
  return {
    type: ctx.selfType ?? 'subagent',
    sessionId: ctx.selfSessionId,
    name: ctx.selfName,
  };
}

/** resolveRef helper：AgentRef struct / sessionId 字串 / 'parent' 别名 → sessionId（a2a_protocol §2.2 优先级 1/2） */
export function resolveAgentRef(
  ref: unknown,
  callerParentSessionId?: string,
): string | null {
  if (typeof ref === 'string') {
    // 字串：sessionId（ULID）或 'parent' 别名
    if (ref === 'parent') return callerParentSessionId ?? null;
    return ref;
  }
  if (ref && typeof ref === 'object') {
    // AgentRef struct：sessionId 权威
    const sid = (ref as { sessionId?: string }).sessionId;
    if (typeof sid === 'string' && sid.length > 0) return sid;
  }
  return null;
}

/**
 * [v0.0.33.2] 扩展 resolveAgentRef：a2a_protocol §2.2 优先级 1-5 全集解析。
 *
 * 解析顺序：
 *   1. AgentRef struct → sessionId 权威（同步）
 *   2. 'parent' → caller.parentSessionId（同步，subagent 专用）
 *   3/4/5. squad 别名（'squadchat'/'leader'/member name）——需 caller 在 squad 内（selfSquadId+squadStore）
 *   fallback. 其他字串 → 当 sessionId 直传（playground session / ULID / squad 未注入场景向后兼容）
 *
 * 用途：send_message 的 target 解析。agent-tool 的 query/abort 仍用同步 resolveAgentRef
 * （subagent 不在 squad 拓扑；leader/mate 派 subagent 也不需 squad 别名）。
 *
 * 注：直接复用同步 resolveAgentRef 会让 'squadchat'/'leader'/name 被当作 sessionId 字串
 * 直接返回（同步函数对非 'parent' 字串透传），故本函数对字串分支独立处理，**不**调同步包装。
 *
 * @param ref   LLM 传入的 target（struct / sessionId 字串 / 别名字串）
 * @param rtc   caller 运行时上下文（取 parentSessionId + selfSquadId + store 句柄）
 * @returns     解析出的 sessionId；不可解析 → null
 */
export async function resolveAgentRefWithSquad(
  ref: unknown,
  rtc: AgentToolRuntimeContext,
): Promise<string | null> {
  // 优先级 1：AgentRef struct → sessionId 权威
  if (ref && typeof ref === 'object') {
    const sid = (ref as { sessionId?: string }).sessionId;
    if (typeof sid === 'string' && sid.length > 0) return sid;
    return null;
  }
  if (typeof ref !== 'string') return null;
  // 优先级 2：'parent' 别名——仅 subagent 有效（a2a 拓扑：subagent→parent）。
  //   [v0.0.33.2 round-3 BUG-3 修] 顶层 session（leader/mate/squad/standalone）无 a2a parent——
  //   rtc.parentSessionId 是 spawn 用的 self-fallback（顶层 session.parentSessionId 空 → fallback self），
  //   若当 a2a target 会自投递（mate send_message('parent') → deliver 回自己 → a2a 自环）。
  //   限定 subagent selfType 才解析，顶层返 null 让收方用真名/sessionId 寻址。
  if (ref === 'parent') {
    return rtc.selfType === 'subagent' ? (rtc.parentSessionId ?? null) : null;
  }
  // 优先级 3/4/5：squad 别名（'squadchat'/'leader'/member name）——需 caller 在 squad 内
  if (rtc.selfSquadId && rtc.squadStore) {
    const squadSid = await resolveSquadAlias(ref, rtc);
    if (squadSid !== null) return squadSid;
  }
  // fallback：sessionId 字串直传（playground session / ULID / squad 未命中别名场景）
  return ref;
}

/**
 * [v0.0.33.2] squad 内别名解析（a2a_protocol §2.2 优先级 3/4/5）。
 * - 优先级 3 'squadchat' → caller squad.squadChatSessionId
 * - 优先级 4 'leader'    → caller squad.leaderId 对应 member.sessionId
 * - 优先级 5 其他字串     → caller squad 内 member.name 唯一查找
 *                         （0 或 >1 个匹配 → null，避免歧义寻址；a2a §9 待定项 #1 唯一性强约束）
 *
 * @returns sessionId 或 null
 */
async function resolveSquadAlias(
  alias: string,
  rtc: AgentToolRuntimeContext,
): Promise<string | null> {
  // squadStore/ selfSquadId 由调用方 guard 保证非空，此处 narrow
  const squad = await rtc.squadStore!.getSquad(rtc.selfSquadId!);
  if (!squad) return null;
  // 优先级 3：'squadchat' → squad.squadChatSessionId
  if (alias === 'squadchat') return squad.squadChatSessionId;
  // 优先级 4/5 都需 memberStore；未注入则 squadchat 之外都不可解析
  if (!rtc.memberStore) return null;
  // 优先级 4：'leader' → leader member.sessionId
  if (alias === 'leader') {
    const leader = await rtc.memberStore.getMember(squad.id, squad.leaderId);
    return leader?.sessionId ?? null;
  }
  // 优先级 5：member name 唯一查找
  const members = await rtc.memberStore.listMembers(squad.id);
  const matches = members.filter((m) => m.name === alias);
  if (matches.length !== 1) return null; // 0 或 >1 个匹配 → 解析失败（避免歧义寻址）
  return matches[0]!.sessionId;
}
