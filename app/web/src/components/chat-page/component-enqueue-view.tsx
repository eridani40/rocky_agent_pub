/**
 * component-enqueue-view —— 排队区（输入框上方）
 * 参考: specs/ui/components/chat-page/_overview.md §4.11a / §5-2b（cancel）
 *       specs/ui/components/chat-page/_components.md component-enqueue-view
 *       设计稿: reqs/v0.0.12/mqnbr367-easy-opc-chat-v9a.html .input-queue/.queue-*
 *
 * 可见条件（MANDATORY）：session.running === true && items.length > 0（design §3.2）。
 * 容器右对齐悬浮在 chat-input 上方（占排版流，不与 loading-status 冲突——后者 absolute）。
 *
 * 视觉基线（对照设计稿，四维度全填，详见 _components.md）：
 *   - 容器 .input-queue：fit-content / max-w-460 / margin 0 0 8px auto / flex column gap-5px
 *   - 头 .queue-head + .queue-dot：mono 10px muted + 6px accent pulse dot
 *   - 项 .queue-item：32px 高 / dashed border-strong / rounded-10px / hover border-accent；
 *     展开态 .open 高 auto + text wrap line-height-1.55
 *   - 序号 .queue-index：mono 10px accent / bg-accent-light / rounded-full pill（#{n}）
 *   - 内容 .queue-text：12.5px fg-2，折叠 line-height-32 nowrap ellipsis；展开 wrap
 *   - 取消 .queue-remove：22×22 rounded-md muted，hover bg-var(--danger-bg)/color-var(--danger) 红底红字
 *
 * cancel 行为（§5-2b）：点击 → x 立即转 spinner（本地 canceling Set，转圈期禁点防重复 POST）
 *   + onCancel(enqueueId) POST /cancel（fire-and-forget）；1s 后回 x（cancel POST 幂等，可重试 INV-7）。
 *   队列移项靠 SSE enqueued_message_canceled（不进 store，多端一致 INV-1/INV-5）。
 *   切 session 时 EnqueueView unmount（showEnqueue 门控）→ useEffect 清 timers 防 fire setCanceling React warn。
 */
import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { EnqueueItem } from './types';
import { ChevronIcon, CloseIcon } from './icons';
import { MentionRender } from './component-mention-render';

/**
 * BUG-007：把 enqueue content 强制拍平为字符串再渲染。
 * 真 LLM / 真实 user message 的 content 永远是 ContentBlock[]（如 [{type:'text',text:'...'}]），
 * 后端 message_enqueued 事件按 ContentBlock[] 透传。
 * reducer 已用 contentBlocksToPreviewText 转字符串，本组件再加一道兜底：
 * 任何意外流入的非 string content（数组/对象）一律 flatten 成字符串，避免 `{type,text}` 对象
 * 被当 React child 渲染导致整树崩（Objects are not valid as a React child）。
 */
function toTextPreview(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: 'text'; text?: string } =>
        !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }
  if (content && typeof content === 'object' && (content as { type?: string }).type === 'text') {
    return String((content as { text?: string }).text ?? '');
  }
  return '';
}

interface EnqueueViewProps {
  /** 排队项（按 enqueue 顺序） */
  items: EnqueueItem[];
  /** 是否处于 running 态（与 items.length 共同决定可见性） */
  running: boolean;
  /** 触发 POST /session/:id/messages/:enqueueId/cancel（fire-and-forget 202） */
  onCancel?: (enqueueId: string) => void;
}

/**
 * 排队区容器。running 且 items 非空时渲染；否则返回 null（不占排版流）。
 * 单项展开/折叠是本地态（独立于全局 store）。
 *
 * cancel 转圈态：canceling Set（enqueueId → 转圈中）纯本地瞬态，不进 store/ctx（INV-3）。
 *   切 session unmount 后 fire setCanceling 会 React warn，故 timersRef 跟踪 setTimeout + unmount 清理。
 */
export function ComponentEnqueueView({ items, running, onCancel }: EnqueueViewProps) {
  // 本地展开态：enqueueId → open（折叠默认，单条点开看全文）
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  // cancel 转圈态：转圈中的 enqueueId 集合（纯本地，1s 后回 x）
  const [canceling, setCanceling] = useState<Set<string>>(new Set());
  // cancel 1s 回 x 的 setTimeout 句柄（unmount 时清理防 React warn）
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const { t } = useTranslation('chat');
  const { t: tCommon } = useTranslation('common');

  // unmount 清理所有 pending cancel timer（切 session EnqueueView unmount 后 fire setCanceling 会 React warn）
  useEffect(() => {
    return () => {
      timersRef.current.forEach((tId) => clearTimeout(tId));
      timersRef.current.clear();
    };
  }, []);

  if (!running || items.length === 0) return null;

  const head = t('enqueue.queueHint', { count: items.length });

  function handleCancel(enqueueId: string) {
    // 转圈期禁点（防重复 POST cancel）
    if (canceling.has(enqueueId)) return;
    setCanceling((prev) => new Set(prev).add(enqueueId));
    onCancel?.(enqueueId);
    // 1s 后回 x（cancel POST 幂等 INV-7，重试无副作用；不监听 POST 成败 fire-and-forget）
    const tId = setTimeout(() => {
      setCanceling((prev) => {
        const next = new Set(prev);
        next.delete(enqueueId);
        return next;
      });
      timersRef.current.delete(enqueueId);
    }, 1000);
    timersRef.current.set(enqueueId, tId);
  }

  return (
    <div

      style={{
        width: 'fit-content',
        maxWidth: '460px',
        margin: '0 0 8px auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
      }}
    >
      {/* 头部：脉冲 dot + mono 小字（右对齐） */}
      <div
        className="flex items-center justify-end gap-1.5 text-[10px] font-mono text-muted px-1"
      >
        <span
          className="inline-block w-1.5 h-1.5 rounded-full bg-accent"
          style={{ animation: 'qpulse 1.2s ease-in-out infinite' }}
        />
        <span>{head}</span>
      </div>
      {items.map((it, i) => {
        const open = !!openMap[it.enqueueId];
        // BUG-007：强制字符串化，兜底任何意外 ContentBlock[]/{type,text} 流入
        const preview = toTextPreview(it.content);
        // 该项是否转圈中（cancel 已点等 SSE 移项）
        const isCanceling = canceling.has(it.enqueueId);
        return (
          <div
            key={it.enqueueId}

            data-open={open ? 'true' : 'false'}
            className={
              'group flex items-center gap-2 bg-surface rounded-[10px] pl-2.5 pr-1.5 ' +
              'border border-dashed border-[var(--color-border-strong)] hover:border-[var(--color-accent)] ' +
              'transition-all overflow-hidden ' +
              (open ? 'py-1.5 items-start' : 'h-8')
            }
          >
            {/* 序号 pill */}
            <span className="text-[10px] font-mono text-accent bg-accent-light rounded-full px-[7px] py-px shrink-0 leading-tight">
              #{i + 1}
            </span>
            {/* 内容（折叠态单行截断；展开态 wrap） */}
            <span

              className={
                'flex-1 min-w-0 text-[12.5px] text-fg-2 ' +
                (open
                  ? 'whitespace-normal overflow-visible break-words leading-[1.55]'
                  : 'whitespace-nowrap overflow-hidden text-ellipsis leading-[32px]')
              }
            >
              {/* MentionRender 解析 <mention/> tag → pill；无 mention 时降级纯文本（preview 由 toTextPreview 产） */}
              <MentionRender text={preview} />
            </span>
            {/* 展开按钮 */}
            <button
              type="button"
              aria-label={open ? tCommon('action.collapse') : t('enqueue.expandFull')}
              title={open ? tCommon('action.collapse') : t('enqueue.expandFull')}
              onClick={() => setOpenMap((m) => ({ ...m, [it.enqueueId]: !open }))}
              className="w-[22px] h-[22px] rounded-md flex items-center justify-center text-muted cursor-pointer shrink-0 hover:bg-bg-warm hover:text-fg-2 transition-colors"
            >
              <ChevronIcon
                size={12}
                style={{
                  transform: open ? 'rotate(180deg)' : 'none',
                  transition: 'transform 0.15s',
                }}
              />
            </button>
            {/* 取消按钮（红底红字 hover，区别于 expand）；cancel 后转 spinner 占同 22×22 槽位 */}
            <button
              type="button"
              data-action-key="chat.enqueue.cancel"
              data-canceling={isCanceling ? 'true' : 'false'}
              disabled={isCanceling}
              aria-label={t('enqueue.dequeue')}
              title={t('enqueue.dequeue')}
              onClick={() => handleCancel(it.enqueueId)}
              className="w-[22px] h-[22px] rounded-md flex items-center justify-center text-muted cursor-pointer shrink-0 hover:bg-[var(--danger-bg)] hover:text-[var(--danger)] transition-colors disabled:cursor-default disabled:hover:bg-transparent"
            >
              {isCanceling ? (
                // 码内 spinner 约定：inline span border+animate-spin（abort-btn/loading-status/ws-tree 同款）
                <span className="inline-block w-3 h-3 border-[1.5px] border-[var(--color-border-strong)] border-t-[var(--color-accent)] rounded-full animate-spin" />
              ) : (
                <CloseIcon size={12} />
              )}
            </button>
          </div>
        );
      })}
      {/* qpulse keyframes（enqueue 脉冲 dot 动画，对照设计稿） */}
      <style>{`@keyframes qpulse {0%,100%{opacity:1}50%{opacity:.3}}`}</style>
    </div>
  );
}

export default ComponentEnqueueView;
