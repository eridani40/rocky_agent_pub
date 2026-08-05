/**
 * panorama HTTP 演进闭环 + PATCH 状态机守护 UT（BUG-001/BUG-003 HTTP 半边）.
 * 参考: specs/api/overall/14-panorama-endpoints.md §1/§3 + specs/tech/squad/[P1]panorama_http.md
 * 从 panorama-routes.test.ts 拆出（单文件 ≤300 行）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { handlePanoramaRoute } from '../http/routes';
import type { PanoramaHandlerDeps } from '../http/routes';

/** 双实体 DSL：book（status 状态机 + priority enum）+ note（陪跑） */
const DSL2 = `
version:
  id: lib
  name: Lib
  board_name: Library
entities:
  book:
    label: 书
    id_field: id
    fields:
      id:       { type: string }
      priority: { type: enum, values: [low, mid, high] }
      status:   { type: enum, values: [reading, done] }
    states:
      field: status
      initial: reading
      transitions:
        reading: [done]
        done: []
      terminal: [done]
  note:
    label: 笔记
    id_field: id
    fields:
      id: { type: string }
views:
  - id: book_table
    label: 书
    entity: book
    component: table
    columns: [id, status]
`;

/** 删掉 book 实体后的 DSL（view 同步移除，否则 L3 报 unknown entity） */
const DSL2_NO_BOOK = `
version:
  id: lib
  name: Lib
  board_name: Library
entities:
  note:
    label: 笔记
    id_field: id
    fields:
      id: { type: string }
views:
  - id: note_table
    label: 笔记
    entity: note
    component: table
    columns: [id]
`;

/** priority 收窄 [low,mid,high] → [low,high]（不涉 states） */
const DSL2_NARROW = DSL2.replace('values: [low, mid, high]', 'values: [low, high]');

let tmpDir: string;
let deps: PanoramaHandlerDeps;
const squadId = 'sq-ev-rt';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-evrt-'));
  const sDir = path.join(tmpDir, 'squad');
  fs.mkdirSync(sDir, { recursive: true });
  fs.writeFileSync(path.join(sDir, `${squadId}.json`), JSON.stringify({ id: squadId, name: 'S', leaderId: 'm1', charter: {}, memberIds: [] }));
  fs.mkdirSync(path.join(tmpDir, 'squads', squadId, 'panorama', 'entities'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'squads', squadId, 'panorama', '.state'), { recursive: true });
  deps = { dataDir: tmpDir };
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function req(method: string, sub: string, body?: unknown): Promise<Response> {
  const url = `http://x/squad/${squadId}/panorama/${sub}`;
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const path = new URL(url).pathname;
  return (await handlePanoramaRoute(new Request(url, init), method, path, deps))!;
}

function body(r: Response) { return r.json(); }

describe('panorama http — define 演进闭环（BUG-001 HTTP 半边）', () => {
  beforeEach(async () => {
    await req('PUT', 'schema', { dsl: DSL2 });
    await req('POST', 'entities/book', { fields: { id: 'b1', priority: 'mid' } });
  });

  it('PUT 裸删实体（有存量）→ 400 data_safety + board 不变', async () => {
    const r = await req('PUT', 'schema', { dsl: DSL2_NO_BOOK });
    expect(r.status).toBe(400);
    const b = await body(r) as { errors: { code: string }[] };
    expect(b.errors.some((x) => x.code === 'panorama_dropping_entity_data')).toBe(true);
    const get = await req('GET', 'schema');
    expect((await body(get) as { dsl: string }).dsl).toContain('book');
  });

  it('PUT 带 approved 删实体 → 200 + 实例 archive', async () => {
    const r = await req('PUT', 'schema', { dsl: DSL2_NO_BOOK, approved: true });
    expect(r.status).toBe(200);
    expect(await body(r)).toEqual({ ok: true });
    const get = await req('GET', 'schema');
    expect((await body(get) as { dsl: string }).dsl).not.toContain('book');
    const inst = JSON.parse(fs.readFileSync(
      path.join(tmpDir, 'squads', squadId, 'panorama', 'entities', 'book', 'b1.json'), 'utf8'));
    expect(inst._archived).toBe(true);
  });

  it('POST validate（dryRun 端点）同 DSL → 仍报 data_safety 预警（不落盘）', async () => {
    const v = await req('POST', 'schema/validate', { dsl: DSL2_NO_BOOK });
    expect(v.status).toBe(200);
    const b = await body(v) as { ok: boolean; errors: { code: string }[] };
    expect(b.ok).toBe(false);
    expect(b.errors.some((x) => x.code === 'panorama_dropping_entity_data')).toBe(true);
    const get = await req('GET', 'schema');
    expect((await body(get) as { dsl: string }).dsl).toContain('book');
  });

  it('PUT narrow_enum 缺 mapping → 400 panorama_migration_postcheck + 回滚', async () => {
    const migration = {
      operations: [{
        operation: 'narrow_enum',
        target: { entity: 'book', field: 'priority' },
        from: ['low', 'mid', 'high'],
        to: ['low', 'high'],
        handler: { strategy: 'mapping' },
      }],
    };
    const r = await req('PUT', 'schema', { dsl: DSL2_NARROW, migration, approved: true });
    expect(r.status).toBe(400);
    expect(await body(r)).toMatchObject({ code: 'panorama_migration_postcheck' });
    const get = await req('GET', 'schema');
    expect((await body(get) as { dsl: string }).dsl).toContain('mid');
    const one = await req('GET', 'entities/book/b1');
    expect((await body(one) as { priority: string }).priority).toBe('mid');
  });
});

describe('panorama http — PATCH 状态机守护（BUG-003 HTTP 半边）', () => {
  beforeEach(async () => {
    await req('PUT', 'schema', { dsl: DSL2 });
    await req('POST', 'entities/book', { fields: { id: 'b1' } });
  });

  it('PATCH 状态字段合法跃迁 → 200', async () => {
    const p = await req('PATCH', 'entities/book/b1', { patch: { status: 'done' } });
    expect(p.status).toBe(200);
  });

  it('PATCH 状态字段非法跃迁 → 400 code/reason/suggestion + 值不变', async () => {
    await req('PATCH', 'entities/book/b1', { patch: { status: 'done' } });
    // done 是 terminal：done→reading 非法
    const p = await req('PATCH', 'entities/book/b1', { patch: { status: 'reading' } });
    expect(p.status).toBe(400);
    const b = await body(p) as { code: string; reason?: string; suggestion?: string };
    expect(b.code).toBeTruthy();
    expect(b.reason).toBeTruthy();
    expect(b.suggestion).toBeTruthy();
    const one = await req('GET', 'entities/book/b1');
    expect((await body(one) as { status: string }).status).toBe('done');
  });

  it('PATCH 状态字段同值 → 幂等放行', async () => {
    const p = await req('PATCH', 'entities/book/b1', { patch: { status: 'reading' } });
    expect(p.status).toBe(200);
  });
});
