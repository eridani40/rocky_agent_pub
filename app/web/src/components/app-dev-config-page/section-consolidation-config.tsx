/**
 * section-consolidation-config — 整理 tab group 渲染
 * 参考: specs/ui/components/app-dev-config-page/section-consolidation-config.md
 *       specs/tech/config/[P0]app_config.md §3.16 / specs/api/overall/03-config-center.md §2.6/§2.7/§2.8
 *       specs/tech/agent/session/[P0]app_task_lock.md §4（app_task SSE + POST /consolidation/run 契约）
 *
 * 职责：整理 tab（系统设置收起区）下唯一 group 的渲染区（app_config/consolidation，key=default）：
 *   - enabled：是否启用天级二级整理任务（boolean）
 *   - dailyTime：每天触发时刻（HH:mm）
 *   - modelId：整理任务使用的模型（复用 KeyModelPicker）
 *   三字段 enabled=false 时 dailyTime/modelId 视觉禁用（不阻止查看，但不生效，PRD UC-2）。
 *
 * 底部含「立即整理」按钮 + 只读状态区（v0.0.164）：
 *   - 按钮 disabled=running；点击调 POST /consolidation/run（202 触发；409 表示已在跑，视同 running）
 *   - running/done/failed 状态由 SSE app_task topic `_all` group 的 consolidation_task_update 事件驱动
 *   - 初始状态由 GET /consolidation/status 拉取（fallback：请求失败视同「尚未整理过」）；
 *     onInit 按响应 status==='running' 初始化 isRunning（PRD UC-C2：running 中切走切回按钮仍禁用）
 *   - running→done 后自动重拉 status 刷新「上次时间 + 摘要」
 */
import { useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyModelPicker } from '../common/component-key-model-picker';
import { KeyBoolean } from '../framework/primitives/key-boolean';
import { req, runConsolidation } from '../../lib/api-client';
import { useLifecycle } from '../../lib/use-lifecycle';
import type { ConsolidationData } from './app-settings-config-defs';

interface SectionConsolidationConfigProps {
  /** consolidation record 的 draft */
  draft: ConsolidationData;
  /** 字段变更上抛 */
  onChange: (key: keyof ConsolidationData, value: ConsolidationData[keyof ConsolidationData]) => void;
}

/** 整理 tab 唯一 group：说明文案 + enabled/dailyTime/modelId + 重启提示 + 立即整理按钮 + 只读状态摘要 */
export function SectionConsolidationConfig({ draft, onChange }: SectionConsolidationConfigProps) {
  const { t } = useTranslation('app-dev-config');
  const disabled = !draft.enabled;
  return (
    <div>
      <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('group.consolidation.label')}</h3>
      <p className="text-xs text-muted-2 mb-4 leading-relaxed">
        {t('consolidation.description')}
      </p>
      <div className="flex flex-col">
        <FieldRow label={t('schema.consolidation.enabled.label')} desc={t('schema.consolidation.enabled.desc')}>
          <KeyBoolean value={draft.enabled} onChange={(v) => onChange('enabled', v)} />
        </FieldRow>
        <FieldRow label={t('schema.consolidation.dailyTime.label')} desc={t('schema.consolidation.dailyTime.desc')} disabled={disabled}>
          <div>
            <input
              type="time"
              disabled={disabled}
              value={draft.dailyTime}
              onChange={(e) => onChange('dailyTime', e.target.value || '04:00')}
              className="w-full rounded-md border border-border-2 bg-surface-2 px-3 py-2 text-[13px] font-mono text-fg outline-none transition-colors focus:border-accent hover:border-border-strong disabled:opacity-60"
            />
          </div>
        </FieldRow>
        <FieldRow label={t('schema.consolidation.modelId.label')} desc={t('schema.consolidation.modelId.desc')} disabled={disabled}>
          {/* KeyModelPicker 本身无 disabled prop，禁用态由外层包装实现（同 ext-impl 系列既有惯例） */}
          <div

            aria-disabled={disabled}
            className={disabled ? 'opacity-60 pointer-events-none' : ''}
          >
            <KeyModelPicker value={draft.modelId} onChange={(v) => onChange('modelId', v)} />
          </div>
        </FieldRow>
      </div>
      <p className="mt-3 text-[11px] font-mono text-muted">
        {t('consolidation.restartNotice')}
      </p>
      <ConsolidationTaskPanel />
    </div>
  );
}

/** 单字段行（label + 说明 + 右侧控件，disabled 时整行灰显但仍可见——PRD「不阻止查看，但不生效」） */
function FieldRow({
  label,
  desc,
  disabled = false,
  children,
}: {
  label: string;
  desc: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={
        'border border-border rounded-lg py-[16px] px-[20px] mb-[8px] bg-surface-2 transition-colors hover:border-border-strong ' +
        (disabled ? 'opacity-80' : '')
      }
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-fg">{label}</div>
          <div className="text-xs text-muted-2 mt-1.5 leading-relaxed">{desc}</div>
        </div>
        <div className="shrink-0 w-[280px]">{children}</div>
      </div>
    </div>
  );
}

/** GET /consolidation/status 响应（§2.7） */
interface ConsolidationStatus {
  lastRunAt: string | null;
  summary: string | null;
  /** 当前任务实时态（源自 AppTaskLock）：running=在跑 / failed=上次失败 / idle=空闲（done 归 idle） */
  status: 'running' | 'idle' | 'failed';
  /** running 态的开始时间（ISO），非 running 为 null */
  startedAt: string | null;
}

/** app_task 事件 payload（同构 AppTaskState，session-event-types §153-167） */
interface ConsolidationTaskEvent {
  id: string;
  type: 'consolidation_task_update';
  createdAt: string;
  data: {
    status: 'idle' | 'running' | 'done' | 'failed';
    runId?: string | null;
    startedAt?: string | null;
    error?: string | null;
  };
}

/** ConsolidationTaskPanel 内部渲染态：整理运行状态 + 上次执行摘要 + 展示型错误 */
interface TaskPanelCtx {
  isRunning: boolean;
  lastRunAt: string | null;
  summary: string | null;
  /** 展示型错误（触发按钮时 5xx / 网络异常 / 服务端 markFailed 事件），null=无 */
  errorMsg: string | null;
}

const APP_TASK_TOPIC = 'app_task';
const APP_TASK_BROADCAST_GROUP = '_all';

/** 拉一次 /consolidation/status；失败视同「尚未整理过 + 空闲」优雅降级（对齐 v0.0.151 既定 UX） */
async function fetchStatus(): Promise<ConsolidationStatus> {
  try {
    const res = await req<ConsolidationStatus>('/consolidation/status');
    return {
      lastRunAt: res?.lastRunAt ?? null,
      summary: res?.summary ?? null,
      status: res?.status ?? 'idle',
      startedAt: res?.startedAt ?? null,
    };
  } catch {
    return { lastRunAt: null, summary: null, status: 'idle', startedAt: null };
  }
}

/**
 * 整理任务面板（按钮 + 状态摘要 + SSE 订阅）。
 *
 * 数据源双通道：
 *   - onInit：subscribe(app_task, _all) + await fetchStatus() → 初始 ctx
 *   - onEvent：consolidation_task_update.data.status 驱动 isRunning
 *     * running → isRunning=true，清 errorMsg
 *     * done → isRunning=false + 异步重拉 status（用 mutateCtx 二次写）刷新 lastRunAt/summary
 *     * failed → isRunning=false + errorMsg=data.error
 *     * idle → isRunning=false（reconcileOnStartup 等场景）
 */
function ConsolidationTaskPanel() {
  const { t } = useTranslation('app-dev-config');
  const { ctx, mutateCtx } = useLifecycle<TaskPanelCtx, ConsolidationTaskEvent>({
    onInit: async ({ signal, subscribe }) => {
      subscribe(APP_TASK_TOPIC, APP_TASK_BROADCAST_GROUP);
      const status = await fetchStatus();
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      // isRunning 按 status.status 初始化（PRD UC-C2）：running 中重挂面板仍禁用，
      // 等 SSE done/failed 恢复
      return {
        isRunning: status.status === 'running',
        lastRunAt: status.lastRunAt,
        summary: status.summary,
        errorMsg: null,
      };
    },
    onEvent: (curr, evt, from) => {
      if (!curr) return;
      if (from.topic !== APP_TASK_TOPIC) return curr;
      if (evt?.type !== 'consolidation_task_update') return curr;
      const data = evt.data;
      if (data.status === 'running') {
        return { ...curr, isRunning: true, errorMsg: null };
      }
      if (data.status === 'done') {
        // 后台异步刷 status（不阻塞 reducer 返回），mutateCtx 二次写 lastRunAt/summary
        void fetchStatus().then((s) => {
          mutateCtx((prev) => {
            if (!prev) return; // void = 跳写
            return { ...prev, lastRunAt: s.lastRunAt, summary: s.summary };
          });
        });
        return { ...curr, isRunning: false, errorMsg: null };
      }
      if (data.status === 'failed') {
        return { ...curr, isRunning: false, errorMsg: data.error ?? 'failed' };
      }
      // idle（reconcileOnStartup 兜底）
      return { ...curr, isRunning: false };
    },
    // deps 空 = 挂载仅 init 一次；mutateCtx 内部走 useCallback 稳定，闭包每 render 由 useLifecycle 的
    //   onEventRef 同步刷新，故 onEvent 内引用 mutateCtx 无 stale-closure 风险
    deps: [],
  });

  const isRunning = ctx?.isRunning ?? false;
  const lastRunAt = ctx?.lastRunAt ?? null;
  const summary = ctx?.summary ?? null;
  const errorMsg = ctx?.errorMsg ?? null;

  /** 点击「立即整理」：optimistic 置 running（服务端 acquire 前 UI 先禁用）；再按响应分派 */
  const handleRunNow = useCallback(async () => {
    if (isRunning) return;
    mutateCtx((prev) => {
      if (!prev) return;
      return { ...prev, isRunning: true, errorMsg: null };
    });
    try {
      const resp = await runConsolidation();
      if ('error' in resp) {
        // 409 consolidation_in_progress：服务端确认已有任务在跑，保持 disabled 等 SSE done 恢复
        mutateCtx((prev) => {
          if (!prev) return;
          return { ...prev, isRunning: true, errorMsg: t('consolidation.error.inProgress') };
        });
      }
      // 202：keep isRunning=true，等 SSE 事件驱动状态迁移
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 5xx / 网络错误：回滚 isRunning 让用户可重试
      mutateCtx((prev) => {
        if (!prev) return;
        return { ...prev, isRunning: false, errorMsg: t('consolidation.error.network', { message: msg }) };
      });
    }
  }, [isRunning, mutateCtx, t]);

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-xs text-muted-2">
          {isRunning ? (
            <span>{t('consolidation.running')}</span>
          ) : (
            <span />
          )}
        </div>
        <button
          type="button"

          onClick={handleRunNow}
          disabled={isRunning}
          className="rounded-md border border-border-2 bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-fg transition-colors hover:border-border-strong disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {t('consolidation.runNow')}
        </button>
      </div>
      {errorMsg && (
        <p role="alert" className="text-xs text-danger mb-2">
          {errorMsg}
        </p>
      )}
      {lastRunAt === null ? (
        <p className="text-xs text-muted-2">
          {t('consolidation.status.neverRun')}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-2">
            {t('consolidation.status.lastRunLabel', { time: new Date(lastRunAt).toLocaleString() })}
          </p>
          <p className="text-xs text-muted-2 mt-1">
            {summary}
          </p>
        </>
      )}
    </div>
  );
}

export default SectionConsolidationConfig;
