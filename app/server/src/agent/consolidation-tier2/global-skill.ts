/**
 * consolidateGlobalSkills — 全局 skill 域整理（tier2 spec §4 §5.1-§5.3）
 * 参考: specs/tech/agent/memory/[P0]consolidation_tier2.md
 *
 * 预取 app 层（workspaceDir=undefined 跳过 session/workspace 层扫描）全量 skill entry，
 * 过滤 source='agent' → 拼 task message → sideRun（虚拟哨兵 sessionId，白名单仅 skill_manage）。
 * 不走 buildSessionConfigFromDeps，故天然无 skill catalog 注入（§5.1 无注入约束）。
 */
import { SkillResolver } from '../../skills/resolver';
import { SkillEnabledStore } from '../../skills/enabled-store';
import { skillManageTool } from '../../tools/skill-manage';
import { buildLlmClient } from '../../llm-client-factory';
import { ulid } from '../../config/ulid';
import {
  ConsolidationTier2PromptHandler,
} from '../../prompts/handlers/consolidation-tier2-handler';
import type { Message } from '../../message/types';
import type { SkillEntry } from '../../skills/types';
import type { SessionConfig, ContextSnapshot } from '../context-types';
import type { ConsolidationTier2Deps, BlockResult } from './runner';
import type { ResolvedConsolidationModel } from './model-resolve';

/** 全局 skill 域容量上限（tier2 spec §4） */
const GLOBAL_SKILL_CAPACITY_LIMIT = 100;

/** sideRun maxIter（同 tier1 fork-2 惯例：允许多轮工具调用落盘） */
const MAX_ITER = 10;

/** 全局块用的虚拟哨兵 sessionId（tier2 spec §5.2：skill_manage global scope 不读 sessionId） */
const SENTINEL_SESSION_ID = 'consolidation:global';

/** 序列化单条 agent-sourced skill entry（Phase 1 Orient 展示行） */
function formatEntry(e: SkillEntry): string {
  return `- ${e.name} | enabled=${e.enabled} | evolvable=${e.evolvable === true} | updated=${e.updatedAt ?? 'unknown'}\n  ${e.description}`;
}

export async function consolidateGlobalSkills(
  deps: ConsolidationTier2Deps,
  model: ResolvedConsolidationModel,
): Promise<BlockResult> {
  const enabledStore = new SkillEnabledStore(deps.appConfig);
  // workspaceDir 传 undefined 跳过 session/workspace 层扫描，只取 app 层（tier2 §4）
  const catalog = SkillResolver.resolveAll(deps.dataDir, undefined, enabledStore);
  const agentEntries = catalog.entries.filter((e) => e.source === 'agent');
  const activeCount = agentEntries.filter((e) => e.enabled).length;

  const entriesList =
    agentEntries.length > 0
      ? agentEntries.map(formatEntry).join('\n')
      : '(no agent-sourced skill entries)';

  const taskText = new ConsolidationTier2PromptHandler().build({
    vars: {
      domain: 'skill',
      entries_list: entriesList,
      capacity_limit: `${activeCount} / ${GLOBAL_SKILL_CAPACITY_LIMIT}`,
      // scope 必填后必须显式传 scope（global-skill 块落 global/app 介质）
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
    dataDir: deps.dataDir, // skill_manage 读 ctx.config.dataDir
    tools: [skillManageTool],
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
    tools: [skillManageTool.definition],
  };

  const run = await deps.agentManager.sideRun({
    sessionId: SENTINEL_SESSION_ID,
    config,
    // v0.0.204 T2-B4：runKind 扁平闭合枚举；tier-2 子类型统一 'consolidate'（见 global-memory 同注）
    runKind: 'consolidate',
    snapshot,
    userMessage,
    observability: deps.observability,
  });
  const result = await run.promise;
  return ConsolidationTier2PromptHandler.parseResult(result.answer);
}
