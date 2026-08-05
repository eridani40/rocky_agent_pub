/**
 * session entity 的 SchemaDef — Session 元数据主记录
 * 参考: specs/tech/agent/session/[P0]session_store.md §2（Session 接口）
 *       specs/tech/version_logs/v0.0.8/change_log.md §2.1 §6
 *
 * 落盘路径：{root}/session/<id>.json（单数 entity 名，与分片目录 sessions/ 区分）
 *
 * 设计：
 *   - 不分片（session 是顶层数据，需独立 list）
 *   - status 仅 active/archived 两值（v0.0.8）
 *   - contextWindowUsage 是 json 字段（v0.0.8 简化为 3 字段对象，由 updateContextWindowUsage 写）
 *   - 信封 createdAt/updatedAt/version 由 CrudStore 注入，不在此声明
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * session entity 的 SchemaDef。
 * 落盘：{root}/session/<id>.json
 */
export const SessionSchema = {
  entity: 'session',
  engine: 'file',
  fields: {
    /** ULID 主键（业务生成） */
    id: { type: 'ulid', required: true },
    /** 会话标题（可空） */
    title: { type: 'string', required: false },
    /** 会话状态（v0.0.8 仅 active/archived） */
    status: {
      type: 'enum',
      required: true,
      enumValues: ['active', 'archived'],
    },
    /**
     * context window usage（json 透传；v0.0.8 简化为 {tokenLimit,usedTokens,remainingTokens}）。
     * 由 SessionStore.updateContextWindowUsage 写入。
     */
    contextWindowUsage: { type: 'json', required: false },
    /**
     * v0.0.9：手动选 model 持久化到 session。用户在 chat-detail 选模型时
     * PUT /session/:id 写入；POST /session/:id/messages 解析顺序：
     * 请求体 > session 持久(providerId/modelId) > app_config 默认。
     * 可空（未手动选过时为 undefined，回退 app_config 默认）。
     */
    providerId: { type: 'string', required: false },
    /** v0.0.9：session 持久 modelId（配合 providerId，见上） */
    modelId: { type: 'string', required: false },
    /** v0.0.12：运行态六态（idle/running/interrupting/interrupted/error/suspended），见 session_state.md §1
     *  [v0.0.101] 加 'suspended'（HITL 悬挂态，合法存活态非错误）。 */
    state: {
      type: 'enum',
      required: false, // 兼容历史 session（无 state 字段），toSession 缺省 idle
      enumValues: ['idle', 'running', 'interrupting', 'interrupted', 'error', 'suspended'],
    },
    /** v0.0.12：冗余 bool（state ∈ {running, interrupting} ⇔ true） */
    running: { type: 'boolean', required: false },
    /** v0.0.12：当前活跃 Run ULID（无活跃 run 时 null/缺省） */
    currentRunId: { type: 'ulid', required: false },
    // v0.0.55：summaryTask 字段已删除（被 SessionTaskLock 统一锁取代，内存 only 不落盘）。
    //   原 spec [P0]session_state.md §3a 的 summaryTask CAS 已废弃；新机制见
    //   [P0]session_task_lock.md（per-session × per-task 内存锁 + acquire/markDone/markFailed）。
    //   历史 session record 中残留的 summaryTask 字段读时忽略（schema 不声明 → 不消费）。
    /**
     * v0.0.14：session 级 usage meta（三分区累加 + ratio 窗口 + contextWindowUsage）。
     * 形态见 session_usage.md §2/§7 + session_store.md §2 SessionUsageMeta：
     *   { current: AccumulatedUsage, sub: AccumulatedUsage, forked: AccumulatedUsage,
     *     ratio: { samples: number[], current: number } }
     * 兼容历史 session（无该字段）→ 缺省空 partitions / ratio.current=1.0。
     */
    usage: { type: 'json', required: false },
    /**
     * v0.0.14：子 agent session 的父 session id（递归 sub 上报用，见 session_usage.md §6.2）。
     * 顶层 session 不设；子 agent 创建时显式注入。
     */
    parentSessionId: { type: 'ulid', required: false },
    /**
     * [v0.0.17] session 关联的真实工作目录（绝对路径，持久化）。
     * 参考: specs/tech/agent/session/[P0]session_workspace.md §2
     * 用途：LLM 工具默认根（loop 启动 → SessionConfig.workdir）+ workspace reminder 数据源
     *       + WorkspacePanel 展示根 + fs watch 根。
     * 新 session 必填（POST /session handler 按 §3 策略建 <DATA_DIR>/workspaces/<sid>）；
     * 兼容历史 session（无该字段）→ toSession 缺省空串，lazy 修复时补建（§5）。
     */
    workspaceDir: { type: 'string', required: false },
    /**
     * [v0.0.27] 未读标记（explicit-bool 模型，spec session_state.md §6）。
     * 产生（markIdle/markError + 非前台 → CAS unread=true）与消除（POST /read → markRead CAS false）
     * 各写一次。兼容历史 session（无字段）→ toSession 缺省 false。GET 直接返回存储值，非派生。
     */
    unread: { type: 'boolean', required: false },
    /**
     * [v0.0.47] titled 标记（AI 起名 CAS gate，spec session/[P0]session_store.md §2 + auto_naming/[P0]auto_naming_service.md）。
     * true = title 已被命名（人工改名 OR AI 起名应用过）；false / 空缺 = title 仍是默认占位「新会话」。
     * **lazy 默认 false，不跑 migration**：AI 起名首 query 触发条件（transcript 无 prior role=user）
     * 天然保护现存 session（都有 prior user 消息）不被误触发，对齐 bizType/unread lazy 先例。
     * 置 true 的两个 timing：① AI 起名应用（CAS `titled===false → true`）；② 用户改名（PUT body.title 同步置 true）。
     * createSession 强制写 false（即便 caller 不传）。兼容历史 session（无字段）→ toSession 缺省 false。
     */
    titled: { type: 'boolean', required: false },
    /**
     * [v0.0.231] 会话置顶标记（仅 playground 列表消费，spec session_store.md §2）。
     * true = 已置顶（置顶组在前、同组内 updatedAt desc，前端展示层归位）。
     * **lazy 默认 false，不跑 migration**（对齐 unread/titled 先例，历史 session 缺省 false）。
     * 写路径唯一 = PUT /session/:id body.pinned；pinned-only 更新不推进 updatedAt
     * （置顶是纯标记操作，用户裁决 2026-08-01，经 PutOptions.preserveUpdatedAt）。
     */
    pinned: { type: 'boolean', required: false },
    /**
     * [v0.0.56] 业务分区（替代 bizType 作为权威字段；bizType 一期过渡保留）。
     * 参考: specs/tech/agent/session/[P0]session_kind.md §2.1
     * 必填——不再有「空=playground」懒默认散落各处。
     * [v0.0.210] 加 'academy'（培养 agent 教室板块）。
     */
    biz: {
      type: 'enum',
      required: true,
      enumValues: ['playground', 'studio', 'academy'],
    },
    /**
     * [v0.0.56] 会话角色（subagent 存 parent.role bloodline）。
     * 参考: specs/tech/agent/session/[P0]session_kind.md §2.1
     * 'rocky'=playground 主会话；'leader'/'mate'/'squad'=studio 三角色。
     * [v0.0.210] 加 'head_teacher'/'coach'/'student'=academy 三角色。
     * subagent 不在此枚举——用 derivation='subagent' 独立表达。
     */
    role: {
      type: 'enum',
      required: true,
      enumValues: ['rocky', 'leader', 'mate', 'squad', 'head_teacher', 'coach', 'student'],
    },
    /**
     * [v0.0.56] 派生层级（替代 type='subagent'+scope='subagent' 双字段不变量）。
     * 参考: specs/tech/agent/session/[P0]session_kind.md §2.1
     * [v0.0.204] main→parent 改名（parent=非派生顶级；subagent=派生）。
     */
    derivation: {
      type: 'enum',
      required: true,
      enumValues: ['parent', 'subagent'],
    },
    /**
     * [v0.0.28] 派生者 session（权威关联，顶层 Session 属性）。
     * 注：本字段在 v0.0.14 已作为顶层 parentSessionId（ulid）落 schema（line 77），
     * 此处注释仅说明 v0.0.28 multi_agent 语义升级。不重复加 schema 字段。
     */
    // parentSessionId 复用 v0.0.14 schema 字段，不重复声明。
    // [v0.0.56] type + scope schema 字段已删除（被 role + derivation 替代）。
    /**
     * [v0.0.28] 派生自哪个模板标签（如 "explorer"）；仅 type=subagent 有意义。
     * inline spawn（无 templateRef）→ null/undefined。兼容历史 session → undefined。
     */
    subAgentTemplateType: { type: 'string', required: false },
    /**
     * [v0.0.28] 由哪次 spawn 产生（审计/观测）。
     * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §2（origin 结构）。
     */
    origin: { type: 'json', required: false },
    /**
     * [v0.0.28] subagent 派生配置（仅 type=subagent；spawn 时 eff 持久化）。
     * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §4（resolve effective）。
     * 持 {systemPrompt, tools[], skills?, maxIter}；buildSessionConfigFromDeps 覆盖默认。
     */
    subAgentConfig: { type: 'json', required: false },
    /**
     * [v0.0.33.1] 所属 squad（所有 studio session 带：squad/leader/mate + studio 内 subagent）。
     * 参考: specs/tech/squad/[P1]data_model.md §1.4 §2.3（session⇄squad 单向关联）。
     * 顶层 standalone 不填；squad 层 session 必填。
     */
    squadId: { type: 'ulid', required: false },
    /**
     * [v0.0.33.1] 关联 member（仅 leader/mate session 带，双向之一）。
     * 参考: specs/tech/squad/[P1]data_model.md §1.4 §2.2（member⇄session 双向）。
     * subagent session 无 memberId。
     */
    memberId: { type: 'ulid', required: false },
    /**
     * [v0.0.58] session 时区（IANA，optional）。
     * 参考: specs/tech/scheduling/[P1]cron_subsystem.md §5（取值优先级 + 缺省 fallback）
     *
     * 用途：cron job 在该时区本地字段下解析（agent 不传 tz，强制归属 session）。
     * 取值优先级：session.timezone → session.squadId 非空 → squad.timezone → 进程本地
     *   Intl.DateTimeFormat().resolvedOptions().timeZone。
     * 兼容历史 session（无字段）→ 缺省走 fallback 链。
     */
    timezone: { type: 'string', required: false },
    /**
     * [v0.0.101] 悬挂 tool call 队列（HITL 落盘，INV-3）。
     * 参考: reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §4
     * 形态：PendingToolCall[]（每元素含 sessionId/runId/toolCallId/toolName/handleType/
     *   subState/data/resultMessageId?/resultBlockIndex?/status）。
     * 默认 []（兼容历史 session 无字段 → toSession 缺省 []）；tool_pending 触发时写入，
     * 回填逐条 resolve；放弃路径（c 路径）清空。
     * 用 json 透传（复杂结构，schema 层不拆元素 schema）。
     */
    pendingToolCalls: { type: 'json', required: false },
    /**
     * [v0.0.148] session 级 effort 推理强度（canonical 语义键，4 档）。
     * 参考: specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §3.5
     * 'default'=厂商默认行为（encode 不注入 output_config）；low/high/max 对应 anthropic wire 同名值。
     * 兼容历史 session（无字段）→ toSession lazy 缺省 'default'。
     * 由 PUT /session/:id 透传写入；buildSessionConfigFromDeps 读 → config.effort → encode wire。
     */
    effort: {
      type: 'enum',
      required: false,
      enumValues: ['default', 'low', 'high', 'max'],
    },
    /**
     * [v0.0.148] session 级审批模式（绿灯开关）。
     * 参考: specs/tech/agent/tools/[P0]tool_permission.md §5/§10.7
     * 'normal'=默认审批流程（ask 走审批卡）；'greenlight'=绿灯（ask 分支短路 fall through，视同 allow）。
     * 绿灯只在 ask 分支内短路；deny 分支（策略门）在其之前，绿灯不绕策略 deny。
     * 兼容历史 session（无字段）→ toSession lazy 缺省 'normal'。
     */
    approvalMode: {
      type: 'enum',
      required: false,
      enumValues: ['normal', 'greenlight'],
    },
    /**
     * [v0.0.148] always-approved keys 持久化（纠正 v0.0.122 D2 纯内存重启清空）。
     * 参考: specs/tech/agent/tools/[P0]tool_permission.md §5（per-session 持久化）
     * 存 string[]（approvalKey 集合，如 ['bash:rm-wildcard']）；Set 语义（去重）。
     * 兼容历史 session（无字段）→ toSession lazy 缺省 []。
     * 仅 ApprovalManager 内部 read-modify-write 写（allow_always 回填路径）；
     * 不进 UpdateSessionBody（防客户端任意改写）。
     */
    alwaysApprovedKeys: { type: 'json', required: false },
    /**
     * [v0.0.210] academy 实例上下文 4 字段（落盘投影；SessionContext 的持久化形态）。
     * 参考: specs/tech/academy/[P0]session_kind_extension.md §1.2 + [P0]data_model.md §1
     * 仅 biz='academy' 的 session 填；非 academy session 应为 undefined。
     * 学院 session 必填性由 validateSessionContext 兜底（schema 层 required=false 兼容历史 session）。
     */
    academyClassroomId: { type: 'ulid', required: false },
    /** academy student session 必填（具体版本绑定用） */
    academyStudentId: { type: 'ulid', required: false },
    /** academy student session 必填（具体版本绑定用） */
    academyVersionId: { type: 'ulid', required: false },
    /** academy coach session 必填（绑定训练任务） */
    academyTrainingTaskId: { type: 'ulid', required: false },
  },
} as const satisfies SchemaDef;

/** session 记录类型（从 SchemaDef 派生） */
export type SessionRecord = InferRecord<typeof SessionSchema>;
