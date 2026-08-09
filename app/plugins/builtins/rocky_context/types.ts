/**
 * rocky_context plugin — context impl 共享契约类型
 * 参考: specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §2/§6
 *       specs/tech/agent/context_and_memory/[P0]system_prompt.md / system_reminder.md / context_ingest_detail.md
 *
 * 集中定义 context EP 的契约接口与上下文类型，供各 impl 模块复用。impl 模块各自 default export 一个类，
 * 构造器约定 `constructor(implId, cfg)`（与 llm_anthropic provider/protocol 一致）。
 */
import type { Message, MessageRole } from '../../../server/src/message/types';
import type { SessionConfig, ContextSnapshot } from '../../../server/src/agent/context-types';
import type { SessionStore } from '../../../server/src/agent/session-store';
import type { SessionStateMachine } from '../../../server/src/agent/session-state-machine';
import type { SummaryInfo, StoreCallOpts } from '../../../server/src/agent/session-store-types';
import type {
  CompactSideRunner,
} from '../../../server/src/agent/context-compact-runner';
import type {
  ConsolidateRunner,
  PostCompactHandler,
  PostCompactCtx,
  CompactPluginContext,
} from '../../../server/src/agent/compact-types';
import type { ToolDefinition } from '../../../server/src/tools/types';

/** PromptFragment（system_prompt.md §2） */

/** fragment tier：决定 cache 稳定性 + tier_sort 合并排序（stable→context→volatile） */
export type PromptTier = 'stable' | 'context' | 'volatile';

/** system prompt 片段：mapper 贡献、reducer 处理、builder 拼接的最小单元 */
export interface PromptFragment {
  /** 唯一标识，dedup 去重依据 */
  id: string;
  /** tier 决定 cache 稳定性 + 合并排序 */
  tier: PromptTier;
  /** 片段正文 */
  content: string;
  /**
   * 所属 mapper 的 priority（plugin_manager 实例化时不自动注入，由 builder 构造时回填）。
   * tier_sort reducer 用它做 tier 内排序。缺省 0。
   */
  priority?: number;
}

/** mapper / reducer 共享的上下文（system_prompt.md §3） */
export interface PromptCtx {
  config: SessionConfig;
}

/** SystemReminder（system_reminder.md §2） */

/** 单条 system reminder（系统运行时动态注入） */
export interface SystemReminder {
  /** 唯一标识 */
  id: string;
  /** reminder 正文（系统生成） */
  content: string;
  /** 提示/警告（影响呈现） */
  tier?: 'info' | 'warn';
}

/**
 * reminder provider 上下文。
 * [v0.0.223] 扩展：加可选 todoStore（鸭子类型 listBySession），供 TodoReminderProvider 读
 * session 级双层 todo 进度注入 `[todo]` reminder。缺省 undefined → todo provider 不产出。
 */
export interface ReminderCtx {
  config: SessionConfig;
  /**
   * squad 上下文 service（封装 store 句柄，不暴露 raw store，可测）。
   * 由 ContextEngine.ingest 构造期按 config.squadId 注入。缺省 undefined → squad provider 降级不产出。
   */
  squadContext?: SquadContextService;
  /**
   * transcript 读取器（去重：找上次该类 reminder + 算距上次 message 数）。
   * 由 ContextEngine.ingest 构造期按 config.sessionId 注入。缺省 undefined → provider 默认每次产出（不去重）。
   */
  transcriptReader?: TranscriptReader;
  /**
   * [v0.0.223] TodoStore 句柄（鸭子类型，仅 listBySession），供 todo reminder provider 读
   * 当前 session 双层 todo 进度。由 ContextEngine.ingest 注入；缺省 undefined → todo provider 不产出。
   */
  todoStore?: TodoStorePort;
}

/**
 * [v0.0.223] TodoStore 鸭子类型端口（reminder provider 侧只读 listBySession）。
 * 生产注入 TodoStore 实例（app/server/src/agent/todo/todo-store.ts），接口同名兼容。
 * 返回 TodoItem[] 结构（todo_tools.md §2.1）。
 */
export interface TodoStorePort {
  /** 列 session 全部 todo item（含已结束未清理） */
  listBySession(sessionId: string): Promise<unknown[]> | unknown[];
}

/** [v0.0.223] TodoItem 鸭子类型（todo_tools.md §2.1，reminder provider 读字段子集） */
export interface TodoItemLike {
  id: string;
  desc: string;
  status: string;
  steps?: Array<{ id: string; desc: string; status: string }>;
  source?: { type?: string; refId?: string };
  output?: { type?: string; refId?: string };
  memo?: string;
}

/**
 * squad 上下文 service（squad_reminder_providers §1）。
 * 封装 squad/member store 句柄，供 reminder provider 读取动态数据。
 * 接口与 SquadStore/MemberStore 同名方法鸭子类型兼容（生产注入直接传 store 实例）。
 */
export interface SquadContextService {
  /** 取 squad entity */
  getSquad(squadId: string): unknown | Promise<unknown>;
  /** 列 squad 全部 member */
  listMembers(squadId: string): unknown[] | Promise<unknown[]>;
  /**
   * [v0.0.116] session running 状态查询（squad_agents_status provider 用）。
   * 口径：session.state==='running'（bootstrap 注入的 isSessionRunning 透传）。
   */
  isSessionRunning(sessionId: string): boolean | Promise<boolean>;
  /**
   * 列活跃 task（squad_task provider 用，panorama_builtin §5）.
   * leader（viewerMemberId=null）→ 全队活跃；mate → owner∪我 block 别人的.
   * 返回 TaskLike 子集（archived 永远 false）.
   */
  listActiveTasks(squadId: string, viewerMemberId: string | null): TaskLike[] | Promise<TaskLike[]>;
}

/**
 * task 实例子集（squad_task reminder provider 产出格式用，panorama_builtin §5）.
 * 与 app/server/src/agent/squad-reminder-deps.ts TaskLike 形状等价（鸭子类型）.
 */
export interface TaskLike {
  id: string;
  title: string;
  owner: string | null;
  dependencies: string[];
  status: string;
  archived: boolean;
}

/**
 * transcript 读取器（squad_reminder_providers §1）。
 * 用于 reminder 去重：扫近 N 条 transcript 找最近一条匹配 prefix 的 reminder，并算距其的 message 数。
 */
export interface TranscriptReader {
  /** 找最近一条正文以 prefix 开头的 reminder message（扫 system_reminder 聚合块）；不存在返 null */
  findLastReminder(prefix: string): { messageId: string; atMessageCount: number } | null;
  /** 距 messageId（不含）以后的 message 条数（用于 10 条兜底刷新判定） */
  messageCountSince(messageId: string): number;
}

/** Ingest handler（context_ingest_detail.md §3） */

/** ingest handler 上下文（store_sink 写库 / truncate handler offload / reminder injector 用 config） */
export interface IngestCtx {
  config: SessionConfig;
  /**
   * SessionStore 句柄（ContextEngine.ingest 注入 wireStore）。store_sink handler 调
   *   `store.appendMessages(...)` 写 transcript；亦供 truncate handler offload 原文（当前 no-op）。
   * [v0.0.66] store 扩展点化后，ContextEngine 按 scope 选 session_store EP impl 注入此处
   *   （default→persistent_session_store / forked→in_memory_session_store）。
   */
  store?: SessionStore;
  /**
   * reminder provider 链执行器（system_reminder_injector 用）。
   * ContextEngine 构造期 closure 注入；未注入（如单测）→ injector 跳过 reminder。
   */
  reminderRunner?: (ctx: IngestCtx) => SystemReminder[];
  /**
   * [v0.0.83] store 调用 opts（runId 等）；store_sink 透传到 appendMessages。
   * forked 路径含 runId（per-run buffer 隔离）；default 缺省。
   */
  opts?: StoreCallOpts;
}

/** 契约接口（各 EP impl 实现） */

/** system_prompt_mapper 契约（map → PromptFragment[]） */
export interface SystemPromptMapper {
  map(ctx: PromptCtx): PromptFragment[] | Promise<PromptFragment[]>;
}

/** system_prompt_reducer 契约（链式 reduce → PromptFragment[]） */
export interface SystemPromptReducer {
  reduce(input: PromptFragment[], ctx: PromptCtx): PromptFragment[];
}

/** system_reminder provider 契约（provide → SystemReminder[]） */
export interface SystemReminderProvider {
  provide(ctx: ReminderCtx): SystemReminder[] | Promise<SystemReminder[]>;
}

/**
 * context_ingest_handler 契约（transform → Message[]）。
 * 返回放宽为 `Message[] | Promise<Message[]>`：sink impl（store_sink）需 await async 的
 *   store.appendMessages，故允许 async handler；sync handler 仍兼容。applyIngestPipeline 对每个 handler `await`。
 */
export interface IngestHandler {
  handle(messages: Message[], ctx: IngestCtx): Message[] | Promise<Message[]>;
}

/** assemble mapper/reducer（context_assemble_detail.md §3） */

/**
 * mapper 贡献的数据源集合；各 mapper 贡献 Partial，deepMerge 合并（同字段后者覆盖）。
 * [v0.0.66] 删 `system` 字段——system prompt 不再走 context_assemble_mapper 链
 *   （system 由 context-engine.assemble 独立构建，design §1.3）。
 * [v0.0.173] 删 `prevMessages` 字段——snapshot 永远 rebuild，不再需要上一版 messages 作增量基础
 *   （prev_snapshot mapper 一并删除，详见 change_plan §二）。
 */
export interface AssembleData {
  /** transcript_reader 贡献（最近 N 条 message） */
  transcript: Message[];
  /** summary_reader 贡献（含 version） */
  summary: SummaryInfo | null;
  /**
   * [v0.0.185] summary_reader 贡献：head 候选（会话真第一条起、upToId=summaryUpTo 锚定，升序）。
   * 锚定 transcript 起点，不随 recent 窗口滑动 → 同 summary version 下 head 段逐字节稳定。
   * 缺省（无 summary / forked / 旧测试 ctx）时 base_builder 回退 transcript 派生。
   * [v0.0.186] 仅服务 fallback 即时构建路径（summary 无烘焙 block）；summary 带 block 时
   *   summary_reader 不再取候选、base_builder 直接用 block（零计算）。
   */
  headCandidates?: Message[];
  /**
   * [v0.0.185] summary_reader 贡献：tail 候选（upToId=summaryUpTo 锚定的末尾 N 条，升序）。
   * 锚定 summaryUpTo，summaryUpTo 掉出 recent 窗口时 tail 段仍稳定（修 upToIdx=-1 旧异常路径）。
   * [v0.0.186] 同 headCandidates：仅 fallback 路径消费。
   */
  tailCandidates?: Message[];
}

/** assemble mapper/reducer 共享上下文（context_assemble_detail.md §3） */
export interface AssembleCtx {
  config: SessionConfig;
  /** 来自 RunState 的上一版 snapshot（summary version 比对用，增量构建基础） */
  prevSnapshot: ContextSnapshot | null;
  /** SessionStore（ContextEngine 注入）—— transcript_reader/summary_reader 用（按 scope 选 EP impl）。 */
  store?: SessionStore;
  /** token/char 估算 ratio（session 维度，冷启动 1.0）。base_builder head/tail 选取用 char×ratio 累加（tokenCap 算法）。 */
  ratio: number;
  /** scopeId（'default' / 'forked'）。[v0.0.173] base_builder 永远 rebuild，不再读 scopeId/prevSnapshot 作增量判定；forked 与 default 的清理 reducer 迁至 context_clean_view_reducer EP（active 一致）。 */
  scopeId?: string;
  /** [v0.0.83] store 调用 opts（runId 等）；transcript_reader 透传到 getMessages（forked per-run 隔离）。 */
  opts?: StoreCallOpts;
}

/** context_assemble_mapper 契约（map → Partial<AssembleData>） */
export interface AssembleMapper {
  map(ctx: AssembleCtx): Partial<AssembleData> | Promise<Partial<AssembleData>>;
}

/**
 * assemble_reducer + clean_view_reducer 共享契约（链式 reduce → Message[]）。
 * - assemble_reducer（v0.0.173 起只剩 base_builder）：input = 上一 reducer 输出（首 reducer base_builder 收 input=null 从 data 构建 rebuild 框架）。
 * - clean_view_reducer（v0.0.173 新增 EP，6 个清理 reducer 迁过来）：input 永远非 null（= 上一步输出或 caller 传入的 messages），
 *   data 不读（用 EMPTY_DATA 占位满足签名，由 ContextEngine.getCleanSnapshot 在 structuredClone 副本上跑）。
 */
export interface AssembleReducer {
  reduce(
    data: AssembleData,
    input: Message[] | null,
    ctx: AssembleCtx,
  ): Message[];
}

/** compact EP 契约（context_compact_detail §2c，v0.0.40 新增首批 exclusive context EP） */

/**
 * compact 触发上下文（context_compact_detail §2c.2）。由 tryCompact 胶水（T6 落
 * current ContextPort.recordAssistant）构造后传入谓词/动作。
 *
 * 谓词（threshold_should_compact）只用前 4 个 spec 字段；动作（summary_do_compact）
 * 额外读 *Runner/stateMachine（T6 tryCompact 注入；T3 未 wire → undefined）。
 * [v0.0.81.compaction_bug] noticeEmitter 字段已删（compact_notice 全段砍）。
 */
export interface CompactCtx {
  config: SessionConfig;
  /** assemble 后快照（含 contextWindowUsage.totalTokens/maxOutputTokens/tokenLimit）*/
  snapshot: ContextSnapshot;
  store: SessionStore;
  /** router.resolve 产出（default=current / forked=forked）*/
  scopeId: string;
  // —— 动作运行时依赖（T6 tryCompact 注入；T3 未 wire，可选）——
  /** summaryTask CAS（markSummaryRunning/Done/Failed，串行化防并发 compact）*/
  stateMachine?: SessionStateMachine;
  /** 复用 ContextEngine.assemble（compact 内重新 assemble 取最新 snapshot）*/
  assembleFn?: (c: SessionConfig) => Promise<ContextSnapshot>;
  /** AgentManager.sideRun 回调（执行 summary run：NO_TOOLS / maxIter=1）*/
  sideRunner?: CompactSideRunner;
  /**
   * fork-2 整理 agent 入口回调（memory_skill_consolidation handler 用）。
   * 缺省（UT fixture 不注入）→ handler 跳过整理（不抛错）。bootstrap 注入生产单例。
   */
  consolidateRunner?: ConsolidateRunner;
  /** fork-2 工具声明（复用主对话保 cache；memory_skill_consolidation handler 用）。 */
  toolDefinitions?: ToolDefinition[];
  /**
   * compact 后置阶段插件上下文（tryCompact 胶水构造注入；summary_do_compact 透传 runCompact）。
   * 缺省（UT fixture）→ runCompact 跳过 post-compact EP 派发。
   */
  pluginCtx?: CompactPluginContext;
}

/** context_should_compact EP 契约（谓词，§2c.2）：exclusive ≤1 active，返 true = 该压了 */
export interface ShouldCompactPredicate {
  check(ctx: CompactCtx): Promise<boolean>;
}

/** context_do_compact EP 契约（动作，§2c.3）：exclusive ≤1 active，执行 sideRun(summary)→setSummary */
export interface DoCompactAction {
  run(ctx: CompactCtx): Promise<void>;
}

/**
 * context_post_compact EP 契约（handler，§2d.2）：ordered，取 active 列表首个 handler 执行。
 * 触发：runCompact 成功后由其末尾统一派发（手动/自动两路径共享；context-compact-post-phase.ts）。
 * ctx 为 PostCompactCtx（prevSnapshot 压缩前 + postSnapshot 压缩后双快照）。
 * re-export 自 server 侧 compact-types（结构等价，避免重复声明）。
 */
export type { PostCompactHandler, PostCompactCtx };

/** impl 基类（统一 implId/cfg 注入） */

/**
 * 所有 rocky_context impl 的基类。子类按需读 this.cfg 取阈值；this.implId 便于自识别。
 * PluginManager.instantiate 约定 `new ImplClass(implId, cfg)`（plugin-manager.ts §instantiate）。
 */
export abstract class ContextImplBase {
  /** impl id（registry 登记的 implId，用于自识别） */
  protected readonly implId: string;
  /** 当前 merged config（manifest.configSchema.default ∩ implPolicy.configValues） */
  protected readonly cfg: Record<string, unknown>;

  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    this.implId = implId;
    this.cfg = cfg;
  }

  /** 读数值配置，缺省返 fallback */
  protected getNumber(key: string, fallback: number): number {
    const v = this.cfg[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  }

  /** 读字符串配置，缺省返 fallback */
  protected getString(key: string, fallback: string): string {
    const v = this.cfg[key];
    return typeof v === 'string' ? v : fallback;
  }
}

// re-export 业务类型便于 impl 模块一站式 import
export type {
  Message,
  MessageRole,
  SessionConfig,
  SessionStore,
  ContextSnapshot,
  SummaryInfo,
};

// [v0.0.66] SessionStoreContract（session_store EP 契约）拆到 ./store/types.ts
//   （assemble/ingest 路径消费的方法子集；releaseSlot 与 SessionStore.clearSession 语义分离）。
