/**
 * panorama HTTP 端点实现（14-panorama-endpoints.md 端点级权威）.
 *
 * 与 agent 工具共用同一套校验/store/migration 引擎（panorama_tools §0 四面对齐）.
 * HTTP 无 session context，caller 身份经 header 传（x-caller-role/x-message-id，
 * 与 board-write 同款 readCallerCtx）.
 *
 * 错误码 → HTTP status 对齐 14-panorama-endpoints.md §1-§3 + panorama_http.md §5.
 */
import { readCallerCtx, json } from './http-helpers';
import { PanoramaEntityStore } from '../store/panorama_store';
import { parseDsl } from '../dsl/parser';
import { validateSchema, validateInstance, validateTransition, applyFieldDefaults, coerceRecord } from '../validation';
import { applyMigration } from '../migration/apply_migration';
import { stringify as serializeYaml } from 'yaml';
import { BreakingChangeRequiresApprovalError, MigrationMismatchError, MigrationPostValidationError } from '../migration/types';
import type { MigrationPlan } from '../migration/types';
import { emitPanoramaEvent } from './sse';
import { ensureSystemEntities, injectSystemEntities, afterTaskWrite, SYSTEM_ENTITY_DEFS } from '../builtin';
import { notifyTaskTransition } from '../../squad-states-fanout';
import type { ReplayableEventBus } from '../../../agent/event-hub';

interface RouteCtx {
  dataDir: string;
  squadId: string;
  bus?: ReplayableEventBus;
}

function store(ctx: RouteCtx): PanoramaEntityStore {
  return new PanoramaEntityStore({ root: ctx.dataDir, squadId: ctx.squadId });
}

/** 读 squad schema（lazy migration chokepoint，panorama_builtin §3）.
 *  task entity 经 ensureSystemEntities 恒在；空 board 也建表返 task-only schema（永不 null）. */
function readSquadSchema(ctx: RouteCtx) {
  return ensureSystemEntities(store(ctx));
}

/** 非 system entity + schema 仅有 system entity（leader 未 define）→ 409 schema_not_defined；
 *  system entity（task）ensure 后必在 schema → 直接放行.
 *  返回 null 表示放行（caller 继续查 entityDef）；返回 Response 表示已 emit 409（caller 早返）. */
function schemaOr409(ctx: RouteCtx, entity: string): Response | null {
  // system entity（task）永远放行（ensure 兜底）；其余 entity 需 leader 已 define
  if (SYSTEM_ENTITY_DEFS[entity]) return null;
  const schema = store(ctx).readBoard();
  // schema=null（leader 未 define）或 schema 仅有 system entity（task-only）→ 409
  const hasLeaderEntity = schema ? Object.values(schema.entities).some((e) => !e.system) : false;
  if (!hasLeaderEntity) {
    return json(409, { code: 'panorama_schema_not_defined' });
  }
  return null;
}

/** 校验引擎 StoreLike 适配器（getInstance 返 null） */
interface StoreLikeAdapter {
  getInstance(entity: string, id: string): Record<string, unknown> | null;
  listInstances(entity: string): Record<string, unknown>[];
  hasId(entity: string, id: string): boolean;
}
function storeLike(s: PanoramaEntityStore): StoreLikeAdapter {
  return {
    getInstance: (e, i) => s.getInstance(e, i) ?? null,
    listInstances: (e) => s.listInstances(e),
    hasId: (e, i) => s.hasId(e, i),
  };
}

/** 读取 JSON body（非法 JSON → null + 400 哨兵） */
async function readBody(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: Response }> {
  try {
    return { ok: true, body: (await req.json()) as Record<string, unknown> };
  } catch {
    return { ok: false, res: json(400, { error: 'invalid json body' }) };
  }
}

/** query string 解析 filter=field:value,since 等 */
function queryNum(req: Request, key: string): number | undefined {
  const v = new URL(req.url).searchParams.get(key);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// ── schema 面 ─────────────────────────────────────────────

export function handleGetSchema(ctx: RouteCtx): Response {
  // ensureSystemEntities 触发 lazy migration：task entity 恒在（首访问 squad 建表）.
  // 序列化返 DSL（含 task entity/view——agent 可见，修认知 bug，panorama_api §1.1）.
  const schema = readSquadSchema(ctx);
  return json(200, { dsl: serializeYaml(schema) });
}

export async function handlePutSchema(req: Request, ctx: RouteCtx): Promise<Response> {
  const b = await readBody(req);
  if (!b.ok) return b.res;
  const dsl = typeof b.body.dsl === 'string' ? b.body.dsl : '';
  if (dsl.length === 0) return json(400, { error: 'dsl required' });
  return execDefine(req, ctx, dsl, b.body.dryRun === true, b.body.approved === true, b.body.migration as { operations: MigrationPlan['operations'] } | undefined);
}

export async function handleValidateSchema(req: Request, ctx: RouteCtx): Promise<Response> {
  const b = await readBody(req);
  if (!b.ok) return b.res;
  const dsl = typeof b.body.dsl === 'string' ? b.body.dsl : '';
  if (dsl.length === 0) return json(400, { error: 'dsl required' });
  const s = store(ctx);
  const result = validateSchema(dsl, { oldSchema: s.readBoard() ?? undefined, store: storeLike(s) });
  return json(200, { ok: result.ok, errors: result.errors, warnings: result.warnings });
}

/** PUT schema 核心：校验 → migration → 落盘 → SSE（PUT/validate 共用 validate，PUT 落盘） */
async function execDefine(
  req: Request, ctx: RouteCtx, dsl: string, dryRun: boolean, approved: boolean,
  migration: { operations: MigrationPlan['operations'] } | undefined,
): Promise<Response> {
  const caller = readCallerCtx(req);
  // mate 不可定义 schema（panorama_http.md §5 forbidden 403）
  if (caller.role === 'mate') return json(403, { code: 'forbidden' });
  const s = store(ctx);
  const oldSchema = s.readBoard();
  // 带 migration/approved = 声明迁移意图 → L4 数据安全交 migration 引擎裁决（对齐工具 runDefine，
  // 否则 HTTP PUT 带 migration 也永远 400——BUG-001 同漏洞）。POST validate 不走此路径（始终 L4 预警）。
  const deferDataSafety = migration !== undefined || approved;
  const result = validateSchema(dsl, { oldSchema: oldSchema ?? undefined, store: storeLike(s), deferDataSafety });
  if (!result.ok) return json(400, { ok: false, errors: result.errors });
  if (dryRun) return json(200, { ok: true, warnings: result.warnings });
  const parsed = parseDsl(dsl);
  if (!parsed.ok) return json(400, { ok: false, errors: parsed.errors });
  // 时序关键（panorama_builtin §3 决策 5）：validate 已先跑（让 checkSystemEntityImmutable 看到
  // leader 原始提交拒字段漂移）→ pass 后 inject canonical task 进 newSchema → applyMigration diff
  // 看到 task 是 entity_added（非 deleted）→ 非破坏性.dryRun 路径不注入（不落盘）.
  injectSystemEntities(parsed.schema);
  try {
    const res = applyMigration(s, {
      oldSchema: oldSchema ?? parsed.schema, newSchema: parsed.schema,
      plan: migration ? { operations: migration.operations } : undefined,
      approved, messageId: caller.messageId ?? null,
    });
    emitPanoramaEvent(ctx.bus, ctx.squadId, { type: 'panorama_schema_update', squadId: ctx.squadId, seq: res.seq });
    return json(200, { ok: true });
  } catch (e) {
    if (e instanceof BreakingChangeRequiresApprovalError) return json(409, { code: 'panorama_breaking_change_requires_approval' });
    if (e instanceof MigrationMismatchError) return json(400, { code: 'panorama_migration_mismatch', message: e.message });
    if (e instanceof MigrationPostValidationError) {
      // 迁移后实例校验不过（已回滚）——把违规明细喂回调用方修 migration（如 narrow_enum 缺 mapping）
      return json(400, { code: 'panorama_migration_postcheck', message: e.message, violations: e.violations.slice(0, 10) });
    }
    return json(500, { error: e instanceof Error ? e.message : String(e) });
  }
}

// ── 实体 CRUD ─────────────────────────────────────────────

export function handleListEntities(req: Request, ctx: RouteCtx, entity: string): Response {
  const notDefined = schemaOr409(ctx, entity);
  if (notDefined) return notDefined;
  const s = store(ctx);
  // effective schema（DSL + builtin 合并）——task entity 永远 defined，空板也返 200（panorama_builtin §3）
  const schema = readSquadSchema(ctx);
  if (!schema.entities[entity]) return json(404, { code: 'panorama_entity_not_found', entity });
  let list = s.listInstances(entity);
  const params = new URL(req.url).searchParams;
  const filter = params.get('filter');
  const entityDef = schema.entities[entity];
  if (filter) {
    for (const pair of filter.split(',')) {
      const [k, v] = pair.split(':');
      if (!k || v === undefined) continue;
      // boolean 字段 + false 过滤值 → 匹配 MISSING/falsy（语义：archived:false = 未归档，含字段未设）
      // 防 task create 后字段 MISSING 被滤掉（panorama_builtin §5；listActiveTasks 同口径）
      if (entityDef?.fields[k]?.type === 'boolean' && v === 'false') {
        list = list.filter(r => !r[k]);
      } else {
        list = list.filter(r => String(r[k]) === v);
      }
    }
  }
  const sort = params.get('sort');
  if (sort) {
    const [f, order] = sort.split(':');
    if (f) list = [...list].sort((a, b) => cmp(a[f], b[f]) * (order === 'desc' ? -1 : 1));
  }
  const limit = queryNum(req, 'limit') ?? 50;
  return json(200, { instances: list.slice(0, limit) });
}

export async function handleCreateEntity(req: Request, ctx: RouteCtx, entity: string): Promise<Response> {
  const b = await readBody(req);
  if (!b.ok) return b.res;
  const notDefined = schemaOr409(ctx, entity);
  if (notDefined) return notDefined;
  const caller = readCallerCtx(req);
  const s = store(ctx);
  const schema = readSquadSchema(ctx);
  const entityDef = schema.entities[entity];
  if (!entityDef) return json(404, { code: 'panorama_entity_not_found', entity });
  const fields = (b.body.fields as Record<string, unknown>) ?? {};
  const id = String(fields[entityDef.id_field] ?? '');
  if (id.length === 0) return json(400, { code: 'panorama_missing_required', field: entityDef.id_field });
  // create 幂等短路：id 已存在 → 201 created:false，不写库 / 不 emit / 不触发 afterTaskWrite
  if (s.hasId(entity, id)) {
    return json(201, { ok: true, id, created: false });
  }
  // 应用字段缺省值：states.initial + boolean 字段默认 false（panorama_builtin §5；
  // 保证 task.archived=false 存在，view.filter `archived:false` 不漏）
  const defaulted = applyFieldDefaults(entityDef, fields);
  // 按声明类型无损 coerce：number↔string / boolean←"true","false" 同值拧巴不报错
  const record = coerceRecord(entityDef, defaulted);
  const vr = validateInstance(entity, entityDef, record, { mode: 'create', store: storeLike(s) });
  if (!vr.ok) return json(400, { ok: false, errors: vr.errors });
  const created = s.createInstance(entity, id, record, { messageId: caller.messageId ?? null, source: 'api' });
  emitEntity(ctx, entity, 'created', id, created, undefined, s);
  // task 写后置 hook（panorama_builtin §4）
  if (entity === 'task') afterTaskWrite(s);
  return json(201, { ok: true, id, created: true });
}

export function handleGetEntity(ctx: RouteCtx, entity: string, id: string): Response {
  const notDefined = schemaOr409(ctx, entity);
  if (notDefined) return notDefined;
  const s = store(ctx);
  const schema = readSquadSchema(ctx);
  if (!schema.entities[entity]) return json(404, { code: 'panorama_entity_not_found', entity });
  const inst = s.getInstance(entity, id);
  if (!inst) return json(404, { code: 'panorama_instance_not_found' });
  return json(200, inst);
}

export async function handlePatchEntity(req: Request, ctx: RouteCtx, entity: string, id: string): Promise<Response> {
  const b = await readBody(req);
  if (!b.ok) return b.res;
  const notDefined = schemaOr409(ctx, entity);
  if (notDefined) return notDefined;
  const caller = readCallerCtx(req);
  const s = store(ctx);
  const schema = readSquadSchema(ctx);
  const entityDef = schema.entities[entity];
  if (!entityDef) return json(404, { code: 'panorama_entity_not_found', entity });
  const existing = s.getInstance(entity, id);
  if (!existing) return json(404, { code: 'panorama_instance_not_found' });
  const patch = (b.body.patch as Record<string, unknown>) ?? {};
  // patch 触碰状态机字段且值变化 → 走 transition 校验（禁绕过状态机直改状态，对齐 drag/工具 update 路径；
  // 同值幂等放行——BUG-003）
  const stateField = entityDef.states?.field;
  if (stateField && patch[stateField] != null) {
    const from = String(existing[stateField] ?? '');
    const to = String(patch[stateField]);
    if (to !== from) {
      const tr = validateTransition(schema, entity, from, to, existing);
      if (!tr.ok) return json(400, { code: tr.code ?? 'panorama_illegal_transition', reason: tr.message, suggestion: tr.suggestion });
    }
  }
  const merged = { ...existing, ...patch };
  // 按声明类型无损 coerce（覆盖 update 路径）：merged 后类型拧巴统一转
  const coerced = coerceRecord(entityDef, merged);
  const vr = validateInstance(entity, entityDef, coerced, { mode: 'update', store: storeLike(s) });
  if (!vr.ok) return json(400, { ok: false, errors: vr.errors });
  const updated = s.updateInstance(entity, id, coerced, { messageId: caller.messageId ?? null, source: 'api' });
  emitEntity(ctx, entity, 'updated', id, updated ?? merged, undefined, s);
  // task + patch 触 dependencies/status → 重算依赖 waiting/todo（panorama_builtin §4）
  if (entity === 'task' && (patch.dependencies !== undefined || patch.status !== undefined)) {
    afterTaskWrite(s);
  }
  return json(200, { ok: true });
}

export async function handleTransition(req: Request, ctx: RouteCtx, entity: string, id: string): Promise<Response> {
  const b = await readBody(req);
  if (!b.ok) return b.res;
  const notDefined = schemaOr409(ctx, entity);
  if (notDefined) return notDefined;
  const caller = readCallerCtx(req);
  const s = store(ctx);
  const schema = readSquadSchema(ctx);
  const entityDef = schema.entities[entity];
  if (!entityDef) return json(404, { code: 'panorama_entity_not_found', entity });
  const to = String((b.body as { to?: unknown }).to ?? '');
  const inst = s.getInstance(entity, id);
  if (!inst) return json(404, { code: 'panorama_instance_not_found' });
  const stateField = entityDef.states?.field;
  const from = stateField ? String(inst[stateField] ?? '') : '';
  const tr = validateTransition(schema, entity, from, to, inst);
  if (!tr.ok) return json(400, { code: tr.code ?? 'panorama_illegal_transition', reason: tr.message, suggestion: tr.suggestion });
  s.transitionInstance(entity, id, stateField!, from, to, { messageId: caller.messageId ?? null, source: 'drag' });
  emitEntity(ctx, entity, 'transitioned', id, { ...inst, [stateField!]: to }, { from, to }, s);
  // task transition（如 todo→done）→ 重算依赖该 task 的 waiting 解除（panorama_builtin §4）
  if (entity === 'task') {
    afterTaskWrite(s);
    // [v0.0.361 T4] task 状态变化写 reminder queue + audience fanout（与 tool 入口同调 helper，§1.5 不重复实现）
    await notifyTaskTransition(
      { fsRoot: ctx.dataDir, squadId: ctx.squadId, store: s },
      { ...inst, [stateField!]: to },
      to,
    );
  }
  return json(200, { ok: true, from, to });
}

export function handleEvents(req: Request, ctx: RouteCtx): Response {
  const since = queryNum(req, 'since') ?? 0;
  const limit = queryNum(req, 'limit') ?? 50;
  const events = store(ctx).readEvents(since, limit);
  return json(200, { events });
}

// ── helpers ───────────────────────────────────────────────

function emitEntity(
  ctx: RouteCtx, entity: string, action: 'created' | 'updated' | 'transitioned',
  id: string, record: Record<string, unknown>,
  transition: { from: string; to: string } | undefined, s: PanoramaEntityStore,
): void {
  if (!ctx.bus) return;
  const seq = s.readEvents(0, 1)[0]?.seq ?? 0;
  emitPanoramaEvent(ctx.bus, ctx.squadId, {
    type: 'panorama_entity_update', squadId: ctx.squadId, entity, action, id, record,
    ...(transition ? { transition } : {}), source: action === 'transitioned' ? 'drag' : 'api', seq,
  });
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return String(a).localeCompare(String(b));
}

