/**
 * section-conv-panel —— 会话列表栏（§4.1，[v0.0.182] 可拖 180~400 默认 220）
 * 参考: specs/ui/components/chat-page/_overview.md §4.1（栏：header + 滚动列表 + [v0.0.182] 可拖宽）
 *       设计稿: reqs/v0.0.8/easy-opc-chat-v9a.html .conv-panel（基础视觉）
 *
 * header（标题 + 新建按钮）+ 滚动列表（逐条 component-conversation-item）+ 右缘可选拖宽手柄。
 * 打开 page-chat 时调 GET /session 拉列表。新建调 POST /session。删除调 DELETE /session/:id。
 *
 * [v0.0.182]：宽度受控（去 w-[220px]，改 style width = renderWidth ?? CONV_WIDTH_DEFAULT），
 *   父组件可注入 5 个可选 props 启用拖宽（playground chat 注入；其他消费方不注入则固定宽）。
 *
 * conv-item 行级 state（expanded / 编辑态 / refresh）由 ComponentConversationItem 自治，
 * panel 仅做 header + 列表 map + 右键菜单 shell。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChildrenView, Session } from './types';
import { PlusIcon } from './icons';
import { ComponentConversationItem } from './component-conversation-item';
import { ComponentDeleteSessionConfirmModal } from './component-delete-session-confirm-modal';
import { ComponentColResizeHandle } from './component-col-resize-handle';
import { CONV_WIDTH_DEFAULT, CONV_WIDTH_MAX, CONV_WIDTH_MIN } from '../../lib/layout-width-engine';

interface ConvPanelProps {
  /** 会话列表（顶层项，subagent 不作顶层项——page-chat 层已据 type 过滤） */
  sessions: Session[];
  /** 当前 active session id */
  activeId: string | null;
  /** parent → children 视图（仅 parent 项有值；来自 GET /session/:id/children） */
  childrenByParent: Record<string, ChildrenView>;
  /** 当前 active 的 subagent sessionId（subagent-tree 高亮用） */
  activeSubId?: string;
  /** 列表加载错误文案 */
  error?: string | null;
  /** 选中会话（顶层） */
  onSelect: (id: string) => void;
  /** 选中 subagent 子项 → 切到 subagent 只读页面（§5 交互8） */
  onSelectSub: (subSessionId: string) => void;
  /** 新建会话 */
  onCreate: () => void;
  /** 删除会话 */
  onDelete: (id: string) => void;
  /** 行点击展开时刷新 children（可选，向后兼容单测） */
  onRefreshChildren?: (parentId: string) => void;
  /** conv-item title 编辑态 save 回调（父 PUT {title, titled:true}） */
  onRenameTitle?: (id: string, newTitle: string) => void;
  /** [v0.0.231] 置顶/取消置顶回调（父 fire-and-forget PUT {pinned}；仅 playground 注入） */
  onTogglePin?: (id: string, pinned: boolean) => void;
  // ── [v0.0.182] 可拖宽契约（5 可选 props，仅 playground chat 注入；其他消费方零破坏） ──
  /** 父引擎钳制后的渲染宽（缺省回退 CONV_WIDTH_DEFAULT=220） */
  renderWidth?: number;
  /** 拖宽动态上限（dragDynMax(available, rightCurrent)，缺省回退静态 CONV_WIDTH_MAX=400） */
  dragMaxWidth?: number;
  /** 拖动回调（drag 期间持续更新 convWidth） */
  onConvResize?: (width: number) => void;
  /** mousedown 触发（父挂 setDragging('left') 进场景 A） */
  onConvDragStart?: () => void;
  /** mouseup 触发（父 persist localStorage + setDragging(null)） */
  onConvResizeEnd?: () => void;
}

/**
 * 会话列表栏 shell。header + 滚动列表（map ComponentConversationItem）+ 右键菜单 + [v0.0.182] 可选右缘拖宽手柄。
 */
export function SectionConvPanel({
  sessions,
  activeId,
  childrenByParent,
  activeSubId,
  error,
  onSelect,
  onSelectSub,
  onCreate,
  onDelete,
  onRefreshChildren,
  onRenameTitle,
  onTogglePin,
  renderWidth,
  dragMaxWidth,
  onConvResize,
  onConvDragStart,
  onConvResizeEnd,
}: ConvPanelProps) {
  // 右键菜单 state（panel 层单一浮层，contextMenu session id + 屏幕坐标）
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  // 删除确认 state：列表项「删除」按钮先弹二次确认 modal（仿 clear-confirm），确认后才真删
  const [confirmDel, setConfirmDel] = useState<Session | null>(null);
  const { t } = useTranslation('chat');
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    // 延迟注册：躲开「打开菜单的同一次 contextmenu 事件」冒泡到 window 立刻触发 close（菜单一开就关 bug）
    const timer = setTimeout(() => {
      window.addEventListener('click', close);
      window.addEventListener('contextmenu', close);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  return (
    <aside

      style={{ width: renderWidth ?? CONV_WIDTH_DEFAULT }}
      className="relative shrink-0 bg-surface border-r border-border flex flex-col"
    >
      <div className="px-4 pt-4 pb-3 flex justify-between items-center shrink-0">
        <span className="text-[11px] font-semibold text-[var(--color-muted-2)] uppercase tracking-wider font-mono">
          {t('convPanel.title')}
        </span>
        <button
          type="button"
          data-action-key="chat.session.create"
          onClick={onCreate}
          aria-label={t('convPanel.create')}
          className="w-6 h-6 flex items-center justify-center text-muted rounded-md hover:bg-accent-surface hover:text-[var(--color-accent)] transition-colors"
        >
          <PlusIcon size={14} />
        </button>
      </div>

      <div

        className="flex-1 overflow-y-auto px-2 pb-2"
      >
        {error && <div className="px-3 py-2 text-[11px] text-[var(--danger)]">{error}</div>}
        {sessions.length === 0 && !error && (
          <div className="px-3 py-2 text-[11px] text-muted">{t('convPanel.empty')}</div>
        )}
        {sessions.map((s) => (
          <ComponentConversationItem
            key={s.id}
            session={s}
            active={s.id === activeId}
            childrenView={childrenByParent[s.id]}
            activeSubId={activeSubId}
            onSelect={onSelect}
            onSelectSub={onSelectSub}
            onDelete={(id) => setConfirmDel(sessions.find((x) => x.id === id) ?? null)}
            onContextMenu={(sessionId, x, y) => setContextMenu({ sessionId, x, y })}
            onRefreshChildren={onRefreshChildren}
            onRenameTitle={onRenameTitle}
            onTogglePin={onTogglePin}
          />
        ))}
      </div>

      {/* 右键菜单：[v0.0.231] 置顶/取消置顶（仅注入 onTogglePin 时渲染） + 复制 Session ID */}
      {contextMenu && (
        <div

          className="fixed z-50 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md shadow-md py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {onTogglePin && (() => {
            // 文案按当前 pinned 派生（置顶 ↔ 取消置顶）；fire-and-forget，归位靠 session_meta 广播重排
            const cur = sessions.find((x) => x.id === contextMenu.sessionId)?.pinned === true;
            return (
              <button
                type="button"
                data-action-key="chat.session.pin"
                onClick={() => {
                  onTogglePin(contextMenu.sessionId, !cur);
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-bg-warm)] transition-colors"
              >
                {cur ? t('convPanel.unpin') : t('convPanel.pin')}
              </button>
            );
          })()}
          <button
            type="button"
            data-action-key="chat.session.copy-id"
            onClick={() => {
              navigator.clipboard.writeText(contextMenu.sessionId);
              setContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-bg-warm)] transition-colors"
          >
            {t('convPanel.copySessionId')}
          </button>
        </div>
      )}

      {/* 删除会话二次确认 modal（L3 Portal，danger 色）。确认 → 真删；取消/点遮罩 → 关闭不动。 */}
      <ComponentDeleteSessionConfirmModal
        open={!!confirmDel}
        sessionTitle={confirmDel?.title}
        onConfirm={() => {
          if (confirmDel) onDelete(confirmDel.id);
          setConfirmDel(null);
        }}
        onCancel={() => setConfirmDel(null)}
      />

      {/* [v0.0.182] 右缘拖宽手柄（仅 onConvResize 注入时渲染；不带 testid——用户裁决 2026-07-20） */}
      {onConvResize && (
        <ComponentColResizeHandle
          side="left"
          currentWidth={renderWidth ?? CONV_WIDTH_DEFAULT}
          minWidth={CONV_WIDTH_MIN}
          maxWidth={Math.min(CONV_WIDTH_MAX, dragMaxWidth ?? CONV_WIDTH_MAX)}
          onResize={onConvResize}
          onDragStart={onConvDragStart}
          onResizeEnd={onConvResizeEnd}
          ariaLabel={t('convPanel.resize.ariaLabel')}
          title={t('convPanel.resize.title')}
        />
      )}
    </aside>
  );
}

export default SectionConvPanel;
