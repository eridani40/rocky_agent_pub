/**
 * 系统固定 entity 注入 + lazy migration chokepoint（v0.0.243 — panorama_builtin §3）.
 * 参考: specs/tech/squad/[P1]panorama_builtin.md §3（system-wins / lazy migration）
 *       reqs/[working] v0.0.243.task_entity/req.md §migration 边界
 *
 * 职责：
 *   - SYSTEM_ENTITY_DEFS：系统固定 entity 的 canonical 注册表（目前仅 task），权威源
 *   - injectSystemEntities：define 流程 post-parse 注入（强制 schema.entities.task = canonical + prepend view）
 *   - ensureSystemEntities：schema-read chokepoint，幂等 lazy migration（read→无 system task→inject+write）
 *
 * 不变量：
 *   1. injectSystemEntities 不 read 文件系统（纯内存 mutate，idempotent）
 *   2. ensureSystemEntities 幂等（task.system===true 时纯读不写）
 *   3. system-wins：覆盖 leader 同名 task 变体（req 边界——无有效 task 数据，概率低）
 */
import type { PanoramaSchema, EntityDef, KanbanViewDef } from '../dsl/types';
import type { PanoramaEntityStore } from '../store/panorama_store';
import { TASK_ENTITY_DEF, TASK_VIEW_DEF } from './task-schema';

/**
 * 系统固定 entity canonical 注册表（v0.0.243）.
 * - key = entity name（与 schema.entities key 对齐）
 * - value = canonical EntityDef（含 system:true）
 * - views = 该系统 entity 配套 view（prepend 为首 tab）
 *
 * 后续系统 entity 加这里（同时补 view）；checkSystemEntityImmutable 遍历此表，
 * injectSystemEntities 强制覆盖 schema.entities[name] 为 canonical 版本.
 */
export const SYSTEM_ENTITY_DEFS: Record<string, EntityDef> = {
  task: TASK_ENTITY_DEF,
};

/** 系统配栈 view 列表（prepend 进 schema.views，作为首 tab） */
export const SYSTEM_VIEWS: KanbanViewDef[] = [TASK_VIEW_DEF];

/** canonical schema 的默认 meta（raw=null 时 ensureSystemEntities 建表用，version 1.0 对齐 parser 默认） */
const SYSTEM_META = { version: '1.0' };

/**
 * 把 system entity 强制注入 schema（内存 mutate，chainable）.
 *
 * 行为：
 *   - schema.entities.task = TASK_ENTITY_DEF（canonical，覆盖任何 leader 提交的 task 变体——system-wins）
 *   - schema.views 缺失 task_kanban 时 prepend（已存在则不重复加）
 *
 * 用于 define 流程：validate 通过后、applyMigration 之前注入（见 panorama-tool-actions.runDefine）.
 * 时序关键：inject 必须在 validate 后（让 checkSystemEntityImmutable 看到 leader 原始提交拒漂移），
 * 必须在 applyMigration 前（让 newSchema 含 canonical task，diff 不误判 entity_deleted=task）.
 *
 * @param schema parser 后的 schema（可能含 leader 提交的 task 变体）
 * @returns schema 本身（已 mutate；chainable）
 */
export function injectSystemEntities(schema: PanoramaSchema): PanoramaSchema {
  // system-wins：强制覆盖任何 leader 提交的同名 task 变体
  for (const [name, canonical] of Object.entries(SYSTEM_ENTITY_DEFS)) {
    schema.entities[name] = canonical;
  }
  // 系统配栈 view prepend（去重：已存在则不重复加）
  const existingIds = new Set(schema.views.map((v) => v.id));
  const missingViews = SYSTEM_VIEWS.filter((v) => !existingIds.has(v.id));
  if (missingViews.length > 0) {
    schema.views = [...missingViews, ...schema.views];
  }
  return schema;
}

/**
 * lazy migration chokepoint：schema-read 时确保 system entity 已落盘.
 *
 * 四态幂等：
 *   1. board=null（未 define）→ 建 `{meta, entities:{task}, views:[task_kanban]}` 并 writeBoard
 *   2. board 非 null + entities.task.system !== true（leader 同名 task 变体 / 旧 schema 无 task）
 *      → injectSystemEntities + writeBoard（system-wins 覆盖）
 *   3. board 非 null + entities.task.system === true → 纯读，不写（已 canonical）
 *
 * 所有 schema-read 路径（get_schema / schema 数据面 / resolveEntity）必经此 chokepoint，
 * 保证 task entity 恒在（req 目标：agent 一目了然）.
 *
 * @param store PanoramaEntityStore（readBoard + writeBoard）
 * @returns 非 null schema（task 必在）
 */
export function ensureSystemEntities(store: PanoramaEntityStore): PanoramaSchema {
  const raw = store.readBoard();
  if (!raw) {
    // 空 board：建纯 system schema（task entity + task_kanban view）并落盘
    const fresh: PanoramaSchema = {
      meta: { ...SYSTEM_META },
      entities: { ...SYSTEM_ENTITY_DEFS },
      views: [...SYSTEM_VIEWS],
    };
    store.writeBoard(fresh);
    return fresh;
  }
  // 已有 board：检查 task 是否已是 system 版本
  const taskEntity = raw.entities.task;
  if (taskEntity?.system === true) {
    return raw; // 已 canonical，纯读不写
  }
  // leader 提交了非 system task 变体 / 旧 schema 缺 task → inject canonical + write
  const injected = injectSystemEntities({ ...raw, entities: { ...raw.entities }, views: [...raw.views] });
  store.writeBoard(injected);
  return injected;
}
