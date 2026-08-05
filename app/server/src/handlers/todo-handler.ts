/**
 * todo UI HTTP handler — 7 端点（与 todo 工具正交，共享 todoStore）。
 * 参考: specs/api/overall/20-todo.md（7 UI 端点契约）
 *       specs/tech/agent/tools/[P1]todo_tools.md §7（HTTP API 权威）
 *       app/server/src/handlers/cron-handler.ts（路由形态 + 鉴权模式参照）
 *
 * 设计：
 *   - 路由形态：/session/:sessionId/todos[/:itemId[/steps[/:stepId]]] + /todos/cleanup
 *   - 与 todo 工具完全正交：共享 TodoStore，互不感知（同 cron 与 cron 工具关系）
 *   - 鉴权与 /session/:id/memory 同模式：仅 session 存在校验；不含 user 权限
 *   - 仅 session 级读写，不跨 session
 *
 * 端点（todo_tools.md §7）：
 *   GET    /session/:sid/todos                       — 列全部
 *   POST   /session/:sid/todos                       — add_item
 *   PATCH  /session/:sid/todos/:itemId               — update_item（body: patch）
 *   DELETE /session/:sid/todos/:itemId               — delete_item
 *   POST   /session/:sid/todos/:itemId/steps         — add_step
 *   PATCH  /session/:sid/todos/:itemId/steps/:stepId — update_step
 *   POST   /session/:sid/todos/cleanup               — cleanup_finished
 */
import type { SessionStore } from '../agent/session-store';
import type { TodoStore, TodoItem, TodoStatus } from '../agent/todo/todo-store';
import { isTodoStatus, parseTodoSource, parseTodoOutput } from '../agent/todo/todo-store';

/** TodoRouteDeps（router 注入；bootstrap 装配后透传） */
export interface TodoRouteDeps {
  todoStore: TodoStore;
  sessionStore: SessionStore;
}

/** JSON Response 构造（与现有 handler 一致） */
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 校验 session 存在（与 cron handler 同模式，404 不存在） */
async function ensureSession(deps: TodoRouteDeps, sessionId: string): Promise<Response | null> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) return json(404, { error: `session not found: ${sessionId}` });
  return null;
}

/** 取 item（不存在 → null） */
async function findItem(deps: TodoRouteDeps, sessionId: string, itemId: string): Promise<TodoItem | null> {
  const items = await deps.todoStore.listBySession(sessionId);
  return items.find((it) => it.id === itemId) ?? null;
}

// ============================================================
// 端点实现
// ============================================================

/** GET /session/:sid/todos — 列全部 */
async function handleList(deps: TodoRouteDeps, sessionId: string): Promise<Response> {
  const notFound = await ensureSession(deps, sessionId);
  if (notFound) return notFound;
  const items = await deps.todoStore.listBySession(sessionId);
  return json(200, { items });
}

/** POST /session/:sid/todos — add_item（body: {desc, status?, source?, output?, memo?}） */
async function handleCreate(deps: TodoRouteDeps, req: Request, sessionId: string): Promise<Response> {
  const notFound = await ensureSession(deps, sessionId);
  if (notFound) return notFound;
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return json(400, { error: 'invalid JSON body' }); }
  const desc = typeof body.desc === 'string' ? body.desc.trim() : '';
  if (!desc) return json(400, { error: 'desc required' });
  const now = new Date().toISOString();
  const item: TodoItem = {
    id: deps.todoStore.nextId(),
    desc,
    status: parseStatus(body.status, 'not_started'),
    steps: [],
    createdAt: now,
    updatedAt: now,
  };
  if (body.memo != null) item.memo = String(body.memo);
  // source/output（todo_tools.md §2.1；部分合法也接受，与工具层共享 parseTodoSource/parseTodoOutput）
  const source = parseTodoSource(body.source);
  if (source) item.source = source;
  const output = parseTodoOutput(body.output);
  if (output) item.output = output;
  try {
    await deps.todoStore.upsertItem(sessionId, item);
  } catch (e) {
    return json(500, { error: `todo create failed: ${e instanceof Error ? e.message : String(e)}` });
  }
  // spec 20-todo.md §2.2：写操作返小对象 {itemId}（完整对象走 GET /todos）
  return json(201, { itemId: item.id });
}

/** PATCH /session/:sid/todos/:itemId — update_item（body: patch） */
async function handleUpdateItem(deps: TodoRouteDeps, req: Request, sessionId: string, itemId: string): Promise<Response> {
  const notFound = await ensureSession(deps, sessionId);
  if (notFound) return notFound;
  const item = await findItem(deps, sessionId, itemId);
  if (!item) return json(404, { error: `todo item not found: ${itemId}` });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return json(400, { error: 'invalid JSON body' }); }
  const next: TodoItem = { ...item, steps: [...item.steps] };
  if (typeof body.desc === 'string') next.desc = body.desc;
  if (body.status != null) {
    if (!isTodoStatus(String(body.status))) return json(400, { error: `invalid status: ${body.status}` });
    next.status = body.status as TodoStatus;
  }
  if (typeof body.memo === 'string') next.memo = body.memo;
  await deps.todoStore.upsertItem(sessionId, next);
  // spec 20-todo.md §2.3：update_item 返 {itemId}
  return json(200, { itemId });
}

/** DELETE /session/:sid/todos/:itemId — delete_item */
async function handleDeleteItem(deps: TodoRouteDeps, sessionId: string, itemId: string): Promise<Response> {
  const notFound = await ensureSession(deps, sessionId);
  if (notFound) return notFound;
  const removed = await deps.todoStore.removeItem(sessionId, itemId);
  if (!removed) return json(404, { error: `todo item not found: ${itemId}` });
  return json(200, { id: itemId, deleted: true });
}

/** POST /session/:sid/todos/:itemId/steps — add_step（body: {desc, status?}） */
async function handleAddStep(deps: TodoRouteDeps, req: Request, sessionId: string, itemId: string): Promise<Response> {
  const notFound = await ensureSession(deps, sessionId);
  if (notFound) return notFound;
  const item = await findItem(deps, sessionId, itemId);
  if (!item) return json(404, { error: `todo item not found: ${itemId}` });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return json(400, { error: 'invalid JSON body' }); }
  const desc = typeof body.desc === 'string' ? body.desc.trim() : '';
  if (!desc) return json(400, { error: 'desc required' });
  const step = { id: deps.todoStore.nextId(), desc, status: parseStatus(body.status, 'not_started') };
  const next: TodoItem = { ...item, steps: [...item.steps, step] };
  await deps.todoStore.upsertItem(sessionId, next);
  // spec 20-todo.md §2.5：add_step 返 {itemId, stepId}
  return json(201, { itemId, stepId: step.id });
}

/** PATCH /session/:sid/todos/:itemId/steps/:stepId — update_step */
async function handleUpdateStep(
  deps: TodoRouteDeps, req: Request, sessionId: string, itemId: string, stepId: string,
): Promise<Response> {
  const notFound = await ensureSession(deps, sessionId);
  if (notFound) return notFound;
  const item = await findItem(deps, sessionId, itemId);
  if (!item) return json(404, { error: `todo item not found: ${itemId}` });
  const stepIdx = item.steps.findIndex((s) => s.id === stepId);
  if (stepIdx < 0) return json(404, { error: `todo step not found: ${stepId}` });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return json(400, { error: 'invalid JSON body' }); }
  const step = { ...item.steps[stepIdx]! };
  if (typeof body.desc === 'string') step.desc = body.desc;
  if (body.status != null) {
    if (!isTodoStatus(String(body.status))) return json(400, { error: `invalid status: ${body.status}` });
    step.status = body.status as TodoStatus;
  }
  const steps = [...item.steps];
  steps[stepIdx] = step;
  await deps.todoStore.upsertItem(sessionId, { ...item, steps });
  // spec 20-todo.md §2.6：update_step 返 {itemId, stepId}
  return json(200, { itemId, stepId });
}

/** POST /session/:sid/todos/cleanup — cleanup_finished */
async function handleCleanup(deps: TodoRouteDeps, sessionId: string): Promise<Response> {
  const notFound = await ensureSession(deps, sessionId);
  if (notFound) return notFound;
  const removed = await deps.todoStore.cleanupFinished(sessionId);
  return json(200, { removed });
}

/** 解析 status 入参（缺省返 fallback） */
function parseStatus(raw: unknown, fallback: TodoStatus): TodoStatus {
  if (typeof raw === 'string' && isTodoStatus(raw)) return raw;
  return fallback;
}

// ============================================================
// 路由分发入口（session-routes 调）
// ============================================================

/**
 * /session/:sessionId/todos* 路由分发入口。
 * @returns 503 当 todoStore 未注入（bootstrap 未装配时；正常生产路径不应到达）
 */
export async function handleTodoRoute(
  req: Request,
  method: string,
  path: string,
  deps: TodoRouteDeps | null,
): Promise<Response> {
  if (!deps) {
    return json(503, { error: 'todo subsystem not bootstrapped (todoStore missing)' });
  }
  // /session/:sid/todos/cleanup（先匹配，避免被 :itemId 吞）
  const cleanupMatch = path.match(/^\/session\/([^/]+)\/todos\/cleanup$/);
  if (cleanupMatch) {
    if (method !== 'POST') return json(405, { error: 'Method Not Allowed' }, { allow: 'POST' });
    return handleCleanup(deps, cleanupMatch[1]!);
  }
  // /session/:sid/todos/:itemId/steps/:stepId
  const stepItemMatch = path.match(/^\/session\/([^/]+)\/todos\/([^/]+)\/steps\/([^/]+)$/);
  if (stepItemMatch) {
    const [, sid, itemId, stepId] = stepItemMatch;
    if (method === 'PATCH') return handleUpdateStep(deps, req, sid!, itemId!, stepId!);
    return json(405, { error: 'Method Not Allowed' }, { allow: 'PATCH' });
  }
  // /session/:sid/todos/:itemId/steps
  const stepsMatch = path.match(/^\/session\/([^/]+)\/todos\/([^/]+)\/steps$/);
  if (stepsMatch) {
    const [, sid, itemId] = stepsMatch;
    if (method === 'POST') return handleAddStep(deps, req, sid!, itemId!);
    return json(405, { error: 'Method Not Allowed' }, { allow: 'POST' });
  }
  // /session/:sid/todos/:itemId
  const itemMatch = path.match(/^\/session\/([^/]+)\/todos\/([^/]+)$/);
  if (itemMatch) {
    const sid = itemMatch[1]!;
    const itemId = itemMatch[2]!;
    if (method === 'PATCH') return handleUpdateItem(deps, req, sid, itemId);
    if (method === 'DELETE') return handleDeleteItem(deps, sid, itemId);
    return json(405, { error: 'Method Not Allowed' }, { allow: 'PATCH,DELETE' });
  }
  // /session/:sid/todos
  const rootMatch = path.match(/^\/session\/([^/]+)\/todos$/);
  if (rootMatch) {
    const sid = rootMatch[1]!;
    if (method === 'GET') return handleList(deps, sid);
    if (method === 'POST') return handleCreate(deps, req, sid);
    return json(405, { error: 'Method Not Allowed' }, { allow: 'GET,POST' });
  }
  return json(404, { error: 'Not Found' });
}
