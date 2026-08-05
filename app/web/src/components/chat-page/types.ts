/**
 * chat-page 共享类型 barrel re-export hub（v0.0.156 拆分重构）。
 * 参考: specs/ui/components/chat-page/_overview.md §2
 *       specs/tech/agent/message/[P0]agent_message_interface.md
 *
 * 原单文件 types.ts（522 行）按子域拆为 6 子文件（types/{message,session,hitl,usage,subagent,enqueue}.ts），
 * 本文件保留为 barrel re-export hub —— **消费方零改**（35 个文件仍 `from './types'` 或 `'../chat-page/types'`）。
 *
 * 子域依赖方向（INV-G4 无循环）：
 *   - message / hitl / usage / subagent / enqueue = 叶子（无内部依赖）
 *   - session → usage（单向，Session 引用 SummaryTaskStatus；不反向）
 */

export * from './types/message';
export * from './types/session';
export * from './types/hitl';
export * from './types/usage';
export * from './types/subagent';
export * from './types/enqueue';
