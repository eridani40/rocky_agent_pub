/**
 * token_usage_stat entity 的 SchemaDef — squad token 用量细粒度时序记录
 * 参考: specs/tech/persistence/[P1]token_usage_stat.md §3（SchemaDef 权威定义）
 *       specs/tech/version_logs/v0.0.194/change_plan.md 模块 B
 *
 * 设计（spec §2 决策）：
 *   - engine='sqlite'（用户裁决，经 CrudStore 体系；§2.1）
 *   - 粒度 = (sessionId, hour, providerId, modelId) 四维度（§2.2），非天级预聚合
 *   - 字段名 snake_case 对齐 Usage 类型（§2.3），便于 SQL SUM + subscriber per-field diff
 *   - 冗余存 squadId/memberId（§2.4），免 join session 表，session 删后历史 stat 完整
 *   - 不配 fs.sharding（sqlite engine 不分片，§2.7）
 *   - id 主键 ULID（schema 强制）；调用方约定 (sessionId,hour,providerId,modelId) 唯一（§2.5）
 *
 * 不存派生字段（totalTokens/cacheRate）—— 视图层算（§2.3 反例）。
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * token_usage_stat 时序表 SchemaDef。
 * 落盘：sqlite crud.sqlite 库的 token_usage_stat 表（blob-first，data JSON 含实体字段）。
 */
export const TokenUsageStatSchema = {
  entity: 'token_usage_stat',
  engine: 'sqlite',
  fields: {
    /** ULID 主键（业务生成；§2.5 约定 (sessionId,hour,providerId,modelId) 唯一） */
    id: { type: 'ulid', required: true },
    /** §2.4 冗余存 squadId（方便 GROUP BY WHERE json_extract(data,'$.squadId')） */
    squadId: { type: 'ulid', required: true },
    /** §2.4 冗余存 memberId（方便 scope=member 筛选；subagent 跳过不写） */
    memberId: { type: 'ulid', required: true },
    /** 维度（PK 组成）；同一 session 的多 hour/model 组合各占一行 */
    sessionId: { type: 'ulid', required: true },
    /**
     * 维度（PK 组成）；'YYYY-MM-DD HH'（squad.timezone 本地小时桶）。
     * 字典序可排序 + substr(hour,1,10) 派生 date（day 粒度 GROUP BY）。
     */
    hour: { type: 'string', required: true },
    /** 维度（PK 组成）；provider id（model 三级 fallback 后的值，兜底 '__unknown__'） */
    providerId: { type: 'string', required: true },
    /** 维度（PK 组成）；model id（model 三级 fallback 后的值，兜底 '__unknown__'） */
    modelId: { type: 'string', required: true },
    // ── 细分 token（snake_case 对齐 Usage 类型，§2.3）──
    /** 未缓存输入 token（Usage.input_no_cache Σ） */
    input_no_cache: { type: 'number', required: true },
    /** 缓存命中 token（Usage.input_cache_read Σ） */
    cache_read: { type: 'number', required: true },
    /** 缓存写入 token（Usage.input_cache_write Σ） */
    cache_creation: { type: 'number', required: true },
    /** 实际回复 token（Usage.output_response Σ） */
    output_response: { type: 'number', required: true },
    /** 思维链 token（Usage.output_reasoning Σ） */
    output_reasoning: { type: 'number', required: true },
    /** 原币种金额（Usage.cost Σ） */
    cost: { type: 'number', required: true },
    /** LLM 调用次数（subscriber 每次 event +1） */
    llmCallCount: { type: 'number', required: true },
  },
  // v1 不配 indexes（业务字段聚合走 raw SQL json_extract，§3 注释）
} as const satisfies SchemaDef;

/** token_usage_stat 记录类型（从 SchemaDef 派生） */
export type TokenUsageStatRecord = InferRecord<typeof TokenUsageStatSchema>;
