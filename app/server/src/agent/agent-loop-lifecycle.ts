/**
 * AgentLoop 生命周期辅助方法（agent-loop 拆分模块）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_eager_drain.md §4
 *
 * 职责：把 runLoop 周边的小辅助方法（initState / ensureRunCreated / maxIter / persistRun /
 * ingestAndAssemble）从主类抽出，让 agent-loop.ts 主类聚焦 runLoop 编排 + ② ③ stage。
 *
 * 设计：纯函数 + 注入依赖（store / contextEngine / bus / config / runId / runKind / obs），
 * 不依赖 AgentLoop 实例字段（除 obs 的 setSystem 调用，由 caller 透传）。
 */
import { firstText } from './assemble-pipeline';
import type { MessageInput } from '../message/types';
import type { ContextSnapshot, SessionConfig } from './context-types';
import type { RunKind } from '../../../shared/src/types/session-kind';
import type { ContextEngine } from './context-engine';
import type { SessionStore } from './session-store';
import type { ReplayableEventBus } from './event-bus';
import type { RunState } from './agent-loop-helpers';
import { groupKeyForRunKind } from './agent-interface';
import type { LoopObservability } from './agent-loop-observability';

/**
 * 顶层/studio/squad 会话的 maxIter 默认。
 * 唯一消费点 = session-config.ts 的 buildSessionConfigFromDeps
 *  （`appConfig.get('agent','maxIterations') ?? DEFAULT_MAX_ITERATIONS`）。
 * maxIterOf 不再兜底它——兜底是死代码（buildSessionConfigFromDeps 必填 config.maxIterations）。
 */
export const DEFAULT_MAX_ITERATIONS = 200;

/**
 * main 链路 maxIter：直接读 config.maxIterations。
 * config.maxIterations 由 buildSessionConfigFromDeps 总是赋值，此处 ! 断言非空——
 * 不兜底默认值（兜底是死代码：永不触发，曾致 200/25 双常量不一致事故）。
 */
export function maxIterOf(config: SessionConfig): number {
  return config.maxIterations!;
}

/** 初始化 RunState + 游标（newest：避免历史消息触发 LLM） */
export async function initState(store: SessionStore, config: SessionConfig): Promise<RunState> {
  const existingPage = await store.getMessages(config.sessionId, { limit: 1 });
  // store 返回升序末尾= newest；limit:1 → items[0] 即最新一条
  const lastExisting = existingPage.items[0];
  const lastId = lastExisting?.id ?? null;
  return {
    ingestUpTo: lastId,
    llmUpTo: lastId,
    snapshot: null,
    step: 0,
    done: false,
    // [v0.0.25 task 5 gap 1] 初始化空 LlmErrorState（跨 iteration overlay 容器）
    llmErrorState: {},
  };
}

/** run 记录 upsert（handler 层可能预创建；getRun 不存在才 createRun） */
export async function ensureRunCreated(store: SessionStore, config: SessionConfig, runId: string): Promise<void> {
  const sid = config.sessionId;
  if (!(await store.getRun(sid, runId))) {
    await store.createRun({ id: runId, sessionId: sid, status: 'running' });
  }
}

/**
 * ingest 一批新消息 → clearReplay → assemble → 更新 snapshot（消除 3 处重复）。
 * 不变量：调用方保证 cursor 推进后 llmUpTo ≤ ingestUpTo。compact 判定不在此（② 独有）。
 *
 * [v0.0.13 M1] assemble 后推送实际 system 给 observability（snapshot.system 首个 text block）。
 * [v0.0.52 P1-2] scopeId 透传：ingest/assemble 都按 scopeId 路由 impl 链（修旧 helper 残留：
 *   原先 ingest(config)/assemble(config) 既没传 scopeId 也没传 prevSnapshot）。
 * [v0.0.52 P0-1] prevSnapshot 透传：传 state.snapshot 激活 base_builder append 分支（prompt cache 命中）。
 */
export async function ingestAndAssemble(
  contextEngine: ContextEngine,
  bus: ReplayableEventBus,
  obs: LoopObservability,
  config: SessionConfig,
  runKind: RunKind,
  runId: string,
  scopeId: string,
  newMessages: MessageInput[],
  state: RunState,
  cursor: 'ingestUpTo' | 'llmUpTo',
): Promise<ContextSnapshot> {
  await contextEngine.ingest(config, newMessages, scopeId);
  state[cursor] = newMessages[newMessages.length - 1]!.id;
  bus.clearReplay(groupKeyForRunKind(config.sessionId, runKind));
  // [v0.0.66 §2.6] 删 buffer 参数（统一走 prevSnapshot + EP-selected store）
  state.snapshot = await contextEngine.assemble(config, scopeId, state.snapshot ?? null);
  obs.setSystem(firstText(state.snapshot.system));
  return state.snapshot;
}

/**
 * loop 结束持久化 run（status/stopReason/endedAt + contextWindowUsage）
 *
 * [v0.0.15 BUG-004] best-effort 容错：getRun 返 null（loop 已不在 store —
 * 测试 teardown 销毁 / cleanupRun 已移除 / 并发 abort 已清）时不抛，跳过 update。
 * 理由：persistRun 是 loop 收尾的 best-effort 副作用，run 记录已不存在时再 update
 * 无意义；原本 throw 会变成 Unhandled Rejection（loop promise 已 settle）。
 */
export async function persistRun(
  store: SessionStore,
  config: SessionConfig,
  runId: string,
  state: RunState,
): Promise<void> {
  const sid = config.sessionId;
  const cw = state.snapshot?.contextWindowUsage;
  // 先查 run 是否还在 store；不在则 warn + 跳过（避免 updateRun throw RunNotFoundError）
  const existing = await store.getRun(sid, runId);
  if (!existing) {
    // run 已不存在（teardown / cleanupRun / 并发 abort）：best-effort 跳过，不抛
    return;
  }
  await store.updateRun(sid, runId, {
    status: state.stopReason === 'error' ? 'failed' : 'completed',
    stopReason: state.stopReason,
    // [v0.0.25 rev2] RunErrorInfo（仅 stopReason="error" 时 state.error 被填；写 Run/RunRecord）
    ...(state.stopReason === 'error' && state.error ? { error: state.error } : {}),
    endedAt: new Date().toISOString(),
    ...(cw ? { contextWindowUsage: cw } : {}),
  });
}
