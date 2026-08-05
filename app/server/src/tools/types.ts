/**
 * 工具子系统核心类型（业务权威源）
 * 参考: specs/tech/agent/tools/[P0]tool_execution_engine.md §2
 *       specs/tech/version_logs/v0.0.101/change_plan.md 模块 A（pending/HITL 载荷类型）
 *
 * 本文件定义工具子系统的对外类型契约：
 *   - ToolDefinition（给 LLM 的声明：name/description/inputSchema）
 *   - Tool（实现：definition + 可选 interaction（HITL 悬挂判定）/ onReply（callback 回填）+ run）
 *   - ToolCtx（执行上下文，引擎构造后传给 tool.run / tool.interaction）
 *   - ToolRunResult（tool.run 返回值：content + isError）
 *   - ToolErrorCode（错误码枚举，用于错误归类）
 *   - [v0.0.101] HITL 载荷类型：FeedbackData / Question / ApprovalData / ToolInteraction / PendingToolCall
 *
 * HITL 模型（v0.0.101 起）：Tool.interaction(input, ctx) 返非 null → 引擎不调 run，
 * 转而构造 pending ToolResultBlock + PendingToolCall wrapper（落盘悬挂队列）；
 * 返 null / undefined → 普通 tool，立即 run。
 * ToolCtx.config 仅声明 engine 需要的最小结构，用结构化类型兼容 SessionConfig，不强耦合。
 *
 * [v0.0.101] 命名约定（architect 锁定，见 change_plan 模块 A）：
 *   - ToolInteraction 用 `subType`（tool 作者侧返回的类型标签）
 *   - PendingToolCall / ToolResultBlock 用 `subState`（运行/存储侧的子状态）
 *   二者值域相同（'need_feedback'|'need_approval'）；命名差异是契约锁定，非笔误。
 */
import type { ContentBlock } from '../message/types';
import type { ChildProcessRegistry } from './child-process-registry';

// ============================================================
// 1. JSONSchemaLike（inputSchema，宽松形态）
// ============================================================

/**
 * 工具 input schema（JSON Schema 子集，宽松形态）。
 * 不引入 ajv 等校验库，engine 做轻量结构校验（必填 + 类型 primitive）；
 * 完整 JSON Schema 校验留待后续版本。此类型仅约束形状，便于 LLM 读 schema。
 */
export interface JSONSchemaLike {
  type?: 'object' | 'string' | 'number' | 'boolean' | 'array' | 'integer';
  /** object 类型时的属性表 */
  properties?: Record<string, JSONSchemaLike>;
  /** 必填属性名列表 */
  required?: string[];
  /** 描述（给 LLM 看） */
  description?: string;
  [key: string]: unknown;
}

// ============================================================
// 2. ToolDefinition（给 LLM 的声明 · 权威）
// ============================================================

/**
 * 工具声明（对齐 overall §2）。
 * assemble 时 config.tools.map(t => t.definition) 产 ToolDefinition[] → snapshot.tools。
 */
export interface ToolDefinition {
  /** 工具名（小写：read/write/edit/glob/grep/bash） */
  name: string;
  /** 给 LLM 的说明（完整版，进 tool schema / function calling） */
  description: string;
  /**
   * 一句话短简介，供 system prompt Tool Guidance 用（tool_guidance mapper）。
   * 无则 fallback 用 description。去掉 schema 已覆盖的细节（输出格式 / 参数 / 模式分支），
   * 避免 system prompt 与 tool schema 重复。可选；外部/非默认 plugin 不强制。
   */
  intro?: string;
  /** 参数 schema（LLM 据此构造 ToolCallBlock.arguments） */
  inputSchema: JSONSchemaLike;
}

// ============================================================
// 3. 工具输入 / 结果 / 上下文
// ============================================================

/** 工具输入（对应 ToolCallBlock.arguments） */
export type ToolInput = Record<string, unknown>;

/**
 * 工具执行结果（对齐 tool_execution_engine §2）。
 * content 通常是 TextBlock[]；错误时 content 携带错误描述，isError=true。
 */
export interface ToolRunResult {
  /** 结果内容（通常是 TextBlock，可含 ImageBlock 等） */
  content: ContentBlock[];
  /** 是否执行出错（→ ToolResultBlock.isError） */
  isError: boolean;
}

/**
 * 引擎与工具共享的最小 SessionConfig 形状（结构化类型，对齐 ../agent/context-types.ts SessionConfig）。
 * 完整 SessionConfig 由 agent/context-types.ts 权威定义（单一源）；本接口仅声明引擎所需的最小字段，
 * 让 task-5 构造的完整 SessionConfig 天然兼容（鸭子类型）。两者不重复定义权威形态。
 */
export interface ToolSessionConfigLike {
  /** 工具数组（引擎按 definition.name 路由；assemble 用其 definition） */
  tools: Tool[];
  /** session id（用于日志/审计，可选） */
  sessionId?: string;
  /**
   * [v0.0.148] session 级审批模式（绿灯）。
   * engine.execute ask 分支直读：'greenlight' → ask 短路（fall through 视同 allow）。
   * 缺省 undefined / 'normal' → 现状（ask 未批准悬挂审批卡）。
   * 与 ../agent/context-types.ts SessionConfig.approvalMode 镜像（结构化类型兼容）。
   */
  approvalMode?: 'normal' | 'greenlight';
  /** 工作目录（bash/file 工具的默认根；默认 <DATA_DIR>/workspace） */
  workdir?: string;
  /**
   * 引擎内部跨 execute 调用共享的 readSet（read→write/edit 跨工具链校验依赖）。
   * task-5 agent-loop 构造 config 时可不设；引擎首次 execute 时自动初始化并挂在 config 上。
   */
  _readSet?: Set<string>;
  /**
   * PluginManager 引用（web_search 等需读 EP provider 的工具消费）。
   * 由 session-config 构造期注入（与 buildLlmClient 同源 deps.pluginManager）。
   * 缺省 undefined → web_search 返「未配置 provider type」（isError）。
   */
  pluginManager?: unknown;
  /**
   * ConnectorManager 引用（browser tool mode=attach 读 attach session）。
   * 由 session-config 构造期注入；缺省 undefined → attach 返「未连接」引导 isError。
   */
  connectorManager?: unknown;
  /**
   * ComputerNativePort 引用（screenshot 等 computer use 工具读，走主进程原生能力）。
   * 由 session-config 构造期注入（从 deps.computerNativePort）；缺省 undefined →
   * screenshot tool fail-closed 返「仅桌面 App 可用」errorResult。
   * 类型用 unknown（鸭子类型，仅需 checkPermissions/screenshot），避免耦合 platform 模块。
   */
  computerNativePort?: unknown;
  /**
   * DriverRegistry 引用（browser tool 按 mode 取 BrowserDriver）。
   * 由 session-config 构造期注入；缺省 → headless/managed-profile 无 driver → isError。
   */
  browserDriverRegistry?: unknown;
  /**
   * agent 工具运行时上下文（spawn/query/abort + send_message 用）。
   * 由 agent-loop 注入；agent-tool / send-message-tool 经 ctx.config.agentToolContext 读。
   * 类型用 unknown（结构化类型由 agent/tools/runtime-context.ts 权威定义，本文件不耦合 agent 模块）。
   */
  agentToolContext?: unknown;
  /**
   * LogWriter 引用（dev 调试日志，tool hook）。
   * 由 session-config 构造期注入；engine.executeOne 经 config.logWriter 取用，
   * 每次真实工具调用写一条 logs/tool.log（not-allowed 分支不写）。
   * 缺省 undefined → 不写日志。类型用 unknown（鸭子类型，仅需 write(type, record)）。
   */
  logWriter?: unknown;
  /**
   * app 数据根（绝对路径）。由 session-config 构造期从 deps.dataDir 注入。
   * skill_manage 等工具经 ctx.config.dataDir 读 app 数据根（写 <dataDir>/skills/<name>/SKILL.md）。
   * 缺省 undefined → skill_manage 报 RUNTIME_ERROR。类型用 string（纯路径，无服务句柄）。
   */
  dataDir?: string;
  /**
   * AppConfigService 引用。由 session-config 构造期从 deps.appConfig 注入。
   * 消费方：
   *   - web_fetch 工具读 app_config web group（jina 配置）。
   *   - memory 注入配额（maxMemoryInject，session 组）由 plugin memory mapper 经同一服务读。
   * 缺省 undefined → web_fetch 走代码默认；mapper 用内置默认配额。
   * 类型用 unknown（鸭子类型，仅需 get/set），避免本文件耦合 config 模块。
   */
  appConfig?: unknown;
  /**
   * cron 工具运行时上下文（cronStore + engine + sessionStore 取 tz / squadStore fallback）。
   * 由 session-config 构造期注入；cron 工具（action: create/list/update/disable/enable/delete）
   * 经 ctx.config.cronToolDeps 读。类型用 unknown（鸭子类型），避免本文件耦合 scheduling 模块；
   * 实际形状由 tools/cron/cron-tool.ts CronToolDeps interface 定义，工具内部 downcast。
   * 缺省 undefined → cron 工具返 RUNTIME_ERROR。
   */
  cronToolDeps?: unknown;
  /**
   * [v0.0.126] history_search / history_get_context 工具运行时依赖。
   * 由 session-config 构造期从 deps.historyToolDeps 注入（bootstrap 装配 SearchEngine + SessionStore ref）。
   * 实际形状 = { searchEngine: SearchEngine; sessionStore: SessionStore }（见 tools/history-search-tool.ts HistoryToolDeps）。
   * 缺省 undefined → 两 tool 报 RUNTIME_ERROR（isError=true）。
   * 类型用 unknown 避免本文件耦合 persistence/agent 模块（鸭子类型）。
   */
  historyToolDeps?: unknown;
}

/**
 * 执行上下文（引擎构造，传给 tool.run，对齐 tool_execution_engine §2）。
 * 工具可按需扩展字段（如 file_op 的 readSet、bash 的 shell 状态）。
 */
export interface ToolCtx {
  /** session 配置（含 tools / sessionId / workdir） */
  config: ToolSessionConfigLike;
  /** 取消信号（超时 / loop 终止）；工具自行响应 */
  signal?: AbortSignal;
  /** 工作目录（config.workdir 的快捷引用，bash 默认 cwd 基址） */
  workdir: string;
  /**
   * 当前 session 已 read 的文件路径集合（file_op 共用）。
   * write/edit 覆盖已存在文件前校验该集合；read 成功后写入。
   * 跨工具共享 → 放在 ctx 而非各工具自维护。
   */
  readSet?: Set<string>;
  /**
   * [v0.0.130.hang] run 级子进程注册表（spawn 型工具如 bash 注册子进程用，供 run 终止级 sweep）。
   * 由 engine.execute() 从 ExecuteRunCtx.childRegistry 透传（沿 opts 链从 AbortControllerHandle.childRegistry 下沉）。
   * 缺省 undefined → 工具不注册（不影响单工具功能，只是 run 终止 killAll 时该工具的子进程不受 sweep 覆盖）。
   */
  childRegistry?: ChildProcessRegistry;
  /**
   * 当前 LLM tool_call 的 id（截图落盘命名用）。
   * engine.execute() per-call 从 ToolCallBlock.id（call.id）注入（唯一注入源）；
   * snapshot-store.saveSnapshot 消费：文件名 `<toolCallId>.<ext>` 确定性（INV-157-2，
   * record/replay 下 LLM stub 返相同 id → 路径稳定，避 stub 漂移）。
   * 可选字段：外部 mock 跳过 engine 时缺省 → saveSnapshot fallback `'unknown-'+Date.now()` 并 warn。
   */
  toolCallId?: string;
}

// ============================================================
// 4. Tool（实现）
// ============================================================

/**
 * 工具实现（对齐 tool_execution_engine §2 + §5 HITL 钩子）。
 *
 * 三种形态：
 *   - 普通 tool：只实现 `run`，引擎 execute 串行调它产 result
 *   - 悬挂型 tool（direct_result）：实现 `interaction`（恒返非 null）+ 不实现 run 或 run 永不达
 *       引擎不调 run，转构造 pending result + PendingToolCall；用户答案回填后 pre-process
 *       序列化 payload 编辑占位 block + status pending→success（如 ask-question）
 *   - callback tool：实现 `interaction`（返非 null）+ `onReply`（接 payload 自处理）
 *       handleType='callback' 分支：pre-process 调 tool.onReply(payload, ctx) → ToolRunResult
 *       编辑占位 block 为 onReply 产出的 result
 */
export interface Tool {
  /** 声明（给 LLM） */
  definition: ToolDefinition;
  /**
   * [v0.0.130.hang] per-tool 默认超时（ms，可选）。engine.runTool 解析有效超时时的第二优先级
   * （per-call > per-tool 本字段 > engine 兜底默认 30s），见 tools/engine-timeout.ts resolveEffectiveTimeout。
   * 未声明 → 该工具沿用 engine 默认 30s；声明值本身仍受 engine 硬天花板 600s 封顶。
   * MUST 仅声明数值，不改变 run 逻辑本身（超时行为完全由 engine 层 race 控制）。
   */
  defaultTimeoutMs?: number;
  /**
   * [v0.0.122] 权限检查钩子（可选，INV-P2 缺省=allow，其他工具不受影响）。
   * 参考: specs/tech/agent/tools/[P0]tool_permission.md §3
   *
   * 约束：
   *   - 同步纯判定：只读 input，不改外部状态、不发起 IO
   *   - 抛错兜底：引擎调用时 try/catch，异常视作 allow（fail-open）
   *   - 被引擎调用在 allowedTools 白名单门后、interaction 分流前（策略门 §4）
   *
   * 未实现 → 引擎跳过，行为与 v0.0.122 前完全一致（向后兼容）。
   */
  checkPermission?(input: ToolInput, ctx: ToolCtx): PermissionDecision;
  /**
   * [v0.0.101] HITL 悬挂判定（per-call，按 input 决定是否立即 run）。
   * - 返非 null：该 call 不立即 run；引擎构造 pending ToolResultBlock + PendingToolCall
   *   落盘到 session.pendingToolCalls，等用户回填（pre-process 处理 handleType 三分发）
   * - 返 null / undefined：普通 tool，立即调 run（默认行为，向后兼容）
   *
   * 实现 side-effect 注意：interaction 可能在 LLM call 前被多次调用（schema 校验失败重试等），
   * 应保持幂等纯读 input（不修改外部状态）。
   */
  interaction?(input: ToolInput, ctx: ToolCtx): ToolInteraction | null;
  /**
   * [v0.0.101] 回填处理（仅 handleType='callback' 用）。
   * pre-process 在用户回填后调此方法，传入用户 payload（FeedbackAnswer / ApprovalDecision），
   * tool 自行决定如何处理（如触发表格更新 / 触发外部 action）。
   * 返回的 ToolRunResult 编辑占位 block（替代原 pending content）。
   *
   * - direct_result handleType：不实现 onReply（pre-process 直接序列化 payload 为 result）
   * - approval handleType：本版 spec 留位不实例（allow 时补跑原 tool.run）
   */
  onReply?(payload: unknown, ctx: ToolCtx): Promise<ToolRunResult>;
  /** 执行（串行，引擎 await）；返回结果内容 + 是否出错。
   *  悬挂型 tool（interaction 恒返非 null）可不实现或永不达——引擎仅当 interaction 返 null 时才调 */
  run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult>;
}

// ============================================================
// 5. ToolErrorCode（错误归类）
// ============================================================

/**
 * 工具错误码（对内归类，错误描述仍以人类可读文本写进 content）。
 * 引擎/工具 catch 后可用此码做日志聚合，仅记录不驱动分支。
 */
export const ToolErrorCode = {
  /** 未知工具（未注册） */
  UNKNOWN_TOOL: 'unknown_tool',
  /** 参数校验失败（缺必填 / 类型错） */
  INVALID_INPUT: 'invalid_input',
  /** 路径非绝对（file 工具硬约束） */
  PATH_NOT_ABSOLUTE: 'path_not_absolute',
  /** 文件/路径不存在 */
  NOT_FOUND: 'not_found',
  /** 覆盖已存在文件前未 read（write/edit 硬约束） */
  NOT_READ: 'not_read',
  /** edit oldString 未找到 */
  STRING_NOT_FOUND: 'string_not_found',
  /** edit oldString 多处匹配（replaceAll=false 时） */
  MULTIPLE_MATCHES: 'multiple_matches',
  /** bash 超时 */
  TIMEOUT: 'timeout',
  /** bash 退出码非 0 */
  NON_ZERO_EXIT: 'non_zero_exit',
  /** bash 交互式 flag 不支持 */
  INTERACTIVE_UNSUPPORTED: 'interactive_unsupported',
  /** 其他运行时错误 */
  RUNTIME_ERROR: 'runtime_error',
} as const;

export type ToolErrorCodeValue = (typeof ToolErrorCode)[keyof typeof ToolErrorCode];

// ============================================================
// 6. 辅助：构造 TextBlock 结果（工具实现共用）
// ============================================================

/**
 * 构造一个 isError=true 的 ToolRunResult，content 为单条 TextBlock（错误描述）。
 * 工具实现 catch / 校验失败时统一用此函数，避免到处重复 TextBlock 包装。
 * @param message 错误描述文本
 */
export function errorResult(message: string): ToolRunResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * 构造一个 isError=false 的 ToolRunResult，content 为单条 TextBlock。
 * @param text 成功结果文本
 */
export function textResult(text: string): ToolRunResult {
  return { content: [{ type: 'text', text }], isError: false };
}

// ============================================================
// 7. [v0.0.101] HITL 载荷类型（FeedbackData / ApprovalData / ToolInteraction / PendingToolCall）
// ============================================================

/**
 * [v0.0.101] 结构化提问载荷（ask-question 等 direct_result 悬挂型 tool 用）。
 * 参考: specs/tech/version_logs/v0.0.101/change_plan.md 模块 A
 *       reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §5
 *
 * 前端按 questions[] 渲染提问卡（每 question 一 tab）；用户答案汇总成 FeedbackAnswer。
 */
export interface FeedbackData {
  /** 可选的提问引导文案（卡片顶部展示） */
  prompt?: string;
  /** 问题列表（每条对应卡片一个 tab；多 question → 多 tab 串行） */
  questions: Question[];
}

/**
 * [v0.0.101] 单个提问项（FeedbackData.questions 元素）。
 * 前端按 type 渲染单选/多选控件；allowOther=true 时附「其他」展开输入框。
 */
export interface Question {
  /** 问题 id（前端 tab key + FeedbackAnswer.selections 的 key） */
  id: string;
  /** 问题标题（tab 内顶部展示） */
  title: string;
  /** 选择类型：single=单选（值数组长度 1）/ multi=多选（值数组长度任意） */
  type: 'single' | 'multi';
  /** 候选项列表（key=值标识，label=展示文案） */
  options: { key: string; label: string }[];
  /** 是否允许「其他」自填文本（true 时前端渲染展开输入框；答案值含「其他：<text>」） */
  allowOther: boolean;
}

/**
 * [v0.0.101] 审批型 tool 的请求载荷（dangerous 操作 HITL）。
 * 前端按 toolName + arguments 渲染审批卡；用户决策汇总成 ApprovalDecision。
 *
 * [v0.0.122] 新增两可选字段（向后兼容）：
 *   - reason：ask.reason，审批卡展示拦截原因（来自 checkPermission 返回值）
 *   - approvalKey：ask.approvalKey，allow_always 回填时 recordAlways 用（稳定标识）
 */
export interface ApprovalData {
  /** 待审批的工具名（展示给用户） */
  toolName: string;
  /** 待审批的工具入参（展示给用户，allow 时可被修改） */
  arguments: unknown;
  /** [v0.0.122] 拦截原因（来自 checkPermission ask.reason，审批卡顶部展示） */
  reason?: string;
  /** [v0.0.122] 批准 key 稳定标识（allow_always 时 recordAlways 用；格式: toolName:policyId） */
  approvalKey?: string;
}

/**
 * [v0.0.122] 工具权限决策联合类型（checkPermission 钩子返回值）。
 * 参考: specs/tech/agent/tools/[P0]tool_permission.md §2
 *
 * 三态闭合：
 *   - allow：无异议，直接走 run（等价未实现 checkPermission）
 *   - deny：拒绝本次调用，reason 进 errorResult（LLM 可见），不悬挂不执行
 *   - ask：需要用户审批，reason 进审批卡展示，approvalKey 按 (sessionId,key) 记忆
 *
 * 格式 approvalKey：`{toolName}:{policyId}`（如 `bash:rm-wildcard`），跨调用稳定。
 */
export type PermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string }
  | { behavior: 'ask'; reason: string; approvalKey: string };

/**
 * [v0.0.101] handleType 枚举（pre-process 回填处理三分发 key，见 change_plan 模块 E）。
 * - direct_result：答案 payload 序列化即为 tool result（ask-question）
 * - approval：allow 时补跑原 tool / deny 时拒绝
 * - callback：调 tool.onReply 自定义处理（扩展点）
 */
export type ToolHandleType = 'direct_result' | 'approval' | 'callback';

/**
 * [v0.0.101] Tool.interaction() 返回的悬挂描述（非 null 表示该 tool call 不立即 run）。
 * 参考: specs/tech/agent/tools/[P0]tool_execution_engine.md §5
 *
 * - subType：渲染分发 key（前端据此选提问卡/审批卡），值域与 PendingToolCall.subState 相同
 * - handleType：回填处理分发 key（pre-process 据此选 direct_result/approval/callback 分支）
 * - data：交互载荷（按 subType 分发为 FeedbackData 或 ApprovalData）
 */
export interface ToolInteraction {
  /** 渲染分发 key（前端据此选提问卡 need_feedback / 审批卡 need_approval） */
  subType: 'need_feedback' | 'need_approval';
  /** 回填处理分发 key（pre-process 据此三分发） */
  handleType: ToolHandleType;
  /** 交互载荷（subType='need_feedback' → FeedbackData；'need_approval' → ApprovalData） */
  data: FeedbackData | ApprovalData;
}

/**
 * [v0.0.101] PendingToolCall — 悬挂 tool call 的落盘 wrapper（session.pendingToolCalls[] 元素）。
 * 参考: reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §4
 *       specs/tech/agent/session/[P0]session_store.md §2
 *
 * 字段集（INV-3：落盘存活，重启后可恢复）：
 *   - 定位/配对：sessionId / runId / toolCallId（配对 ToolCallBlock.id 的 key）/ toolName
 *   - 处理策略：handleType（pre-process 三分发）
 *   - 渲染类型：subState（前端据此选提问卡/审批卡）
 *   - 交互载荷：data（FeedbackData / ApprovalData，驱动前端渲染）
 *   - 编辑目标：resultMessageId / resultBlockIndex（占位 ToolResultBlock 在 transcript 的位置，回填用）
 *   - 状态：status（pending=悬挂待答 / resolved=已回填或放弃）
 *
 * engine 构造时 resultMessageId/resultBlockIndex 引擎不知（ingest 后才有 message id），
 * 由 caller（runReActLoop ③ 段）在 ingest 后回填这两个字段。
 */
export interface PendingToolCall {
  /** 所属 session id */
  sessionId: string;
  /** 所属 run id（恢复时校验归属） */
  runId: string;
  /** 配对 ToolCallBlock.id（回填匹配 key） */
  toolCallId: string;
  /** 工具名（审计/日志） */
  toolName: string;
  /** 回填处理分发 key（pre-process 三分发） */
  handleType: ToolHandleType;
  /** 渲染分发 key（前端据此选提问卡/审批卡） */
  subState: 'need_feedback' | 'need_approval';
  /** 交互载荷（subState='need_feedback' → FeedbackData；'need_approval' → ApprovalData） */
  data: FeedbackData | ApprovalData;
  /** 占位 ToolResultBlock 所在 message id（回填编辑目标，engine 不填由 caller 回填） */
  resultMessageId?: string;
  /** 占位 ToolResultBlock 在 message.content 数组中的下标（回填编辑目标，engine 不填由 caller 回填） */
  resultBlockIndex?: number;
  /** 状态：pending=悬挂待答 / resolved=已回填或放弃（resolvePendingToolCall 标记） */
  status: 'pending' | 'resolved';
}
