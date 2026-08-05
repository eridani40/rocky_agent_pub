/**
 * search_indexing EP delegate 注入点（v0.0.126 新建）
 * 参考: app/server/src/agent/session-store-ep-delegate.ts（同模式：server 侧 holder + setter）
 *       specs/tech/version_logs/v0.0.126/change_plan.md 模块6 第3行（indexer 注入）
 *       specs/tech/agent/context_and_memory/[P0]extension_point_and_implementations.md §3.9（persistent_session_store pattern）
 *
 * 背景：search_indexing handler（context_ingest EP impl）需持 HistoryIndexer 引用投递索引。
 *   plugin_manager 经 `new ImplClass(implId, cfg)` 实例化 EP impl（每次 scope assemble 按需 new），
 *   构造器签名只接 (implId, cfg)，无法直接注入 HistoryIndexer 实例；且 bootstrap 阶段拿不到
 *   按需实例化的 handler 实例（PluginManager 无 getInstance 缓存）。
 *
 * 为何 holder 放 server 侧而非 plugin 侧（与 session-store-ep-delegate 同理由）：
 *   - plugin → server 是允许的依赖方向（plugin 已 import server 的类型）
 *   - server → plugin 违反 rootDir + 语义（plugin 是被加载的扩展，不应被 server 静态 import）
 *   - 故 holder 放 server 侧（本文件），plugin 的 SearchIndexingHandler 从此 import getIndexer；
 *     bootstrap 装配 HistoryIndexer 后调 setSearchIndexerEpDelegate(idx) 完成注入（server → server）。
 *
 * SearchIndexingHandler 兼容两注入路径：① setIndexer（UT 显式注入）② 本 holder（生产路径）。
 * handle 时优先用 setIndexer 注入的；未注入则回退 holder（null 时 no-op）。
 */
import type { HistoryIndexer } from './history-indexer';

/** 模块级 delegate：bootstrap 调 setSearchIndexerEpDelegate 注入真实 HistoryIndexer 实例 */
let delegate: HistoryIndexer | null = null;

/**
 * bootstrap 装配 HistoryIndexer 后调一次，注入真实实例。
 * 必须在 ContextEngine 跑 ingest 链（search_indexing handler 被 assemble）前调。
 * 幂等：重复调用覆盖前一个引用。
 */
export function setSearchIndexerEpDelegate(indexer: HistoryIndexer): void {
  delegate = indexer;
}

/** 取当前 delegate；未注入返 null（UT 隔离 / 启动早期 / forked scope disabled 不实例化 handler 时用） */
export function getSearchIndexerEpDelegate(): HistoryIndexer | null {
  return delegate;
}

/** 测试清理用：UT afterEach 重置 holder 防跨 case 泄漏（生产路径不调） */
export function __resetSearchIndexerEpDelegateForTest(): void {
  delegate = null;
}
