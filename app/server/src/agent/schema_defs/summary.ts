/**
 * summary entity 的 SchemaDef — compact 产出的会话级单值 summary
 * 参考: specs/tech/agent/session/[P0]session_store.md §3（summary 总存，单值/会话）
 *       specs/tech/agent/context_and_memory/[P0]context_snapshot_interface.md §2（SummaryInfo）
 *
 * 落盘路径：{root}/sessions/{sessionId}/summary/<id>.json
 *   - engine: file
 *   - sharding: shardKeyField=sessionId, dirTemplate='sessions/{shardKey}/'
 *   - format: json
 *
 * 单值语义：每会话仅一条 summary（SessionStore 固定 id=sessionId 作主键，
 * setSummary 用 upsert 覆盖）。schema id 字段类型 ulid 与 sessionId（ULID）兼容。
 * 信封 version（store 注入）每次 setSummary 自增；SummaryInfo.version 直接读信封 version。
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * summary entity 的 SchemaDef。
 * 落盘：{root}/sessions/{sessionId}/summary/<id>.json
 */
export const SummarySchema = {
  entity: 'summary',
  engine: 'file',
  fs: {
    sharding: {
      shardKeyField: 'sessionId',
      dirTemplate: 'sessions/{shardKey}/',
    },
    format: 'json',
  },
  fields: {
    /** 主键 ULID（SessionStore 固定使用 sessionId 本身作 id，保证每会话单值） */
    id: { type: 'ulid', required: true },
    /** 所属会话 ULID（shardKey） */
    sessionId: { type: 'ulid', required: true },
    /** 摘要覆盖到哪个 message id（该 id 之前的消息已压缩）；null 表示尚无 summary */
    summaryUpTo: { type: 'string', required: false },
    /** 摘要正文（压缩后的历史内容） */
    content: { type: 'string', required: true },
    /**
     * [v0.0.186] 烘焙的完整 summary block 文本（preamble+head+tail，compact 时一次构建）。
     * 组装期 msg[0] 直接读它（零计算）；缺省（旧记录）→ base_builder 即时构建 fallback，
     * 下次 compact 自动升级。见 specs/tech/agent/context/[P0]context_assemble_detail.md §6。
     */
    block: { type: 'string', required: false },
  },
} as const satisfies SchemaDef;

/** summary 记录类型（从 SchemaDef 派生） */
export type SummaryRecord = InferRecord<typeof SummarySchema>;
