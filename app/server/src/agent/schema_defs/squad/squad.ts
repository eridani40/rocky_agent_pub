/**
 * squad entity 的 SchemaDef — squad 团队/角色信息权威源
 * 参考: states/v0.0.33.1/design.md §1.1（squad entity）
 *       specs/tech/squad/[P1]data_model.md §1.1（SchemaDef）+ §3（存储布局）
 *       specs/api/overall/11a-squad-endpoints.md §1.3（SquadDetail）
 *
 * 设计（data_model.md §3 + design.md §2）：
 *   - engine=file，不分片（每 squad 一个 {squadId}.json，落 {root}/squad/{squadId}.json）
 *   - 占位 v4 字段（budget/enableHeartBeat/heartbeat）存但不生效（data_model.md §1.1）
 *   - 无 status / 无 archived（squad 本身不参与工作项归档/取消可见性；那是 board 工作项语义）
 *   - 可硬删除（解散团队，v0.0.111）：DELETE /squad/:id → dissolveSquad（teardown→删session→deleteSquad→rmSync 目录），见 data_model.md §1.1
 *   - 信封 createdAt/updatedAt/version 由 CrudStore 注入，不在此声明
 */
import type { SchemaDef, InferRecord } from '../../../persistence/schema-types';

/**
 * squad entity 的 SchemaDef。
 * 落盘路径：{root}/squad/{squadId}.json（不分片；root=data_dir/squads 由 store 装配决定）。
 *
 * 注：根目录布局按 design.md §2「data_dir/squads/{squadId}/squad.json」，
 * 本 schema 不分片（entity 目录 = {root}/squad/），squad record 落此；
 * members 按 squadId 分片落到 {root}/squads/{squadId}/members/。
 * store 装配处用 root=data_dir 确保路径一致（详见 squad-store.ts）。
 */
export const SquadSchema = {
  entity: 'squad',
  engine: 'file',
  fields: {
    /** ULID 主键（业务生成） */
    id: { type: 'ulid', required: true },
    /** squad 名（required） */
    name: { type: 'string', required: true },
    /** 描述（可空） */
    description: { type: 'string', required: false },
    /** 默认模型 ModelRef 的 modelId 部分（required；与 modelDefaultProviderId 配对作复合 ModelRef） */
    modelDefault: { type: 'string', required: true },
    /**
     * modelDefault 的配对 providerId（INV-B1 复合 ModelRef；optional back-compat）。
     * 新数据建议填（精确解同名 model 歧义）；旧 squad 无此字段 → resolver fallback 跨 provider 反查（救存量）。
     * 参考: specs/tech/agent/providers_and_models/[P0]model_resolve.md §4 原则 3
     */
    modelDefaultProviderId: { type: 'string', required: false },
    /**
     * [v0.0.279] 团队默认推理强度（canonical 语义键 4 档：'default'|'low'|'high'|'max'）。
     * required:false：存量 squad 无字段 = 'default'（读取方 ?? 'default' 兜底）。
     * 覆盖链：成员显式档（low/high/max）→ 用之；否则本字段（low/high/max）→ 用之；否则 undefined（厂商默认）。
     * 对齐 modelDefault 模式放其下方；PATCH !== undefined 才写、显式 'default' 也落盘不清空。
     * 参考: specs/tech/version_logs/v0.0.279/change_plan.md（PRD D2）
     */
    effortDefault: { type: 'string', required: false },
    /** leader member id（建队回填，data_model §2.1 双向之一） */
    leaderId: { type: 'ulid', required: true },
    /** member id 列表（含 leader；建队/hire 维护） */
    memberIds: { type: 'json', required: true },
    /** 群聊 session id（建队回填） */
    squadChatSessionId: { type: 'ulid', required: true },
    /**
     * 写入消息 id（ulid，工具写 squad 时填；caller 不直传——从执行上下文自动取 currentMessageId）。
     */
    lastWriteMessageId: { type: 'ulid', required: false },
    /**
     * 占位 v4：预算（存但不生效，design.md §1.1）。
     * 形态 { limit, window:"daily", scope:"team" } | null。
     */
    budget: { type: 'json', required: false },
    /** squad 级心跳开关（默认 false；killswitch 由 handler gate0 每 tick 现取，job 恒注册无论开关值） */
    enableHeartBeat: { type: 'boolean', required: true },
    /**
     * IANA 时区（如 "Asia/Shanghai"），默认 user local。
     * activeWindow 判定 + daily 回血窗口都跟它（scheduler.md §4/§5）。
     * 缺省时 budget-aggregator/squad-runtime 各自回退 Intl 本地 tz（向前兼容老 squad 无此字段）。
     */
    timezone: { type: 'string', required: false },
    /**
     * [v0.0.116] squad 级心跳配置（SquadHeartbeatConfig | null）。
     * required:false：容忍历史无字段的 squad record（读旧 record 时 undefined，
     *   projectSquadHeartbeatConfig 以 ?? null 回退默认 interval15/全天/all）。
     * 形态：{ interval:5|15|30|60; activeWindows:Array<{start;end}>; scope:{mode;memberIds} }
     * null = 使用默认配置（interval=15、activeWindows=[]=全天、scope.mode=all）。
     * 参考: specs/tech/squad/[P1]data_model.md §1.1a
     */
    heartbeatConfig: { type: 'json', required: false },
    /**
     * [v0.0.270] squad 群聊可见性开关（默认开）。
     * true=注入 SquadChat 可达 + UI 显示群聊入口；false=两者隐藏（squad 实体恒存在，仅控可见性）。
     * required:false：容忍历史无字段的 squad record（读旧 record 时 undefined → 读取方 ?? true 兜底=开）。
     * 无 migration；新建 squad 由 createSquadService 显式写 true（与 enableHeartBeat:false 模式对称，方向相反）。
     * 参考: specs/tech/version_logs/v0.0.270/change_plan.md 裁决 1
     */
    enableGroupChat: { type: 'boolean', required: false },
  },
} as const satisfies SchemaDef;

/** squad 记录类型（从 SchemaDef 派生；信封由 store 注入） */
export type SquadRecord = InferRecord<typeof SquadSchema>;
