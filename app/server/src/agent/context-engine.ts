/**
 * ContextEngine — ingest / assemble / compact / getCleanSnapshot
 * 参考: specs/tech/agent/context/[P0]context_engine.md §3
 *       specs/tech/agent/context/[P0]context_compact_detail.md §2 §3
 * v0.0.66：session_store EP 解析 + slot 释放拆到 context-engine-store-resolver.ts（≤300 行约束）
 * v0.0.173：新增 getCleanSnapshot（structuredClone 深克隆 + 跑 context_clean_view_reducer 链）。
 *   snapshot.messages 永远 rebuild（确定性纯函数 f(summary,transcript)）；清理剥到独立 EP 由
 *   getCleanSnapshot 在深克隆副本上跑，原 snapshot 不被 mutate（根治 tool_call 乱序 400）。
 */
import type { LlmClient } from '../llm/client';
import type { Message, ContextWindowUsage, MessageInput, Usage } from '../message/types';
import type { SessionStore } from './session-store';
import type { SessionStateMachine } from './session-state-machine';
import type { SessionTaskLock } from './session-task-lock';
import type { SummaryInfo, StoreCallOpts } from './session-store-types';
import type { ContextSnapshot, SessionConfig, AppConfigLike } from './context-types';
import type { ToolDefinition } from '../tools/types';
import type { PluginManager } from '../plugin/plugin-manager';
import { buildSystemPrompt } from './system-prompt-builder';
import { runAssemblePipeline, pickFallback, firstText } from './assemble-pipeline';
import { runCleanViewPipeline } from './clean-view-pipeline';
import { extractTag } from './context-compact-helpers';
import { estimateChars, estimateMessageChars, estimateToolChars, computeContextWindowUsage } from './context-usage-calc';
import { runCompact } from './context-compact-runner';
import { applyIngestPipeline, type ReminderQueueHandles } from './context-ingest-pipeline';
import type { ReminderQueueStore } from './system-reminder-queue';
import { scopeIdOf } from './scope-id';
import { buildReminderExtras, type SquadReminderDeps } from './squad-reminder-deps';
import type { ConsolidateRunner, CompactPluginContext } from './compact-types';
import { resolveStore, clearScopeSession } from './context-engine-store-resolver';

/**
 * v0.0.15 T5：compact 走 AgentManager.sideRun 的回调签名。
 * 为避免循环依赖（AgentManager→ContextEngine，不可反向），持可选 sideRunner 回调，
 * bootstrap 创建 manager 后回写 setSideRunner。
 *
 * v0.0.158 change_plan §F：删除 `config` 字段——bootstrap setSideRunner 闭包内部
 *   `await agentManager.resolveConfigBySid(input.sessionId)` 自 resolve（唯一入口收敛）。
 *   与 CompactSideRunner（context-compact-runner.ts）结构等价。
 *
 * @returns { answer } compact 用 <summary> tag 提取后的 summary 文本（caller 自己 extractTag）
 */
export type SideRunRunner = (input: {
  sessionId: string;
  snapshot: ContextSnapshot;
  userMessage: Message;
  /**
   * [v0.0.80.t1] 触发点 msg id（透传给 agentManager.sideRun → forked trace meta）。
   * 缺省兜底 '' → forked trace inputMessageIds 兜底 []（向后兼容）。
   */
  triggerMessageId?: string;
  /**
   * [v0.0.80.t1] 触发时 context window 用量（透传给 sideRun → forked trace meta）。
   */
  triggerUsage?: ContextWindowUsage;
}) => Promise<{ answer: string; usage: Usage }>;

/** ContextEngine 构造参数（对齐 context_engine.md §3 构造函数） */
export interface ContextEngineOptions {
  store: SessionStore;
  /** SessionStateMachine（五态机，仅供其他潜在消费者；缺省从 store.stateMachine 取）。 */
  stateMachine?: SessionStateMachine;
  /** SessionTaskLock（compact 互斥锁；缺省 undefined 兼容旧 UT fixture，生产由 bootstrap 注入）。 */
  taskLock?: SessionTaskLock;
  /** PluginManager（context ordered 链入口；缺省 null → 降级 v0.0.8 行为，便于 UT）。 */
  pluginManager?: PluginManager | null;
  /** AppConfig（读 context.maxOutputTokens，缺省 20000；v0.0.89 自 DevConfig 改名，源切 app_config）。 */
  appConfig?: AppConfigLike | null;
}

/** v0.0.13 ContextEngine 实现：一个实例服务多个 session（store 跨 session 复用，session 维度走 config）。 */
export class ContextEngine {
  private readonly store: SessionStore;
  private readonly stateMachine: SessionStateMachine | undefined;
  /** SessionTaskLock（compact 互斥锁，缺省 undefined 兼容旧 UT fixture，bootstrap 后置注入）。 */
  private taskLock: SessionTaskLock | undefined;
  private readonly pluginManager: PluginManager | null;
  /** AppConfig（读 context.maxOutputTokens，缺省 null 用代码默认 20000；v0.0.89 自 DevConfig 改名）。 */
  private readonly appConfig: AppConfigLike | null;
  /** compact 走 AgentManager.sideRun 的回调（避免循环依赖，bootstrap 后置注入）。 */
  private sideRunner: SideRunRunner | null = null;
  /** fork-2 整理 agent 入口回调（post-compact memory_skill_consolidation handler 用）。 */
  private consolidateRunner: ConsolidateRunner | null = null;
  /** squad reminder provider 的 store 句柄（squadContext service 数据源，缺省 null 降级不产出）。 */
  private squadReminderDeps: SquadReminderDeps | null = null;
  /**
   * [v0.0.223] TodoStore 句柄（todo reminder provider 数据源，缺省 null 降级不产出）。
   * 鸭子类型 listBySession（todo_tools.md §6）；bootstrap 注入实例。
   */
  private todoStore: { listBySession(sid: string): Promise<unknown[]> | unknown[] } | null = null;
  /**
   * [v0.0.361 §1.2 T3] ReminderQueueStore 句柄（reminder queue 消费侧数据源，缺省 null 降级不注入）。
   * bootstrap 注入单例（同 TodoStore 模式）；ingest 期构造 drain/clearAll closure 透传给 injector。
   */
  private reminderQueueStore: ReminderQueueStore | null = null;

  constructor(opts: ContextEngineOptions) {
    this.store = opts.store;
    // 优先用注入的 stateMachine，否则回落到 store 内置（v0.0.12 起所有 SessionStore 实例自带）
    this.stateMachine = opts.stateMachine ?? opts.store.stateMachine;
    this.taskLock = opts.taskLock;
    this.pluginManager = opts.pluginManager ?? null;
    this.appConfig = opts.appConfig ?? null;
  }

  /** bootstrap 创建 AgentManager 后回写 sideRunner（打破循环依赖）。 */
  setSideRunner(runner: SideRunRunner): void {
    this.sideRunner = runner;
  }

  /** bootstrap 构造 SessionTaskLock 单例后回写（打破初始化顺序依赖）。 */
  setTaskLock(lock: SessionTaskLock): void {
    this.taskLock = lock;
  }

  /** bootstrap 创建 AgentManager 后回写 consolidateRunner（打破循环依赖，runKind='consolidate' wrapper）。 */
  setConsolidateRunner(runner: ConsolidateRunner): void {
    this.consolidateRunner = runner;
  }

  /** 暴露 pluginManager（MainContextPort.tryCompact 胶水用，缺省 null → tryCompact 跳过）。 */
  getPluginManager(): PluginManager | null {
    return this.pluginManager;
  }

  /** 暴露 stateMachine（五态机，v0.0.55 起 compact 不再用）。 */
  getStateMachine(): SessionStateMachine | undefined {
    return this.stateMachine;
  }

  /** 暴露 taskLock（summary_do_compact CompactCtx.taskLock 注入用，缺省 undefined 兼容 UT）。 */
  getTaskLock(): SessionTaskLock | undefined {
    return this.taskLock;
  }

  /** 暴露 sideRunner（summary_do_compact CompactCtx.sideRunner 注入用，缺省 null 降级）。 */
  getSideRunner(): SideRunRunner | null {
    return this.sideRunner;
  }

  /** 暴露 consolidateRunner（memory_skill_consolidation handler CompactCtx 注入用）。 */
  getConsolidateRunner(): ConsolidateRunner | null {
    return this.consolidateRunner;
  }

  /**
   * 注入 squad reminder provider 所需的 store 句柄（squadContext service 数据源）。
   * 缺省（UT fixture）→ squad provider 降级不产出（向后兼容）。
   */
  setSquadReminderDeps(deps: SquadReminderDeps): void {
    this.squadReminderDeps = deps;
  }

  /**
   * [v0.0.223] 注入 TodoStore（todo reminder provider 数据源）。
   * 鸭子类型 listBySession；bootstrap 注入后 todo reminder 经 ctx.todoStore 读 session todo 进度。
   * 缺省（UT fixture）→ todo provider 降级不产出（向后兼容）。
   */
  setTodoStore(store: { listBySession(sid: string): Promise<unknown[]> | unknown[] } | null): void {
    this.todoStore = store;
  }

  /**
   * [v0.0.361 §1.2 T3] 注入 ReminderQueueStore 单例（bootstrap 装配；同 setTodoStore 模式）。
   * 注入后 ingest 构造 queueDrain/queueClearAll closure 透传 injector（closure 防 handler 持 store）。
   * 缺省（UT fixture）→ 不注入 queue 句柄（injector 降级，向后兼容）。
   */
  setReminderQueueStore(store: ReminderQueueStore | null): void {
    this.reminderQueueStore = store;
  }

  /**
   * [v0.0.361 §1.2 T3] 暴露 ReminderQueueStore（T4 写入方接线用：todo/presence/state-machine
   * 等五点 queue.write 与消费侧共享同一单例——per-sid mutex 必须单实例内互斥）。
   */
  getReminderQueueStore(): ReminderQueueStore | null {
    return this.reminderQueueStore;
  }

  /** v0.0.66 §2.3 解析 scope 选中的 session_store EP impl（委托 store-resolver helper）。 */
  resolveStore(scopeId: string): SessionStore {
    return resolveStore(this.pluginManager, this.store, scopeId);
  }

  /**
   * [v0.0.66 §2.6] 清理某 scope 的 store buffer 桶（委托 store-resolver helper）。
   * [v0.0.83] opts.runId：forked 按 runId 释放 per-run buffer 桶（回收防泄漏）。
   */
  async clearScopeSession(scopeId: string, sessionId: string, opts?: StoreCallOpts): Promise<void> {
    await clearScopeSession(this.pluginManager, this.store, scopeId, sessionId, opts);
  }

  /**
   * 将消息 ingest 到 transcript：跑 context_ingest_handler 链，链尾 store_sink 写 store。
   * [v0.0.66 §2.7] 删 buffer 参数——buffer_sink impl 已删，store 扩展点取代（default→persistent /
   *   forked→in_memory）。参考 context_engine.md §3.6。
   *
   * [v0.0.83.forked_per_run_isolation] opts.runId：消息缓冲按 run 隔离（forked 每个 run 独立 buffer）。
   *   session(sid) + run(runId) 是通用领域 id；opts 承载 runId 透传到 store_sink → store.appendMessages。
   *   default 路径不传 opts（runId undefined → persistent 按 sid 落盘，零变化）。
   */
  async ingest(
    config: SessionConfig,
    messages: MessageInput[],
    scopeId: string = 'default',
    _allowEdit = false,
    opts?: StoreCallOpts,
    /**
     * [v0.0.361 §1.4 T3] 当前 run 的状态（RunState 透传；主 run 调用点持有 state 传入）。
     * injector 读 useFullReminder 决 full/incremental（undefined 视 true = run 首天然 full）；
     * forked / UT fixture 不传 → undefined → 恒 full（§1.4 语义）。
     */
    runState?: { useFullReminder?: boolean },
  ): Promise<void> {
    const extras = await buildReminderExtras(this.store, this.squadReminderDeps, config);
    // [v0.0.223] todoStore 透传到 reminder provider（TodoReminderProvider 经 ctx.todoStore 读 session todo）
    if (this.todoStore) (extras as { todoStore?: unknown }).todoStore = this.todoStore;
    // [v0.0.66 §2.3] store 按 scope 选 EP impl（default 持久 / forked 内存）；统一注入 store_sink
    const store = this.resolveStore(scopeId);
    // [v0.0.361 §1.2/§1.4 T3] reminder queue 句柄装配（drain/clearAll closure + runState 透传；
    //   queue store 缺席（UT fixture）仅透传 runState；两者皆无 → undefined（injector 降级））
    const qs = this.reminderQueueStore;
    const queueHandles: ReminderQueueHandles | undefined =
      qs || runState !== undefined
        ? {
            ...(qs
              ? {
                  queueDrain: (sid: string) => qs.drain(sid),
                  queueClearAll: (sid: string) => qs.clearAll(sid),
                }
              : {}),
            ...(runState !== undefined ? { runState } : {}),
          }
        : undefined;
    await applyIngestPipeline(
      this.pluginManager,
      config,
      messages,
      extras,
      scopeId,
      store,
      opts,
      queueHandles,
    );
  }

  /**
   * 组装 LLM 上下文快照（不调 LLM）。
   * [v0.0.173] base_builder 永远 rebuild（删 append 分支 + appendNew 函数），不再读 prevSnapshot 判增量；
   *   snapshot.messages = 确定性纯函数 f(summary, transcript)，同输入同输出保 prompt cache（详见
   *   context_assemble_detail.md §2）。prevSnapshot 入参仍用于 system 复用规则（下面）+ fixture 兼容。
   * [v0.0.66 §2.3] 零 forked 分支：default/forked 同一套主干逻辑，差异靠 store EP impl 切换（design §1）。
   *   - store 按 scope 选 EP impl（default 持久 / forked 内存）
   *   - summary = store.getSummary（forked 内存 store 恒返 null → 无 summary 分支 → `[...transcript]`）
   *   - systemText 复用规则：prevSnapshot 非空且（本 scope 无 summary 或 summary.version 未变）→ 复用
   *     prevSnapshot.system；否则调 buildSystemPrompt（design §1.3）；messages 不参与此判定（恒 rebuild）。
   *     forked 内存 store 恒无 summary → 无条件复用父 system（版本比较只对同 session 有意义，跨 session
   *     比父 version vs null 恒 true 会让 forked 每步重建、写 memory 即崩 prompt 缓存前缀）
   *   - contextWindowUsage 写入由 store EP impl 决定（forked in_memory no-op，不污染主对话）
   * @returns ContextSnapshot（含 system / messages / inputCharCount / contextWindowUsage / summary）
   */
  async assemble(
    config: SessionConfig,
    scopeId: string = 'default',
    prevSnapshot: ContextSnapshot | null = null,
    opts?: StoreCallOpts,
  ): Promise<ContextSnapshot> {
    // [v0.0.83] opts.runId 透传到消息缓冲方法（getMessages via transcript_reader / fallback）；
    //   session-meta 方法（getSummary/getRatio/updateContextWindowUsage）按 sid，与 run 无关，不传 opts。
    // [v0.0.66 §2.3] store 按 scope 选 EP impl；forked 内存 store getSummary 恒返 null → version 不变 → 永远 append
    const store = this.resolveStore(scopeId);
    const summary = await store.getSummary(config.sessionId);
    // ratio 与 computeContextWindowUsage 同源（store.getRatio），冷启动返 1.0
    const ratio = await store.getRatio(config.sessionId);

    // 跑 assemble mapper/reducer 双链（mapper：transcript_reader/summary_reader；
    // reducer：base_builder）。[v0.0.173] 6 个清理 reducer 已迁 context_clean_view_reducer EP（getCleanSnapshot 跑）；
    // base_builder 永远 rebuild，不再依赖 prevSnapshot（保留参数仅历史兼容）。
    const pipelinePicked = await runAssemblePipeline(
      this.pluginManager,
      store,
      config,
      prevSnapshot,
      scopeId,
      ratio,
      opts,
    );

    let picked: Message[];
    let systemText: string;
    if (pipelinePicked !== null) {
      // 链产出：base_builder reducer 产出 messages（system 由 snapshot.system 独立承载，design §1.3）。
      picked = pipelinePicked;
      // systemText 复用规则（design §1.3）：完全重建 → 调 builder；否则用 prevSnapshot.system（缺失 fallback builder）
      // [fix] 仅当前 scope 确有 summary 才比版本：forked 内存 store getSummary 恒 null，而 forked 路径的
      //   prevSnapshot 是父 snapshot（其 summary.version 属父 session）——跨 session 比较 V!==undefined 恒 true，
      //   导致 forked 每步重建 system（memory mapper 重读文件重渲染 → prompt 缓存前缀全崩，prod trace 实证
      //   cache_read 掉 128）。修正后：forked 无条件复用 prevSnapshot.system（父 system 整 run 冻结，且与父
      //   run 共享缓存前缀）；default 语义不变（首轮 !prevSnapshot / 本 session summary.version 变 → 重建）。
      const shouldRebuild = !prevSnapshot || (summary != null && prevSnapshot.summary?.version !== summary.version);
      systemText = shouldRebuild
        ? await this.buildSystemPrompt(config, scopeId)
        : (prevSnapshot?.system ? firstText(prevSnapshot.system) : await this.buildSystemPrompt(config, scopeId));
    } else {
      // fallback v0.0.8（pluginManager=null UT fixture）：直接读 transcript + head3/tail3。
      // pluginManager 非 null 但链空（production misconfig）→ hard fail（避免静默 fallback 掩盖 misconfig）。
      if (this.pluginManager) {
        throw new Error(
          'ContextEngine.assemble: assemble pipeline returned null with pluginManager set '
          + '— context_assemble_mapper/reducer chain empty (rocky_context builtin not loaded?)',
        );
      }
      const page = await store.getMessages(config.sessionId, { limit: 10000 }, opts);
      const all = page.items; // 升序（旧→新）
      picked = pickFallback(all, summary, config.sessionId);
      systemText = config.systemPrompt;
    }

    // char 估算（picked messages + system prompt）。contextWindowUsage 计算拆到 context-usage-calc.ts。
    const systemCharCount = estimateChars(systemText);
    const messageCharCount = picked.reduce((n, m) => n + estimateMessageChars(m), 0);
    const toolCharCount = estimateToolChars(config.tools);
    const inputCharCount = systemCharCount + messageCharCount + toolCharCount;

    const tokenLimit = config.client.contextWindow;
    const cw = await computeContextWindowUsage(
      store,
      config.sessionId,
      tokenLimit,
      { system: systemCharCount, message: messageCharCount, tool: toolCharCount },
      this.appConfig,
    );
    // 持久化 cw 到 session meta 并推送（updateUsage 写+推一体：写 cw 后读 getUsageView 全量
    //   emit session_usage_update——推送时累计分区必为 store 最新值；forked in_memory store no-op，
    //   不污染主对话零推送，§2.3）
    await store.updateUsage(config.sessionId, { contextWindowUsage: cw });

    const system: Message = {
      id: 'system',
      sessionId: config.sessionId,
      role: 'system',
      content: [{ type: 'text', text: systemText }],
    };

    return {
      system,
      messages: picked,
      inputCharCount,
      contextWindowUsage: cw,
      summary,
      // [v0.0.82] tools 加回 snapshot：从 config.tools 派生 definitions（与 main spec.toolDefinitions 同源），
      // 供 forked 复用保 cache 前缀（spec §2 完整形态本含 tools，v0.0.8 省略现恢复）。
      tools: ((config.tools as Array<{ definition: ToolDefinition }> | undefined) ?? []).map(
        (t) => t.definition,
      ),
    };
  }

  /**
   * 喂 LLM 前的清理视图：深克隆 snapshot.messages + 跑 clean view reducer 链。
   *
   * 衔接链（change_plan §三 开放点 A3）：
   *   state.snapshot（assemble 产出，稳定 rebuild 含原始 role + reminder block）
   *     → 本方法 structuredClone 深克隆 messages
   *     → 跑 clean view 链（snip/orphan/think/fill/empty/role_merge）
   *     → 返回新 ContextSnapshot（messages 已清理，原 snapshot 不变）
   *     → loop-stage-llm.callLLMForSpec 取 messages
   *     → protocol.encode wire 层（tool→user 映射 + mergeAdjacentSameRole + reminder 过滤）
   *
   * 不变量（req 关键约束 + change_plan §三）：
   *   - MUST structuredClone 深克隆（绝不 mutate 入参 snapshot.messages）
   *   - MUST 返新 snapshot 对象（不 mutate 原 snapshot 任何字段）
   *   - MUST NOT 跑 assemble mapper/reducer 链（clean view 只跑 clean reducer）
   *   - pluginManager=null 时返 messages 深克隆 fallback（保 UT fixture 兼容；链 null fallback 同义）
   *   - 其他字段（system/tools/summary/contextWindowUsage/inputCharCount）引用复用（不被触碰）
   *
   * @param snapshot assemble 产出的稳定 snapshot（messages = rebuild 确定性纯函数输出）
   * @param scopeId  'default' / 'forked'（决定 clean view EP per-scope 回退取源）
   * @returns 新 ContextSnapshot（messages 字段已清理；其他字段引用复用自入参）
   */
  async getCleanSnapshot(
    snapshot: ContextSnapshot,
    scopeId: string = 'default',
  ): Promise<ContextSnapshot> {
    // (1) 深克隆 snapshot.messages（关键不变量：绝不 mutate 入参 snapshot.messages）
    const cloned: Message[] = structuredClone(snapshot.messages);

    // (2) config 占位：clean reducer 不读 config 数据字段，仅 fill_empty_text 读 ctx.config.sessionId
    //     写 error 级日志（logWriter 未注入则 fail-silent）。sessionId 从 snapshot.system 派生。
    const placeholderConfig = { sessionId: snapshot.system.sessionId } as SessionConfig;

    // (3) 跑 clean view 链；null → fallback 用 cloned 本身（无 pluginManager / 链空）
    const cleaned = runCleanViewPipeline(this.pluginManager, cloned, scopeId, placeholderConfig)
      ?? cloned;

    // (4) 返新 snapshot（其他字段 system/tools/summary/contextWindowUsage/inputCharCount 引用复用）
    return { ...snapshot, messages: cleaned };
  }

  /**
   * 压缩对话为 summary、推进 summaryUpTo（CAS 串行化防并发）。
   * 流程：SessionTaskLock.acquire('compact') → assemble → sideRun（summary runKind）→ extractTag → setSummary。
   * 执行路径拆到 context-compact-runner.ts（≤300 行约束），本方法薄壳调用。
   *
   * compact 是纯生产者（setSummary + accumulateUsage write），不产任何 transcript 消息，
   * 故无需向 agentLoopBus emit message 序列。
   *
   * @returns true=完成；false=CAS 失败（已有 compact 在跑，跳过）
   */
  async compact(config: SessionConfig): Promise<boolean> {
    // 手动入口（POST /compact）：caller 不持有 main snapshot，这里先 assemble 产 snapshot。
    // 自动入口（tryCompact）走 summary_do_compact → runCompact，直接传 main snapshot 深拷贝，不进本方法。
    // scopeId 按 session scope 解析（生产唯一 caller=session-compact handler，config 必带 kind）：
    //   手动 compact 的 snapshot.system 与该 scope 主 run 全链一致。
    const scopeId = scopeIdOf(config.kind!);
    const snapshot = await this.assemble(config, scopeId);
    // 手动/自动统一：post-compact EP（consolidate）收进 runCompact 末尾触发，
    //   手动路径同样构造 CompactPluginContext（scopeId/pluginManager/consolidateRunner/store/taskLock）。
    const pluginCtx: CompactPluginContext = {
      scopeId,
      pluginManager: this.pluginManager,
      consolidateRunner: this.consolidateRunner,
      store: this.store,
      taskLock: this.taskLock,
    };
    return runCompact(
      this.store,
      this.taskLock,
      config,
      snapshot,
      this.sideRunner,
      undefined,
      undefined,
      undefined,
      pluginCtx,
    );
  }

  /**
   * 构建 system prompt string（委托 system-prompt-builder）。
   * scopeId 透传：mapper/reducer 链按 scope 取 impl 列表（scope 级 system_prompt 覆写生效）；
   * 缺省 'default'。
   */
  buildSystemPrompt(config: SessionConfig, scopeId: string = 'default'): Promise<string> {
    return buildSystemPrompt(this.pluginManager, config, scopeId);
  }
}

// re-export（保外部 import 路径不变；详见 context-compact-helpers.ts）
export { extractTag };
export type { LlmClient, ContextSnapshot, SessionConfig, SummaryInfo, AppConfigLike };
// re-export squad reminder deps（bootstrap 注入用 type，拆自 squad-reminder-deps.ts）
export type { SquadReminderDeps } from './squad-reminder-deps';
