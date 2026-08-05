/**
 * compact EP 契约类型（server 侧；v0.0.40 T6a 新建）
 * 参考: specs/tech/agent/context/[P0]context_compact_detail.md §2c.2/§2c.3
 *       specs/tech/agent/session/[P0]session_task_lock.md（v0.0.55 统一锁）
 *
 * 定位：把 compact EP 的契约类型（CompactCtx / ShouldCompactPredicate / DoCompactAction）
 * 在 server 侧声明一份，避免 server → plugin 反向依赖（app/server/tsconfig.json 限 rootDir=src）。
 *
 * 与 plugin 侧（app/plugins/builtins/rocky_context/types.ts）的对应类型**结构等价**——
 * 它们都引用 server 侧的 SessionConfig / ContextSnapshot / SessionStore / SessionTaskLock /
 * CompactSideRunner（plugin types.ts 已 re-export）。
 * 结构兼容 → tryCompact 胶水（server 侧）传 CompactCtx 给 plugin 实例的 check()/run()，
 * TS 结构类型自动兼容，运行时无影响。
 *
 * v0.0.55：CompactCtx.stateMachine 改为 CompactCtx.taskLock（subsumes summaryTask CAS）。
 * [v0.0.81.compaction_bug] CompactCtx.noticeEmitter 字段 + CompactNoticeEmitter 引用已删
 *   （compact_notice 全段砍）。
 */
import type { ContextSnapshot, SessionConfig } from './context-types';
import type { SessionStore } from './session-store';
import type { SessionTaskLock } from './session-task-lock';
import type { CompactSideRunner } from './context-compact-runner';
import type { PluginManager } from '../plugin/plugin-manager';
import type { ToolDefinition } from '../tools/types';
import type { Message, Usage, ContextWindowUsage } from '../message/types';

/**
 * compact 触发上下文（context_compact_detail §2c.2）。
 * 谓词（threshold_should_compact）用前 4 字段；动作（summary_do_compact）额外读 *Runner/taskLock。
 */
export interface CompactCtx {
  config: SessionConfig;
  /** assemble 后快照（含 contextWindowUsage.totalTokens/maxOutputTokens/tokenLimit） */
  snapshot: ContextSnapshot;
  /**
   * session store（main 持久化 + compact summary 版本检查；forked 不注入=undefined）。
   * v0.0.49 改 optional：骨架统一调 tryCompact，forked（wireStore=undefined）也构造 CompactCtx，
   * 但 forked scope reject_should_compact 恒 false → 谓词不读 store 即 return（运行时安全）。
   */
  store?: SessionStore;
  /** router.resolve 产出（current='default' / forked='forked'） */
  scopeId: string;
  // —— 动作运行时依赖（buildMainDeps 注入；UT fixture 可选）——
  /**
   * [v0.0.55] SessionTaskLock 统一锁（subsumes 旧 stateMachine CAS，串行化防并发 compact）。
   * compact 进入 acquire('compact')，结束 markDone/markFailed；缺省（UT fixture）→ runCompact 跳过守卫。
   */
  taskLock?: SessionTaskLock;
  /** AgentManager.sideRun 回调（执行 summary run：NO_TOOLS / maxIter=1） */
  sideRunner?: CompactSideRunner;
  /**
   * [v0.0.51] fork-2 整理 agent 入口回调（memory_skill_consolidation handler 用）。
   * 缺省（UT fixture 不注入）→ handler 跳过整理（不抛错）。bootstrap 注入生产单例。
   */
  consolidateRunner?: ConsolidateRunner;
  /**
   * [v0.0.51] fork-2 工具声明（复用主对话保 cache；memory_skill_consolidation handler 用）。
   * 缺省（UT fixture 不注入）→ handler 跳过整理。
   */
  toolDefinitions?: ToolDefinition[];
  /**
   * [v0.0.80.t1] 触发点 tryCompact sibling spawn 时填入：主 session 末尾 msg id。
   * 用于 forked trace metadata.inputMessageIds（反查触发点；spec change_plan §2.6 改进#1）。
   * 缺省（UT fixture）→ undefined → forked trace metadata inputMessageIds 兜底 []。
   */
  triggerMessageId?: string;
  /**
   * [v0.0.80.t1] 触发点 tryCompact sibling spawn 时填入：触发时 context window 用量。
   * 用于 forked trace metadata.triggerUsage（便于反查触发时上下文规模）。
   * 缺省（UT fixture）→ undefined → trace metadata 跳过该字段。
   */
  triggerUsage?: ContextWindowUsage;
  /**
   * compact 后置阶段插件上下文（tryCompact 胶水构造注入；summary_do_compact 透传 runCompact）。
   * 承载 post-compact EP 派发所需依赖（scopeId/pluginManager/consolidateRunner/store/taskLock）。
   * 缺省（UT fixture）→ runCompact 跳过 post-compact EP 派发（postSnapshot/usage 更新仍执行）。
   */
  pluginCtx?: CompactPluginContext;
}

/**
 * compact 后置阶段插件上下文（runCompact 末尾触发 post-compact EP 用）。
 *
 * 把 post handler 所需依赖包成单一对象传进 runCompact（比逐个加参数干净，照 CompactCtx 风格）。
 * 手动（ContextEngine.compact）/ 自动（tryCompact → summary_do_compact）两条 compact 路径
 * 都构造本对象 → 两路径统一在 compact 末尾触发 post-compact EP（consolidate 从 tryCompact
 * 并发 sibling 改为 compact 内部串行 fire-and-forget，手动路径不再漏触发）。
 */
export interface CompactPluginContext {
  /** compact 发生的 session scope（post handler EP 按 scope 读配置激活 impl 列表） */
  scopeId: string;
  /** plugin 注册表（getExtensionImpls(ContextPostCompactPoint, scopeId) 用）；null → 跳过 EP 派发 */
  pluginManager: PluginManager | null;
  /** consolidate 启动入口（透传进 PostCompactCtx.consolidateRunner；null → handler 跳过整理） */
  consolidateRunner: ConsolidateRunner | null;
  /** 主 session 持久 store（透传给 handler 做 accumulateUsage 等写操作） */
  store: SessionStore;
  /** SessionTaskLock（consolidate handler 内部 acquire 'tier1_consolidation'） */
  taskLock?: SessionTaskLock;
}

/** context_should_compact EP 契约（谓词，§2c.2）：exclusive ≤1 active，返 true = 该压了 */
export interface ShouldCompactPredicate {
  check(ctx: CompactCtx): Promise<boolean>;
}

/** context_do_compact EP 契约（动作，§2c.3）：exclusive ≤1 active，执行 sideRun(summary) → setSummary */
export interface DoCompactAction {
  run(ctx: CompactCtx): Promise<void>;
}

// ============================================================
// post-compact EP 契约（context_compact_detail §2d，v0.0.51 新增 ordered context EP）
// ============================================================

/**
 * fork-2 整理 agent 入口回调（v0.0.51 新增）。
 * bootstrap 创建 AgentManager 后回写到 ContextEngine.setConsolidateRunner（与
 * CompactSideRunner 同模式，避免循环依赖）。memory_skill_consolidation handler
 * 通过 CompactCtx.consolidateRunner 调用本回调启动 fork-2。
 *
 * 与 CompactSideRunner（summary 专用，参数硬编码）的区别：本回调由 caller 指定
/**
 * fork-2 consolidation runner 输入（v0.0.204 T2-B4 瘦身）。
 *
 * v0.0.158 change_plan §F：删除 `config` 字段——bootstrap setConsolidateRunner 闭包内部
 *   `await agentManager.resolveConfigBySid(input.sessionId)` 自 resolve（唯一入口收敛）。
 *   caller（post-compact-consolidation handler）不再传 config；ctx.config 保留供 sessionId 派生用。
 * v0.0.204 T2-B4：删 enableToolWhitelist/toolWhitelist/toolDefinitions/maxIter 4 字段——
 *   全部由 agentManager.sideRun 内部从 policy（consolidate profile toolBound + runShape.maxIterDefault）
 *   + snapshot 派生。external API（sideRun opts）已 slim，runner input 同步瘦。
 */
export type ConsolidateRunner = (input: {
  sessionId: string;
  /** fork-2 runKind（v0.0.204 扁平闭合枚举 'consolidate'，区别 fork-1 的 'summary'） */
  runKind: 'consolidate';
  snapshot: ContextSnapshot;
  userMessage: Message;
  /**
   * [v0.0.80.t1] 触发点 msg id（caller=memory_skill_consolidation handler 从 CompactCtx 透传）。
   * 用于 forked trace metadata.inputMessageIds 反查触发点。缺省兜底 []（向后兼容）。
   */
  triggerMessageId?: string;
  /**
   * [v0.0.80.t1] 触发时 context window 用量（同 triggerMessageId，从 CompactCtx 透传）。
   * 用于 forked trace metadata.triggerUsage。缺省跳过该字段。
   */
  triggerUsage?: ContextWindowUsage;
}) => Promise<{ answer: string; usage: Usage }>;

/**
 * post-compact handler 上下文（context_compact_detail §2d）。
 *
 * 双 snapshot 设计（handler 自行决定用哪个，签名不预设）：
 *   - prevSnapshot = runCompact 入口传入的**压缩前**完整对话快照（含中间对话；
 *     memory_skill_consolidation 用它做整理——原始信息最全）
 *   - postSnapshot = compact 成功后「假装 assemble」合成的**压缩后**视图
 *     （system + [summary block + recent] + 重算的 contextWindowUsage；
 *     与下次真 assemble 产出同构，留给需要压缩后视图的 handler）
 * 其余字段（config/store/scopeId/taskLock/consolidateRunner/toolDefinitions/trigger*）
 * 继承 CompactCtx（snapshot 字段除外——被 prev/post 双快照替代）。
 */
export interface PostCompactCtx extends Omit<CompactCtx, 'snapshot' | 'pluginCtx'> {
  /** 压缩前完整对话快照（runCompact 入口传入，未被 compact 修改） */
  prevSnapshot: ContextSnapshot;
  /** 压缩后视图快照（compact 内部合成；usage 立即更新与传 handler 同源） */
  postSnapshot: ContextSnapshot;
}

/** context_post_compact EP 契约（handler，§2d.2）：ordered，取 active 列表首个 handler 执行 */
export interface PostCompactHandler {
  handle(ctx: PostCompactCtx): Promise<void>;
}
