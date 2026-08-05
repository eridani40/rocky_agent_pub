# Squad Token Stats 端点契约（v0.0.194 — 11a-squad-endpoints.md 姊妹文件）

> version: 1.0 · 引入版本 v0.0.194
> 管什么：v0.0.194 新增的 `GET /squad/:id/token-stats` 端点**完整契约**（query 参数 / 响应类型 / 口径 / 错误码 / 性能）。
> 不管什么：squad CRUD / member / charter / budget（→ `11a-squad-endpoints.md`）；UI 组件（→ `specs/ui/components/studio-page/component-token-stats-*.md`）。
> **本文件是 AT（API Test）token-stats 端点的唯一依据**：api-verifier 黑盒 curl，不读代码。
>
> **权威概念源**：`specs/tech/persistence/[P1]token_usage_stat.md`（SchemaDef + engine 选型）+ `specs/prd/version_logs/v0.0.194/prd.md`（产品口径 + 单位 + 缓存率公式）。

---

## 1. 端点总览

### 1.1 `GET /squad/:id/token-stats` — squad token 用量时序数据

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `GET` | `/squad/:id/token-stats` | 查 squad 团队/member 级 LLM token 用量时序数据（日历热力 / 时间轴堆积图 / scope × granularity 四象限） | 无（query 参数） | `200` + `TokenUsageQueryResult` |

---

## 2. Query 参数

| 参数 | 类型 | 缺省 | 必填 | 说明 |
|------|------|------|------|------|
| `from` | `YYYY-MM-DD` | `to` - 60 天 | 否 | 起始日期（含）；实际 SQL 走 `hour >= 'YYYY-MM-DD 00'` |
| `to` | `YYYY-MM-DD` | 今天（squad.timezone 本地） | 否 | 结束日期（含）；实际 SQL 走 `hour <= 'YYYY-MM-DD 23'` |
| `scope` | `'team'` \| memberId | `'team'` | 否 | 范围；`'team'`=Σ 全 member（含 leader+mate，WHERE squadId）；memberId=单个 member 过滤（AND memberId） |
| `granularity` | `'day'` \| `'hour'` | `'day'` | 否 | 粒度；`day`=GROUP BY substr(hour,1,10)（跨天日序列）；`hour`=GROUP BY hour（小时序列） |
| `providerId` | string | — | 否 | 可选 model 筛选（与 modelId 一起使用） |
| `modelId` | string | — | 否 | 可选 model 筛选（与 providerId 一起使用） |

**约束**：
- `from > to` 返回 400
- `from`/`to` 日期格式严格 `YYYY-MM-DD`（否则 400）
- `scope` 非 `'team'` 时必须是该 squad 已存在的 memberId（否则 404）
- `providerId` / `modelId` 必须同时提供或同时缺失（单独提供一个返 400）
- `granularity=hour` 允许跨天（不再限定同日），SQL GROUP BY hour 返回完整小时序列；**from/to 均有界时补零成范围内每天 0~23 点完整 24 点位**（无数据点位全字段 0；from/to 缺省不补零——范围无界无法生成序列）

---

## 3. 响应类型

### 3.1 `TokenUsageQueryResult`

```typescript
interface TokenUsageQueryResult {
  squadId: string;
  granularity: 'day' | 'hour';
  /** 'team' 或具体 memberId */
  scope: string;
  /** 'YYYY-MM-DD'（含） */
  from: string;
  /** 'YYYY-MM-DD'（含） */
  to: string;
  /** squad.timezone（IANA），日期分桶跟此时区；缺省进程本地 */
  timezone: string;
  /** 可选 model 筛选（前端控制条 model 下拉选中时回显） */
  providerId?: string;
  modelId?: string;
  /** 时间序列（按时间升序） */
  series: TokenUsageStatPoint[];
  /**
   * 当前 squad 在查询范围内**实际使用过**的 distinct model 列表（v0.0.194 补全）。
   * 从 token_usage_stat 数据派生（非 squad.modelDefault 配置）；供前端 model 筛选下拉。
   * 一次请求同时返回数据 + model 列表，省独立端点。
   * label：'__unknown__' → '未知模型'，否则 `${providerName} / ${modelId}`
   *   （handler 用 app_config providers.label 改写，含 disabled provider；
   *   provider 已删除等未命中 fallback `${providerId}/${modelId}`）。
   */
  availableModels: Array<{ providerId: string; modelId: string; label: string }>;
}
```

### 3.2 `TokenUsageStatPoint`

```typescript
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

---

## 4. 口径（MANDATORY）

### 4.1 团队口径（PRD §2.4）

- **team = Σ 全 member**（含 leader + mate，不能只取 leader）：SQL `WHERE squadId`（不 filter memberId）
- **subagent 已统计给 parent**：subagent session 无 memberId → subscriber 跳过不写；其 usage 通过 `accumulateUsage` 递归 'sub' 上报 parent member session.usage.sub → parent view.total 包含 → subscriber 写入 parent member 的 stat
- **mate 不统计给 leader**：mate 是同级成员，消耗归 mate 自己 session → stat 行

### 4.2 缓存率（PRD §2.2）

```
cacheRate = sum(cache_read) / (sum(cache_read) + sum(input_no_cache))
```

- 分母（即 sum(input_no_cache)）≤ 0 → 返 0
- 分子不含 cache_creation（写入缓存不算"命中"）
- 前端 ×100 显 %，1 位小数（去尾 0）

### 4.3 单位（PRD §2.2）

- token 数一律 **M**（÷1,000,000）—— 前端格式化（`<0.01M` 显 `<0.01M` 兜底；`<1M` 显 2 位小数；`<100M` 显 1 位小数；`≥100M` 显整数）
- server 返**原值**（input_no_cache / cache_read 等是原始 token 数），前端除以 1e6

### 4.4 时区（PRD §6 OUT OF SCOPE 时区配置 UI）

- 默认 `squad.timezone`（IANA，PRD §6 默认本地）
- 日期分桶按此时区（"今天"边界跟 squad.timezone）
- 时区切换 UI 归后续版本

---

## 5. 行为

### 5.1 数据来源

| 维度 | 数据源 | 触发 |
|------|--------|------|
| 新用量（增量） | `token_usage_stat` 表 | `notifyUsageChanged` 内 direct call `notifyTokenUsageSubscriber`（fire-and-forget `.catch(()=>{})` 错误隔离，PRD §2.5）—— 不走 bus 订阅（避免 double-count） |
| 存量历史（migration） | — | **不做**（用户核实无精确数据源：run.usage 实际没落、session.usage 无 per-call 时间分布）；token_usage_stat 从空表开始，仅统计上线后新数据 |

### 5.2 查询路径（raw SQL GROUP BY SUM，读写分离）

所有查询走 SQLite `GROUP BY` + `SUM` 聚合，由 `TokenUsageAggregator` 通过注入的 `SqlDriver` 执行（绕过 CrudStore.query，因契约不支持 GROUP BY）。**blob-first 约束**：SqliteCrudStore 整条 record 序列化为 `data` JSON blob 列，SQL 里所有业务字段必须走 `json_extract(data,'$.field')`，bare column 引用必失败。

```sql
SELECT
  <substr(json_extract(data,'$.hour'),1,10) | json_extract(data,'$.hour')> AS bucket,
  SUM(json_extract(data,'$.input_no_cache')), SUM(json_extract(data,'$.cache_read')), SUM(json_extract(data,'$.cache_creation')),
  SUM(json_extract(data,'$.output_response')), SUM(json_extract(data,'$.output_reasoning')),
  SUM(json_extract(data,'$.cost')), SUM(json_extract(data,'$.llmCallCount'))
FROM token_usage_stat
WHERE json_extract(data, '$.squadId') = ?
  AND json_extract(data, '$.hour') >= ? AND json_extract(data, '$.hour') <= ?
  [AND json_extract(data, '$.memberId') = ?]            -- scope=memberId
  [AND json_extract(data, '$.providerId') = ?
   AND json_extract(data, '$.modelId') = ?]             -- optional model filter
GROUP BY bucket
ORDER BY bucket ASC;
```

| granularity | GROUP BY | 说明 |
|---|---|---|
| `day` | `substr(json_extract(data,'$.hour'),1,10)` | 跨天日序列（hour 前 10 字符 = YYYY-MM-DD） |
| `hour` | `json_extract(data,'$.hour')` | 完整小时序列（YYYY-MM-DD HH），支持跨天范围 |

| scope | WHERE | 说明 |
|---|---|---|
| `team` | `json_extract(data,'$.squadId') = ?` | Σ 全 member（不 filter memberId） |
| `memberId` | `json_extract(data,'$.squadId') = ? AND json_extract(data,'$.memberId') = ?` | 单 member 过滤 |

### 5.3 性能（PRD §7）

- 查询响应 <500ms（SQLite 原生聚合 + json_extract 过滤，单 squad 几千行级别）
- model 筛选：额外 AND providerId+modelId（前端控制条 model 下拉切换）
- 派生字段（total / cacheRate）在 aggregator 视图层算，不冗余存

---

## 6. 错误码

| 状态 | 原因 | 响应体 |
|------|------|--------|
| `200` | 成功 | `TokenUsageQueryResult` |
| `400` | query 参数非法（granularity=hour 跨天 / from>to / scope 非法值 / 日期格式错） | `{ error: string, detail?: string }` |
| `404` | squad 不存在 / scope memberId 不属于该 squad | `{ error: 'squad not found' \| 'member not in squad' }` |
| `405` | 非 GET 方法 | `{ error: 'Method Not Allowed' }`，响应头 `Allow: GET` |
| `500` | aggregator 内部错误（fs 读取失败、squad timezone 异常等） | `{ error: string, detail?: string }` |

---

## 7. AT 测试范围

按用户铁律「普通 feature 不新增持久 AT case」（CLAUDE.md 持久化测试用例库 §核心冒烟集），本端点是**确定性 HTTP 契约**（GET 查询无 LLM 不确定性）→ **UT 覆盖**，**不进 AT 库**。

UT 覆盖点（coder 白盒）：
- `TokenUsageStatStore.upsertDelta`：read-modify-write 累加 + 分片隔离 + (memberId,date) 唯一约定
- `TokenUsageAggregator.query`：**raw SQL GROUP BY SUM** via SqlDriver —— scope 切换（team WHERE squadId / memberId 加 AND memberId）+ granularity 切换（day GROUP BY substr(hour,1,10) / hour GROUP BY hour）+ 可选 model 筛选（AND providerId+modelId）+ cacheRate 视图层派生 + timezone 分桶
- `TokenUsageSubscriber.onEvent`：delta 计算（lastSeen 差值）+ 首次见记 0 + subagent session 跳过 + fire-and-forget 错误隔离
