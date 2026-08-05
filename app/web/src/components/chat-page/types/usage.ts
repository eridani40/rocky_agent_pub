/**
 * usage / summaryTask 子域类型 —— token 用量视图 + compact 任务状态（对齐后端 SessionUsageView + SummaryTask）。
 * 参考: specs/tech/agent/session/[P0]session_usage.md §8
 *       specs/tech/agent/context/[P0]context_snapshot_interface.md §2（ContextWindowUsage 7 字段）
 *       specs/tech/agent/session/[P0]session_event.md §2（SummaryTaskStatus）
 *
 * 拆分自原 chat-page/types.ts（v0.0.156 纯拆分，类型定义 100% 不变）。
 */

/**
 * ContextWindowUsage（snapshot 级 context window 占用，7 字段）。
 * 后端权威：app/server/src/message/types.ts ContextWindowUsage。
 */
export interface ContextWindowUsage {
  systemTokens: number;
  messageTokens: number;
  toolTokens: number;
  totalTokens: number;
  maxOutputTokens: number;
  tokenLimit: number;
  remainingTokens: number;
}

/**
 * 累积分区（Record 形态，字段含 input_total_tokens / output_total_tokens / total_tokens /
 * input_cache_read 等 + llmCallCount）。后端 partitionToRecord 平铺，UI 只读键值。
 */
export type AccumulatedUsageRecord = Record<string, number>;

/**
 * SessionUsageView（业务视图，三分区 + total + ratio + contextWindowUsage + 4 cacheRate）。
 * 后端权威：app/server/src/agent/session-usage-helper.ts SessionUsageView。
 */
export interface SessionUsageView {
  current: AccumulatedUsageRecord;
  sub: AccumulatedUsageRecord;
  forked: AccumulatedUsageRecord;
  total: AccumulatedUsageRecord;
  ratio: number;
  contextWindowUsage?: ContextWindowUsage;
  /** cacheRate 4 字段（cache_read / input_total，分母 0 返 0） */
  currentCacheRate: number;
  subCacheRate: number;
  forkedCacheRate: number;
  totalCacheRate: number;
}

/** summaryTask 状态枚举（对齐 session_event.md §2 SummaryTaskStatus.status） */
export type SummaryTaskStatusKind = 'idle' | 'running' | 'done' | 'failed';

/**
 * SummaryInfo —— GET /session/:id/summary 响应（spec api 04-agent-session.md §5）。
 * compact 后产生的摘要；未触发过 compact 时为 null。Studio 记忆 tab 读 member session summary（角色长期记忆）。
 */
export interface SummaryInfo {
  version: number;
  summaryUpTo: string | null;
  content: string | null;
}

/**
 * SummaryTask 快照（对齐 session_event.md §2 SummaryTaskStatus）。
 * SSE summary_task_update 推送，CompactBtn 按此状态切换可点 / disabled+spinner。
 */
export interface SummaryTaskStatus {
  status: SummaryTaskStatusKind;
  runId: string | null;
  startedAt: string | null;
  error: string | null;
}
