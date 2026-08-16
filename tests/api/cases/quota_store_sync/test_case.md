# quota_store_sync — v0.0.363 全局额度 store + 同步 + SSE（临时 case，不入持久冒烟集）

- **版本**：v0.0.363 quota-global-sync（T1 契约面）
- **权威**：specs/tech/version_logs/v0.0.363/change_plan.md §1.3/§1.4 + specs/api/overall/02-llm-chat.md §5.6（QuotaSnapshot 形状 350 契约不变）
- **性质**：版本白名单临时 case（module=cases）；普通 feature 不入持久集

## 覆盖契约

| 面 | 契约 | 断言 |
|---|---|---|
| GET /provider/quota 秒回 | §1.3 读 store 立即返回 | A 步 `.items exists`（空窗容忍）；D 步 `.lastSyncedAt exists`（同步后非 null） |
| 启动空窗口径 | §1.3 store 空 → {items:[], lastSyncedAt:null} | A 步不断言非空（null 拒 exists 语义恰好分离两态）；B1 poll `.items[0] exists` 烧穿 |
| POST /provider/quota/sync | §1.3 202 fire-and-forget | B2 poll until `.syncing == true` + `.lastTriggeredAt exists`；节流分支 {syncing:false,reason} 不作主路径 |
| SSE provider_quota | §1.4 topic + group _all 广播 | C 步 `q.count(topic=provider_quota,group=_all) >= 1`（先订阅后触发，帧必达） |

## 设计要点

1. **先订阅后触发（step1）**：SSE 竞态防御；provider_quota 是全局广播（_all），无 session 依赖
2. **B2 节流烧穿**：30s lastTriggeredAt 节流使单次 POST 可能返 {syncing:false,reason}——poll 每 2s 重触发直至 syncing:true，确定性覆盖触发分支
3. **B1 空窗烧穿**：test 池 3 个 enabled native provider（kimi/deepseek/minimax）+「错误 item 也进 store」→ 首轮后 items 确定性非空
4. **帧内容形状断言的分层**：wait 谓词仅 k=v 精确匹配（无法断 ISO 时间戳/嵌套 data.items）→ 帧形状 {data:{items,lastSyncedAt},timestamp} 归 UT（sync-service emit）+ D 步 GET 同源对照（emit 在 store.set 后，帧到达 ⇒ store 已写）
5. **耗时口径**：GET 秒回 vs sync 慢路径（~15s）由 wait/poll timeout 区分承载；毫秒级度量无 DSL 原语，归 UT/ET

## 前置依赖

- test env provider 池：3 个 enabled native coding plan（kimi 01M01K7GX…/deepseek 01M01K965…/minimax 01M01KAPB…，et352）——env_start.sh 全局池 symlink，恒有
- 无需建 session/squad/provider（纯契约面）
