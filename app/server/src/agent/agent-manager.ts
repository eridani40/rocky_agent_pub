/**
 * AgentManagerImpl — session 级 agent 管理器
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md §3 §5
 *
 * 职责（agent_manager §3）：门面 + 编排
 *   - enqueue：消息入 inbox（独立存储，不写主对话 store） + emit message_enqueued
 *   - activate：启动 AgentLoop（幂等），异步不 await，返 AgentRun
 *   - sideRun：旁路 run 入口（runKind=summary/consolidate，编排逻辑在 agent-side-run.ts）
 *   - abort：中断 session 的指定 run（主对话 4 步收尾 / 旁路直接置 aborted）
 *   - subscribe：经 bus.subscribe 订阅 session 事件流
 *
 * 按职责拆分：
 *   - agent-run-registry.ts：三 map 管理（shell 构造 / promise 绑定 / cleanup）+ startRunAndTrack 启动 shell
 *   - agent-side-run.ts：旁路 run 启动编排（executeSideRun）
 *   - abort-finalize.ts：abort 4 步 + finalizeHalfData + emitInterruptedRunStop
 *
 * 解耦原则（agent_manager §1）：enqueue / activate 解耦；activate 幂等；AgentLoop 独立类。
 */
import { ulid } from '../config/ulid';
import type { Message } from '../message/types';
import type { ToolExecutionEngine } from '../tools/engine';
import type { ContextEngine } from './context-engine';
import type { SessionConfig } from './context-types';
import type { SessionStore } from './session-store';
import type { MemberStore } from '../stores/squad-store';
import type { InboxStore, InboxEntry } from './inbox';
import type { AgentEvent, MessageEnqueuedEvent } from './agent-event-types';
import type { EventBusEvent, ReplayableEventBus } from './event-bus';
import { buildRunDeps } from './build-run-deps';
import type { LoopHandle } from './run-loop-handle';
import { emitEnqueuedCanceled, type EmitContext } from './agent-loop-emitters';
import { groupKeyForRunKind } from './agent-interface';
import type { AgentRun, AbortResult, AbortControllerHandle } from './agent-interface';
import type { RunKind } from '../../../shared/src/types/session-kind';
import type { SessionTypePolicy } from './session-type-policy';
// run 级子进程注册表：两处 controller 创建（activate 主对话 + agent-side-run 旁路）都挂载
import { ChildProcessRegistry } from '../tools/child-process-registry';
import type { RunSpec } from './loop-ports';
import type { ObservabilityAdapter } from '../observability/adapter';
import { noopAdapter } from '../observability/noop-adapter';
import {
  loopKey, runMapKey, RUN_KIND_MAIN,
  createAgentRunShell, makeErrorRun, startRunAndTrack,
} from './agent-run-registry';
import { executeSideRun, type SideRunOptions } from './agent-side-run';
import { abortRun, waitForInterruptingSettled } from './abort-finalize';
import {
  ChildrenTracker, managerDeliverTo, managerAbortCascade,
  type ManagerChildrenOps,
} from './agent-manager-children';
import { A2aReplyTracker } from './a2a-reply-tracker';

/** AgentManager 构造参数 */
export interface AgentManagerOptions {
  /** agent_loop topic 的 bus（replayable） */
  bus: ReplayableEventBus;
  store: SessionStore;
  inbox: InboxStore;
  contextEngine: ContextEngine;
  toolEngine: ToolExecutionEngine;
  /** 全局 observability adapter（可选） */
  observability?: ObservabilityAdapter;
  /**
   * 按 sessionId 解析 SessionConfig（deliverTo / spawn 用）。
   * 由 bootstrap 注入：内部调 buildSessionConfigFromDeps + store.getSession
   * 取持久 providerId/modelId/workspaceDir 组装完整 config。
   * 缺省 → deliverTo/spawn 抛错（测试可注入 mock）。
   */
  resolveConfig?: (sessionId: string) => Promise<SessionConfig>;
  /**
   * 构造 agent 工具运行时上下文（spawn/query/abort + send_message 用）。
   * activate 时调本函数注入到 child SessionConfig.agentToolContext；
   * agent-loop 构造 ToolCtx 时透传给 agent-tool / send-message-tool。
   * 缺省 → 不注入（agent 工具 run 时抛「未注入」）。
   */
  buildAgentToolContext?: (sessionId: string, runId: string) => Promise<unknown>;
  /**
   * SessionTypePolicy — sideRun 内部派生 allowedTools / maxIter 用（profile 单源）。
   * 缺省 → sideRun 抛错（生产路径 bootstrap 必注；测试 mock 可省）。
   */
  sessionTypePolicy?: SessionTypePolicy;
  /**
   * [v0.0.340 决策 1] 可选 memberStore——enrich sender 名反查注入面（squad 成员 sender
   *   反查实时名，不读 session.title 快照）。缺省 undefined → 行为不变（测试兼容）。
   */
  memberStore?: MemberStore;
}

/**
 * AgentManager 实现（agent_manager §4）：三 map（loops / agentRuns / abortControllers）+
 * activate 创建 controller 注入 loop；sideRun 经 executeSideRun 每次新建 RunLoopHandle。
 */
export class AgentManagerImpl {
  private readonly bus: ReplayableEventBus;
  private readonly store: SessionStore;
  private readonly inbox: InboxStore;
  private readonly contextEngine: ContextEngine;
  private readonly toolEngine: ToolExecutionEngine;
  private readonly observability: ObservabilityAdapter;
  /** sessionId_current → running loop（幂等检查用） */
  private readonly loops: Map<string, LoopHandle> = new Map();
  /** ${sid}_${runKind} → AgentRun（caller 视图对象） */
  private readonly agentRuns: Map<string, AgentRun> = new Map();
  /** ${sid}_${runKind} → AbortControllerHandle（内存中断对象） */
  private readonly abortControllers: Map<string, AbortControllerHandle> = new Map();
  /** children 运行追踪（parentSid → Set<childSid>；级联 abort + 并发限用） */
  readonly children = new ChildrenTracker();
  /** a2a 履约追踪（判据 A 数据源）：内存态不落盘；deliverTo 成功后 mark，child run 装配快照 baseline 判履约 */
  private readonly a2aReplyTracker = new A2aReplyTracker();
  /** resolveConfig 注入点（deliverTo/spawn 用；缺省抛错，bootstrap 后置注入） */
  private resolveConfigFn?: (sessionId: string) => Promise<SessionConfig>;
  /** buildAgentToolContext 注入点（activate 时注入到 child config；bootstrap 后置注入） */
  private buildToolCtxFn?: (sessionId: string, runId: string) => Promise<unknown>;
  /** SessionTypePolicy — sideRun 内部派生 allowedTools / maxIter 用 */
  private readonly sessionTypePolicy?: SessionTypePolicy;
  /** [v0.0.340 决策 1] memberStore 注入面（enrich sender 名反查；缺省 undefined → 不反查） */
  private readonly memberStore?: MemberStore;

  constructor(opts: AgentManagerOptions) {
    this.bus = opts.bus;
    this.store = opts.store;
    this.inbox = opts.inbox;
    this.contextEngine = opts.contextEngine;
    this.toolEngine = opts.toolEngine;
    this.observability = opts.observability ?? noopAdapter;
    this.resolveConfigFn = opts.resolveConfig;
    this.buildToolCtxFn = opts.buildAgentToolContext;
    this.sessionTypePolicy = opts.sessionTypePolicy;
    this.memberStore = opts.memberStore;
  }

  /**
   * 按 sessionId 解析 SessionConfig（方案 A 无 cache）。
   * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md §2.3
   *
   * 复用 bootstrap setResolveConfig 注入的 buildSessionConfigFromDeps 通路。
   * 每次 enqueue/activate/deliverTo 内部按需取最新 session 持久字段（无 cache）。
   * public：AutoNamingService 也复用此方法取 SessionConfig 后调 client.call。
   *
   * @throws 未注入 resolveConfig 时 throw（bootstrap 后置注入；测试需 setResolveConfig）
   */
  async resolveConfigBySid(sessionId: string): Promise<SessionConfig> {
    if (!this.resolveConfigFn) {
      throw new Error('AgentManager: resolveConfig not injected (bootstrap 未注入)');
    }
    return this.resolveConfigFn(sessionId);
  }

  /**
   * 入队消息到 session inbox（不触发推理，只写 inbox + 分配 enqueueId + emit message_enqueued）。
   * 签名 `enqueue(sessionId, messages)`——config 由 manager 内部按 sessionId 解析（enrich 在
   * deliverTo 层，裸 enqueue 不 enrich）。详见 [P0]agent_manager.md §2.3。
   */
  async enqueue(sessionId: string, messages: Message[]): Promise<string[]> {
    // config 解析失败不阻塞 enqueue（防击穿）：provider/model 配置错误时 throw 会击穿 deliverTo 的
    //   fire-and-forget 路径 → unhandled rejection → 进程 crash。本方法只用 sessionId；config
    //   真正错误在 activate 时报（落 makeErrorRun 给 caller）。仅"未注入"（misconfig）仍抛。
    if (!this.resolveConfigFn) {
      throw new Error('AgentManager: resolveConfig not injected (bootstrap 未注入)');
    }
    try {
      await this.resolveConfigBySid(sessionId);
    } catch (e) {
      console.warn(
        `[enqueue] session ${sessionId} resolveConfig failed (will surface on activate):`,
        e instanceof Error ? e.message : String(e),
      );
    }
    const enqueueIds = this.inbox.enqueue(sessionId, messages);
    for (let i = 0; i < messages.length; i++) {
      this.emitMessageEnqueued(sessionId, enqueueIds[i]!, messages[i]!);
    }
    return enqueueIds;
  }

  /**
   * 取消排队消息（agent_enqueue_cancel.md §2 §5）。
   * 同步 removeMessage + emit canceled（不等 drain，避免竞态）。
   */
  async cancel(sessionId: string, enqueueId: string): Promise<void> {
    const removed = this.inbox.removeMessage(sessionId, enqueueId);
    if (removed) {
      const ctx: EmitContext = {
        sessionId, runId: '', runKind: RUN_KIND_MAIN,
        bus: this.bus, now: () => new Date().toISOString(),
      };
      emitEnqueuedCanceled(ctx, enqueueId);
      return;
    }
    // message 已被 drain 消费（cancel 来晚）→ 追加 cancel 条目作 drain 兜底（幂等无害）
    this.inbox.appendCancel(sessionId, enqueueId);
  }

  /**
   * 只读 peek session inbox（GET /session/:id/inbox handler 透传用）。
   * 纯透传不改语义：返全量 InboxEntry[]（含 message + cancel 两 kind），过滤 kind:'message'
   * 由调用方负责——保持 inbox.peek 既有 normal-mode live-ref 契约。
   * 注意：peek 返直接引用，drain splice 会改同数组；调用方须自行浅拷贝快照。
   */
  peekInbox(sessionId: string): InboxEntry[] {
    return this.inbox.peek(sessionId);
  }

  /**
   * 激活 session 的 AgentLoop（返 AgentRun）。三情况（session_state §4.1）：
   *  running/interrupting → 返现有 AgentRun；idle/interrupted/error → CAS markRunning 启动新 loop。
   *  签名 `activate(sessionId)`——config 由 manager 内部按 sessionId 解析。
   */
  async activate(sessionId: string): Promise<AgentRun> {
    // config 解析失败不击穿进程：deliverTo 的 fire-and-forget 路径遇 throw → unhandled rejection
    //   → 进程 crash。故 catch 运行时 config 错误 → 落 makeErrorRun（state='error'，caller handler
    //   有兜底）。session.state 不动（markRunning 未跑）。仅"未注入"（misconfig）仍显式抛。
    if (!this.resolveConfigFn) {
      throw new Error('AgentManager: resolveConfig not injected (bootstrap 未注入)');
    }
    let config: SessionConfig;
    try {
      config = await this.resolveConfigBySid(sessionId);
    } catch (e) {
      // 透传原 Error（非字符串化）——保 ModelNotConfiguredError 等 structured error 的 code/detail，
      //   供 caller handler 识别返语义化 400。非 Error 值（字符串 throw 等）兜底包 Error。
      const errObj = e instanceof Error ? e : new Error(String(e));
      console.warn(`[activate] session ${sessionId} config resolve failed:`, errObj.message);
      return makeErrorRun(sessionId, RUN_KIND_MAIN, errObj);
    }
    const sid = sessionId;
    const lk = loopKey(sid);
    const rk = runMapKey(sid, RUN_KIND_MAIN);

    // case3：interrupting 时循环等待收尾完成
    await waitForInterruptingSettled(this.store, sid);

    // 优先检查内存 map（loop 仍在运行 → 返现有 AgentRun，幂等优化）
    const existing = this.loops.get(lk);
    if (existing && existing.isRunning()) {
      const existingRun = this.agentRuns.get(rk);
      if (existingRun) return existingRun;
      return createAgentRunShell(sid, RUN_KIND_MAIN, existing.runId);
    }

    // 读 store state 决定（design §11.11 闸门 = session 持久化状态）
    const session = await this.store.getSession(sid);
    if (!session) return makeErrorRun(sid, RUN_KIND_MAIN, `session not found: ${sid}`);
    if (session.state === 'running') {
      const runId = session.currentRunId ?? '';
      const existingRun = runId ? this.agentRuns.get(rk) : undefined;
      if (existingRun) return existingRun;
      return createAgentRunShell(sid, RUN_KIND_MAIN, runId);
    }

    // 创建 controller + CAS markRunning（挂 run 级 ChildProcessRegistry，不改 CAS 时序）
    const newRunId = ulid();
    const controller: AbortControllerHandle = { runId: newRunId, aborted: false, childRegistry: new ChildProcessRegistry() };
    const casOk = await this.store.stateMachine.markRunning(sid, newRunId);
    if (!casOk) {
      const refreshed = await this.store.getSession(sid);
      const runId = refreshed?.currentRunId ?? '';
      const existingRun = runId ? this.agentRuns.get(rk) : undefined;
      if (existingRun) return existingRun;
      return createAgentRunShell(sid, RUN_KIND_MAIN, runId);
    }

    const configWithObs: SessionConfig =
      config.observability !== undefined ? config : { ...config, observability: this.observability };

    // 注入 agent 工具运行时上下文（agent-tool / send-message-tool 经 ctx 读）。
    // bootstrap 注入 buildToolCtxFn（含 manager/store/sessionDeps + parent session info）。
    let configWithToolCtx: SessionConfig = configWithObs;
    if (this.buildToolCtxFn && configWithObs.agentToolContext === undefined) {
      try {
        const toolCtx = await this.buildToolCtxFn(sid, newRunId);
        configWithToolCtx = { ...configWithObs, agentToolContext: toolCtx };
      } catch {
        // 注入失败不阻塞 activate（agent 工具 run 时再抛「未注入」）
        configWithToolCtx = configWithObs;
      }
    }

    // activate 降为 thin wrapper —— buildRunDeps 装配 main RunSpec 后调 run(spec, loop)。
    //   三 map 注册 + start + cleanup 全在 run() → startRunAndTrack。
    try {
      const { spec, loop } = buildRunDeps({
        config: configWithToolCtx, bus: this.bus, store: this.store,
        inbox: this.inbox, contextEngine: this.contextEngine,
        toolEngine: this.toolEngine,
        runId: newRunId, controller,
        kind: configWithToolCtx.kind!,
        sessionTypePolicy: this.sessionTypePolicy!,
        observability: this.observability,
        // 回报兜底两窄口（buildRunDeps 内仅 main && subagent 装配 replySettle）
        a2aReplyTracker: this.a2aReplyTracker,
        deliverToFn: (targetSid, msg) => this.deliverTo(targetSid, msg),
      });
      return this.run(spec, loop);
    } catch (e) {
      const errObj = e instanceof Error ? e : new Error(String(e));
      return makeErrorRun(sid, RUN_KIND_MAIN, errObj);
    }
  }

  /**
   * 唯一 loop 启动入口（agent_manager §1 单 loop 入口）——thin wrapper。
   * 启动逻辑（注册三 map → void loop.start() → 绑 promise + cleanup）在 startRunAndTrack；
   * shell 构造按 runKind 分流（main 结果不传播 / 旁路 RunResult 真实传播 + error→reject）。
   */
  async run(spec: RunSpec, loop: LoopHandle): Promise<AgentRun> {
    return startRunAndTrack(
      { agentRuns: this.agentRuns, abortControllers: this.abortControllers, loops: this.loops },
      spec,
      loop,
    );
  }

  /**
   * 旁路 run 入口（agent_manager §2）——thin wrapper。
   * 编排逻辑（并发检查 + controller + snapshot 克隆 + buildRunDeps 装配 + 启动）在
   * agent-side-run.ts executeSideRun；旁路不碰 session 五态机。
   */
  async sideRun(opts: SideRunOptions): Promise<AgentRun> {
    return executeSideRun(
      {
        bus: this.bus,
        store: this.store,
        contextEngine: this.contextEngine,
        toolEngine: this.toolEngine,
        sessionTypePolicy: this.sessionTypePolicy!,
        defaultObservability: this.observability,
        agentRuns: this.agentRuns,
        abortControllers: this.abortControllers,
        loops: this.loops,
      },
      opts,
    );
  }

  /**
   * 中断 session 指定 run（主对话 4 步收尾 / 旁路直接 aborted=true）。
   * 主对话 abort 成功后级联中断 in-flight children（D6 单向——parent abort → child 跟停）。
   * 传递性：级联 abort child 再触发本方法 → 级联 grandchild。child 自身挂不连坐 parent。
   */
  async abort(sessionId: string, runId: string, runKind: RunKind): Promise<AbortResult> {
    const result = await abortRun({
      sessionId, runId, runKind,
      store: this.store, bus: this.bus,
      agentRuns: this.agentRuns, abortControllers: this.abortControllers, loops: this.loops,
    });
    // D6 级联：仅主对话 + accepted 时遍历 in-flight child 级联（helper 在 agent-manager-children）
    if (runKind === RUN_KIND_MAIN && result.accepted) {
      await managerAbortCascade(this.childrenOps(), this.children, sessionId);
    }
    return result;
  }

  /**
   * abortSession —— 中断 session 的当前主对话 run（team 硬删 teardown 用）。
   * 读 session.currentRunId：存在则以 RUN_KIND_MAIN abort 当前 run；无 run 或 session 不存在 → no-op。
   * 封装 RUN_KIND_MAIN 不外泄（调用方无需知道 runKind 概念）；幂等——重复调 / 无 run / 不存在均安全。
   */
  async abortSession(sessionId: string): Promise<void> {
    const session = await this.store.getSession(sessionId);
    const runId = session?.currentRunId;
    if (!runId) return; // 无进行中 run（含 session 不存在）→ 安全 no-op
    await this.abort(sessionId, runId, RUN_KIND_MAIN);
  }

  /** 构造 children ops（注入 store + abort + enqueue/activate 给 helper） */
  private childrenOps(): ManagerChildrenOps {
    return {
      enqueue: (sid, msgs) => this.enqueue(sid, msgs),
      activate: (sid) => this.activate(sid),
      abort: (sid, rid, mk) => this.abort(sid, rid, mk),
      getSession: async (sid) => {
        const s = await this.store.getSession(sid);
        return s ? { state: s.state, currentRunId: s.currentRunId } : null;
      },
      // enrichForInbox 反查发送方 session record（title/subAgentTemplateType 等）
      getFullSession: (sid) => this.store.getSession(sid),
      // [v0.0.340 决策 1] memberStore 透传（sender 名反查实时名；缺省 undefined → 不反查）
      ...(this.memberStore ? { memberStore: this.memberStore } : {}),
    };
  }

  /** 后置注入 resolveConfig（打破 bootstrap 循环引用：agentManager 引用自身） */
  setResolveConfig(fn: (sessionId: string) => Promise<SessionConfig>): void {
    this.resolveConfigFn = fn;
  }

  /** 后置注入 buildAgentToolContext（打破循环引用） */
  setBuildAgentToolContext(fn: (sessionId: string, runId: string) => Promise<unknown>): void {
    this.buildToolCtxFn = fn;
  }

  /**
   * deliverTo —— 统一投递入口（derivation §4.1）。
   * 只需 sessionId + message：inbox.append + activate → AgentRun，不碰 config。
   * spawn 首任务 / a2a send_message / 测试 fixture 等所有「给 session 发消息」场景收敛到此。
   */
  async deliverTo(sessionId: string, message: Message): Promise<AgentRun & { enqueueId: string }> {
    const run = await managerDeliverTo(this.childrenOps(), sessionId, message);
    // 判据 A：投递成功后按 message 自身 sender 记 from→to（失败抛错不 mark；user/system 来源不记）
    if (message.sender?.source === 'agent') {
      this.a2aReplyTracker.markDelivery(message.sender.agent.ref.sessionId, sessionId);
    }
    return run;
  }

  /**
   * isSessionBusy — scheduler gate-chain gate3 的 busy check。
   *
   * 参考: specs/tech/squad/[P1]scheduler.md §4 gate3（deliverTo 前 check 防 enqueue 堆积）
   *       specs/tech/squad/[P1]squad_autonomy.md §5（busy 跳过当周期；activate 幂等但 enqueue 不可撤）
   *
   * check `session.state === 'running'`（与 activate() 同口径）。session 不存在返 false
   * （不阻塞 gate——deliverTo 会自然报错；实践中 scheduler 持 sessionId 来自 squad data，必存在）。
   *
   * @returns true = session running 中（跳过当周期 tick，下次到点重来，不堆 enqueue）
   */
  async isSessionBusy(sessionId: string): Promise<boolean> {
    const session = await this.store.getSession(sessionId);
    return session?.state === 'running';
  }

  /** 订阅 session 事件流（agent_manager.md §2，runKind 默认 main） */
  subscribe(sessionId: string, runKind: RunKind = RUN_KIND_MAIN): AsyncIterable<AgentEvent> {
    const inner = this.bus.subscribe<AgentEvent>(groupKeyForRunKind(sessionId, runKind));
    return this.unwrap(inner);
  }

  /** EventBusEvent={data,timestamp} → unwrap data 透传消费者 */
  private async *unwrap(iter: AsyncIterable<EventBusEvent<AgentEvent>>): AsyncIterable<AgentEvent> {
    for await (const ebe of iter) {
      if (ebe.data === undefined) continue;
      yield ebe.data;
    }
  }

  /** emit message_enqueued（agent_manager.md §5 emitMessageEnqueued） */
  private emitMessageEnqueued(sessionId: string, enqueueId: string, msg: Message): void {
    const e: MessageEnqueuedEvent = {
      id: ulid(), type: 'message_enqueued',
      sessionId, createdAt: new Date().toISOString(),
      runKind: RUN_KIND_MAIN, enqueueId,
      source: msg.sender?.source ?? 'user', role: msg.role, content: msg.content,
    };
    this.bus.emit(groupKeyForRunKind(sessionId, RUN_KIND_MAIN), {
      data: e, timestamp: new Date().toISOString(),
    });
  }

  /** （诊断/测试用）返回当前活跃 loop 数 */
  activeLoopCount(): number {
    return this.loops.size;
  }

  /** clear 用：清指定 runKind 的 replay buffer（spec session_clear.md §5.2）。 */
  clearReplay(sessionId: string, runKind: RunKind): void {
    this.bus.clearReplay(groupKeyForRunKind(sessionId, runKind));
  }
}
