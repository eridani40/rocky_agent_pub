# v0.0.363 变更计划书 — 全局额度同步任务 + store 权威源 + 打开增量 + SSE 推送

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 0. 需求与拍板

| 时间 | 拍板 | 内容 |
|---|---|---|
| 老板 20:33 | 四点需求 | ①server 全局同步任务每 5min 同步各 provider 额度 → 全局 store（单一权威源）②两消费端（squad 额度弹层 + 全局模型页）优先读 store 秒开 ③打开时触发增量查询（不阻塞首屏），结果回写 store ④store 更新 SSE 推送打开中的页面 |

- req：`reqs/[working] v0.0.363.quota-global-sync.md`（commit 5bb2c17c6）
- **PRD 判定（架构评估）**：纯技术直架构——交互形态不变（弹层/页面渲染同现状），只换数据来源与刷新机制（现拉轮询 → store+SSE）；「打开速度提升/数据实时性」为既有交互的性能属性非新交互。无新 UI 元素。跳 PRD（leader 口径倾向一致）。

## 1. 方案设计

### 1.1 现状链路（代码实证）

- **额度聚合端点**：GET `/provider/quota`（`routes/misc-routes.ts` L144 → `handlers/provider-quota.ts` handleProviderQuota）——**每次现拉不缓存**（v0.0.350 决策⑥），listProviders 过滤 NATIVE_QUOTA_NAMES（4 native coding plan）→ Promise.all 逐 provider impl.queryQuota（15s timeout 在 impl 内）→ 单渠道失败 item.error 不炸整体。
- **消费端 A**：`web/src/components/chat-page/use-squad-quota.ts`（356 四源 hook）——planId + 方案库 + 熔断状态 + **额度快照(fetchProviderQuota)** + provider 元数据；5min setInterval 轮询 + lastGood 降级。
- **消费端 B**：`web/src/components/providers/use-quota-polling.ts`（350 决策⑥ 前端轮询）——fetchProviderQuota 5min 轮询 + lastGood。
- **SSE 基建**：SseChannel hub（`handlers/sse.ts` ALLOWED_TOPICS + `bootstrap-bus-phase.ts` registerTopic 双处手维护，`__tests__/sse-topic-whitelist.test.ts` 双向对齐断言防漏配）；app_task topic 用 `_all` 广播 group 先例（AppTaskLock.setAppTaskBus + emit(APP_TASK_BROADCAST_GROUP)）。

**本版推翻**：350 决策⑥「server 不缓存，前端 lastGood 持有」→ server 全局 store 单一权威源（决策演进记 change_log）。

### 1.2 全局 store + 同步任务（server）

**QuotaStore**（新 `app/server/src/llm/quota-store.ts`，纯数据无 IO）：内存 Map<providerId, QuotaSnapshot> + lastSyncedAt。**不持久化**——额度快照时效性强，重启后启动即跑首轮同步补齐（15s 内），持久化旧值反而误导。

**QuotaSyncService**（新 `app/server/src/llm/quota-sync-service.ts`）：
- `syncOnce()`：复用聚合逻辑——自 handleProviderQuota 提取纯函数 `collectQuotaSnapshots(svc, pluginManager): Promise<QuotaSnapshot[]>`（provider-quota.ts 导出，两处共用零重复）→ 写 store 全量覆盖（含 error item——错误态也是状态）→ emit SSE（§1.4）。
- 周期：`setInterval(syncOnce, intervalMs)`，默认 5min；**可配置**：env `QUOTA_SYNC_INTERVAL_MS`（缺省 300000；packaged 护栏语义——仅 dev/prod env 层读取，同既有 env 惯例）。
- 生命周期：bootstrap-store-phase 装配 → server 启动即 start（立即跑首轮 + interval）；SIGTERM/SIGINT trap 清 interval（registerShutdownTrap 先例）。
- 并发/节流：`inFlight` flag（上一轮未完跳过触发）；`lastTriggeredAt` 30s 节流（多页面同时打开触发增量不叠加）。

### 1.3 端点语义变更 + 打开增量

- **GET `/provider/quota`（语义变更）**：读 store 立即返回 `{ items, lastSyncedAt }`（秒开）；store 空（启动空窗）→ 异步触发 syncOnce（不等待）+ 立即返回 `{ items: [], lastSyncedAt: null }`——前端 lastGood 兜底 + SSE 到达刷新。
- **POST `/provider/quota/sync`（新增）**：触发一次增量同步（fire-and-forget，立即 202 `{ syncing: true, lastTriggeredAt }`；inFlight/节流命中 → 202 `{ syncing: false, reason }`）。打开页面时前端调用。
- **增量查询范围 = 全量 native providers**（非视野内）。理由：①store 是全局权威源，两消费端视野不同（squad 弹层看 plan 内、模型页看全部），「视野内」需传参且 store 混入新旧夹杂语义复杂；②与 5min 兜底任务同构——同一 syncOnce() 复用，「打开触发」= 提前跑一轮，零额外代码路径；③native coding plan 通常 ≤5 个，全量成本低。

### 1.4 SSE 推送（复用现有基建，新 topic）

- 新 topic `provider_quota`，广播 group `_all`（同 app_task 模式）。
- 触发：syncOnce 写 store 完成后 emit `{ topic:'provider_quota', group:'_all', data:{ items, lastSyncedAt } }`。
- 接线三处：`handlers/sse.ts` ALLOWED_TOPICS + `bootstrap-bus-phase.ts` registerTopic（新 bus，同 panoramaBus/app_task 装配模式）+ `sse-topic-whitelist.test.ts` 白名单断言同步。
- **判定理由**：复用 SseChannel 基建（订阅管理/断线重连/白名单全现成），不建独立 channel；新 topic 而非塞 app_task（语义不同，混用污染既有消费者过滤）。

### 1.5 前端 hook 改造（上层 UI 组件零改动）

**新共享 hook** `web/src/components/providers/use-provider-quota-store.ts`：
1. 挂载即 GET store 存量 → 立即渲染（秒开）
2. 挂载即 POST sync 触发增量（不阻塞首屏）
3. sse-client subscribe('provider_quota', '_all') → 帧到达 setByProvider
4. 卸载 unsubscribe（SubscribeHandle.cleanup）+ aliveRef 拦截异步 setState（沿用既有模式）
5. 输出 `{ byProvider, lastSyncedAt }`（对齐 use-quota-polling 现有形状，消费组件少动）

**消费端 B 改造**：`use-quota-polling.ts` 内部改调共享 hook，轮询 interval 删（SSE 替代），`lastGood` 语义由 store 权威源接管（server 侧恒有最近成功值）——输出形状保持，section-providers/footer 零改动。
**消费端 A 改造**：`use-squad-quota.ts` 四源中 quota 源换共享 hook；其余三源（方案库/熔断状态/provider 元数据）照旧 5min 轮询（低频+非额度语义不动）；quota 出轮询列表。ComponentQuotaEntryModal 零改动。

### 1.5b 已知限制

- SSE 断线期间 store 更新不达（重连后下一轮 5min 或下次打开触发补齐）——既有 SSE 全 topic 共性，不在本版解。
- store 不持久化 → 重启后空窗期（首轮 sync 前）两消费端空数据渲染（lastGood 前端兜底在重启后的浏览器侧仍有效）。

## 2. 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| server | app/server/src/llm/quota-store.ts | QuotaStore（get/set/all） | 新增 | 内存 Map<providerId,QuotaSnapshot> + lastSyncedAt；纯数据无 IO 不持久化 | MUST：≤300 行；MUST NOT：不做文件写入 | 本表 §1.2 | +40 |
| server | app/server/src/llm/quota-sync-service.ts | QuotaSyncService（syncOnce/start/stop） | 新增 | interval 5min（env QUOTA_SYNC_INTERVAL_MS 可配）+ inFlight + 30s 节流 + SIGTERM trap；syncOnce = collect → store.set → SSE emit | MUST：启动立即首轮；MUST NOT：inFlight 重入 | 本表 §1.2 | +90 |
| server | app/server/src/handlers/provider-quota.ts | handleProviderQuota + collectQuotaSnapshots + handleProviderQuotaSync | 修改/新增 | 聚合逻辑提取导出 collectQuotaSnapshots；GET 改读 store（空则异步触发 syncOnce）；POST /provider/quota/sync handler（202） | MUST：GET 秒回不等待；错误 item 也进 store | 本表 §1.3 | +45/-10 |
| server | app/server/src/routes/misc-routes.ts | POST 分支 | 修改 | +`/provider/quota/sync` 路由（GET 分支旁） | MUST：与 GET 同置于 providerMatch 正则前 | misc-routes L142-145 | +5 |
| server | app/server/src/handlers/sse.ts | ALLOWED_TOPICS | 修改 | +'provider_quota' | MUST：与 bootstrap-bus-phase 同 commit | sse.ts L22 | +1 |
| server | app/server/src/bootstrap-bus-phase.ts | registerTopic | 修改 | +provider_quota topic（新 bus，同 panoramaBus 模式） | 同上 | 本表 §1.4 | +8 |
| server | app/server/src/bootstrap-store-phase.ts | 装配 | 修改 | QuotaStore + QuotaSyncService 构造 + start + shutdown trap | MUST：registerTopic 先于 service.start | 本表 §1.2 | +12 |
| web | app/web/src/lib/api-client.ts | syncProviderQuota | 新增 | POST /provider/quota/sync 封装 | — | 本表 §1.3 | +8 |
| web | app/web/src/components/providers/use-provider-quota-store.ts | useProviderQuotaStore | 新增 | store 读 + 打开触发 sync + SSE 订阅；输出 {byProvider,lastSyncedAt} | MUST：unsubscribe cleanup + aliveRef；MUST NOT：不做轮询 | 本表 §1.5 | +70 |
| web | app/web/src/components/providers/use-quota-polling.ts | useQuotaPolling | 修改 | 内部改调共享 hook；轮询/lastGood interval 删 | MUST：输出形状不变（section/footer 零改动） | 本表 §1.5 | -30/+12 |
| web | app/web/src/components/chat-page/use-squad-quota.ts | useSquadQuota | 修改 | quota 源换共享 hook；三源轮询保留；fetchProviderQuota 调用删 | MUST：CardVM/UseSquadQuotaResult 形状不变 | 本表 §1.5 | -20/+15 |
| 测试 | __tests__（server 3 面 + web 2 面 + whitelist） | describe 新增/修改 | 修改 | sync-service（周期/inFlight/节流/首轮）+ GET 语义（store 读/空触发）+ POST 202 + sse-topic-whitelist 同步 + use-provider-quota-store（SSE 帧到达/卸载清理）+ use-squad-quota 四源回归 | MUST：全绿 + tsc -b 0 error | — | +160 |

## 3. 影响面与验证

- **跨模块**：server（llm/handlers/routes/bootstrap 四点）+ web（lib+两 hook）。依赖单向：sync-service → store + collect；handlers → store/sync-service；无循环。
- **行为变更**：①GET /provider/quota 从现拉（~15s 慢）→ store 秒回（350 决策⑥ 推翻，change_log 记录）②前端额度轮询 5min interval 全删（SSE 替代）③打开页面多发一次 POST sync（30s 节流）。
- **风险**：①重启空窗（首轮 sync 前空数据）——前端浏览器侧 lastGood 仍兜底 + 启动即跑首轮缩短窗口；②SSE 断线丢帧——5min 兜底 + 下次打开触发补齐（§1.5b）；③多页面并发触发 sync——30s 节流挡叠加。
- **验证**：UT 必须（5 面）；AT 建议 1 条（GET 秒回语义 + POST sync 契约，黑盒真实调）；ET 豁免（无交互形态变化）。老板验收 = 打开弹层秒开 + 额度变化 5min 内自动刷新。
- **specs 同步**（doc-modifier 收尾）：`specs/api/overall/02-llm-chat.md` §5.6（GET 语义 + POST sync 端点 + SSE provider_quota topic）+ 350/356 change_log 决策⑥推翻追记。

## 4. 任务拆分

- **T1 server**：store + sync-service + 端点改造 + SSE topic + bootstrap（含 whitelist test）
- **T2 web**：共享 hook + 两消费端改造（依赖 T1 API/SSE 契约，可按契约并行）
