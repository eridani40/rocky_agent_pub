/**
 * consolidateGlobalMemory — 全局 memory 域整理（tier2 spec §4 §5.1-§5.3）
 * 参考: specs/tech/agent/memory/[P0]consolidation_tier2.md
 *
 * 预取 global memory 全量 entry（includeArchived:true，§5.3 全局块上下文供给约定；
 * 介质 = `<dataDir>/memory/` per-entry dir store），
 * 过滤 source='agent' → 拼 task message → sideRun（虚拟哨兵 sessionId，白名单仅 memory_manage）。
 */
import { globalMemoryDir, listEntries } from '../../memory/memory-dir-store';
import { memoryManageTool } from '../../tools/memory-manage';
import { buildLlmClient } from '../../llm-client-factory';
import { ulid } from '../../config/ulid';
import {
  ConsolidationTier2PromptHandler,
} from '../../prompts/handlers/consolidation-tier2-handler';
import { formatMemoryEntry } from './format-memory-entry';
import type { Message } from '../../message/types';
import type { SessionConfig, ContextSnapshot } from '../context-types';
import type { ConsolidationTier2Deps, BlockResult } from './runner';
import type { ResolvedConsolidationModel } from './model-resolve';

/** 全局 memory 域容量上限（tier2 spec §4） */
const GLOBAL_MEMORY_CAPACITY_LIMIT = 100;

/** sideRun maxIter（同 tier1 fork-2 惯例：允许多轮工具调用落盘） */
const MAX_ITER = 10;

/** 全局块用的虚拟哨兵 sessionId（tier2 spec §5.2：memory_manage global scope 不读 sessionId） */
const SENTINEL_SESSION_ID = 'consolidation:global';

export async function consolidateGlobalMemory(
  deps: ConsolidationTier2Deps,
  model: ResolvedConsolidationModel,
): Promise<BlockResult> {
  // includeArchived:true（tier2 §5.3：全局块上下文供给含已归档条目，供 LLM 感知避免重复归档）
  const allEntries = listEntries(globalMemoryDir(deps.dataDir), { includeArchived: true });
  const agentEntries = allEntries.filter((e) => e.source === 'agent');
  const activeCount = agentEntries.filter((e) => !e.archived).length;

  const entriesList =
    agentEntries.length > 0
      ? agentEntries.map(formatMemoryEntry).join('\n')
      : '(no agent-sourced memory entries)';

  const taskText = new ConsolidationTier2PromptHandler().build({
    vars: {
      domain: 'memory',
      entries_list: entriesList,
      capacity_limit: `${activeCount} / ${GLOBAL_MEMORY_CAPACITY_LIMIT}`,
      // scope 必填后必须显式传 scope（global-memory 块落 global 介质）
      write_scope: 'global',
    },
  }).content;

  const userMessage: Message = {
    id: ulid(),
    sessionId: SENTINEL_SESSION_ID,
    role: 'user',
    content: [{ type: 'text', text: taskText }],
  };

  const config: SessionConfig = {
    sessionId: SENTINEL_SESSION_ID,
    systemPrompt: '', // 未使用（forked 走 snapshot.system）
    client: buildLlmClient(model.providerId, model.modelId, deps.appConfig, deps.pluginManager),
    modelId: model.modelId,
    providerId: model.providerId,
    dataDir: deps.dataDir, // memory_manage global scope 落 <dataDir>/memory/（dir store）
    appConfig: deps.appConfig,
    tools: [memoryManageTool],
  };

  const snapshot: ContextSnapshot = {
    system: {
      id: ulid(),
      sessionId: SENTINEL_SESSION_ID,
      role: 'system',
      content: [{ type: 'text', text: ConsolidationTier2PromptHandler.SYSTEM_PROMPT }],
    },
    messages: [],
    inputCharCount: 0,
    contextWindowUsage: {
      systemTokens: 0, messageTokens: 0, toolTokens: 0,
      totalTokens: 0, maxOutputTokens: 0, tokenLimit: 0, remainingTokens: 0,
    },
    summary: null,
    tools: [memoryManageTool.definition],
  };

  const run = await deps.agentManager.sideRun({
    sessionId: SENTINEL_SESSION_ID,
    config,
    // v0.0.204 T2-B4：runKind 扁平闭合枚举；tier-2 子类型（global_memory / global_skill / session_memory）
    //   统一收敛到 'consolidate'。原 per-tier toolWhitelist 单工具限制（memory_manage / skill_manage）
    //   转由 consolidate profile toolBound=[skill_manage,memory_manage] 整体供——
    //   tier-2 LLM 在 both-tools 范围内自选（轻微过权但功能等价；后续波可拆 profile 精细化）。
    runKind: 'consolidate',
    snapshot,
    userMessage,
    observability: deps.observability,
  });
  const result = await run.promise;
  return ConsolidationTier2PromptHandler.parseResult(result.answer);
}
