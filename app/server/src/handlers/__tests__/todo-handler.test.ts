/**
 * todo UI HTTP handler 单测（白盒）— 7 端点 + 400/404/405 错误路径。
 * 参考: specs/api/overall/19-todo.md（端点契约）
 *       specs/tech/agent/tools/[P1]todo_tools.md §7（HTTP API 权威）
 *       states/v0.0.223/verify/test-plan.md §3（UT 范围）
 *
 * 覆盖：
 *   - GET list（空 / 非空）
 *   - POST add_item（desc required / status 缺省 not_started / memo）
 *   - PATCH update_item（desc/status/memo / 404 item 不存在 / 400 invalid status）
 *   - DELETE delete_item（200 / 404）
 *   - POST add_step / PATCH update_step
 *   - POST cleanup（返 removed 数）
 *   - 404 session 不存在
 *   - 405 方法错 / 404 路径不存在
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach rmSync。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '../../config/ulid';
import { handleTodoRoute, type TodoRouteDeps } from '../todo-handler';
import { TodoStore } from '../../agent/todo/todo-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';

let tmpRoot: string;
let todoStore: TodoStore;
let sessionStore: SessionStore;
let deps: TodoRouteDeps;
let sessionId: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'todo-http-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fsEngine)
    .mount('transcript', fsEngine)
    .mount('summary', fsEngine)
    .mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  todoStore = new TodoStore({ fsRoot: tmpRoot });
  deps = { todoStore, sessionStore };
  sessionId = ulid();
  await sessionStore.createSession({ id: sessionId, title: 't' });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const req = new Request(`http://test${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await handleTodoRoute(req, method, path, deps);
  return { status: res.status, body: await res.json() };
}

function sidPath(sub: string): string {
  return `/session/${sessionId}${sub}`;
}

// ============================================================
// GET list
// ============================================================
describe('GET /session/:sid/todos', () => {
  it('空 → 200 {items:[]}', async () => {
    const { status, body } = await call('GET', sidPath('/todos'));
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
  });

  it('非空 → 200 + items', async () => {
    await call('POST', sidPath('/todos'), { desc: 'a' });
    await call('POST', sidPath('/todos'), { desc: 'b' });
    const { status, body } = await call('GET', sidPath('/todos'));
    expect(status).toBe(200);
    expect(body.items).toHaveLength(2);
  });

  it('session 不存在 → 404', async () => {
    const { status } = await call('GET', '/session/GHOST/todos');
    expect(status).toBe(404);
  });
});

// ============================================================
// POST add_item
// ============================================================
describe('POST /session/:sid/todos', () => {
  it('创建 → 201 返 {itemId}（写操作小对象；完整对象走 GET）', async () => {
    const { status, body } = await call('POST', sidPath('/todos'), {
      desc: '写文档', source: { type: 'task', refId: 'T-1' }, memo: 'm',
    });
    expect(status).toBe(201);
    expect(typeof body.itemId).toBe('string');
    expect(body.itemId.length).toBeGreaterThan(0);
    // 完整对象走 GET（spec 20-todo.md §2.1）：持久化字段可经 GET 读回
    const list = await call('GET', sidPath('/todos'));
    const item = list.body.items.find((it: { id: string }) => it.id === body.itemId);
    expect(item).toBeDefined();
    expect(item.desc).toBe('写文档');
    expect(item.status).toBe('not_started');
    expect(item.steps).toEqual([]);
    expect(item.memo).toBe('m');
    expect(item.source).toEqual({ type: 'task', refId: 'T-1' });
  });

  it('缺 desc → 400', async () => {
    const { status, body } = await call('POST', sidPath('/todos'), {});
    expect(status).toBe(400);
    expect(body.error).toMatch(/desc required/);
  });

  it('session 不存在 → 404', async () => {
    const { status } = await call('POST', '/session/GHOST/todos', { desc: 'x' });
    expect(status).toBe(404);
  });
});

// ============================================================
// PATCH update_item / DELETE
// ============================================================
describe('PATCH/DELETE /session/:sid/todos/:itemId', () => {
  it('PATCH 改 desc/status/memo → 200 返 {itemId}', async () => {
    const created = await call('POST', sidPath('/todos'), { desc: 'a' });
    const itemId = created.body.itemId;
    const { status, body } = await call('PATCH', sidPath(`/todos/${itemId}`), {
      desc: 'b', status: 'in_progress', memo: 'mm',
    });
    expect(status).toBe(200);
    expect(body.itemId).toBe(itemId);
    // 完整对象走 GET 读回
    const list = await call('GET', sidPath('/todos'));
    const item = list.body.items.find((it: { id: string }) => it.id === itemId);
    expect(item.desc).toBe('b');
    expect(item.status).toBe('in_progress');
    expect(item.memo).toBe('mm');
  });

  it('PATCH 非法 status → 400', async () => {
    const created = await call('POST', sidPath('/todos'), { desc: 'a' });
    const { status, body } = await call('PATCH', sidPath(`/todos/${created.body.itemId}`), { status: 'bogus' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid status/);
  });

  it('PATCH item 不存在 → 404', async () => {
    const { status } = await call('PATCH', sidPath('/todos/GHOST'), { desc: 'x' });
    expect(status).toBe(404);
  });

  it('DELETE → 200 {id, deleted:true}', async () => {
    const created = await call('POST', sidPath('/todos'), { desc: 'a' });
    const itemId = created.body.itemId;
    const { status, body } = await call('DELETE', sidPath(`/todos/${itemId}`));
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(body.id).toBe(itemId);
    // 再 GET 空
    const list = await call('GET', sidPath('/todos'));
    expect(list.body.items).toEqual([]);
  });

  it('DELETE item 不存在 → 404', async () => {
    const { status } = await call('DELETE', sidPath('/todos/GHOST'));
    expect(status).toBe(404);
  });
});

// ============================================================
// steps endpoints
// ============================================================
describe('POST/PATCH /session/:sid/todos/:itemId/steps', () => {
  it('POST add_step → 201 返 {itemId, stepId}', async () => {
    const created = await call('POST', sidPath('/todos'), { desc: '主' });
    const itemId = created.body.itemId;
    const { status, body } = await call('POST', sidPath(`/todos/${itemId}/steps`), { desc: '步骤1' });
    expect(status).toBe(201);
    expect(body.itemId).toBe(itemId);
    expect(typeof body.stepId).toBe('string');
    // 完整对象走 GET 读回
    const list = await call('GET', sidPath('/todos'));
    const item = list.body.items.find((it: { id: string }) => it.id === itemId);
    const step = item.steps.find((s: { id: string }) => s.id === body.stepId);
    expect(step.desc).toBe('步骤1');
    expect(step.status).toBe('not_started');
  });

  it('PATCH update_step → 200 返 {itemId, stepId}', async () => {
    const created = await call('POST', sidPath('/todos'), { desc: '主' });
    const itemId = created.body.itemId;
    const stepRes = await call('POST', sidPath(`/todos/${itemId}/steps`), { desc: 's1' });
    const stepId = stepRes.body.stepId;
    const { status, body } = await call('PATCH', sidPath(`/todos/${itemId}/steps/${stepId}`), { status: 'done' });
    expect(status).toBe(200);
    expect(body.itemId).toBe(itemId);
    expect(body.stepId).toBe(stepId);
    // 完整对象走 GET 读回
    const list = await call('GET', sidPath('/todos'));
    const item = list.body.items.find((it: { id: string }) => it.id === itemId);
    expect(item.steps.find((s: { id: string }) => s.id === stepId).status).toBe('done');
  });

  it('add_step 缺 desc → 400', async () => {
    const created = await call('POST', sidPath('/todos'), { desc: '主' });
    const { status } = await call('POST', sidPath(`/todos/${created.body.itemId}/steps`), {});
    expect(status).toBe(400);
  });
});

// ============================================================
// cleanup + 路径/方法错误
// ============================================================
describe('POST /session/:sid/todos/cleanup + 错误路径', () => {
  it('cleanup 清掉 done/skipped → 200 {removed:N}', async () => {
    await call('POST', sidPath('/todos'), { desc: 'a', status: 'in_progress' });
    await call('POST', sidPath('/todos'), { desc: 'b', status: 'done' });
    const { status, body } = await call('POST', sidPath('/todos/cleanup'));
    expect(status).toBe(200);
    expect(body.removed).toBe(1);
  });

  it('cleanup 优先于 :itemId 匹配（/cleanup 不被当 itemId）', async () => {
    const { status } = await call('POST', sidPath('/todos/cleanup'));
    expect(status).toBe(200);
  });

  it('路径不存在 → 404', async () => {
    const req = new Request(`http://test/session/${sessionId}/bogus`, { method: 'GET' });
    const res = await handleTodoRoute(req, 'GET', `/session/${sessionId}/bogus`, deps);
    expect(res.status).toBe(404);
  });

  it('方法错 → 405', async () => {
    const { status } = await call('PUT', sidPath('/todos'));
    expect(status).toBe(405);
  });

  it('deps null → 503', async () => {
    const req = new Request(`http://test${sidPath('/todos')}`, { method: 'GET' });
    const res = await handleTodoRoute(req, 'GET', sidPath('/todos'), null);
    expect(res.status).toBe(503);
  });
});
