/**
 * component-conversation-item —— 单条会话列表项（§4.2）
 * 参考: specs/ui/components/chat-page/_overview.md §4.2（conv-item + 编辑态 + 行点击展开）
 *       设计稿: reqs/v0.0.8/easy-opc-chat-v9a.html .conv-item（基础视觉）
 *
 * 一行会话：title（13px ellipsis）+ time（11px mono）；hover bg-warm；active bg-[var(--surface-3)] + title accent。
 * [v0.0.231] pinned 视觉：置顶 item 最右侧常驻 PinIcon（absolute 零 reflow）+ 常态 bg-bg-warm 背景加重
 *   （active 仍最强）；unread 红点 right-[18px] 与 pin 错位共存（§4.2 pinned 视觉基线）。
 * title 贴左 padding 左对齐；行点击幂等置 expanded=true（不 toggle，无 collapse 入口）→ 自动展开 subagent-tree。
 * title 编辑态：active 点 title span → input（autoFocus + 全选）；Enter/blur save（调
 *   onRenameTitle PUT {title, titled:true}）/ Esc cancel（恢复原值）。未激活 session 点 title 走 onSelect
 *   切 active（不进编辑态）。
 * expanded / 编辑态 / expandOnce 主动刷一次 均为本组件局部 state（行级自治）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChildrenView, Session } from './types';
import { ComponentSubagentTree } from './component-subagent-tree';
import { SpinnerRing } from '../common/spinner-ring';
import { Icon } from '../studio-page/studio-icons';

/**
 * 格式化时间（简短展示：相对/日期）。
 * 相对时段文案走 i18n（common.timeAgo.*），日期段（≥7 天）保持 `M-DD` 字面格式（数字无 locale 差异）。
 */
function fmtTime(iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return t('common:timeAgo.justNow');
  if (min < 60) return t('common:timeAgo.minutesAgo', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('common:timeAgo.hoursAgo', { count: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return t('common:timeAgo.daysAgo', { count: day });
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
}

interface Props {
  /** 本条 session 数据 */
  session: Session;
  /** 是否当前激活（高亮 + 可编辑） */
  active: boolean;
  /** parent → children 视图（仅 parent 项有值；来自 GET /session/:id/children） */
  childrenView?: ChildrenView;
  /** 当前 active 的 subagent sessionId（subagent-tree 高亮用）。
   *  同时驱动例外：若该 id 属于本 conv-item 的 children，parent 切 inactive
   *  时 tree 不收起 + 兜底渲染（用户选 subagent 时左侧兄弟列表保持可见）。 */
  activeSubId?: string;
  /** 选中会话（行点击 + 非 active 时点 title span 都触发） */
  onSelect: (id: string) => void;
  /** 选中 subagent 子项 → 切到 subagent 只读页面（§5 交互8） */
  onSelectSub: (subSessionId: string) => void;
  /** 删除会话 */
  onDelete: (id: string) => void;
  /** 右键菜单触发（透传到 panel 层渲染） */
  onContextMenu: (sessionId: string, x: number, y: number) => void;
  /**
   * 行点击展开时刷新该 parent 的 children。session_meta 广播在部分环境
   * （ET headless / SSE 时序）不可靠，行点击展开后主动 GET /children 拿最新数据，保证 terminated
   * 段及时渲染（running→terminated 转移可观测）。expandOnce 仅调一次，
   * 后续 subagent 状态变化靠 page-chat session_meta `_all` 推送的 refreshChildren 兜底。
   * 可选（缺省不调）。
   */
  onRefreshChildren?: (parentId: string) => void;
  /**
   * title 编辑态 save 回调。父组件调 PUT /session/:id body {title, titled:true}
   * （body 同步置 titled:true 防覆盖，详见 specs/api/overall/04-agent-session.md §2.5）
   * → session_meta reducer 自动刷新 title。
   */
  onRenameTitle?: (id: string, newTitle: string) => void;
  /**
   * [v0.0.306] 置顶/取消置顶回调（可选，向后兼容）。父组件 fire-and-forget PUT {pinned}，
   * 归位靠 session_meta 广播重排（无乐观更新）。未注入时 hover pin 按钮不渲染（旧消费方零破坏）。
   */
  onTogglePin?: (id: string, pinned: boolean) => void;
}

/**
 * 单条会话列表项。expanded（subagent-tree 展开）/ editing（title 编辑态）/ expandOnce 主动刷一次
 * 都是局部 state——行级自治，不污染 panel 层。subagent 变化靠 session_meta 推送。
 */
export function ComponentConversationItem({
  session,
  active,
  childrenView,
  activeSubId,
  onSelect,
  onSelectSub,
  onDelete,
  onContextMenu,
  onRefreshChildren,
  onRenameTitle,
  onTogglePin,
}: Props) {
  const s = session;
  // common.timeAgo.* 相对时间文案
  const { t } = useTranslation(['common', 'chat']);
  // subagent-tree 是否展开：只置 true 不 toggle，无 collapse 入口
  const [expanded, setExpanded] = useState(false);
  // title 编辑态：本组件内部 state（editingId 派生为 boolean 即可，因为每行独立）
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');

  // active 从 true→false 时自动收起 subagent-tree，
  // **但选中本会话的 subagent 不算「切走」**——切到 subagent 只读页面时 parent conv-item
  // active 会变 false（activeSessionId 切到 subSid），若照旧收起会让用户看不到自己刚选的
  // subagent 在 tree 里的高亮位置 + 兄弟列表消失，体验断裂。故引入派生 flag `activeSubIsMyChild`：
  // 当前 activeSubId 是否属于本 conv-item 的 children（running ∪ terminated）。true 时跳过收起 +
  // 兜底渲染 tree（即便用户从未手动 expanded）。
  // 切到无关会话（顶层 / 别的 parent）→ active=false 且 activeSubIsMyChild=false → 仍收起 tree。
  const activeSubIsMyChild = !!(
    activeSubId &&
    childrenView &&
    [...childrenView.running, ...childrenView.terminated].some((c) => c.sessionId === activeSubId)
  );

  useEffect(() => {
    if (!active && !activeSubIsMyChild) {
      setExpanded(false);
    }
  }, [active, activeSubIsMyChild]);

  /**
   * 行点击幂等置 expanded=true + 首次展开主动刷一次 children。
   * 后续 subagent 状态变化靠 page-chat session_meta `_all` 推送的 refreshChildren 兜底。
   */
  const expandOnce = () => {
    if (expanded) return;
    setExpanded(true);
    if (onRefreshChildren) {
      onRefreshChildren(s.id);
    }
  };
  /** save：trim 后非空则调 onRenameTitle；空值放弃 */
  const commitEdit = () => {
    if (!editing) return;
    const trimmed = draftTitle.trim();
    if (trimmed && onRenameTitle) onRenameTitle(s.id, trimmed);
    setEditing(false);
  };
  /** cancel：丢弃 draft，恢复原 title（不清 expanded、不切 active） */
  const cancelEdit = () => setEditing(false);

  const hasSubagent = !!(childrenView && (childrenView.running.length > 0 || childrenView.terminated.length > 0));
  const showUnread = s.unread === true && !active;
  // [v0.0.231] 置顶派生（lazy 默认 false）：true → pin 图标常驻 + 背景加重（§4.2 pinned 视觉基线）
  const isPinned = s.pinned === true;
  // [v0.0.101] running spinner / suspended「?」派生自 session.state：
  //   - state∈{running,interrupting} → SpinnerRing（表「在跑」）
  //   - state==='suspended' → 「?」标记（表「等用户回填」，loop 已退出，running=false INV-2）
  //   - idle/interrupted/error → 均不渲染
  // suspended 排除 running（INV-2：loop 已退出等用户回填，亮「?」非 spinner）
  const isRunningState = s.state === 'running' || s.state === 'interrupting';
  const isSuspendedState = s.state === 'suspended';

  return (
    <div
      data-action-key="chat.session.select"
      data-active={active ? 'true' : 'false'}
      onClick={() => {
        onSelect(s.id);
        // 行点击幂等置 expanded=true（自动展开 subagent-tree；不 toggle，无 collapse）
        if (hasSubagent) expandOnce();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(s.id, e.clientX, e.clientY);
      }}
      // 上下 padding 紧凑（py-1.5），提升 list 视觉密度
      // [v0.0.231] pinned 三层级：active → bg-[var(--surface-3)]（最强，统一替换 bg-accent-surface）
      //   > pinned 常态 bg-bg-warm > 非置顶白底（hover:bg-bg-warm）；全走 token（INV-2）
      className={
        'group relative px-3 py-1.5 rounded-lg cursor-pointer transition-colors mb-0.5 ' +
        (active ? 'bg-[var(--surface-3)]' : isPinned ? 'bg-bg-warm' : 'hover:bg-bg-warm')
      }
    >
      {/*
       * [v0.0.306] 可交互 pin 按钮（替换 v0.0.231 只读 PinIcon）：absolute top-2 right-2
       * 恒占位（visibility:visible，脱离布局流零 reflow）。hover 显隐（group-hover）+
       * pinned 常驻（opacity-100 + text-accent）；未 pin text-muted hover:text-fg。
       * 点击 stopPropagation 防行 onSelect/expandOnce；fire-and-forget 无乐观更新。
       * 仅注入 onTogglePin 时渲染（向后兼容）；未注入保持零按钮。unread 红点 right-[18px] 错位共存。
       */}
      {onTogglePin && (
        <button
          type="button"
          aria-label={isPinned ? t('chat:convPanel.unpin') : t('chat:convPanel.pin')}
          title={isPinned ? t('chat:convPanel.unpin') : t('chat:convPanel.pin')}
          onClick={(e) => {
            e.stopPropagation(); // 不触发行 onSelect/expandOnce
            onTogglePin(s.id, !isPinned);
          }}
          className={
            'absolute top-2 right-2 flex h-5 w-5 items-center justify-center rounded transition-opacity ' +
            (isPinned ? 'text-accent opacity-100' : 'text-muted hover:text-fg opacity-0 group-hover:opacity-100')
          }
          style={{ visibility: 'visible' }} // 恒占位（visibility 不控 display，零 reflow）
        >
          <Icon name={isPinned ? 'pin-filled' : 'pin'} size={12} />
        </button>
      )}
      {/* 未读红点：absolute top-2 7px 圆 var(--danger)（§4.2 / §8 视觉基线）；
          [v0.0.231] right-2 → right-[18px] 统一位移，与 pin 图标错位共存 */}
      {showUnread && (
        <span

          className="absolute top-2 right-[18px] w-[7px] h-[7px] rounded-full bg-[var(--danger)] pointer-events-none"
          aria-hidden="true"
        />
      )}

      {/*
       * title 行：title 贴左 padding 左对齐。编辑态 → input（autoFocus + 全选）；
       * 否则 → span（active 时点 span 进编辑态）。布局稳定性 MANDATORY：input 与 span 同排版槽位
       * （flex-1 + 同字号 13px/medium）。
       * 视觉可见性：编辑态 input 必须有可见编辑指示（否则用户看不出在编辑——ET vision
       *   判定「仍是只读文本」）。方案：outline（脱离布局流，零布局影响）+ bg-surface-2（与父
       *   bg-accent-surface 形成对比）+ box-border 锁外框。禁用会撑大盒模型的 border（除非 box-border）。
       */}
      <div className={'flex items-center mb-0.5 min-w-0' + (isPinned ? ' pr-5' : '')}>
        {/*
         * [v0.0.101] running spinner / suspended「?」槽位（title 左侧）。
         * [2026-07-18 用户裁决] 槽位不再常驻——idle 态不渲染，title 贴左与时间行对齐
         * （原常驻 14px 占位使 idle 项 title 右缩进一段空白，视觉不齐）；
         * 仅 running/suspended 时渲染，出现时 title 微右移属可接受的状态提示。
         */}
        {(isRunningState || isSuspendedState) && (
          <span className="mr-1 inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center">
            {isRunningState && (
              <SpinnerRing />
            )}
            {isSuspendedState && (
              <span

                className="font-mono text-[12px] font-bold leading-none text-[var(--color-accent)]"
                aria-label="suspended"
              >
                ?
              </span>
            )}
          </span>
        )}
        {editing ? (
          <input
            type="text"
            data-action-key="chat.session.rename"
            value={draftTitle}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelEdit();
              }
            }}
            onBlur={commitEdit}
            className="text-[13px] font-medium flex-1 min-w-0 bg-surface-2 text-fg rounded-sm outline outline-2 outline-accent px-1 py-0 box-border"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span

            onClick={(e) => {
              // 仅 active session 可编辑：点 title span 进编辑态（stopPropagation 防 onSelect 二次切）
              if (active) {
                e.stopPropagation();
                setEditing(true);
                setDraftTitle(s.title);
              }
              // 非 active：不阻止冒泡，让行 onClick 走 onSelect 切 active
            }}
            className={
              'text-[13px] font-medium truncate flex-1 min-w-0 ' +
              (active ? 'text-[var(--color-accent)] cursor-text' : 'text-fg')
            }
            title={s.title}
          >
            {s.title}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted font-mono">{fmtTime(s.updatedAt, t)}</span>
        <button
          type="button"
          data-action-key="chat.session.delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(s.id);
          }}
          aria-label={t('chat:conversation.delete.ariaLabel')}
          className="opacity-0 group-hover:opacity-100 text-[11px] text-muted hover:text-[var(--danger)] transition-opacity"
        >
          {t('common:action.delete')}
        </button>
      </div>

      {/* subagent 展开树：行点击置 expanded=true + 有 subagent 时挂载（三段结构）。
       *   兜底：activeSubIsMyChild=true 时即便 expanded=false 也渲染——
       *   用户从未手动展开 parent 但直接选了某 subagent（如外链 / 列表搜索）时，左侧 tree 仍可见。 */}
      {(expanded || activeSubIsMyChild) && hasSubagent && childrenView && (
        <div className="mt-1 -mx-3 -mb-2.5" onClick={(e) => e.stopPropagation()}>
          <ComponentSubagentTree
            parentSessionId={s.id}
            running={childrenView.running}
            terminated={childrenView.terminated}
            activeSubId={activeSubId}
            onSelectSub={onSelectSub}
          />
        </div>
      )}
    </div>
  );
}

export default ComponentConversationItem;
