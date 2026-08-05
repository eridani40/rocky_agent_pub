---
type: spec
title: token_usage_stat 时序表（squad token 用量统计）
priority: P1
status: active
updated: 2026-07-23
since: v0.0.194
---

# token_usage_stat 时序表（squad token 用量统计）

## 1. 概述

**管什么**：squad 维度的 LLM token 用量细粒度时序记录——按 `(sessionId, hour, providerId, modelId)` 粒度累加 delta，查询走 GROUP BY SUM 聚合（不在运行时重算 transcript）。
**不管什么**：单次 LLM 调用 raw usage（→ 流式 UsageBlock，不持久化）、session 级累计（→ `SessionSchema.usage` 三分区）。

定位：**细粒度时序记录层 + 异步聚合查询层**，非采集层。采集链路（`accumulateUsage`/`persistUsage`/`notifyUsageChanged`）不动，统计挂同款 `ReplayableEventBus` 异步消费。

## 2. 设计决策

### 2.1 engine = 'sqlite'（经 CrudStore，用户裁决）

**结论**：token_usage_stat 用 SQLite engine 落 SQLite 表，**必须经 CrudStore/SchemaDef**（用户原话「用我们的 schema store 存储体系」），不能旁路单独走 SQL 写入。
**理由**：
- 用户明确裁决（v0.0.194 架构期）：坚持 SQLite engine，不走 FsCrudStore
- SQLite engine 的 GROUP BY SUM 聚合能力适合细粒度时序 + 多维聚合查询
- CrudStore 体系统一：写入路径走 CrudStore.put（sqlite engine 同步语义；详见 §2.6/§4）；聚合查询走 engine 专有 raw SQL（read path 例外，见 §2.6）
**扶正前置**：SQLite engine 原本是实验态（`SqliteCrudStore` 顶层 import `bun:sqlite`，packaged 不可用），v0.0.194 同步扶正——见 `[P0]sqlite_engine_packaged_promotion.md`。

### 2.2 粒度 = (sessionId, hour, providerId, modelId)（细粒度累加，非天级预聚合）

**结论**：每行 = 一个 `(sessionId, hour, providerId, modelId)` 组合的 delta 累加；同 session+hour+model 多次 event delta 累加到同一行。
**理由**：
- **解决 hour 数据源问题**：v2 设计 granularity=hour 从 RunSchema 临时聚合，但 run.usage 实际没写（用户实测）→ 无数据。本设计 subscriber 直接从 event 拿 delta 按 hour 桶写入，绕过 run，hour 有数据
- 细粒度存储 + GROUP BY SUM 聚合，支持多维切片（team/member × day/hour × model 筛选）单一数据源
- model 维度独立 → 前端可按 model 筛选呈现
**反例**：天级预聚合（member × date）失去 hour 分布 + model 维度，且 v2 hour fallback 无数据。

### 2.3 字段对齐 Usage 细分（snake_case，方便 SQL 聚合）

**结论**：存细分 token 字段（非聚合 inputTokens/outputTokens）；字段名 snake_case 对齐 `Usage` 类型（`message/types.ts:227`）：`input_no_cache / cache_read / cache_creation / output_response / output_reasoning / cost / llmCallCount`。
**理由**：
- 细分存储支持缓存率口径精确计算（cacheRate = cache_read / (cache_read + input_no_cache)）
- snake_case 命名让 SQL `SUM(input_no_cache)` 可读 + 与 Usage 字段对齐便于 delta 累加（subscriber 按 Usage 字段 key 累加）
- 派生字段（totalTokens = sum 各字段、cacheRate）在 aggregator 视图层算，不冗余存
**反例**：聚合存（inputTokens/outputTokens）失去细分；衍生字段冗余存易双源漂移。

### 2.4 冗余存 squadId/memberId（方便 GROUP BY，不靠 join）

**结论**：每行冗余存 `squadId/memberId`（从 session 带入），不靠 join session 表。
**理由**：
- SQLite GROUP BY WHERE squadId/memberId 直接走 json_extract，不需要 join session 表
- session 可能被删（squad dissolve）→ join 会丢历史 stat；冗余存保证历史完整
- 写入时从 SessionSchema 读一次 squadId/memberId（subscriber 本就要查 session），零额外查询成本
**反例**：若不冗余，每次聚合查询要 JOIN session 表，且 session 删除后历史 stat 失关联。

### 2.5 id 主键约定：`(sessionId, hour, providerId, modelId)` 唯一 ULID

**结论**：stat 表主键 `id` 是 ULID（业务生成，schema 强制），调用方约定同一 `(sessionId, hour, providerId, modelId)` 对应**同一 id**（query-then-put 拿到既有 id 后复用，不存在则生成新 ULID）。
**理由**：
- SchemaDef 契约：`id` 必为 ULID（schema_interface §3.2），不允许复合主键
- 累加语义需要 (sessionId, hour, providerId, modelId) 唯一：read-modify-write 时若每次生成新 ULID 会产生重复行
- 实现侧：`TokenUsageStatStore.upsertDelta` 内部先 `queryByJsonExtract` 四个维度（或组合 raw SQL 查询）→ 有则复用 put，无则生成新 ULID put

### 2.6 读写分离：写入走 CrudStore（sync put,sqlite engine）/ 聚合查询走 raw SQL（read path 例外）

**结论**：
- **写入路径**（subscriber upsertDelta）走 `CrudStore.put`（sync）—— sqlite engine 同步语义,`CompositeStore.putAsync` 对 sqlite engine 退化为 `Promise.resolve(sync put)`（SqliteCrudStore 无 putAsync 方法,fs_crud_store_engine §5.3 的串行化是 FS engine 专属,sqlite ACID 由事务 + WAL 保证）；保持 schema store 体系统一（SchemaDef 校验 + 信封）
- **聚合查询路径**（aggregator GROUP BY SUM）走 **engine 专有 raw SQL**（绕过 CrudStore.query，因其契约不支持 GROUP BY 聚合）

**理由**：
- CrudStore 契约（crud_store_interface §2.3）只承诺主键集合 + 时间范围 + 排序 + limit，**不承诺 GROUP BY/SUM**
- aggregator 需要 `SELECT substr(hour,1,10), SUM(input_no_cache), ... GROUP BY` 跨多字段聚合，超出 CrudStore 契约
- 写入仍守 CrudStore 体系（SchemaDef 校验 + 信封 + 串行化），不破坏体系统一
- read path 例外是合理的：analytical 聚合查询天然不是 entity CRUD 的一部分
**实现**：`TokenUsageAggregator` 接收 `SqlDriver`（与 SqliteCrudStore 共享同一实例，bootstrap 注入），通过 `driver.prepare<Row>(sql).all(...params)` 执行 GROUP BY 查询。
**反例**：若强行用 CrudStore.queryByJsonExtract 拉全表后 in-memory 聚合，数据量大（几千行 × 多次 json_extract）性能差；raw SQL 走 SQLite 原生聚合高效。

### 2.7 SQLite engine 不分片（shardKeyField 当普通列）

**结论**：SchemaDef 不配 fs.sharding（token_usage_stat 是 sqlite engine，分片无意义）；squadId 是普通业务字段（进 data blob），查询走 `json_extract(data, '$.squadId')`。
**理由**：
- spec schema_interface §3.5：SQLite engine 忽略 sharding
- token_usage_stat 是跨 squad 全局时序表（不像 member/board 按 squadId 物理分区），所有 squad 共享一张表
- 查询 WHERE squadId 过滤即可（单 squad 数据量小）

## 3. SchemaDef

```typescript
import type { SchemaDef } from '../../persistence/schema-types';

const TokenUsageStatSchema = {
  entity: 'token_usage_stat',
  engine: 'sqlite',          // §2.1：经 CrudStore sqlite engine（扶正后 packaged 可用）
  // §2.7：不配 fs.sharding（sqlite engine 不分片）
  fields: {
    // ── 维度（PK 组成 + GROUP BY key）──
    id:                 { type: 'ulid', required: true },    // §2.5：(sessionId,hour,providerId,modelId) 唯一约定
    squadId:            { type: 'ulid', required: true },    // §2.4：冗余存（方便 GROUP BY WHERE squadId）
    memberId:           { type: 'ulid', required: true },    // §2.4：冗余存（方便 GROUP BY WHERE memberId）
    sessionId:          { type: 'ulid', required: true },    // 维度（PK 组成）
    hour:               { type: 'string', required: true },  // 'YYYY-MM-DD HH'（squad.timezone 本地小时桶，字典序可排序+可 substr 派生 date）
    providerId:         { type: 'string', required: true },  // 维度（PK 组成）；'__unknown__' 兜底
    modelId:            { type: 'string', required: true },  // 维度（PK 组成）；'__unknown__' 兜底
    // ── 细分 token（跟 Usage 字段 snake_case 对齐，§2.3）──
    input_no_cache:     { type: 'number', required: true },  // 未缓存输入 token
    cache_read:         { type: 'number', required: true },  // 缓存命中（cache_read_input_tokens）
    cache_creation:     { type: 'number', required: true },  // 缓存写入（cache_creation_input_tokens）
    output_response:    { type: 'number', required: true },  // 实际回复 token
    output_reasoning:   { type: 'number', required: true },  // 思维链 token
    cost:               { type: 'number', required: true },  // 原币种金额
    llmCallCount:       { type: 'number', required: true },  // LLM 调用次数
  },
  // v1 indexes 仅信封字段（schema_interface §3.4）；业务字段聚合靠 raw SQL json_extract
} as const satisfies SchemaDef;
```

## 4. 写入路径（subscriber ← direct call → CrudStore.put）

```
LLM 调用 → accumulateUsage(current) → session.usage.current += usage
                                       ↓ (write/notify 分离,spec session_usage §6)
                                  notifyUsageChanged → emit SessionUsageUpdateEvent (data = SessionUsageView)
                                                       ↓ (v0.0.194 direct call,非 bus 订阅)
                                            notifyTokenUsageSubscriber(sid, view, evt.createdAt)
                                                       ↓ 1. 查 SessionSchema(ssid) 拿 squadId/memberId/providerId/modelId
                                                       ↓ 2. subagent (无 memberId) 跳过
                                                       ↓ 3. model 解析:session.providerId/modelId ?? squad.modelDefault/modelDefaultProviderId ?? '__unknown__'
                                                       ↓ 4. hour = format(event.createdAt, squad.timezone, 'YYYY-MM-DD HH')
                                                       ↓ 5. delta = per-field diff(view.total, lastSeen[ssid])(首见记 0)
                                                       ↓ 6. upsert (sessionId,hour,providerId,modelId) += delta → CrudStore.put (sync)
                                            crud.sqlite > token_usage_stat 表
```

**投递机制 = direct call(非 bus 订阅)**:
- `session-store-usage-impl.ts:147` 在 `notifyUsageChanged` 内 `notifyTokenUsageSubscriber(...).catch(()=>{})` fire-and-forget —— 与 bus 订阅语义等价但更简洁(无 bus 生命周期 + 无订阅时序竞态),且避免 bus 订阅 + direct call 同用 double-count
- `token-usage-subscriber.ts` 全文无 `.subscribe(` —— 模块级 holder `setTokenUsageSubscriberDeps(deps)` 注入(bootstrap 装配后调一次),`notifyTokenUsageSubscriber` 是唯一入口
- 错误隔离在调用点显式 `.catch(()=>{})` —— 统计异常不崩主对话(PRD P10)

**关键不变量**:
- 写入失败不阻塞主流程(fire-and-forget + try/catch + 调用点 catch,PRD §2.5)
- subagent session(无 memberId / parentSessionId 非空)跳过(usage 已通过 accumulate 递归 'sub' 上报 parent session.usage.sub)
- **首次见记 0**(不灌历史累计);重启后 lastSeen 清空 → 下次 event 把当前 view.total 当 delta 全量记一次(时间分布失真但总量准确,PRD §2.6 兜底)
- **model 解析三级 fallback**:session 显式选 → squad 默认 → `__unknown__` 兜底(防御性,理论不应到这)
- delta 按 Usage 字段 key 计算(input_no_cache/cache_read/.../llmCallCount per-field diff)

**写入走 sync CrudStore.put(非 putAsync)**:
- sqlite engine 是同步语义,`CompositeStore.putAsync` 对 sqlite engine 退化为 `Promise.resolve(sync put)`(因 SqliteCrudStore 无 putAsync 方法);sqlite ACID 由 SQLite 事务 + WAL 保证,不需应用层串行化(fs_crud_store_engine §5.3 的 putAsync 串行化是 FS engine 专属)

## 5. 查询路径（aggregator → raw SQL GROUP BY SUM）

```
GET /squad/:id/token-stats?granularity=day|hour&scope=team|memberId&providerId&modelId&from&to
  ↓
TokenUsageAggregator.query(squadId, opts) → 执行 GROUP BY SQL via SqlDriver
  ↓
SELECT
  <substr(json_extract(data,'$.hour'),1,10) | json_extract(data,'$.hour')> AS bucket,
  SUM(json_extract(data,'$.input_no_cache')) AS input_no_cache,
  SUM(json_extract(data,'$.cache_read')) AS cache_read,
  SUM(json_extract(data,'$.cache_creation')) AS cache_creation,
  SUM(json_extract(data,'$.output_response')) AS output_response,
  SUM(json_extract(data,'$.output_reasoning')) AS output_reasoning,
  SUM(json_extract(data,'$.cost')) AS cost,
  SUM(json_extract(data,'$.llmCallCount')) AS llmCallCount
FROM token_usage_stat
WHERE json_extract(data, '$.squadId') = ?
  AND json_extract(data, '$.hour') >= ? AND json_extract(data, '$.hour') <= ?
  [AND json_extract(data, '$.memberId') = ?]            -- scope=memberId
  [AND json_extract(data, '$.providerId') = ?
   AND json_extract(data, '$.modelId') = ?]             -- optional model filter
GROUP BY bucket
ORDER BY bucket ASC;
  ↓
后处理：派生 totalTokens = sum 各 token 字段；cacheRate = cache_read / (cache_read + input_no_cache)
  ↓
granularity=hour 且 from/to 均有界 → zeroFillHours 补零成范围内每天 0~23 点完整 24 点位
（无数据点位全字段 0；纯字符串日期数学不涉运行时区；day 粒度不补零；from/to 缺省不补零）
  ↓
TokenUsageQueryResult { series: [{date/hour, input_no_cache, cache_read, ..., total, cacheRate}], availableModels? }
```

**blob-first 约束（MANDATORY）**：`SqliteCrudStore` 是 blob-first 存储（整条 record 序列化为 `data` JSON blob 列，信封字段 id/createdAt/updatedAt/version 另列）—— SQL 里所有业务字段（含 hour/squadId/memberId + SUM 聚合字段）**必须走 `json_extract(data,'$.field')`**，bare column 引用必失败（无 `hour` / `input_no_cache` 列）。

**口径**（PRD §2.2 + §2.4）：
- `total = input_no_cache + cache_read + cache_creation + output_response + output_reasoning`（派生）
- `cacheRate = cache_read / (cache_read + input_no_cache)`，分母 ≤0 时显 0%
- team = Σ 全 member（`WHERE squadId`，不 filter memberId；subagent 不单独统计，已隐含在 parent member）
- granularity=day: `GROUP BY substr(json_extract(data,'$.hour'), 1, 10)`（hour 前 10 字符 = YYYY-MM-DD）
- granularity=hour: `GROUP BY json_extract(data,'$.hour')`
- model 筛选：`WHERE providerId + modelId`（前端控制条 model 下拉，可选）

**distinct model 列表**（前端 model 下拉数据源）：

```sql
SELECT DISTINCT
  IFNULL(json_extract(data, '$.providerId'), '__unknown__') AS providerId,
  IFNULL(json_extract(data, '$.modelId'), '__unknown__') AS modelId
FROM token_usage_stat
WHERE json_extract(data, '$.squadId') = ?
  [AND json_extract(data, '$.hour') >= ? AND json_extract(data, '$.hour') <= ?]
ORDER BY providerId ASC, modelId ASC;
```

- 从 token_usage_stat 数据派生（**非 squad.modelDefault 配置**）—— 用户真正使用过的 distinct (providerId, modelId) 组合
- `IFNULL(..., '__unknown__')` 兜底：subscriber model 三级 fallback 终站 = `__unknown__`，但历史/异常数据可能 NULL，统一归入 `__unknown__`
- label 派生：`__unknown__` →「未知模型」，否则 `${providerId}/${modelId}`（aggregator 层 fallback）；**handler 层用 app_config providers.label 改写为 `${providerName} / ${modelId}`**（含 disabled provider——历史统计可能引用已停用 provider；`_deleted` 墓碑跳过；未命中保持 fallback）
- 合并进 `TokenUsageQueryResult.availableModels?` optional 字段（一次请求拿数据 + model 列表，省独立端点）；既有 `query` / `derivePoint` 不动，纯增量方法 `queryDistinctModels`

## 6. 历史 migration（不做 — 用户核实无精确数据源，最终决策）

**决策**：不做 migration，token_usage_stat 从空表开始，subscriber 从上线后统计新数据。

**真相查证**（用户实测 + 代码确认）：
- `persistUsage`（session-store-usage-impl.ts:188）只有 `runUsage` 传入才写 `run.usage`，用户实测 run JSON **无 usage 字段** → 实际没落（调用没传 runUsage），run.usage 无数据
- usage 流式 emit（UsageBlock），但 message/transcript **不持久化**（前端不渲染，过滤）
- session.usage 只有累计总量（三分区），**无 per-call 时间分布 + 无 model 维度**

→ migration（遍历 run 复原）**无精确数据源** → 不做。

## 7. 边界

| 零件 | 归属 |
|------|------|
| SchemaDef + engine='sqlite' + 细粒度 (sessionId,hour,model) 粒度 + 字段对齐 Usage + 冗余存 squadId/memberId + 读写分离 + SQLite 不分片 | 本文件 ✅ |
| CrudStore sqlite engine 扶正（SqlDriver 复用 + packaged 接入 + 验证） | `[P0]sqlite_engine_packaged_promotion.md` |
| CrudStore 契约、信封字段、InferRecord | `[P0]schema_interface.md` / `[P0]crud_store_interface.md` / `[P0]sqlite_crud_store_engine.md` |
| Usage 类型（input_no_cache 等字段语义） | `app/server/src/message/types.ts:227` + `specs/tech/agent/session/[P0]session_usage.md` |
| 团队口径、缓存率公式、单位 M、model 筛选维度 | `specs/prd/version_logs/v0.0.194/prd.md §2.2/§2.4` |
| 异步事件订阅、写入失败不阻塞主流程 | `specs/tech/agent/event/[P0]event_bus.md` + PRD §2.5 |

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)。
