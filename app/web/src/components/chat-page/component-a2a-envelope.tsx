/**
 * component-a2a-envelope —— a2a 消息信封折叠组件
 * 参考: specs/tech/version_logs/v0.0.295/change_plan.md
 *
 * 收起态：闭合信封 SVG + senderName，点击整行展开
 * 展开态：打开信封 SVG + senderName + 灰色气泡（variant='a2a'）包裹 markdown 正文
 * 再点收起回到收起态。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { PrimitiveBubble } from '../common/primitive-bubble';
import { PrimitiveMarkdownView } from '../common/primitive-markdown-view';

interface A2aEnvelopeProps {
  /** 正文内容（markdown 文本） */
  children: ReactNode;
  /** 发送方名字 */
  senderName: string;
}

/** 闭合信封 SVG（收起态） */
function EnvelopeClosedIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="m2 7 10 6 10-6" />
    </svg>
  );
}

/** 打开信封 SVG（展开态） */
function EnvelopeOpenIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 9.5 12 3l10 6.5V19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" />
      <path d="m2 9.5 10 6 10-6" />
      <path d="M7 21v-7h10v7" />
    </svg>
  );
}

/**
 * a2a 消息信封折叠组件。
 * useState(false) 控制展开/收起；点击信封行切换。
 */
export function ComponentA2aEnvelope({ children, senderName }: A2aEnvelopeProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex flex-col gap-1.5" data-testid="a2a-envelope">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] text-muted hover:text-fg/70 transition-colors cursor-pointer"
        data-testid="a2a-envelope-toggle"
        aria-expanded={expanded}
      >
        {expanded ? <EnvelopeOpenIcon /> : <EnvelopeClosedIcon />}
        <span className="font-mono">{senderName}</span>
      </button>
      {expanded && (
        <PrimitiveBubble variant="a2a" testId="a2a-envelope-body">
          <PrimitiveMarkdownView source={children as string} />
        </PrimitiveBubble>
      )}
    </div>
  );
}

export default ComponentA2aEnvelope;
