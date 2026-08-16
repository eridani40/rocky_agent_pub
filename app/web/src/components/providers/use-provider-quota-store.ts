/**
 * use-provider-quota-store —— 全局额度 store 共享消费 hook（v0.0.363 T2）
 * 参考: specs/tech/version_logs/v0.0.363/change_plan.md §1.5 + T1 冻结契约（commit 8a2266e50）
 *
 * 职责：额度数据唯一前端入口——
 *   挂载 GET /provider/quota 读 store 存量秒开（T1：秒回不等待）；
 *   打开触发 POST /provider/quota/sync 增量（fire-and-forget 不阻塞首屏；30s 节流在 server）；
 *   subscribe('provider_quota','_all') 帧到达 setState（store 每轮同步后推送）；
 *   浏览器侧 lastGood 保留（单渠道失败项沿用上次成功值；SSE 断线/重启空窗兜底）；
 *   卸载 unsubscribe + aliveRef 拦截异步 setState。
 * 边界：不做轮询（server 5min 后台同步替代）；渲染决策在消费端组件（footer/modal）。
 */
import { useEffect, useRef, useState } from 'react';
import { fetchProviderQuota, syncProviderQuota, type QuotaSnapshot } from '../../lib/api-client';
import { getSseClient } from '../../lib/sse-singleton';
import type { SubscribeHandle } from '../../lib/sse-client';

/** topic/广播组（与 server 侧 llm/quota-events.ts 契约一致；广播 _all 同 app_task 模式） */
const PROVIDER_QUOTA_TOPIC = 'provider_quota';
const PROVIDER_QUOTA_BROADCAST_GROUP = '_all';

/** hook 输出：store 快照 + lastGood 降级源 + 同步时间 */
export interface UseProviderQuotaStoreResult {
  /** 最新一轮快照（含 error 项；providerId → snapshot） */
  byProvider: Map<string, QuotaSnapshot>;
  /** 各渠道最近一次成功快照（SSE 断线/空窗降级展示用） */
  lastGood: Map<string, QuotaSnapshot>;
  /** store 上次同步时间（ms；null=尚无数据） */
  lastSyncedAt: number | null;
}

/** items → byProvider 索引（全量覆盖；error 项也记录——错误态也是状态） */
function indexByProvider(items: QuotaSnapshot[]): Map<string, QuotaSnapshot> {
  const m = new Map<string, QuotaSnapshot>();
  for (const it of items) m.set(it.providerId, it);
  return m;
}

/** lastGood 合并：只记成功项；本轮全失败则沿用上轮（LastGood 语义） */
function mergeLastGood(prev: Map<string, QuotaSnapshot>, items: QuotaSnapshot[]): Map<string, QuotaSnapshot> {
  if (!items.some((it) => !it.error)) return prev;
  const m = new Map(prev);
  for (const it of items) if (!it.error) m.set(it.providerId, it);
  return m;
}

/** SSE 帧到达应用（GET 与帧共用）：items 全量覆盖 byProvider + lastGood 合并；空 items 保留旧值兜底（时间戳由 caller 单独更新） */
function applyRound(
  setters: { setByProvider: (m: Map<string, QuotaSnapshot>) => void; setLastGood: (f: (p: Map<string, QuotaSnapshot>) => Map<string, QuotaSnapshot>) => void },
  items: QuotaSnapshot[],
): void {
  if (items.length > 0) {
    setters.setByProvider(indexByProvider(items));
    setters.setLastGood((prev) => mergeLastGood(prev, items));
  }
}

/**
 * 全局额度 store 共享 hook。enabled=false（消费端 providers 为空）→ 零请求零订阅零开销。
 */
export function useProviderQuotaStore(enabled = true): UseProviderQuotaStoreResult {
  const [byProvider, setByProvider] = useState<Map<string, QuotaSnapshot>>(() => new Map());
  const [lastGood, setLastGood] = useState<Map<string, QuotaSnapshot>>(() => new Map());
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  // 卸载后不再 setState（GET/帧在 async 里，cleanup 后可能 resolve/到达）
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // effect 级取消标记：enabled 翻转（非卸载）时 cleanup 已跑但订阅仍 pending——aliveRef 拦不住（组件未卸载），
    // 晚到句柄须补偿回收（资源开闭成对）；帧 handler 同守卫防翻转后继续 setState
    let cancelled = false;
    let handle: SubscribeHandle | null = null;

    // ① 打开触发增量：fire-and-forget（202；失败静默——SSE 帧到达自然刷新）
    void syncProviderQuota().catch(() => {});

    // ② store 存量秒开（GET 秒回；空窗 {items:[], lastSyncedAt:null} 保留旧值兜底）
    void (async () => {
      try {
        const { items, lastSyncedAt } = await fetchProviderQuota();
        if (!aliveRef.current || cancelled) return;
        applyRound({ setByProvider, setLastGood }, items);
        // 空窗 null 不回退已有值：帧先到（含时间戳）后 GET 空响应晚到的竞态下保序——"保留旧值"对数据与时间戳一致
        if (lastSyncedAt != null) setLastSyncedAt(lastSyncedAt);
      } catch {
        // 整体失败（网络异常）：保持既有 state（LastGood 语义），下次帧/打开兜底
      }
    })();

    // ③ SSE 订阅：store 每轮同步后推帧刷新打开中页面
    void (async () => {
      try {
        const h = await getSseClient().subscribe(PROVIDER_QUOTA_TOPIC, PROVIDER_QUOTA_BROADCAST_GROUP, (frame) => {
          if (!aliveRef.current || cancelled) return;
          const data = frame.data as { items?: QuotaSnapshot[]; lastSyncedAt?: number | null } | null | undefined;
          if (!data || !Array.isArray(data.items)) return;
          applyRound({ setByProvider, setLastGood }, data.items);
          setLastSyncedAt(data.lastSyncedAt ?? null);
        });
        // 订阅晚于卸载/enabled 翻转到 → 立即回退（cleanup 已跑、句柄未接上，须补偿；资源开闭成对）
        if (!aliveRef.current || cancelled) {
          void h.unsubscribe().catch(() => {});
          return;
        }
        handle = h;
      } catch {
        // 订阅失败：静默（GET 已拉存量；下次打开重订）
      }
    })();

    return () => {
      cancelled = true;
      void handle?.unsubscribe().catch(() => {});
    };
  }, [enabled]);

  return { byProvider, lastGood, lastSyncedAt };
}

export default useProviderQuotaStore;
