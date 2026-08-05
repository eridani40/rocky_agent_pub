/**
 * use-coach-children —— coach session 工作子代理列表（5s 轮询）
 * 参考: specs/tech/app/frontend/[P0]component_architecture.md §3.10（useLifecycle 四方法契约 + 禁忌 #2 禁裸 setInterval）
 *
 * 用途：训练观察页 working subagent 入口（design §8.8）。coach session 下的 running/terminated
 *   子代理列表无 SSE 推送通道，走 5s 轮询感知（mount 即拉 + 每 5s 重读）。
 *
 * 实现：useLifecycle.startTimer 声明轮询（不变量④ justification），onTick 重读返新 ctx。
 *   清理归 useLifecycle 自动回收（不变量⑤），不写裸 setInterval（§3.10 禁忌 #2）。
 */
import { useLifecycle } from '../../lib/use-lifecycle';
import { listChildren } from '../../lib/chat-api';
import type { ChildrenView } from '../chat-page/types';

/**
 * coach session 工作子代理列表（running + terminated）。
 * @param coachSessionId coach session id（空串不拉）
 */
export function useCoachChildren(coachSessionId: string): { children: ChildrenView | null; loading: boolean } {
  const r = useLifecycle<ChildrenView>({
    onInit: async ({ signal, startTimer }) => {
      if (!coachSessionId) return null as unknown as ChildrenView;
      const first = await listChildren(coachSessionId);
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      startTimer({
        intervalMs: 5000,
        justification: 'coach 工作子代理感知（无 SSE 推送通道，5s 轮询 running/terminated 列表）',
      });
      return first;
    },
    onTick: async () => {
      try {
        return await listChildren(coachSessionId);
      } catch {
        return; // 单 tick 失败静默（下 tick 重试）
      }
    },
    deps: [coachSessionId],
  });
  return { children: r.ctx, loading: r.loading };
}
