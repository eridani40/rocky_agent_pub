/**
 * SchemaDef 声明层 — 类型与 InferRecord 派生
 * 参考: specs/tech/persistence/[P0]schema_interface.md §2.1-§2.3
 *
 * 本文件只含「类型」与「类型派生」（静态契约），无运行时逻辑。
 * 运行时校验见 schema-validation.ts。
 *
 * 核心设计（spec §3.1）：SchemaDef 是唯一源头，TS 类型用 InferRecord<S> 从它反推，
 * 不另写一份 interface（避免双份漂移）。
 */

// ============================================================
// 1. 字段类型枚举（封闭集合，spec §2.1）
// ============================================================

/** 字段类型（封闭枚举；复杂结构走 json，spec §3.3） */
export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'ulid' // ULID 字符串（见 convention.md §3）
  | 'isoDate' // ISO 8601 UTC 字符串
  | 'enum' // 取值受限的字符串
  | 'json'; // 不透明任意嵌套值

// ============================================================
// 2. 字段 / 索引 / 存储策略描述符
// ============================================================

/** 单字段定义 */
export interface FieldDef {
  type: FieldType;
  /** 是否必填，缺省 false */
  required?: boolean;
  /** 仅 type: 'enum' 时生效 */
  enumValues?: string[];
}

/** 索引定义（v1 仅支持信封字段：id / createdAt / updatedAt / version） */
export interface IndexDef {
  fields: string[];
  /** 是否唯一索引，缺省 false */
  unique?: boolean;
}

/** FS engine 存储策略（仅 engine: 'file' 时消费；SQLite engine 忽略） */
export interface FsStorageConfig {
  /** 分片配置；缺省 = 不分片 */
  sharding?: {
    /** shard key 字段名（须在 fields 中声明） */
    shardKeyField: string;
    /**
     * 相对 root 的分片路径模板，{shardKey} 替换为字段值；
     * entity 名追加其后（同 shardKey 多 entity 聚同 shard 目录）。
     * 见 keyDecisions.fsLayout（engine 老实拼接不自加前缀）。
     */
    dirTemplate: string;
  };
  /** 文件格式，缺省 json */
  format?: 'json' | 'jsonl';
  /** format: 'jsonl' 时单段文件最大记录数 */
  jsonlMaxCount?: number;
}

// ============================================================
// 3. SchemaDef（实体 schema 唯一源头）
// ============================================================

/**
 * 实体 Schema 描述符
 *
 * entity 既是实体/schema 标识，也是底层集合名（FS 目录名 / SQLite 表名）。
 * 必须声明保留名 id（恒为主键，ULID，业务生成）。
 * 必须含 engine（决定 CompositeStore 路由）。
 * 禁止声明 createdAt/updatedAt/version（store 注入的信封字段，见 schema §2.2）。
 */
export interface SchemaDef {
  /** 实体/schema 标识，全局唯一；同时是底层集合名 */
  entity: string;
  /** 字段定义，key 为字段名；必须含保留名 id */
  fields: Record<string, FieldDef>;
  /** 索引，缺省空 */
  indexes?: IndexDef[];
  /** 存储引擎（决定 CompositeStore 路由） */
  engine: 'file' | 'sqlite';
  /** FS 存储策略（仅 engine: 'file' 时消费） */
  fs?: FsStorageConfig;
}

// ============================================================
// 4. 类型派生：TsOf / InferRecord（spec §2.3）
// ============================================================

/** 把 FieldDef 映射到 TS 类型（spec §2.3 TsOf） */
export type TsOf<F extends FieldDef> =
  F['type'] extends 'string' | 'ulid' | 'isoDate' ? string :
  F['type'] extends 'number' ? number :
  F['type'] extends 'boolean' ? boolean :
  F['type'] extends 'enum' ?
    // enum → 字面量 union（as const schema 下 enumValues 是字面量元组）
    F['enumValues'] extends ReadonlyArray<infer V> ? V : string :
  unknown; // 'json' → 不透明

/**
 * 从 SchemaDef 反推 record 类型（spec §2.3）。
 * required: true 的字段进主体（无 ?），其余加 ?。
 */
export type InferRecord<S extends SchemaDef> = {
  [K in keyof S['fields'] & string
    as S['fields'][K] extends { required: true } ? K : never]: TsOf<S['fields'][K]>
} & {
  [K in keyof S['fields'] & string
    as S['fields'][K] extends { required: true } ? never : K]?: TsOf<S['fields'][K]>
};
