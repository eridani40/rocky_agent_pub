/**
 * component-a2a-envelope —— a2a 消息信封折叠组件（双向：in 收到 / out 发出）
 * 参考: specs/tech/version_logs/v0.0.295/change_plan.md（in 方向原始实现）
 *       specs/tech/version_logs/v0.0.310/change_plan.md（out 方向扩展）
 *
 * in 方向：信封 + ↙ + from {senderName}，点击展开灰色气泡正文
 * out 方向（v0.0.310）：信封 + ↗ + to {senderName}，status 控制 sending/done/error 三态
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { PrimitiveBubble } from '../common/primitive-bubble';
import { PrimitiveMarkdownView } from '../common/primitive-markdown-view';

interface A2aEnvelopeProps {
  /** 正文内容（done 态展开后渲染） */
  children?: ReactNode;
  /** 对端名字（in=senderName, out=targetName） */
  senderName: string;
  /** 方向：in=收到（↙ from）, out=发出（↗ to），默认 'in' */
  direction?: 'in' | 'out';
  /** 发送状态（out 专用）：sending / done / error；in 方向不传 */
  status?: 'sending' | 'done' | 'error';
  /** error 正文（status=error 时展开显示） */
  errorContent?: ReactNode;
  /** 展开状态变化回调（外部据此渲染时间戳：展开→显示，收起→隐藏） */
  onToggle?: (expanded: boolean) => void;
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
 * a2a 消息信封折叠组件（双向）。
 * in 方向：↙ from {senderName}，可展开看正文。
 * out 方向：↗ to {senderName}，sending/done/error 三态。
 */
export function ComponentA2aEnvelope({
  children,
  senderName,
  direction = 'in',
  status,
  errorContent,
  onToggle,
}: A2aEnvelopeProps) {
  const isOut = direction === 'out';
  // out+sending 不可展开；其他状态正常 toggle
  const canToggle = !(isOut && status === 'sending');
  const [expanded, setExpanded] = useState(false);

  /** toggle 展开态并通知外部（外部据此控制时间戳渲染） */
  const handleToggle = () => {
    if (!canToggle) return;
    const next = !expanded;
    setExpanded(next);
    onToggle?.(next);
  };

  // 方向标识：in=↙ from, out=↗ to
  const arrow = isOut ? '↗' : '↙'; // ↗ / ↙
  const prefix = isOut ? 'to' : 'from';
  // [v0.0.311] sending 态 targetName 未解析（'...'）→ 隐藏 to 前缀，只显示「发送中...」
  const hideTargetName = isOut && status === 'sending' && (senderName === '...' || !senderName);

  return (
    <div className="flex flex-col gap-1.5" data-testid="a2a-envelope">
      <div className="flex items-center gap-1.5 text-[11px] text-muted">
        {/* hideTargetName → 不渲染 toggle 按钮（↗ to ...），只留信封图标 + 发送中文案 */}
        {!hideTargetName ? (
          <button
            type="button"
            onClick={handleToggle}
            className={`flex items-center gap-1.5 text-[11px] text-muted hover:text-fg/70 transition-colors ${canToggle ? 'cursor-pointer' : 'cursor-default'}`}
            data-testid="a2a-envelope-toggle"
            aria-expanded={expanded}
          >
            {expanded ? <EnvelopeOpenIcon /> : <EnvelopeClosedIcon />}
            <span className="font-mono">{arrow}</span>
            <span className="font-mono">{prefix} {senderName}</span>
          </button>
        ) : (
          <span className="flex items-center gap-1.5 text-[11px] text-muted" data-testid="a2a-envelope-toggle">
            <EnvelopeClosedIcon />
            <span className="font-mono">{'发送中...'}</span>
          </span>
        )}
        {/* out + sending + targetName 已解析 → 追加「发送中...」（hideTargetName 时已内置在 toggle span） */}
        {isOut && status === 'sending' && !hideTargetName && (
          <span className="text-[11px] text-muted font-mono">{'发送中...'}</span>
        )}
        {isOut && status === 'error' && (
          <span className="text-[9px] font-bold font-mono uppercase px-1.5 py-0.5 rounded-full bg-[var(--danger-bg)] text-[var(--danger)] tracking-wider">
            {'发送失败'}
          </span>
        )}
      </div>
      {expanded && canToggle && (
        <PrimitiveBubble variant="a2a" testId="a2a-envelope-body">
          {isOut && status === 'error' ? (
            errorContent
          ) : (
            <PrimitiveMarkdownView source={children as string} />
          )}
        </PrimitiveBubble>
      )}
    </div>
  );
}

export default ComponentA2aEnvelope;
