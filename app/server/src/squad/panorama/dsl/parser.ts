/**
 * Panorama DSL parser — YAML parse + 类型校验 + 护栏检查（Layer 1 语法 + Layer 2 schema 基础）.
 * 参考: specs/tech/squad/[P1]panorama_dsl.md §1-§6
 *       specs/tech/squad/[P1]panorama_validation.md §2-§3
 * 深层语义校验 + 数据安全层在 validation 模块（Task#2）。
 */
import { parse as parseYaml } from 'yaml';
import type {
  PanoramaSchema, EntityDef, FieldDef, StatesDef, TransitionTarget,
  ViewDef, MetaDef, VersionBlock, Guard, GuardOp, CardTemplate,
  KanbanViewDef, TableViewDef, BarChartViewDef,
  ParseResult, ParseError, ParseWarning,
} from './types';

const FIELD_TYPES = new Set(['string', 'number', 'boolean', 'enum', 'ref', 'datetime']);
const ENTITY_NAME_RE = /^[a-z][a-z0-9_]*$/;
const VERSION_RE = /^\d+\.\d+$/;
const VALID_OPS: Set<GuardOp> = new Set(['eq', 'ne', 'gte', 'lte', 'gt', 'lt', 'in', 'not_in']);

export const LIMITS = {
  MAX_ENTITIES: 20, MAX_FIELDS: 30, MAX_VIEWS: 10,
  MAX_ENUM_VALUES: 15, MAX_CARD_TEMPLATE: 200, MAX_TRANSITIONS: 10,
} as const;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const strArr = (r: unknown): string[] | null =>
  Array.isArray(r) ? r.filter((v): v is string => typeof v === 'string') : null;

function err(layer: 'syntax' | 'schema', code: string, path: string, msg: string): ParseError {
  return { layer, code, path, message: msg };
}
function reqStr(raw: unknown, p: string, errs: ParseError[]): string | null {
  if (typeof raw !== 'string') {
    errs.push(err('schema', 'panorama_missing_field', p, `缺少必填字段（应为 string）: ${p}`));
    return null;
  }
  return raw;
}
function limitErr(item: string, n: number, max: number, p: string): ParseError {
  return err('schema', `panorama_limit_${item.replace(/ /g, '_')}`, p, `${item} 数量 ${n} 超过上限 ${max}`);
}

export function parseDsl(text: string): ParseResult {
  const errors: ParseError[] = [];
  const warnings: ParseWarning[] = [];
  let raw: unknown;
  try { raw = parseYaml(text); }
  catch (e) {
    return { ok: false, errors: [err('syntax', 'panorama_yaml_parse_error', '',
      `YAML 解析失败: ${(e as Error).message}`)] };
  }
  if (!isObj(raw)) {
    return { ok: false, errors: [err('syntax', 'panorama_invalid_root', '',
      `DSL 根必须是 map，实际为 ${raw === null ? 'null' : typeof raw}`)] };
  }
  if (!isObj(raw.entities))
    errors.push(err('syntax', 'panorama_missing_top_level', 'entities', '缺少顶层键 entities'));
  if (!Array.isArray(raw.views))
    errors.push(err('syntax', 'panorama_missing_top_level', 'views', '缺少顶层键 views'));
  if (errors.length > 0) return { ok: false, errors };

  const meta = parseMeta(raw.meta, warnings);
  const verBlock: VersionBlock | undefined = isObj(raw.version) ? raw.version as VersionBlock : undefined;
  const entities = parseEntities(raw.entities as Record<string, unknown>, errors);
  const views = parseViews(raw.views as unknown[], errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, schema: { meta, version: verBlock, entities, views }, warnings };
}

function parseMeta(raw: unknown, warns: ParseWarning[]): MetaDef {
  const m = isObj(raw) ? raw : {};
  let ver = typeof m.version === 'string' ? m.version : '';
  if (!ver || !VERSION_RE.test(ver)) {
    if (ver) warns.push({ code: 'panorama_meta_default', path: 'meta.version',
      message: `meta.version "${ver}" 不符合 \\d+\\.\\d+，填充 "1.0"` });
    else warns.push({ code: 'panorama_meta_default', path: 'meta.version',
      message: 'meta.version 缺失，填充默认值 "1.0"' });
    ver = '1.0';
  }
  return { version: ver,
    author: typeof m.author === 'string' ? m.author : undefined,
    created_at: typeof m.created_at === 'string' ? m.created_at : undefined,
    updated_at: typeof m.updated_at === 'string' ? m.updated_at : undefined };
}

function parseEntities(raw: Record<string, unknown>, errs: ParseError[]): Record<string, EntityDef> {
  const names = Object.keys(raw);
  if (names.length > LIMITS.MAX_ENTITIES)
    errs.push(limitErr('entities', names.length, LIMITS.MAX_ENTITIES, 'entities'));
  const out: Record<string, EntityDef> = {};
  for (const name of names) {
    if (!ENTITY_NAME_RE.test(name)) {
      errs.push(err('schema', 'panorama_invalid_entity_name', `entities.${name}`,
        `实体名 "${name}" 不符合 ^[a-z][a-z0-9_]*$`));
      continue;
    }
    const e = parseEntity(name, raw[name], errs);
    if (e) out[name] = e;
  }
  return out;
}

function parseEntity(name: string, raw: unknown, errs: ParseError[]): EntityDef | null {
  if (!isObj(raw)) {
    errs.push(err('schema', 'panorama_invalid_entity', `entities.${name}`, `实体 ${name} 必须是 map`));
    return null;
  }
  const b = `entities.${name}`;
  const label = reqStr(raw.label, `${b}.label`, errs);
  const idField = reqStr(raw.id_field, `${b}.id_field`, errs);
  const fields = parseFields(raw.fields, errs, b);
  const states = parseStates(raw.states, errs, b);
  const display = isObj(raw.display) ? raw.display as Record<string, unknown> : undefined;
  if (!label || !idField) return null;
  const ent: EntityDef = { label, id_field: idField, fields };
  if (states) ent.states = states;
  if (display) ent.display = display;
  return ent;
}

function parseFields(raw: unknown, errs: ParseError[], base: string): Record<string, FieldDef> {
  if (!isObj(raw)) {
    errs.push(err('schema', 'panorama_missing_fields', `${base}.fields`, `${base} 缺少 fields`));
    return {};
  }
  const names = Object.keys(raw);
  if (names.length > LIMITS.MAX_FIELDS)
    errs.push(limitErr('fields', names.length, LIMITS.MAX_FIELDS, `${base}.fields`));
  const out: Record<string, FieldDef> = {};
  for (const fn of names) {
    const f = parseField(fn, raw[fn], errs, `${base}.fields.${fn}`);
    if (f) out[fn] = f;
  }
  return out;
}

function parseField(name: string, raw: unknown, errs: ParseError[], p: string): FieldDef | null {
  if (!isObj(raw)) {
    errs.push(err('schema', 'panorama_invalid_field', p, `字段 ${name} 必须是 map`));
    return null;
  }
  const type = raw.type;
  if (typeof type !== 'string' || !FIELD_TYPES.has(type)) {
    errs.push(err('schema', 'panorama_invalid_field_type', p,
      `字段 ${name} type="${type}" 不在 {string,number,boolean,enum,ref,datetime}`));
    return null;
  }
  const r = raw.required === true;
  // label = 字段展示名（可选，仅 string 才收；非 string 静默忽略，对齐 pattern 风格）
  const label = typeof raw.label === 'string' ? raw.label : undefined;
  const base = label !== undefined ? { required: r, label } : { required: r };
  const num = (k: string) => typeof raw[k] === 'number' ? raw[k] as number : undefined;
  switch (type) {
    case 'string': return { type, ...base, max: num('max'), pattern: typeof raw.pattern === 'string' ? raw.pattern : undefined };
    case 'number': return { type, ...base, min: num('min'), max: num('max') };
    case 'boolean': return { type, ...base };
    case 'enum': {
      const vals = strArr(raw.values);
      if (!vals || vals.length === 0) {
        errs.push(err('schema', 'panorama_missing_enum_values', p, `enum 字段 ${name} 缺少 values`));
        return null;
      }
      if (vals.length > LIMITS.MAX_ENUM_VALUES)
        errs.push(limitErr('enum_values', vals.length, LIMITS.MAX_ENUM_VALUES, p));
      return { type, ...base, values: vals };
    }
    case 'ref': {
      const ent = reqStr(raw.entity, `${p}.entity`, errs);
      return ent ? { type, ...base, entity: ent } : null;
    }
    case 'datetime': return { type, ...base };
    default: return null;
  }
}

function parseStates(raw: unknown, errs: ParseError[], base: string): StatesDef | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw)) {
    errs.push(err('schema', 'panorama_invalid_states', `${base}.states`, `${base}.states 必须是 map`));
    return undefined;
  }
  const field = reqStr(raw.field, `${base}.states.field`, errs);
  const initial = reqStr(raw.initial, `${base}.states.initial`, errs);
  const transitions = parseTransitions(raw.transitions, errs, `${base}.states.transitions`);
  const terminal = strArr(raw.terminal) ?? undefined;
  if (!field || !initial) return undefined;
  const sd: StatesDef = { field, initial, transitions };
  if (terminal) sd.terminal = terminal;
  return sd;
}

function parseTransitions(raw: unknown, errs: ParseError[], p: string): Record<string, TransitionTarget[]> {
  if (!isObj(raw)) return {};
  const out: Record<string, TransitionTarget[]> = {};
  for (const [from, targets] of Object.entries(raw)) {
    if (!Array.isArray(targets)) { out[from] = []; continue; }
    if (targets.length > LIMITS.MAX_TRANSITIONS)
      errs.push(limitErr('transitions', targets.length, LIMITS.MAX_TRANSITIONS, `${p}.${from}`));
    out[from] = targets.map(normTarget).filter((t): t is TransitionTarget => t !== null);
  }
  return out;
}

function normTarget(raw: unknown): TransitionTarget | null {
  if (typeof raw === 'string') return { to: raw };
  if (isObj(raw) && typeof raw.to === 'string') {
    const t: TransitionTarget = { to: raw.to };
    if (isObj(raw.guard) && typeof raw.guard.field === 'string' && typeof raw.guard.op === 'string'
      && VALID_OPS.has(raw.guard.op as GuardOp))
      t.guard = { field: raw.guard.field, op: raw.guard.op as GuardOp, value: raw.guard.value as Guard['value'] };
    return t;
  }
  return null;
}

function parseViews(raw: unknown[], errs: ParseError[]): ViewDef[] {
  if (raw.length > LIMITS.MAX_VIEWS)
    errs.push(limitErr('views', raw.length, LIMITS.MAX_VIEWS, 'views'));
  const out: ViewDef[] = [];
  raw.forEach((r, i) => { const v = parseView(r, i, errs); if (v) out.push(v); });
  return out;
}

function parseView(raw: unknown, idx: number, errs: ParseError[]): ViewDef | null {
  if (!isObj(raw)) {
    errs.push(err('schema', 'panorama_invalid_view', `views[${idx}]`, `view #${idx} 必须是 map`));
    return null;
  }
  const p = `views[${idx}]`;
  const id = reqStr(raw.id, `${p}.id`, errs);
  const label = reqStr(raw.label, `${p}.label`, errs);
  const entity = reqStr(raw.entity, `${p}.entity`, errs);
  if (!id || !label || !entity) return null;
  const c = raw.component;
  if (typeof c !== 'string') {
    errs.push(err('schema', 'panorama_missing_field', `${p}.component`, '缺少 component'));
    return null;
  }
  const base = { id, label, entity };
  const cols = strArr(raw.columns);
  if (c === 'kanban') {
    const groupBy = reqStr(raw.group_by, `${p}.group_by`, errs);
    if (!cols) errs.push(err('schema', 'panorama_missing_field', `${p}.columns`, '缺少 columns'));
    const cardRaw = isObj(raw.card) ? raw.card : undefined;
    if (!cardRaw) { errs.push(err('schema', 'panorama_missing_field', `${p}.card`, '缺少 card')); return null; }
    if (!groupBy || !cols) return null;
    const title = reqStr(cardRaw.title, `${p}.card.title`, errs);
    if (!title) return null;
    const card: CardTemplate = { title };
    if (title.length > LIMITS.MAX_CARD_TEMPLATE)
      errs.push(limitErr('card_template', title.length, LIMITS.MAX_CARD_TEMPLATE, `${p}.card.title`));
    const badges = strArr(cardRaw.badges);
    if (badges) card.badges = badges;
    if (typeof cardRaw.footer === 'string') card.footer = cardRaw.footer;
    if (typeof cardRaw.subtitle === 'string') card.subtitle = cardRaw.subtitle;
    return { ...base, component: 'kanban', group_by: groupBy, columns: cols, card };
  }
  if (c === 'table') {
    if (!cols) { errs.push(err('schema', 'panorama_missing_field', `${p}.columns`, '缺少 columns')); return null; }
    const v: TableViewDef = { ...base, component: 'table', columns: cols };
    if (isObj(raw.sort)) {
      const sf = typeof raw.sort.field === 'string' ? raw.sort.field : undefined;
      const so = raw.sort.order === 'asc' || raw.sort.order === 'desc' ? raw.sort.order : undefined;
      if (sf && so) v.sort = { field: sf, order: so };
    }
    if (typeof raw.limit === 'number') v.limit = raw.limit;
    return v;
  }
  if (c === 'bar_chart') {
    const bkt = isObj(raw.bucket) ? raw.bucket : undefined;
    if (!bkt) { errs.push(err('schema', 'panorama_missing_field', `${p}.bucket`, '缺少 bucket')); return null; }
    const bf = typeof bkt.field === 'string' ? bkt.field : '';
    const bd = typeof bkt.days === 'number' ? bkt.days : undefined;
    if (!bf || bkt.unit !== 'day' || bd === undefined) {
      errs.push(err('schema', 'panorama_missing_field', `${p}.bucket`, 'bucket 须 {field, unit:day, days}'));
      return null;
    }
    const v: BarChartViewDef = { ...base, component: 'bar_chart',
      bucket: { field: bf, unit: 'day', days: bd } };
    if (typeof raw.stack_by === 'string') v.stack_by = raw.stack_by;
    return v;
  }
  errs.push(err('schema', 'panorama_invalid_view_component', `${p}.component`, `component="${c}" 不在 {kanban,table,bar_chart}`));
  return null;
}
