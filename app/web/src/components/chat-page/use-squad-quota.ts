/**
 * use-squad-quota —— 模型方案额度弹层四源数据组合 hook（v0.0.356 T1；v0.0.363 T2 quota 源换全局 store）
 * 参考: specs/tech/version_logs/v0.0.356-squad-quota-entry/change_plan.md D4/D6/D7
 *        specs/tech/version_logs/v0.0.363/change_plan.md §1.5（quota 源换共享 hook）
 *
 * 职责：
 *   - 四源组合：planId（squadCtx.detail 零请求）+ 方案库 + 熔断状态 + 额度快照（共享 store）+ provider 元数据（baseUrl）
 *   - [v0.0.363] quota 源换 useProviderQuotaStore（GET store 存量 + 打开触发 POST sync + SSE provider_quota 帧）；
 *     fetchProviderQuota 直调删——弹层打开仍即时（store 秒开 + 增量同步回写推送）
 *   - 方案库/熔断/provider 元数据三源：弹层内挂载立即首拉 + 5min setInterval 轮询保留，弹层关闭（卸载）即停
 *   - 单源失败不炸整体；每个源保留上次成功值 lastGood（CardVM 降级展示）；quota lastGood 在共享 hook 内
 *   - 1s tick 仅驱动熔断倒计时 UI，零网络请求
 *   - 卸载后 aliveRef 拦截异步 setState，避免内存泄漏/已卸载组件 setState 警告
 * 边界：
 *   - 入参 planId 非空；由调用方（ComponentQuotaEntryModal）在 squadCtx.detail.modelRoutingPlanId 存在时才渲染
 *   - 纯 async 聚合；错误对象落到 error 字段，不抛异常炸组件树
 *   - CardVM/UseSquadQuotaResult 形状不变（v0.0.356 契约，ComponentQuotaEntryModal 零改动）
 */
import { useEffect, useRef, useState } from 'react';
import { listProviders, type QuotaSnapshot } from '../../lib/api-client';
import { listModelRoutingPlans, getModelRoutingStatus } from '../app-dev-config-page/model-routing-api';
import type { ModelRoutingPlan, ModelRoutingStatus } from '../app-dev-config-page/model-routing-types';
import { hourHit } from '../providers/quota-format';
import { useProviderQuotaStore } from '../providers/use-provider-quota-store';

/** 轮询/ tick 常量 */
const FETCH_INTERVAL_MS = 5 * 60 * 1000;
const TICK_INTERVAL_MS = 1000;

/** 熔断器三态 */
export type CircuitState = 'closed' | 'open' | 'half_open';

/** 卡片视图模型（PRD §2.3/§2.4 双态卡统一数据） */
export interface CardVM {
  /** provider 主键 */
  providerId: string;
  /** provider 显示名（优先 plan item 中 providerId 对应的 label） */
  providerLabel: string;
  /** 方案条目里的 modelId */
  modelId: string;
  /** 当前命中合并后的状态 */
  state: 'working' | 'open' | 'half' | 'off';
  /** 当前状态词（已 i18n key 化） */
  stateKey: 'working' | 'open' | 'half' | 'off';
  /** 是否不在时间窗内 */
  offWindow: boolean;
  /** 熔断剩余秒数（open 态有效；UI 本地倒计时用） */
  remainingSeconds: number | null;
  /** 时间条件 hours（空 = 不限时） */
  hours: number[] | undefined;
  /** 余额/额度快照（可能 undefined：该 provider 无额度数据） */
  snapshot?: QuotaSnapshot;
  /** provider baseUrl（展开态 mono 行） */
  baseUrl?: string;
}

/** hook 输出 */
export interface UseSquadQuotaResult {
  /** 分组后的卡片视图模型 */
  cards: CardVM[];
  /** 方案名（方案库命中 planId） */
  planName: string | null;
  /** 上次成功更新时间（ms） */
  lastUpdatedAt: number | null;
  /** 是否首次加载中 */
  loading: boolean;
  /** 任意源错误提示（只保留最近一次；null=无） */
  error: string | null;
}

/** 三源 last-good 快照（[v0.0.363] quota 源在共享 hook 内持有 lastGood） */
interface LastGood {
  plan: ModelRoutingPlan | null;
  status: ModelRoutingStatus | null;
  providers: Map<string, { id: string; label: string; baseUrl: string }>;
}

/** 最新拉取轮次（quota 由共享 hook state 供给，不经 fetchRound） */
interface LatestRound {
  plan: ModelRoutingPlan | null;
  status: ModelRoutingStatus | null;
  providers: Map<string, { id: string; label: string; baseUrl: string }>;
}

/** 构造空 latest */
function emptyLatest(): LatestRound {
  return { plan: null, status: null, providers: new Map() };
}

/** 构造空 lastGood */
function emptyLastGood(): LastGood {
  return { plan: null, status: null, providers: new Map() };
}

/** 将 status.items 按 providerId+modelId 建索引 */
function indexStatus(status: ModelRoutingStatus | null): Map<string, ModelRoutingStatus['items'][number]> {
  const m = new Map<string, ModelRoutingStatus['items'][number]>();
  if (!status) return m;
  for (const it of status.items) {
    m.set(`${it.providerId}||${it.modelId}`, it);
  }
  return m;
}

/** 合并状态：offWindow 优先级最高，然后 worst-priority（open > half > closed） */
function mergeState(
  item: ModelRoutingStatus['items'][number] | undefined,
  hours: number[] | undefined,
  now: Date,
): { state: CardVM['state']; stateKey: CardVM['stateKey']; offWindow: boolean; remainingSeconds: number | null } {
  const offWindow = !hourHit(hours, now);
  if (offWindow) {
    return { state: 'off', stateKey: 'off', offWindow: true, remainingSeconds: null };
  }
  const cs = item?.circuitState ?? 'closed';
  if (cs === 'open') {
    return { state: 'open', stateKey: 'open', offWindow: false, remainingSeconds: item?.remainingSeconds ?? null };
  }
  if (cs === 'half_open') {
    return { state: 'half', stateKey: 'half', offWindow: false, remainingSeconds: null };
  }
  return { state: 'working', stateKey: 'working', offWindow: false, remainingSeconds: null };
}

/** 从 plan 与三辅助源生成 CardVM 列表（[v0.0.363] quotaMap 由共享 hook 供给） */
function buildCards(
  latest: LatestRound,
  lastGood: LastGood,
  quotaMap: Map<string, QuotaSnapshot>,
  quotaLastGood: Map<string, QuotaSnapshot>,
  now: Date,
): CardVM[] {
  const plan = latest.plan ?? lastGood.plan;
  const status = latest.status ?? lastGood.status;
  const statusMap = indexStatus(status);
  const effectiveQuota = quotaMap.size > 0 ? quotaMap : quotaLastGood;
  const providers = latest.providers.size > 0 ? latest.providers : lastGood.providers;

  if (!plan) return [];
  return plan.items
    .filter((it) => it.enabled !== false)
    .map((it) => {
      const p = providers.get(it.providerId);
      // 单渠道失败 per-provider 降级：error 项沿用 lastGood 成功值（对齐 footer view 语义）
      const rawSnap = effectiveQuota.get(it.providerId);
      const snap = rawSnap?.error ? quotaLastGood.get(it.providerId) ?? rawSnap : rawSnap;
      const statusItem = statusMap.get(`${it.providerId}||${it.modelId}`);
      const merged = mergeState(statusItem, it.timeCondition?.hours, now);
      return {
        providerId: it.providerId,
        providerLabel: p?.label ?? it.providerId,
        modelId: it.modelId,
        state: merged.state,
        stateKey: merged.stateKey,
        offWindow: merged.offWindow,
        remainingSeconds: merged.remainingSeconds,
        hours: it.timeCondition?.hours,
        snapshot: snap,
        baseUrl: p?.baseUrl,
      };
    });
}

/** useSquadQuota(planId)：三源轮询 + quota 共享 store + lastGood */
export function useSquadQuota(planId: string): UseSquadQuotaResult {
  // [v0.0.363] quota 源：共享 store hook（GET 存量秒开 + 打开触发 POST sync + SSE 帧刷新；lastGood 在其内部）
  const { byProvider, lastGood: quotaLastGood } = useProviderQuotaStore();
  const [latest, setLatest] = useState<LatestRound>(emptyLatest());
  const [lastGood, setLastGood] = useState<LastGood>(emptyLastGood());
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const aliveRef = useRef(true);

  // 卸载标记 + nowMs 初始化
  useEffect(() => {
    aliveRef.current = true;
    setNowMs(Date.now());
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // tick 驱动 nowMs 更新（纯 UI 倒计时）
  useEffect(() => {
    setNowMs(Date.now());
  }, [tick]);

  useEffect(() => {
    let cancelled = false;

    async function fetchRound() {
      let anySuccess = false;
      let errMsg: string | null = null;
      let fetchedAt: number | null = null;

      try {
        const [plans, providers] = await Promise.all([
          listModelRoutingPlans(),
          listProviders(),
        ]);
        if (cancelled || !aliveRef.current) return;
        const plan = plans.find((p) => p.id === planId) ?? null;
        const providersMap = new Map(providers.map((p) => [p.id, { id: p.id, label: p.label, baseUrl: p.baseUrl }]));

        setLatest((prev) => ({ ...prev, plan, providers: providersMap }));
        if (plan || providersMap.size > 0) {
          setLastGood((prev) => ({
            ...prev,
            plan: plan ?? prev.plan,
            providers: providersMap.size > 0 ? providersMap : prev.providers,
          }));
          anySuccess = true;
        }

        // 熔断状态（[v0.0.363] quota 源已换共享 store hook，不经 fetchRound）
        try {
          const statusValue = plan ? await getModelRoutingStatus(planId) : null;
          if (cancelled || !aliveRef.current) return;
          setLatest((prev) => ({ ...prev, status: statusValue }));
          setLastGood((prev) => ({ ...prev, status: statusValue ?? prev.status }));
          anySuccess = true;
        } catch (e) {
          if (cancelled || !aliveRef.current) return;
          errMsg = e instanceof Error ? e.message : String(e);
        }

        if (anySuccess) {
          fetchedAt = Date.now();
        }
      } catch (e) {
        if (cancelled || !aliveRef.current) return;
        errMsg = e instanceof Error ? e.message : String(e);
      } finally {
        if (!cancelled && aliveRef.current) {
          setLoading(false);
          if (errMsg) setError(errMsg);
          else setError(null);
          if (fetchedAt !== null) setLastUpdatedAt(fetchedAt);
        }
      }
    }

    void fetchRound();
    const interval = setInterval(() => void fetchRound(), FETCH_INTERVAL_MS);
    const tickTimer = setInterval(() => setTick((t) => t + 1), TICK_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(tickTimer);
    };
  }, [planId]);

  const now = new Date(nowMs);
  const cards = buildCards(latest, lastGood, byProvider, quotaLastGood, now);

  return { cards, planName: latest.plan?.name ?? lastGood.plan?.name ?? null, lastUpdatedAt, loading, error };
}
