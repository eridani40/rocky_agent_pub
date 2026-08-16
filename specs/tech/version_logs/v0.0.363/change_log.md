# v0.0.363 change_log — 全局额度同步任务 + store 权威源 + 打开增量 + SSE 推送

> 需求：老板 2026-08-15 20:33 四点（`reqs/[working] v0.0.363.quota-global-sync.md`，commit 5bb2c17c6）。
> 权威契约：`specs/tech/version_logs/v0.0.363/change_plan.md`（frozen）。
> commit：`70abdda64`（架构四件套）/ `8a2266e50`（T1 server）/ `87ac94238`（T1 review Minor×2）/ `174c002a6`（T2 web）/ `9c146cffb`（T2 review Minor×2）/ `b0d1bf758`（AT case）/ AT 执行报告（states verify，产物未 commit）。
> PRD 跳过（架构判定）：纯技术——交互形态不变，只换数据来源与刷新机制。

## 变更摘要（决策）

| 决策 | 内容 |
|---|---|
| ① store 不持久化 | 额度快照时效性强，持久化旧值误导；重启后启动即跑首轮（15s 内）补齐。内存 Map<providerId,QuotaSnapshot> + lastSyncedAt |
| ② 5min 可配 | `QUOTA_SYNC_INTERVAL_MS`（缺省 300000）；启动立即首轮；SIGTERM/SIGINT trap 清 interval |
| ③ 打开增量 = 全量 native | 非视野内——store 是全局权威源（两消费端视野不同）；与周期轮同构复用 syncOnce（提前跑一轮，零额外路径）；native ≤5 成本低 |
| ④ 防重入/节流 | inFlight flag（上一轮未完跳过）+ lastTriggeredAt 30s 节流（多页面同时打开不叠加） |
| ⑤ 决策⑥推翻 | 350 决策⑥「server 不缓存、前端 lastGood 持有」→ server 全局 store 单一权威源 + SSE 推送（lastGood 语义由 server 侧「恒有最近成功值」接管，前端浏览器侧 lastGood 保留为断线/空窗兜底） |
| ⑥ 前端 5min 轮询删 | 两消费端额度轮询 interval 全删（SSE 替代）；use-squad-quota 其余三源（方案库/熔断/provider 元数据）低频轮询保留 |

## 实现核对（T1 server）

| 计划项 | 实现一致性 |
|---|---|
| QuotaStore（新 llm/quota-store.ts） | ✅ 内存 Map + lastSyncedAt；replaceAll 全量覆盖（含 error 项）；不持久化 |
| QuotaSyncService（新 llm/quota-sync-service.ts） | ✅ setInterval 5min（env 可配）+ 启动首轮 + inFlight + 30s 节流 + SIGTERM/SIGINT trap；syncOnce = collectQuotaSnapshots → store.replaceAll → SSE emit |
| collectQuotaSnapshots 提取 | ✅ 自 350 handler 提取导出纯函数（GET 旧逻辑与 syncOnce 两处共用零重复）；fetchedAt 统一本批时刻 |
| GET 语义变更 | ✅ 读 store 秒回 `{items, lastSyncedAt}`；空窗异步触发 triggerSync（不等待）+ 返回 `{items:[], lastSyncedAt:null}`；405 补 `{allow:'GET'}`（review Minor2） |
| POST /provider/quota/sync | ✅ 202 fire-and-forget：接受 `{syncing:true,lastTriggeredAt}`；拒绝 `{syncing:false,reason}`（inFlight/节流）；路由与 GET 同置 providerMatch 正则前；405 带 `{allow:'POST'}` |
| SSE provider_quota | ✅ 新 topic 广播组 `_all`（同 app_task）；llm/quota-events.ts 常量单一权威源；sse.ts ALLOWED_TOPICS + bootstrap-bus-phase registerTopic + sse-topic-whitelist.test.ts 三处同 commit；帧 `{data:{items,lastSyncedAt},timestamp:ISO}` |
| bootstrap 装配 | ✅ bootstrap-store-phase 可选尾参构造 + start + shutdown trap（registerTopic 先于 service.start）；registerTopic 先于 start |

## 实现核对（T2 web）

| 计划项 | 实现一致性 |
|---|---|
| use-provider-quota-store（新共享 hook） | ✅ 挂载 GET store 存量秒开 + POST sync fire-and-forget 不阻塞首屏 + SSE provider_quota/_all 帧到达 setState + lastGood 只记成功项 + 空 items/空窗保旧值兜底 + 订阅晚于卸载补偿回退 + enabled=false 零开销 |
| use-quota-polling 改造 | ✅ 数据源换共享 hook；5min 轮询 interval 删（server 后台同步替代）；30s tick 留；输出形状不变（footer 零改动） |
| use-squad-quota 改造 | ✅ quota 源换共享 hook；三源轮询保留；fetchProviderQuota 直调删；error 项 per-provider lastGood 降级；CardVM/Result 形状不变（modal 零改动） |
| api-client | ✅ fetchProviderQuota 返回加 lastSyncedAt + 新 syncProviderQuota POST 封装 |

## Review 结论

- **T1 CONDITIONAL PASS**（`87ac94238`）：6/6 面全过（store 全量覆盖/生命周期/端点语义/350 等价性/SSE 三处同 commit/越界排除）；Minor×2 直接修——bootstrap-store-phase 冗余双注释删旧留新 + GET 405 补 `{allow:'GET'}`。独立复跑定向 33/33 + tsc -b 0 + 全量 10865 passed。
- **T2 CONDITIONAL PASS**（`9c146cffb`）：6/6 面全过；2 竞态 Minor 直接修——① GET 空响应晚到无条件重置 lastSyncedAt=null（帧先到竞态混合态）→ null 不回退已有值；② enabled 翻转时 pending 订阅句柄泄漏 → effect 级 cancelled flag 补偿回收 + 帧守卫；配 2 竞态暴露回归用例。独立复跑定向 30/30 + tsc ×2 0 error + 全量 10878 passed（1 failed 归因既有 flaky，见下）。

## 验证

- **UT**：T1 33/33 + bootstrap/SSE 回归 49/49；T2 62/62（新 hook 11 用例 + footer 帧驱动 + squad-quota 四源回归）；全量 10878 passed + tsc -b 0 error（review 独立复跑）。
- **AT PASS**：`CASES=quota_store_sync`（真实调 API，30.1s）——GET store 秒回（空窗口径容忍）/ 首轮同步落 store（poll 烧穿启动空窗）/ POST sync 触发增量（poll 烧穿节流至 syncing:true + lastTriggeredAt）/ SSE provider_quota 帧到达（count ≥1）/ sync 后 store 快照复核（lastSyncedAt 非 null），6/6 step PASS。报告 `states/v0.0.363/verify/api-test/AT_report_quota_store_sync.md`。
- **ET 豁免**（无交互形态变化）。

## BUG 移交（跨版本非本版责任）

**BUG-SESSION-UNREAD-FLAKY（open，`9ee8a72c9`）**：session-unread CAS 幂等用例时敏 flaky，发现于 T2 review 全量复跑。证据链：干净 HEAD（stash 后）隔离复跑仍失败 + 该测试最后改动 = v0.0.27（T1/T2 零触）+ 时敏机制（bun 下 DB 写落库 >5 轮 microtask，断言时第二次 CAS 未完成）。纯测试稳定性问题，无产品行为缺陷。移交后续版本：修复建议（确定性等待 waitFor / expect.poll + 文件内 3 处同模式 flushMicrotasks 一并改造）见 `states/v0.0.363/bugs/BUG-SESSION-UNREAD-FLAKY-open.md`。

## 已知限制

- SSE 断线期间 store 更新不达——重连后下一轮 5min / 下次打开触发补齐（既有 SSE 全 topic 共性）。
- store 不持久化 → 重启空窗期（首轮 sync 前）两消费端空数据渲染（前端浏览器侧 lastGood 兜底）。

## 标准沉淀

- **额度数据单源范式**：server QuotaStore 权威源 + 周期后台同步 + SSE 推送 + 前端零轮询——后续额度类消费方一律走 `useProviderQuotaStore`，禁止自建轮询。
- **SSE 新 topic 三处同 commit**：sse.ts ALLOWED_TOPICS + bootstrap-bus-phase registerTopic + sse-topic-whitelist.test.ts（whitelist 测试 import 常量文件防漂移）。

## 关键文件

| 文件 | 变更 |
|---|---|
| `app/server/src/llm/quota-store.ts` / `quota-sync-service.ts` / `quota-events.ts` | 新增（store / 同步服务 / topic 常量） |
| `app/server/src/handlers/provider-quota.ts` | collectQuotaSnapshots 提取 + GET store 秒回 + POST sync handler |
| `app/server/src/routes/misc-routes.ts` | POST /provider/quota/sync 路由 |
| `app/server/src/{handlers/sse.ts, bootstrap-bus-phase.ts, bootstrap-store-phase.ts, bootstrap.ts}` | whitelist/装配（可选尾参保 UT 兼容） |
| `app/web/src/lib/api-client.ts` | fetchProviderQuota +lastSyncedAt + syncProviderQuota |
| `app/web/src/components/providers/use-provider-quota-store.ts` | 新增共享 hook |
| `app/web/src/components/providers/use-quota-polling.ts` / `chat-page/use-squad-quota.ts` | 换源改造（轮询删 / 三源保留） |
| 测试 | server 3 面 + web 2 面 + whitelist（+160 量级） |

## 文档同步（doc-modifier，本版本）

- **`specs/api/overall/02-llm-chat.md`**：1.8→1.9——§5.1 GET 行改 store 语义 + POST sync 新行；§5.6 重写（GET store 秒回 + lastSyncedAt + 空窗行为；QuotaSnapshot 形状不变注记）；新增 §5.6b SSE provider_quota + §5.6c POST sync 契约。
- **`specs/tech/version_logs/v0.0.350/change_log.md`**：追记「决策⑥演进」段——server 不缓存已被 v0.0.363 推翻。
- **`specs/prd/version_logs/v0.0.356-squad-quota-entry/change_log.md`**：追记 quota 源刷新语义演进注记。
- **`specs/ui/components/chat-page/use-squad-quota.md`**：刷新策略/四源/复用关系改 store+SSE 语义（quota 源换共享 hook）。
- **`specs/ui/components/providers/component-coding-plans-quota-footer.md`**：数据获取行 5min 轮询 → store+SSE。
- **`specs/ui/components/providers/_overview.md`**：数据源段加 provider_quota SSE 注记。
- use-provider-quota-store 无独立 spec 文件——职责/契约已在 change_log 本节 + api spec §5.6b/5.6c + 两个消费端 spec 描述；providers 目录无 hooks spec 惯例位（_conventions 分层为组件/hook 均有但本目录既有 hook 无 spec 先例），不新建单文件。
