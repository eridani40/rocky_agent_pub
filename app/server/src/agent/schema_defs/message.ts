/**
 * message entity（transcript）的 SchemaDef — transcript 主存储
 * 参考: specs/tech/agent/session/[P0]session_store.md §3（transcript 总存）
 *       specs/tech/agent/message/[P0]agent_message_interface.md §6（持久化归属）
 *       specs/tech/version_logs/v0.0.8/change_log.md §6（落盘路径）
 *
 * 落盘路径：{root}/sessions/{sessionId}/transcript/<seg>.jsonl
 *   - engine: file
 *   - sharding: shardKeyField=sessionId, dirTemplate='sessions/{shardKey}/'
 *   - format: jsonl（按段文件聚合，jsonlMaxCount=1000）
 *
 * 替换 v0.0.2 的 persistence/schema_defs/transcript.ts（实验 fixture）。
 * 字段：
 *   - id：消息 ULID（业务生成；ULID 字典序天然按时间升序，分页 beforeId 直接用字典序比较）
 *   - sessionId：所属会话（shardKey）
 *   - role：消息角色（system/user/assistant/tool）
 *   - content：ContentBlock[]（json 透传，落库形态按 message/types.ts）
 *   - runId：关联 agent run（可选）
 *   - sender：消息来源标记（可选 json）
 *   - metadata：扩展元数据（可选 json）
 *
 * 信封 createdAt/updatedAt/version 由 CrudStore 注入。
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * message entity（transcript）的 SchemaDef。
 * 落盘：{root}/sessions/{sessionId}/transcript/<seg>.jsonl
 */
export const MessageSchema = {
  entity: 'transcript',
  engine: 'file',
  fs: {
    sharding: {
      shardKeyField: 'sessionId',
      dirTemplate: 'sessions/{shardKey}/',
    },
    format: 'jsonl',
    jsonlMaxCount: 1000,
  },
  fields: {
    /** 消息 ULID（业务生成；字典序 = 时间序，便于 beforeId 分页） */
    id: { type: 'ulid', required: true },
    /** 所属会话 ULID（shardKey） */
    sessionId: { type: 'ulid', required: true },
    /** 消息角色 */
    role: {
      type: 'enum',
      required: true,
      enumValues: ['system', 'user', 'assistant', 'tool'],
    },
    /** ContentBlock[]（json 透传；具体形状归 message/types.ts） */
    content: { type: 'json', required: true },
    /** 关联 agent run ULID（可选） */
    runId: { type: 'ulid', required: false },
    /** 消息来源标记 MessageSender（json 透传） */
    sender: { type: 'json', required: false },
    /** 扩展元数据（json 透传） */
    metadata: { type: 'json', required: false },
  },
} as const satisfies SchemaDef;

/** message（transcript）记录类型（从 SchemaDef 派生） */
export type MessageRecord = InferRecord<typeof MessageSchema>;
