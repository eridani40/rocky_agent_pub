/**
 * executeSideRun — 旁路 run（runKind=summary/consolidate）启动编排
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md §2（sideRun 入口）
 *       specs/tech/agent/session/[P0]session_type_profile.md（profile 驱动装配）
 *
 * 从 AgentManagerImpl 拆出（文件体量治理）：旁路 run 的并发检查 + controller 创建 +
 * snapshot 克隆 + effectiveKind 派生 + buildRunDeps 装配 + startRunAndTrack 启动。
 * 旁路 run 不碰 session 五态机（靠 agentRuns map 拒并发），配置全部经 profile 驱动。
 */
import { ulid } from '../config/ulid';
import type { Message, ContextWindowUsage } from '../message/types';
import type { ContextEngine } from './context-engine';
import type { SessionConfig, ContextSnapshot } from './context-types';
import type { SessionStore } from './session-store';
import type { ReplayableEventBus } from './event-bus';
import type { ToolExecutionEngine } from '../tools/engine';
import type { ObservabilityAdapter } from '../observability/adapter';
import type { AgentRun, AbortControllerHandle } from './agent-interface';
import type { LoopHandle } from './run-loop-handle';
import type { RunKind } from '@app/shared';
import { SessionKind } from '@app/shared';
import type { SessionTypePolicy } from './session-type-policy';
import { ChildProcessRegistry } from '../tools/child-process-registry';
import { buildRunDeps } from './build-run-deps';
import { runMapKey, startRunAndTrack } from './agent-run-registry';

/** 旁路 run 环境依赖（AgentManager 持有的句柄 + 三 map） */
export interface SideRunEnv {
  bus: ReplayableEventBus;
  store: SessionStore;
  contextEngine: ContextEngine;
  toolEngine: ToolExecutionEngine;
  /** policy 单源（buildRunDeps 派生 allowedTools/maxIter/profile 字段用） */
  sessionTypePolicy: SessionTypePolicy;
  /** manager 级默认 observability（config/opts 未带时兜底注入） */
  defaultObservability: ObservabilityAdapter;
  agentRuns: Map<string, AgentRun>;
  abortControllers: Map<string, AbortControllerHandle>;
  loops: Map<string, LoopHandle>;
}

/** 旁路 run 入参（caller = compact / consolidate runner 回调） */
export interface SideRunOptions {
  sessionId: string;
  config: SessionConfig;
  /** 旁路 runKind（'summary' | 'consolidate'） */
  runKind: RunKind;
  /** snapshot（必填：生产三路径 caller 均非空——自动 compact=main snapshot 深拷贝 /
   *  手动 compact=ContextEngine.compact 先 assemble 产 / consolidate=ctx.snapshot 复用） */
  snapshot: ContextSnapshot;
  userMessage: Message;
  observability?: ObservabilityAdapter;
  /**
   * 触发点 message（仅取 id 用于 wirePeekTriggerMessages → 旁路 trace metadata）。
   * caller 从 triggerMessageId 反查 message 或直接构造 synthetic。
   * 仅用于 trace meta，不进旁路 buffer（buffer 由 wireInitState 显式 ingest reminder + userMessage）。
   */
  triggerMessage?: Message;
  /** 触发时 context window 用量（写入旁路 trace metadata.triggerUsage） */
  triggerUsage?: ContextWindowUsage;
}

/**
 * 执行旁路 run：并发检查 → controller → snapshot 克隆 → buildRunDeps 装配 → startRunAndTrack。
 *
 * @param env  manager 持有的依赖句柄 + 三 map
 * @param opts 见 SideRunOptions
 * @returns AgentRun（shell 构造 + 三 map 注册 + cleanup 全在 startRunAndTrack 内）
 * @throws 同 (sid, runKind) 已有 in-flight run 时抛 already_running_in_this_mode
 */
export async function executeSideRun(env: SideRunEnv, opts: SideRunOptions): Promise<AgentRun> {
  const sid = opts.sessionId;
  const runKind = opts.runKind;
  const rk = runMapKey(sid, runKind);
  // 同 (sid, runKind) 并发检查（agent_interface §6；旁路不参与五态机，靠 map 拒并发）
  if (env.agentRuns.has(rk)) throw new Error(`already_running_in_this_mode: ${rk}`);

  // 旁路 run 同样挂 run 级 ChildProcessRegistry
  const newRunId = ulid();
  const controller: AbortControllerHandle = { runId: newRunId, aborted: false, childRegistry: new ChildProcessRegistry() };

  const configWithObs: SessionConfig =
    opts.config.observability !== undefined
      ? opts.config
      : { ...opts.config, observability: opts.observability ?? env.defaultObservability };

  // 旁路入口 deep clone（双保险防篡改）：caller 可能传共享 snapshot（两 sibling 共用 clone），
  // 本入口对每路旁路 run 单独再 clone 一次，确保旁路内部 assemble 不污染 caller snapshot。
  const snapshotClone = structuredClone(opts.snapshot) as ContextSnapshot;

  // config.kind 兜底：生产 caller（compact/consolidate runner 经 resolveConfigBySid）必带 kind；
  // tier2 三 caller（consolidation-tier2/session-memory|global-memory|global-skill）构造的
  // SessionConfig 无 kind（旁路整理 run 不属任何业务会话类型）——兜底 playground-rocky:parent
  // （对应 consolidate profile toolBound=[skill_manage,memory_manage]，与 tier2 snapshot.tools 交集正确）。
  const parentKind = opts.config.kind
    ?? new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent' });
  const effectiveKind = new SessionKind({
    biz: parentKind.biz,
    role: parentKind.role,
    derivation: parentKind.derivation,
    runKind,
  });
  const { spec, loop } = buildRunDeps({
    config: configWithObs,
    bus: env.bus,
    store: env.store,
    contextEngine: env.contextEngine,
    toolEngine: env.toolEngine,
    controller,
    runId: newRunId,
    kind: effectiveKind,
    sessionTypePolicy: env.sessionTypePolicy,
    snapshot: snapshotClone,
    userMessage: opts.userMessage,
    emit: true,
    observability: opts.observability ?? env.defaultObservability,
    triggerMessage: opts.triggerMessage,
    triggerUsage: opts.triggerUsage,
  });
  return startRunAndTrack(
    { agentRuns: env.agentRuns, abortControllers: env.abortControllers, loops: env.loops },
    spec,
    loop,
  );
}
