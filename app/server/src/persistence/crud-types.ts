/**
 * CrudStore 契约层 — 接口 / 信封 / Options / Filter
 * 参考: specs/tech/persistence/[P0]crud_store_interface.md §2-§3
 *
 * 本文件只含「类型」与「接口契约」（静态契约），无运行时落盘逻辑。
 * 信封注入/mode/ifVersion 纯逻辑见 envelope.ts，错误类见 errors.ts。
 *
 * 核心设计（spec §3.1）：
 *   - 一个泛型 CrudStore，实体类型由 SchemaDef 参数化（不为每实体写一套 store）
 *   - id 由业务生成，store 不分配；store 只注入信封（createdAt/updatedAt/version）
 *   - 分片 entity（schema.fs.sharding 存在）point 访问必须带 shardKey（spec §3.6）
 */
import type { SchemaDef, InferRecord } from './schema-types';

// ============================================================
// 1. RecordMeta / StoredRecord（信封 + 记录，spec §2.1）
// ============================================================

/**
 * store 管理的信封元数据（保留字段，实体不得自带，见 schema §2.2/§2.4）。
 *   - createdAt/updatedAt: isoDate（ISO 8601 UTC）
 *   - version: 乐观锁版本号，首次为 1，每次写入自增
 */
export interface RecordMeta {
  /** 首次写入时间（isoDate），后续写入不可变 */
  readonly createdAt: string;
  /** 最近写入时间（isoDate），每次写入推进 */
  updatedAt: string;
  /** 乐观锁版本号，首次为 1，每次写入自增 */
  version: number;
}

/**
 * get/query 返回的形态：实体字段 + 信封（spec §2.1）。
 */
export type StoredRecord<S extends SchemaDef> = InferRecord<S> & RecordMeta;

// ============================================================
// 2. PutOptions（写入模式 + 乐观锁，spec §2.3）
// ============================================================

/** 写入模式（spec §2.3 PutOptions.mode） */
export type PutMode = 'insert' | 'replace' | 'upsert';

/**
 * put 选项（spec §2.3）。
 *   - mode: 缺省 'upsert'
 *   - ifVersion: 乐观锁，仅当当前 version 等于 ifVersion 才写入；不匹配 → VersionConflictError
 *   - preserveUpdatedAt: 缺省 false（现状推进 updatedAt）
 */
export interface PutOptions {
  /** 写入模式，缺省 'upsert' */
  mode?: PutMode;
  /** 乐观锁：仅当当前 version 等于 ifVersion 才写入 */
  ifVersion?: number;
  /**
   * [v0.0.231] upsert 更新时保留 existing.updatedAt（version 仍 +1，createdAt 照常保留）。
   * 用于「纯标记字段」写入不刷新会话活跃时间（如 session pinned 置顶——用户裁决
   * 2026-08-01：置顶是纯标记操作不算对话活动）。缺省 false = 现状推进，存量调用方零影响。
   * 仅影响 upsert 更新分支；insert/replace 分支语义不变（replace 恒重置时间）。
   */
  preserveUpdatedAt?: boolean;
}

// ============================================================
// 3. QueryFilter（查询过滤，spec §2.3 / §3.5）
// ============================================================

/** 查询排序方式（按 createdAt） */
export type QueryOrder = 'createdAtAsc' | 'createdAtDesc';

/**
 * 查询过滤条件（spec §2.3）。
 * v1 只保证信封维度 + shardKey 范围，业务字段过滤不在契约保证范围内（spec §3.5）。
 */
export interface QueryFilter {
  /**
   * 分片 entity：限定在某 shard 内查询。
   * 缺省 = scatter（遍历所有 shard 目录，性能差，FS engine 慎用）。
   * 不分片 entity 忽略此字段。
   */
  shardKey?: string;
  /** 主键集合过滤 */
  ids?: string[];
  /** createdAt 下界（含），isoDate */
  createdAfter?: string;
  /** createdAt 上界（不含），isoDate */
  createdBefore?: string;
  /** 返回条数上限，缺省无上限 */
  limit?: number;
  /** 排序方式，缺省 'createdAtDesc'（最近优先） */
  order?: QueryOrder;
}

// ============================================================
// 4. CrudStore 接口（spec §2.2）
// ============================================================

/**
 * 引擎无关的 CRUD 契约（spec §2.2）。FS / SQLite engine 都实现此接口。
 * 业务面向此接口编程，不感知后端。
 *
 * 分片 entity（schema.fs.sharding 存在）的 point 访问（get/delete）必须带 shardKey
 * 才能路由到正确分区；put 从 record[shardKeyField] 提取；query 不带 shardKey=scatter。
 */
export interface CrudStore {
  /**
   * 写入（insert / replace / upsert）。分片 entity 的 shardKey 从
   * `record[schema.fs.sharding.shardKeyField]` 提取。
   * 返回落盘后的完整记录（含新信封）。
   */
  put<S extends SchemaDef>(
    schema: S,
    record: InferRecord<S>,
    opts?: PutOptions,
  ): StoredRecord<S>;

  /**
   * 按主键读取。
   * 分片 entity 必须传 shardKey 路由；不分片省略。
   * 不存在返回 undefined。
   */
  get<S extends SchemaDef>(
    schema: S,
    id: string,
    shardKey?: string,
  ): StoredRecord<S> | undefined;

  /**
   * 按主键删除。
   * 分片 entity 必须传 shardKey。
   * 返回是否实际删除了一条。
   */
  delete<S extends SchemaDef>(
    schema: S,
    id: string,
    shardKey?: string,
  ): boolean;

  /**
   * 按过滤条件批量查（v1 只支持信封维度 + shardKey 范围，spec §3.5）。
   */
  query<S extends SchemaDef>(schema: S, filter: QueryFilter): StoredRecord<S>[];
}
