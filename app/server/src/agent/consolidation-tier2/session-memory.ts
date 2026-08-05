/**
 * consolidateSessionMemory — 单 session memory 整理 + 双重 skip 判定（tier2 spec §3 §4 §5.2 §5.3）
 * 参考: specs/tech/agent/memory/[P0]consolidation_tier2.md
 *
 * Skip A（无新对话）/ Skip B（memory 全空）均在调用 LLM 前用代码完成判定——零 LLM 调用；
 * 两者都过了才构造 task message + sideRun（真实 sessionId，白名单仅 memory_manage）。
 */
import { join } from 'node:path';
import { listEntries, wsMemoryDir } from '../../memory/memory-dir-store';
import { memoryManageTool } from '../../tools/memory-manage';
import { buildLlmClient } from '../../llm-client-factory';
import { ulid } from '../../config/ulid';
import {
  ConsolidationTier2PromptHandler,
} from '../../prompts/handlers/consolidation-tier2-handler';
import { formatMemoryEntry } from './format-memory-entry';
import type { Message } from '../../message/types';
import type { Session } from '../session-store-types';
import type { SessionConfig, ContextSnapshot } from '../context-types';
import type { ConsolidationTier2Deps, BlockResult } from './runner';
import type { ResolvedConsolidationModel } from './model-resolve';

/** 单 session memory 容量上限（tier2 spec §4） */
const SESSION_MEMORY_CAPACITY_LIMIT = 30;

/** sideRun maxIter（同 tier1 fork-2 惯例：允许多轮工具调用落盘） */
const MAX_ITER = 10;

/** consolidateSessionMemory 返回形态：BlockResult 或两种独立 skip 原因（api change_log §响应契约） */
export type SessionMemoryOutcome = BlockResult | 'skipped_no_activity' | 'skipped_empty_memory';

/**
 * 单 session 整理：Skip A（本次窗口内无新对话）→ Skip B（memory 全空）→（否则）sideRun。
 * 两个 skip 分支均在调用 LLM 前用代码判定完成——零 LLM 调用（tier2 §3 硬性要求）。
 */
export async function consolidateSessionMemory(
  deps: ConsolidationTier2Deps,
  model: ResolvedConsolidationModel,
  session: Session,
  windowStart: string,
): Promise<SessionMemoryOutcome> {
  // Skip A：本次窗口内无新对话（session.updatedAt 是消息驱动 CAS 转换的代理指标，§3 heuristic）
  if (session.updatedAt < windowStart) return 'skipped_no_activity';

  // session ws 解析（memory 介质 = <ws>/.rocky/memory/ per-entry dir store）：
  //   session.workspaceDir 缺省回退 <dataDir>/workspace（与 session-config 同规则）
  const sessionWsDir = session.workspaceDir && session.workspaceDir.trim()
    ? session.workspaceDir
    : join(deps.dataDir, 'workspace');
  const memoryDir = wsMemoryDir(sessionWsDir);

  // Skip B：有新对话但 session memory 全空（includeArchived:true 原始检查，§3；零 LLM 调用）
  const rawEntries = listEntries(memoryDir, { includeArchived: true });
  if (rawEntries.length === 0) return 'skipped_empty_memory';

  // Context 供给：includeArchived:false 全文（§5.3），仅展示 agent 来源（tier2 只处理 agent 噪声，§4）
  const activeEntries = listEntries(memoryDir, { includeArchived: false });
  const agentEntries = activeEntries.filter((e) => e.source === 'agent');
  const activeCount = agentEntries.length;

  const noEntriesText = '(no agent-sourced memory entries in this session)';
  const entriesList = agentEntries.length > 0 ? agentEntries.map(formatMemoryEntry).join('\n') : noEntriesText;
  const sessionMemoryFull =
    agentEntries.length > 0
      ? agentEntries.map((e) => `## ${e.name}\n${e.body}`).join('\n\n')
      : noEntriesText;

  const summaryInfo = await deps.sessionStore.getSummary(session.id).catch(() => null);
  const sessionSummary = summaryInfo?.content ?? '(no summary available)';

  const taskText = new ConsolidationTier2PromptHandler().build({
    vars: {
      domain: 'memory',
      entries_list: entriesList,
      capacity_limit: `${activeCount} / ${SESSION_MEMORY_CAPACITY_LIMIT}`,
      session_memory_full: sessionMemoryFull,
      session_summary: sessionSummary,
      // scope 必填后必须显式传 scope（session-memory 块落 session 介质）
      write_scope: 'session',
    },
  }).content;

  const sessionId = session.id; // 真实 sessionId（memory_manage scope=session 依赖 ctx.config.sessionId）
  const userMessage: Message = {
    id: ulid(),
    sessionId,
    role: 'user',
    content: [{ type: 'text', text: taskText }],
  };

  const config: SessionConfig = {
    sessionId,
    systemPrompt: '', // 未使用（forked 走 snapshot.system）
    client: buildLlmClient(model.providerId, model.modelId, deps.appConfig, deps.pluginManager),
    modelId: model.modelId,
    dataDir: deps.dataDir, // memory_manage global/group 寻址数据根
    workdir: sessionWsDir, // memory_manage session scope 落 <workdir>/.rocky/memory/（dir store）
    appConfig: deps.appConfig,
    tools: [memoryManageTool],
  };

  const snapshot: ContextSnapshot = {
    system: {
      id: ulid(),
      sessionId,
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
    sessionId,
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
