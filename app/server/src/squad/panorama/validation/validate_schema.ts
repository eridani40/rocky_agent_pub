/**
 * Panorama 四层校验引擎 — 主入口 + Layer 1 语法层 + Layer 2 schema 层.
 * 参考: specs/tech/squad/[P1]panorama_validation.md §1-§3
 * Layer 3 语义层在 validate_semantic.ts；Layer 4 数据安全层在 validate_data_safety.ts.
 *
 * Layer 1（语法）：parseDsl 短路——parse 不了后续层无意义。
 * Layer 2（schema）：不短路——收集全部错误一次性返回。
 */
import { parseDsl } from '../dsl/parser';
import type {
  PanoramaSchema, EntityDef, FieldDef, EnumFieldDef,
} from '../dsl/types';
import type {
  ValidationResult, ValidationError, ValidationWarning,
  ValidationOptions,
} from './types';
import { makeError } from './types';
import { validateSemantic } from './validate_semantic';
import { validateDataSafety } from './validate_data_safety';
import { checkSystemEntityImmutable } from './validate_system_entity';

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const VERSION_RE = /^\d+\.\d+$/;

/** 共享错误工厂别名（m5：逻辑收敛到 types.makeError） */
const e = makeError;

// ── 主入口：四层校验（接受 DSL 文本或已解析 schema） ──────

export function validateSchema(
  input: string | PanoramaSchema,
  options: ValidationOptions = {},
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Layer 1: 语法层（parseDsl 已含 YAML parse + 根类型 + 顶层键 + 基础结构 + 护栏）
  let schema: PanoramaSchema;
  if (typeof input === 'string') {
    const parsed = parseDsl(input);
    if (!parsed.ok) {
      // 短路：syntax/schema 基础错误直接返回
      return { ok: false, errors: parsed.errors, warnings: [] };
    }
    schema = parsed.schema;
    // ParseWarning 缺 layer 字段 — 边界 map 补 'schema'（C1：ParseWarning → ValidationWarning）
    warnings.push(...parsed.warnings.map(w => ({ ...w, layer: 'schema' as const })));
  } else {
    schema = input;
  }

  // Layer 2: schema 层（不短路）
  checkSchema(schema, errors, warnings);

  // Layer 2.5: 系统固定 entity 不可变（panorama_system_entity_immutable）.
  // 在 Layer 2 之后跑（依赖 schema 基础结构合法）；不需要 oldSchema（canonical 即权威）.
  // 时序：define 流程中 validate 先跑（让 check 看到 leader 原始提交拒漂移）→ pass 后 inject.
  checkSystemEntityImmutable(schema, errors);

  // Layer 3: 语义层（不短路）
  validateSemantic(schema, errors, warnings);

  // Layer 4: 数据安全层（仅有 oldSchema + store 时触发；deferDataSafety 时跳过，
  // 破坏性变更由 migration 引擎裁决——见 ValidationOptions.deferDataSafety）
  if (options.oldSchema && options.store && !options.deferDataSafety) {
    validateDataSafety(options.oldSchema, schema, options.store, errors);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** validateDsl — 文本入口别名（对齐 change_plan 符号名） */
export function validateDsl(
  text: string,
  options: ValidationOptions = {},
): ValidationResult {
  return validateSchema(text, options);
}

/** validateSyntax — 单独跑 Layer 1（parseDsl wrapper） */
export function validateSyntax(text: string): ValidationResult {
  const parsed = parseDsl(text);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [] };
  return { ok: true, errors: [], warnings: parsed.warnings.map(w => ({ ...w, layer: 'schema' as const })) };
}

// ── Layer 2: schema 层规则 ───────────────────────────────

function checkSchema(
  schema: PanoramaSchema,
  errors: ValidationError[],
  warnings: ValidationWarning[],
): void {
  if (!VERSION_RE.test(schema.meta.version)) {
    errors.push(e('schema', 'panorama_invalid_version', 'meta.version',
      `meta.version "${schema.meta.version}" 不符合 \\d+\\.\\d+`, '"1.0"'));
  }
  // M3: updated_at 不可手填 — 引擎自动维护（spec §3.1）
  if (schema.meta.updated_at) {
    errors.push(e('schema', 'panorama_manual_updated_at', 'meta.updated_at',
      'meta.updated_at 不可手填，引擎自动维护', '删除 updated_at 字段'));
  }
  for (const [name, entity] of Object.entries(schema.entities)) {
    checkEntity(name, entity, errors, warnings);
  }
  checkEnumCollisions(schema, errors);
  checkViewIds(schema, errors);
}

function checkEntity(
  name: string, entity: EntityDef,
  errors: ValidationError[], warnings: ValidationWarning[],
): void {
  const b = `entities.${name}`;

  // id_field 指向 string 类型字段
  const idField = entity.fields[entity.id_field];
  if (!idField) {
    errors.push(e('schema', 'panorama_id_field_not_string', `${b}.id_field`,
      `id_field "${entity.id_field}" 不在 fields 中`));
  } else if (idField.type !== 'string') {
    errors.push(e('schema', 'panorama_id_field_not_string', `${b}.id_field`,
      `id_field "${entity.id_field}" 必须指向 string 字段，实际是 ${idField.type}`));
  }

  for (const [fname, field] of Object.entries(entity.fields)) {
    checkField(fname, field, `${b}.fields.${fname}`, errors);
  }
  if (entity.states) checkStates(name, entity, errors);
  if (entity.display) checkDisplay(name, entity, errors, warnings);
}

function checkField(
  fname: string, field: FieldDef, p: string, errors: ValidationError[],
): void {
  if (field.type === 'enum') {
    const seen = new Set<string>();
    for (const v of (field as EnumFieldDef).values) {
      if (!NAME_RE.test(v)) {
        errors.push(e('schema', 'panorama_invalid_enum_value', `${p}.values`,
          `enum 值 "${v}" 不符合 ^[a-z][a-z0-9_]*$`));
      }
      if (seen.has(v)) {
        errors.push(e('schema', 'panorama_duplicate_enum_value', `${p}.values`,
          `enum 值 "${v}" 重复`));
      }
      seen.add(v);
    }
  }
  if (field.type === 'string' && field.max !== undefined &&
    (field.max <= 0 || !Number.isInteger(field.max))) {
    errors.push(e('schema', 'panorama_invalid_max', `${p}.max`,
      `max=${field.max} 必须是正整数`));
  }
  if (field.type === 'number' && field.min !== undefined && field.max !== undefined &&
    field.min > field.max) {
    errors.push(e('schema', 'panorama_invalid_range', p,
      `min=${field.min} > max=${field.max}`));
  }
}

function checkStates(
  name: string, entity: EntityDef, errors: ValidationError[],
): void {
  const states = entity.states!;
  const b = `entities.${name}.states`;
  const field = entity.fields[states.field];

  if (!field || field.type !== 'enum') {
    errors.push(e('schema', 'panorama_state_field_not_enum', `${b}.field`,
      `states.field "${states.field}" 必须指向 enum 字段${field ? `，实际是 ${field.type}` : '（字段不存在）'}`));
    return; // 没有 enum 基准，后续 initial/transition/terminal 无法检查
  }
  const vals = new Set((field as EnumFieldDef).values);

  if (!vals.has(states.initial)) {
    errors.push(e('schema', 'panorama_invalid_initial', `${b}.initial`,
      `initial "${states.initial}" 不在 enum values 内`));
  }
  for (const [from, targets] of Object.entries(states.transitions)) {
    if (!vals.has(from)) {
      errors.push(e('schema', 'panorama_invalid_transition_target', `${b}.transitions.${from}`,
        `transition from "${from}" 不在 enum values 内`));
    }
    for (const t of targets) {
      if (!vals.has(t.to)) {
        errors.push(e('schema', 'panorama_invalid_transition_target', `${b}.transitions.${from}`,
          `transition to "${t.to}" 不在 enum values 内`));
      }
      if (t.guard && !entity.fields[t.guard.field]) {
        errors.push(e('schema', 'panorama_guard_unknown_field', `${b}.transitions.${from}`,
          `guard.field "${t.guard.field}" 不是 ${name} 的字段`));
      }
    }
  }
  if (states.terminal) {
    for (const t of states.terminal) {
      if (!vals.has(t)) {
        errors.push(e('schema', 'panorama_invalid_terminal', `${b}.terminal`,
          `terminal "${t}" 不在 enum values 内`));
      }
    }
  }
}

/** 宽松判定 string map（display 的 {field}_labels 宽松索引值，非 object 直接跳过不告警） */
function isStrMap(v: unknown): v is Record<string, string> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkDisplay(
  name: string, entity: EntityDef,
  errors: ValidationError[], warnings: ValidationWarning[],
): void {
  const d = entity.display!;
  const b = `entities.${name}.display`;

  // 实体全部 enum 字段 values（按字段名索引 + 并集）——无 states 实体也校验 display key
  const enumFields = new Map<string, Set<string>>();
  const allEnumVals = new Set<string>();
  for (const [fname, field] of Object.entries(entity.fields)) {
    if (field.type !== 'enum') continue;
    const vals = new Set((field as EnumFieldDef).values);
    enumFields.set(fname, vals);
    for (const v of vals) allEnumVals.add(v);
  }

  // status_labels（全局兜底映射）/ status_colors：key 须在任一 enum 字段 values 并集内
  for (const entries of [d.status_labels, d.status_colors]) {
    if (!entries) continue;
    for (const [k, v] of Object.entries(entries)) {
      if (!allEnumVals.has(k)) {
        warnings.push({ layer: 'schema', code: 'panorama_warn_unknown_display_key',
          path: `${b}.${k}`, message: `display key "${k}" 不在任一 enum 字段 values 内` });
      }
      if (d.status_colors === entries && typeof v === 'string' && !HEX_RE.test(v)) {
        errors.push(e('schema', 'panorama_invalid_color', `${b}.status_colors.${k}`,
          `color "${v}" 不是合法 hex (#RRGGBB)`, '"#4c9aff"'));
      }
    }
  }

  // 字段级 {field}_labels：field 须是本实体 enum 字段，key 须在该字段 values 内
  for (const [key, entries] of Object.entries(d as Record<string, unknown>)) {
    if (key === 'status_labels' || key === 'status_colors' || !isStrMap(entries)) continue;
    const m = /^([a-z][a-z0-9_]*)_labels$/.exec(key);
    if (!m) continue;
    const fname = m[1]!;
    const vals = enumFields.get(fname);
    if (!vals) {
      warnings.push({ layer: 'schema', code: 'panorama_warn_unknown_display_key',
        path: `${b}.${key}`, message: `"${fname}" 不是 ${name} 的 enum 字段` });
      continue;
    }
    for (const k of Object.keys(entries)) {
      if (!vals.has(k)) {
        warnings.push({ layer: 'schema', code: 'panorama_warn_unknown_display_key',
          path: `${b}.${key}.${k}`, message: `display key "${k}" 不在 ${fname} 的 enum values 内` });
      }
    }
  }
}

function checkEnumCollisions(schema: PanoramaSchema, errors: ValidationError[]): void {
  const seen = new Map<string, string[]>();
  for (const [ename, entity] of Object.entries(schema.entities)) {
    for (const [fname, field] of Object.entries(entity.fields)) {
      if (field.type !== 'enum') continue;
      const vals = (field as EnumFieldDef).values;
      const prev = seen.get(fname);
      if (prev && prev.join(',') !== vals.join(',')) {
        errors.push(e('schema', 'panorama_enum_name_collision',
          `entities.${ename}.fields.${fname}`,
          `同名字段 "${fname}" 在不同实体中 enum values 不一致`));
      } else if (!prev) {
        seen.set(fname, vals);
      }
    }
  }
}

function checkViewIds(schema: PanoramaSchema, errors: ValidationError[]): void {
  const ids = new Set<string>();
  schema.views.forEach((view, i) => {
    const p = `views[${i}]`;
    if (!NAME_RE.test(view.id)) {
      errors.push(e('schema', 'panorama_invalid_view_id', `${p}.id`,
        `view id "${view.id}" 不符合 ^[a-z][a-z0-9_]*$`));
    }
    if (ids.has(view.id)) {
      errors.push(e('schema', 'panorama_duplicate_view_id', `${p}.id`,
        `view id "${view.id}" 重复`));
    }
    ids.add(view.id);
  });
}
