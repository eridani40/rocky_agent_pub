/**
 * useCronCrud —— cron job 列表 CRUD hook（从 section-cron-panel 抽出，v0.0.131 新建）
 * 参考: specs/tech/version_logs/v0.0.131/change_plan.md A 组
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10（useLifecycle 四方法契约）
 *       specs/tech/app/frontend/[P0]lifecycle_data_shapes.md §2.1（Collection 形）
 *       specs/ui/components/chat-page/component-chat-float-menu.md §2（badge 数据源 + hideCron gate）
 *
 * 从 section-cron-panel 抽出的纯数据层 CRUD 逻辑（不含 UI）：
 *   - onInit：GET /session/:sid/cron → Collection<CronJobSummary>（keyOf=按 id 索引）+
 *     effect.startTimer({intervalMs:60000,...})（cron nextFireAt 分钟级漂移，无 SSE topic）
 *   - onTick：60s 到点重读 list 返新 ctx
 *   - toggle/delete 写后 refetch（reload 命令式）
 *   - enabled=false（如 squad 群聊 float-menu hideCron 时）→ 零网络：onInit 直接返空 Collection，
 *     不调 startTimer / listCronJobs
 *
 * 被 component-chat-float-menu（badge 数据源，恒挂载）+ component-cron-modal（弹层列表，同一 hook
 * 实例复用）共用——badge 与弹层列表同源，写后 refetch 即时更新两处。
 */
import { useCallback, useState } from 'react';
import {
  deleteCronJob,
  disableCronJob,
  enableCronJob,
  listCronJobs,
  type CronJobSummary,
} from '../../lib/cron-api';
import { useLifecycle } from '../../lib/use-lifecycle';
import { type Collection } from '../../lib/lifecycle-shapes';

/** 60s 轮询间隔（cron nextFireAt 分钟级漂移，无 SSE topic → poll 兜底，走 effect.startTimer） */
const POLL_INTERVAL_MS = 60_000;

/** 新建表单 state（迁自 section-cron-panel，被 component-cron-new-form 复用，须 export） */
export interface NewFormState {
  open: boolean;
  cron: string;
  prompt: string;
  name: string;
  submitting: boolean;
  error: string | null;
}

/** INITIAL_NEW 也被 component-cron-new-form（onCancel 时父层重置）依赖，须 export */
export const INITIAL_NEW: NewFormState = {
  open: false,
  cron: '*/30 * * * *',
  prompt: '',
  name: '',
  submitting: false,
  error: null,
};

/** onInit enabled=false 时的空占位（避免每次 render 重建新对象引用） */
const EMPTY_COLLECTION: Collection<CronJobSummary> = { items: [], keyOf: (j) => j.id };

export interface UseCronCrudOptions {
  /** false（如群聊无主 cron，float-menu hideCron 时）→ 零网络：不 fetch/不 startTimer；缺省 true */
  enabled?: boolean;
}

export interface CronCrud {
  jobs: CronJobSummary[];
  loading: boolean;
  error: string | null;
  busyId: string | null;
  refetch: () => Promise<void>;
  handleToggle: (job: CronJobSummary) => Promise<void>;
  handleDelete: (job: CronJobSummary) => Promise<void>;
}

/**
 * @param sessionId 当前 session id（cron 为 session 级）
 * @param opts.enabled false → 零网络（onInit 不 fetch/不 startTimer），jobs 恒为 []
 */
export function useCronCrud(sessionId: string, opts: UseCronCrudOptions = {}): CronCrud {
  const enabled = opts.enabled ?? true;
  const [busyId, setBusyId] = useState<string | null>(null);
  // mutation 失败的 error（toggle/delete）。useLifecycle 仅管 init 失败 error，不暴露 setError，
  // 故 mutation catch 单独存 mutError，与 initError 合并对外暴露（保 section-cron-panel 旧行为）
  const [mutError, setMutError] = useState<string | null>(null);

  // ctx=Collection<CronJobSummary>（keyOf 按 id 索引）；对外暴露 jobs=ctx.items。
  // enabled=false → onInit 直接返空 Collection，不调 startTimer/listCronJobs（MUST 零网络）。
  const {
    ctx: coll,
    loading,
    error: initError,
    reload,
  } = useLifecycle<Collection<CronJobSummary>>({
    onInit: async ({ signal, startTimer }) => {
      if (!enabled) return EMPTY_COLLECTION;
      // 声明 60s poll（cron 无 SSE topic，poll 兜底须走 effect.startTimer 标准化）
      startTimer({
        intervalMs: POLL_INTERVAL_MS,
        justification: 'cron nextFireAt 分钟级漂移，无 SSE topic',
      });
      const items = await listCronJobs(sessionId);
      // 不变量②：fetch 后必须校验 signal.aborted 才能「生效」（杜绝 setState on unmounted）
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return { items, keyOf: (j: CronJobSummary) => j.id };
    },
    // onTick: 60s 到点重读返新 ctx（enabled=false 时未 startTimer，本回调不会被调）
    onTick: async () => {
      const items = await listCronJobs(sessionId);
      return { items, keyOf: (j: CronJobSummary) => j.id };
    },
    deps: [sessionId, enabled],
  });

  // refetch：命令式刷新（清 mutError + 调 reload 重 init），保旧 refetch 行为（开始时清 error）
  const refetch = useCallback(async () => {
    setMutError(null);
    await reload();
  }, [reload]);

  // toggle enable/disable
  const handleToggle = useCallback(
    async (job: CronJobSummary) => {
      setBusyId(job.id);
      try {
        if (job.enabled) await disableCronJob(sessionId, job.id);
        else await enableCronJob(sessionId, job.id);
        await refetch();
      } catch (e) {
        // mutation 失败走本地 mutError（useLifecycle 不暴露 setError，与 useMemoryCrud 同模式）
        setMutError(e instanceof Error ? e.message : 'cron 操作失败');
      } finally {
        setBusyId(null);
      }
    },
    [sessionId, refetch],
  );

  // 删除（二次确认在承载 UI 层做，本 hook 只管调 API + refetch）
  const handleDelete = useCallback(
    async (job: CronJobSummary) => {
      setBusyId(job.id);
      try {
        await deleteCronJob(sessionId, job.id);
        await refetch();
      } catch (e) {
        setMutError(e instanceof Error ? e.message : 'cron 删除失败');
      } finally {
        setBusyId(null);
      }
    },
    [sessionId, refetch],
  );

  // jobs：onInit 未完成时 ctx 为 null，对外暴露空数组（保旧 jobs 初值 [] 语义）；
  // ctx 是 Collection，渲染直接取 ctx.items（keyOf 不外泄给调用方）。
  // error：mutError 优先（mutation 失败更具体），其次 initError（GET 失败）。
  return {
    jobs: coll?.items ?? [],
    loading,
    error: mutError ?? initError?.message ?? null,
    busyId,
    refetch,
    handleToggle,
    handleDelete,
  };
}
