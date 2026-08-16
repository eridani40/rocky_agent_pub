/**
 * quota-events — provider_quota SSE topic 常量（v0.0.363 T1）
 * 参考: specs/tech/version_logs/v0.0.363/change_plan.md §1.4
 *
 * topic 真值单一权威源（whitelist test import 本文件，同 SQUAD_META_TOPIC 模式）：
 * 广播 group `_all`（同 app_task），打开中的两消费端页面订阅刷新。
 */

/** provider_quota topic 名（hub.registerTopic + sse.ts ALLOWED_TOPICS 同 commit 维护） */
export const PROVIDER_QUOTA_TOPIC = 'provider_quota';

/** 广播 group（共享 _all，无 wildcard——传输层 group 分区约束） */
export const PROVIDER_QUOTA_BROADCAST_GROUP = '_all';
