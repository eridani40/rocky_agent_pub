/**
 * createMemberService — hire member 事务（fresh / derive / derive_academy，8 步 + 补偿回滚）。
 * 参考: specs/tech/squad/[P1]data_model.md §2/§5 + specs/api/overall/11a-squad-endpoints.md §2.1
 *       + specs/tech/academy/[P1]squad_derive.md §2（derive_academy 桥校验 + step7 seed workspace）。
 * 事务顺序：resolve effective → name 唯一校验 → 建 mate session → put member → append memberIds →
 *   step7 derive_academy seed / step7.5 derive 复制父成员个人 AGENTS.md → return；任一步失败反向补偿。
 * 双向关联（§2）：member.sessionId↔session.memberId、member.squadId↔squad.memberIds；
 *   member 不持运行配置（model 走 session，与 effort/approvalMode 同款，[P1]session_config_studio.md §3）。
 */
import { rmSync } from 'node:fs';
import { ulid } from '../config/ulid';
import type { SquadServiceDeps } from './squad-service';
import { squadRootDir } from '../stores/squad-store';
import type { MemberEntity } from '../stores/squad-store';
import type { MemberSkillConfig } from '../agent/schema_defs/squad/member';
import type { AcademyStore } from '../academy/academy-store';
// derive_academy + derive：源校验 + seed/复制 workspace（squad_derive §2 / data_model §5 step7.5；[v0.0.233]/[v0.0.250]）
import {
  seedMemberWorkspaceFromVersion,
  resolveAcademyDeriveIdentity,
  InvalidAcademySourceError,
  copyPersonalAgentsMd,
  type DeriveResolution,
} from './member-academy-bridge';

/**
 * [v0.0.113] 新成员默认 skill 叠加 = 纯继承全局（inherit，无局部覆盖）。fresh 缺省 / derive 未显式传时统一用；
 * 角色区分由 squad_role mapper + tool-policy 保证。
 */
const DEFAULT_SKILL_CONFIG: MemberSkillConfig = { mode: 'inherit', overrides: {} };

/** name 冲突错误（squad 内 member name 重复；handler 层 catch 转 409，11a §2.1） */
export class MemberNameConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberNameConflictError';
  }
}

/** deriveFrom 指向不存在的 member（handler 层 catch 转 404，11a §2.1） */
export class DeriveSourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeriveSourceNotFoundError';
  }
}

/** hire member 入参（11a §2.1 HireMemberBody + service 用；v0.0.210 加 derive_academy 模式） */
export interface CreateMemberInput {
  squadId: string;
  mode: 'fresh' | 'derive' | 'derive_academy';
  // fresh 模式必填
  name?: string;
  /** 一句话介绍（fresh 建 mate 必填；渲染进 Team Roster 花名册） */
  intro?: string;
  /**
   * [v0.0.169] 工作方式（fresh 可选直传，对齐 11a §2.2 PATCH 的 v0.0.142 语义）：
   * trim 后回写；提供空串 = 回写空串（无 400，区别 intro）；不传 = 缺省无 workStyle。
   */
  workStyle?: string;
  tools?: string[];
  skillConfig?: MemberSkillConfig; // [v0.0.113] 缺省 = DEFAULT_SKILL_CONFIG（inherit）
  // derive 模式必填
  deriveFrom?: string;
  overrides?: Partial<{ name: string; intro: string; workStyle: string; tools: string[]; skillConfig: MemberSkillConfig }>;
  /**
   * [v0.0.210] derive_academy 模式必填：指向教室学生版本（squad_derive §2.1）。
   * versionId 必须 formal + active（process 版本 = 训练临时区不可派生，§5 INV-3）。
   * 与 deriveFrom 互斥（§5 INV-4）。
   */
  academySource?: {
    classroomId: string;
    studentId: string;
    versionId: string;
  };
  /** [v0.0.233] derive_academy 同名裁决（仅 derive_academy 消费；undefined = 默认全 skip 同名 + 不同名 merge） */
  resolution?: DeriveResolution;
}

/**
 * createMemberService 依赖 = SquadServiceDeps + derive_academy 所需 academyStore（可选；
 * 仅 mode='derive_academy' 时必填，fresh/derive 不读——旧 caller 不回归）。
 * 独立扩展而非改 SquadServiceDeps：squad-service.ts 已超 300 行，且 academyStore 只有 hire 用。
 */
export type CreateMemberDeps = SquadServiceDeps & { academyStore?: AcademyStore };

/** createMemberService 出参（11a §2.1 + data_model §5） */
export interface CreatedMember {
  member: MemberEntity;
  sessionId: string;
}

/**
 * resolve effective 配置：fresh 直用 / derive 从父 member 复制 + overrides 覆盖 / derive_academy 桥接校验。
 * 口径：fresh name+intro 必填（workStyle 可选 trim 回写）；derive 复制 parent {intro/workStyle}+override（parent=leader 降 mate）；
 * skillConfig 三模式缺省 DEFAULT_SKILL_CONFIG；tools/model dead（input.tools 忽略+warn，member.tools 落盘恒 []）。
 */
async function resolveEffective(
  deps: CreateMemberDeps,
  input: CreateMemberInput,
): Promise<{
  name: string;
  intro: string;
  workStyle?: string;
  tools: string[];
  skillConfig: MemberSkillConfig;
  deriveFrom?: string;
  parentName?: string; // [v0.0.250] derive 透传父信息给 step7.5 复制个人 AGENTS.md（非 derive = undefined）
  parentMemberId?: string;
  resolution?: DeriveResolution;
}> {
  if (input.mode === 'fresh') {
    // fresh：name + intro 必填（intro 空/缺失 → 'intro required'，handler 转 400）；
    //   workStyle 可选（空串=回写空串，不传=不写盘）；skillConfig 缺省 inherit。
    if (!input.name || input.name.length === 0) throw new Error('name required');
    if (!input.intro || input.intro.trim().length === 0) throw new Error('intro required');
    if (input.tools !== undefined) {
      console.warn('[v0.0.48] member.tools is dead (static-by-type via tool-policy.ts); ignoring fresh input.tools');
    }
    return {
      name: input.name,
      intro: input.intro.trim(),
      ...(input.workStyle !== undefined ? { workStyle: input.workStyle.trim() } : {}),
      tools: [], // [v0.0.48] dead（entity 字段保留，不再写 caller 值）
      skillConfig: input.skillConfig ?? DEFAULT_SKILL_CONFIG,
    };
  }
  // [v0.0.210] derive_academy：从教室学生 formal+active 版本派生（squad_derive §2.2）。
  //   源校验下沉 bridge（resolveAcademyDeriveIdentity）；InvalidAcademySourceError 在此转
  //   DeriveSourceNotFoundError（createMemberService 对外错误契约统一；handler 按 mode 转
  //   400 invalid_academy_source）。配置语义同 fresh（name 必填 / skillConfig 缺省 inherit）。
  if (input.mode === 'derive_academy') {
    let identity: { name: string; intro: string; workStyle?: string };
    try {
      identity = await resolveAcademyDeriveIdentity(deps, input);
    } catch (e) {
      if (e instanceof InvalidAcademySourceError) throw new DeriveSourceNotFoundError(e.message);
      throw e;
    }
    return {
      ...identity,
      tools: [], // [v0.0.48] dead（entity 字段保留，不再写 caller 值）
      skillConfig: input.skillConfig ?? DEFAULT_SKILL_CONFIG,
      ...(input.resolution !== undefined ? { resolution: input.resolution } : {}), // [v0.0.233] 透传给 step7 seed
    };
  }
  // derive：从父 member 复制配置 + overrides 覆盖（配置继承，非 prompt 继承）；
  //   tools/model 是 dead 字段（不复制 parent.tools、不读 overrides.tools）。
  if (!input.deriveFrom) throw new Error('deriveFrom required');
  const parent = await deps.memberStore.getMember(input.squadId, input.deriveFrom);
  if (!parent) throw new DeriveSourceNotFoundError(`deriveFrom member ${input.deriveFrom} not found`);
  const ov = input.overrides ?? {};
  if (ov.tools !== undefined) {
    console.warn('[v0.0.48] member.tools is dead (static-by-type via tool-policy.ts); ignoring derive overrides.tools');
  }
  const resolvedName = ov.name ?? parent.name;
  if (!resolvedName || resolvedName.length === 0) throw new Error('name required (from override or parent)');
  // skillConfig：不复制父成员快照（父/子各自独立），缺省 inherit；显式 overrides 按 caller 意图
  const derivedSkillConfig = ov.skillConfig ?? DEFAULT_SKILL_CONFIG;
  // intro：override 优先，否则继承父 intro（父无 intro 降级空串——派生不强制，与 fresh 必填区分）
  const derivedIntro = (ov.intro ?? parent.intro ?? '').trim();
  // workStyle：默认复制父；overrides 覆盖（空串=清空回写空串）；父无且未 override → 不写盘
  const derivedWorkStyle = ov.workStyle !== undefined ? ov.workStyle.trim() : parent.workStyle;
  return {
    name: resolvedName,
    intro: derivedIntro,
    ...(derivedWorkStyle !== undefined ? { workStyle: derivedWorkStyle } : {}),
    tools: [], // [v0.0.48] dead（不复制 parent.tools，entity 字段保留）
    skillConfig: derivedSkillConfig,
    deriveFrom: input.deriveFrom,
    parentName: parent.name, // [v0.0.250] 透传父信息给 step7.5（零二次 getMember）
    parentMemberId: parent.id,
  };
}

/**
 * hire member 事务（8 步 + 补偿回滚，data_model.md §5）。
 *
 * @throws MemberNameConflictError  name 在 squad 内重复（handler 转 409 member_name_conflict）
 *         DeriveSourceNotFoundError deriveFrom 不存在（handler 转 404）
 *         Error                    其余入参/事务失败（squad 不存在 / 字段缺 / 事务炸 → 400/500）
 */
export async function createMemberService(
  deps: CreateMemberDeps,
  input: CreateMemberInput,
): Promise<CreatedMember> {
  const { sessionStore, squadStore, memberStore, dataDir } = deps;

  // ── 0. squad 必须存在（11a §2.1 404）──
  const squad = await squadStore.getSquad(input.squadId);
  if (!squad) throw new Error('squad not found');

  // ── 1. resolve effective（fresh / derive）──
  const eff = await resolveEffective(deps, input);

  // ── 2. 校验 name 在 squad 内唯一（11a §2.1 member_name_conflict → 409）──
  const existing = await memberStore.listMembers(input.squadId);
  if (existing.some((m) => m.name === eff.name)) {
    throw new MemberNameConflictError(`member name "${eff.name}" already exists in squad`);
  }

  // ── 3. 生成 id（先建 session 拿 id，再 put member——绕过 member.sessionId required）──
  const memberId = ulid();
  const sessionId = ulid();
  // mate workspace = 团队根（团队 workspace 简化：leader/mate/群聊 session.workspaceDir 统一 squads/{sid}/）
  const workspaceDir = squadRootDir(dataDir, input.squadId);

  const created: { mateSession?: boolean; member?: boolean } = {};

  try {
    // ── 4. 建 mate session（role=mate, biz=studio, squadId, memberId，data_model §5 step4）──
    //    [v0.0.33.2 round-3 BUG-3 修] title=mate name——enrichForInbox 用 session.title 派生
    //    sender.agent.ref.name；修前 mate session 无 title → name 退化 'parent' → 收方按 'parent'
    //    回复（parent 别名对 mate 自解析为 self）→ a2a 自环（mate_peer/leader_mate_collab 断）。
    await sessionStore.createSession({
      id: sessionId,
      role: 'mate',
      biz: 'studio',
      derivation: 'parent',
      squadId: input.squadId,
      memberId,
      parentSessionId: undefined, // mate 顶层（非 subagent）
      workspaceDir,
      title: eff.name,
    });
    created.mateSession = true;

    // ── 5. put member record（role=mate state=deployed, sessionId 已就绪）──
    //   [v0.0.33.3 step3] systemPrompt 字段已移除（身份正文迁 squad_role mapper content fragment）
    //   [v0.0.155] model 字段已移除（A4；member 退管理概念）
    const member = await memberStore.putMember({
      id: memberId,
      squadId: input.squadId,
      sessionId,
      name: eff.name,
      // [v0.0.114] intro 一句话介绍（fresh 必填校验通过；derive 继承父或 override，可能为空串）
      ...(eff.intro !== '' ? { intro: eff.intro } : {}),
      // [v0.0.169] workStyle 工作方式（fresh 直传 trim / derive 复制父+override；空串=清空回写，不传=不写盘）
      ...(eff.workStyle !== undefined ? { workStyle: eff.workStyle } : {}),
      role: 'mate',
      tools: eff.tools,
      skillConfig: eff.skillConfig,
      state: 'deployed',
      ...(eff.deriveFrom !== undefined ? { deriveFrom: eff.deriveFrom } : {}),
    });
    created.member = true;

    // ── 6. append squad.memberIds（read-modify-write，data_model §5 step6）──
    //   剥信封字段再 put（与 patchSquad handler 一致）
    const { createdAt: _ca, updatedAt: _ua, version: _v, ...rest } = squad as unknown as Record<string, unknown>;
    void _ca; void _ua; void _v;
    const updatedMemberIds = [...(Array.isArray(squad.memberIds) ? squad.memberIds : []), memberId];
    await squadStore.putSquad({ ...(rest as object), memberIds: updatedMemberIds } as Parameters<typeof squadStore.putSquad>[0]);

    // ── 7. derive_academy：seed 团队 workspace（squad_derive §2.3）——AGENTS.md→.rocky/agents/{name}-{memberId}.md，
    //     .rocky/{skills,memory}→团队层；失败补偿只删 written（MUST NOT rm 团队根），外层 catch 继续反向补偿。──
    if (input.mode === 'derive_academy' && input.academySource) {
      let written: string[] = [];
      try {
        written = await seedMemberWorkspaceFromVersion({
          academyStore: deps.academyStore!,
          classroomId: input.academySource.classroomId,
          sourceVersionId: input.academySource.versionId,
          squadRoot: workspaceDir,
          memberName: eff.name,
          memberId,
          ...(eff.resolution !== undefined ? { resolution: eff.resolution } : {}), // [v0.0.233] 裁决结果
        });
      } catch (seedErr) {
        // 清理本次 seed 实际写入的文件（不 rm 团队根），再 rethrow 让外层继续补偿 member/session
        for (const p of written) {
          try { rmSync(p, { recursive: true, force: true }); }
          catch (e) { console.warn('compensate: cleanup seeded file failed', e); }
        }
        throw seedErr;
      }
    }

    // ── 7.5. derive（非 academy）：复制父成员个人 AGENTS.md → 子名下（§5 step7.5；父无/失败 → 静默 no-op 不回滚）。
    if (input.mode === 'derive' && input.deriveFrom && eff.parentMemberId) {
      await copyPersonalAgentsMd({
        squadRoot: workspaceDir, parentName: eff.parentName!,
        parentMemberId: eff.parentMemberId!, childName: eff.name, childMemberId: memberId,
      });
    }

    // ── 8. 返回（双向关联 member.sessionId↔session.memberId 已就绪；复用 step5 的 put 返回值）──
    return { member, sessionId };
  } catch (err) {
    // ── 补偿回滚（反向：删 member → 删 session；memberIds 不回滚——record 删了 memberIds 残留
    //     memberId 但 member 查不到，best-effort；事务失败极少见，UI/GET 走 listMembers 已过滤脏数据）──
    try {
      if (created.member) await memberStore.deleteMember(input.squadId, memberId);
    } catch (e) { console.warn('compensate: delete member failed', e); }
    try {
      if (created.mateSession) await sessionStore.deleteSession(sessionId);
    } catch (e) { console.warn('compensate: delete mate session failed', e); }
    throw err;
  }
}
