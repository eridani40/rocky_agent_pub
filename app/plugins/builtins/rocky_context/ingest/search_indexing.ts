/**
 * builtin rocky_context plugin — ingest_handler: search_indexing（v0.0.126 新增）
 * 参考: specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.1（ingest handler 表）
 *       specs/tech/agent/context_and_memory/[P0]context_ingest_detail.md §3（IngestHandler 契约）
 *       specs/tech/persistence/[P1]search_engine.md §3.3（文本来源时序）+ §4（indexer 写入队列）
 *       specs/tech/version_logs/v0.0.126/change_plan.md 模块3
 *
 * 职责：order=5 旁路 sink —— 在 store_sink(4) 落库后，遍历 messages 提取纯文本副本
 *   投递给 HistoryIndexer（fire-and-forget）。只对 role∈{user,assistant} 提取 type=text
 *   block 的 text（剥 image/tool_use/tool_result/reasoning 等非文本块）。
 *
 * 与 store_sink 的关系：
 *   - store_sink(4)：主链尾 sink，await appendMessages 落 transcript（必须等完成才返，否则下一轮
 *     assemble 读 store 漏本轮新消息）
 *   - search_indexing(5)：旁路 sink，不 await（fire-and-forget），异常吞掉。索引失败由
 *     HistoryIndexer.reconcile() 启动兜底扫 jsonl 补索（spec §5 不变量）。
 *     v0.0.136 起 HistoryIndexer 内部已是 async consumer loop（批间 await sleep 让出 event loop，
 *     不再同步排空阻塞），handle 侧保持 idx.index(payloads) 不 await（ingest 入口绝不阻塞）。
 *
 * indexer 注入（T6 bootstrap 装配，change_plan 模块6 第 3 行）：
 *   - 生产路径：bootstrap 装配 HistoryIndexer 后调 setSearchIndexerEpDelegate(idx) 注入 server 侧
 *     holder；本 handler handle 时从 holder 读（plugin→server 方向正确，与 persistent_session_store
 *     从 session-store-ep-delegate 读 delegate 同模式）。PluginManager 按需 new EP impl，bootstrap
 *     拿不到实例故走 holder 而非直接 setIndexer。
 *   - UT 路径：UT 显式调 setIndexer(idx) 注入单实例（UT 可控、不污染 holder）
 *   - 未注入（UT fixture / 启动早期 / forked scope disabled 不实例化）→ no-op（不动 messages）
 *   - handle 时优先用 setIndexer 注入的；未注入则回退 holder（两路径兼容）
 *
 * 防御性：
 *   - indexer 未注入 → 返 messages 原样（no-op，UT 隔离安全）
 *   - indexer.index() 抛错 → 吞掉不影响 ingest（fire-and-forget 语义；reconcile 兜底）
 *
 * EP: context_ingest_handler，order=5（chain 尾——紧随 store_sink，store 落库后才能投索引）。
 *     forked scope 显式 disabled（forked.yaml 加 enabled:false），forked run 不进历史索引
 *     （防 forked run 的 summary/memory_extract 内容污染历史搜索召回）。
 */
import type { Message } from '../../../../server/src/message/types';
import {
  ContextImplBase,
  type IngestCtx,
  type IngestHandler,
} from '../types';
import type { HistoryIndexer, IndexPayload } from '../../../../server/src/persistence/history-indexer';
import { extractPlainText } from '../../../../server/src/persistence/search-text-util';
import { getSearchIndexerEpDelegate } from '../../../../server/src/persistence/search-indexer-ep-delegate';

/** 仅 user/assistant 进索引（system/tool 由 handler 过滤掉） */
const INDEXED_ROLES = new Set(['user', 'assistant']);

/**
 * search_indexing impl：旁路 sink 投递 HistoryIndexer，原样返回 messages（不 transform）。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class SearchIndexingHandler
  extends ContextImplBase
  implements IngestHandler
{
  /** HistoryIndexer 引用（bootstrap 注入；未注入 = no-op） */
  private indexer: HistoryIndexer | null = null;

  /**
   * 注入 HistoryIndexer（T6 bootstrap 装配后调）。
   * 幂等：重复调用覆盖前一个引用。
   */
  setIndexer(indexer: HistoryIndexer): void {
    this.indexer = indexer;
  }

  /** 测试 / 调试用：当前注入的 indexer 引用（可能为 null） */
  getIndexer(): HistoryIndexer | null {
    return this.indexer;
  }

  /**
   * ingest 旁路：遍历 messages，提取 role∈{user,assistant} 的纯文本 → 批量投递 indexer。
   * 透传 messages（返回 === 入参引用）；fire-and-forget（不 await indexer）；异常吞。
   */
  handle(messages: Message[], ctx: IngestCtx): Message[] {
    // indexer 注入：优先 setIndexer（UT 路径）；未注入则从 server 侧 holder 取（生产路径，
    // 与 persistent_session_store 从 session-store-ep-delegate 读同模式）。两者都 null → no-op。
    const idx = this.indexer ?? getSearchIndexerEpDelegate();
    if (idx === null) return messages;

    // 从 ctx.config.sessionId 取 sessionId（spec §3.3：handler 投递 id = chunks.message_id = transcript id）
    const sessionId = ctx.config?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return messages;

    // 提取 role∈{user,assistant} 的纯文本
    const payloads: IndexPayload[] = [];
    const roleBreakdown: Record<string, number> = {};
    for (const m of messages) {
      if (!INDEXED_ROLES.has(m.role)) continue; // tool/system 跳过
      const text = extractPlainText(m.content);
      if (text.length === 0) continue; // 空 text 不投（无搜索价值）
      payloads.push({
        messageId: m.id,
        sessionId,
        role: m.role as 'user' | 'assistant',
        ts: m.id, // ts = messageId（ULID 字典序 = 时间序，recency 排序用）
        text,
      });
      roleBreakdown[m.role] = (roleBreakdown[m.role] ?? 0) + 1;
    }

    // [history_search] 临时验证 log：投递情况（messages 总数 + 实际索引条数 + role 分布）
    try {
      console.log(
        `[history_search] search_indexing handler: session=${sessionId}, messages=${messages.length}, ` +
          `indexed=${payloads.length} (roles=${JSON.stringify(roleBreakdown)}), ` +
          `indexer=${idx.constructor?.name ?? '?'}`,
      );
    } catch {
      // log 本身不抛错（防 log 崩）
    }

    if (payloads.length === 0) return messages;

    // 批量投递（不 await；HistoryIndexer.index 内部 fire-and-forget，由 async consumer loop 后台消费）；异常吞
    try {
      idx.index(payloads);
    } catch {
      // 异常吞：不影响 ingest；reconcile 启动兜底
    }

    // 透传 messages（返回 === 入参引用；不 transform）
    return messages;
  }
}
