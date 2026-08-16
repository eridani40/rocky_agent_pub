/**
 * loop-runtime-config.ts — ReAct loop 运行中 session 配置实时刷新
 * [v0.0.351 T1]
 * 参考: specs/tech/version_logs/v0.0.351/chat-input-config-realtime/change_plan.md §2 D1-D6
 *
 * 职责：
 * - 每个 iteration 边界（prepareStage 后、callLLM 前）按 session 最新值刷新可变配置。
 * - 只刷新 UI 已暴露且用户可改的三件套：providerId + modelId、effort、approvalMode。
 * - 模型变化时重建 LlmClient；未变化时保持 client 引用稳定。
 * - 刷新失败（session 不存在/解析错误）时 log warn 并继续使用旧 config，不中断 loop。
 * - 仅主 run（spec.runKind === 'main'）刷新；forked/subagent run 保持启动快照。
 *
 * 注意：本函数**不重跑**完整的 buildSessionConfigFromDeps，不重建 skills/tools/workdir/systemPrompt。
 */
import type { AppConfigService } from '../config/app-config-service';
import type { PluginManager } from '../plugin/plugin-manager';
import { buildLlmClient } from '../llm-client-factory';
import type { SessionStore } from './session-store';
import type { RunSpec } from './loop-ports';

/** refreshRuntimeConfig 所需依赖 */
export interface RuntimeConfigRefreshDeps {
  /** 读取 session 最新字段 */
  store: SessionStore;
  /** buildLlmClient 需要 */
  appConfig: AppConfigService;
  /** buildLlmClient 需要 */
  pluginManager: PluginManager;
}

/**
 * 在 iteration 边界刷新 RunSpec.config。
 * @param spec 当前 run 规格（含 config）
 * @param deps 刷新依赖
 * @returns void（同步/异步副作用仅更新 spec.config）
 */
export async function refreshRuntimeConfig(
  spec: RunSpec,
  deps: RuntimeConfigRefreshDeps,
): Promise<void> {
  // [D6] 仅主 run 实时刷新；forked/subagent 保持启动快照
  if (spec.runKind !== 'main') return;

  const cfg = spec.config;
  try {
    const session = await deps.store.getSession(spec.sessionId);
    if (!session) {
      console.warn(
        `[refreshRuntimeConfig] session ${spec.sessionId} not found; keeping existing runtime config`,
      );
      return;
    }

    const nextProviderId = session.providerId;
    const nextModelId = session.modelId;
    const nextEffort = session.effort;
    const nextApprovalMode = session.approvalMode;

    // [D3] providerId + modelId 任一变化 → 重建 client；否则保持引用稳定
    if (
      nextProviderId &&
      nextModelId &&
      (nextProviderId !== cfg.providerId || nextModelId !== cfg.modelId)
    ) {
      cfg.client = buildLlmClient(
        nextProviderId,
        nextModelId,
        deps.appConfig,
        deps.pluginManager,
      );
      cfg.providerId = nextProviderId;
      cfg.modelId = nextModelId;
    }

    // [D2] 纯值直接覆盖（undefined 也覆盖，表示用户清空/恢复默认）
    cfg.effort = nextEffort;
    cfg.approvalMode = nextApprovalMode;
  } catch (err) {
    // [D6/D8] 非致命错误吞掉，保持旧 config，不中断 loop
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[refreshRuntimeConfig] refresh failed: ${message}; keeping existing runtime config`);
  }
}
