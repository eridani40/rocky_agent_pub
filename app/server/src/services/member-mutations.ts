/**
 * member-mutations service — member 状态写共享业务逻辑（deploy / bench / patch）
 * 参考: specs/tech/squad/[P1]data_model.md §1.2（Member entity）+ §5（createMemberService 错误 class 模式）
 *       specs/api/overall/11a-squad-endpoints.md §2.2-§2.4（HTTP 契约——此 service 把行为抽共享）
 *       specs/tech/version_logs/v0.0.128/change_plan.md 模块 A（D6 决策 B：HTTP/tool 三路同源）
 *
 * 职责：HTTP handler 与 agent tool 双入口共享业务校验 + read-modify-write + 剥信封 putMember。
 *   - deployMemberService：幂等（已 deployed no-op）；benched → deployed 清 benchReason/benchedAt
 *   - benchMemberService：leader 不可 bench；deployed → benched 记 benchReason + benchedAt（不发 send_message，D2）
 *   - patchMemberService：name 改名 squad 内唯一；intro trim 后非空；read-modify-write merge
 *
 * [v0.0.155] patchMemberService 不再校验/写 model（A4 硬删 member.model）；patch.model 入参移除。
 *
 * 业务逻辑源：handlers/member.ts handleDeploy/handleBench/handlePatchMember（行为 1:1 抽出，不重写）。
 * 错误 class 模式：对齐 member-service.ts:37 MemberNameConflictError。
 *
 * 单文件 ≤300 行。
 */
import type { MemberStore, MemberEntity } from '../stores/squad-store';
import type { MemberSkillConfig } from '../agent/schema_defs/squad/member';
import { MemberNameConflictError } from './member-service';

/** member mutation 共用最小依赖集（deploy/bench/patch 真实依赖；不重复 SquadServiceDeps 全集） */
export interface MemberMutationDeps {
  memberStore: MemberStore;
}

/** PATCH member 业务字段（去 dead tools/heartbeat/model；对齐 data_model §1.2 + change_plan D3 + A4） */
export interface PatchMemberInput {
  name?: string;
  intro?: string;
  /** 工作方式（v0.0.142，可空，空串=清空，无非空校验——区别于 intro） */
  workStyle?: string;
  skillConfig?: MemberSkillConfig;
}

/** member 不存在（HTTP→404 'member not found' / tool→errorResult 同文案） */
export class MemberNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberNotFoundError';
  }
}

/** bench leader 时 throw（HTTP→403 'leader_not_benchable' / tool→errorResult 同文案，11a §2.4） */
export class LeaderNotBenchableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaderNotBenchableError';
  }
}

/** 剥信封（createdAt/updatedAt/version 由 store 注入，record 不得自带，schema-validation.ts:28） */
function stripEnvelope(rec: Record<string, unknown>): Record<string, unknown> {
  const { createdAt: _ca, updatedAt: _ua, version: _v, ...rest } = rec;
  void _ca; void _ua; void _v;
  return rest;
}

/**
 * 部署 member（幂等：已 deployed 直接返；benched → deployed 清 benchReason/benchedAt，11a §2.3）。
 *
 * @throws MemberNotFoundError member 不存在
 */
export async function deployMemberService(
  deps: MemberMutationDeps,
  squadId: string,
  memberId: string,
  lastWriteMessageId?: string,
): Promise<MemberEntity> {
  const existing = await deps.memberStore.getMember(squadId, memberId);
  if (!existing) throw new MemberNotFoundError(`member ${memberId} not found in squad ${squadId}`);

  // 幂等：已 deployed → no-op（直接返原 member，11a §2.3）
  if (existing.state === 'deployed') return existing;

  // benched → deployed（剥信封 + 清 benchReason/benchedAt，照搬 member.ts:278-281）
  const rest = stripEnvelope(existing as unknown as Record<string, unknown>);
  const { benchReason: _br, benchedAt: _ba, ...restNoBench } = rest;
  void _br; void _ba;
  const updated = await deps.memberStore.putMember({
    ...(restNoBench as object),
    state: 'deployed',
    ...(lastWriteMessageId !== undefined ? { lastWriteMessageId } : {}),
  } as Parameters<typeof deps.memberStore.putMember>[0]);
  return updated;
}

/**
 * 下岗 member（deployed → benched；leader 不可 bench；不发 send_message，D2）。
 *
 * @throws MemberNotFoundError     member 不存在
 *         LeaderNotBenchableError existing.role==='leader'（HTTP→403 / tool→同文案）
 *         Error                   reason 空（service 兜底；handler/tool 入口已校验）
 */
export async function benchMemberService(
  deps: MemberMutationDeps,
  squadId: string,
  memberId: string,
  reason: string,
  lastWriteMessageId?: string,
): Promise<MemberEntity> {
  // reason 兜底校验（handler/tool 入口通常已校验；照搬 member.ts:298-300 的 reason required 语义）
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new Error('reason required');
  }
  const existing = await deps.memberStore.getMember(squadId, memberId);
  if (!existing) throw new MemberNotFoundError(`member ${memberId} not found in squad ${squadId}`);

  // leader 不可 bench（双层拒：service throw + UI 隐藏按钮，squad_definition §8）
  if (existing.role === 'leader') {
    throw new LeaderNotBenchableError(`leader ${memberId} is not benchable`);
  }

  // deployed → benched + benchReason + benchedAt（剥信封后 putMember，照搬 member.ts:312-319）
  const rest = stripEnvelope(existing as unknown as Record<string, unknown>);
  const updated = await deps.memberStore.putMember({
    ...(rest as object),
    state: 'benched',
    benchReason: reason,
    benchedAt: new Date().toISOString(),
    ...(lastWriteMessageId !== undefined ? { lastWriteMessageId } : {}),
  } as Parameters<typeof deps.memberStore.putMember>[0]);
  return updated;
}

/**
 * 编辑 member（read-modify-write merge + 字段校验，11a §2.2）。
 *
 * 校验顺序（与现 handler 一致）：name → intro。
 * [v0.0.155] 不再校验/写 model（A4 硬删；patch.model 传则 warn 兜底）。
 *
 * @throws MemberNotFoundError      member 不存在
 *         MemberNameConflictError  name 改名且 squad 内有同名（排除自己）
 *         Error                    intro trim 后空
 */
export async function patchMemberService(
  deps: MemberMutationDeps,
  squadId: string,
  memberId: string,
  patch: PatchMemberInput,
  lastWriteMessageId?: string,
): Promise<MemberEntity> {
  const existing = await deps.memberStore.getMember(squadId, memberId);
  if (!existing) throw new MemberNotFoundError(`member ${memberId} not found in squad ${squadId}`);

  // name 改名仍需 squad 内唯一（排除自己；同名 no-op 不改）
  if (patch.name !== undefined && patch.name !== existing.name) {
    const all = await deps.memberStore.listMembers(squadId);
    if (all.some((m) => m.id !== memberId && m.name === patch.name)) {
      throw new MemberNameConflictError(`member name "${patch.name}" already exists in squad`);
    }
  }
  // [v0.0.155] model 字段已硬删（A4）；patch.model 不再接受/校验/落盘。
  //   旧 caller 传 patch.model → dead 字段 warn 兜底（见下方 PatchMemberInput 不含 model，但 caller 强传时也走 warn）。
  // intro 可编辑：提供但 trim 后空 → 'intro required'（与创建校验口径一致）
  if (patch.intro !== undefined && patch.intro.trim().length === 0) {
    throw new Error('intro required');
  }
  // dead 字段兜底（PatchMemberInput 类型不含；caller 强传时 accept-and-ignore + warn）
  const patchRaw = patch as unknown as Record<string, unknown>;
  if (patchRaw.tools !== undefined) {
    console.warn('[v0.0.48] PatchMemberInput.tools is dead (static-by-type via tool-policy.ts); ignoring');
  }
  if (patchRaw.heartbeat !== undefined) {
    console.warn('[v0.0.116] PatchMemberInput.heartbeat is dead (use PATCH /squad heartbeatConfig); ignoring');
  }
  if (patchRaw.model !== undefined) {
    console.warn('PatchMemberInput.model is dead (member 不持 model；use PATCH /session for model); ignoring');
  }

  // 剥信封 + read-modify-write merge（intro trim 后写）
  const rest = stripEnvelope(existing as unknown as Record<string, unknown>);
  const merged: Record<string, unknown> = { ...rest };
  if (patch.name !== undefined) merged.name = patch.name;
  if (patch.intro !== undefined) merged.intro = patch.intro.trim();
  // workStyle 允许清空（trim 归一，空串保留=清空；不 throw，区别于 intro）
  if (patch.workStyle !== undefined) merged.workStyle = patch.workStyle.trim();
  if (patch.skillConfig !== undefined) merged.skillConfig = patch.skillConfig;
  if (lastWriteMessageId !== undefined) merged.lastWriteMessageId = lastWriteMessageId;
  // [v0.0.155] 不写 model（A4 硬删）；旧 record.model 若存在不回写（lazy 忽略）

  const updated = await deps.memberStore.putMember(
    merged as Parameters<typeof deps.memberStore.putMember>[0],
  );
  return updated;
}
