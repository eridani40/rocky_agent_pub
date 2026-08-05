// @vitest-environment jsdom
/**
 * useTodoCrud 单测（仿 use-cron-crud.test.ts）
 * 参考: specs/api/overall/20-todo.md §3（SSE session_todo_changed 实时化）
 *       specs/prd/version_logs/v0.0.223.md §2.6（badge=未完成主 item 数）
 *       specs/tech/app/frontend/[P0]chat_area_hooks.md §4.2（fanout 扇出受控例外）
 *       app/web/src/components/chat-page/use-todo-crud.ts
 *
 * 覆盖：
 *   - 挂载 GET 列表（listTodos 调用一次，items 写入）
 *   - pendingCount = 未完成主 item 数（status ∉ {done, skipped}；error 计入未完成）
 *   - delete 后 refetch（重新 GET）
 *   - refetch 静默刷新：GET + items 更新，飞行中旧数据保留、loading 不翻转（禁 reload 闪烁）
 *   - SSE 驱动：store.lastTodoEvent 匹配 sid → 静默 refetch；不匹配 sid skip；同 id 幂等不重复
 *
 * mock 策略：vi.hoisted + __dirname 派生绝对路径 mock todo-api（MEMORY test-vitest-mock-absolute-path），
 * useLifecycle 本身不 mock（真实跑，验证 hook 端到端行为）；chat store 用真实单例（每用例重置）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { TodoItem, TodoStatus } from '../../../lib/todo-api';
import { useChatStore } from '../../../store/chat-slice';
import type { SessionTodoChangedEvent } from '../../../store/session-slice-reducer';

const apiMocks = vi.hoisted(() => ({
  listTodos: vi.fn(),
  createTodo: vi.fn(),
  updateTodo: vi.fn(),
  deleteTodo: vi.fn(),
}));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/todo-api'));

vi.mock(apiPath, () => apiMocks);

import { useTodoCrud } from '../use-todo-crud';

function mkItem(id: string, status: TodoStatus): TodoItem {
  return {
    id,
    desc: `todo-${id}`,
    status,
    steps: [],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  };
}

/** 构造 session_todo_changed 事件（shape 对齐 session_event.md §2，data 空对象） */
function mkTodoEvt(id: string, sessionId: string): SessionTodoChangedEvent {
  return { id, type: 'session_todo_changed', sessionId, createdAt: '2026-07-31T00:00:00.000Z', data: {} };
}

/** 排空 hook 挂载后异步副作用（onInit await），act 内结算 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  apiMocks.listTodos.mockReset().mockResolvedValue([]);
  apiMocks.deleteTodo.mockReset().mockResolvedValue({ id: 't1', deleted: true });
  useChatStore.setState({ lastTodoEvent: null });
});
afterEach(() => {
  vi.clearAllMocks();
  // 注意：store 重置只放 beforeEach——afterEach 时 hook 仍挂载（RTL cleanup 后跑），
  // 此时写 store 会触发未包 act 的 React 更新告警
});

describe('useTodoCrud — 挂载 GET 列表', () => {
  it('mount → listTodos(sessionId) 调用一次，items 写入', async () => {
    const items = [mkItem('t1', 'in_progress'), mkItem('t2', 'done')];
    apiMocks.listTodos.mockResolvedValue(items);
    const { result } = renderHook(() => useTodoCrud('s1'));
    await settle();
    expect(apiMocks.listTodos).toHaveBeenCalledTimes(1);
    expect(apiMocks.listTodos).toHaveBeenCalledWith('s1');
    expect(result.current.items).toEqual(items);
    expect(result.current.loading).toBe(false);
  });
});

describe('useTodoCrud — pendingCount badge 语义（未完成主 item 数）', () => {
  it('done/skipped 不计入；not_started/in_progress/error 计入', async () => {
    apiMocks.listTodos.mockResolvedValue([
      mkItem('t1', 'not_started'),
      mkItem('t2', 'in_progress'),
      mkItem('t3', 'error'),
      mkItem('t4', 'done'),
      mkItem('t5', 'skipped'),
    ]);
    const { result } = renderHook(() => useTodoCrud('s1'));
    await settle();
    expect(result.current.pendingCount).toBe(3);
  });

  it('全部已结束（done/skipped）→ pendingCount=0', async () => {
    apiMocks.listTodos.mockResolvedValue([mkItem('t1', 'done'), mkItem('t2', 'skipped')]);
    const { result } = renderHook(() => useTodoCrud('s1'));
    await settle();
    expect(result.current.pendingCount).toBe(0);
  });
});

describe('useTodoCrud — delete 后 refetch', () => {
  it('handleDelete 后重新 GET（refetch）', async () => {
    const item = mkItem('t1', 'in_progress');
    apiMocks.listTodos.mockResolvedValue([item]);
    const { result } = renderHook(() => useTodoCrud('s1'));
    await settle();
    expect(apiMocks.listTodos).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.handleDelete(item);
    });
    expect(apiMocks.deleteTodo).toHaveBeenCalledWith('s1', 't1');
    expect(apiMocks.listTodos).toHaveBeenCalledTimes(2);
  });

  it('handleDelete 失败 → error 暴露 + busyId 复位', async () => {
    const item = mkItem('t1', 'in_progress');
    apiMocks.listTodos.mockResolvedValue([item]);
    apiMocks.deleteTodo.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useTodoCrud('s1'));
    await settle();
    await act(async () => {
      await result.current.handleDelete(item);
    });
    expect(result.current.error).toBe('boom');
    expect(result.current.busyId).toBeNull();
  });
});

describe('useTodoCrud — refetch 静默刷新（禁 reload 闪烁）', () => {
  it('refetch 飞行中旧 items 保留 + loading 不翻转（reload 会 setCtx(null) → items 清空闪烁）', async () => {
    apiMocks.listTodos.mockResolvedValue([mkItem('t1', 'in_progress')]);
    const { result } = renderHook(() => useTodoCrud('s1'));
    await settle();
    expect(result.current.items.map((i) => i.id)).toEqual(['t1']);

    // 挂起第二次 GET（飞行中观测中间态）
    let resolveSecond: (v: TodoItem[]) => void = () => {};
    apiMocks.listTodos.mockImplementation(
      () => new Promise<TodoItem[]>((r) => { resolveSecond = r; }),
    );
    act(() => {
      void result.current.refetch();
    });
    // 飞行中：旧 items 保留（无 ctx-null 闪烁）、loading 不翻转（badge 不归 0）
    expect(result.current.items.map((i) => i.id)).toEqual(['t1']);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveSecond([mkItem('t2', 'done')]);
    });
    expect(result.current.items.map((i) => i.id)).toEqual(['t2']);
    expect(result.current.loading).toBe(false);
  });

  it('refetch 失败 → error 暴露不 throw（事件驱动路径无调用方兜底）', async () => {
    apiMocks.listTodos.mockResolvedValue([mkItem('t1', 'in_progress')]);
    const { result } = renderHook(() => useTodoCrud('s1'));
    await settle();
    apiMocks.listTodos.mockRejectedValue(new Error('net-down'));
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.error).toBe('net-down');
    // 失败不清空既有数据
    expect(result.current.items.map((i) => i.id)).toEqual(['t1']);
  });
});

describe('useTodoCrud — SSE 驱动刷新（session_todo_changed → store.lastTodoEvent）', () => {
  it('store.lastTodoEvent 写入匹配 sid → 静默 refetch（items 更新且 loading 不翻转）', async () => {
    apiMocks.listTodos.mockResolvedValue([mkItem('t1', 'in_progress')]);
    const { result } = renderHook(() => useTodoCrud('s1'));
    await settle();
    expect(apiMocks.listTodos).toHaveBeenCalledTimes(1);

    // SSE 事件到达（经 fanout 写 store）：后端新数据
    apiMocks.listTodos.mockResolvedValue([mkItem('t1', 'done'), mkItem('t2', 'in_progress')]);
    act(() => {
      useChatStore.getState().setLastTodoEvent(mkTodoEvt('evt-1', 's1'));
    });
    await settle();
    expect(apiMocks.listTodos).toHaveBeenCalledTimes(2);
    expect(result.current.items.map((i) => i.id)).toEqual(['t1', 't2']);
    expect(result.current.loading).toBe(false);
    expect(result.current.pendingCount).toBe(1);
  });

  it('不匹配 sid → 不 refetch', async () => {
    apiMocks.listTodos.mockResolvedValue([mkItem('t1', 'in_progress')]);
    renderHook(() => useTodoCrud('s1'));
    await settle();
    expect(apiMocks.listTodos).toHaveBeenCalledTimes(1);

    act(() => {
      useChatStore.getState().setLastTodoEvent(mkTodoEvt('evt-2', 's-other'));
    });
    await settle();
    expect(apiMocks.listTodos).toHaveBeenCalledTimes(1);
  });

  it('同 id 事件重发（SSE 重连）→ store 幂等 skip 不重复 refetch', async () => {
    apiMocks.listTodos.mockResolvedValue([mkItem('t1', 'in_progress')]);
    renderHook(() => useTodoCrud('s1'));
    await settle();
    const evt = mkTodoEvt('evt-3', 's1');
    act(() => {
      useChatStore.getState().setLastTodoEvent(evt);
    });
    await settle();
    expect(apiMocks.listTodos).toHaveBeenCalledTimes(2);

    // 同 id 重发：store 幂等（state 不变），不再 refetch
    act(() => {
      useChatStore.getState().setLastTodoEvent(evt);
    });
    await settle();
    expect(apiMocks.listTodos).toHaveBeenCalledTimes(2);
    // 新 id 事件：正常再触发
    act(() => {
      useChatStore.getState().setLastTodoEvent(mkTodoEvt('evt-4', 's1'));
    });
    await settle();
    expect(apiMocks.listTodos).toHaveBeenCalledTimes(3);
  });
});
