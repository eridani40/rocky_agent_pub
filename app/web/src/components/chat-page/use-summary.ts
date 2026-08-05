/**
 * use-summary —— 会话 summaryTask area-hook
 * 参考: specs/tech/app/frontend/[P0]chat_area_hooks.md §2（一 hook 一 topic 一形）
 *       specs/tech/app/frontend/[P0]lifecycle_data_shapes.md §2.2（Snapshot 形 + applySnapshot）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10（useLifecycle 四方法）
 *
 * 职责：唯一持 summaryTask（SummaryTaskStatus 快照）的 area-hook。
 *   - onInit 只 subscribe(session_panel)（无初始 GET，初值 null——CompactBtn 按 idle 兜底）。
 *   - onEvent `summary_task_update` → applySnapshot(replace)。
 * 单 topic；与 useUsage 同形（Snapshot），唯一差别是无初始 GET（summary 未触发过 compact 时无落盘值，
 *   后端不提供 GET /session/:id/summary 推 summaryTask；CompactBtn 按 null=idle 兜底即可）。
 */
import { useLifecycle } from '../../lib/use-lifecycle';
import { applySnapshot, type Snapshot } from '../../lib/lifecycle-shapes';
import type { SessionEvent } from '../../store/session-slice-reducer';
import type { SummaryTaskStatus } from './types';

/** useSummary 返回：summaryTask 快照（null = 按 idle 兜底） */
export interface UseSummaryResult {
  summaryTask: Snapshot<SummaryTaskStatus>;
}

/** useSummary ctx：Snapshot<SummaryTaskStatus> */
type SummaryCtx = Snapshot<SummaryTaskStatus>;

/** useSummary 可选项（[v0.0.216] enabled 门，与 useRunState 同款） */
export interface UseSummaryOpts {
  /** false = 不 subscribe（零 SSE 订阅，ctx 恒 null=idle 兜底）。群聊场景用。缺省 true。 */
  enabled?: boolean;
}

/**
 * 会话 summaryTask area-hook（Snapshot 形，无初始 GET）。sessionId 变化时重订阅 + 重置为 null。
 * @param sessionId 当前查看的 session id
 * @param opts enabled 门（缺省 true；false = 零订阅，summaryTask 恒 null）
 */
export function useSummary(sessionId: string, opts?: UseSummaryOpts): UseSummaryResult {
  const enabled = opts?.enabled !== false;
  const { ctx } = useLifecycle<SummaryCtx, SessionEvent>({
    deps: [sessionId, enabled],
    onInit: async ({ subscribe }) => {
      // enabled 门 / sessionId 空：不 subscribe（零 SSE），ctx 恒 null（CompactBtn 按 idle 兜底）
      if (!enabled || !sessionId) return null;
      // 无初始 GET：summaryTask 未触发 compact 时无落盘值，null 兜底（CompactBtn 按 idle）
      subscribe('session_panel', `session_id:${sessionId}`);
      return null;
    },
    onEvent: (ctx, event) => {
      if (event.type !== 'summary_task_update') return;
      return applySnapshot(ctx, { op: 'replace', value: event.data });
    },
  });

  return { summaryTask: ctx };
}
