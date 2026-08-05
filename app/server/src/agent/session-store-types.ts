/**
 * SessionStore 对外业务类型（与 spec session_store.md §2/§4 对齐）
 * 参考: specs/tech/agent/session/[P0]session_store.md §2（Session/Run）
 *       specs/tech/agent/context/[P0]context_snapshot_interface.md §2（SummaryInfo）
 *
 * 本文件只含类型，无运行时逻辑。
 */
import type { CompositeStore } from '../persistence/composite';
import type { ReplayableEventBus } from './event-bus';
import type { BizType, Role, Derivation } from '@app/shared';
import type {
  Message,
  ContextWindowUsage,
  Usage,
} from '../message/types';
// LlmErrorCategory（RunErrorInfo.errorCategory 用）
import type { LlmErrorCategory } from '../llm/caller/error_types';
import type { SessionTypeProfileLoader } from './session-type-profile-loader';
import type { LogWriter } from '../dev-logs/log-writer';
// [v0.0.101] PendingToolCall（Session.pendingToolCalls 元素类型）
import type { PendingToolCall } from '../tools/types';

/**
 * Run 失败时的结构化错误信息（stopReason="error" 时携带）。
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §9.1
 *       specs/api/version_logs/v0.0.25/change_log.md §1.5
 *
 * 结构化三件套：
 *   - errorCategory：LlmErrorCategory 枚举值（权威分类）
 *   - displayReason：用户可读理由（从 category 派生，前端可直接显示）
 *   - errorDetail：raw provider message（给 debug tooltip / log，不直接给终端用户）
 *
 * ABORTED_BY_USER 不走 error（走 interrupted），不填 RunErrorInfo。
 * 非 error 的 stopReason（no_tool_call / max_iterations / doom_loop / no_new_messages / tool_pending）也不填。
 */
export interface RunErrorInfo {
  /** LLM 错误分类（恢复语义，19 值枚举） */
  errorCategory: LlmErrorCategory;
  /** 用户可读理由（从 category 派生，见 display_reason.ts 映射表） */
  displayReason: string;
  /** raw provider message（debug / log；可选） */
  errorDetail?: string;
}

/**
 * Session 运行态六态枚举（权威定义见 [P0]session_state.md §1）。
 * - idle：初始/正常结束后的空闲
 * - running：run 进行中（loop 活跃）
 * - interrupting：abort api 收尾中（临时态，currentRunId=null）
 * - interrupted：被中断后的终态
 * - error：run 出错后的终态
 * - suspended：[v0.0.101] HITL 悬挂态（tool_pending StopReason 触发，等待用户回填）
 *   合法存活态（非错误非空闲）；running bool 排除 suspended（INV-2，列表亮「?」非 spinner）；
 *   reconcileOnStartup 保留 suspended（INV-3）；markRunning WHERE 含 suspended（O6 闸门）。
 */
export type SessionState =
  | 'idle'
  | 'running'
  | 'interrupting'
  | 'interrupted'
  | 'error'
  | 'suspended';

/** Session 业务视图（信封 + 业务字段） */
export interface Session {
  id: string;
  title?: string;
  status: 'active' | 'archived';
  contextWindowUsage?: ContextWindowUsage;
  /**
   * 手动选 model 持久化。用户在 chat-detail 选模型时
   * PUT /session/:id 写入；POST /session/:id/messages 解析顺序：
   * 请求体 > session 持久 > app_config 默认。可空。
   */
  providerId?: string;
  /** session 持久 modelId（配合 providerId，见上） */
  modelId?: string;
  /** 运行态六态（idle/running/interrupting/interrupted/error/suspended），见 [P0]session_state.md */
  state: SessionState;
  /** 冗余 bool（state ∈ {running, interrupting} ⇔ true），高频查询用；suspended 排除（INV-2） */
  running: boolean;
  /** 当前活跃 Run 的 ULID（= AgentLoop.runId），无活跃 run 时 null */
  currentRunId: string | null;
  /**
   * [v0.0.101] 悬挂 tool call 队列（HITL 落盘，INV-3）。
   * tool_pending StopReason 触发时由 runReActLoop ③ 段写入；回填后逐条 resolve；
   * 放弃路径（c 路径）直接清空。默认 []（兼容旧 session 无字段 → toSession 缺省 []）。
   * 前端 GET /pending-tool-call peek 队首驱动提问卡渲染（recover d 路径）。
   */
  pendingToolCalls?: PendingToolCall[];
  /**
   * 未读标记（explicit-bool 模型，spec session_state.md §6 + session_store.md §2）。
   * - 产生：agent-loop markIdle/markError 后 + 非前台（isSessionActive=false）→ CAS unread=true
   * - 消除：POST /session/:id/read → markRead CAS unread=false + emit session_read_update
   * 兼容历史 session（无字段）缺省 false。GET 直接返回，非派生。
   */
  unread: boolean;
  /**
   * titled 标记（AI 起名 CAS gate，spec session_store.md §2 + auto_naming/[P0]auto_naming_service.md）。
   * - true = title 已被命名（人工改名 OR AI 起名应用过）；false / undefined / 空缺 = title 仍是默认占位「新会话」。
   * - lazy 默认 false，不跑 migration（首 query 触发条件天然保护现存 session）。
   * - 置 true 的两个 timing：① AI 起名应用 CAS `titled===false → true`；② 用户改名 PUT body.title 同步置 true。
   * - 兼容历史 session（无字段）→ toSession 缺省 false。createSession 强制写 false。
   * - optional：对齐 spec（`titled?: boolean`）；toSession 始终规范化为 boolean，但 mock fixture
   *   手构造 Session literal 时可省略（CAS gate `=== true` 对 undefined 安全短路）。
   */
  titled?: boolean;
  /**
   * [v0.0.231] 会话置顶标记（仅 playground 列表消费，spec session_store.md §2）。
   * - true = 已置顶（置顶组在前、同组内 updatedAt desc——前端 store 统一比较器归位）。
   * - lazy 默认 false，不跑 migration（toSession `r.pinned === true` 规范化，对齐 unread/titled）。
   * - 写路径唯一 = PUT /session/:id body.pinned；pinned-only 更新不推进 updatedAt
   *   （置顶是纯标记操作，用户裁决 2026-08-01，经 PutOptions.preserveUpdatedAt）。
   * - session 层不感知 pinned 语义，只持久化；分组/排序纯前端展示层。
   */
  pinned?: boolean;
  /** 子 agent session 的父 session id（递归 sub 上报用，见 session_usage.md §6.2）；顶层 session 无 */
  parentSessionId?: string;
  /**
   * 业务分区（权威字段）。
   * 参考: specs/tech/agent/session/[P0]session_kind.md §2.1
   */
  biz?: BizType;
  /**
   * 会话角色（权威字段）。
   * 参考: specs/tech/agent/session/[P0]session_kind.md §2.1
   */
  role?: Role;
  /**
   * 派生层级（权威字段）。
   * 参考: specs/tech/agent/session/[P0]session_kind.md §2.1
   */
  derivation?: Derivation;
  /**
   * 派生自哪个模板标签（如 "explorer"）；仅 type=subagent 有意义。
   * inline spawn（无 templateRef）→ undefined。
   */
  subAgentTemplateType?: string;
  /**
   * 由哪次 spawn 产生（审计/观测）。
   * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §2（origin 结构）。
   */
  origin?: { spawnRunId: string; toolCallId: string };
  /**
   * subagent 派生配置（仅 type=subagent 填；spawn 时 eff 解析结果持久化）。
   * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §4（resolve effective + createSession）
   *
   * 背景：spawn 时 executeSpawn 调 resolveEffective 算出 eff（systemPrompt/tools/skills/maxIter），
   * 必须持久化到 session record，否则 deliverTo→resolveConfig→buildSessionConfigFromDeps
   * 重建 config 时会用空字符串占位 + defaultTools，subagent 人设/工具白名单全丢，
   * 导致 child 用错误配置跑（explorer 不探查直接 no_tool_call）。
   *   重建时 systemPrompt 占位为空字符串（无默认人设兜底）。
   * buildSessionConfigFromDeps 优先用本字段覆盖默认 systemPrompt/tools/maxIter。
   */
  subAgentConfig?: {
    /** subagent systemPrompt（explorer 模板人设 / inline spawn 覆盖） */
    systemPrompt: string;
    /**
     * subagent 工具白名单（如 ['read','web_search','send_message']；不含 agent）
     * [v0.0.222] 三态：undefined=继承 subagent profile toolBound（默认）/ []=显式空 / 非空=与 bound 交集
     */
    tools?: string[];
    /** subagent skills（模板 skills 或 inline 覆盖；可空） */
    skills?: string[];
    /** subagent maxIter（来源 spawn-action.ts：spawn 入参 maxIter ?? 独立默认，不走 DEFAULT_MAX_ITERATIONS） */
    maxIter: number;
  };
  /**
   * session 关联的真实工作目录（绝对路径，持久化）。
   * 参考: specs/tech/agent/session/[P0]session_workspace.md §2
   * - 新 session 必填（POST /session handler 建默认 <DATA_DIR>/workspaces/<sid>）
   * - 历史兼容：旧 session 无此字段 → toSession 缺省 ''，lazy 修复（getSession 读后补建）
   */
  workspaceDir: string;
  /**
   * 所属 squad（所有 studio session 带：squad/leader/mate + studio 内 subagent）。
   * 参考: specs/tech/squad/[P1]data_model.md §1.4 §2.3（session⇄squad 单向关联）
   * 顶层 standalone session 不填；squad 层 session 必填。
   */
  squadId?: string;
  /**
   * 关联 member（仅 leader/mate session 带，双向之一）。
   * 参考: specs/tech/squad/[P1]data_model.md §1.4 §2.2（member⇄session 双向）
   * subagent session 无 memberId（它是 member 派生的临时子 agent，不是 member 本身）。
   */
  memberId?: string;
  /**
   * [v0.0.210] academy 4 实例字段（持久化 SessionRecord.academyXxx 的读侧投影）。
   * 仅 biz='academy' 的 session 带；createSession 入参侧是 CreateSessionInput.classroomId/...
   * （写时映射为 academyXxx 落盘，见 session-store-core-impl）。
   * 消费方：resolveConfig / buildAgentToolContext 组 SessionContext（classroomId/trainingTaskId 等）。
   */
  academyClassroomId?: string;
  /** academy student session 带（学生绑定） */
  academyStudentId?: string;
  /** academy student session 带（具体版本绑定） */
  academyVersionId?: string;
  /** academy coach session 带（绑定训练任务） */
  academyTrainingTaskId?: string;
  /**
   * session 时区（IANA，optional）。
   * 参考: specs/tech/scheduling/[P1]cron_subsystem.md §5（取值优先级 + 缺省 fallback）
   * cron 工具取 tz：session.timezone → squad.timezone → 进程本地。
   * 兼容历史 session（无字段）→ undefined，cron 工具走 fallback 链。
   */
  timezone?: string;
  /**
   * [v0.0.148] session 级 effort 推理强度（canonical 语义键，4 档）。
   * 'default'=厂商默认行为（encode 不注入 output_config）。
   * 兼容历史 session（无字段）→ toSession lazy 缺省 'default'。
   * PUT /session/:id 透传写入；buildSessionConfigFromDeps 读 → config.effort。
   */
  effort?: 'default' | 'low' | 'high' | 'max';
  /**
   * [v0.0.148] session 级审批模式（绿灯开关）。
   * 'normal'=默认审批；'greenlight'=绿灯（ask 短路 fall through）。
   * 兼容历史 session（无字段）→ toSession lazy 缺省 'normal'。
   */
  approvalMode?: 'normal' | 'greenlight';
  /**
   * [v0.0.148] always-approved keys（per-session 持久化，纠正 v0.0.122 D2）。
   * 存 approvalKey 集合（如 ['bash:rm-wildcard']）；Set 语义（去重）。
   * 兼容历史 session（无字段）→ toSession lazy 缺省 []。
   * 仅 ApprovalManager 内部写（allow_always 回填），不进 UpdateSessionBody。
   */
  alwaysApprovedKeys?: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** Run 业务视图 */
export interface Run {
  id: string;
  sessionId: string;
  /** interrupted：abort 收尾 / 崩溃恢复 */
  status: 'running' | 'completed' | 'failed' | 'paused' | 'interrupted';
  stopReason?: string;
  /**
   * run 失败时的结构化错误信息（仅 stopReason="error" 时存在）。
   * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §9.1
   * eager-drain 落 SessionStore 持久化；forked 不落（旁路）。
   */
  error?: RunErrorInfo;
  contextWindowUsage?: ContextWindowUsage;
  startedAt: string;
  endedAt?: string;
  version: number;
}

/** session 运行态快照（session_status_update 事件 data；见 session_event.md §2） */
export interface SessionStatus {
  state: SessionState;
  running: boolean;
  currentRunId: string | null;
}

/** Summary 业务视图（对齐 SummaryInfo） */
export interface SummaryInfo {
  version: number;
  summaryUpTo: string | null;
  content: string | null;
  /**
   * [v0.0.186] 烘焙的完整 summary block 文本（preamble+head+tail，compact 时一次构建持久化）。
   * 组装期 base_builder 直接用作 msg[0]（零选取零计算，prompt 缓存前缀逐字节稳定）。
   * 旧记录无此字段 → null → 组装走 v0.0.185 即时构建 fallback，下次 compact 自动升级。
   */
  block: string | null;
  createdAt: string;
  updatedAt: string;
}

/** getMessages 分页范围（对齐 session_store.md §4 MessageRange） */
export interface MessageRange {
  /** 取该 id ULID 字典序之前的 limit 条 */
  beforeId?: string;
  /** 起始 message id（含） */
  fromId?: string;
  /** 结束 message id（含） */
  upToId?: string;
  /** 返回条数上限，缺省 50 */
  limit?: number;
  /**
   * [v0.0.185] 取范围头部 limit 条（缺省 false = 取范围尾部 limit 条）。
   * 仅无 beforeId 时生效；用于 head 候选锚定会话真第一条（prompt 缓存前缀稳定）。
   */
  takeFromStart?: boolean;
}

/** getMessages 返回形态 */
export interface MessagePage {
  items: Message[];
  /** 是否还有更早/更多的消息 */
  hasMore: boolean;
}

/**
 * store 调用可选参数（消息缓冲类方法用）。
 *
 * 设计原则：`session`(sid) 与 `run`(runId) 是通用领域 id——任何调用点都同时拥有二者。
 * `slot` 只是 in_memory 这个特定 ext impl 的内部概念（Map 桶 key = runId），不出现在本类型。
 * 本 opts 仅承载「消息缓冲类方法（appendMessages/getMessages/releaseSlot）按 run 隔离」所需的 runId，
 * 以及未来可能新增的 per-call store 参数——加字段不改任何方法签名。
 *
 * session-meta 类方法（getSummary/getRatio/updateContextWindowUsage）与 run 无关，不接受本 opts。
 */
export interface StoreCallOpts {
  /**
   * run 身份（通用领域 id）。forked 路径 caller 传 runId；default/HTTP 路径不传。
   * in_memory_session_store 内部用 runId 作 buffer 桶 key（per-run 隔离）；persistent 忽略。
   */
  runId?: string;
}

/** listChildren 状态分组枚举（derivation §3） */
export type ChildStatusFilter = 'running' | 'terminated';

/**
 * list_children 单 child 摘要（api 10-multi-agent §3.2 ChildSummary）。
 * 用于 GET /session/:id/children + agent.query action 同源数据。
 */
export interface ChildSummary {
  sessionId: string;
  /** subagent 显示名（有模板=模板 name；inline= "subagent" 默认占位） */
  name: string;
  /** child session state（对齐 Session.state；running/interrupting 落 running 组）。
   *  [v0.0.101] 加 'suspended'（subagent 同样可悬浮；running/interrupting 落 running 组不变）。 */
  state: 'idle' | 'running' | 'interrupting' | 'interrupted' | 'error' | 'suspended';
  /** 模板标签（inline spawn 无模板=null） */
  subAgentTemplateType: string | null;
  /** isoDate，活跃时间（组内排序依据，复用 Session.updatedAt） */
  updatedAt: string;
}

/**
 * children/swarm 列表视图（api 10-multi-agent §3.2 ChildrenView）。
 * running/terminated 分组，组内按 updatedAt desc。
 */
export interface ChildrenView {
  parentSessionId: string;
  /** state==='running' 的 child（interrupting 视觉暂显运行态，spec §3.2） */
  running: ChildSummary[];
  /** state ∈ {idle, error, interrupted} 的 child（run 已结束） */
  terminated: ChildSummary[];
}

/**
 * listChildren 查询过滤参数（derivation §7 list_children filter）。
 * - status?: 仅返该组（'running' / 'terminated'）；缺省=两组都返
 * - templateType?: 按模板标签筛（HTTP 端点本版不暴露，仅 LLM agent.query 用）
 * - limit?: 单组最多返回 N 条（按 updatedAt desc 截断）；缺省 20
 */
export interface ListChildrenFilter {
  status?: ChildStatusFilter;
  templateType?: string;
  limit?: number;
}

/** 创建 Session 入参 */
export interface CreateSessionInput {
  id: string;
  title?: string;
  status?: 'active' | 'archived';
  contextWindowUsage?: ContextWindowUsage;
  /** 创建时持久 providerId/modelId（POST /session 落库） */
  providerId?: string;
  /** 创建时持久 modelId（配合 providerId） */
  modelId?: string;
  /** 子 agent session 的父 session id（递归 sub 上报用） */
  parentSessionId?: string;
  /** 工作目录绝对路径（caller 按 session_workspace.md §3 策略建好传入；不传时 handler 默认 <DATA_DIR>/workspaces/<sid>） */
  workspaceDir?: string;
  /** 业务分区（权威字段） */
  biz?: BizType;
  /** 会话角色（权威字段） */
  role?: Role;
  /** 派生层级（权威字段） */
  derivation?: Derivation;
  /** 派生自哪个模板标签（仅 type=subagent 有意义） */
  subAgentTemplateType?: string;
  /** 由哪次 spawn 产生（审计/观测） */
  origin?: { spawnRunId: string; toolCallId: string };
  /** subagent 派生配置（仅 derivation=subagent 填；见 Session.subAgentConfig） */
  subAgentConfig?: {
    systemPrompt: string;
    /** [v0.0.222] 三态：undefined=继承 bound / []=显式空 / 非空=交集 */
    tools?: string[];
    skills?: string[];
    maxIter: number;
  };
  /** 所属 squad（见 Session.squadId）；squad 层 session 填 */
  squadId?: string;
  /** 关联 member（见 Session.memberId）；仅 leader/mate session 填 */
  memberId?: string;
  /**
   * [v0.0.210] academy 4 字段——SessionContext.classroomId/studentId/versionId/trainingTaskId
   * 的持久化入参。仅 biz='academy' 的 session 填；validateSessionContext C4-C7 强制校验。
   */
  classroomId?: string;
  /** [v0.0.210] academy student session 必填（具体版本绑定用） */
  studentId?: string;
  /** [v0.0.210] academy student session 必填（具体版本绑定用） */
  versionId?: string;
  /** [v0.0.210] academy coach session 必填（绑定训练任务） */
  trainingTaskId?: string;
  /**
   * [v0.0.148] 创建时持久 effort（POST /session 可带）；缺省 → toSession 'default'。
   * alwaysApprovedKeys 不进 create input（新建无「已批准」语义，由 toSession 缺省 []）。
   */
  effort?: 'default' | 'low' | 'high' | 'max';
  /** [v0.0.148] 创建时持久 approvalMode；缺省 → toSession 'normal' */
  approvalMode?: 'normal' | 'greenlight';
}

/** 创建 Run 入参 */
export interface CreateRunInput {
  id: string;
  sessionId: string;
  status?: 'running' | 'completed' | 'failed' | 'paused' | 'interrupted';
  stopReason?: string;
  /** run 失败错误信息（stopReason="error" 时填；可后置 updateRun 写） */
  error?: RunErrorInfo;
}

/** SessionStore 构造参数 */
export interface SessionStoreOptions {
  /**
   * 已 mount 4 schema 的 CompositeStore。
   * 须 CompositeStore（非 CrudStore）：callsite 走 putAsync/deleteAsync，CrudStore 接口不含
   * （spec file_write_lock §4.3 + §6.1）。
   */
  crud: CompositeStore;
  /** fs root（用于级联删 sessions/{sid}/ 目录；仅 fs engine 需要） */
  fsRoot?: string;
  /** session_panel topic 的 bus（推送 session_status_update；缺省 no-op） */
  statusBus?: ReplayableEventBus;
  /** [dev-logs] agent 诊断日志（透传给 SessionStateMachine 写 logs/agent.log；缺省不写） */
  logWriter?: LogWriter;
  /**
   * [v0.0.204 T2-B5] SessionTypeProfileLoader 引用——createSession enabled 门用（STP §8）。
   * 缺省 → enabled 门跳过（UT fixture / dev misconfig 容忍）；生产路径 bootstrap 必注。
   * 仅 main-run 类型（derivation='parent'）走门：profile 必须存在且 enabled!==false。
   */
  sessionTypeProfileLoader?: SessionTypeProfileLoader;
}

/**
 * SessionUsageView 聚合视图。
 * current/sub/forked/total 由真累加派生。
 * 4 个 cacheRate 派生字段（input_cache_read / input_total_tokens，分母 0 返 0）。
 * full 形态见 session_usage.md §8。每个 partition Record<string,number> 为 AccumulatedUsage
 * 字段（token+char+cost Σ + llmCallCount）。
 */
export interface SessionUsageView {
  current: Record<string, number>;
  sub: Record<string, number>;
  forked: Record<string, number>;
  total: Record<string, number>;
  ratio: number;
  /** 最近 assemble 的 context window 占用（可空） */
  contextWindowUsage?: ContextWindowUsage;
  /** 4 个 cacheRate 派生字段（cache_read / input_total，分母 0 返 0） */
  currentCacheRate: number;
  subCacheRate: number;
  forkedCacheRate: number;
  totalCacheRate: number;
}

/** 零值 view（getUsageView 遇 session 不存在时返回） */
export const ZERO_USAGE_VIEW: SessionUsageView = {
  current: {},
  sub: {},
  forked: {},
  total: {},
  ratio: 1.0,
  currentCacheRate: 0,
  subCacheRate: 0,
  forkedCacheRate: 0,
  totalCacheRate: 0,
};

/** Usage 分区（对齐 session_usage.md §3） */
export type UsagePartition = 'current' | 'sub' | 'forked';

/**
 * updateUsage 统一更新入参（写 + 推一体，caller 只 set 不推）。
 * 只写传入的字段；写完对涉及的 sid 链逐个 emit session_usage_update
 * （推送时总是读 getUsageView 全量——改 cw 时累计分区必为最新值，改累计时 cw 必为最新值）。
 */
export interface UpdateUsageOpts {
  /** 传入则写 session 级 contextWindowUsage（assemble 产出） */
  contextWindowUsage?: ContextWindowUsage;
  /** 累计目标分区（须与 usage 成对传入；缺一则累计不生效） */
  usagePartition?: UsagePartition;
  /** 累计增量（与 usagePartition 成对） */
  usage?: Usage;
}

/** re-export Usage 便于调用方一站式 import */
export type { Usage, ContextWindowUsage, Message };
