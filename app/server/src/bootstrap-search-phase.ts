/**
 * bootstrap-search-phase — Phase 11 装配：SearchEngine + HistoryIndexer + WorkspaceManager
 *
 * 纯 move 自 bootstrap.ts（v0.0.156 结构性拆分）。函数体 100% copy-paste，签名 + 内部逻辑不变。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §4.1 Phase 11 + §4.2 第七行
 *
 * 装配内容（按原 line 顺序，INV-C-1 严格保留）：
 *   1. createSqlDriver + SearchEngine + HistoryIndexer（search.sqlite 异常容忍 → undefined 不阻塞）
 *   2. setSearchIndexerEpDelegate（search_indexing handler delegate 注入）
 *   3. onSessionDestroyed wire（保留 scheduling boot 回调 + 追加 indexer.deleteBySession）
 *   4. historyIndexer.reconcile() fire-and-forget（崩溃恢复索引）
 *   5. SessionWorkspaceManager 构造 + sseChannel.setSubscribeHooks（懒监听 + recycleSession 兜底）
 *   6. workspaceManager shutdown hook（beforeExit → stopAll）
 *
 * 注：实际代码 line 顺序为 scheduler(827-877) → search(879-954) → workspace(956-990) → connectors(992+)。
 * 严格按 line 顺序：search-phase 在 scheduler 之后、connectors 之前（INV-C-1）。
 *
 * packaged 护栏（INV-PKG-1/2）：不读 process.env；不拼接相对路径；dataDir 作入参。
 */
import * as path from 'node:path';
import type { SessionStore } from './agent/session-store';
import type { SseChannel } from './sse/sse-channel';
import type { ReplayableEventBus } from './agent/event-hub';
import type { SearchEngine } from './persistence/search-engine';
import type { HistoryIndexer } from './persistence/history-indexer';
import { createSqlDriver } from './persistence/search-sql-driver';
import { SearchEngine as SearchEngineClass } from './persistence/search-engine';
import { HistoryIndexer as HistoryIndexerClass } from './persistence/history-indexer';
import { setSearchIndexerEpDelegate } from './persistence/search-indexer-ep-delegate';
// session_workspace_manager: 懒监听编排器
import { SessionWorkspaceManager } from './agent/session-workspace-manager';
import { SESSION_PANEL_TOPIC } from './bootstrap-bus-phase';

/** session_panel topic group 形如 `session_id:<sid>`，提取 sid（spec §3 group 约定） */
function extractSessionIdFromGroup(group: string): string | null {
  const prefix = 'session_id:';
  if (!group.startsWith(prefix)) return null;
  const sid = group.slice(prefix.length);
  return sid.length > 0 ? sid : null;
}

/**
 * Phase 11 装配：SearchEngine + HistoryIndexer + SessionWorkspaceManager + SSE subscribe hooks。
 *
 * @param dataDir 数据根目录绝对路径
 * @param store SessionStore（用于 onSessionDestroyed wire）
 * @param sessionStatusBus session_panel topic 的 bus（workspace manager 注入）
 * @param sseChannel SseChannel（注入 subscribe/unsubscribe hooks）
 * @returns searchEngine? + historyIndexer? + workspaceManager
 */
export async function bootstrapSearchPhase(deps: {
  dataDir: string;
  store: SessionStore;
  sessionStatusBus: ReplayableEventBus;
  sseChannel: SseChannel;
}): Promise<{
  searchEngine?: SearchEngine;
  historyIndexer?: HistoryIndexer;
  workspaceManager: SessionWorkspaceManager;
}> {
  const { dataDir, store, sessionStatusBus, sseChannel } = deps;

  // [v0.0.126] history_search 装配：SqlDriver + SearchEngine + HistoryIndexer
  // 路径：join(dataDir, 'search.sqlite') — 绝对路径（resolveDataDir 已展开 ~，PACKAGED-GUARD-2 禁字面 ~）。
  // createSqlDriver 按 runtime 选实现（dev=BunSqlDriver / packaged=Node/BetterSqlite3，async 工厂）。
  //
  // schema 顺序（硬约束，change_plan 模块6 已标注）：
  //   - SearchEngine 构造内调 ensureSchema 建 chunks + fts(external-content) + idx_chunks_session + idx_meta
  //   - HistoryIndexer 构造内调 ensureHistorySchema 建 chunks + fts + triggers + idx_meta
  //   - 两者都用 IF NOT EXISTS 幂等；HistoryIndexer.ensureHistorySchema 依赖 chunks 表存在
  //   - 顺序保证：先 new SearchEngine（建 chunks + fts）→ 再 new HistoryIndexer（建 triggers，chunks 已存在）。
  //
  // 异常容忍：search.sqlite 装配失败不阻塞 server 启动（历史搜索是旁路能力，不应让主服务挂）。
  //   失败时 searchEngine/historyIndexer = undefined；router endpoint 返 500；search_indexing handler no-op。
  let searchEngine: SearchEngine | undefined;
  let historyIndexer: HistoryIndexer | undefined;
  try {
    const searchSqlitePath = path.join(dataDir, 'search.sqlite');
    const sqlDriver = await createSqlDriver(searchSqlitePath);
    // titleResolver：同步返（async getSession 返 Promise 被 SearchEngine._tryResolveTitleSync 忽略返 null）。
    //   一期接受 sessionTitle 经常为 null（用户可见但搜索可用）；二期可改异步 title 解析。
    const titleResolver = (sid: string): string | null => {
      // 同步路径无法 await getSession；返 null（SearchEngine 兜底从 message_id ULID 解 timestamp）
      // 避免 search 阻塞。UT 路径注入同步 resolver；生产路径 title 暂 null（snippet 已足够召回价值）。
      void sid;
      return null;
    };
    searchEngine = new SearchEngineClass(sqlDriver, titleResolver);
    historyIndexer = new HistoryIndexerClass(sqlDriver, dataDir);
    // 注入 search_indexing handler（server 侧 holder；handler handle 时从 holder 读 indexer）
    setSearchIndexerEpDelegate(historyIndexer);
    // [history_search] 临时验证 log：装配成功（含 driver kind）
    try {
      console.log(
        `[history_search] boot: SearchEngine + HistoryIndexer assembled ` +
          `(driver=${sqlDriver.constructor?.name ?? '?'}, dataDir=${dataDir})`,
      );
    } catch {
      // log 本身不抛错
    }
  } catch (e) {
    // 装配失败：log + 继续启动（历史搜索不可用，但主服务正常）
    console.error('[bootstrap] search.sqlite assembly failed; history_search disabled:', e);
  }

  // 组合 onSessionDestroyed 链：scheduling/boot.ts 已直接赋值 sessionStore.onSessionDestroyed（单回调）。
  //   保留其原回调（cron 注销）+ 追加 indexer.deleteBySession（级联删 search.sqlite 索引）。
  //   两段共存不互斥（spec §5 onSessionDestroyed 注入链设计；change_plan 模块6 第2行约束）。
  //   必须在 bootScheduler 之后（bootScheduler 占用了 onSessionDestroyed），否则被覆盖。
  if (historyIndexer) {
    const prevCb = store.onSessionDestroyed;
    store.onSessionDestroyed = async (sessionId) => {
      // 先跑原 scheduling 回调（cron 注销）
      try { await prevCb?.(sessionId); } catch { /* best-effort */ }
      // 再跑 indexer 级联删（idempotent；FTS external-content trigger 自动级联删 fts 行）
      try { await historyIndexer.deleteBySession(sessionId); } catch { /* best-effort */ }
    };
  }

  // 启动 reconcile（fire-and-forget，不 await 阻塞 server.listen）：
  //   扫 sessions/*/transcript/*.jsonl 补 last_ulid 之后的索引（崩溃恢复 / 首次启用回填）。
  //   spec §5 + PRD §11.2.5。失败 log，下次启动重试。
  if (historyIndexer) {
    // [history_search] 临时验证 log：reconcile 触发
    try {
      console.log(`[history_search] boot: reconcile triggered (async, fire-and-forget)`);
    } catch {
      // log 本身不抛错
    }
    Promise.resolve(historyIndexer.reconcile()).catch((e) => {
      console.error('[bootstrap] history indexer reconcile failed (will retry next start):', e);
    });
  }

  // SessionWorkspaceManager —— 懒监听编排器（spec session_workspace_manager.md，v0.0.139 重写）。
  // 注入 session_panel topic 的 bus（emit session_workspace_file_changed）。
  // [v0.0.139] 懒监听下 watch 全由前端显式 POST /session/:id/workspace/watch 驱动（展开=watch/
  //   收起=unwatch，见 handlers/session-workspace-watch.ts）；subscribe（0→1）**不再**隐式建
  //   任何 watcher。unsubscribe（1→0）仍保留兜底：主人死亡（浏览器崩溃/断连，前端未走优雅
  //   release-all）时，经既有 SESSION_PANEL_TOPIC 守卫 + extractSessionIdFromGroup 触发
  //   recycleSession 回收该 session 全部 tab 的监听（spec §6②，两层回收之一）。
  const workspaceManager = new SessionWorkspaceManager({ statusBus: sessionStatusBus });
  sseChannel.setSubscribeHooks({
    onSubscribe: async (_topic, _group) => {
      // [v0.0.139] 懒监听重构：不再隐式 startWatch。保留 hook 挂载点（no-op），watch 由
      // 前端在 ws-panel 挂载 / 展开目录时显式调用。
    },
    onUnsubscribe: async (topic, group) => {
      if (topic !== SESSION_PANEL_TOPIC) return;
      const sid = extractSessionIdFromGroup(group);
      if (!sid) return;
      // 订阅归零 → await recycleSession（回收该 session 全部 tab 监听；异常兜底不影响退订）
      try {
        await workspaceManager.recycleSession(sid);
      } catch {
        // recycleSession 异常忽略（manager 内部已 try/catch watcher.close，再兜一层）
      }
    },
  });

  // 注册 shutdown hook（spec §7）：app shutdown → stopAll 释放所有 watcher。
  // Bun 进程退出时 process.on('beforeExit') 触发；electron app quit 走 destroy 链。
  // 仅注册一次（避免 bootstrapCache 多次复用时重复挂 hook）。
  if (!globalThis.__workspaceManagerShutdownHookRegistered) {
    process.on('beforeExit', () => {
      void workspaceManager.stopAll();
    });
    globalThis.__workspaceManagerShutdownHookRegistered = true;
  }

  return {
    ...(searchEngine ? { searchEngine } : {}),
    ...(historyIndexer ? { historyIndexer } : {}),
    workspaceManager,
  };
}

// 模块级标记位（避免 shutdown hook 重复挂载）
declare global {
  // eslint-disable-next-line no-var
  var __workspaceManagerShutdownHookRegistered: boolean | undefined;
}
