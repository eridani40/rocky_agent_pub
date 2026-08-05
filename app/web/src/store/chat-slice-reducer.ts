/**
 * chat-slice-reducer barrel re-export hub（v0.0.156 拆分重构）。
 * 参考: specs/ui/components/chat-page/_overview.md §2（视图模型）/ §4.10 / §4.13
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md §9（事件→Message 映射）
 *       specs/tech/version_logs/v0.0.95.lifecycle_buffer/change_plan.md §T1 §B（reducer 纯化）
 *
 * 原单文件 chat-slice-reducer.ts（495 行）按职责拆为 4 子文件（reducer/ 子目录），
 * 本文件保留为 barrel re-export hub —— **消费方零改**
 * （useMessages / use-run-state / chat-slice / 6 个单测仍 `from './chat-slice-reducer'` 或
 * `'../../store/chat-slice-reducer'`）。
 *
 * 子文件依赖方向（INV-G4 无循环）：
 *   - agent-event-types / message-preview / reducer-state = 叶子（仅依赖 chat-page/types）
 *   - apply-agent-event → 三者（同目录聚合），不反向
 *
 * reducer 设计原则（原文件顶部，延续 copy-paste，权威源）：
 *   - 纯函数：applyAgentEventToMessages(messages, runCtx, evt, stateSlice) → ReducerFullResult；
 *     runCtx 值传递（不 mutate），消费方（useMessages / squad-chat）按返回值写回自己的 buffer.runCtx。
 *   - session_panel session_status_update 帧的 reducer 拆到 session-slice-reducer.ts（控行数）。
 *   - 对话区只渲染服务端 SSE message_start 的 messageId（ULID 唯一来源），不本地乐观 push。
 *   - part key 稳定性（§2 rule6）：toolCallId / text-index 而非数组 index，SSE 乱序不抖动。
 *   - tool_call JSON 片段累积到 runCtx.toolCallRawArgs（拷贝旧 Map entries + set），end 时 parse 写回
 *     arguments 并返回**删了该 key 的新 Map**（reducer 内清理，不依赖消费方）。
 *   - tool_call_* 一律用 evt.messageId（事件自带）锚定 message，不依赖 runCtx.currentAssistantMessageId
 *     （仅 message_start role=assistant 才设，切到进行中 run 时可能永不设）；错过 message_start 时
 *     tool_call_start 兜底建 assistant message。
 *   - error 事件 pendingError 累积进返回的 runCtx；run_end 读出写入 lastRunFinish（§4.13）+ 返 runCtx=null。
 *   - enqueue-view：message_enqueued 建 / processed|canceled 按 enqueueId 幂等移除。
 *
 * v0.0.156 INV-G1/G2：函数体 copy-paste，导出 surface 100% 等价（typecheck + UT 回归兜底）。
 *     注：apply-agent-event.ts 因主 reducer 函数体 305 行 + JSDoc 总行数略超 300，已汇报 orchestrator
 *     （INV-G1「函数体 100% 等价」与 §0.4「≤ 300 行」对此单一函数互斥；保函数体不变）。
 */

export * from './reducer/agent-event-types';
export * from './reducer/message-preview';
export * from './reducer/reducer-state';
export * from './reducer/apply-agent-event';
