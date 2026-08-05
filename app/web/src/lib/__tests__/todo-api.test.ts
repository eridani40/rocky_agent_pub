// @vitest-environment jsdom
/**
 * todo-api 单测（v0.0.223 新建，仿 memory-api.test.ts）
 * 参考: specs/api/overall/20-todo.md（todo HTTP API 契约）
 *
 * 覆盖：
 *   - listTodos → GET /session/:sid/todos + items 解包（缺 items → []）
 *   - createTodo → POST URL + body 透传（desc/source/output/memo/status）
 *   - updateTodo → PATCH URL + body（partial patch）
 *   - deleteTodo → DELETE URL
 *   - sessionId/itemId 特殊字符 → encodeURIComponent 转义
 *   - 错误响应（!res.ok）→ 抛 Error（走 req() 统一错误处理）
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  listTodos,
  createTodo,
  updateTodo,
  deleteTodo,
  type TodoItem,
} from '../todo-api';

/** 构造 fetch Response 桩 */
function resJson(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const ITEM: TodoItem = {
  id: '01J',
  desc: '写 spec 文档',
  status: 'in_progress',
  source: { type: 'user_message', refId: 'm1' },
  output: { type: 'file', refId: 'spec.md' },
  memo: '先对齐 conventions',
  steps: [{ id: 's1', desc: '列大纲', status: 'done' }],
  createdAt: '2026-07-30T00:00:00Z',
  updatedAt: '2026-07-30T00:00:00Z',
};

describe('todo-api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('listTodos → GET /session/:sid/todos + 解包 items', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(resJson({ items: [ITEM] }));
    const r = await listTodos('sid-1');
    expect(r).toEqual([ITEM]);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/session/sid-1/todos');
    expect(init?.method).toBeUndefined(); // GET
  });

  it('listTodos 响应缺 items → 兜底空数组', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(resJson({}));
    expect(await listTodos('sid-1')).toEqual([]);
  });

  it('createTodo → POST URL + body 透传（desc/source/output/memo/status）', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(resJson(ITEM, true, 201));
    const input = {
      desc: '写 spec 文档',
      source: { type: 'user_message' as const, refId: 'm1' },
      output: { type: 'file' as const, refId: 'spec.md' },
      memo: '先对齐 conventions',
      status: 'in_progress' as const,
    };
    const r = await createTodo('sid-1', input);
    expect(r).toEqual(ITEM);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/session/sid-1/todos');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it('updateTodo → PATCH /todos/:itemId + body（partial patch）', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(resJson(ITEM));
    const r = await updateTodo('sid-1', '01J', { status: 'done' });
    expect(r).toEqual(ITEM);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/session/sid-1/todos/01J');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ status: 'done' });
  });

  it('deleteTodo → DELETE /todos/:itemId', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(resJson({ id: '01J', deleted: true }));
    const r = await deleteTodo('sid-1', '01J');
    expect(r).toEqual({ id: '01J', deleted: true });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/session/sid-1/todos/01J');
    expect(init?.method).toBe('DELETE');
  });

  it('sessionId/itemId 特殊字符 → encodeURIComponent 转义', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(resJson({ items: [] }));
    await listTodos('sid/with space');
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/session/sid%2Fwith%20space/todos');
  });

  it('错误响应（!res.ok）→ 抛 Error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      resJson({ error: 'todo item not found: x' }, false, 404),
    );
    await expect(deleteTodo('sid-1', 'x')).rejects.toThrow();
  });
});
