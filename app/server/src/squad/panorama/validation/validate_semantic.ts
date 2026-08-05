/**
 * Panorama Layer 3 语义层 — 跨引用闭合校验（编译期报错，非运行时静默）.
 * 参考: specs/tech/squad/[P1]panorama_validation.md §4
 *
 * 规则：ref target / view entity / group_by / columns / template field /
 * ref navigation / badge field / ref cycle / terminal 出边 / guard type.
 */
import type {
  PanoramaSchema, EntityDef, EnumFieldDef, RefFieldDef,
  KanbanViewDef, TableViewDef, BarChartViewDef, CardTemplate,
} from '../dsl/types';
import type { ValidationError, ValidationWarning } from './types';
import { makeError } from './types';
// system entity canonical 注册表（panorama_builtin §3 决策5）
// 让 semantic 层把 system entity 当恒在可引用，与 inject 后置时序解耦
import { SYSTEM_ENTITY_DEFS } from '../builtin';

/** 复用 dsl/template.ts 的模板正则（同语法） */
const TEMPLATE_RE = /\{\{([^{}]*)\}\}|\{(\w+)(?:\.(\w+))?(?:\|([^}]*))?\}/g;

/** 共享错误工厂 — 固定 semantic 层（m5：逻辑收敛到 types.makeError） */
const e = (code: string, path: string, msg: string, suggestion?: string): ValidationError =>
  makeError('semantic', code, path, msg, suggestion);

export function validateSemantic(
  schema: PanoramaSchema,
  errors: ValidationError[],
  warnings: ValidationWarning[],
): void {
  // system entity 名恒在可引用（panorama_builtin §3 决策5）：
  // leader 即使未在 entities 声明 task，ref.entity/view.entity 指向 task 也合法。
  // 仅扩解析可见性集合，不触发 inject/write（纯内存操作），与 inject 后置时序解耦。
  const entityNames = new Set<string>([
    ...Object.keys(schema.entities),
    ...Object.keys(SYSTEM_ENTITY_DEFS),
  ]);

  for (const [name, entity] of Object.entries(schema.entities)) {
    // ref.entity 指向已声明实体
    for (const [fname, field] of Object.entries(entity.fields)) {
      if (field.type === 'ref' && !entityNames.has((field as RefFieldDef).entity)) {
        errors.push(e('panorama_unknown_ref_target',
          `entities.${name}.fields.${fname}.entity`,
          `ref.entity "${(field as RefFieldDef).entity}" 不存在`,
          '改为已声明的实体名'));
      }
    }
    // terminal 有出边 → 矛盾
    checkTerminalOutgoing(name, entity, errors);
  }

  checkRefCycles(schema, errors);
  checkViews(schema, errors, warnings);
}

function checkTerminalOutgoing(name: string, entity: EntityDef, errors: ValidationError[]): void {
  const states = entity.states;
  if (!states?.terminal) return;
  for (const term of states.terminal) {
    if (states.transitions[term]?.length) {
      errors.push(e('panorama_terminal_has_outgoing',
        `entities.${name}.states.transitions.${term}`,
        `terminal 状态 "${term}" 不应有出边`));
    }
  }
}

function checkViews(
  schema: PanoramaSchema,
  errors: ValidationError[],
  warnings: ValidationWarning[],
): void {
  schema.views.forEach((view, i) => {
    const p = `views[${i}]`;
    // view.entity miss 时 fallback 到 SYSTEM_ENTITY_DEFS canonical def（panorama_builtin §3 决策5）：
    // leader 未声明 task 时用 canonical def 继续下游校验（group_by/columns/filter/template/badges），
    // 不能仅 pass 跳过下游（否则字段漂移静默通过）。panorama_unknown_view_entity 仅在两处都 miss 时报。
    const entity = schema.entities[view.entity] ?? SYSTEM_ENTITY_DEFS[view.entity];
    if (!entity) {
      errors.push(e('panorama_unknown_view_entity', `${p}.entity`,
        `view.entity "${view.entity}" 不存在`));
      return;
    }
    // view.filter key 须命中 entity 字段（panorama_dsl §5.0；component 校验前先校 filter）
    checkViewFilter(view.filter, entity, `${p}.filter`, errors, warnings);
    if (view.component === 'kanban') {
      checkKanban(schema, view, entity, p, errors, warnings);
    } else if (view.component === 'table') {
      checkTable(view, entity, p, errors);
    } else {
      checkBarChart(view, entity, p, errors);
    }
  });
}

/**
 * view.filter 校验（panorama_dsl §5.0）.
 *  - filter key 须是 entity 已声明字段 → 否则 error `panorama_unknown_filter_field`
 *    （防 leader 写错字段名静默无效 filter）
 *  - enum 字段值不在 values 内 → warning `panorama_warn_unknown_filter_value`
 *    （不阻塞：可能是未来扩展值；收集式不短路）
 */
function checkViewFilter(
  filter: Record<string, unknown> | undefined,
  entity: EntityDef,
  p: string,
  errors: ValidationError[],
  warnings: ValidationWarning[],
): void {
  if (!filter) return;
  for (const [key, value] of Object.entries(filter)) {
    const field = entity.fields[key];
    if (!field) {
      errors.push(e('panorama_unknown_filter_field', `${p}.${key}`,
        `filter 字段 "${key}" 不在 entity fields 中`));
      continue;
    }
    if (field.type === 'enum' && typeof value === 'string' && !(field as EnumFieldDef).values.includes(value)) {
      warnings.push({
        layer: 'semantic',
        code: 'panorama_warn_unknown_filter_value',
        path: `${p}.${key}`,
        message: `filter 值 "${value}" 不在 enum ${field.type === 'enum' ? (field as EnumFieldDef).values.join('/') : ''} 内`,
      });
    }
  }
}

function checkKanban(
  schema: PanoramaSchema, view: KanbanViewDef, entity: EntityDef,
  p: string, errors: ValidationError[], warnings: ValidationWarning[],
): void {
  const gb = entity.fields[view.group_by];
  if (!gb) {
    errors.push(e('panorama_unknown_group_by', `${p}.group_by`,
      `group_by "${view.group_by}" 不在 fields 中`));
  } else if (gb.type !== 'enum') {
    errors.push(e('panorama_group_by_not_enum', `${p}.group_by`,
      `group_by "${view.group_by}" 必须是 enum 字段，实际是 ${gb.type}`));
  }
  if (gb?.type === 'enum') {
    const vals = new Set((gb as EnumFieldDef).values);
    const missing = (gb as EnumFieldDef).values.filter(v => !view.columns.includes(v));
    if (missing.length) {
      warnings.push({ layer: 'semantic', code: 'panorama_warn_missing_column',
        path: `${p}.columns`, message: `columns 缺少 enum 值: ${missing.join(', ')}` });
    }
  }
  checkCardTemplate(schema, view.card, entity, `${p}.card`, errors);
}

function checkCardTemplate(
  schema: PanoramaSchema, card: CardTemplate, entity: EntityDef,
  p: string, errors: ValidationError[],
): void {
  for (const [part, tpl] of [['title', card.title], ['footer', card.footer], ['subtitle', card.subtitle]] as const) {
    if (tpl) checkTemplateStr(schema, tpl, entity, `${p}.${part}`, errors);
  }
  if (card.badges) {
    for (const badge of card.badges) {
      if (!entity.fields[badge]) {
        errors.push(e('panorama_unknown_badge_field', `${p}.badges`,
          `badge "${badge}" 不在 fields 中`));
      }
    }
  }
}

function checkTemplateStr(
  schema: PanoramaSchema, tpl: string, entity: EntityDef,
  p: string, errors: ValidationError[],
): void {
  const re = new RegExp(TEMPLATE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(tpl)) !== null) {
    const [, esc, field, target] = m;
    if (esc !== undefined) continue; // {{escaped}}
    if (!field) continue; // C1: 正则捕获组可能为 undefined，收窄后才可索引
    if (!entity.fields[field]) {
      errors.push(e('panorama_unknown_field_in_template', p,
        `模板引用字段 "{${field}}" 不存在`, '改为已声明的字段名'));
      continue;
    }
    if (target) {
      const fdef = entity.fields[field]!;
      if (fdef.type !== 'ref') {
        errors.push(e('panorama_ref_navigation_on_non_ref', p,
          `字段 "{${field}}" 不是 ref 类型，不能用 {${field}.${target}} 点导航`));
        continue;
      }
      const refEnt = schema.entities[(fdef as RefFieldDef).entity];
      if (refEnt && !refEnt.fields[target]) {
        errors.push(e('panorama_unknown_ref_target_field', p,
          `ref 目标 ${(fdef as RefFieldDef).entity} 没有 "${target}" 字段`));
      }
    }
  }
}

function checkTable(view: TableViewDef, entity: EntityDef, p: string, errors: ValidationError[]): void {
  for (const col of view.columns) {
    if (!entity.fields[col]) {
      errors.push(e('panorama_unknown_column', `${p}.columns`,
        `table column "${col}" 不在 fields 中`));
    }
  }
  if (view.sort && !entity.fields[view.sort.field]) {
    errors.push(e('panorama_unknown_sort_field', `${p}.sort.field`,
      `sort.field "${view.sort.field}" 不在 fields 中`));
  }
}

function checkBarChart(view: BarChartViewDef, entity: EntityDef, p: string, errors: ValidationError[]): void {
  const bf = entity.fields[view.bucket.field];
  if (!bf) {
    errors.push(e('panorama_bucket_not_datetime', `${p}.bucket.field`,
      `bucket.field "${view.bucket.field}" 不在 fields 中`));
  } else if (bf.type !== 'datetime') {
    errors.push(e('panorama_bucket_not_datetime', `${p}.bucket.field`,
      `bucket.field "${view.bucket.field}" 必须是 datetime，实际是 ${bf.type}`));
  }
  if (view.stack_by) {
    const sb = entity.fields[view.stack_by];
    if (!sb || sb.type !== 'enum') {
      errors.push(e('panorama_stack_by_not_enum', `${p}.stack_by`,
        `stack_by "${view.stack_by}" 必须${sb ? `是 enum（实际 ${sb.type}）` : '指向已声明的 enum 字段'}`));
    }
  }
}

/** ref 无环检测（自引用 A→A 允许；A→B→A 报错） */
function checkRefCycles(schema: PanoramaSchema, errors: ValidationError[]): void {
  const adj = buildRefGraph(schema);
  const color = new Map<string, number>(); // 0=white 1=gray 2=black
  for (const n of adj.keys()) color.set(n, 0);

  const dfs = (node: string, path: string[]): boolean => {
    color.set(node, 1);
    path.push(node);
    for (const next of adj.get(node) ?? []) {
      if (!color.has(next)) continue; // 指向不存在实体（已被 ref check 捕获）
      if (color.get(next) === 1) {
        const start = path.indexOf(next);
        errors.push(e('panorama_circular_ref', `entities.${next}`,
          `ref 循环引用: ${path.slice(start).concat(next).join(' → ')}`));
        return true;
      }
      if (color.get(next) === 0 && dfs(next, path)) return true;
    }
    path.pop();
    color.set(node, 2);
    return false;
  };

  for (const n of adj.keys()) {
    if (color.get(n) === 0) dfs(n, []);
  }
}

function buildRefGraph(schema: PanoramaSchema): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const [name, entity] of Object.entries(schema.entities)) {
    const targets = new Set<string>();
    for (const field of Object.values(entity.fields)) {
      if (field.type === 'ref') {
        const tgt = (field as RefFieldDef).entity;
        if (tgt !== name) targets.add(tgt); // 自引用不构成环
      }
    }
    adj.set(name, [...targets]);
  }
  return adj;
}
