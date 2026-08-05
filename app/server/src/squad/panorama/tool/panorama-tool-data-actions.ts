/**
 * panorama 工具数据面 action 实现（create/update/transition/delete/query）.
 * 参考: specs/tech/squad/[P1]panorama_tools.md §2.3-§2.7
 * 从 panorama-tool-actions.ts 拆出（单文件 ≤300 行）；schema 面（define/get_schema/events）留在主文件。
 * store 每次 action call 新建（无状态文件 IO）；lastWriteMessageId 从 rtc.currentMessageId 取；source=agent.
 */
import type { ToolInput, ToolRunResult } from '../../../tools/types';
import { errorResult } from '../../../tools/types';
import type { AgentToolRuntimeContext } from '../../../agent/tools/runtime-context';
import type { PanoramaSchema, EntityDef } from '../dsl/types';
import { validateInstance, validateTransition, applyFieldDefaults, coerceRecord } from '../validation';
import { emitPanoramaEvent } from '../http/sse';
import { afterTaskWrite } from '../builtin';
import {
  store, storeLike, msgId, okJson, validationFailed, readSquadSchema,
} from './panorama-tool-actions';

// ── create（数据面，panorama_tools §2.3） ────────────────

export async function runCreate(
  input: ToolInput, rtc: AgentToolRuntimeContext, dataDir: string,
): Promise<ToolRunResult> {
  const { schema, entityDef, error } = resolveEntity(input, rtc, dataDir);
  if (error || !schema || !entityDef) return error ?? errorResult('panorama.create: internal');
  const entity = String(input.entity);
  const fields = (input.fields as Record<string, unknown>) ?? {};
  const idField = entityDef.id_field;
  const id = String(fields[idField] ?? '');
  if (id.length === 0) {
    return errorResult(`panorama.create: id field "${idField}" is required`);
  }
  const s = store(rtc, dataDir);
  // create 幂等短路：id 已存在 → 返 created:false，不写库 / 不 emit / 不触发 afterTaskWrite
  if (s.hasId(entity, id)) {
    return okJson({ ok: true, id, created: false });
  }
  // 应用字段缺省值：states.initial + boolean 字段默认 false（panorama_builtin §5）
  const defaulted = applyFieldDefaults(entityDef, fields);
  // 按声明类型无损 coerce：number↔string / boolean←"true","false" 同值拧巴不报错
  const record = coerceRecord(entityDef, defaulted);
  const vr = validateInstance(entity, entityDef, record, { mode: 'create', store: storeLike(s) });
  if (!vr.ok) return validationFailed(vr);
  const created = s.createInstance(entity, id, record, { messageId: msgId(rtc) ?? null, source: 'agent' });
  emitEntity(rtc, s, entity, 'created', id, created);
  // task 写后置 hook：自动依赖 transition（panorama_builtin §4；仅 task entity 触发）
  if (entity === 'task') {
    afterTaskWrite(s);
  }
  return okJson({ ok: true, id, created: true });
}

// ── update（数据面，panorama_tools §2.4） ────────────────

export async function runUpdate(
  input: ToolInput, rtc: AgentToolRuntimeContext, dataDir: string,
): Promise<ToolRunResult> {
  const { schema, entityDef, error } = resolveEntity(input, rtc, dataDir);
  if (error || !schema || !entityDef) return error ?? errorResult('panorama.update: internal');
  const entity = String(input.entity);
  const id = String(input.id ?? '');
  const patch = (input.patch as Record<string, unknown>) ?? {};
  if (id.length === 0) return errorResult('panorama.update: id is required');
  const s = store(rtc, dataDir);
  const existing = s.getInstance(entity, id);
  if (!existing) return errorResult(JSON.stringify({ code: 'panorama_instance_not_found' }));
  // patch 触碰状态机字段 → 走 transition 校验（禁绕过状态机直改状态，对齐 drag 路径）
  const stateErr = checkStatePatch(schema, entity, entityDef, patch, existing);
  if (stateErr) return stateErr;
  const merged = { ...existing, ...patch };
  // 按声明类型无损 coerce（覆盖 update 路径）：merged 后类型拧巴统一转（如 patch {count:"1928"} 与库里 number merge）
  const coerced = coerceRecord(entityDef, merged);
  const vr = validateInstance(entity, entityDef, coerced, { mode: 'update', store: storeLike(s) });
  if (!vr.ok) return validationFailed(vr);
  const updated = s.updateInstance(entity, id, coerced, { messageId: msgId(rtc) ?? null, source: 'agent' });
  emitEntity(rtc, s, entity, 'updated', id, updated ?? merged);
  // task + patch 触 dependencies/status → 重算依赖 waiting/todo（panorama_builtin §4）
  if (entity === 'task' && (patch.dependencies !== undefined || patch.status !== undefined)) {
    afterTaskWrite(s);
  }
  return okJson({ ok: true });
}

// ── transition（数据面，panorama_tools §2.5） ────────────

export async function runTransition(
  input: ToolInput, rtc: AgentToolRuntimeContext, dataDir: string,
): Promise<ToolRunResult> {
  const { schema, error } = resolveEntity(input, rtc, dataDir);
  if (error || !schema) return error ?? errorResult('panorama.transition: internal');
  const entity = String(input.entity);
  const id = String(input.id ?? '');
  const to = String(input.to ?? '');
  if (id.length === 0) return errorResult('panorama.transition: id is required');
  if (to.length === 0) return errorResult('panorama.transition: to is required');
  const s = store(rtc, dataDir);
  const inst = s.getInstance(entity, id);
  if (!inst) return errorResult(JSON.stringify({ code: 'panorama_instance_not_found' }));
  const entityDef = schema.entities[entity];
  if (!entityDef) return errorResult(JSON.stringify({ code: 'panorama_entity_not_found', entity }));
  const stateField = entityDef.states?.field;
  const from = stateField ? String(inst[stateField] ?? '') : '';
  const tr = validateTransition(schema, entity, from, to, inst);
  if (!tr.ok) {
    return errorResult(JSON.stringify({ code: tr.code ?? 'panorama_illegal_transition', reason: tr.message, suggestion: tr.suggestion }));
  }
  s.transitionInstance(entity, id, stateField!, from, to, { messageId: msgId(rtc) ?? null, source: 'agent' });
  if (rtc.panoramaBus) {
    const seq = s.readEvents(0, 1)[0]?.seq ?? 0;
    emitPanoramaEvent(rtc.panoramaBus, rtc.selfSquadId!, { type: 'panorama_entity_update', squadId: rtc.selfSquadId!, entity, action: 'transitioned', id, record: { ...inst, [stateField!]: to }, transition: { from, to }, source: 'agent', seq });
  }
  // task transition（如 todo→done）→ 重算依赖该 task 的 waiting 解除（panorama_builtin §4）
  if (entity === 'task') {
    afterTaskWrite(s);
  }
  return okJson({ ok: true, from, to });
}

// ── delete（数据面，panorama_tools §2.8） ────────────────

export async function runDelete(
  input: ToolInput, rtc: AgentToolRuntimeContext, dataDir: string,
): Promise<ToolRunResult> {
  const { error } = resolveEntity(input, rtc, dataDir);
  if (error) return error;
  const entity = String(input.entity);
  const id = String(input.id ?? '');
  if (id.length === 0) return errorResult('panorama.delete: id is required');
  const s = store(rtc, dataDir);
  const inst = s.getInstance(entity, id);
  if (!inst) return errorResult(JSON.stringify({ code: 'panorama_instance_not_found' }));
  // removeInstance 物理删除 + 写 entity.deleted 审计事件
  s.removeInstance(entity, id, { messageId: msgId(rtc) ?? null, source: 'agent' });
  emitEntity(rtc, s, entity, 'deleted', id, inst);
  return okJson({ ok: true, id });
}

// ── query（读，panorama_tools §2.6） ─────────────────────

export async function runQuery(
  input: ToolInput, rtc: AgentToolRuntimeContext, dataDir: string,
): Promise<ToolRunResult> {
  const { error } = resolveEntity(input, rtc, dataDir);
  if (error) return error;
  const entity = String(input.entity);
  const s = store(rtc, dataDir);
  let list = s.listInstances(entity);
  const filter = input.filter as Record<string, unknown> | undefined;
  if (filter) {
    list = list.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
  }
  const sort = input.sort as { field?: string; order?: string } | undefined;
  if (sort?.field) {
    const f = sort.field;
    const dir = sort.order === 'desc' ? -1 : 1;
    list = [...list].sort((a, b) => cmp(a[f], b[f]) * dir);
  }
  const limit = typeof input.limit === 'number' ? input.limit : 50;
  return okJson({ instances: list.slice(0, limit) });
}

// ── helpers ──────────────────────────────────────────────

interface EntityResolve {
  schema?: PanoramaSchema;
  entityDef?: EntityDef;
  error?: ToolRunResult;
}

/** 解析 entity：readSquadSchema（已 ensure task）→ 查 entityDef.
 *  - task entity 永远 resolved（system ensure 兜底）
 *  - 非 system entity + schema 仅有 system entity（leader 未 define）→ panorama_schema_not_defined
 *  - 非 system entity + schema 有 leader entity 但缺此 entity → panorama_entity_not_found */
function resolveEntity(
  input: ToolInput, rtc: AgentToolRuntimeContext, dataDir: string,
): EntityResolve {
  const entity = String(input.entity ?? '');
  const schema = readSquadSchema(rtc, dataDir);
  if (entity.length === 0) {
    return { schema, error: errorResult('panorama: entity is required') };
  }
  const entityDef = schema.entities[entity];
  if (entityDef) return { schema, entityDef };
  // 未命中：system entity 不可能（ensure 兜底），此处是非 system entity
  // schema 仅有 system entity（无 leader entity）→ leader 未 define → schema_not_defined
  // schema 有 leader entity 但缺此 entity → entity_not_found
  const hasLeaderEntity = Object.values(schema.entities).some((e) => !e.system);
  const code = hasLeaderEntity ? 'panorama_entity_not_found' : 'panorama_schema_not_defined';
  return { schema, error: errorResult(JSON.stringify({ code, ...(code === 'panorama_entity_not_found' ? { entity } : {}) })) };
}

/** update patch 触碰状态机字段时走 transition 校验（from→to 合法性 + guard + terminal 锁） */
function checkStatePatch(
  schema: PanoramaSchema, entity: string, entityDef: EntityDef,
  patch: Record<string, unknown>, existing: Record<string, unknown>,
): ToolRunResult | null {
  const stateField = entityDef.states?.field;
  if (!stateField || patch[stateField] == null) return null;
  const from = String(existing[stateField] ?? '');
  const to = String(patch[stateField]);
  if (to === from) return null; // 同值重写不算跃迁
  const tr = validateTransition(schema, entity, from, to, existing);
  if (!tr.ok) {
    return errorResult(JSON.stringify({ code: tr.code ?? 'panorama_illegal_transition', reason: tr.message, suggestion: tr.suggestion }));
  }
  return null;
}

/** create/update/delete 后统一 emit panorama_entity_update（transition 走自己的带 from/to 版本） */
function emitEntity(
  rtc: AgentToolRuntimeContext, s: ReturnType<typeof store>,
  entity: string, action: 'created' | 'updated' | 'deleted',
  id: string, record: Record<string, unknown>,
): void {
  if (!rtc.panoramaBus) return;
  const seq = s.readEvents(0, 1)[0]?.seq ?? 0;
  emitPanoramaEvent(rtc.panoramaBus, rtc.selfSquadId!, {
    type: 'panorama_entity_update', squadId: rtc.selfSquadId!, entity, action, id, record, source: 'agent', seq,
  });
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return String(a).localeCompare(String(b));
}
