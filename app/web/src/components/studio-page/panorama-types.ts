/**
 * panorama-types —— 业务全景 DSL 前端类型（mirror app/server/src/squad/panorama/dsl/types.ts）
 * 参考: specs/tech/squad/[P1]panorama_dsl.md §1-§5
 *
 * 纯类型文件：前端只需读侧类型（schema 由服务端四层校验保证合法，前端不做 DSL 校验）。
 */

// ── 字段类型集（§4.2 — 6 种闭集合） ──

export interface BaseFieldDef {
  required?: boolean;
  /** 字段中文展示名（table 表头用；缺省 = 字段名） */
  label?: string;
}
export interface StringFieldDef extends BaseFieldDef {
  type: 'string';
  max?: number;
  pattern?: string;
}
export interface NumberFieldDef extends BaseFieldDef {
  type: 'number';
  min?: number;
  max?: number;
}
export interface BooleanFieldDef extends BaseFieldDef {
  type: 'boolean';
}
export interface EnumFieldDef extends BaseFieldDef {
  type: 'enum';
  values: string[];
}
export interface RefFieldDef extends BaseFieldDef {
  type: 'ref';
  entity: string;
}
export interface DatetimeFieldDef extends BaseFieldDef {
  type: 'datetime';
}
export type FieldDef =
  | StringFieldDef
  | NumberFieldDef
  | BooleanFieldDef
  | EnumFieldDef
  | RefFieldDef
  | DatetimeFieldDef;

// ── 状态机（§4.3） ──

export interface TransitionTarget {
  to: string;
}
export interface StatesDef {
  field: string;
  initial: string;
  transitions: Record<string, TransitionTarget[]>;
  terminal?: string[];
}

// ── 展示配置（§4.4） ──

export interface DisplayConfig {
  status_labels?: Record<string, string>;
  status_colors?: Record<string, string>;
  /** 非状态分组字段的 label 映射（key = `${group_by}_labels`，宽松索引） */
  [extra: string]: Record<string, string> | undefined;
}

// ── 实体定义（§4） ──

export interface EntityDef {
  label: string;
  id_field: string;
  fields: Record<string, FieldDef>;
  states?: StatesDef;
  display?: DisplayConfig;
}

// ── card 模板（§5.5） ──

export interface CardTemplate {
  title: string;
  badges?: string[];
  footer?: string;
  subtitle?: string;
}

// ── 视图定义（§5 — kanban / table / bar_chart union） ──
// v0.0.240：BaseViewDef 加 filter（field:value 精确匹配；前端 fetch 透传 ?filter=）

export interface BaseViewDef {
  id: string;
  label: string;
  entity: string;
  component: 'kanban' | 'table' | 'bar_chart';
  /** v0.0.240 视图过滤声明：key = 字段名，value = 精确匹配值；前端 fetch 透传 ?filter=k:v,k2:v2 */
  filter?: Record<string, unknown>;
}
export interface KanbanViewDef extends BaseViewDef {
  component: 'kanban';
  group_by: string;
  columns: string[];
  card: CardTemplate;
}
export interface TableViewDef extends BaseViewDef {
  component: 'table';
  columns: string[];
  sort?: { field: string; order: 'asc' | 'desc' };
  limit?: number;
}
export interface BarChartViewDef extends BaseViewDef {
  component: 'bar_chart';
  bucket: { field: string; unit: 'day'; days: number };
  stack_by?: string;
}
export type ViewDef = KanbanViewDef | TableViewDef | BarChartViewDef;

// ── 顶层 schema（§1） ──

export interface PanoramaSchema {
  version?: { id?: string; name?: string; board_name?: string };
  entities: Record<string, EntityDef>;
  views: ViewDef[];
}

// ── 事件流（14-panorama-endpoints.md §3.1） ──

export interface PanoramaEvent {
  seq: number;
  ts: string;
  type: string;
  entity: string;
  summary: string;
  payload: Record<string, unknown>;
}

// ── SSE 事件 payload（panorama_http.md §4.2/§4.3） ──

export interface PanoramaEntityUpdateEvent {
  type: 'panorama_entity_update';
  squadId: string;
  entity: string;
  action: 'created' | 'updated' | 'transitioned';
  id: string;
  record: Record<string, unknown>;
  transition?: { from: string; to: string };
  source: 'agent' | 'drag' | 'api';
  seq: number;
}
export interface PanoramaSchemaUpdateEvent {
  type: 'panorama_schema_update';
  squadId: string;
  seq: number;
}
export type PanoramaSseEvent = PanoramaEntityUpdateEvent | PanoramaSchemaUpdateEvent;

/** per-squad SSE group 路由键（与 server panorama/http/sse.ts panoramaGroup 一致） */
export function panoramaGroup(squadId: string): string {
  return `panorama:squad:${squadId}:entity`;
}
