/**
 * component-tool-call-item —— 单个工具调用：head + 展开参数/结果 KV（§4.9）
 * 参考: specs/ui/components/chat-page/_overview.md §4.9
 *       设计稿: reqs/v0.0.8/easy-opc-chat-v9a.html .tool-item
 *
 * KV 排版硬约束：左 key 固定 70px 右对齐，右 value mono 左对齐 break-all；禁 JSON/代码框。
 * status pill：done=success-bg/success「✓ done」；running=warning-bg/warning「running」；err=danger 语义色。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ImageBlockView, ViewElement } from './types';
import { ChevronIcon, FileIcon, CheckIcon } from './icons';
// [v0.0.129] output text 块 JSON pretty；[v0.0.134] input arguments value 同机制（string 走 formatToolOutputText、object/array 走 JSON.stringify(v,null,2)）
import { formatToolOutputText } from './format-tool-output-text';

interface ToolCallItemProps {
  /** tool-call-item 视图元素（含绑定 result） */
  call: Extract<ViewElement, { kind: 'tool-call-item' }>;
}

/** 计算 status：有 result → done/err；否则 running */
function statusOf(call: Extract<ViewElement, { kind: 'tool-call-item' }>): 'done' | 'running' | 'err' {
  if (!call.result) return 'running';
  return call.result.isError ? 'err' : 'done';
}

const STATUS_STYLE: Record<'done' | 'running' | 'err', { cls: string; text: string }> = {
  done: { cls: 'bg-[var(--success-bg)] text-[var(--success)]', text: '✓ done' },
  running: { cls: 'bg-[var(--warning-bg)] text-[var(--warning)]', text: 'running' },
  err: { cls: 'bg-[var(--danger-bg)] text-[var(--danger)]', text: 'error' },
};

/**
 * [v0.0.105] tool_result 图片块渲染（P1 最小占位）：computer use get_app_state 返 image+text 双 block。
 * 缩略图默认 max-h-24；click 切换全宽展开/收起（图片自身缩放，不引起相邻元素位移——click 目标始终可见）。
 *   - base64：src=`data:${mediaType};base64,${data}`
 *   - url：src=source.url
 */
function ToolResultImage({
  block,
  idx,
  toolCallId,
}: {
  block: ImageBlockView;
  idx: number;
  toolCallId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const src =
    block.source.kind === 'url'
      ? block.source.url
      : `data:${block.mediaType};base64,${block.source.data}`;
  return (
    <div className="flex items-baseline gap-3 text-[12px] leading-[1.5]">
      <span className="text-muted font-medium w-[70px] shrink-0 text-right">image</span>
      <img

        src={src}
        alt="tool result screenshot"
        onClick={() => setExpanded((v) => !v)}
        className={
          'cursor-pointer rounded-md border border-line transition-all ' +
          (expanded ? 'max-w-full' : 'max-h-24')
        }
      />
    </div>
  );
}

/**
 * 单个工具调用：可折叠 head（icon + name + status pill + chevron）+ 展开 body（参数/结果 KV）。
 */
export function ComponentToolCallItem({ call }: ToolCallItemProps) {
  const [open, setOpen] = useState(false);
  const status = statusOf(call);
  const statusInfo = STATUS_STYLE[status];
  const { t } = useTranslation('chat');

  return (
    <div

      className={'px-3 py-2.5 rounded-xl cursor-pointer transition-colors ' +
        (open ? 'bg-bg-warm' : 'hover:bg-bg-warm')}
    >
      <div

        className="flex items-center gap-2 text-[12px] select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <FileIcon size={11} className="text-muted" />
        <span className="font-mono font-medium text-fg-2">{call.name}</span>
        <span
          className={
            'text-[9px] font-bold font-mono uppercase px-1.5 py-0.5 rounded-full tracking-wider ' +
            statusInfo.cls
          }
        >
          {statusInfo.text}
        </span>
        <ChevronIcon
          size={12}
          className={'ml-auto transition-transform ' + (open ? 'rotate-180' : '')}
        />
      </div>

      {open && (
        <div className="mt-2 pl-5 flex flex-col gap-3">
          {/* 参数 */}
          <div className="flex flex-col gap-0.5">
            <div className="text-[10px] font-semibold text-muted uppercase tracking-wider mb-0.5">
              {t('toolCall.params')}
            </div>
            {Object.entries(call.arguments).length === 0 ? (
              <div className="text-[12px] text-muted italic">{t('toolCall.paramsEmpty')}</div>
            ) : (
              Object.entries(call.arguments).map(([k, v], i) => (
                <div key={i} className="flex items-baseline gap-3 text-[12px] leading-[1.5]">
                  <span className="text-muted font-medium w-[70px] shrink-0 text-right">{k}</span>
                  <span className="text-fg-2 font-mono text-[12px] flex-1 break-all whitespace-pre-wrap">
                    {typeof v === 'string' ? formatToolOutputText(v) : JSON.stringify(v, null, 2)}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* 结果 */}
          {call.result && (
            <div className="flex flex-col gap-0.5">
              <div className="text-[10px] font-semibold text-muted uppercase tracking-wider mb-0.5">
                {t('toolCall.result')}
              </div>
              <div className="flex items-baseline gap-3 text-[12px] leading-[1.5]">
                <span className="text-muted font-medium w-[70px] shrink-0 text-right">status</span>
                <span
                  className={
                    'font-mono text-[12px] flex-1 ' +
                    (call.result.isError ? 'text-[var(--danger)]' : 'text-[var(--success)]')
                  }
                >
                  {call.result.isError ? 'Error' : 'Success'}
                </span>
              </div>
              {call.result.content.map((c, i) => {
                if (c.type === 'text') {
                  return (
                    <div key={i} className="flex items-baseline gap-3 text-[12px] leading-[1.5]">
                      <span className="text-muted font-medium w-[70px] shrink-0 text-right">content</span>
                      <span
                        className={
                          'font-mono text-[12px] flex-1 break-all whitespace-pre-wrap ' +
                          (call.result!.isError ? 'text-[var(--danger)]' : 'text-[var(--success)]')
                        }
                      >
                        {/* [v0.0.129] output text 含 JSON → pretty 多行缩进。[v0.0.134] input arguments value 同机制：string 走 formatToolOutputText、object/array 走 JSON.stringify(v,null,2)。守 §4.9 line233：禁整体 JSON 代码框 */}
                        {formatToolOutputText(c.text)}
                      </span>
                    </div>
                  );
                }
                // [v0.0.105] image block（computer use get_app_state 截图）→ 缩略占位 + click 展开
                if (c.type === 'image') {
                  return <ToolResultImage key={i} block={c} idx={i} toolCallId={call.toolCallId} />;
                }
                return null;
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ComponentToolCallItem;
