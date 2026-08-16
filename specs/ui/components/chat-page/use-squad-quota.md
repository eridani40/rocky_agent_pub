# use-squad-quota

> 层级: hook
> 文件: app/web/src/components/chat-page/use-squad-quota.ts（261 行）
> 引入版本: v0.0.356 · v0.0.363 quota 源改 store+SSE · v0.0.364 hourHit 收敛 quota-format

## 职责
弹层内四源数据组合 hook：打开即拉三低频源（方案库/熔断/provider 元数据 5min 轮询）+ quota 源走全局 store 共享 hook（GET store 秒开 + POST sync 增量 + SSE 帧刷新）+ 每源 lastGood + 1s tick（倒计时驱动）+ 卸载清理。

## 签名
```typescript
export function useSquadQuota(planId: string): {
  cards: CardVM[];
  planName: string;
  lastUpdatedAt: number;
  loading: boolean;
  error: Error | null;
}
```

## 四源 + 1 辅助源（v0.0.363 quota 源换共享 hook）
1. `planId` — 入参（来自 SquadStatusContext.detail，零请求）
2. `fetchModelRoutingPlans()` — 方案 items + 方案名（5min 轮询保留）
3. `fetchModelRoutingStatus(planId)` — 熔断状态 / remainingSeconds（5min 轮询保留）
4. `useProviderQuotaStore()`（`../providers/use-provider-quota-store.ts`，v0.0.363）— 额度/余额（byProvider/lastGood/lastSyncedAt）——挂载 GET store 秒开 + POST `/provider/quota/sync` 触发增量（fire-and-forget）+ SSE `provider_quota`/`_all` 帧刷新；`fetchProviderQuota` 直调已删
5. `listProviders()` — baseUrl（展开态 mono 行辅助源；5min 轮询保留）

## 刷新策略（v0.0.363）
- 三低频源（2/3/5）：挂载即首拉 + `FETCH_INTERVAL_MS = 5 * 60 * 1000` 自动刷新（非额度语义不动）
- quota 源：无轮询——server QuotaSyncService 5min 后台同步 + 打开触发增量 + SSE `provider_quota` 帧到达刷新
- `TICK_INTERVAL_MS = 1000` 仅更新 `nowMs` 驱动倒计时，零网络
- 卸载清理：轮询 interval + SSE 订阅（共享 hook 自管理）；`aliveRef` 拦截卸载后异步 setState

## 关键实现
- **hours 命中**：`hourHit` 从 `../providers/quota-format` import（私有副本已收敛为单一实现；h23 hourCycle 语义见 quota-format.md）
- **状态点合并**：一 provider 多 item 时最劣优先（红 > 橙 > 绿 > 灰白）
- **lastGood**：三低频源每源独立保留；quota 源 per-provider lastGood（error 项沿用上次成功值降级，SSE 断线/空窗兜底）
- **plan 被删/找不到**：planName 回退 `planId.slice(0,8)`；status 空则全灰白

## 复用关系
- 被组合：`component-quota-entry-modal.md`
- 组合：`../providers/use-provider-quota-store.ts`（v0.0.363 额度数据唯一前端入口）
- 消费：`../providers/quota-format.md`（formatSingleUnit/formatAmount/currencySymbol/hourHit）+ `model-routing-api.ts` + `api-client.ts`

## 测试
`use-squad-quota.test.ts`：四源组合 VM / lastGood / 三源 5min 轮询+卸载清理 / quota 帧（SSE）驱动 / tick 零网络 / hourHit h23。
