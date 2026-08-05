/**
 * useTodoCrud —— todo 列表 CRUD hook（仿 useCronCrud）
 * 参考: specs/tech/app/frontend/[P0]component_architecture.md §3.10（useLifecycle 四方法契约）
 *       specs/tech/app/frontend/[P0]lifecycle_data_shapes.md §2.1（Collection 形）
 *       specs/tech/app/frontend/[P0]chat_area_hooks.md §4.2（fanout 扇出受控例外）
 *       specs/api/overall/20-todo.md §3（SSE session_todo_changed 实时化）
 *       specs/ui/components/chat-page/component-todo-modal.md（视图契约）
 *
 * session 级 todo 数据层：
 *   - onInit：GET /session/:sid/todos → Collection<TodoItem>（keyOf=按 id 索引）
 *   - SSE 驱动刷新：session_todo_changed 经 useSessionPanelFanout 扇出 → store.lastTodoEvent，
 *     hook 内 effect 匹配 sessionId 后静默 refetch（订阅归 fanout 唯一枢纽，hook 内不自订 SSE）
 *   - refetch = 静默刷新（GET + mutateCtx 口子）：不 reset ctx/loading——reload() 内部
 *     setCtx(null)+setLoading(true)，SSE 高频触发会致 badge 归 0/列表闪「加载中」，禁用
 *   - delete 写后 refetch；视图只读，update/create 口子留给 follow-up
 *   - badge 语义：未完成主 item 数（status ∉ {done, skipped}；PRD §2.6 拍板「未完成」）
 *
 * 被 component-chat-float-menu（badge 数据源，恒挂载）+ component-todo-modal（弹层列表，
 * 同一 hook 实例复用）共用——badge 与弹层列表同源，SSE refetch 后两处同步更新。
 */
import { useCallback, useEffect, useState } from 'react';
import { deleteTodo, listTodos, type TodoItem, type TodoStatus } from '../../lib/todo-api';
import { useLifecycle } from '../../lib/use-lifecycle';
import { type Collection } from '../../lib/lifecycle-shapes';
import { useChatStore } from '../../store/chat-slice';

/** 已结束状态集合（badge「未完成」= 不在此列；与后端 cleanup_finished 清理目标同口径） */
const FINISHED_STATUSES: ReadonlySet<TodoStatus> = new Set(['done', 'skipped']);

export interface TodoCrud {
  items: TodoItem[];
  loading: boolean;
  error: string | null;
  busyId: string | null;
  /** 未完成主 item 数（float-menu badge 语义） */
  pendingCount: number;
  refetch: () => Promise<void>;
  handleDelete: (item: TodoItem) => Promise<void>;
}

/**
 * @param sessionId 当前 session id（todo 为 session 级）
 */
export function useTodoCrud(sessionId: string): TodoCrud {
  const [busyId, setBusyId] = useState<string | null>(null);
  // mutation 失败的 error（delete / 静默 refetch）。useLifecycle 仅管 init 失败 error，不暴露 setError，
  // 故 mutation catch 单独存 mutError，与 initError 合并对外暴露（与 useCronCrud 同模式）
  const [mutError, setMutError] = useState<string | null>(null);

  // ctx=Collection<TodoItem>（keyOf 按 id 索引）；对外暴露 items=ctx.items。
  const {
    ctx: coll,
    loading,
    error: initError,
    mutateCtx,
  } = useLifecycle<Collection<TodoItem>>({
    onInit: async ({ signal }) => {
      const items = await listTodos(sessionId);
      // 不变量②：fetch 后必须校验 signal.aborted 才能「生效」（杜绝 setState on unmounted）
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return { items, keyOf: (it: TodoItem) => it.id };
    },
    deps: [sessionId],
  });

  // refetch：静默刷新（GET + mutateCtx 口子）——禁走 reload()：runInit 会 setCtx(null)+setLoading(true)，
  // SSE 高频触发会致 badge 归 0/列表闪「加载中」。失败置 mutError 不 throw（事件驱动路径无调用方兜底）
  const refetch = useCallback(async () => {
    setMutError(null);
    try {
      const items = await listTodos(sessionId);
      mutateCtx(() => ({ items, keyOf: (it: TodoItem) => it.id }));
    } catch (e) {
      setMutError(e instanceof Error ? e.message : 'todo 刷新失败');
    }
  }, [sessionId, mutateCtx]);

  // SSE 驱动：store.lastTodoEvent 匹配本 session 才静默 refetch（不匹配 skip）。
  // 幂等已由 store.setLastTodoEvent 按 event.id 保证（同 id 重发不产生新 state，effect 不重触发）
  const lastTodoEvent = useChatStore((s) => s.lastTodoEvent);
  useEffect(() => {
    if (!lastTodoEvent || lastTodoEvent.sessionId !== sessionId) return;
    void refetch();
  }, [lastTodoEvent, sessionId, refetch]);

  // 删除（视图只读不暴露入口；hook 保留写口子供 follow-up 用户编辑）
  const handleDelete = useCallback(
    async (item: TodoItem) => {
      setBusyId(item.id);
      try {
        await deleteTodo(sessionId, item.id);
        await refetch();
      } catch (e) {
        setMutError(e instanceof Error ? e.message : 'todo 删除失败');
      } finally {
        setBusyId(null);
      }
    },
    [sessionId, refetch],
  );

  const items = coll?.items ?? [];
  // items 派生 pendingCount：每 render 重算（items 引用变才变，代价 O(n) 可忽略）
  const pendingCount = items.filter((it) => !FINISHED_STATUSES.has(it.status)).length;

  return {
    items,
    loading,
    error: mutError ?? initError?.message ?? null,
    busyId,
    pendingCount,
    refetch,
    handleDelete,
  };
}
