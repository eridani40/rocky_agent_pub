---
type: design
title: Langfuse Adapter（observability backend 实现）
priority: P0
status: active
updated: 2026-07-14
since: v0.0.10
related: [[P0]observability_interface.md, [P0]observability_manager.md]
---

# Langfuse Adapter（首个 observability backend 实现）

> `ObservabilityAdapter` 的 `LangfuseAdapter` 实现：把 trace/generation/span 生命周期 + **全量字段**映射到 Langfuse SDK。
> 接口契约 + 概念对齐 + 全量字段定义（TraceStart/GenInput/ToolSpanInput/…）见 `[P0]observability_interface.md §5`；Usage 见 `../session/[P0]session_usage.md §1`。
> **ENV 兜底已移除**：凭证改由 `ObservabilityManager` per-item 经构造参数注入（见 `observability_manager.md §6`）；singleton 已被 manager per-item client 取代。

## 1. 定位

`LangfuseAdapter` 实现 `ObservabilityAdapter`（`observability_interface §6`），用 Langfuse TS SDK（`langfuse` npm）上报。是首个真实 backend；换 backend（OTel 等）= 换 adapter，loop 不动。

## 2. SDK 接入 + LangfuseEventQueue（核心红线 — v0.0.138）

- **包**：`langfuse`（官方 TS SDK，异步 batch 上报）。
- **凭证**：`publicKey` / `secretKey` / `baseUrl`（self-host 或 cloud），经构造参数传入——由 `ObservabilityManager` 按 per-item 从 app_config observability 列表（runtime 组）注入（见 `observability_manager.md §6`）。**不读 ENV**（`LANGFUSE_*` env 兜底已移除，凭证只来自 app_config observability 列表）。
- **per-item client + queue**：每个 enabled observability 配置项一个独立 `LangfuseAdapter`，持一个独立 `LangfuseEventQueue`（持独立 langfuse client——不同 baseUrl/凭证隔离 batch queue）；manager 持 N 个 child。trace 按 `sessionId` 区分。

**LangfuseEventQueue（`langfuse-event-queue.ts`）— 所有 SDK 调用经此队列（核心红线）**：

> v0.0.138 起重构：SDK 调用不再由 `LangfuseAdapter` 直接发起，而是入队由单 consumer async loop 批处理。此前 `client.trace()/span()/generation()/update()` 散调，攒 2.6MB batch + 高频 squad 活动致后端阻塞。现统一队列隔离 + 500MB 上限封顶。

- **全 op 队列（方案 B）**：start 方法（`startTrace/startSpan/startGeneration`）入队 `create-op`（create-trace/create-span/create-gen），end 方法 + `setLevel` 入队 `update-op`。**handle.id 在 start 方法同步生成**（caller 立即可用），consumer FIFO 处理 → parent op 必先于 child op 处理（`resolveParent` 必命中）。
- **500MB byte buffer + drop-new**：`MAX_BUFFER_BYTES=500MB`，`enqueue` 估算 op size（`JSON.stringify(args)` 长度 + 固定 overhead）→ `bufferedBytes+size > MAX` → drop new（保 FIFO 老）+ 节流 warn（10s 窗口聚合 N 条计数）。稳态 queue 几乎恒空，burst 才触发；observability 旁观者，drop = 缺一段 trace，不影响业务。
- **单 consumer async loop**：lazy 启 on first enqueue；空 → `await sleep(50ms)` 轮询；非空 → 取 batch（≤64）→ 每 op `_apply`（try/catch 静默）→ 批间 `await sleep(250ms)` yield 让出 event loop（memory `async-marked-fn-sync-io-blocks-eventloop`，MUST NOT 同步排空）。所有 setTimeout 用 `unref` sleep helper。
- **`_apply` op 分发**（逐一等价重构前 LangfuseAdapter 现状 SDK 调用）：create-trace→`client.trace(args)`+obs.set；create-span→`resolveParent(parentId).span(args)`+obs.set；create-gen→`resolveParent(parentId).generation(args)`+obs.set；update→`obs.get(id)?.update(args)`。`resolveParent` 找不到 → throw（被 `_apply` try/catch 吞，等价现状「parent 未找到」）。
- **SDK 状态迁入队列**：`traces/obs/genKind` Map 从 LangfuseAdapter 迁入 LangfuseEventQueue（consumer 维护，key/value 语义不变）。

**核心红线（不可违反）：observability 失败绝不影响主流程**——三层守卫：
1. adapter `start*/end*/setLevel` 全包 try/catch（op 构造 + enqueue 错误吞）；错误经 `warnSuppressed(method, e)` 模块级函数（**非类方法**，保「observability 失败 console.warn debug 级」契约）console.warn 不向 loop 抛。
2. consumer `_apply` try/catch 吞 SDK 调用错误（console.warn debug 级）。
3. `enqueue` 同步不 await（fire-and-forget），start/end 同步返 Handle（loop 不等队列）。

```typescript
import { Langfuse } from "langfuse";
import { LangfuseEventQueue } from "./langfuse-event-queue";

/** debug 级日志（核心红线：observability 失败仅 console.warn，不向 loop 抛）— 模块级函数非类方法 */
const warnSuppressed = (method: string, e: unknown): void => {
  const msg = e instanceof Error ? e.message : String(e);
  console.warn(`[observability:langfuse] ${method} failed (suppressed): ${msg}`);
};

class LangfuseAdapter implements ObservabilityAdapter {
  private readonly queue: LangfuseEventQueue;   // SDK client + traces/obs/genKind Map 全在 queue 内

  constructor(opts: { publicKey: string; secretKey: string; baseUrl: string }) {
    // SDK 构造可能因凭证非法抛错——抛在构造期（激活前）比运行中静默更清晰。
    this.queue = new LangfuseEventQueue(new Langfuse(opts));
  }
  // start*/end*/setLevel 主体改为 enqueue op + 同步返 Handle（见 §4）；shutdown = drainAndShutdown（见 §3）
}

// LangfuseAdapter 只经构造参数收凭证（由 ObservabilityManager per-item 注入，见 observability_manager.md §6）。
```

## 3. 生命周期（electron 全局 + node server）

| 时机 | 动作 |
|---|---|
| 启动（electron 或 node server） | bootstrap 读 app_config observability 列表（runtime 组）→ `createObservabilityManager(items)` → 每 enabled 项一个 `new LangfuseAdapter(opts)`（manager 持 N 个 child；queue lazy 启 on first enqueue）→ 注入 SessionConfig.observability（manager 实例）。凭证只来自 app_config observability 列表。 |
| run 期间 | `startTrace/startGen/startSpan` → enqueue create-op；`endXxx/setLevel` → enqueue update-op；consumer 批处理 → SDK batch |
| **关闭**（见下方 flush 生命周期） | `adapter.shutdown()` → `queue.drainAndShutdown()`：drain（等 queue 空 + writing false，5s deadline）**先于** `client.shutdownAsync()`（兑现 flush 契约，防丢未处理事件） |

> SDK 异步 batch + 队列消费者，**关闭前必须 drain + `shutdownAsync()`**，否则末尾 trace / 未处理 op 可能未上报。

> **flush 生命周期（双触发，不依赖存活延迟）**：
> - **node server SIGTERM/SIGINT**（`app/server/src/index.ts`）：收到信号后调 `shutdownObservability()` 强制 flush；Electron packaged 模式（isMain=false）不进此分支。
> - **electron before-quit**（`app/electron/main.ts`）：调 `shutdownObservability()` flush。
> - 不依赖「process 存活 12s」式延迟 flush。test env 由 `tests/api/env_start.sh`（AT）+ `tests/e2e/env.sh`（ET）注入 `LANGFUSE_*` 环境变量。

> **`drainAndShutdown` 实现（v0.0.138）**：`while (q.length>0 || writing) && Date.now()<deadline: await sleep(20)` → `await client.shutdownAsync()`（失败静默）。`writing` flag（抄 `log-queue.ts`）：consumer 在 `_apply` 段前置 true / finally false，故 `q.length===0` ≠ apply 完成（consumer splice 出队后才 apply，race 下 drain 误判完成），drain 须等 `q.length>0 || writing`。5s deadline 防 hang。

## 4. 接口映射（adapter → langfuse SDK）

Langfuse SDK 支持嵌套 observation：`trace.span()` 返回 span 对象，其上 `.span()` / `.generation()` 创建子节点（SDK 自动设 `parentObservationId`）。落地 `observability_interface §3` 的 step span 嵌套。

> **v0.0.138 起 SDK 调用全经 LangfuseEventQueue**（§2）：adapter 方法不再直接调 SDK，而是 enqueue op（start 入队 create-op，end/setLevel 入队 update-op）；consumer FIFO 处理时调 SDK。下表「langfuse SDK」列描述 consumer `_apply` 实际发起的 SDK 调用（语义与重构前逐一等价）。handle.id 在 start 方法同步生成（caller 立即可用），consumer FIFO 保证 parent create-op 先于 child create-op 处理 → `resolveParent` 必命中。

| adapter 方法 | langfuse SDK（consumer `_apply`） | input/output/metadata 落点 |
|---|---|---|
| `startTrace` | enqueue `create-trace` → consumer `client.trace({ id, sessionId, name, input, metadata })` | input=TraceStart.input(触发消息)；metadata=TraceMetadata |
| `endTrace` | enqueue `update` → consumer `trace.update({ output, metadata })` | output=TraceStart.output(最终 message)；metadata.stopReason |
| `startSpan(step)` | enqueue `create-span` → consumer `trace.span({ name, input, metadata, startTime })` | input={step}；metadata=StepSpanMetadata |
| `startSpan(tool)` | enqueue `create-span` → consumer `stepSpan.span({ name, input, metadata, startTime })` | input=ToolSpanInput；metadata=ToolSpanMetadata |
| `endSpan` | enqueue `update` → consumer `obs.update({ endTime, output, metadata, level? })` | output=ToolSpanOutput；isError→level:"ERROR" |
| `startGeneration` | enqueue `create-gen` → consumer `stepSpan.generation({ name, model, input, startTime })` | logical（默认）：name=`llm-N-logical` 或 fallback `llm`，input=GenInput(完整 system+messages+tools，logical 视图)；physical（v0.0.50）：name=`llm-N-physical` 或 fallback `llm-physical`，input=physicalInput(wire body)，metadata.physicalWire=true |
| `endGeneration` | enqueue `update` → consumer `gen.update({ endTime, output, usageDetails, costDetails, metadata })` | logical：output=GenOutput；usageDetails/costDetails=mapUsageDetails(全字段，§6 互斥拆分)；metadata=GenMetadata；physical：不传 output；usageDetails/costDetails=mapUsageDetails({})→全 0；metadata 追加 physicalWire=true |

```typescript
startGeneration(p: GenStart): GenHandle {
  const id = ulid();                                  // handle.id 同步生成（caller 立即可用）
  const genKind: 'logical' | 'physical' = p.kind ?? 'logical';
  // name 优先用 caller 传入（llm-N-logical / llm-N-physical）；未传 fallback `llm`（logical）/ `llm-physical`（physical）
  const fallbackName = genKind === 'physical' ? 'llm-physical' : 'llm';
  const genArgs: Record<string, unknown> = {
    name: p.name ?? fallbackName,
    model: p.model,
    input: genKind === 'physical' ? p.physicalInput : p.input,
    startTime: p.startTime ?? new Date(),
  };
  if (genKind === 'physical') genArgs.metadata = { physicalWire: true };
  try { this.queue.enqueue({ kind: 'create-gen', id, parentId: p.parent.id, args: genArgs, genKind }); }
  catch (e) { warnSuppressed('startGeneration', e); }
  return { kind: 'gen', id, parent: p.parent };
}
endGeneration(e: GenEnd): void {
  // ★ genKind 在 create-gen 入队时同步 set（queue.enqueue 内：if create-gen → genKind.set(id, genKind)）
  //   避免「consumer 异步 set genKind 但 endGeneration 先读」的 race（physical gen 被误按 logical 处理）
  const genKind = this.queue.getGenKind(e.gen.id);
  const upd: Record<string, unknown> = { endTime: e.endTime ?? new Date() };
  // physical 传 mapUsageDetails({}) → usageDetails/costDetails 全 0（不污染 cost dashboard）；
  // logical 正常映射全字段（§6 互斥拆分防双计）
  const m = mapUsageDetails(genKind === 'physical' ? ({} as Usage) : e.usage);
  upd.usageDetails = m.usageDetails;
  upd.costDetails = m.costDetails;
  // physical 不传 output（物理层不承载 LLM 产出）；logical 透传 output + error 路径 level/status
  if (genKind !== 'physical') {
    if (e.output !== undefined) upd.output = e.output;
    if (e.status === 'error') { upd.level = 'ERROR'; upd.status = 'ERROR'; }
  }
  const meta = mapGenMetadata(e.metadata, e.errorCategory);
  upd.metadata = genKind === 'physical' ? { ...meta, physicalWire: true } : meta;
  try { this.queue.enqueue({ kind: 'update', id: e.gen.id, args: upd }); }
  catch (err) { warnSuppressed('endGeneration', err); }
}
```

> **`genKind` 时序（v0.0.138 偏离记录，已 sound）**：genKind 不能在 consumer `_apply` 处理 create-gen 时才 set——`endGeneration` 可能在 consumer 处理 create-gen 之前被调（enqueue 后 consumer 还在 250ms sleep），此时 `getGenKind` 读到 undefined → 默认 logical → physical gen 被误按 logical 处理（多传 output、usage 映射用真 usage 而非空）。**修复**：`LangfuseEventQueue.enqueue` 内对 create-gen **同步 set genKind**（enqueue 入队前），consumer 不再 set。`getGenKind(id)` 返 `genKind.get(id) ?? 'logical'`。

## 5. 全量字段映射（adapter 字段 → langfuse 字段）

每个 adapter 字段都落到 langfuse observation 的 `input` / `output` / `metadata` / `usageDetails`+`costDetails` / `model`，**不丢、不截断**。

**对齐关系（meta）**：adapter 各对象的 metadata（`TraceMetadata` / `GenMetadata` / `StepSpanMetadata` / `ToolSpanMetadata`，见 overall §5）原样整体写入 langfuse observation 的 `metadata` 字段（任意 KV JSON）。Langfuse UI 可按 metadata key 检索 / 筛选 trace（如按 `toolName`、`stopReason`、`needsApproval` 过滤）。嵌套场景下，每层 observation 各自带自己的 metadata，随 handle 树自然分层。

### Trace

| adapter 字段 | langfuse 字段 |
|---|---|
| `TraceStart.id`（=runId） | trace `id`（自定义；runId 唯一不冲突） |
| `sessionId` | trace `sessionId`（聚合 session view，不主动 create） |
| `input`（触发消息） | trace `input` |
| `output`（最终 message） | trace `output`（endTrace 时 update） |
| `TraceMetadata`（runId/parentSessionId/modelId/provider/protocol/toolNames/systemPromptHash/stopReason/…） | trace `metadata` |

### Generation

| adapter 字段 | langfuse 字段 |
|---|---|
| `GenStart.model`（modelId） | generation `model` |
| `GenInput`（system+messages+tools+params，**完整 LLM 输入**） | generation `input` |
| `GenOutput`（message + stopReason，**完整 LLM 输出**） | generation `output` |
| `Usage`（token 拆分 + char + cost） | generation `usageDetails` + `costDetails`（mapUsageDetails，§6 互斥拆分防双计） |
| `GenMetadata`（iteration/step/cache/durationMs） | generation `metadata` |

> GenInput.messages 是 LLM 真正看到的完整上下文，GenOutput.message 是真正产出——trace 最核心可调试信息，原样落。

### step Span

| adapter 字段 | langfuse 字段 |
|---|---|
| `name`（`step N`） | span `name` |
| `input`（{step}） | span `input` |
| `StepSpanMetadata`（step/ingestUpTo/llmUpTo/newMessageCount/hasToolCall） | span `metadata` |

### tool Span

| adapter 字段 | langfuse 字段 |
|---|---|
| `name`（`tool:${toolName}`） | span `name` |
| `ToolSpanInput`（toolCallId/toolName/**arguments 完整**） | span `input` |
| `ToolSpanOutput`（**result 完整** + isError） | span `output` |
| `ToolSpanMetadata`（step/needsApproval/approvalStatus/durationMs） | span `metadata`；isError → span `level:"ERROR"` |

## 6. Usage 映射（Usage → langfuse usageDetails/costDetails）

**对齐关系（usage）**：adapter `GenEnd.usage`（= `Usage`，session_usage §1）→ langfuse generation 的 `usageDetails`（number map）+ `costDetails`（number map，应用定价权威）。

**关键语义（防双计 — 不可违反）**：langfuse UI 求和所有含 "input" 子串的 key。anthropic `input_tokens` **不含** cache（实测：input_tokens=1123 + cache_read=128 = total=1251）。所以必须传**互斥不重叠**拆分，绝不能 input=grand total 又加 cache key（双计）。

**fallback 规则（优先用拆分字段；缺失才用 total 且不传 cache key）**：
- 有拆分（`input_no_cache` / `input_cache_read` / `input_cache_write` 任一非 null）→ 拆分写：`usageDetails.input = input_no_cache`、`usageDetails.cache_read_input_tokens = input_cache_read`、`usageDetails.cache_creation_input_tokens = input_cache_write`（值为 0 的 cache key 跳过，不写入）。
- 无拆分（三者全 null，如旧 caller 或 non-anthropic）→ `usageDetails.input = input_total_tokens`，**不**传 cache key（防双计）。
- 输出同理（`output_response` / `output_reasoning` 拆分 vs `output_total_tokens` 兜底）。

**canonical key 命名（对齐 `reqs/v0.0.61.langfuse_opt_v1/langfuse-usage-protocol.md` §二/§四，匹配 langfuse 内置 model pricing + 官方示例）**：cache/reasoning 用 langfuse Anthropic 原生 snake_case，不用自造 camelCase：
- cache read → `cache_read_input_tokens`（Anthropic `usage.cache_read_input_tokens` 同名直接传）
- cache write（创建缓存）→ `cache_creation_input_tokens`（Anthropic `usage.cache_creation_input_tokens` 同名）
- reasoning → `output_reasoning_tokens`（OpenAI flatten 名，§四.2：`completion_tokens_details.reasoning_tokens → output_reasoning_tokens`）

**costDetails**：`cost != null ? { total: cost } : {}`（保留应用定价权威：`Usage.cost` = LlmClient.computeCost 按 modelConfig.pricing 算）。

| Usage 字段（session_usage §1） | usageDetails/costDetails 字段 | 说明 |
|---|---|---|
| `input_no_cache` | `usageDetails.input` | 未缓存输入 token（拆分路径） |
| `input_cache_read` | `usageDetails.cache_read_input_tokens` | 缓存命中读 token（Anthropic 原生 snake_case） |
| `input_cache_write` | `usageDetails.cache_creation_input_tokens` | 缓存写入 token（Anthropic 原生 snake_case） |
| `input_total_tokens` | `usageDetails.input`（fallback 时） | 三拆分全缺 → 兜底写 input，**不**传 cache key |
| `output_response` | `usageDetails.output` | 实际回复 token（拆分路径） |
| `output_reasoning` | `usageDetails.output_reasoning_tokens` | 思维链 token（OpenAI flatten 名） |
| `output_total_tokens` | `usageDetails.output`（fallback 时） | 二拆分全缺 → 兜底写 output |
| `cost` | `costDetails.total` | = LlmClient.computeCost（按 modelConfig.pricing） |
| `total_tokens` | — | 不再单独映射（langfuse UI 求和；显式传会重复计算） |
| `inputCharCount` / `outputCharCount` / `currency` | — | 次级信息，丢弃（非本需求范围） |

```typescript
function mapUsageDetails(u: Usage): { usageDetails: Record<string, number>; costDetails: Record<string, number> } {
  const num = (v: number | undefined): number => (typeof v === 'number' ? v : 0);
  const usageDetails: Record<string, number> = {};
  // 输入拆分（优先用拆分字段；缺失才用 total 且不传 cache key，防双计）
  const hasInputBreakdown = u.input_no_cache != null || u.input_cache_read != null || u.input_cache_write != null;
  if (hasInputBreakdown) {
    usageDetails.input = num(u.input_no_cache);
    if (num(u.input_cache_read))  usageDetails.cache_read_input_tokens     = num(u.input_cache_read);
    if (num(u.input_cache_write)) usageDetails.cache_creation_input_tokens = num(u.input_cache_write);
  } else {
    usageDetails.input = num(u.input_total_tokens);  // 兜底，不传 cache key
  }
  // 输出拆分（同理）
  const hasOutputBreakdown = u.output_response != null || u.output_reasoning != null;
  if (hasOutputBreakdown) {
    usageDetails.output = num(u.output_response);
    if (num(u.output_reasoning)) usageDetails.output_reasoning_tokens = num(u.output_reasoning);
  } else {
    usageDetails.output = num(u.output_total_tokens);
  }
  // costDetails：保留应用定价权威（Usage.cost = LlmClient.computeCost）
  const costDetails: Record<string, number> = u.cost != null ? { total: num(u.cost) } : {};
  return { usageDetails, costDetails };
}
```

> langfuse 据 generation `model` + `costDetails.total` 展示成本；`Usage.cost` 用 LlmClient 算好（llm_client_interface §2）。`total_tokens`/`unit`/`charCount`/`currency` 不再落 langfuse（防双计 + 次级丢弃）。

## 7. 边界

| 零件 | 归属 |
|---|---|
| LangfuseAdapter（adapter impl）+ SDK 接入 + 嵌套映射 + 全量字段映射 + usage 映射 + flush 生命周期 | 本文 ✅ |
| ObservabilityAdapter 接口 + 全量字段定义（TraceStart/GenInput/ToolSpanInput/…） | `observability_interface.md §5/§6` |
| 凭证 / baseUrl 数据来源 | app_config observability 列表（runtime 组，config 板块） |
| Usage / Message / ToolDefinition / ToolResultBlock 类型 | session_usage / agent_message_interface / tools/overall |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
