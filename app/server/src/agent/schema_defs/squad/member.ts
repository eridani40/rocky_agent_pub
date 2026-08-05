/**
 * member entity 的 SchemaDef — squad 成员（leader + mate，role 区分）
 * 参考: states/v0.0.33.1/design.md §1.2（member entity）
 *       specs/tech/squad/[P1]data_model.md §1.2（SchemaDef）+ §3（存储布局）
 *       specs/tech/squad/[P1]squad_definition.md §3/§4（role/name/state 语义）
 *
 * 设计（data_model.md §3 + design.md §2）：
 *   - engine=file，按 squadId 分片（落 {root}/squads/{squadId}/members/{memberId}.json）
 *   - role = leader | mate（B 方案命名统一，design.md §5）
 *   - state = deployed | benched（leader 永远 deployed，不可 bench）
 *   - 全 agent（无 human member）
 *   - 占位 v4：heartbeat（存但不生效）
 *   - 信封 createdAt/updatedAt/version 由 CrudStore 注入，不在此声明
 */
import type { SchemaDef, InferRecord } from '../../../persistence/schema-types';

/**
 * 成员 skill 叠加快照（overlay）形态 [v0.0.113 — 推翻旧 skills 白名单，不兼容旧数据]。
 * - mode='inherit'：纯继承全局 skill 配置，无任何局部覆盖（默认新成员）。
 * - mode='custom'：以全局 enabled 为底，overrides 有记录的 skill 用记录值覆盖；
 *     overrides 无记录的 skill（如全局后续新增）跟全局配置（R3）。
 * - overrides：skill name → 是否启用 的局部开关快照（仅治理 builtin/app 层；workspace 层恒生效）。
 * 注：schema field `skillConfig` 声明为 json（InferRecord 派生为 unknown），消费方按本类型断言。
 * resolve 契约见 specs/tech/squad/[P1]session_config_studio.md §3.2 + PRD 2-member-skills-mechanism.md §3。
 */
export interface MemberSkillConfig {
  mode: 'inherit' | 'custom';
  overrides: Record<string, boolean>;
}

/**
 * member entity 的 SchemaDef。
 * 落盘路径：{root}/squads/{squadId}/members/{memberId}.json（按 squadId 分片）。
 *
 * 注：entity 名用复数 'members'（= 目录名，design.md §2 / data_model.md §3 锁定 `members/` 子目录）。
 *   CrudStore entity 名即目录名（schema_interface §2.1），故 entity='members' 才能落 `squads/{squadId}/members/`。
 *   （data_model.md §1.2 字面写 "member" 是逻辑类型名；物理 entity 标识用复数以匹配 §3 目录布局。）
 */
export const MemberSchema = {
  entity: 'members',
  engine: 'file',
  fs: {
    sharding: {
      shardKeyField: 'squadId',
      dirTemplate: 'squads/{shardKey}/',
    },
    format: 'json',
  },
  fields: {
    /** ULID 主键（业务生成） */
    id: { type: 'ulid', required: true },
    /** 所属 squad id（分片键 + 双向关联，data_model §2.1） */
    squadId: { type: 'ulid', required: true },
    /** 关联 session id（双向之一；仅 leader/mate 有 session，data_model §2.2） */
    sessionId: { type: 'ulid', required: true },
    /** 成员名（squad 内唯一，a2a 人类可读寻址符，squad_definition §3） */
    name: { type: 'string', required: true },
    /**
     * 一句话介绍（Team Roster 花名册渲染用，安排工作 / 相互寻址时快速识别角色职责）。
     * schema 层 required=false（容忍历史 member record 无此字段——PATCH 读改写不炸、旧队渲染优雅降级）；
     * 业务层强约束：fresh 建 mate 时 intro 必填（member-service resolveEffective 校验），
     * leader 建队时默认 intro = 代码固定职能文案（squad-service defaultLeaderIntro）。
     * 可编辑：PATCH member intro（提供空串 → 400 intro required，与创建口径一致）。
     */
    intro: { type: 'string', required: false },
    /**
     * 工作方式（成员编辑面板可管理，仅用户可编辑，v0.0.142）。
     * 仅注入该成员**自己个人 session** 的 system prompt（squad_role mapper leader/mate 分支追加段），
     * 不进 team_roster（全队花名册）、不进 agent 管理工具 schema。
     * 可空，默认空（空则不注入，无 400 校验——区别于 intro）；PATCH 提供空串即清空。
     */
    workStyle: { type: 'string', required: false },
    /** 角色（leader | mate，B 方案，design.md §5；mate 原 type=member） */
    role: {
      type: 'enum',
      required: true,
      enumValues: ['leader', 'mate'],
    },
    // [v0.0.33.3] systemPrompt 字段已移除（prompt_sections §7 step3）：
    //   身份正文由 squad_role mapper 注入（content fragment），不落 DB。
    //   derive 模式改配置继承（parent.{role 降 mate,tools,skills,model}，非 prompt 继承）。
    /** 工具白名单（string[]，json 透传） */
    tools: { type: 'json', required: true },
    /**
     * skill 叠加快照（overlay，json 透传，形态 = MemberSkillConfig）。
     * [v0.0.113] 推翻旧 `skills` 白名单（string[] 交集机制）为 overlay：
     *   mode='inherit' 纯跟全局；mode='custom' 以全局 enabled 为底叠加 overrides 局部开关。
     * 不兼容旧数据（旧 record 无 skillConfig，读到即走上层兜底/前端默认 inherit）。
     */
    skillConfig: { type: 'json', required: true },
    /** 状态（deployed | benched；leader 永远 deployed，squad_definition §8） */
    state: {
      type: 'enum',
      required: true,
      enumValues: ['deployed', 'benched'],
    },
    /** bench 原因（state=benched 时填） */
    benchReason: { type: 'string', required: false },
    /** bench 时间 ISO 8601（state=benched 时填） */
    benchedAt: { type: 'isoDate', required: false },
    /**
     * [v0.0.116 dead] 原 per-member 心跳配置（{ activeWindow, interval } | null）。
     * 已停止读写（squad 级心跳升级后废弃）；schema 保留避免历史 record 迁移风险。
     * 参考: specs/tech/squad/[P1]data_model.md §1.2 dead
     */
    heartbeat: { type: 'json', required: false },
    /**
     * [v0.0.116] presence 数据（{ text: string; updatedAt: string } | null）。
     * presence 工具写 selfMemberId 的当前工作状态（set/clear）；
     * SquadDetail.members[] 回显（GET /squad/:id 含 currentWork）。
     * required:false：容忍历史 member record 无此字段（PATCH 读改写不炸、旧队渲染优雅降级）。
     * 参考: specs/tech/squad/[P1]data_model.md §1.2b
     */
    currentWork: { type: 'json', required: false },
    /** derive 模式：父 member id（hire 时一次性记，无后续联动，data_model §1.2） */
    deriveFrom: { type: 'ulid', required: false },
    /**
     * 最近一次写 member 的 message id（agent tool 写时填，HTTP 不传）。
     * 与 squad.lastWriteMessageId 同语义（store 投影字段，记 caller message）；
     * service member-mutations.ts.{deploy,bench,patch} 接 lastWriteMessageId? 入参时写入。
     */
    lastWriteMessageId: { type: 'ulid', required: false },
  },
} as const satisfies SchemaDef;

/** member 记录类型（从 SchemaDef 派生；信封由 store 注入） */
export type MemberRecord = InferRecord<typeof MemberSchema>;
