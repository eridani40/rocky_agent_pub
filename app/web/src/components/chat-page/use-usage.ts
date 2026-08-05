/**
 * use-usage —— 会话 usage area-hook
 * 参考: specs/tech/app/frontend/[P0]chat_area_hooks.md §2（一 hook 一 topic 一形）/ §4.1（事件流解耦）
 *       specs/tech/app/frontend/[P0]lifecycle_data_shapes.md §2.2（Snapshot 形 + applySnapshot）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10（useLifecycle 四方法 + 不变量①）
 *
 * 职责：唯一持 usage（SessionUsageView 快照）的 area-hook。
 *   - onInit GET /usage 拉基线 + subscribe(session_panel)（只收 session_usage_update）。
 *   - onEvent `session_usage_update` → applySnapshot(replace) 得新 ctx（Snapshot 形）。
 * 一形一 topic；不靠 useMessages 触发刷新（事件流解耦，design-decisions §7 原子化）。
 * usage 后端直推 session_usage_update 给本 hook，各区域自治。
 */
import { useLifecycle, type LifecycleInitApi } from '../../lib/use-lifecycle';
import { getSessionUsage } from '../../lib/chat-api';
import { applySnapshot, type Snapshot } from '../../lib/lifecycle-shapes';
import type { SessionEvent } from '../../store/session-slice-reducer';
import type { SessionUsageView } from './types';

/** useUsage 返回：usage 快照（null = 占位 0/0） */
export interface UseUsageResult {
  usage: Snapshot<SessionUsageView>;
}

/** useUsage ctx：Snapshot<SessionUsageView>（onEvent 按 applySnapshot replace 形） */
type UsageCtx = Snapshot<SessionUsageView>;

/**
 * 会话 usage area-hook（Snapshot 形）。sessionId 变化时 useLifecycle 自动重订阅 + 重拉基线。
 * @param sessionId 当前查看的 session id
 */
export function useUsage(sessionId: string): UseUsageResult {
  const { ctx } = useLifecycle<UsageCtx, SessionEvent>({
    deps: [sessionId],
    onInit: async ({ signal, subscribe }: LifecycleInitApi): Promise<UsageCtx> => {
      subscribe('session_panel', `session_id:${sessionId}`);
      if (!sessionId) return null;
      // 初始基线 GET /usage（失败返 null 占位，SSE 仍可推送）
      try {
        const u = await getSessionUsage(sessionId);
        if (signal.aborted) return null;
        return u;
      } catch {
        return null;
      }
    },
    onEvent: (ctx, event) => {
      if (event.type !== 'session_usage_update') return;
      // applySnapshot replace：同引用幂等跳渲染（不变量① ref-latest，ctx 由 useLifecycle 写回）
      return applySnapshot(ctx, { op: 'replace', value: event.data });
    },
  });

  return { usage: ctx };
}
