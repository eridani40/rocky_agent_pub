/**
 * chat-api barrel re-export hub（v0.0.156 拆分重构）。
 * 参考: specs/api/version_logs/v0.0.8/change_log.md §2 / §3 / §5.1
 *       specs/api/overall/04-agent-session.md（session/messages/inbox/pending/usage/compact/summary/clear/workspace 契约）
 *
 * 原单文件 chat-api.ts（403 行）按 API 模块拆为 4 子文件（chat-api/ 子目录），
 * 本文件保留为 barrel re-export hub —— **消费方零改**
 * （14+ 前端文件 page-chat / section-* / studio area-hooks / 单测仍 `from '../chat-api'` 或 `'./chat-api'`）。
 *
 * 子文件依赖方向（INV-G4 无循环）：
 *   - session-api = 端点 + 共享 req helper（被其他三者 import）
 *   - message-api / usage-summary-api / workspace-api → session-api（单向，不反向）
 *
 * v0.0.156 INV-B-3/G2：函数体 copy-paste，URL/method/body + 导出 surface 100% 等价（typecheck + UT 回归兜底）。
 */

export * from './chat-api/session-api';
export * from './chat-api/message-api';
export * from './chat-api/usage-summary-api';
export * from './chat-api/workspace-api';
