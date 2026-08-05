/**
 * runConsolidationTier2 — 二级整理（天级离线「编辑」）主编排入口
 * 参考: specs/tech/agent/memory/[P0]consolidation_tier2.md §3 §5
 *       specs/tech/scheduling/[P1]consolidation_job.md §4 §7
 *
 * 自洽的"整理一次"业务函数：第一步做模型反查 + 未配置 fast-finish 判定；模型可用后严格
 * 串行跑三段工作——全局 skill → 全局 memory → 各 session memory（session 间也逐个串行，
 * 不 Promise.all）。被两条调用方共同复用而不重复 skip 逻辑：① ConsolidationJobHandler.fire()
 * （真实调度，Task 2）；② handleTestConsolidationRun（test-only 同步触发，Task 2）。两条路径
 * 唯一差异在"要不要碰 lastFiredAt/lastResult"（调度层状态），那部分留在各自调用方，不在本函数。
 */
import type { AppConfigService } from '../../config/app-config-service';
import type { PluginManager } from '../../plugin/plugin-manager';
import type { AgentManagerImpl } from '../agent-manager';
import type { SessionStore } from '../session-store';
import type { Session } from '../session-store-types';
import type { ObservabilityAdapter } from '../../observability/adapter';
import { resolveConsolidationModel } from './model-resolve';
import { consolidateGlobalSkills } from './global-skill';
import { consolidateGlobalMemory } from './global-memory';
import { consolidateSessionMemory, type SessionMemoryOutcome } from './session-memory';

/** 一天的毫秒数（窗口起点缺省回退：now - 24h，tier2 spec §3.1） */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * runner 依赖（两条调用方共同装配）。刻意不含 lastFiredAt/lastResult 等调度层状态——
 * 那些字段的读写归调用方（ConsolidationJobHandler / handleTestConsolidationRun）。
 */
export interface ConsolidationTier2Deps {
  appConfig: AppConfigService;
  pluginManager: PluginManager;
  agentManager: AgentManagerImpl;
  sessionStore: SessionStore;
  /** app 数据根（绝对路径） */
  dataDir: string;
  observability?: ObservabilityAdapter;
  /**
   * "今天"窗口起点（ISO；tier2 spec §3.1）。调度路径传 `job.lastFiredAt`；
   * test-only 端点不经过 job（无 lastFiredAt 可传），缺省 → 回退 now-24h。
   */
  windowStart?: string;
}

/** 单工作块结果（全局 skill / 全局 memory / 单 session memory 共用形态） */
export interface BlockResult {
  /** 由整理 agent 最终回答的 `<result>` 标签解析（tier2 spec §6 Output 约定） */
  action: string;
  detail: string;
}

/** 单 session 整理结果条目（api change_log §响应 sessions[] 形态） */
export interface SessionOutcomeEntry {
  sessionId: string;
  result: SessionMemoryOutcome;
}

/** runConsolidationTier2 完整返回（对齐 api/version_logs 的 test-only 端点响应契约） */
export interface ConsolidationTier2Result {
  globalSkill: BlockResult | null;
  globalMemory: BlockResult | null;
  sessions: SessionOutcomeEntry[];
  summary: string;
  /** 非 null = 本次整体跳过的原因（目前唯一取值 'model_not_configured'） */
  skippedReason: string | null;
}

/**
 * 主编排：模型反查 → 未配置 fast finish；否则三段严格串行（不 Promise.all）。
 *
 * 失败隔离（比 change_plan 字面更保守一档，见完成报告偏离说明）：单个 session 失败按
 * change_plan 要求 try/catch 吞掉继续下一个（best-effort）；两个全局块同样包一层防御式
 * try/catch——一个块抛异常不阻塞另一块或 session 遍历（"到点必执行一次"的精神延伸到块级）。
 */
export async function runConsolidationTier2(
  deps: ConsolidationTier2Deps,
): Promise<ConsolidationTier2Result> {
  const model = resolveConsolidationModel(deps.appConfig);
  if (!model) {
    return {
      globalSkill: null,
      globalMemory: null,
      sessions: [],
      summary: '模型未配置，跳过本次整理',
      skippedReason: 'model_not_configured',
    };
  }

  const windowStart = deps.windowStart ?? new Date(Date.now() - DAY_MS).toISOString();

  // 三段严格串行：await 完成上一段才开始下一段（MUST NOT Promise.all）
  const globalSkill = await runBlockSafely(() => consolidateGlobalSkills(deps, model));
  const globalMemory = await runBlockSafely(() => consolidateGlobalMemory(deps, model));

  let allSessions: Session[] = [];
  let sessionListError: string | null = null;
  try {
    allSessions = await deps.sessionStore.listSessions();
  } catch (err) {
    // 灾难性失败（连 session 列表都拿不到）：不阻塞已完成的两个全局块，sessions 留空——
    // 但不可静默吞掉（错误吞没=Major）：console.warn 留痕 + 计入 summary，供 lastResult/
    // 状态端点可见，让运维/调用方（ConsolidationJobHandler）有机会观察到这一异常路径。
    sessionListError = err instanceof Error ? err.message : String(err);
    console.warn('[consolidation-tier2] sessionStore.listSessions failed (suppressed):', sessionListError);
    allSessions = [];
  }

  const sessions: SessionOutcomeEntry[] = [];
  for (const session of allSessions) {
    // session 间也逐个串行（同一 for...of + await，不 Promise.all）
    try {
      const result = await consolidateSessionMemory(deps, model, session, windowStart);
      sessions.push({ sessionId: session.id, result });
    } catch (err) {
      // 单个 session 失败 try/catch 吞掉继续下一个（best-effort，change_plan 硬性要求）
      const msg = err instanceof Error ? err.message : String(err);
      sessions.push({ sessionId: session.id, result: { action: 'error', detail: msg } });
    }
  }

  return {
    globalSkill,
    globalMemory,
    sessions,
    summary: buildSummary(globalSkill, globalMemory, sessions, sessionListError),
    skippedReason: null,
  };
}

/** 全局块防御式包裹：异常不抛出，转成 {action:'error'} 结果，不阻塞后续块 */
async function runBlockSafely(fn: () => Promise<BlockResult>): Promise<BlockResult> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'error', detail: msg };
  }
}

/** 汇总一句话 summary（供 lastResult / test-only 响应展示） */
function buildSummary(
  globalSkill: BlockResult,
  globalMemory: BlockResult,
  sessions: SessionOutcomeEntry[],
  sessionListError: string | null,
): string {
  const skipped = sessions.filter(
    (s) => s.result === 'skipped_no_activity' || s.result === 'skipped_empty_memory',
  ).length;
  const processed = sessions.length - skipped;
  const sessionListErrorNote = sessionListError ? ` / session 列表读取失败: ${sessionListError}` : '';
  return (
    `全局 skill: ${globalSkill.action}（${globalSkill.detail}）/ ` +
    `全局 memory: ${globalMemory.action}（${globalMemory.detail}）/ ` +
    `${sessions.length} 个 session 中 ${processed} 个已处理（${skipped} 跳过）${sessionListErrorNote}`
  );
}
