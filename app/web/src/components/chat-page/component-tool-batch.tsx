/**
 * component-tool-batch —— 视图层合并胶囊（§4.8）
 * 参考: specs/ui/components/chat-page/_overview.md §4.8
 *       设计稿: reqs/v0.0.8/easy-opc-chat-v9a.html .tool-wrapper
 *
 * 折叠态：rounded-full 胶囊（wrench + 「工具调用」+ 进度 done/total + chevron）
 * 展开态：rounded-2xl 面板，包裹各 tool-call-item，chevron 旋转 180°
 * calls 来自视图层连续合并（可跨消息边界）；runActive 时不显示进度总数对齐。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ViewElement } from './types';
import { ComponentToolCallItem } from './component-tool-call-item';
import { ChevronIcon, WrenchIcon } from './icons';
// [CHAT-DEBUG] 临时观测（定位 tool_call 回放渲染缺失；排查完连同 lib/chat-debug-log 整体删除）
import { chatDebug } from '../../lib/chat-debug-log';

interface ToolBatchProps {
  /** 本 batch 内的 tool-call-item 视图元素组（§2 rule5 连续合并） */
  calls: Extract<ViewElement, { kind: 'tool-call-item' }>[];
  /** run 是否在进行（影响进度文案） */
  runActive: boolean;
}

/**
 * 工具调用合并胶囊：折叠默认，点击 head 展开为面板包裹各 call。
 * 进度 = done 数 / 总数（done = 有 result 的 call）。
 */
export function ComponentToolBatch({ calls, runActive }: ToolBatchProps) {
  const [open, setOpen] = useState(false);
  const done = calls.filter((c) => c.result).length;
  const total = calls.length;
  const { t } = useTranslation('chat');

  // [CHAT-DEBUG] 折叠态观测：默认 open=false 收为胶囊——「屏幕上只见几个 tool_call」
  //   若实际是 N 个 batch 胶囊（每胶囊内 calls 被收起），这里逐 batch 可见
  chatDebug(`render tool-batch calls=${total} done=${done} open=${open} first=${calls[0]?.toolCallId} last=${calls[total - 1]?.toolCallId}`);

  if (open) {
    return (
      <div

        className="bg-surface-2 border border-border rounded-2xl p-1.5 w-fit max-w-full"
      >
        <div

          onClick={() => setOpen(false)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg cursor-pointer text-[11px] font-mono font-medium text-muted hover:bg-bg-warm select-none"
        >
          <WrenchIcon size={10} />
          <span>{t('toolBatch.title')}</span>
          <span className="text-[9px]">{done}/{total}</span>
          <ChevronIcon size={12} className="ml-0.5 rotate-180 transition-transform" />
        </div>
        <div className="mt-0.5 flex flex-col gap-1">
          {calls.map((c) => (
            <ComponentToolCallItem key={c.key} call={c} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div

      className="inline-flex items-center gap-1.5 border border-border rounded-full px-3 py-1.5 text-[11px] font-mono text-muted cursor-pointer hover:bg-surface-2 hover:border-[var(--color-muted)] transition-all select-none"
    >
      <div

        className="inline-flex items-center gap-1.5"
        onClick={() => setOpen(true)}
      >
        <WrenchIcon size={10} />
        <span>{t('toolBatch.title')}</span>
        <span className="text-[9px]">
          {runActive ? `${done}/${total}` : t('toolBatch.countSuffix', { count: total })}
        </span>
        <ChevronIcon size={12} className="ml-0.5 transition-transform" />
      </div>
    </div>
  );
}

export default ComponentToolBatch;
