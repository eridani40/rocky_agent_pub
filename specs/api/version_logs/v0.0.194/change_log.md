# v0.0.194 API 变更日志 — squad token 用量统计端点

> 范围：新增 1 个查询端点 `GET /squad/:id/token-stats`（时序聚合数据，支撑日历热力 + 时间轴堆积图双视图）。
> 父契约：`specs/api/overall/11c-token-stats.md`（本版新建，承载完整端点契约）。
> PRD 来源：`specs/prd/version_logs/v0.0.194/prd.md §2.1-§2.5`。
> 概念权威源：`specs/tech/persistence/[P1]token_usage_stat.md`（SchemaDef + engine 选型 + 口径）。

---

## 1. 端点变更总览

| # | 方法 | 路径 | 状态 | 用途 |
|---|---|---|---|---|
| 1 | `GET` | `/squad/:id/token-stats` | **新增** | 查 squad token 用量时序聚合数据（日历热力 / 时间轴堆积图 / scope=team\|member × granularity=day\|hour） |

---

## 2. `GET /squad/:id/token-stats`（新增）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `GET` | `/squad/:id/token-stats` | 查 squad 团队/member 级 LLM token 用量时序数据，支撑日历热力 + 时间轴堆积图双视图 | 无（query 参数） | `200` + `TokenUsageQueryResult` |

### 2.1 Query 参数

| 参数 | 类型 | 缺省 | 说明 |
|------|------|------|------|
| `from` | `YYYY-MM-DD` | 近 60 天 | 起始日期（含）；实际 SQL `hour >= 'YYYY-MM-DD 00'` |
| `to` | `YYYY-MM-DD` | 今天 | 结束日期（含）；实际 SQL `hour <= 'YYYY-MM-DD 23'` |
| `scope` | `'team'` \| `memberId` | `'team'` | 范围；`team` = Σ 全 member（含 leader + mate，WHERE squadId），`memberId` = 单个 member（AND memberId） |
| `granularity` | `'day'` \| `'hour'` | `'day'` | 粒度；`day` = GROUP BY substr(hour,1,10)；`hour` = GROUP BY hour（支持跨天） |
| `providerId` | string | — | 可选 model 筛选（与 modelId 一起使用） |
| `modelId` | string | — | 可选 model 筛选（与 providerId 一起使用） |

**约束**：
- `scope` 值非 `'team'` 时必须是该 squad 已存在的 memberId（否则 404）
- `from > to` 返回 400
- `providerId` / `modelId` 必须同时提供或同时缺失（单独提供一个返 400）

### 2.2 成功响应（`TokenUsageQueryResult`）

```typescript
interface TokenUsageQueryResult {
  squadId: string;
  granularity: 'day' | 'hour';
  /** 范围；'team' 或具体 memberId */
  scope: string;
  /** 'YYYY-MM-DD'（含） */
  from: string;
  /** 'YYYY-MM-DD'（含） */
  to: string;
  /** squad.timezone（IANA），日期分桶跟此时区 */
  timezone: string;
  /** 时间序列（按时间升序） */
  series: TokenUsageStatPoint[];
}

interface TokenUsageStatPoint {
  /**
   * 时间桶 key：
   *   - granularity=day：'YYYY-MM-DD'（substr(hour,1,10)）
   *   - granularity=hour：'YYYY-MM-DD HH'
   */
  bucket: string;
  /** 未缓存输入 token（input_no_cache Σ） */
  input_no_cache: number;
  /** 缓存命中 token（cache_read Σ） */
  cache_read: number;
  /** 缓存写入 token（cache_creation Σ） */
  cache_creation: number;
  /** 实际回复 token（output_response Σ） */
  output_response: number;
  /** 思维链 token（output_reasoning Σ） */
  output_reasoning: number;
  /** 原币种金额（cost Σ） */
  cost: number;
  /** LLM 调用次数（llmCallCount Σ） */
  llmCallCount: number;
  /** 总 token = input_no_cache + cache_read + cache_creation + output_response + output_reasoning（派生） */
  total: number;
  /** 缓存率 [0,1]：cache_read / (cache_read + input_no_cache)，分母 ≤0 时返 0；前端 ×100 显 % */
  cacheRate: number;
}
```

### 2.3 行为

- **scope=team**：SQL `WHERE squadId`（不 filter memberId，Σ 全 member 含 leader+mate）
- **scope=memberId**：SQL 加 `AND memberId = ?`
- **granularity=day**：`GROUP BY substr(hour,1,10)` → 跨天日序列
- **granularity=hour**：`GROUP BY hour` → 小时序列（支持跨天）
- **model 筛选**（可选）：SQL 加 `AND providerId = ? AND modelId = ?`
- **聚合查询走 raw SQL**（绕过 CrudStore.query，其契约不支持 GROUP BY SUM；读写分离见 `[P1]token_usage_stat.md §2.6`）—— aggregator 通过注入的 SqlDriver 执行
- **派生字段**（aggregator 视图层算）：`total = input_no_cache + cache_read + cache_creation + output_response + output_reasoning`；`cacheRate = cache_read / (cache_read + input_no_cache)`
- **timezone**：hour 桶按 `squad.timezone`（IANA，默认进程本地）本地日历日截断

### 2.4 缓存率口径（PRD §2.2 MANDATORY）

```
cacheRate = sum(cache_read) / (sum(cache_read) + sum(input_no_cache))
```

- 分母 ≤0（无 input 或异常）→ 返 0
- 分子不含 cacheCreation（写入缓存不算"命中"）
- 前端 ×100 显 %，1 位小数（去尾 0）

### 2.5 单位（PRD §2.2）

- token 数一律 **M**（÷1,000,000）—— 前端格式化，server 返原值
- `<0.01M` 显 `<0.01M` 兜底（前端）

### 2.6 错误

| 状态 | 原因 |
|------|------|
| `400` | query 参数非法（granularity=hour 跨天 / from>to / scope 非法值） |
| `404` | squad 不存在 / scope 指定 memberId 不属于该 squad |
| `405` | 非 GET 方法（响应头 `Allow: GET`） |
| `500` | aggregator 内部错误（squad 配置异常、fs 读取失败等） |

### 2.7 性能（PRD §7）

- 查询响应 <500ms（时序表已聚合，不在运行时重算 transcript）
- day 粒度：1 次 fs read（shardKey=squadId，全 stat 记录）+ in-memory filter/Σ
- hour 粒度：SQLite GROUP BY hour（原生聚合，单 squad 几千行级别，<200ms）

### 2.8 数据来源

- **新用量**：异步事件（`TokenUsageSubscriber` 订阅 `SessionUsageUpdateEvent` → `TokenUsageStatStore.upsertDelta` fire-and-forget）—— 采集链路不动（accumulate/notifyUsageChanged 不变），挂同款 `ReplayableEventBus`
- **存量历史（migration 不做 — 用户核实无精确数据源，最终决策）**：`persistUsage`（session-store-usage-impl.ts:188）只有 `runUsage` 传入才写 `run.usage`，用户实测 run JSON 无 usage 字段 → 实际没落；usage 流式 emit UsageBlock 但 message/transcript 不持久化（前端不渲染过滤）；session.usage 只有累计总量（三分区）无 per-call 时间分布 → migration 遍历 run 复原**无精确数据源** → **不做**。token_usage_stat 从空表开始，subscriber 从上线后统计新数据（首见记 0，避免把历史累计一次性写入）
- **存储 engine**：SQLite（`schema.engine='sqlite'`，用户裁决）—— 经 CrudStore/SchemaDef 体系；SQLite engine 扶正（packaged 可用）见 `specs/tech/persistence/[P0]sqlite_engine_packaged_promotion.md`

---

## 3. spec 同步

- `specs/api/overall/11c-token-stats.md`：新建（父契约，承载完整端点表 + TokenUsageQueryResult/Point 类型 + 口径）
- `specs/api/overall/11a-squad-endpoints.md`：§1.4 PATCH /squad 或新 §6 加引用（由 doc-modifier 阶段 5 同步）
- `specs/tech/persistence/[P0]sqlite_engine_packaged_promotion.md`：新建（CrudStore sqlite engine 扶正设计 + SqlDriver 复用 + packaged 接入 + 验证 + 回退预案）
- `specs/tech/persistence/[P1]token_usage_stat.md`：新建（SchemaDef engine='sqlite' + 写入/查询路径 + §6 migration 不做的真相查证）
- `specs/tech/persistence/index.md`：导航表加 sqlite_engine_packaged（P0）+ token_usage_stat（P1）两行（已同步）
- `specs/tech/persistence/log.md`：加 v0.0.194 块（已同步）
