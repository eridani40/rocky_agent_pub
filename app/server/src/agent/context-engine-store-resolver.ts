/**
 * ContextEngine store-resolver — session_store EP 解析 + slot 释放（v0.0.66 从 context-engine.ts 拆出）
 * 参考: reqs/[working] v0.0.66/design.md §1.1/§2.1/§2.6
 *       specs/tech/agent/context/[P0]context_engine.md §3.6（源/汇可注入 + scope 驱动）
 *
 * 拆分原因：context-engine.ts 主干（ingest/assemble/compact）≤300 行约束。
 * 本文件承载 session_store EP 相关胶水：
 *   - resolveStore(pluginManager, fallbackStore, scopeId)：按 scope 选 EP impl（default→persistent / forked→in_memory）
 *   - clearScopeSession(...)：释放 forked scope 的 in_memory slot（forked run 结束 / 启动期兜底）
 *
 * releaseSlot（SessionStoreContract 方法）与 SessionStore.clearSession 语义分离：
 *   - releaseSlot：释放 forked 内存槽（default scope 永不调），caller = ForkedLifecyclePort
 *   - clearSession：删整 session 返 Session（HTTP handler 用，不经 EP impl 调）
 * 命名分离避免误删真实 session（Major 2 修复）。
 */
import type { PluginManager } from '../plugin/plugin-manager';
import { SessionStorePoint } from '../plugin/extension-point';
import type { SessionStore } from './session-store';
import type { StoreCallOpts } from './session-store-types';

/**
 * v0.0.66 §2.3 解析 scope 选中的 session_store EP impl。
 *   - default scope → persistent_session_store（包装真实持久 SessionStore 实例）
 *   - forked scope → in_memory_session_store（per-session 内存数组，替代旧 buffer）
 * 无 pluginManager / EP 无 active impl → 回退 fallbackStore（保 UT fixture 兼容）。
 * EP impl 仅实现 SessionStoreContract 子集（6 方法），assemble/ingest 路径只调该子集，
 * 故 `as unknown as SessionStore` 强转运行期安全（其他 SessionStore 方法不经此 EP 调）。
 */
export function resolveStore(
  pluginManager: PluginManager | null,
  fallbackStore: SessionStore,
  scopeId: string,
): SessionStore {
  if (!pluginManager) return fallbackStore;
  const impls = pluginManager.getExtensionImpls(SessionStorePoint, scopeId);
  if (impls.length === 0) return fallbackStore;
  return impls[0] as unknown as SessionStore;
}

/**
 * [v0.0.66 §2.6] 清理某 scope 的 store buffer 桶（forked run 结束 caller 调）。
 * 经 resolveStore 拿 EP-selected store 后调其 releaseSlot：
 *   - forked scope → in_memory_session_store.releaseSlot 按 runId 删 Map 桶（释放内存 + per-run 隔离）
 *   - default scope → persistent_session_store.releaseSlot no-op（持久 session 不经此 EP 删）
 * 无 pluginManager → no-op（UT fixture 无 EP impl，无桶需清；保 fallbackStore.releaseSlot 误删）。
 * [v0.0.83] opts.runId：forked 按 runId 释放 per-run 桶。
 */
export async function clearScopeSession(
  pluginManager: PluginManager | null,
  fallbackStore: SessionStore,
  scopeId: string,
  sessionId: string,
  opts?: StoreCallOpts,
): Promise<void> {
  if (!pluginManager) return;
  const store = resolveStore(pluginManager, fallbackStore, scopeId);
  // SessionStoreContract.releaseSlot(sessionId, opts?) 返 Promise<void>（design §1.1）。
  // 经 unknown 强转拿到 Contract 接口；pluginManager 非 null 时 resolveStore 必返 EP impl
  // （forked scope 选 in_memory），运行期 releaseSlot 是 Contract 的 void 版本。
  await (store as unknown as { releaseSlot: (sid: string, opts?: StoreCallOpts) => Promise<void> })
    .releaseSlot(sessionId, opts);
}
