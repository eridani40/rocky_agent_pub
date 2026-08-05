---
type: change_log
version: v0.0.61
title: langfuse 优化（trace 命名 + usageDetails 防双计）
updated: 2026-07-03
---

# v0.0.61 · langfuse 优化（trace 命名 + usageDetails 防双计）

> 两项 observability 内部优化：① trace 不再 unnamed；② usage 落 langfuse 防双计。
> 不改对外 API/UI 契约——trace 命名 + usageDetails 是 observability 内部映射，对 agent loop / session / client 完全透明。
> 权威需求：`reqs/[working] v0.0.61.langfuse_opt_v1/req.md`

## 1. trace 命名修复（避免 unnamed-trace）

### 问题
`LoopObservability.startTrace` 之前不传 `name`，langfuse UI 列表全部显示 `unnamed-trace`，无法区分是哪个 session、哪轮对话。

### 做法
- `LoopObservabilityOpts` 加 `sessionKind?: string`（取 `SessionKind.toolPolicyRole`，如 `studio-leader` / `playground-rocky`）。
- `build-deps.ts` + `build-forked-deps.ts` 构造 `LoopObservability` 时两处都接 `sessionKind: config.kind?.toolPolicyRole`。
- 新增**纯函数** `buildTraceName(sessionKind, sessionId, triggerMessages)`（落在 `agent-loop-helpers.ts`，非 `LoopObservability` 私有方法——因主文件已超 300 行拆出）。
- `LoopObservability.startTrace` 调 `buildTraceName` 拼 name 后透传 `adapter.startTrace({ id, sessionId, name, input, metadata })`。

### name 格式
```
${kind} ${sid6} ${input10}
```
- `kind = sessionKind ?? 'session'`（兜底，避免 unnamed-trace）
- `sid6 = sessionId.slice(0, 6)`
- `input10` = 首条 user 消息所有 `TextBlock.text` 拼接、`\s+`→单空格 `trim`、`slice(0, 10)`；无 user 消息则空串，`trimEnd()` 处理 trailing 空格

例：`studio-leader 01KWBP helloworld`

### 关键文件
- `app/server/src/agent/agent-loop-helpers.ts` — `buildTraceName` 纯函数（新增导出）
- `app/server/src/agent/agent-loop-observability.ts` — `startTrace` 调 buildTraceName + `LoopObservabilityOpts.sessionKind` 字段
- `app/server/src/agent/build-deps.ts` / `build-forked-deps.ts` — sessionKind 接线

> **[v0.0.78.bug] name 格式扩展**：`buildTraceName` 加第 4 参 `modeKey?: string`，在 kind 段拼 `[modeKey]` 后缀（如 `studio-leader[summary] 01KWBPa3 helloworld`），用于区分 forked compact / tier1 consolidation 与 main loop。modeKey 缺省 / `'current'` 时退本节原格式（main loop 视觉零回归）。详见 `specs/tech/version_logs/v0.0.78.bug/change_log.md §T3`。

## 2. usage 落 usageDetails/costDetails（防双计核心）

### 问题
`mapUsage` 之前产单层 `usage` 对象，含 `input` + `input_cache_read` + `input_cache_write` 三个 key。但 langfuse UI 求和所有含 "input" 子串的 key —— 若 `input` 已是 grand total（含 cache）又加 cache key，全部双计；即便 `input` 用 `input_no_cache`，cache key 用 `inputCacheRead`/`inputCacheCreation`（langfuse canonical 名）也含 "input" 子串被求和——**必须保证三者互斥不重叠**。

实测 anthropic：`input_tokens`（1123，**不含** cache）+ `cache_read_input_tokens`（128）= total（1251）。即拆分天然互斥，安全。

### 做法
- `mapUsage` → **`mapUsageDetails`**（迁出到 `observability/langfuse-metadata.ts`，返 `{ usageDetails: Record<string,number>, costDetails: Record<string,number> }`）。
- **互斥拆分路径**（input_no_cache / input_cache_read / input_cache_write 任一非 null）：
  - `usageDetails.input = input_no_cache`
  - `usageDetails.inputCacheRead = input_cache_read`（值为 0 跳过）
  - `usageDetails.inputCacheCreation = input_cache_write`（值为 0 跳过）
- **fallback 路径**（三拆分全 null，如旧 caller 或 non-anthropic）：`usageDetails.input = input_total_tokens`，**不**传 cache key（防双计）。
- 输出同理：`output_response`/`output_reasoning` 拆分 vs `output_total_tokens` 兜底；reasoning 为 0 跳过。
- **costDetails**：`cost != null ? { total: cost } : {}`（保留 `LlmClient.computeCost` 按 `modelConfig.pricing` 算的应用定价权威）。
- physical generation：传 `{}` → `mapUsageDetails` 全 0（不污染 token/cost dashboard）。
- `endGeneration` 改写 `upd.usageDetails` / `upd.costDetails`，**不再用废弃的 `upd.usage` 单层对象**。
- `total_tokens` / `unit` / `charCount` / `currency` 不再落 langfuse（求和重复 + 次级信息丢弃）。

### 关键文件
- `app/server/src/observability/langfuse-metadata.ts` — `mapUsageDetails`（从 langfuse-adapter.ts 迁入 + 重写语义）
- `app/server/src/observability/langfuse-adapter.ts` — `endGeneration` 改用 `upd.usageDetails/costDetails`（physical 路径 `mapUsageDetails({})`）

## 3. 文档同步

- `specs/tech/agent/observability/[P0]langfuse_adapter.md`：
  - §4 接口映射表 `endGeneration` 行（已 v0.0.61 化）
  - §5 全量字段映射（Generation 行 `usage` → `usageDetails`+`costDetails`；§5 intro 同步）
  - §6 整章重写为 mapUsageDetails（互斥拆分 + fallback + costDetails + 代码块）
- `specs/tech/agent/observability/[P0]observability_interface.md` §5.1：`TraceStart.name` 补 v0.0.61 语义（兜底 'session' + sid6 + input10 + trimEnd）。
- `specs/tech/agent/observability/log.md`：追加 v0.0.61 条目。

## 4. 不影响范围

- 对外 API（sessions/messages/…）：零变更，trace 命名 + usageDetails 是 observability 内部映射。
- PRD/UI 契约：零变更（observability 不在前端可观测路径，UI 只看 event 不看 trace）。
- `langfuse-metadata.ts::mapGenMetadata` 中 `cacheReadTokens`/`cacheWriteTokens` 字段保留（GenMetadata 类型契约不删，避免连锁改），仍写进 generation metadata，无害冗余。

## 5. 验收

- API 测试：通过（observability trace 字段断言已含 name + usageDetails）。
- AT case 复用 v0.0.24 起的 langfuse oracle 三类（内容一致性 / 工具结果保真 / 多轮 generation）。

## 6. key 名对齐协议（cache/reasoning snake_case）

**问题**：v0.0.61 初版 `mapUsageDetails` 自造 camelCase key（`inputCacheRead` / `inputCacheCreation` / `reasoning`），但用户权威协议 `reqs/v0.0.61.langfuse_opt_v1/langfuse-usage-protocol.md` §二/§四 明确要用 langfuse Anthropic 原生 snake_case（匹配 langfuse 内置 model pricing + 官方示例），自造 key 会导致 langfuse 无法按内置 model definition 算成本。

**改动**（key 名对齐，**值不变、防双计语义不变**）：
- `usageDetails.inputCacheRead` → `usageDetails.cache_read_input_tokens`（Anthropic `usage.cache_read_input_tokens` 同名）
- `usageDetails.inputCacheCreation` → `usageDetails.cache_creation_input_tokens`（Anthropic 同名）
- `usageDetails.reasoning` → `usageDetails.output_reasoning_tokens`（OpenAI flatten 名，§四.2）
- `input` / `output` / fallback 用 total 不传 cache key 的防双计语义**完全不变**

**影响范围**：
- `app/server/src/observability/langfuse-metadata.ts`（mapUsageDetails key 名 + JSDoc）
- 单测断言（5 个文件：observability-noop / observability-langfuse-adapter / langfuse-physical-endpair / langfuse-physical-manager-invoke / langfuse-adapter.ts 顶部注释）
- API case `tests/api/observability/langfuse_usage_cache_tc1/`（checkpoint.json canonical key 断言 + run.sh python 校验逻辑 + test_case.md 字段映射表）
- spec：`[P0]langfuse_adapter.md §6`（字段映射表 + fallback 规则 + 代码块 + 新增 canonical key 命名段）
