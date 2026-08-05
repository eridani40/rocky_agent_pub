/**
 * component-todo-modal —— todo 待办弹层（双层树只读视图，v0.0.223 新建）
 * 参考: specs/ui/components/chat-page/component-todo-modal.md（组件契约）
 *       specs/prd/version_logs/v0.0.223.md §2.6（产品语义）
 *       specs/api/overall/20-todo.md（数据契约）
 *
 * 结构（仿 component-cron-modal L3 modal 壳）：
 *   - 标题栏（待办清单 + 关闭）+ body 双层树
 *   - 主 item 行：状态徽章 + desc + 步骤进度 N/M（steps 非空才渲染）
 *   - 步骤行：缩进在主 item 下（状态徽章 + desc）
 *   - 悬停状态徽章 → 主 item 正下方绝对定位详情面板（source/output/memo，只读）——
 *     overlay 不推挤布局；触发域仅状态徽章（item 行最左 STATUS_STYLE 徽章，
 *     data-action-key=chat.todo.item.status）；步骤行 / 主 item 行其余区域 hover 不触发；
 *     移出徽章即收起（含下移进弹层）
 * 只读：todo 是 agent 自主维护的工具数据，点击不做任何事（编辑归 follow-up）。
 * 打开（挂载）即调一次 crud.refetch() 静默刷新（skills 弹层先例，component-chat-float-menu.md §7）。
 * crud 由父（component-chat-float-menu）恒挂载后以 prop 下传——badge 与弹层列表同一数据源。
 * 视觉基线：待设计师 demo（先按现有 token + cron modal 风格做交互逻辑）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TodoItem, TodoStatus } from '../../lib/todo-api';
import { CloseIcon } from './icons';
import { Portal } from '../../lib/portal';
import type { TodoCrud } from './use-todo-crud';

export interface ComponentTodoModalProps {
  /** float-menu 恒挂载的 useTodoCrud 实例（badge 同源） */
  crud: TodoCrud;
  /** 关闭弹层 */
  onClose: () => void;
}

/** 状态徽章配色（not_started 灰待机 / in_progress 蓝 / done success 绿 / skipped 灰降透明 / error 橙；
 *  done 与 tool-call「✓ done」同款 --success 语义色，与 skipped 靠色相拉开；只用既有 token 零硬编码 hex） */
const STATUS_STYLE: Record<TodoStatus, string> = {
  not_started: 'text-muted-2 bg-bg-warm',
  in_progress: 'text-accent bg-accent/10',
  done: 'text-[var(--success)] bg-[var(--success-bg)]',
  skipped: 'text-muted-2 bg-bg-warm opacity-60',
  error: 'text-[var(--warning)] bg-[var(--warning-bg)]',
};

/** 单个主 item（双层树根节点 + 悬停详情） */
function TodoItemRow({ item, hover, onHover, onLeave }: {
  item: TodoItem;
  hover: boolean;
  onHover: () => void;
  onLeave: () => void;
}) {
  const { t } = useTranslation('chat');
  const doneSteps = item.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  // 悬停详情有内容才渲染面板（source/output/memo 全空 → 不弹）
  const hasDetail = Boolean(item.source || item.output || item.memo);

  return (
    <div>
      {/* 主 item 行容器：relative 定位上下文（仅为详情弹层提供定位基准，不挂 hover）。 */}
      <div className="relative">
        {/* 主 item 行（只读，点击无行为）；hover 不触发详情弹层（v0.0.240：触发域迁到下方状态徽章） */}
        <div data-action-key="chat.todo.item" className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg-warm">
          {/* 状态徽章（item 行最左 STATUS_STYLE 徽章）——hover 触发域（v0.0.240 从主 item 行收窄到徽章；
              data-action-key=chat.todo.item.status 供 executor/UT 锚点定位；移出即收起含下移进弹层） */}
          <span data-action-key="chat.todo.item.status" onMouseEnter={onHover} onMouseLeave={onLeave} className={`shrink-0 rounded px-1 py-0.5 font-mono text-[10px] ${STATUS_STYLE[item.status]}`}>
            {t(`todoModal.status.${item.status}`)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2">{item.desc}</span>
          {item.steps.length > 0 && (
            <span className="shrink-0 font-mono text-[10px] text-muted">
              {t('todoModal.stepsProgress', { done: doneSteps, total: item.steps.length })}
            </span>
          )}
        </div>

        {/* 悬停详情面板（绝对定位 overlay：主 item 行正下方、覆盖步骤层之上，不推挤后续行——布局稳定） */}
        {hover && hasDetail && (
          <div className="absolute left-2 right-2 top-full z-10 mt-0.5 flex flex-col gap-0.5 rounded-md border border-border-2 bg-surface px-3 py-2 font-mono text-[10.5px] text-muted-2 shadow-lg">
            {item.source && (
              <div>
                {t('todoModal.source')} · {t(`todoModal.sourceType.${item.source.type}`)}
                {item.source.refId ? ` · ${item.source.refId}` : ''}
              </div>
            )}
            {item.output && (
              <div>
                {t('todoModal.output')} · {t(`todoModal.outputType.${item.output.type}`)}
                {item.output.refId ? ` · ${item.output.refId}` : ''}
              </div>
            )}
            {item.memo && (
              <div className="whitespace-pre-wrap break-all">
                {t('todoModal.memo')} · {item.memo}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 步骤层（layer 2，缩进）——在 hover 容器外：步骤行 hover 不触发详情弹层 */}
      {item.steps.length > 0 && (
        <div className="ml-7 flex flex-col">
          {item.steps.map((s) => (
            <div key={s.id} className="flex items-center gap-2 px-2 py-1">
              <span className={`shrink-0 rounded px-1 py-0.5 font-mono text-[9.5px] ${STATUS_STYLE[s.status]}`}>
                {t(`todoModal.status.${s.status}`)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted-2">{s.desc}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** todo 待办弹层（只读双层树） */
export function ComponentTodoModal({ crud, onClose }: ComponentTodoModalProps) {
  const { items, loading, error, refetch } = crud;
  const { t } = useTranslation('chat');
  const { t: tCommon } = useTranslation('common');
  const [hoverId, setHoverId] = useState<string | null>(null);

  // 弹层每次打开（挂载）静默刷新一次（skills 弹层先例，component-chat-float-menu.md §7）；
  // hook 本体恒挂载于 float-menu 不随开关重 GET——刷新只发生在打开这一刻，与 SSE 实时增量互补
  useEffect(() => {
    void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // L3 modal（_layering.md §3A）：包 <Portal> 到 overlay-root，脱离 overlay 的 pointer-events:none 链。
  return (
    <Portal>
      <div
        // z=`--z-modal`(1000) + pointer-events-auto 双保险（与 cron-modal 统一规矩）
        className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[rgba(30,25,20,0.45)] backdrop-blur-sm pointer-events-auto"
        onClick={onClose}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="relative flex max-h-[88vh] w-[720px] max-w-[92vw] flex-col rounded-[14px] border border-border-2 bg-surface shadow-2xl"
        >
          {/* head：标题 + 关闭（只读视图无二级导航/新建按钮） */}
          <div className="flex shrink-0 items-center gap-2 px-[22px] pb-3 pt-[18px]">
            <span className="flex-1 text-[15px] font-bold text-fg">{t('todoModal.title')}</span>
            <button
              type="button"
              data-action-key="chat.todo.close"
              aria-label={tCommon('modal.close')}
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-warm hover:text-fg"
            >
              <CloseIcon size={16} />
            </button>
          </div>

          {/* body：双层树 / 空态 / 加载 / 错误 */}
          <div className="flex flex-col overflow-y-auto px-[22px] pb-5">
            {loading && items.length === 0 ? (
              <div className="py-6 text-center font-mono text-[11px] text-muted">{tCommon('status.loading')}</div>
            ) : error ? (
              <div role="alert" className="py-4 text-center text-[12px] text-[var(--danger)]">{error}</div>
            ) : items.length === 0 ? (
              <div className="px-6 py-12 text-center text-muted">
                <div className="mb-1 text-[24px]" aria-hidden>✓</div>
                <b className="block text-[13px] text-muted-2">{t('todoModal.empty')}</b>
                <span className="text-[12px]">{t('todoModal.emptyHint')}</span>
              </div>
            ) : (
              items.map((item) => (
                <TodoItemRow
                  key={item.id}
                  item={item}
                  hover={hoverId === item.id}
                  onHover={() => setHoverId(item.id)}
                  onLeave={() => setHoverId((h) => (h === item.id ? null : h))}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}

export default ComponentTodoModal;
