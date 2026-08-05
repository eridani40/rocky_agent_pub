/**
 * use-training-task —— 训练任务详情 hook（轮询保权威，T1 未实现 training.* SSE 事件）
 * 参考: specs/tech/app/frontend/[P0]academy_component_architecture.md §3（useTrainingTask 契约草案）
 *       specs/api/overall/18-academy.md §2.2（GET /academy/training-task/:tid）
 *
 * 契约：Snapshot 形（TrainingTaskDetail | null）；任务活跃（pending/running）时 4s 轮询
 *   （startTimer + onTick 重读，useLifecycle 自动回收 timer——不变量⑤）；
 *   任务终态（awaiting_confirm/done/rejected/aborted）停轮询。
 *   coach 消息驱动的即时刷新由调用方（section-training-observe 在消息流变化时调 reload）。
 *
 * reload 走软刷新（mutateCtx），不走 useLifecycle.reload 的 runInit 路径。
 *   runInit 内部 setCtx(null) 会 nullify ctx → page-academy 的
 *   `taskHook.data && studentDetail ? <SectionTrainingObserve> : <LoadingHint>` 翻转 →
 *   SectionTrainingObserve 卸载 → SectionChatSession（coach 列）卸载 → useMessages destroy →
 *   remount → useMessages.onInit（[CHAT-DEBUG] INIT 日志）→ coach messages 变化 →
 *   onMessagesChange → reload → 无限死循环（console INIT 风暴每分钟万条 + 观察页永久加载中）。
 *   软刷新仅覆盖新值不置 null → 消费方 ternary 不翻转 → 子树不卸载 → 循环从源头断开。
 *   timer/订阅由 onInit 起 + deps(taskId) 变时 useLifecycle 自动回收；软刷新不碰
 *   （onTick 对终态任务短路，timer 空转无害）。
 */
import { useCallback } from 'react';
import { useLifecycle } from '../../lib/use-lifecycle';
import { getTrainingTaskDetail, type TrainingTaskDetail } from '../../lib/academy-api';
import type { AcademyDataResult } from './use-academy-data';

/** 活跃状态（pending/running 需要轮询追踪进度） */
const ACTIVE_STATUSES = new Set(['pending', 'running']);

/**
 * 训练任务详情（含 turns/history/baselineScore）。
 * @param taskId 训练任务 id（空串不拉取）
 */
export function useTrainingTask(taskId: string): AcademyDataResult<TrainingTaskDetail> {
  const r = useLifecycle<TrainingTaskDetail>({
    onInit: async ({ signal, startTimer }) => {
      if (!taskId) return null as unknown as TrainingTaskDetail;
      const detail = await getTrainingTaskDetail(taskId);
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      // 活跃任务 → 轮询（timer 由 useLifecycle 自动回收；onTick 重读保权威不直接 mutate）
      if (ACTIVE_STATUSES.has(detail.task.status)) {
        startTimer({
          intervalMs: 4000,
          justification: '训练任务活跃期轮询进度（后端无 training.* SSE 事件推送，T1 事实）',
        });
      }
      return detail;
    },
    onTick: async (ctx) => {
      // 每 tick 重读任务详情；进入终态后下一次 init 不再起 timer（deps 未变不 re-init，
      //   但 onTick 返新 ctx 后任务已终态，timer 空转无害——下轮 tick 简单短路）
      if (!ctx || !ACTIVE_STATUSES.has(ctx.task.status)) return;
      try {
        const detail = await getTrainingTaskDetail(taskId);
        return detail;
      } catch {
        return; // 单 tick 失败静默（下 tick 重试；不污染 error 态）
      }
    },
    deps: [taskId],
  });

  // 软刷新：重读 + mutateCtx（不走 runInit 的 setCtx(null)）。
  // r.mutateCtx 是稳定引用（useCallback [commitCtx] → commitCtx useCallback []），
  //   所以 softReload 仅在 taskId 变化时重建（与 deps [taskId] 对齐）。
  const softReload = useCallback(async () => {
    if (!taskId) return;
    try {
      const detail = await getTrainingTaskDetail(taskId);
      r.mutateCtx(() => detail);
    } catch {
      // 单次刷新失败静默（下次 onTick 或手动重试；不污染 error 态）
    }
  }, [taskId, r.mutateCtx]);

  return { data: r.ctx, loading: r.loading, error: r.error, reload: softReload };
}
