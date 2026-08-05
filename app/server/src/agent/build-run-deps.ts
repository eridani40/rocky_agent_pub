/**
 * buildRunDeps — profile 驱动 RunSpec 单装配入口
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md §2/§4
 *       specs/tech/agent/session/[P0]session_type_profile.md §3/§6
 *
 * main/旁路 run 差异完全由 profile 字段驱动（policy.profile(kind) 唯一读取入口）：
 *   runShape（drainMode/backgroundPath/maxIterDefault/persistsRun/touchesStateMachine/usagePartition）+
 *   toolDefinitionsSource（own=config.tools 三层一致 / host-snapshot=snapshot.tools 复用）+ eventChannel.emitDefault。
 * runReActLoop 骨架零 if kind（全参数化）。
 */
import { ulid } from '../config/ulid';
import type { ToolDefinition } from '../tools/types';
import type { Message, ContextWindowUsage } from '../message/types';
import type { ContextEngine } from './context-engine';
import type { SessionStore } from './session-store';
import type { InboxStore } from './inbox';
import type { ReplayableEventBus } from './event-bus';
import type { ToolExecutionEngine } from '../tools/engine';
import type { ObservabilityAdapter } from '../observability/adapter';
import type { AbortControllerHandle } from './agent-interface';
import { groupKeyForRunKind } from './agent-interface';
import type { EmitContext } from './agent-loop-emitters';
import { LoopObservability } from './agent-loop-observability';
import { maxIterOf } from './agent-loop-lifecycle';
import { EOS_STOP_TOKEN, stripEosToken } from './agent-loop-stage-llm';
import type { RunSpec, LoopState } from './loop-ports';
import type { SessionConfig, ContextSnapshot } from './context-types';
import { injectSideRunReminder } from './side-run-reminder-injector';
import { scopeIdOf } from './scope-id';
import type { PluginManager } from '../plugin/plugin-manager';
import type { SessionTypePolicy } from './session-type-policy';
import type { SessionKind } from '../../../shared/src/types/session-kind';
import { RunLoopHandle, silentBus } from './run-loop-handle';
import { RunLifecyclePort } from './run-lifecycle-port';
import { wrapRevocableEmitCtx, wrapRevocableContextEngine } from './revocable-side-effects';
import type { A2aReplyTracker } from './a2a-reply-tracker';

/** buildRunDeps 构造参数（activate + 旁路 run 入口组装后注入） */
export interface BuildRunDepsOpts {
  config: SessionConfig;
  bus: ReplayableEventBus;
  store: SessionStore;
  contextEngine: ContextEngine;
  toolEngine: ToolExecutionEngine;
  controller: AbortControllerHandle;
  /** policy 单源（必填）：profile(kind) 派生所有装配字段（drainMode/persistsRun/toolBound/maxIterDefault/...） */
  sessionTypePolicy: SessionTypePolicy;
  /** 身份（runKind 字段决定 main/summary/consolidate；canonicalId 即 scopeId） */
  kind: SessionKind;
  runId?: string;
  observability?: ObservabilityAdapter;
  /** main 专属：drainMode='eager' 必填 inbox（peek/drain 用） */
  inbox?: InboxStore;
  /** 旁路 run 专属：snapshot（必填——sideRun opts 必填；main 路径忽略本字段） */
  snapshot?: ContextSnapshot;
  /** 旁路 run 专属：任务 userMessage（main=undefined） */
  userMessage?: Message;
  /** 旁路 run 专属：触发点 message（仅取 id 写入 trace metadata.inputMessageIds） */
  triggerMessage?: Message;
  /** 旁路 run 专属：触发时 context window 用量（写入 trace metadata.triggerUsage） */
  triggerUsage?: ContextWindowUsage;
  /** 旁路 run 专属：emit 开关（默认 true；false=静音 suppress message_*） */
  emit?: boolean;
  /**
   * main+subagent 专属：a2a 履约追踪器（AgentManagerImpl 单例经 activate 注入）。
   * 旁路 executeSideRun / 测试缺省 → replySettle 不装配（全链路 noop）。
   */
  a2aReplyTracker?: A2aReplyTracker;
  /** main+subagent 专属：系统代发投递口（manager.deliverTo 箭头函数绑 this） */
  deliverToFn?: (targetSid: string, msg: Message) => Promise<unknown>;
}

/**
 * 装配 RunSpec + RunLoopHandle（policy.profile(kind) 单源驱动 main/旁路 run 装配）。
 *
 * main（kind.runKind='main'）：drainMode='eager' / persistsRun=true / touchesStateMachine=true /
 *   toolDefinitionsSource='own'（config.tools 三层一致派生） / usagePartition='current'。
 * 旁路 run（'summary'|'consolidate'）：drainMode='none' / persistsRun=false /
 *   touchesStateMachine=false / toolDefinitionsSource='host-snapshot'（snapshot.tools 复用，
 *   snapshot 必填） / usagePartition 同 runKind。
 */
export function buildRunDeps(opts: BuildRunDepsOpts): { spec: RunSpec; loop: RunLoopHandle } {
  const { controller } = opts;
  const runId = opts.runId ?? ulid();
  const kind = opts.kind;
  const runKind = kind.runKind;
  const sid = opts.config.sessionId;
  const isMain = kind.isMainRun;
  const profile = opts.sessionTypePolicy.profile(kind);

  const scopeId = scopeIdOf(kind);

  // —— 工具：三层 name set 一致（main=config.tools 派生 / 旁路=snapshot.tools 复用 + resolveToolSet 单源过滤）——
  let toolDefinitions: ToolDefinition[];
  let allowedTools: string[];
  let maxIter: number;
  if (isMain) {
    // main：session-config 阶段 policy.resolveToolSet 已算 config.tools；本处三层一致派生
    const configTools = (opts.config.tools as Array<{ definition: ToolDefinition }> | undefined) ?? [];
    toolDefinitions = configTools.map((t) => t.definition);
    allowedTools = toolDefinitions.map((d) => d.name);
    maxIter = maxIterOf(opts.config);
  } else {
    // 旁路 run：toolDefinitions = snapshot.tools 复用（cache 契约）；snapshot 必填（sideRun opts 必填）
    const providedSnapshot = opts.snapshot!;
    toolDefinitions = providedSnapshot.tools;
    // allowedTools = resolveToolSet 单源（profile.toolBound ∩ snapshot 名表，注册序）。
    // 只取 allowedTools 一件——resolveToolSet 产的 tools/toolDefinitions 是 registry 序全集子集，
    // 绝不给旁路用（会破 toolDefinitions=snapshot.tools 的 cache 契约）。
    ({ allowedTools } = opts.sessionTypePolicy.resolveToolSet(kind, {
      tools: toolDefinitions.map((d) => d.name),
    }));
    maxIter = profile.runShape.maxIterDefault;
  }

  // —— LoopObservability ——
  const obs = new LoopObservability({
    adapter: opts.observability ?? opts.config.observability,
    runId,
    sessionId: sid,
    modelId: opts.config.modelId,
    sessionKind: kind.canonicalId(),
    runKind,
    fallbackSystemPrompt: opts.config.systemPrompt,
    toolDefinitions,
    triggerUsage: isMain ? undefined : opts.triggerUsage,
  });

  // —— emit 闭包（main 永远开；旁路 run 看 opts.emit，默认 true）——
  const emitOn = isMain ? true : opts.emit !== false;
  const group = groupKeyForRunKind(sid, runKind);
  const emit = emitOn
    ? (e: import('./agent-event-types').AgentEvent): void => {
        opts.bus.emit(group, { data: e, timestamp: new Date().toISOString() });
      }
    : (): void => { /* emit=false: noop（suppress message_*） */ };

  const emitCtx: EmitContext = {
    sessionId: sid,
    runId,
    runKind,
    bus: emitOn ? opts.bus : silentBus,
    now: () => new Date().toISOString(),
  };

  // —— v0.0.207 authority transfer：包 revocable handle，让 abort 能吊销 loop emit/ingest 副作用 ——
  // main + forked 都包（forked 不被调 revoke，无副作用）；wireEmitCtx/wireContextEngine 用 proxy。
  // abort api 直发 bus.emit / store.appendMessages 走原对象，不经 proxy → 豁免。
  const emitWrap = wrapRevocableEmitCtx(emitCtx);
  const ceWrap = wrapRevocableContextEngine(opts.contextEngine);
  const wrappedEmitCtx = emitWrap.ctx;
  const wrappedCe = ceWrap.ce;

  // async subagent 回报兜底装配：仅 main && derivation='subagent' 且两依赖齐备
  //   （顶层/squad/forked 旁路/测试缺省 → undefined，lifecycle 全链路 noop）。
  //   baseline 此刻快照（=run 起点，本 run 的投递 mark 全部晚于它）；
  //   carried=takePending 出上一 run tool_pending stash 的跨 run 未决请求。
  const replySettle =
    isMain && kind.isSubagent && opts.a2aReplyTracker && opts.deliverToFn
      ? {
          deliverTo: opts.deliverToFn,
          tracker: opts.a2aReplyTracker,
          baseline: opts.a2aReplyTracker.deliveryEpoch(),
          carried: opts.a2aReplyTracker.takePending(sid),
        }
      : undefined;
  const lifecycle = new RunLifecyclePort({ config: opts.config, store: opts.store, runId, profile, replySettle });

  // —— EOS stop seq/eosStripper（main squad 专属）——
  const isSquad = kind.role === 'squad';
  const stopSequences: string[] | undefined = isMain && isSquad ? [EOS_STOP_TOKEN] : undefined;
  const eosStripper = isMain && isSquad ? stripEosToken : undefined;

  // —— 旁路 run wireInitState（ingest reminder + userMessage 到 in_memory store）——
  let wireInitState: (() => Promise<LoopState>) | undefined;
  if (!isMain) {
    const userMessage = opts.userMessage!;
    const reminder = injectSideRunReminder({
      allowedTools,
      runKind,
      sessionId: sid,
    });
    const providedSnapshot = opts.snapshot;
    wireInitState = async (): Promise<LoopState> => {
      // snapshot 必填（sideRun opts 必填）——直接复用作 parentSnapshot（零重建，cache 前缀不破）
      const snapshot = providedSnapshot!;
      await opts.contextEngine.ingest(opts.config, [reminder, userMessage], scopeId, false, { runId });
      return {
        ingestUpTo: null,
        llmUpTo: null,
        snapshot,
        // 固定 parentSnapshot：旁路 builder 读 ctx.prevSnapshot.messages 整 run 不变
        //   （不能用每轮漂移的 state.snapshot，否则多轮会重复 reminder/userMessage）。
        parentSnapshot: snapshot,
        step: 0,
        done: false,
        llmErrorState: {},
      };
    };
  }

  const pluginManager: PluginManager | null = opts.contextEngine.getPluginManager();

  // —— wirePeekTriggerMessages（main=drain 前 peek inbox；旁路=triggerMessage 单值）——
  let wirePeekTriggerMessages: (() => Message[]) | undefined;
  if (isMain) {
    wirePeekTriggerMessages = (): Message[] => {
      return opts.inbox!.peek(sid)
        .filter((e) => e.kind === 'message')
        .map((e) => (e.kind === 'message' ? e.message : null))
        .filter((m): m is Message => m !== null);
    };
  } else if (opts.triggerMessage) {
    const triggerMessage = opts.triggerMessage;
    wirePeekTriggerMessages = (): Message[] => [triggerMessage];
  }

  // —— RunSpec（profile 字段 → spec 字段单源派生；wire extras 按 persists/touchesStateMachine/drainMode 设）——
  const spec: RunSpec = {
    sessionId: sid,
    runId,
    runKind,
    scopeId,
    controller,
    message: isMain ? undefined : opts.userMessage,
    toolDefinitions,
    allowedTools,
    maxIter,
    config: opts.config,
    backgroundPath: profile.runShape.backgroundPath,
    drainMode: profile.runShape.drainMode,
    stopSequences,
    eosStripper,
    lifecycle,
    emit,
    observability: obs,
    wireContextEngine: wrappedCe,
    wireInitState,
    wireToolEngine: opts.toolEngine,
    wireEmitCtx: wrappedEmitCtx,
    wirePeekTriggerMessages,
    wireStore: profile.runShape.persistsRun ? opts.store : undefined,
    wireInbox: isMain ? opts.inbox : undefined,
    wireStateMachine: profile.runShape.touchesStateMachine ? opts.contextEngine.getStateMachine() : undefined,
    wireTaskLock: isMain ? opts.contextEngine.getTaskLock() : undefined,
    pluginManager,
  };

  // —— 组合 revoke：emitCtx + ce 两层吊销；main + forked 都装，forked 永不调 revoke（无副作用）——
  const revokeFn = (): void => {
    emitWrap.revoke.revoke();
    ceWrap.revoke.revoke();
  };
  const loop = new RunLoopHandle(runKind, spec, !isMain, revokeFn);
  return { spec, loop };
}
