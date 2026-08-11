/**
 * SquadEvent 类型定义（v0.0.305 新建）
 * 参考: specs/tech/app/frontend/[P0]sse_channel.md §10（session_meta topic 架构 + producer 归属）
 *       specs/tech/version_logs/v0.0.305.squad-list-ui-upgrade/architecture.md D5（squad_meta 同构）
 *
 * squad 聚合状态（在线/工作中/最后活跃）的广播 topic（topic=`squad_meta`，group=`_all`）。
 * 与 session_meta 同构：全量 payload（非 diff）、replayable=false（初始态走 GET /squad 拉全量）。
 */
/** squad_meta topic 名（hub.registerTopic + SSE 白名单 + 前端订阅共用；白名单测试 import 真值） */
export const SQUAD_META_TOPIC = 'squad_meta';

/** squad_meta 共享广播 group（对齐 SESSION_META_BROADCAST_GROUP 广播模式） */
export const SQUAD_META_BROADCAST_GROUP = '_all';

/**
 * squad 聚合视图（PRD §4.4.1 data schema）。
 * 口径与 seats 面板完全一致（architecture D2）：
 *   - onlineCount = member.state==='deployed' 数
 *   - inProgressCount = squadChat + members 直连 session state∈{running,interrupting,suspended} 数
 *   - lastActiveAt = 上述 session 集合 updatedAt 最大值；集合空 → squad.updatedAt
 */
export interface SquadAggregate {
  squadId: string;
  /** 在线成员数（deployed） */
  onlineCount: number;
  /** 工作中 session 数（busy） */
  inProgressCount: number;
  /** 最后活跃时间（max(session.updatedAt) ?? squad.updatedAt，恒有值可排序） */
  lastActiveAt: string;
}

/**
 * squad_meta_update 事件（squad_meta topic 唯一事件类型）。
 * 由 SquadMetaBroadcaster 在 squad 聚合状态变化时 emit 到 (squad_meta, _all) group；
 * data=全量聚合（非 diff），前端 reducer 按 data.squadId 整条替换。
 */
export interface SquadMetaUpdateEvent {
  /** 事件自身 ULID */
  id: string;
  /** 固定 'squad_meta_update'（squad_meta topic 只此一种事件） */
  type: 'squad_meta_update';
  /** 变更的 squad（与 data.squadId 一致） */
  squadId: string;
  /** ISO 8601 UTC */
  createdAt: string;
  /** squad 完整聚合视图（全量，非 diff） */
  data: SquadAggregate;
}

/** squad_meta topic 的事件联合（预留扩展） */
export type SquadMetaEvent = SquadMetaUpdateEvent;
