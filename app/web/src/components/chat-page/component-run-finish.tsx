/**
 * component-run-finish —— run 结束态（§4.13，仅最近一次 run 渲染）
 * 参考: specs/ui/components/chat-page/_overview.md §4.13
 *
 * stopReason 翻译：
 *   no_tool_call / no_new_messages → 克制态「✓ 已完成」
 *   max_iterations / doom_loop → gold 警告
 *   tool_pending → sage「等待输入」（HITL 悬挂态，ask-question 等；[v0.0.101] 替换原 require_approval）
 *   interrupted → muted「已中断」
 *   error → ⚠️ icon（accent 错误色）+ displayReason 一行 + hover tooltip 显 detail
 *
 * 显示前提（§4.13 line 225）：仅当 sessionRunning===false 时由父组件挂载本组件。
 *   本组件单一职责（不读 sessionRunning），父层 message-stream 门控（见 component-message-stream.tsx）。
 *
 * error 形态（§4.13 line 228-234）：细分隔线 + ⚠️ icon + displayReason 一行，
 *   有 detail 时 ⚠️ icon 包 primitive-tooltip（hover 显 detail，不占排版流）。
 *   视觉对齐非 error 形态（都是分隔线 + 一行文案），仅靠 accent 错误色 + ⚠️ icon 区分。
 */
import type { RunFinish } from './types';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertIcon } from './icons';
import { PrimitiveTooltip } from '../common/primitive-tooltip';
import { localizedDisplayReason } from '../../i18n/llm-error-category';
import { localizedStopReason } from '../../i18n/stop-reason';

interface RunFinishProps {
  /** 最近一次 run 的结束态（stopReason + 可选 error） */
  finish: RunFinish;
}

// stopReason 文案走 locale 查表（chat.run.stopReason.<camelCase>）：后端发 snake_case code、
// 前端按 locale 查 camelCase key。error 不进此表（用 error.displayReason 动态文案，走 localizedDisplayReason）。

/** error 态行：⚠️ icon（accent 错误色）+ displayReason 一行 + 可选 code pill。
 * 有 detail 时 ⚠️ icon 包 primitive-tooltip（hover 显 detail，不占排版流）。
 * 点击整行复制 error detail 到剪贴板。 */
function ErrorRow({ error }: { error: NonNullable<RunFinish['error']> }) {
  const [copied, setCopied] = useState(false);
  // displayReason 走 locale 查表（spec §8）：优先 t('error.llm.<camelCase>')，查不到回退 displayReason 字段
  const { t: tError } = useTranslation('error');
  const { t: tChat } = useTranslation('chat');
  const localizedReason = localizedDisplayReason(error.category, error.displayReason, tError);
  // tooltip 内容：优先 detail（raw provider message，原样直展不 i18n），无则退化为 localizedReason（与主文案一致）
  const tipContent = error.detail ?? localizedReason;
  const handleCopy = () => {
    navigator.clipboard.writeText(tipContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const iconSpan = (
    <span

      role="img"
      aria-label={tChat('run.error.title')}
      className="inline-flex shrink-0 text-[var(--danger)]"
    >
      <AlertIcon size={11} />
    </span>
  );
  return (
    <span

      className="font-mono text-[11px] inline-flex items-center gap-1.5 text-[var(--danger)] cursor-pointer"
      onClick={handleCopy}
      title={tChat('run.error.copyHint')}
    >
      <PrimitiveTooltip content={tipContent}>
        {iconSpan}
      </PrimitiveTooltip>
      <span className="truncate">
        {copied ? tChat('run.error.copied') : localizedReason}
      </span>
      {error.code && !copied && (
        <span

          className="inline-block font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--danger-bg)] text-[var(--danger)] tracking-wider shrink-0"
        >
          {error.code}
        </span>
      )}
    </span>
  );
}

/**
 * run 结束态行。error 走 ⚠️ icon + displayReason + tooltip(detail)；其余克制分隔线文案。
 * 所有 stopReason 统一「分隔线 + 居中 span」结构。
 * stopReason 文案走 locale 查表（chat.run.stopReason.<camelCase>）。
 */
export function ComponentRunFinish({ finish }: RunFinishProps) {
  const { t } = useTranslation('chat');

  // error 形态：分隔线 + ⚠️ icon + displayReason + tooltip(detail)
  if (finish.stopReason === 'error' && finish.error) {
    return (
      <div className="max-w-[820px] mx-auto w-full">
        <div className="flex items-center gap-2 py-1">
          <span className="h-px flex-1 bg-border" />
          <ErrorRow error={finish.error} />
          <span className="h-px flex-1 bg-border" />
        </div>
      </div>
    );
  }

  // 非 error 形态：分隔线 + muted/gold/sage mono 文案
  const isWarning = finish.stopReason === 'max_iterations' || finish.stopReason === 'doom_loop';
  // [v0.0.101] tool_pending 替换原 require_approval（HITL 悬挂态，sage 色「等待输入」）
  const isPending = finish.stopReason === 'tool_pending';
  // stopReason==='error' 但无 error payload 的兜底（理论不该发生，defensive）
  // 其余 stopReason 走 localizedStopReason 查 chat.run.stopReason.<camelCase> 表
  const text = finish.stopReason === 'error'
    ? t('run.error.title')
    : localizedStopReason(finish.stopReason, t);

  return (
    <div className="max-w-[820px] mx-auto w-full">
      <div className="flex items-center gap-2 py-1">
        <span className="h-px flex-1 bg-border" />
        <span

          className={
            'font-mono text-[11px] inline-flex items-center gap-1.5 ' +
            (isWarning
              ? 'text-[var(--color-gold)]'
              : isPending
                ? 'text-[var(--color-sage)]'
                : 'text-muted')
          }
        >
          {!isWarning && !isPending && finish.stopReason !== 'interrupted' && <>✓ {text}</>}
          {(isWarning || isPending || finish.stopReason === 'interrupted') && text}
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}

export default ComponentRunFinish;
