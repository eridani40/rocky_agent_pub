/**
 * run entity 的 SchemaDef — AgentLoop 单次执行的状态记录
 * 参考: specs/tech/agent/session/[P0]session_store.md §2（Run 接口）
 *       specs/tech/version_logs/v0.0.8/change_log.md §6（落盘路径）
 *
 * 落盘路径：{root}/sessions/{sessionId}/runs/<id>.json
 *   - engine: file
 *   - sharding: shardKeyField=sessionId, dirTemplate='sessions/{shardKey}/'
 *   - format: json
 *
 * 一个 AgentLoop.start() 对应一个 Run。run 级 contextWindowUsage 由 persistUsage 写。
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * run entity 的 SchemaDef。
 * 落盘：{root}/sessions/{sessionId}/runs/<id>.json
 */
export const RunSchema = {
  entity: 'runs',
  engine: 'file',
  fs: {
    sharding: {
      shardKeyField: 'sessionId',
      dirTemplate: 'sessions/{shardKey}/',
    },
    format: 'json',
  },
  fields: {
    /** run ULID（= AgentLoop.runId，业务生成） */
    id: { type: 'ulid', required: true },
    /** 所属会话 ULID（shardKey） */
    sessionId: { type: 'ulid', required: true },
    /** run 状态（v0.0.12 五值：running/completed/failed/paused/interrupted） */
    status: {
      type: 'enum',
      required: true,
      enumValues: ['running', 'completed', 'failed', 'paused', 'interrupted'],
    },
    /** 停止原因（agent_loop §2 六枚举；json 透传 string） */
    stopReason: { type: 'string', required: false },
    /**
     * [v0.0.25 rev2] run 失败结构化错误信息（仅 stopReason="error" 时存在）。
     * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §9.1
     * 形态：RunErrorInfo（errorCategory + displayReason + errorDetail?）；json 透传。
     */
    error: { type: 'json', required: false },
    /** run 级 contextWindowUsage（json 透传；persistUsage 写） */
    contextWindowUsage: { type: 'json', required: false },
    /**
     * v0.0.14：run 级累计 token usage（persistUsage 写；崩溃恢复/历史查询重建累计视图用，
     * 见 session_usage.md §10 stretch 条件 1）。形态：AccumulatedUsage（token+char+cost Σ + llmCallCount）。
     */
    usage: { type: 'json', required: false },
    /** 结束时间 isoDate（可选，run 完成时写） */
    endedAt: { type: 'isoDate', required: false },
  },
} as const satisfies SchemaDef;

/** run 记录类型（从 SchemaDef 派生） */
export type RunRecord = InferRecord<typeof RunSchema>;
