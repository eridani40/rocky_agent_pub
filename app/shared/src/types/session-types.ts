/**
 * 会话类型全局 type alias（BizType / Role / SessionType）
 * 参考: specs/prd/version_logs/v0.0.45-mention-system.md §4.5
 *       specs/tech/agent/session/[P0]session_kind.md §2（v0.0.56 SessionKind 概念）
 *
 * [v0.0.56] BizType / Role 从 session-kind.ts 重导出（概念权威处），避免两处独立定义不同步。
 * SessionType 保留为 Role | 'subagent'（向后兼容，T3 将改为 Role 别名）。
 */

import type { BizType, Role } from './session-kind';
export type { BizType, Role };

/**
 * 会话类型（向后兼容 alias，T3 将改为 `export type SessionType = Role`）。
 * 包含 'subagent' 值用于旧代码迁移期（T1-T3 期间）。
 */
export type SessionType = Role | 'subagent';
