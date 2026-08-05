/**
 * system-entities UT — injectSystemEntities + ensureSystemEntities（panorama_builtin §3）.
 * 参考: specs/tech/squad/[P1]panorama_builtin.md §3（system-wins / lazy migration）
 *       reqs/[working] v0.0.243.task_entity/req.md §migration 边界
 *
 * 覆盖：
 *   - injectSystemEntities：leader task 变体被覆盖 / 缺失补全 / 已 canonical no-op / view 缺失 prepend / view 已存在不重复
 *   - ensureSystemEntities：四态幂等（null/无 task/有非 system task/已 system task）
 *
 * 底层用真 PanoramaEntityStore + tmpdir（无 mock；隔离 by mkdtempSync + afterEach 清理）.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PanoramaEntityStore } from '../../store/panorama_store';
import {
  injectSystemEntities,
  ensureSystemEntities,
  SYSTEM_ENTITY_DEFS,
} from '../system-entities';
import { TASK_ENTITY_DEF, TASK_VIEW_DEF } from '../task-schema';
import type { PanoramaSchema, EntityDef } from '../../dsl/types';

let tmpDir: string;
let store: PanoramaEntityStore;
const squadId = 'sq-se';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-sys-'));
  fs.mkdirSync(path.join(tmpDir, 'squads', squadId, 'panorama', 'entities'), { recursive: true });
  store = new PanoramaEntityStore({ root: tmpDir, squadId });
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/** 非 system 的 leader task 变体（字段与 canonical 不一致） */
const leaderTaskVariant: EntityDef = {
  label: '假任务',
  id_field: 'x',
  fields: { x: { type: 'string' } },
};

const baseLeaderSchema: PanoramaSchema = {
  meta: { version: '1.0' },
  entities: {
    feature: { label: '功能', id_field: 'id', fields: { id: { type: 'string' } } },
  },
  views: [
    { id: 'feat_tbl', label: '功能表', entity: 'feature', component: 'table', columns: ['id'] },
  ],
};

describe('injectSystemEntities — 内存 mutate', () => {
  it('schema 含 leader 非 system task 变体 → 覆盖为 canonical TASK_ENTITY_DEF（system-wins）', () => {
    const schema: PanoramaSchema = {
      meta: { version: '1.0' },
      entities: { task: leaderTaskVariant },
      views: [],
    };
    const ret = injectSystemEntities(schema);
    expect(ret).toBe(schema); // chainable（返同引用）
    expect(schema.entities.task).toEqual(TASK_ENTITY_DEF);
    expect(schema.entities.task).not.toEqual(leaderTaskVariant);
    expect(schema.entities.task!.label).toBe('任务');
    expect(schema.entities.task!.system).toBe(true);
  });

  it('schema 缺 task → 补全 canonical TASK_ENTITY_DEF', () => {
    const schema: PanoramaSchema = {
      meta: { version: '1.0' },
      entities: { book: { label: '书', id_field: 'id', fields: { id: { type: 'string' } } } },
      views: [],
    };
    injectSystemEntities(schema);
    expect(schema.entities.task).toEqual(TASK_ENTITY_DEF);
    expect(schema.entities.task!.system).toBe(true);
    // 原 leader entity 保留
    expect(schema.entities.book).toBeDefined();
  });

  it('schema 已含 canonical task（含 system:true）→ 覆盖为同值（idempotent，无副作用）', () => {
    const schema: PanoramaSchema = {
      meta: { version: '1.0' },
      entities: { task: { ...TASK_ENTITY_DEF } },
      views: [TASK_VIEW_DEF],
    };
    injectSystemEntities(schema);
    expect(schema.entities.task).toEqual(TASK_ENTITY_DEF);
  });

  it('schema 缺 task_kanban view → prepend（首项）', () => {
    const schema: PanoramaSchema = JSON.parse(JSON.stringify(baseLeaderSchema));
    injectSystemEntities(schema);
    expect(schema.views[0]).toEqual(TASK_VIEW_DEF);
    expect(schema.views[1]!.id).toBe('feat_tbl');
    expect(schema.views).toHaveLength(2);
  });

  it('schema 已含 task_kanban view → 不重复加（去重）', () => {
    const schema: PanoramaSchema = {
      meta: { version: '1.0' },
      entities: { task: { ...TASK_ENTITY_DEF } },
      views: [
        TASK_VIEW_DEF,
        { id: 'feat_tbl', label: 'F', entity: 'feature', component: 'table', columns: ['id'] },
      ],
    };
    injectSystemEntities(schema);
    const kanbanViews = schema.views.filter((v) => v.id === 'task_kanban');
    expect(kanbanViews).toHaveLength(1);
  });

  it('不 read 文件系统（纯内存 mutate，无 IO）', () => {
    // 用一个不含 entities 的最小对象（模拟 parser 后但无任何 entity）
    const schema: PanoramaSchema = {
      meta: { version: '1.0' },
      entities: {},
      views: [],
    };
    injectSystemEntities(schema);
    expect(schema.entities.task).toEqual(TASK_ENTITY_DEF);
  });
});

describe('ensureSystemEntities — lazy migration 四态幂等', () => {
  it('态 1：board=null（未 define）→ 建纯 system schema 并落盘', () => {
    expect(store.readBoard()).toBeNull(); // 初始 null
    const schema = ensureSystemEntities(store);
    expect(schema.entities.task).toEqual(TASK_ENTITY_DEF);
    expect(schema.entities.task!.system).toBe(true);
    expect(schema.views[0]).toEqual(TASK_VIEW_DEF);
    expect(schema.meta.version).toBe('1.0');
    // 落盘验证
    const persisted = store.readBoard();
    expect(persisted).not.toBeNull();
    expect(persisted!.entities.task).toEqual(TASK_ENTITY_DEF);
  });

  it('态 2a：board 有 leader entity 但缺 task → inject canonical + 落盘', () => {
    store.writeBoard(baseLeaderSchema);
    const schema = ensureSystemEntities(store);
    // task 注入
    expect(schema.entities.task).toEqual(TASK_ENTITY_DEF);
    expect(schema.entities.task!.system).toBe(true);
    // leader entity 保留
    expect(schema.entities.feature).toBeDefined();
    expect(schema.entities.feature!.label).toBe('功能');
    // task_kanban view prepend
    expect(schema.views[0]).toEqual(TASK_VIEW_DEF);
    expect(schema.views[1]!.id).toBe('feat_tbl');
    // 落盘
    const persisted = store.readBoard();
    expect(persisted!.entities.task).toEqual(TASK_ENTITY_DEF);
    expect(persisted!.entities.feature).toBeDefined();
  });

  it('态 2b：board 有 leader 提交的非 system task 变体 → 覆盖为 canonical + 落盘（system-wins）', () => {
    store.writeBoard({
      meta: { version: '1.0' },
      entities: { task: leaderTaskVariant },
      views: [],
    });
    const schema = ensureSystemEntities(store);
    expect(schema.entities.task).toEqual(TASK_ENTITY_DEF);
    expect(schema.entities.task!.label).toBe('任务');
    expect(schema.entities.task!.label).not.toBe('假任务');
    expect(schema.entities.task!.system).toBe(true);
  });

  it('态 3：board 已含 system task（system:true）→ 纯读不写（幂等）', () => {
    // 第一次 ensure 触发建表
    const firstSchema = ensureSystemEntities(store);
    expect(firstSchema.entities.task!.system).toBe(true);
    // 模拟后续 leader 已 define feature（writeBoard 覆盖，但仍含 system task）
    store.writeBoard({
      meta: { version: '1.0' },
      entities: {
        task: TASK_ENTITY_DEF,
        feature: { label: '功能', id_field: 'id', fields: { id: { type: 'string' } } },
      },
      views: [
        TASK_VIEW_DEF,
        { id: 'feat_tbl', label: 'F', entity: 'feature', component: 'table', columns: ['id'] },
      ],
    });
    const beforeMtime = fs.statSync(path.join(tmpDir, 'squads', squadId, 'panorama', 'board.yaml')).mtimeMs;
    // 第二次 ensure：纯读，不写
    const schema = ensureSystemEntities(store);
    expect(schema.entities.task!.system).toBe(true);
    expect(schema.entities.feature).toBeDefined();
    const afterMtime = fs.statSync(path.join(tmpDir, 'squads', squadId, 'panorama', 'board.yaml')).mtimeMs;
    expect(afterMtime).toBe(beforeMtime); // 文件未被重写
  });

  it('返永不 null（即便初始 board 为空）', () => {
    const schema = ensureSystemEntities(store);
    expect(schema).not.toBeNull();
    expect(typeof schema).toBe('object');
    expect(schema.entities.task).toBeDefined();
  });
});

describe('SYSTEM_ENTITY_DEFS — 注册表', () => {
  it('含 task（首例系统 entity）', () => {
    expect(SYSTEM_ENTITY_DEFS.task).toBe(TASK_ENTITY_DEF);
    expect(SYSTEM_ENTITY_DEFS.task?.system).toBe(true);
  });
});
