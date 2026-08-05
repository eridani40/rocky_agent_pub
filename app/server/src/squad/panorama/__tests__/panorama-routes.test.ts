/**
 * panorama HTTP 路由 UT — 9 端点 + 错误 status（14-panorama-endpoints.md）.
 * 参考: specs/api/overall/14-panorama-endpoints.md + specs/tech/squad/[P1]panorama_http.md
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { handlePanoramaRoute } from '../http/routes';
import type { PanoramaHandlerDeps } from '../http/routes';

const DSL = `
version:
  id: dev
  name: Dev
  board_name: CI/CD
entities:
  pipeline_run:
    label: Pipeline
    id_field: id
    fields:
      id:     { type: string }
      status: { type: enum, values: [queued, running, success, failed] }
    states:
      field: status
      initial: queued
      transitions:
        queued:  [running]
        running: [success, failed]
      terminal: [success, failed]
views:
  - id: run_kanban
    label: Kanban
    entity: pipeline_run
    component: kanban
    group_by: status
    columns: [queued, running, success, failed]
    card:
      title: "{id}"
`;

let tmpDir: string;
let deps: PanoramaHandlerDeps;
const squadId = 'sq-rt';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-rt-'));
  // 建 squad record（routes 校验 squad 存在）
  const sDir = path.join(tmpDir, 'squad');
  fs.mkdirSync(sDir, { recursive: true });
  fs.writeFileSync(path.join(sDir, `${squadId}.json`), JSON.stringify({ id: squadId, name: 'S', leaderId: 'm1', charter: {}, memberIds: [] }));
  // panorama 骨架
  fs.mkdirSync(path.join(tmpDir, 'squads', squadId, 'panorama', 'entities'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'squads', squadId, 'panorama', '.state'), { recursive: true });
  deps = { dataDir: tmpDir };
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function req(method: string, sub: string, body?: unknown): Promise<Response> {
  const url = `http://x/squad/${squadId}/panorama/${sub}`;
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  // path 传 pathname（去 query string，对齐 router.ts url.pathname 调用方）
  const path = new URL(url).pathname;
  return (await handlePanoramaRoute(new Request(url, init), method, path, deps))!;
}

function body(r: Response) { return r.json(); }

describe('panorama http — schema 面', () => {
  it('GET schema 空 board → 返 task-only DSL（lazy migration 兜底，含 task entity）', async () => {
    const r = await req('GET', 'schema');
    expect(r.status).toBe(200);
    const dsl = (await body(r) as { dsl: string }).dsl;
    // 后端 ensureSystemEntities 恒返含 task 的 DSL（lazy migration：空 board 建表）
    expect(dsl).not.toBeNull();
    expect(dsl).toContain('task');
    expect(dsl).toContain('task_kanban');
  });

  it('PUT schema 落盘 + GET 回读', async () => {
    const put = await req('PUT', 'schema', { dsl: DSL });
    expect(put.status).toBe(200);
    expect(await body(put)).toEqual({ ok: true });
    const get = await req('GET', 'schema');
    expect((await body(get) as { dsl: string }).dsl).toContain('pipeline_run');
  });

  it('POST validate 干跑不落盘', async () => {
    const v = await req('POST', 'schema/validate', { dsl: DSL });
    expect(v.status).toBe(200);
    expect((await body(v) as { ok: boolean }).ok).toBe(true);
    // validate 不落盘 leader DSL：get_schema 返 task-only（ensure 兜底），不含 pipeline_run
    const get = await req('GET', 'schema');
    const dsl = (await body(get) as { dsl: string }).dsl;
    expect(dsl).toContain('task');
    expect(dsl).not.toContain('pipeline_run');
  });

  it('PUT schema mate → 403 forbidden', async () => {
    const put = await req('PUT', 'schema', { dsl: DSL });
    // 默认无 header role=user 允许；mate 需 header
    const r2 = new Request(`http://x/squad/${squadId}/panorama/schema`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-caller-role': 'mate' }, body: JSON.stringify({ dsl: DSL }) });
    const res = (await handlePanoramaRoute(r2, 'PUT', `/squad/${squadId}/panorama/schema`, deps))!;
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: 'forbidden' });
    void put;
  });

  it('PUT schema 非法 → 400', async () => {
    const r = await req('PUT', 'schema', { dsl: 'bad: yaml\n  - x' });
    expect(r.status).toBe(400);
  });
});

describe('panorama http — 实体 CRUD', () => {
  beforeEach(async () => { await req('PUT', 'schema', { dsl: DSL }); });

  it('POST create + GET list + GET one', async () => {
    const c = await req('POST', 'entities/pipeline_run', { fields: { id: 'pr-1' } });
    expect(c.status).toBe(201);
    expect(await body(c)).toEqual({ ok: true, id: 'pr-1', created: true });
    const list = await req('GET', 'entities/pipeline_run');
    expect((await body(list) as { instances: unknown[] }).instances).toHaveLength(1);
    const one = await req('GET', 'entities/pipeline_run/pr-1');
    expect((await body(one) as { status: string }).status).toBe('queued');
  });

  it('POST create 重复 id → 201 created:false 幂等短路（req §B）', async () => {
    await req('POST', 'entities/pipeline_run', { fields: { id: 'pr-1' } });
    const c = await req('POST', 'entities/pipeline_run', { fields: { id: 'pr-1' } });
    expect(c.status).toBe(201);
    expect(await body(c)).toEqual({ ok: true, id: 'pr-1', created: false });
    // 短路不写库：仍只有 1 条
    const list = await req('GET', 'entities/pipeline_run');
    expect((await body(list) as { instances: unknown[] }).instances).toHaveLength(1);
  });

  it('GET one 不存在 → 404', async () => {
    const r = await req('GET', 'entities/pipeline_run/nope');
    expect(r.status).toBe(404);
  });

  it('PATCH update', async () => {
    await req('POST', 'entities/pipeline_run', { fields: { id: 'pr-1' } });
    const p = await req('PATCH', 'entities/pipeline_run/pr-1', { patch: { status: 'running' } });
    expect(p.status).toBe(200);
    const one = await req('GET', 'entities/pipeline_run/pr-1');
    expect((await body(one) as { status: string }).status).toBe('running');
  });

  it('POST transition 合法', async () => {
    await req('POST', 'entities/pipeline_run', { fields: { id: 'pr-1' } });
    const t = await req('POST', 'entities/pipeline_run/pr-1/transition', { to: 'running' });
    expect(t.status).toBe(200);
    expect(await body(t)).toEqual({ ok: true, from: 'queued', to: 'running' });
  });

  it('POST transition 非法 → 400', async () => {
    await req('POST', 'entities/pipeline_run', { fields: { id: 'pr-1' } });
    const t = await req('POST', 'entities/pipeline_run/pr-1/transition', { to: 'success' });
    expect(t.status).toBe(400);
    expect(await body(t)).toMatchObject({ code: 'panorama_illegal_transition' });
  });

  it('GET list query filter', async () => {
    await req('POST', 'entities/pipeline_run', { fields: { id: 'pr-1' } });
    await req('POST', 'entities/pipeline_run', { fields: { id: 'pr-2', status: 'running' } });
    const r = await req('GET', 'entities/pipeline_run?filter=status:running');
    expect((await body(r) as { instances: unknown[] }).instances).toHaveLength(1);
  });

  it('task entity：builtin 永远可查（无 board define 也可 create/list）', async () => {
    // builtin task entity 在 schema 已 define 的 board 上也永远可解析
    const c = await req('POST', 'entities/task', { fields: { id: 'task-0001', title: 'T1' } });
    expect(c.status).toBe(201);
    const got = await body(c) as { ok: boolean; id: string };
    expect(got.ok).toBe(true);
    // archived 字段 default false 存在（修 ET blocking：MISSING 被滤掉）
    const one = await req('GET', 'entities/task/task-0001');
    expect((await body(one) as { archived: boolean }).archived).toBe(false);
  });

  it('task filter `archived:false` 匹配未归档 task（ET blocking 回归）', async () => {
    // 建 2 task（默认未归档）+ 归档 1 个
    await req('POST', 'entities/task', { fields: { id: 'task-a', title: 'A' } });
    await req('POST', 'entities/task', { fields: { id: 'task-b', title: 'B' } });
    await req('PATCH', 'entities/task/task-b', { patch: { archived: true } });
    // 默认活跃视图（filter archived:false）→ 只看 task-a
    const active = await req('GET', 'entities/task?filter=archived:false');
    const activeList = (await body(active) as { instances: Array<{ id: string }> }).instances;
    expect(activeList.map((t) => t.id)).toEqual(['task-a']);
    // 切「含归档」（无 filter）→ 看全部
    const all = await req('GET', 'entities/task');
    const allList = (await body(all) as { instances: Array<{ id: string }> }).instances;
    expect(allList.map((t) => t.id).sort()).toEqual(['task-a', 'task-b']);
  });

  it('未 define schema → create 409', async () => {
    // 删 board.yaml 模拟未 define
    fs.rmSync(path.join(tmpDir, 'squads', squadId, 'panorama', 'board.yaml'), { force: true });
    const c = await req('POST', 'entities/pipeline_run', { fields: { id: 'x' } });
    expect(c.status).toBe(409);
  });

  it('GET events', async () => {
    await req('POST', 'entities/pipeline_run', { fields: { id: 'pr-1' } });
    const e = await req('GET', 'events');
    const evs = (await body(e) as { events: { type: string }[] }).events;
    expect(evs.some((x) => x.type === 'entity.created')).toBe(true);
  });
});

// 原始 bug 路径：leader DSL view.filter 被静默忽略 → "3 table 筛一样"
// 后端 handleListEntities 已支持 ?filter= 解析（v0.0.240 effective schema + filter 加固）
// 此 describe 验证非-boolean string filter 路径工作（与 boolean archived:false 走 !r[k] 不同口径）
const BOOK_DSL = `
version:
  id: dev
  name: Dev
  board_name: Library
entities:
  book:
    label: Book
    id_field: id
    fields:
      id:       { type: string }
      title:    { type: string }
      category: { type: string }
views:
  - id: book_table
    label: Books
    entity: book
    component: table
    columns: [id, title, category]
`;

describe('panorama http — 非 boolean string filter（原始 "3 table 筛一样" bug 路径）', () => {
  beforeEach(async () => { await req('PUT', 'schema', { dsl: BOOK_DSL }); });

  it('filter=category:X 只返匹配的 string 值（strict equality `String(r[k])===v`）', async () => {
    await req('POST', 'entities/book', { fields: { id: 'b1', title: 'Fic1', category: 'fiction' } });
    await req('POST', 'entities/book', { fields: { id: 'b2', title: 'Fic2', category: 'fiction' } });
    await req('POST', 'entities/book', { fields: { id: 'b3', title: 'Tech1', category: 'tech' } });
    // filter=category:fiction → 只返 b1+b2（原始 bug：filter 被忽略会返全部 3 条）
    const r = await req('GET', 'entities/book?filter=category:fiction');
    const list = (await body(r) as { instances: Array<{ id: string }> }).instances;
    expect(list.map((b) => b.id).sort()).toEqual(['b1', 'b2']);
  });

  it('string 字段 MISSING 的记录不匹配 string filter（与 boolean false 走 !r[k] 不同口径）', async () => {
    // b4 不传 category → 字段 MISSING（string 字段无默认，不像 boolean 默认 false）
    await req('POST', 'entities/book', { fields: { id: 'b1', title: 'Fic1', category: 'fiction' } });
    await req('POST', 'entities/book', { fields: { id: 'b4', title: 'NoCat' } });
    // filter=category:fiction → 只返 b1；b4 MISSING 不匹配（区分于 boolean false 匹配 MISSING 的语义）
    const r = await req('GET', 'entities/book?filter=category:fiction');
    const list = (await body(r) as { instances: Array<{ id: string }> }).instances;
    expect(list.map((b) => b.id)).toEqual(['b1']);
    // 切「全部」（无 filter）→ b1 + b4 都可见
    const all = await req('GET', 'entities/book');
    const allList = (await body(all) as { instances: Array<{ id: string }> }).instances;
    expect(allList.map((b) => b.id).sort()).toEqual(['b1', 'b4']);
  });

  it('多 filter 组合（category:fiction + id:b2）AND 语义', async () => {
    await req('POST', 'entities/book', { fields: { id: 'b1', title: 'Fic1', category: 'fiction' } });
    await req('POST', 'entities/book', { fields: { id: 'b2', title: 'Fic2', category: 'fiction' } });
    const r = await req('GET', 'entities/book?filter=category:fiction,id:b2');
    const list = (await body(r) as { instances: Array<{ id: string }> }).instances;
    expect(list.map((b) => b.id)).toEqual(['b2']);
  });
});

describe('panorama http — 路由分发', () => {
  it('squad 不存在 → 404', async () => {
    const r = (await handlePanoramaRoute(new Request('http://x/squad/nope/panorama/schema'), 'GET', '/squad/nope/panorama/schema', deps))!;
    expect(r.status).toBe(404);
  });

  it('非 panorama 路径 → null（未命中）', async () => {
    const r = await handlePanoramaRoute(new Request('http://x'), 'GET', '/squad/sq-rt/board', deps);
    expect(r).toBeNull();
  });

  it('未知子路径 → 404', async () => {
    const r = (await handlePanoramaRoute(new Request('http://x'), 'GET', `/squad/${squadId}/panorama/nope`, deps))!;
    expect(r.status).toBe(404);
  });
});

// router.ts 不解 pathname → 非 ASCII id path 段须 routes 边界 decode；此用例复刻报障 id 往返（create/GET/PATCH-archive/transition）。
describe('panorama http — 非 ASCII id path decode（v0.0.251：归档中文 id task 404）', () => {
  beforeEach(async () => { await req('PUT', 'schema', { dsl: DSL }); });

  it('create + GET + PATCH(archived) + transition 全通（id decoded 往返）', async () => {
    const id = 'C4-T1-v4-概括手-r2'; // 复刻报障 id（含中文「概括手」）
    // req() helper 内部 new URL(url).pathname 会自动 percent-encode 中文 → 复现 bug 路径

    // 1. POST create（id + 必填 title；status 用 initial todo 兜底）
    const c = await req('POST', 'entities/task', { fields: { id, title: '概括手任务' } });
    expect(c.status).toBe(201);
    expect(await body(c)).toEqual({ ok: true, id, created: true });

    // 2. GET 同 id → 200 且 id 字段 === decoded（证明 path 参数 decoded 往返）
    const one = await req('GET', `entities/task/${id}`);
    expect(one.status).toBe(200);
    expect((await body(one) as { id: string }).id).toBe(id);

    // 3. PATCH archived:true（报障归档路径，修复前 404 panorama_instance_not_found）
    const p = await req('PATCH', `entities/task/${id}`, { patch: { archived: true } });
    expect(p.status).toBe(200);
    expect(await body(p)).toEqual({ ok: true });

    // 4. POST transition（task 合法跃迁 todo → in_progress）
    const t = await req('POST', `entities/task/${id}/transition`, { to: 'in_progress' });
    expect(t.status).toBe(200);
    expect(await body(t)).toEqual({ ok: true, from: 'todo', to: 'in_progress' });
  });
});
