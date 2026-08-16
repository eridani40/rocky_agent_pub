/**
 * use-quota-polling —— 额度总览消费 hook（v0.0.363 T2 换源：接全局 store，历史名保留）
 * 参考: specs/tech/version_logs/v0.0.363/change_plan.md §1.5 + v0.0.350 决策⑥（轮询制，363 推翻）
 *
 * 职责：native provider 额度快照——
 *   数据源换共享 useProviderQuotaStore（GET store 存量 + 打开触发 POST sync + SSE provider_quota 帧）；
 *   5min 轮询 interval 已删（server 后台 5min 同步替代）；
 *   浏览器侧 lastGood 保留（单渠道失败沿用上次成功值；SSE 断线/空窗兜底）；
 *   30s 独立 tick 只触发重渲染（倒计时走动），零网络请求；
 *   卸载清理（订阅句柄由共享 hook 管理）。
 * 输出形状不变（v0.0.350 契约）：byProvider/lastGood/lastFetchedAt/tick——footer 零改动。
 * 边界：hook 只做数据持有 + tick，渲染决策在 footer 组件。
 */
import { useEffect, useState } from 'react';
import type { QuotaSnapshot } from '../../lib/api-client';
import { useProviderQuotaStore } from './use-provider-quota-store';

/** hook 入参 providers 最小形状（section 传 native 子集；空集合 → 零请求零订阅） */
export interface QuotaPollingProvider {
  id: string;
}

/** hook 输出：最新快照 + lastGood 降级源 + 上次拉取时间 + 30s tick */
export interface UseQuotaPollingResult {
  /** 最新一轮快照（含 error 项；providerId → snapshot） */
  byProvider: Map<string, QuotaSnapshot>;
  /** 各渠道最近一次成功快照（footer 降级展示用） */
  lastGood: Map<string, QuotaSnapshot>;
  /** store 上次同步时间（ms；null=尚无数据） */
  lastFetchedAt: number | null;
  /** 30s tick 计数（footer 倒计时重渲染驱动；自增不拉网络） */
  tick: number;
}

/** 30s tick 间隔常量（倒计时重渲染驱动；轮询 interval 已删——server 5min 后台同步替代） */
const TICK_INTERVAL_MS = 30 * 1000;

/**
 * 额度消费 hook：providers 为空 → 不订阅不建 tick（footer 不渲染时零开销）。
 */
export function useQuotaPolling(providers: readonly QuotaPollingProvider[]): UseQuotaPollingResult {
  const { byProvider, lastGood, lastSyncedAt } = useProviderQuotaStore(providers.length > 0);
  const [tick, setTick] = useState(0);

  // 30s tick：仅重渲染驱动（零网络）
  useEffect(() => {
    if (providers.length === 0) return;
    const tickTimer = setInterval(() => setTick((n) => n + 1), TICK_INTERVAL_MS);
    return () => clearInterval(tickTimer);
  }, [providers.length]);

  // 输出形状不变：lastFetchedAt 字段名沿用（v0.0.350 footer 契约），值换 store 同步时间
  return { byProvider, lastGood, lastFetchedAt: lastSyncedAt, tick };
}

export default useQuotaPolling;
