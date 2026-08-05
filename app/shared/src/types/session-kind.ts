/**
 * SessionKind — 统一 session 身份维度（forked 退役 + runKind 扁平 + SessionContext 拆分）
 * 参考: specs/tech/agent/session/[P0]session_kind.md（概念权威源）
 *
 * SessionKind 只承载纯身份维度（biz/role/derivation + runKind）；实例 ID 拆到 SessionContext
 * 接口结伴传递（与 kind 同构造点产出、分离字段）。runKind 是 run 级扁平枚举（main/summary/consolidate），
 * 不落盘——由 run 装配入口赋予。
 */

// ── 枚举类型 ────────────────────────────────────────

/** 业务分区：playground（个人对话）| studio（团队管理）| academy（培养 agent 教室） */
export type BizType = 'playground' | 'studio' | 'academy';

/**
 * 会话角色。
 *   'rocky' = playground 主会话
 *   'leader'/'mate'/'squad' = studio 三角色
 *   'head_teacher'/'coach'/'student' = academy 三角色（v0.0.210 新增）
 *   subagent 的 role 缺省 = parent.role（bloodline），spawn 可显式指定
 */
export type Role = 'rocky' | 'leader' | 'mate' | 'squad'
  | 'head_teacher' | 'coach' | 'student';

/** 派生层级：parent（非派生顶级）| subagent（被派生的子 agent） */
export type Derivation = 'parent' | 'subagent';

/** Run 级扁平闭合枚举（不落盘；由 run 装配入口赋予） */
export type RunKind = 'main' | 'summary' | 'consolidate';

// v0.0.204 T2-B2：ToolPolicyRole 类型 + deriveToolPolicyRole helper 已删除（消费方迁完，
// 工具解析全部走 SessionTypePolicy.resolveToolSet profile yaml 单源；不再走 ToolPolicyRole 查表）。

// ── SessionKind 输入 shape ───────────────────────────

/** SessionKind 构造函数入参（v0.0.204：仅身份 4 字段，runKind 缺省 'main'） */
export interface SessionKindInput {
  biz: BizType;
  role: Role;
  derivation: Derivation;
  /** run 级枚举；不传默认 'main'（落盘不消费，run 装配点补真值） */
  runKind?: RunKind;
}

// ── SessionContext（实例 ID，与 kind 结伴但分离） ──

/**
 * Session 实例上下文 ID（v0.0.204 从 SessionKind 拆出）。
 * 与 kind 同构造点产出（session record 同名字段投影），但不并入身份维度——
 * 配合 kind 在 SessionConfig.kind + SessionConfig.sessionContext 两字段分离传递。
 */
export interface SessionContext {
  squadId?: string;
  memberId?: string;
  /** 仅 derivation='subagent' 有值 */
  parentSessionId?: string;
  // [v0.0.210] academy 实例上下文 ID（仅 academy session 填）
  /** academy 所有 session 必填（classroom 归属） */
  classroomId?: string;
  /** student session 必填（学生绑定） */
  studentId?: string;
  /** student session 必填（具体版本绑定） */
  versionId?: string;
  /** coach session 必填（绑定训练任务） */
  trainingTaskId?: string;
}

// ── SessionKind class ───────────────────────────────

/**
 * Session 身份维度统一对象（纯身份，runKind run 级；不持久化整体——是 session record 的运行时投影）。
 * 维度独立存储、互不派生；耦合关系降级为校验规则（validateSessionKind + validateSessionContext）。
 *
 * v0.0.204 终版：删 6 实例 ID（迁 SessionContext）+ 删 toolPolicyRole getter（迁 T2 helper）+
 * 新增 canonicalId()（4 段纯拼接，同时作 scopeId）+ isMainRun（替原 isForked 反向）。
 */
export class SessionKind {
  readonly biz: BizType;
  readonly role: Role;
  readonly derivation: Derivation;
  readonly runKind: RunKind;

  constructor(input: SessionKindInput) {
    this.biz = input.biz;
    this.role = input.role;
    this.derivation = input.derivation;
    // runKind 缺省 'main'（落盘 record 不带此字段；run 装配点覆盖真值）
    this.runKind = input.runKind ?? 'main';
  }

  /** biz === 'studio' */
  get isStudio(): boolean {
    return this.biz === 'studio';
  }

  /** derivation === 'subagent' */
  get isSubagent(): boolean {
    return this.derivation === 'subagent';
  }

  /** runKind === 'main'（替原 isForked 反向；main=主对话 run，summary/consolidate=旁路 run） */
  get isMainRun(): boolean {
    return this.runKind === 'main';
  }

  /**
   * canonical id 纯拼接（零逻辑零分支）——4 段 `${biz}-${role}:${derivation}:${runKind}`。
   * 同时即 scopeId（scopeIdOf = canonicalId，见 session_type_profile.md §2）。
   *
   * 例：playground-rocky:parent:main；studio-leader:parent:consolidate；
   *   studio-leader:subagent:main
   */
  canonicalId(): string {
    return `${this.biz}-${this.role}:${this.derivation}:${this.runKind}`;
  }
}

// ── 校验规则（两层拆分，写入路径单点：createSession + spawn） ─────

/** 校验类错误 */
export class SessionKindValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionKindValidationError';
  }
}

/**
 * 第一层校验：SessionKind 形状规则（role⇒biz/derivation/runKind 边界）。
 *
 * K1 role ∈ {leader, mate, squad} ⇒ biz='studio'
 * K3 role='rocky' ⇒ biz='playground'
 * K4 role ∈ {head_teacher, coach, student} ⇒ biz='academy'（v0.0.210 新增）
 * K5 runKind ∈ {main, summary, consolidate}（闭合枚举；构造时已类型约束，本规则防字符串漂入）
 *
 * @throws SessionKindValidationError 任意规则违规
 */
export function validateSessionKind(kind: {
  biz: BizType;
  role: Role;
  derivation: Derivation;
  runKind?: RunKind;
}): void {
  const { biz, role, runKind } = kind;
  // K1/K3/K4：role ⇒ biz
  if (role === 'leader' || role === 'mate' || role === 'squad') {
    if (biz !== 'studio') {
      throw new SessionKindValidationError(
        `role "${role}" requires biz='studio', got biz='${biz}'`,
      );
    }
  }
  if (role === 'rocky') {
    if (biz !== 'playground') {
      throw new SessionKindValidationError(
        `role "rocky" requires biz='playground', got biz='${biz}'`,
      );
    }
  }
  // K4：academy 三角色 ⇒ biz='academy'
  if (role === 'head_teacher' || role === 'coach' || role === 'student') {
    if (biz !== 'academy') {
      throw new SessionKindValidationError(
        `role "${role}" requires biz='academy', got biz='${biz}'`,
      );
    }
  }
  // K5：runKind 闭合枚举（构造类型已约束；防御性校验字符串漂入）
  const validRunKinds: RunKind[] = ['main', 'summary', 'consolidate'];
  if (runKind !== undefined && !validRunKinds.includes(runKind)) {
    throw new SessionKindValidationError(
      `runKind "${runKind}" not in {main, summary, consolidate}`,
    );
  }
}

/**
 * 第二层校验：SessionContext 上下文存在性规则（与 kind 配对）。
 *
 * C1 derivation='subagent' ⇒ parentSessionId 必填
 * C2 biz='studio' && derivation='parent' ⇒ squadId 必填
 * C3 role ∈ {leader, mate} && derivation='parent' ⇒ memberId 必填
 * C4 biz='academy' && derivation='parent' ⇒ classroomId 必填（v0.0.210 新增）
 * C5 role='coach' && derivation='parent' ⇒ trainingTaskId 必填
 * C6 role='student' && derivation='parent' ⇒ studentId + versionId 必填
 * （C5 head_teacher 无额外要求——head 不绑 student/task）
 *
 * @throws SessionKindValidationError 任意规则违规
 */
export function validateSessionContext(
  kind: { biz: BizType; role: Role; derivation: Derivation },
  ctx: SessionContext,
): void {
  const { biz, role, derivation } = kind;
  // C1：subagent ⇒ parentSessionId
  if (derivation === 'subagent' && !ctx.parentSessionId) {
    throw new SessionKindValidationError(
      'derivation="subagent" requires parentSessionId',
    );
  }
  // C2：studio parent ⇒ squadId
  if (biz === 'studio' && derivation === 'parent' && !ctx.squadId) {
    throw new SessionKindValidationError('biz="studio" parent session requires squadId');
  }
  // C3：leader/mate parent ⇒ memberId
  if ((role === 'leader' || role === 'mate') && derivation === 'parent' && !ctx.memberId) {
    throw new SessionKindValidationError(`role "${role}" parent session requires memberId`);
  }
  // C4：academy parent ⇒ classroomId（所有 academy parent session 都归属教室）
  if (biz === 'academy' && derivation === 'parent' && !ctx.classroomId) {
    throw new SessionKindValidationError('biz="academy" parent session requires classroomId');
  }
  // C5：coach parent ⇒ trainingTaskId（coach 一定绑定一个训练任务）
  if (role === 'coach' && derivation === 'parent' && !ctx.trainingTaskId) {
    throw new SessionKindValidationError('role "coach" parent session requires trainingTaskId');
  }
  // C6：student parent ⇒ studentId + versionId（student session 绑定具体版本）
  if (role === 'student' && derivation === 'parent') {
    if (!ctx.studentId) {
      throw new SessionKindValidationError('role "student" parent session requires studentId');
    }
    if (!ctx.versionId) {
      throw new SessionKindValidationError('role "student" parent session requires versionId');
    }
  }
}

// ── helper ──────────────────────────────────────────

/**
 * studio 主 session（非 subagent、非 rocky）判定 helper。
 * 统一 bootstrap.ts + session-debug.ts 两处硬编码副本（v0.0.56 提取）。
 * 签名只读 kind，无实例 ID 依赖（v0.0.204 SessionContext 拆分后保持不变）。
 */
export function isStudioMainSession(kind: SessionKind): boolean {
  return kind.isStudio && kind.derivation === 'parent' && kind.role !== 'rocky';
}

