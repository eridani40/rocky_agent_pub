# 模型路由降级方案调研（cc-switch + 业界方案）2026-08-14

> 目标：为 rocky_agent「模型路由降级逻辑」提供业界事实基础，供 prd 设计配置方案/概念/路由规则。
> 依据：cc-switch 源码（GitHub farion1231/cc-switch，克隆于 2026-08-14）+ 官方文档 + 老板截图（images/image-01KZZ0WCE2V08APYE9DTG0WB4G.png / image-01KZZ0XHWFS0Q7R27VAPW3YFC7.png）。
> 结论分层：**确定 / 高置信 / 待证**。所有源码引用标注 `{文件}:{行}`。

## 1. cc-switch 机制拆解

cc-switch 是 Tauri 桌面工具（Rust 后端 + React 前端），核心是**本地代理 + 供应商故障转移**：接管 Claude Code/Codex 等 CLI 的 API 请求，按队列顺序试供应商。

### 1.1 降级链（failover queue）— 确定

- 数据结构：`providers` 表（`src-tauri/src/database/schema.rs:27`），字段：`id, app_type, name, settings_config, website_url, category, created_at, sort_index, notes, icon, icon_color, meta, is_current, in_failover_queue`。
  - **`sort_index`** = 首页供应商排序（P1/P2/P3…标签）；**`in_failover_queue`** = 是否进降级队列；**`notes`** = 备注（截图「Kimi 周二凌晨恢复」即此字段，**非自动调度**，见 1.4）。
- 路由选择：`ProviderRouter::select_providers()`（`src-tauri/src/proxy/provider_router.rs:37`）：
  - 故障转移开 → 按 `get_failover_queue()` 顺序（与前端展示一致的 sort_index 序）逐个检查熔断器 `is_available()`，可用才进候选列表（P1→P2→…→Pn）。
  - 故障转移关 → 只用当前供应商（`is_current`），**跳过熔断器**。
  - 全部熔断 → 返回 `AllProvidersCircuitOpen` 错误。
- 请求级尝试：`forward_with_retry_inner()`（`src-tauri/src/proxy/forwarder.rs:387`）：
  - **`max_attempts = max_retries + 1`**（`forwarder.rs:219`，默认 max_retries=3 → 最多试 4 家）；循环内先 `allow_provider_request()` 拿熔断放行许可，失败/超时换下一家，成功即返回并异步 `failover_switch` 通知 UI/托盘。
  - **单 provider 场景跳过熔断器检查**（`forwarder.rs:413` bypass_circuit_breaker = providers.len()==1）——注意此设计。

### 1.2 熔断器（Hystrix 风格三态）— 确定

`src-tauri/src/proxy/circuit_breaker.rs` 完整实现，状态机：

| 状态 | 进入条件 | 行为 |
|---|---|---|
| **Closed（闭）** | 初始 / 半开连续成功 ≥ success_threshold | 全部放行 |
| **Open（开）** | 连续失败 ≥ failure_threshold **或**（total ≥ min_requests 且 error_rate ≥ error_rate_threshold） | 拒绝请求（`is_available()=false`） |
| **HalfOpen（半开）** | Open 后等待 timeout_seconds 到期 | **限流放行 1 个探测**（`max_half_open_requests=1`，`circuit_breaker.rs:317`）；探测失败→立即 Open；成功→计数，达 success_threshold→Closed |

配置参数（`circuit_breaker.rs:38-49`，UI 面板对应）：

| 参数 | 含义 | 默认 | 老板截图值 | UI 范围 |
|---|---|---|---|---|
| failure_threshold | 连续失败打开阈值 | 4 | 8 | 3-10 |
| success_threshold | 半开恢复成功数 | 2 | 1 | 1-10 |
| timeout_seconds | 打开后恢复等待（秒） | 60 | 90 | 30-120 建议 |
| error_rate_threshold | 错误率阈值（0-1） | 0.6 | 0.7 | 0-100% |
| min_requests | 错误率计算最小请求数 | 10 | 15 | 5-100 |

其他关键设计：`record_result()` 按 app 独立熔断（key=`{app_type}:{provider_id}`）；计数 Atomic；`reset()` 手动恢复；HalfOpen permit 必须由调用方归还（`release_half_open_permit`），防卡死。

### 1.3 重试与超时 — 确定

- **max_retries**（0-10，默认 3）：请求失败后最多换几家的「重试次数」语义（实际尝试 = retries+1）。
- **streaming_first_byte_timeout**（默认 60s，截图 90）：流式首字节等待上限。
- **streaming_idle_timeout**（默认 60s，截图 180）：数据块间最大静默间隔（0=禁用）。
- **non_streaming_timeout**（默认 600s）：非流式总超时。
- 无指数退避/Retry-After 消费（grep 无 backoff/retry_after）——每 provider 只试一次，失败即降级，重试语义交给 CLI 客户端。

### 1.4 时间段/时间条件 — **cc-switch 无此能力（确定）**

- grep `schedule/cron/time_of_day/weekday/available_from/time_range` 全部源码：**无任何模型路由时间调度**（仅 xai OAuth 轮询、托盘刷新等无关命中）。
- 截图「Kimi 周二凌晨恢复」「Kimi 周六中午恢复」= **providers.notes 人工备注**（`BasicFormFields.tsx:142` notes 输入框），**不是自动恢复调度**。
- 用量窗口「5小时/7天」：来自**服务商官方 API** 的 quota 查询（`src-tauri/src/services/coding_plan.rs:562` 解析 `quota_5_hour`；`subscription.rs` 从 Anthropic/Codex/火山方舟接口拉 `limit_window_seconds` + `resets_at`），**仅展示（托盘/前端），不参与 select_providers 路由过滤（确定，grep provider_router 无 quota 消费）**。

### 1.5 配置数据结构汇总 — 确定

- `AppProxyConfig`（`src-tauri/src/proxy/types.rs:162`）：`app_type, enabled, auto_failover_enabled, max_retries, streaming_first_byte_timeout, streaming_idle_timeout, non_streaming_timeout, circuit_failure_threshold, circuit_success_threshold, circuit_timeout_seconds, circuit_error_rate_threshold, circuit_min_requests`。
- `CircuitBreakerConfig`（`circuit_breaker.rs:38`）：5 个熔断参数。
- Provider 条目（schema.rs:27）：见 1.1。

## 2. 业界方案对比

### 2.1 LiteLLM Router — 确定（docs.litellm.ai/docs/routing）

- **路由策略**：simple-shuffle（默认，加权随机）、rate-limit-aware-v2（rpm/tpm 余量）、latency-based、least-busy、cost-based、usage-based-v2；可 routing_groups 按模型分组设不同策略。
- **优先级降级**：`litellm_params.order`（数字小=优先级高），同 order 内由策略挑选；order=1 失败自动试 order=2…；所有 order 耗尽再走 fallbacks 链（跨模型组）。
- **Cooldown（等效熔断，非三态显式状态机）**：`allowed_fails`/分钟 + `cooldown_time` 秒；触发条件：429 立即、分钟失败率 >50%、非重试错误（401/404/408）→ 均 5s 默认；可 `AllowedFailsPolicy` 按错误类型定制。
- **重试**：`num_retries`（RateLimitError 指数退避，其他立即重试）+ `retry_after` 最小等待；`RetryPolicy` 按错误类型定制。
- **无内建时间条件路由（高置信）**：文档未见 time/schedule 条件（grep 未做，待证但路由文档无此概念）。

### 2.2 OpenRouter — 确定（openrouter.ai/docs/guides/routing/provider-selection）

- **provider.order**：按序试 provider slug 数组（`["anthropic","openai"]`）——最接近 cc-switch 队列。
- **provider.sort**：price / throughput / latency；`max_price`、`only`/`ignore`、`require_parameters`、`zdr` 等**过滤条件**。
- **自动故障转移**（provider 级，默认开，`allow_fallbacks`）：30 秒无 outage 优先 + 最低价候选按价格倒数平方加权。
- **模型 fallbacks**：请求级 `models` 数组按序试（模型级，opt-in）。
- **性能阈值**：p50/p75/p90/p99（5 分钟滚动窗口）过滤/降级端点。
- **无时间条件路由（高置信）**。

### 2.3 Portkey — 确定（portkey.ai/blog）

- Retry（指数退避）+ fallback chains + **circuit breaker**（监控错误数/错误率/状态码 429/502/503，超阈值摘除，cooldown 后自动恢复）——与 cc-switch 同族但平台化。
- 强调三层分工：retry 处理瞬态、fallback 保证连续性、breaker 防系统性恶化（**先等 retry 失败再 fallback 的延迟问题**是 breaker 提前介入的动机）。

### 2.4 条件路由（时间/地域/负载）业界表达 — 确定

| 方案 | 表达方式 |
|---|---|
| Inworld Router | CEL 表达式对 request metadata 求值（docs.inworld.ai conditional-routing） |
| Bifrost | CEL expressions（docs.getbifrost.ai routing-rules） |
| Twilio TaskRouter | Time-of-Day 表达式（Workflow Filter/Target Worker Expressions） |
| LiteLLM/OpenRouter/Portkey/cc-switch | **均无内建时间条件** |

→ 时间条件路由在业界**没有「路由配置内建」先例**，通用做法是**条件表达式（CEL）**或**业务层 if-else**。

## 3. 关键概念提炼（供 prd 设计）

1. **路由规则 = 有序降级链**：条目按优先级排序，请求时从高到低尝试，失败/超时/熔断跳过换下一个（cc-switch `sort_index`+`in_failover_queue`、LiteLLM `order`、OpenRouter `order` 同构）。
2. **条件表达**：每条目可挂条件（时间窗口等）；无条件的条目 = 兜底锚点。老板约束「有条件不能在无条件下面」= 排序校验规则（见 §4）。
3. **熔断状态机（三态）**：Closed →（连续失败/错误率超阈）→ Open →（等待超时）→ HalfOpen（限流 1 探测）→（成功达阈）→ Closed。参数：failure_threshold / success_threshold / timeout / error_rate_threshold / min_requests。
4. **排序约束**：同一模型可有「1 个有条件 + 1 个无条件」，无条件兜底必须排在有条件之后（否则条件不满足时直接落兜底，条件分支失去意义）。业界无直接先例，属 rocky 自定义约束，需在配置层做**静态校验**（提交时校验排序合法性）。
5. **用量窗口（5h/7d）**：cc-switch 展示不路由（quota 来自服务商 API）；若要参与路由需拉取服务商 quota + 本地缓存 + 超限跳过，复杂度高，建议第一期不做（或仅提示）。

## 4. 对 rocky_agent 落地的启示与风险点

### 启示（老板设想映射）

- **模型组合方案配置**（设置里）：≈ cc-switch 的「app 级 AppProxyConfig + failover queue」。建议组合方案 = 有序模型条目列表（每条约 = provider + model + 可选条件 + 可选熔断参数覆盖）。
- **团队默认模型/组合方案**：组合方案可被团队/会话引用（rocky 已有团队概念），配置层把「组合方案」做成可命名实体。
- 时间条件按**本地时间**：Electron 桌面 app 用 `Intl.DateTimeFormat`/本地时区即可，无服务器时区歧义（比 web 服务简单）。
- 熔断状态：Electron 进程内内存态即可（重启丢失可接受，参考 cc-switch 也是内存 Atomic）；若要持久化需落 sqlite。

### 风险点

1. **排序约束校验**（老板第 4 点）：「有条件条目不得排在无条件条目之后」需静态校验 + 明确语义（同一模型组内比较还是全局？若全局「无条件必须在最后」则多组模型冲突——**建议按模型分组校验**：每组内无条件兜底只能在该组末尾，且每组至少 1 个无条件或全局兜底）。
2. **时间条件粒度**：周几+时段（如「周二凌晨」）还是 cron 表达式？建议**周几+起始时间窗口**（贴近老板「周二凌晨恢复」表达），避开 cron 复杂度。
3. **熔断参数默认值**：参考 cc-switch 默认（4/2/60/0.6/10）与老板截图（8/1/90/0.7/15）差异大——老板已按自己场景调过，建议默认取 cc-switch 官方默认，UI 可调。
4. **单 provider 跳过熔断**（cc-switch `forwarder.rs:413`）：rocky 若单模型组合也要熔断保护，需决策是否沿用「单 provider 跳过」设计（cc-switch 为兼容直连模式而跳，rocky 无此包袱，可全程熔断）。
5. **超时参数**：流式首字节/静默/非流式三档超时是 cc-switch 实战关键（截图已调 90/180/600），rocky 的 LLM 调用层需有对应超时注入点。
6. **失败语义**：熔断计数的「失败」= 网络错误/超时/5xx/429 都算？4xx 业务错误（内容策略等）是否算——需明确（cc-switch 的 record_result 由 forwarder 决定，LiteLLM 用错误类型策略）。

## 附：证据清单与来源

- cc-switch 源码（github.com/farion1231/cc-switch，2026-08-14 clone）：`circuit_breaker.rs` / `provider_router.rs` / `forwarder.rs` / `types.rs` / `schema.rs` / `usage_rollup.rs` / `coding_plan.rs` / `subscription.rs` / `FailoverQueueManager.tsx` / `AutoFailoverConfigPanel.tsx`
- 官方文档：docs.litellm.ai/docs/routing、openrouter.ai/docs/guides/routing/provider-selection、portkey.ai/blog/retries-fallbacks-and-circuit-breakers-in-llm-apps、docs.inworld.ai/router/capabilities/conditional-routing、docs.getbifrost.ai/providers/routing-rules、twilio.com/docs/taskrouter/time-of-day-routing
- 老板截图：images/image-01KZZ0WCE2V08APYE9DTG0WB4G.png（降级链+用量+超时+熔断配置）、image-01KZZ0XHWFS0Q7R27VAPW3YFC7.png（熔断参数）
- 未确认项：「周二凌晨恢复」是否参与路由调度——已确认**否**（notes 备注，源码无调度）；LiteLLM/OpenRouter 时间条件——**无内建**（高置信）
