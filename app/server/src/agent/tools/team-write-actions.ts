/**
 * team 工具写 action 子模块 —— schema 常量 + 5 写 action
 * 参考: specs/tech/squad/[P1]squad_tools.md §0 + §2（inputSchema + action 入参权威）
 *       specs/tech/squad/[P1]data_model.md §5（createMemberService hire 流程）
 *       specs/tech/agent/session/[P0]session_clear.md §2/§3（reset 复用 clearSession 清理范围）
 *
 * 收纳 5 写 action + 完整 inputSchema + roleId 解析 helper。team-tool.ts import 本文件 run*，不反向 import。
 */
import type { ToolInput, ToolRunResult, JSONSchemaLike } from '../../tools/types';
import { errorResult, textResult } from '../../tools/types';
import type { AgentToolRuntimeContext } from './runtime-context';
import type { MemberSkillConfig } from '../schema_defs/squad/member';
import type { MemberStore } from '../../stores/squad-store';
import { createMemberService, MemberNameConflictError, DeriveSourceNotFoundError } from '../../services/member-service';
import type { CreateMemberInput } from '../../services/member-service';
import {
  deployMemberService,
  benchMemberService,
  patchMemberService,
  MemberNotFoundError,
  LeaderNotBenchableError,
} from '../../services/member-mutations';
import type { PatchMemberInput } from '../../services/member-mutations';
import type { SquadServiceDeps } from '../../services/squad-service';

/**
 * team 工具完整 inputSchema —— 6 action enum + flat 顶层 properties。
 * 参考 squad_tools §0（properties = LLM 参数契约，handler 实读啥 flat 字段就声明啥）。
 */
export const TEAM_INPUT_SCHEMA: JSONSchemaLike = {
  type: 'object',
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'query', 'hire', 'deploy', 'bench', 'edit', 'reset'],
      description: 'action: list | query | hire | deploy | bench | edit | reset',
    },
    query: {
      type: 'object',
      description: 'QueryInput (action=query). ref = memberId or member.name.',
      properties: { ref: { type: 'string', description: 'member id (ULID) or member.name (squad 内唯一)' } },
    },
    // edit 用 flat 顶层（PatchMemberInput shape）
    patch: { type: 'object', description: 'edit: partial patch，至少 1 字段（leader/user only）' },
    // bench 用 flat 顶层（同语义「变更理由」）
    reason: { type: 'string', description: 'bench: 变更理由（required）' },
    // —— hire 用 flat 顶层（fresh / derive 共 8 字段）——
    mode: { type: 'string', enum: ['fresh', 'derive'], description: 'hire: fresh | derive（缺省 fresh）' },
    name: { type: 'string', description: 'hire (fresh): member.name（squad 内唯一）' },
    intro: { type: 'string', description: 'hire (fresh): 一句话介绍（必填，trim 非空）' },
    skillConfig: { type: 'object', description: "hire (fresh): { mode: 'inherit'|'custom', overrides: Record<string,boolean> }" },
    deriveFrom: { type: 'string', description: 'hire (derive): 父 member id 或 name（与 query.ref 同语义）' },
    overrides: { type: 'object', description: 'hire (derive): 嵌套 { name?, intro?, skillConfig? }' },
    roleId: { type: 'string', description: 'deploy/bench/edit: member id (ULID) 或 member.name（与 query.ref 同语义）' },
  },
};

/**
 * roleId → memberId 解析（与 query.ref 同语义：id 优先，其次 name 唯一匹配）。
 * @throws MemberNotFoundError 无匹配
 */
export async function resolveMemberId(
  memberStore: MemberStore,
  squadId: string,
  roleId: string,
): Promise<string> {
  const members = await memberStore.listMembers(squadId);
  // 先 id 精确（ULID 自然唯一）
  const byId = members.find((m) => m.id === roleId);
  if (byId) return byId.id;
  // 再 name（squad 内唯一）
  const byName = members.find((m) => m.name === roleId);
  if (byName) return byName.id;
  throw new MemberNotFoundError(`member ${roleId} not found in squad ${squadId}`);
}

/**
 * 剔除裸 object 中的 workStyle 键（workStyle 仅用户可编辑，agent 工具面不暴露）。
 * runEdit（patch）/ runHire（derive overrides）共用；LLM 塞入即丢弃，不报错（向后兼容）。
 */
function dropWorkStyle(raw: Record<string, unknown>): Record<string, unknown> {
  const { workStyle: _dropped, ...rest } = raw;
  return rest;
}

/**
 * hire 写 action（复用既有 createMemberService）。
 * fresh 直用入参；derive 收 deriveFrom/overrides。
 * lastWriteMessageId 由 createMemberService 写 member record 时记。
 */
export async function runHire(input: ToolInput, rtc: AgentToolRuntimeContext): Promise<ToolRunResult> {
  const mode: 'fresh' | 'derive' = input.mode === 'derive' ? 'derive' : 'fresh';

  // derive: inputSchema 承诺 deriveFrom「id 或 name（与 query.ref 同语义）」，
  //   但 createMemberService.getMember 是 id-only——传 name 会 404。
  //   复用 resolveMemberId（与 runDeploy/runBench/runEdit 的 roleId 同语义、同 helper）。
  let deriveSourceId: string | undefined;
  if (mode === 'derive') {
    const raw = typeof input.deriveFrom === 'string' ? input.deriveFrom.trim() : '';
    if (!raw) return errorResult('team.hire: deriveFrom required');
    try {
      deriveSourceId = await resolveMemberId(rtc.memberStore!, rtc.selfSquadId!, raw);
    } catch (e) {
      if (e instanceof MemberNotFoundError) return errorResult('team.hire: deriveFrom member not found');
      return errorResult(`team.hire: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const svcInput: CreateMemberInput = {
    squadId: rtc.selfSquadId!,
    mode,
    ...(mode === 'fresh'
      ? {
          ...(typeof input.name === 'string' ? { name: input.name } : {}),
          ...(typeof input.intro === 'string' ? { intro: input.intro } : {}),
          ...(input.skillConfig !== undefined ? { skillConfig: input.skillConfig as MemberSkillConfig } : {}),
        }
      : {
          deriveFrom: deriveSourceId!,
          // workStyle 仅用户可编辑（HTTP hire/PATCH 面板），不进 agent 管理工具——
          //   服务端兜底剔除 overrides.workStyle：TEAM_INPUT_SCHEMA 未声明该字段，但 overrides 是
          //   裸 object schema 无 additionalProperties 限制，挡不住 LLM 塞入（同 runEdit 剔除模式）。
          ...(input.overrides !== undefined && typeof input.overrides === 'object'
            ? { overrides: dropWorkStyle(input.overrides as Record<string, unknown>) as CreateMemberInput['overrides'] }
            : {}),
        }),
  };
  const deps: SquadServiceDeps = {
    sessionStore: rtc.store,
    squadStore: rtc.squadStore!,
    memberStore: rtc.memberStore!,
    dataDir: rtc.sessionDeps.dataDir,
    appConfig: rtc.sessionDeps.appConfig,
  };
  try {
    const { member, sessionId } = await createMemberService(deps, svcInput);
    return textResult(JSON.stringify({ memberId: member.id, sessionId, name: member.name, state: 'deployed' }));
  } catch (e) {
    if (e instanceof MemberNameConflictError) return errorResult('team.hire: member_name_conflict');
    if (e instanceof DeriveSourceNotFoundError) return errorResult('team.hire: deriveFrom member not found');
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'intro required' || msg === 'name required' || msg === 'deriveFrom required') {
      return errorResult(`team.hire: ${msg}`);
    }
    return errorResult(`team.hire: hire member failed: ${msg}`);
  }
}

/** deploy 写 action（复用 deployMemberService；幂等 no-op 由 service 兜底） */
export async function runDeploy(input: ToolInput, rtc: AgentToolRuntimeContext): Promise<ToolRunResult> {
  const roleId = typeof input.roleId === 'string' ? input.roleId.trim() : '';
  if (!roleId) return errorResult('team.deploy: roleId required');
  try {
    const memberId = await resolveMemberId(rtc.memberStore!, rtc.selfSquadId!, roleId);
    const member = await deployMemberService(
      { memberStore: rtc.memberStore! },
      rtc.selfSquadId!,
      memberId,
      rtc.currentMessageId,
    );
    return textResult(JSON.stringify({ memberId: member.id, state: member.state }));
  } catch (e) {
    if (e instanceof MemberNotFoundError) return errorResult('team.deploy: member not found');
    return errorResult(`team.deploy: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** bench 写 action（leader 在 caller session final text 告知 user） */
export async function runBench(input: ToolInput, rtc: AgentToolRuntimeContext): Promise<ToolRunResult> {
  const roleId = typeof input.roleId === 'string' ? input.roleId.trim() : '';
  if (!roleId) return errorResult('team.bench: roleId required');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) return errorResult('team.bench: reason required');
  try {
    const memberId = await resolveMemberId(rtc.memberStore!, rtc.selfSquadId!, roleId);
    const member = await benchMemberService(
      { memberStore: rtc.memberStore! },
      rtc.selfSquadId!,
      memberId,
      reason,
      rtc.currentMessageId,
    );
    return textResult(JSON.stringify({ memberId: member.id, state: member.state, benchReason: member.benchReason }));
  } catch (e) {
    if (e instanceof MemberNotFoundError) return errorResult('team.bench: member not found');
    if (e instanceof LeaderNotBenchableError) return errorResult('team.bench: leader_not_benchable');
    return errorResult(`team.bench: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * edit 写 action（patch 字段 = name/intro/skillConfig）。
 * 校验顺序：patch 是 object 且 ≥1 有效字段 → roleId 非空 → service 校验 name 唯一/intro trim。
 */
export async function runEdit(input: ToolInput, rtc: AgentToolRuntimeContext): Promise<ToolRunResult> {
  const rawPatch = input.patch;
  if (!rawPatch || typeof rawPatch !== 'object') {
    return errorResult('team.edit: patch invalid (need >=1 of skillConfig/intro/name)');
  }
  const p = rawPatch as Record<string, unknown>;
  const hasValid =
    typeof p.name === 'string' ||
    typeof p.intro === 'string' ||
    p.skillConfig !== undefined;
  if (!hasValid) {
    return errorResult('team.edit: patch invalid (need >=1 of skillConfig/intro/name)');
  }
  const roleId = typeof input.roleId === 'string' ? input.roleId.trim() : '';
  if (!roleId) return errorResult('team.edit: roleId required');
  // dead 字段（tools/heartbeat）由 patchMemberService accept-and-ignore + warn
  // workStyle 仅用户可编辑（编辑面板），不进 agent 管理工具——服务端兜底剔除：TEAM_INPUT_SCHEMA
  // 未声明该字段，但 patch 是裸 object schema 无 additionalProperties 限制，挡不住 LLM 塞入。
  const patch = dropWorkStyle(p) as PatchMemberInput;
  try {
    const memberId = await resolveMemberId(rtc.memberStore!, rtc.selfSquadId!, roleId);
    const member = await patchMemberService(
      { memberStore: rtc.memberStore! },
      rtc.selfSquadId!,
      memberId,
      patch,
      rtc.currentMessageId,
    );
    return textResult(JSON.stringify({ member }));
  } catch (e) {
    if (e instanceof MemberNotFoundError) return errorResult('team.edit: member not found');
    if (e instanceof MemberNameConflictError) return errorResult('team.edit: member_name_conflict');
    return errorResult(`team.edit: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * reset 写 action — 清空 mate 会话上下文 + presence + todo。
 * 1. running 保护（state∈{running,interrupting}→拒绝，不 abort）
 * 2. clearSession 清 transcript/summary/runs/usage（同「清理上下文」按钮链路）
 * 3. putMember currentWork=null 清 presence（presence 清失败→warning 不阻塞）
 * 4. todoStore.removeAll 清 todo（缺省→skip）。不动 memory/agent md。
 * 参考: session_clear §2/§3；squad_tools §2
 */
export async function runReset(input: ToolInput, rtc: AgentToolRuntimeContext): Promise<ToolRunResult> {
  const roleId = typeof input.roleId === 'string' ? input.roleId.trim() : '';
  if (!roleId) return errorResult('team.reset: roleId required');

  let memberId: string;
  let sessionId: string | undefined;
  try {
    memberId = await resolveMemberId(rtc.memberStore!, rtc.selfSquadId!, roleId);
    sessionId = (await rtc.memberStore!.getMember(rtc.selfSquadId!, memberId))?.sessionId;
  } catch (e) {
    if (e instanceof MemberNotFoundError) return errorResult('team.reset: member not found');
    return errorResult(`team.reset: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!sessionId) return errorResult('team.reset: member has no session (sessionId missing)');

  // 1. running 保护（不 abort，让 leader 等跑完）
  const session = await rtc.store.getSession(sessionId);
  if (session && (session.state === 'running' || session.state === 'interrupting')) {
    return errorResult(`team.reset: agent is running (state=${session.state}), wait for it to finish or abort first`);
  }

  // 2. 清 transcript+summary+runs+usage（复用 store.clearSession）
  try {
    await rtc.store.clearSession(sessionId);
  } catch (e) {
    return errorResult(`team.reset: clearSession failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3. 清 presence（read-modify-write 剥信封，对齐 presence-tool.ts 模式；清失败→warning 不阻塞）
  let presenceWarning: string | undefined;
  try {
    const member = await rtc.memberStore!.getMember(rtc.selfSquadId!, memberId);
    if (member) {
      const { createdAt: _ca, updatedAt: _ua, version: _v, ...rest } = member as unknown as Record<string, unknown>;
      void _ca; void _ua; void _v;
      await rtc.memberStore!.putMember({ ...(rest as object), currentWork: null } as never);
    }
  } catch (e) {
    presenceWarning = `presence clear failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  // 4. 清 todo：todoStore.removeAll(sid)（类型 unknown 需 cast；缺省→skip）
  let todoWarning: string | undefined;
  const rawTodoStore = rtc.sessionDeps?.todoStore as { removeAll?: (sid: string) => Promise<void> } | undefined;
  if (rawTodoStore && typeof rawTodoStore.removeAll === 'function') {
    try {
      await rawTodoStore.removeAll(sessionId);
    } catch (e) {
      todoWarning = `todo clear failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // 汇总结果（核心 cleared:true + 附 warnings 如有）
  const warnings = [presenceWarning, todoWarning].filter(Boolean);
  const result: Record<string, unknown> = { memberId, sessionId, cleared: true };
  if (warnings.length > 0) result.warnings = warnings;
  return textResult(JSON.stringify(result));
}
