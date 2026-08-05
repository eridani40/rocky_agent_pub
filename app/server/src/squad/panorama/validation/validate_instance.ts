/**
 * Panorama 实例写校验 — create/update 时校验实例值符合 DSL 约束（Layer 2 子集）.
 * 参考: specs/tech/squad/[P1]panorama_validation.md §6
 *
 * 规则从 DSL 派生（不硬编码）；三路写入（拖拽/工具/API）共用。
 */
import type {
  EntityDef, FieldDef, EnumFieldDef, RefFieldDef,
  StringFieldDef, NumberFieldDef,
} from '../dsl/types';
import type { ValidationError, StoreLike } from './types';
import { makeError } from './types';

/** 共享错误工厂 — 固定 schema 层（m5：逻辑收敛到 types.makeError） */
const e = (code: string, path: string, msg: string): ValidationError =>
  makeError('schema', code, path, msg);

/** 带引导语的错误工厂 — message 含声明约束原文，suggestion 指向 readSchema / GET schema */
const eHint = (code: string, path: string, msg: string): ValidationError => {
  const suggestion = `拿不准字段约束先 panorama readSchema / GET schema 看 ${path} 声明`;
  return makeError('schema', code, path, msg, suggestion);
};

/** 字段声明约束原文（喂进错误 message，让 agent 自我定位） */
function declaredStringConstraints(field: StringFieldDef): string {
  const parts: string[] = ['type=string'];
  if (field.max !== undefined) parts.push(`max=${field.max}`);
  if (field.pattern) parts.push(`pattern=${field.pattern}`);
  return parts.join(', ');
}

function declaredNumberConstraints(field: NumberFieldDef): string {
  const parts: string[] = ['type=number'];
  if (field.min !== undefined) parts.push(`min=${field.min}`);
  if (field.max !== undefined) parts.push(`max=${field.max}`);
  return parts.join(', ');
}

/**
 * 应用字段缺省值：states.initial（状态字段）+ boolean 字段默认 false.
 * 用于 create 路径（工具 runCreate + HTTP handleCreateEntity），保证实例字段存在 +
 * boolean 字段不缺省（避免 view.filter `archived:false` 因字段 MISSING 把记录滤掉）.
 *
 * 语义：boolean 字段 absence = falsy（如 archived 未设 = 未归档），与 listActiveTasks 的
 * `t.archived !== true` 过滤口径一致（panorama_builtin §5）.
 */
export function applyFieldDefaults(
  entityDef: EntityDef,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...fields };
  // 状态字段缺省 → states.initial
  if (entityDef.states) {
    const sf = entityDef.states.field;
    if (out[sf] == null && entityDef.states.initial) {
      out[sf] = entityDef.states.initial;
    }
  }
  // boolean 字段缺省 → false（absence = falsy）
  for (const [fname, fdef] of Object.entries(entityDef.fields)) {
    if ((fdef as FieldDef).type === 'boolean' && out[fname] == null) {
      out[fname] = false;
    }
  }
  return out;
}

/**
 * 单字段按声明类型无损 coerce（number↔string / boolean←"true"|"false"）.
 *
 * - number 字段 + string 值：`Number(v)` 有限且 `String(Number(v))===v.trim()` → 转 number
 * - string 字段 + number 值（有限）：→ `String(v)`
 * - boolean 字段 + 字面串 "true"/"false"：→ 转 boolean
 * - enum/ref/datetime 字段 / 有损 / 不合法值：原值返回（交下游 check 报错）
 * - value==null：原值返回（null/空值语义交 required 校验）
 *
 * 纯函数 — 不抛异常；无损 round-trip 是核心约束（`"0x10"`/`"1.0"`/`""` 等不 coerce）.
 */
function coerceFieldValue(field: FieldDef, value: unknown): unknown {
  if (value == null) return value;
  switch (field.type) {
    case 'number': {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        // 空串 / 纯空白 不 coerce（保留原值交 required 或 type 校验）
        if (trimmed.length === 0) return value;
        const n = Number(trimmed);
        // 严格 round-trip：String(Number(v))===trimmed（排掉 0x10/1.0/1e3/12a 等）
        if (Number.isFinite(n) && String(n) === trimmed) return n;
      }
      return value;
    }
    case 'string': {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
      }
      return value;
    }
    case 'boolean': {
      // 仅认字面串 "true"/"false"；"True"/1/0 等不 coerce（过宽易误判）
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    }
    default:
      // enum/ref/datetime：不 coerce（语义串/严格 id/ISO 解析交给 check）
      return value;
  }
}

/**
 * 实例写前按 entityDef 声明类型无损 coerce 各字段值，返回**新 record**（不 mutate 入参）.
 *
 * 用于 create/update 路径（tool runCreate/runUpdate + http handleCreateEntity/handlePatchEntity），
 * 让同值类型拧巴（number 字段传 "1928" / string 字段传 1928）不报错.
 * 有损/不合法值保留原值交下游 validateInstance 报错（pattern/enum/range/required）.
 *
 * 参考: specs/tech/squad/[P1]panorama_validation.md §6
 */
export function coerceRecord(
  entityDef: EntityDef,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [fname, value] of Object.entries(record)) {
    const field = entityDef.fields[fname];
    out[fname] = field ? coerceFieldValue(field, value) : value;
  }
  return out;
}

export interface InstanceValidationOptions {
  mode: 'create' | 'update';
  store?: StoreLike;
}

export interface InstanceValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

export function validateInstance(
  entityName: string,
  entityDef: EntityDef,
  record: Record<string, unknown>,
  options: InstanceValidationOptions,
): InstanceValidationResult {
  const errors: ValidationError[] = [];
  const b = `entities.${entityName}`;

  for (const [fname, field] of Object.entries(entityDef.fields)) {
    checkFieldValue(fname, field, record[fname], `${b}.${fname}`, entityName, options, errors);
  }

  if (options.mode === 'create') {
    // id 唯一性由调用方短路（runCreate / handleCreateEntity 在 coerce+validate 之前用 store.hasId 判定
    // 命中→直接返 created:false；本函数不再做 duplicate check，避免双重判定死代码）
    // 状态字段值合法
    if (entityDef.states) {
      checkInitialState(entityName, entityDef, record, b, errors);
    }
  }

  return { ok: errors.length === 0, errors };
}

function checkFieldValue(
  fname: string, field: FieldDef, value: unknown, p: string,
  entityName: string, opts: InstanceValidationOptions, errors: ValidationError[],
): void {
  if (value == null || value === '') {
    if (field.required) {
      errors.push(e('panorama_missing_required', p, `必填字段 "${fname}" 为空`));
    }
    return; // null/空值：只查 required，跳过类型校验
  }
  switch (field.type) {
    case 'string':
      checkString(fname, field as StringFieldDef, value, p, errors);
      break;
    case 'number':
      checkNumber(fname, field as NumberFieldDef, value, p, errors);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push(e('panorama_type_mismatch', p, `字段 "${fname}" 应为 boolean，实际 ${typeof value}`));
      }
      break;
    case 'enum':
      checkEnumValue(fname, field as EnumFieldDef, value, p, errors);
      break;
    case 'ref':
      checkRefValue(fname, field as RefFieldDef, value, p, opts, errors);
      break;
    case 'datetime':
      if (isNaN(Date.parse(String(value)))) {
        errors.push(e('panorama_invalid_datetime', p, `字段 "${fname}" 值 "${value}" 不是合法 ISO 8601`));
      }
      break;
  }
}

function checkString(fname: string, field: StringFieldDef, value: unknown, p: string, errors: ValidationError[]): void {
  const decl = declaredStringConstraints(field);
  if (typeof value !== 'string') {
    errors.push(eHint('panorama_type_mismatch', p,
      `字段 "${fname}" 应为 string，实际 ${typeof value}（声明约束: ${decl}）`));
    return;
  }
  if (field.max !== undefined && value.length > field.max) {
    errors.push(eHint('panorama_value_too_long', p,
      `字段 "${fname}" 长度 ${value.length} 超过声明 max=${field.max}`));
  }
  if (field.pattern && !new RegExp(field.pattern).test(value)) {
    errors.push(eHint('panorama_pattern_mismatch', p,
      `字段 "${fname}" 值 "${value}" 不匹配声明 pattern=${field.pattern}`));
  }
}

function checkNumber(fname: string, field: NumberFieldDef, value: unknown, p: string, errors: ValidationError[]): void {
  const decl = declaredNumberConstraints(field);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(eHint('panorama_type_mismatch', p,
      `字段 "${fname}" 应为 number，实际 ${typeof value}（声明约束: ${decl}）`));
    return;
  }
  if (field.min !== undefined && value < field.min) {
    errors.push(eHint('panorama_value_out_of_range', p,
      `字段 "${fname}" 值 ${value} 低于声明 min=${field.min}`));
  }
  if (field.max !== undefined && value > field.max) {
    errors.push(eHint('panorama_value_out_of_range', p,
      `字段 "${fname}" 值 ${value} 超过声明 max=${field.max}`));
  }
}

function checkEnumValue(fname: string, field: EnumFieldDef, value: unknown, p: string, errors: ValidationError[]): void {
  const decl = `type=enum, values=[${field.values.join(', ')}]`;
  if (typeof value !== 'string') {
    errors.push(eHint('panorama_type_mismatch', p,
      `字段 "${fname}" 应为 enum(string)，实际 ${typeof value}（声明约束: ${decl}）`));
    return;
  }
  if (!field.values.includes(value)) {
    errors.push(eHint('panorama_invalid_enum_value', p,
      `字段 "${fname}" 值 "${value}" 不在 enum values 内（声明约束: ${decl}）`));
  }
}

function checkRefValue(
  fname: string, field: RefFieldDef, value: unknown, p: string,
  opts: InstanceValidationOptions, errors: ValidationError[],
): void {
  if (typeof value !== 'string') {
    errors.push(e('panorama_type_mismatch', p, `字段 "${fname}" 应为 ref(string id)，实际 ${typeof value}`));
    return;
  }
  if (opts.store?.getInstance && !opts.store.getInstance(field.entity, value)) {
    errors.push(e('panorama_dangling_ref', p,
      `ref 字段 "${fname}" 指向 ${field.entity}/${value} 不存在`));
  }
}

function checkInitialState(
  entityName: string, entityDef: EntityDef, record: Record<string, unknown>,
  b: string, errors: ValidationError[],
): void {
  const states = entityDef.states!;
  const sf = entityDef.fields[states.field];
  if (sf?.type !== 'enum') return;
  const vals = (sf as EnumFieldDef).values;
  const current = record[states.field];
  if (current == null) return; // 未提供 → 用 initial 默认值（schema 层已校验）
  if (!vals.includes(String(current))) {
    errors.push(e('panorama_invalid_initial_value', `${b}.${states.field}`,
      `状态值 "${current}" 不在 enum values [${vals.join(', ')}] 内`));
  }
}
