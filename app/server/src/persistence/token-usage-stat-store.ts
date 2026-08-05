/**
 * TokenUsageStatStore — token_usage_stat 时序表写入 store（仅写，不查）
 * 参考: specs/tech/persistence/[P1]token_usage_stat.md §4（写入路径）+ §2.5（唯一约定）+ §2.6（读写分离）
 *       specs/tech/version_logs/v0.0.194/change_plan.md 模块 B 第 4 行
 *
 * 职责：
 *   - upsertDelta(dimension, deltaUsage)：按 (sessionId,hour,providerId,modelId) 四维度
 *     read-modify-write 累加（首见生成新 ULID，已存在复用 id；§2.5 唯一约定）
 *   - 走 CrudStore.putAsync 串行化（读写分离 §2.6：写入守 CrudStore 体系）
 *
 * 不提供 query 聚合方法 —— 聚合走 TokenUsageAggregator raw SQL GROUP BY（§2.6 read path 例外）。
 *
 * 存储契约：接收 SqliteCrudStore（engine 专有 queryByJsonExtract 可用于四维度定位既有行）。
 * SqliteCrudStore 是 blob-first（业务字段在 data JSON blob），putAsync 写回完整记录。
 */
import { ulid } from '../config/ulid';
import type { CrudStore } from './crud-types';
import type { StoredRecord } from './crud-types';
import { TokenUsageStatSchema, type TokenUsageStatRecord } from '../agent/schema_defs';
import type { SchemaDef } from './schema-types';

/** 四维度定位（(sessionId, hour, providerId, modelId) 唯一约定的 key） */
export interface TokenUsageDimension {
  squadId: string;
  memberId: string;
  sessionId: string;
  /** 'YYYY-MM-DD HH'（squad.timezone 本地小时桶） */
  hour: string;
  providerId: string;
  modelId: string;
}

/**
 * 单次 event 的 per-field delta（对齐 Usage 类型 snake_case 字段）。
 * undefined 字段视为 0（不累加）。
 */
export interface TokenUsageDelta {
  input_no_cache?: number;
  cache_read?: number;
  cache_creation?: number;
  output_response?: number;
  output_reasoning?: number;
  cost?: number;
  llmCallCount?: number;
}

/**
 * SqliteCrudStore 的 engine 专有扩展（queryByJsonExtract），用于四维度定位既有行。
 * 不在 CrudStore 契约上保证，仅 sqlite engine 提供。
 */
type SqliteExt = CrudStore & {
  queryByJsonExtract?<S extends SchemaDef>(
    schema: S,
    field: string,
    value: unknown,
  ): StoredRecord<S>[];
};

/**
 * TokenUsageStatStore — 仅写 store。
 *
 * @param crud 已 mount token_usage_stat 的 CrudStore（bootstrap 注入 SqliteCrudStore 实例）
 */
export class TokenUsageStatStore {
  constructor(private readonly crud: CrudStore) {}

  /**
   * 按 (sessionId, hour, providerId, modelId) 四维度累加 delta（read-modify-write）。
   *
   * 步骤（spec §4 step 6）：
   *   1. 按 sessionId 查既有行（engine 专有 queryByJsonExtract），in-memory 过滤 providerId/modelId/hour
   *   2. 有则复用 id + per-field Σ 累加；无则生成新 ULID + delta 作初始值
   *   3. put 写回（sqlite engine 是同步的，ACID 由 SQLite 事务保证；fs_crud_store_engine §5.3
   *      的 putAsync 串行化是 FS engine 专属，sqlite 用同步 put 语义等价）
   */
  async upsertDelta(dim: TokenUsageDimension, delta: TokenUsageDelta): Promise<void> {
    const existing = this.queryByDimension(dim);
    const id = existing?.id ?? ulid();
    const rec: TokenUsageStatRecord = {
      id,
      squadId: dim.squadId,
      memberId: dim.memberId,
      sessionId: dim.sessionId,
      hour: dim.hour,
      providerId: dim.providerId,
      modelId: dim.modelId,
      input_no_cache: (existing?.input_no_cache ?? 0) + (delta.input_no_cache ?? 0),
      cache_read: (existing?.cache_read ?? 0) + (delta.cache_read ?? 0),
      cache_creation: (existing?.cache_creation ?? 0) + (delta.cache_creation ?? 0),
      output_response: (existing?.output_response ?? 0) + (delta.output_response ?? 0),
      output_reasoning: (existing?.output_reasoning ?? 0) + (delta.output_reasoning ?? 0),
      cost: (existing?.cost ?? 0) + (delta.cost ?? 0),
      llmCallCount: (existing?.llmCallCount ?? 0) + (delta.llmCallCount ?? 0),
    };
    this.crud.put(TokenUsageStatSchema, rec);
  }

  /**
   * 按四维度查既有行（(sessionId,hour,providerId,modelId) 唯一约定下至多一行）。
   * engine 专有 queryByJsonExtract 按 sessionId 拉行，in-memory 过滤其余三维度。
   * 非 sqlite engine（无 queryByJsonExtract）→ 返回 undefined（首见，等同空表）。
   */
  private queryByDimension(dim: TokenUsageDimension): TokenUsageStatRecord | undefined {
    const ext = this.crud as SqliteExt;
    if (typeof ext.queryByJsonExtract !== 'function') return undefined;
    const rows = ext.queryByJsonExtract(TokenUsageStatSchema, 'sessionId', dim.sessionId);
    const match = rows.find(
      r => r.providerId === dim.providerId && r.modelId === dim.modelId && r.hour === dim.hour,
    );
    return match as TokenUsageStatRecord | undefined;
  }
}
