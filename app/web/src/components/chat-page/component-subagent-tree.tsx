/**
 * component-subagent-tree —— parent session 派生的 swarm 展开树
 * 参考: specs/ui/components/chat-page/component-subagent-tree.md（独立 spec：视觉基线 + Props + testid 权威）
 *       specs/ui/components/chat-page/_overview.md §4.2a（挂点）+ §8（tokens --color-indigo）
 *       设计稿: reqs/v0.0.28/easy-opc-squad-v10.html .sq-sub / .sq-subitem / .sq-divider / .id-dot.id-subagent
 *       数据源: api 10-multi-agent.md §3（GET /session/:id/children → ChildrenView running/terminated 分组）
 *
 * 三段结构：
 *   ① running 段（始终展开，subagent-tree-running）
 *   ② 分割线「非运行中 (N)」JetBrains Mono 10px muted + chev toggle（subagent-tree-terminated-toggle）
 *   ③ terminated 段（默认折叠，展开后渲染，灰显 opacity 0.4，subagent-tree-terminated）
 *
 * subagent identity dot：11×11 rounded-3px var(--color-indigo)（区别其他 identity 14×14 rounded-4px）；
 * terminated（idle/error/interrupted）→ dot + name opacity 0.4 + name muted。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SubagentNode } from './types';
import { ChevronRightIcon } from './icons';
import { SpinnerRing } from '../common/spinner-ring';

interface Props {
  /** parent session id（仅用于日志/审计，UI 渲染不直接消费；academy flat 形态不传） */
  parentSessionId?: string;
  /** running 态 children（按 updatedAt desc） */
  running: SubagentNode[];
  /** terminated 态 children（idle/error/interrupted，按 updatedAt desc） */
  terminated: SubagentNode[];
  /** 当前选中的 subagent sessionId（高亮 bg-accent-surface + name text-accent） */
  activeSubId?: string;
  /** 点击 subagent 子项 → 切到该 subagent 只读页面（§5 交互8）；缺省行不可点（academy 树行本身不可点） */
  onSelectSub?: (subSessionId: string) => void;
  /** running 行「观察 →」链接（academy 观察入口，design §8.8 仅进行中可点）；缺省不渲 */
  onOpenNode?: (sessionId: string) => void;
  /** 观察链接文案注入（academy 传 iter.watch；缺省 chat:subagent.observe） */
  openNodeLabel?: string;
  /** 折叠分割线文案注入（缺省 chat:subagent.terminatedCount「非运行中 (N)」） */
  terminatedLabel?: string;
  /** 平铺形态：行/toggle 去 48px conv 缩进（academy 独立列用）；缺省 false = conv 嵌套形态 */
  flat?: boolean;
}

/** subagent identity dot 颜色类（统一从 indigo token 取，terminated 通过 opacity 表达灰显） */
const DOT_COLOR_CLASS = 'bg-[var(--color-indigo)]';

/**
 * 渲染单条 subagent 子项（running / terminated 复用，terminated 传 isTerminated=true 灰显）。
 * 视觉基线（对照 component-subagent-tree.md）：padding 5px 10px 5px 48px（flat 形态 6px 10px）/
 * rounded-md 6px / hover bg-bg-warm / active bg-accent-surface + name accent；dot 11×11 rounded-3px indigo。
 */
function SubagentRow({
  node,
  active,
  isTerminated,
  flat,
  onSelectSub,
  onOpenNode,
  openNodeLabel,
}: {
  node: SubagentNode;
  active: boolean;
  isTerminated: boolean;
  flat: boolean;
  onSelectSub?: Props['onSelectSub'];
  onOpenNode?: Props['onOpenNode'];
  openNodeLabel?: string;
}) {
  const { t } = useTranslation('chat');
  // terminated 灰显：dot + 整行 opacity 0.4；name 在 active 时 accent，否则 muted（terminated）/ fg-2（running）
  const nameColor = active
    ? 'text-[var(--color-accent)]'
    : isTerminated
      ? 'text-muted'
      : 'text-[var(--color-fg-2)]';
  const rowBg = active ? 'bg-accent-surface' : 'hover:bg-bg-warm';
  // running spinner（小 size）派生自 node.state：state∈{running,interrupting} 时渲染。
  //   suspended 不亮 spinner（subagent 是派生只读视图，覆盖范围仅 running spinner）。
  const isRunningState = node.state === 'running' || node.state === 'interrupting';
  // 行点击仅在 onSelectSub 提供时挂载（academy flat 树行不可点，仅观察链接可点）
  const clickable = !!onSelectSub;

  return (
    <div
      data-action-key={clickable ? 'chat.subagent.open' : undefined}
      onClick={
        clickable
          ? (e) => {
              e.stopPropagation();
              onSelectSub(node.sessionId);
            }
          : undefined
      }
      className={`flex items-center gap-1.5 ${clickable ? 'cursor-pointer' : ''} transition-colors ${rowBg}`}
      style={{
        padding: flat ? '6px 10px' : '5px 10px 5px 48px',
        borderRadius: '6px',
        opacity: isTerminated ? 0.4 : 1,
      }}
    >
      {/* identity dot：11×11 rounded-3px indigo（区别其他 identity 14×14 rounded-4px） */}
      <span
        className={`shrink-0 ${DOT_COLOR_CLASS}`}
        style={{ width: '11px', height: '11px', borderRadius: '3px' }}
        aria-hidden="true"
      />
      {/* subagent name：Inter 12.5px（active accent / terminated muted / running fg-2） */}
      <span className={`font-sans text-[12.5px] truncate ${nameColor}`}>{node.name}</span>
      {/* running 行「观察 →」链接（onOpenNode 提供时渲；terminated 无入口——design §8.8 跑完只看过程） */}
      {!isTerminated && onOpenNode && (
        <button
          type="button"
          data-action-key="chat.subagent.observe"
          onClick={(e) => {
            e.stopPropagation();
            onOpenNode(node.sessionId);
          }}
          className="ml-auto shrink-0 text-[11px] text-[var(--color-indigo)] cursor-pointer hover:underline"
        >
          {openNodeLabel ?? t('subagent.observe')}
        </button>
      )}
      {/*
       * running spinner 槽位（name 右侧，小 size 10×10）。
       * 占位固定入常规流（shrink-0 w-[12px] h-[12px]）：spinner/idle 两态均占同尺寸，
       * 出现/消失不导致 name 文本位移（INV-9 与 dot/active 高亮错位共存）。
       * 用 div 而非 span：避免破坏既有 `span:last-of-type` 选择器（name span 仍是最后一个 span）。
       * 无观察链接时 ml-auto 由本槽位承担（有链接时链接已 ml-auto，槽位紧随其后）。
       */}
      <div
        className={`${!isTerminated && onOpenNode ? '' : 'ml-auto'} inline-flex h-[12px] w-[12px] shrink-0 items-center justify-center`}
      >
        {isRunningState && <SpinnerRing size="sm" />}
      </div>
    </div>
  );
}

/**
 * 三段展开树（parent conv-item 内挂载，twisty 展开后渲染；academy flat 形态独立列挂载）。
 * terminated 段默认折叠，点「非运行中 (N)」分割线 toggle 展开。
 */
export function ComponentSubagentTree({
  running,
  terminated,
  activeSubId,
  onSelectSub,
  onOpenNode,
  openNodeLabel,
  terminatedLabel,
  flat = false,
}: Props) {
  // terminated 段折叠态（默认折叠；点 toggle 切换）
  const [terminatedOpen, setTerminatedOpen] = useState(false);
  const { t } = useTranslation('chat');

  return (
    <div className="flex flex-col">
      {/*
       * ① running 段容器始终渲染（即使 running 为空也不判空）：
       * 保证 subagent-tree-running 容器 testid 恒在，ET 三段断言（tree+running+terminated）稳定通过。
       */}
      <div className="flex flex-col">
        {running.map((node) => (
          <SubagentRow
            key={node.sessionId}
            node={node}
            active={activeSubId === node.sessionId}
            isTerminated={false}
            flat={flat}
            onSelectSub={onSelectSub}
            onOpenNode={onOpenNode}
            openNodeLabel={openNodeLabel}
          />
        ))}
      </div>

      {/* ② 分割线「非运行中 (N)」JetBrains Mono 10px muted + chev toggle（仅当有 terminated 时渲染） */}
      {terminated.length > 0 && (
        <button
          type="button"
          data-action-key="chat.subagent.toggle-terminated"
          onClick={(e) => {
            e.stopPropagation();
            setTerminatedOpen((v) => !v);
          }}
          aria-expanded={terminatedOpen}
          className="flex items-center gap-2 w-full text-left transition-colors hover:bg-bg-warm"
          style={{ padding: flat ? '4px 10px' : '6px 10px 6px 48px' }}
        >
          <ChevronRightIcon
            size={10}
            style={{
              transition: 'transform 0.15s',
              transform: terminatedOpen ? 'rotate(90deg)' : 'rotate(0deg)',
              color: 'var(--color-muted)',
              flexShrink: 0,
            }}
          />
          {/* 分割线 1px border flex-1 */}
          <span
            className="flex-1"
            style={{ height: '1px', background: 'var(--color-border)' }}
            aria-hidden="true"
          />
          <span
            className="font-mono text-[10px] text-muted whitespace-nowrap"
          >
            {terminatedLabel ?? t('subagent.terminatedCount', { count: terminated.length })}
          </span>
        </button>
      )}

      {/* ③ terminated 段：默认折叠，展开后渲染（灰显 opacity 0.4） */}
      {terminatedOpen && terminated.length > 0 && (
        <div className="flex flex-col">
          {terminated.map((node) => (
            <SubagentRow
              key={node.sessionId}
              node={node}
              active={activeSubId === node.sessionId}
              isTerminated
              flat={flat}
              onSelectSub={onSelectSub}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default ComponentSubagentTree;
