/**
 * builtin rocky_context plugin — ingest_handler: store_sink（v0.0.49 D15 新增，v0.0.66 default+forked 统一）
 * 参考: specs/tech/version_logs/v0.0.49/design_context_ext.md §1.4（store_sink 契约）
 *       specs/tech/version_logs/v0.0.49/design.md §1 D15（default/forked sink 对称 EP 化）
 *       specs/tech/version_logs/v0.0.66/design.md §1/§2.3/§2.7（session_store EP + buffer_sink 退役）
 *       specs/tech/agent/context/[P0]context_engine.md §3.6（源/汇可注入）
 *       specs/tech/agent/context/[P0]extension point and implementations.md §3.1/§6（v0.0.66 sink 配置）
 *
 * 职责：chain 尾 sink —— append messages 到 ctx.store。v0.0.66 起 default + forked 共用本 impl，
 *   落到哪个 store 由 `session_store` EP 按 scope 选（ContextEngine.resolveStore(scopeId) 解析注入）：
 *     - default scope → persistent_session_store（写持久 transcript）
 *     - forked scope → in_memory_session_store（写 per-session 内存数组）
 *   本 impl 零 scope 分支，透传不同 store 实现。替代 ContextEngine 原
 *   `if (scopeId !== FORKED) store.appendMessages` 硬尾（v0.0.49 D15 已删）。
 *
 * 演进：v0.0.49 D15 把 default sink EP 化（store_sink，对齐当时 forked 的 buffer_sink，chain 尾二选一）；
 *   v0.0.66 把 store 也 EP 化（session_store exclusive EP）后，forked 改用 store_sink + in_memory store，
 *   buffer_sink 退役。详见 extension point and implementations.md §6（v0.0.66 sink + session_store 配置）。
 *
 * 防御性：ctx.store 缺失（UT fixture 未注入）→ 不动 messages（no-op）。生产路径 ContextEngine.ingest
 *   必注入 store（resolveStore 经 session_store EP 解析）。
 *
 * 契约对齐：store.appendMessages 是 async（session-store §6.1 serialized putAsync），故 handle 返回
 *   Promise<Message[]>。applyIngestPipeline 对每个 handler `await`。append 必须在 ingest resolve 前
 *   完成，否则下一轮 assemble 读 store 会漏本轮新消息（race）。
 *
 * EP: context_ingest_handler，order=4（chain 尾——先经 query/tool_result truncate + system_reminder
 *   注入再落库）。
 */
import type { Message, MessageInput } from '../../../../server/src/message/types';
import {
  type IngestCtx,
  type IngestHandler,
  ContextImplBase,
} from '../types';

/**
 * store_sink handler：append messages 到 ctx.store（default scope 持久化），原样返回 messages。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class StoreSinkHandler
  extends ContextImplBase
  implements IngestHandler
{
  async handle(messages: Message[], ctx: IngestCtx): Promise<Message[]> {
    // 无 store（forked scope 不注入 / UT 未注入）→ 不动 messages（防御性 no-op）
    if (!ctx.store) return messages;
    // default 汇：append 到 store transcript（append-only 持久化；await 保 ingest resolve 前落库）
    // [v0.0.83] ctx.opts 透传（runId 等）→ forked 按 runId 分桶 per-run 隔离；default opts 缺省按 sid
    await ctx.store.appendMessages(ctx.config.sessionId, messages as MessageInput[], ctx.opts);
    return messages;
  }
}
