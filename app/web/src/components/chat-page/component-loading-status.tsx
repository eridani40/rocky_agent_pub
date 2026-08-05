/**
 * component-loading-status —— on-message spinner（贴流式尾部）
 * 参考: specs/ui/components/chat-page/_overview.md §4.10（on-message spinner + [v0.0.144] 重试态）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.7（两层状态 UI）
 *       specs/tech/version_logs/v0.0.42/change_log.md 块2
 *       specs/tech/version_logs/v0.0.130.hang/change_plan.md P6-frontend
 *       specs/prd/version_logs/v0.0.144/03-run-spinner-retry.md（重试态）
 *
 * 4 阶段文案：thinking(脑)/answering(聊)/tool_calling(扳手)/tool_executing(闪电)。
 * [v0.0.130.hang] phase=tool_executing 且 toolNames 非空 → 追加「运行工具: <names>」
 *   （i18n loading.toolExecutingNamed，插值 {{names}}），区分单纯「执行中…」与具体在跑哪个工具，
 *   修 hang 场景 UI 永停「思考中」时用户看不出到底卡在哪个工具。
 * [v0.0.144] retryStatus 非空 → 第 5 态「重试中 {attempt}/{maxAttempts}」+ 尾随 ！icon
 *   （hover/focus tooltip 显本次错误 message），让用户在长静默重试窗口知道系统在自愈而非卡死。
 *   retryStatus 空 → 原 4 态行为完全不变（零回归）。
 *
 * 数据源：run 层（agent_loop 的 runActive/loadingPhase，非 sessionRunning）。两层分离原则见 §4.10。
 */
import type { LoadingPhase, RunRetryStatus } from './types';
import { useTranslation } from 'react-i18next';
import { BrainIcon, ChatIcon, WrenchIcon, ZapIcon, AlertIcon } from './icons';
import { PrimitiveTooltip } from '../common/primitive-tooltip';

interface LoadingStatusProps {
  /** 当前阶段；null = 兜底 thinking（spinner 仍转，run 未发具体阶段事件时用） */
  phase: LoadingPhase | null;
  /**
   * [v0.0.130.hang] 当前执行中的 tool 名列表（来源：SSE tool_execution_start）。
   * 仅 phase='tool_executing' 且非空时追加「运行工具: X」文案；不传/空数组不追加（向后兼容旧回放）。
   */
  toolNames?: string[];
  /**
   * [v0.0.144] 「重试中」叠加态（来源：SSE llm_attempt → reducer）。
   * 非空 → 覆盖基础阶段文案，显「重试中 {attempt}/{maxAttempts}」+ ！icon（hover 显 message）；
   * 不传/null → 原 4 态行为不变（零回归）。
   */
  retryStatus?: RunRetryStatus | null;
}

// 文案走 chat.loading.<phase>，icon 在前端静态保留（视觉契约）
const PHASE_CONFIG: Record<LoadingPhase, { icon: typeof BrainIcon; key: string }> = {
  thinking: { icon: BrainIcon, key: 'loading.thinking' },
  answering: { icon: ChatIcon, key: 'loading.answering' },
  tool_calling: { icon: WrenchIcon, key: 'loading.toolCalling' },
  tool_executing: { icon: ZapIcon, key: 'loading.toolExecuting' },
};

// 胶囊容器 className（重试态与常规态共用，保证形态/位置一致，态切换零位移）
const BUBBLE_CLASS =
  'self-start ml-12 inline-flex items-center gap-2 bg-surface border border-border rounded-full px-2.5 py-1 text-[11px] font-mono text-muted shadow';
const SPINNER_CLASS =
  'inline-block w-[9px] h-[9px] border-[1.5px] border-[var(--color-border-strong)] border-t-[var(--color-accent)] rounded-full animate-spin shrink-0';

/**
 * on-message spinner。贴流式尾部，run 进行中可见。
 *
 * 挂载条件由 caller 控制：`{(runActive || sessionRunning) && <ComponentLoadingStatus phase=... />}`。
 * spinner 可见性跟 runActive（只要 run 活着就转）；phase 文案跟 loadingPhase（最后一个 event 派生）。
 * run_end 后 caller 不挂载 → 本组件不入 DOM，不留坑（避免占位导致排版位移）。
 *
 * [v0.0.144] retryStatus 非空时优先渲染「重试中」态（第 5 态，覆盖阶段文案）；空则走原 4 态。
 */
export function ComponentLoadingStatus({ phase, toolNames, retryStatus }: LoadingStatusProps) {
  const { t } = useTranslation('chat');

  // [v0.0.144] 「重试中」态：LLM 失败自动重试进度外显（分子已由 reducer clamp 防越界 4/3）
  if (retryStatus) {
    return (
      <div

        data-phase="retrying"
        className={BUBBLE_CLASS}
      >
        <span

          className="inline-flex items-center gap-2"
        >
          <span className={SPINNER_CLASS} />
          <span>
            {t('loading.retrying', {
              attempt: retryStatus.attempt,
              maxAttempts: retryStatus.maxAttempts,
            })}
          </span>
          {/* 尾随 ！icon：hover/focus 显本次错误 message（复用 primitive-tooltip，不占排版流） */}
          <PrimitiveTooltip content={retryStatus.message}>
            <span

              role="img"
              aria-label={retryStatus.message}
              className="inline-flex shrink-0 text-[var(--danger)]"
            >
              <AlertIcon size={11} />
            </span>
          </PrimitiveTooltip>
        </span>
      </div>
    );
  }

  const current = phase ?? 'thinking'; // null 兜底 thinking（run_start 后 phase 暂无具体值时）
  const cfg = PHASE_CONFIG[current];
  const Icon = cfg.icon;
  // [v0.0.130.hang] 仅 tool_executing 且有具体 tool 名时追加「运行工具: X」（区分「思考中」永停）
  const hasToolNames = current === 'tool_executing' && Array.isArray(toolNames) && toolNames.length > 0;

  return (
    <div

      data-phase={current}
      className={BUBBLE_CLASS}
    >
      <span

        className="inline-flex items-center gap-2"
      >
        <span className={SPINNER_CLASS} />
        <Icon size={11} className="opacity-70" />
        <span>{t(cfg.key)}</span>
        {hasToolNames && (
          <span>{t('loading.toolExecutingNamed', { names: toolNames!.join(', ') })}</span>
        )}
      </span>
    </div>
  );
}

export default ComponentLoadingStatus;
