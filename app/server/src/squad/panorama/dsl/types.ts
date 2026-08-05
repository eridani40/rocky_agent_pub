/**
 * Panorama DSL 类型定义 — 完整 TypeScript interface.
 * 参考: specs/tech/squad/[P1]panorama_dsl.md §1-§5
 *       specs/research/v0.0.189.dsl_board/panorama_dsl_schema.md §2-§5
 *
 * 设计：纯 interface/type 文件，无 runtime 代码。parser/template/validation/store 共享。
 */

// ── meta 块（§2） ──────────────────────────────────────────

export interface MetaDef {
  /** DSL schema 版本（semver major.minor），迁移引擎用 */
  version: string;
  /** 首次定义者 session id（审计追溯） */
  author?: string;
  /** ISO 8601，首次定义时间 */
  created_at?: string;
  /** ISO 8601，最近 define 时间（引擎自动维护，agent 不可手填） */
  updated_at?: string;
}

// ── version 块（§3 — 纯展示，无业务逻辑） ─────────────────

export interface VersionBlock {
  id?: string;
  name?: string;
  board_name?: string;
}

// ── Guard 条件（§4.3 — 结构化跃迁守卫） ───────────────────

export type GuardOp = 'eq' | 'ne' | 'gte' | 'lte' | 'gt' | 'lt' | 'in' | 'not_in';

export interface Guard {
  field: string;
  op: GuardOp;
  value: string | number | boolean | string[];
}

// ── 状态机（§4.3） ─────────────────────────────────────────

/** 跃迁目标（parser 将 shorthand 字符串归一化为 longhand 对象） */
export interface TransitionTarget {
  to: string;
  guard?: Guard;
}

export interface StatesDef {
  /** 状态字段名（须是 entity 的 enum 字段） */
  field: string;
  /** 创建实例时的默认状态 */
  initial: string;
  /** 跃迁表 map（from -> targets[]，shorthand 已归一化） */
  transitions: Record<string, TransitionTarget[]>;
  /** 终态列表（终态不可再跃迁） */
  terminal?: string[];
}

// ── 字段类型集（§4.2 — v1 = 6 种闭集合） ───────────────────

export interface BaseFieldDef {
  required?: boolean;
  /** 字段中文列名/展示名（可选，缺省=字段名；table 表头/表单 label 用） */
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

// ── 展示配置（§4.4） ───────────────────────────────────────

export interface DisplayConfig {
  status_labels?: Record<string, string>;
  status_colors?: Record<string, string>;
}

// ── 实体定义（§4） ─────────────────────────────────────────

export interface EntityDef {
  label: string;
  id_field: string;
  fields: Record<string, FieldDef>;
  states?: StatesDef;
  display?: DisplayConfig;
  /**
   * 系统固定 entity 标记（v0.0.243 — panorama_builtin §3）.
   * 仅由 injectSystemEntities 程序化注入；parser 不识别此字段（leader DSL 里写 system 会被丢弃）.
   * 标记后 leader 不可 edit/delete（checkSystemEntityImmutable 拒绝字段漂移）.
   */
  system?: true;
}

// ── card 模板（§5.5） ──────────────────────────────────────

export interface CardTemplate {
  title: string;
  badges?: string[];
  footer?: string;
  subtitle?: string;
}

// ── 视图定义（§5 — kanban / table / bar_chart union） ──────

export type ViewComponent = 'kanban' | 'table' | 'bar_chart';

/**
 * view.filter（panorama_dsl §5.0 默认过滤声明）.
 * field:value 精确匹配，多键 AND（与 GET entities?filter=k:v,k2:v2 同语义）.
 * 前端 fetch 时序列化透传；语义层校验 key 须是 entity 已声明字段.
 */
export type ViewFilter = Record<string, string | number | boolean>;

export interface BaseViewDef {
  id: string;
  label: string;
  entity: string;
  component: ViewComponent;
  /** 可选默认过滤：声明后 fetch 透传 + 校验 key 命中 entity 字段（panorama_dsl §5.0） */
  filter?: ViewFilter;
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

// ── 顶层 schema（§1） ──────────────────────────────────────

export interface PanoramaSchema {
  meta: MetaDef;
  /** 纯展示块（§3：id/name/board_name） */
  version?: VersionBlock;
  /** map（key=实体名） */
  entities: Record<string, EntityDef>;
  /** 有序数组（tab 顺序） */
  views: ViewDef[];
}

// ── parser 结果（形状对齐 validation spec §1.2） ──────────

export interface ParseError {
  layer: 'syntax' | 'schema';
  code: string;
  path: string;
  message: string;
  suggestion?: string;
}

export interface ParseWarning {
  code: string;
  path: string;
  message: string;
}

export type ParseResult =
  | { ok: true; schema: PanoramaSchema; warnings: ParseWarning[] }
  | { ok: false; errors: ParseError[] };
