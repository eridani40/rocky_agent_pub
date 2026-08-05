/**
 * todo-api —— todo UI HTTP 端点 CRUD 薄封装（v0.0.223 新建，仿 cron-api.ts）
 * 参考: specs/api/overall/20-todo.md（todo HTTP API 契约）
 *       app/server/src/agent/todo/todo-store.ts（TodoItem/TodoStep schema 权威）
 *
 * UI 与 agent 工具正交：UI 走 /session/:sid/todos/* HTTP；agent 工具走 todo action，
 * 两者共享底层 TodoStore。所有端点都在 path 显式带 sessionId（UI 必须显式传）。
 */
import { req } from './api-client';

/** todo 5 态 enum（free-form：仅校验 enum，不校验跃迁路径） */
export type TodoStatus = 'not_started' | 'in_progress' | 'done' | 'skipped' | 'error';

/** 主 item 的 source（任务从哪来） */
export interface TodoSource {
  type: 'task' | 'user_message' | 'agent';
  refId?: string;
}

/** 主 item 的 output（要产出什么） */
export interface TodoOutput {
  type: 'file' | 'reply_session' | 'reply_agent';
  refId?: string;
}

/** 步骤（layer 2） */
export interface TodoStep {
  id: string;
  desc: string;
  status: TodoStatus;
}

/** 主 item（layer 1） */
export interface TodoItem {
  id: string;
  desc: string;
  status: TodoStatus;
  source?: TodoSource;
  output?: TodoOutput;
  memo?: string;
  steps: TodoStep[];
  createdAt: string;
  updatedAt: string;
}

/** POST 新建主 item 入参（对齐 20-todo.md §2.2 CreateBody） */
export interface CreateTodoInput {
  desc: string;
  source?: TodoSource;
  output?: TodoOutput;
  memo?: string;
  status?: TodoStatus;
}

/** PATCH 更新主 item 入参（partial） */
export interface UpdateTodoInput {
  desc?: string;
  status?: TodoStatus;
  source?: TodoSource;
  output?: TodoOutput;
  memo?: string;
}

/**
 * GET /session/:sid/todos —— 列当前 session 全部 todo（含已结束未清理的）。
 */
export async function listTodos(sessionId: string, base?: string): Promise<TodoItem[]> {
  const r = await req<{ items: TodoItem[] }>(
    `/session/${encodeURIComponent(sessionId)}/todos`,
    undefined,
    base,
  );
  return r.items ?? [];
}

/**
 * POST /session/:sid/todos —— 建主 item（201 返完整 item / 400 desc_required·invalid_status）。
 */
export async function createTodo(
  sessionId: string,
  input: CreateTodoInput,
  base?: string,
): Promise<TodoItem> {
  return req<TodoItem>(
    `/session/${encodeURIComponent(sessionId)}/todos`,
    { method: 'POST', body: JSON.stringify(input) },
    base,
  );
}

/**
 * PATCH /session/:sid/todos/:itemId —— 改主 item 字段（200 返完整 item / 404 item_not_found）。
 */
export async function updateTodo(
  sessionId: string,
  itemId: string,
  patch: UpdateTodoInput,
  base?: string,
): Promise<TodoItem> {
  return req<TodoItem>(
    `/session/${encodeURIComponent(sessionId)}/todos/${encodeURIComponent(itemId)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
    base,
  );
}

/**
 * DELETE /session/:sid/todos/:itemId —— 删主 item（含步骤）。
 */
export async function deleteTodo(
  sessionId: string,
  itemId: string,
  base?: string,
): Promise<{ id: string; deleted: boolean }> {
  return req(
    `/session/${encodeURIComponent(sessionId)}/todos/${encodeURIComponent(itemId)}`,
    { method: 'DELETE' },
    base,
  );
}
