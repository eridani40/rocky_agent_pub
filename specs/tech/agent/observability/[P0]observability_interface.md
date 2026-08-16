---
type: interface
title: Observability Adapter 接口契约 + 全量字段
priority: P0
status: active
updated: 2026-08-15
since: v0.0.10
related: [[P0]observability_manager.md, [P0]langfuse_adapter.md]
---

# Observability Adapter 接口契约 + 全量字段

## 1. 概述

**(a) 管什么**：`ObservabilityAdapter` 接口（Trace/Generation/Span 生命周期 + Handle 类型）+ 三类对象的**全量字段定义**（input/output/metadata）+ agent loop 边界埋点契约 + per-session 注入 + Langfuse oracle 用法。是 observability 子系统的契约权威源（`ObservabilityManager` / `LangfuseAdapter` / `NoopAdapter` 都实现本接口）。

**(b) 不管什么**：composite fan-out / handle 映射（→ `observability_manager.md`）；Langfuse SDK 接入 / 字段映射 / flush（→ `langfuse_adapter.md`）；agent loop 驱动 / RunState 游标（→ `../agent_interface_and_loop/`）；Usage / Message / ToolDefinition / ToolResultBlock 类型（→ `../session/` / `../message/` / `../tools/`）；observability 列表 schema（app_config runtime 组，→ `../../config/[P0]app_config.md §3.9`）。

**(c) 与外界如何交互**：adapter per-session 经 `SessionConfig.observability` 注入（不可变共享）；agent loop 在边界（run_start / ② LLM 前/后 / ③ tool 前/后 / iteration 起/末 / run_end）**显式调** adapter 方法（精确拿 LLM input/output/model/usage，非订阅 event 翻译）。

### 1.1 设计取舍：概念以 Langfuse 为主，接口保持中性

adapter 接口的概念模型（Trace / Generation / Span / Session / Metadata / Score）取自 Langfuse——它是 LLM observability 事实标准之一，且 v3 基于 OpenTelemetry（≈ OTel GenAI semantic conventions）。故「以 Langfuse 概念为主」≈「以 OTel GenAI 为主」，未来换 OTel backend（Jaeger/Tempo）几乎零摩擦。但**接口保持中性**：method 名（startTrace/startGeneration/startSpan）与字段类型（GenInput/Usage 等）独立于任何 SDK，Langfuse 只在 `LangfuseAdapter` impl 内映射——不耦合 SDK。

**协议 ≈ Langfuse contract**：本协议的语义基准就是 Langfuse（= OTel GenAI）。其他 backend 想接入，其 adapter impl 负责 **adapt to 本协议**——例如纯 OTel backend（Jaeger/Tempo）没有原生 `Generation` 一等概念，需把 Generation 表达成带 `gen_ai.*` attributes 的 OTel Span。

### 1.2 任意深度嵌套

tool 内可能再调 LLM（agent tool 跑子 agent、summarize/classify tool 内部用 LLM），此时 tool Span 下再嵌 Generation（甚至再嵌 tool Span）。parent 用 handle 链表达，**深度不限**（§3）。

## 2. 概念对齐（Langfuse ↔ rocky_agent）

| Langfuse | rocky_agent 对应 | 说明 |
|---|---|---|
| **Session** | `session`（sessionId） | trace 标 `sessionId`，Langfuse 自动聚合 session view；**不主动 create** |
| **Trace** | 一个 **run**（run_start..run_end） | `traceId = runId` |
| **Generation** | 一次 **LLM 调用**（②） | model/input/output/**usage**（session_usage §1） |
| **Span** | 一个 **step**（iteration）/ 一次 **tool 执行**（③） | step span 包一轮；tool span 是其子节点 |
| **Metadata** | runId/sessionId/parentSessionId/toolCallId/游标/… | §5 全量字段 |

## 3. Trace 结构（step span 嵌套，任意深度）

```
Trace(runId)
├─ Span("step 1")
│  ├─ Generation(LLM#1, model, input, output, usage)
│  └─ Span("tool: read", input=arguments, output=result)
├─ Span("step 2")
│  ├─ Generation(LLM#2, usage)
│  └─ Span("tool: agent")              ← tool 内再调 LLM（嵌套，任意深度）
│     └─ Generation(LLM#2b, usage)     ← parent = tool span
└─ Span("step 3")
   └─ Generation(LLM#3, usage)         ← no tool call，run 结束
```

- **step span** = 一个 while iteration（① pre-process + ② LLM + ③ tool），name=`step N`，N=`RunState.step`。
- Generation / tool Span 的 parent = step span。
- 某轮无 tool call → 该 step 只有 Generation，无 tool span。
- **任意深度嵌套**：tool Span 下可再嵌 Generation / tool Span（tool 内部调 LLM）。parent = handle 链，深度不限——一个 step 内不限于「1 gen + N tool」扁平，可成树。

## 4. 埋点契约（agent loop 边界 + 时序）

```
run_start ──→ adapter.startTrace(traceInput)            // §5.1
while iteration N:
  adapter.startSpan(stepSpanInput)                       // §5.3, parent=trace
  ② LLM 通过:
     callLLM 前 ─→ adapter.startGeneration({             // §5.2, parent=step, kind='logical'（默认）
       kind:'logical', name:`llm-N-logical`,
       input: GenInput（logical 视图，sender 已展平）
     })
     // [v0.0.50] 若 hasPhysicalChild()=true，protocol.encode 后 HTTP 前：
     adapter.startGeneration({                           // §5.2, parent=同 step span, kind='physical'
       kind:'physical', name:`llm-N-physical`,
       physicalInput: wireBody（同 N，紧邻 logical）
     })
     HTTP 请求发起 → 完成
     adapter.endGeneration(physical, endTime, usage={})  // 不带 usage/output
     LLM 返回  ─→ adapter.endGeneration(logical, genOutput, usage 全字段)
  ③ tool:
     引擎跑前 ─→ adapter.startSpan(toolSpanInput)        // §5.4, parent=step
     引擎跑完 ─→ adapter.endSpan(toolSpanOutput)
  adapter.endSpan(stepSpanEnd)                           // 关 step
run_end ────→ adapter.endTrace({metadata:{stopReason}})
```

| loop 节点 | 对象 | start 携带 | end 携带 |
|---|---|---|---|
| run_start | Trace | traceInput（§5.1） | stopReason（endTrace） |
| iteration 起 | Span(step) | stepSpanInput（§5.3） | — |
| ② LLM 前/后（logical） | Generation | genInput（§5.2，kind='logical'，name=`llm-N-logical`） | genOutput + usage（§5.2） |
| ② LLM 前/后（physical，v0.0.50） | Generation | physicalStart（§5.2，kind='physical'，name=`llm-N-physical`，physicalInput=wireBody） | endTime + usage={} + 不传 output |
| ③ tool 前/后 | Span(tool) | toolSpanInput（§5.4） | toolSpanOutput（§5.4） |
| run_end | Trace | — | metadata.stopReason |

> 错误路径（invoke throw / 不可恢复错误）：`endGeneration({status:'error', errorCategory, metadata.retryChain})`，写 metadata.errorCategory（LlmErrorCategory 枚举字符串值）+ retryChain，不再笼统 LOOP_ERROR。physical generation 不承载错误语义（错误归 logical），即使 HTTP throw 也只 endGeneration（不带 status='error'）。

### 4.1 双 generation（v0.0.50）

一次 LLM 调用产**两条紧邻 generation**（同一 step span 下，按 `kind` 判别）：

- **logical**（默认）：input=`GenInput`（业务视图，**v0.0.50 起经 `toLogicalMessages` 展平**——sender 已变文本前缀，与 LLM 真正看到的 input 一致）；output=message；usage 全字段；name=`llm-N-logical`。
- **physical**（新）：input=`physicalInput`（protocol.encode 后的 wire body，任意形状）；**不带 output**；usage 全 0（不污染 token/cost dashboard）；name=`llm-N-physical`（同 N，紧邻 logical）；metadata.physicalWire=true。

**N 的来源**：`LoopObservability.currentGenIteration()`（每轮 LLM 递增）；physical 与 logical 同 N，成对。

**物理方法归属**（避免 `llm/caller→agent` 依赖循环）：`startPhysicalGeneration` / `endPhysicalGeneration` / `hasPhysicalChild` 不在 `LoopObservability`（agent 层），而在 `LangfuseObservabilityPort`（`app/server/src/llm/caller/langfuse_observability_port.ts`，已是 `ObservabilityPort` 实现）。`LoopObservability` 仅暴露 `currentGenIteration(): number` 供 port 拼接 N。埋点点位在 `llm_caller.invoke` 内（encode 后 HTTP 前），不经 agent 层。

**双层容错沿用**（§4.5）：physical 埋点失败绝不影响 loop、不影响 logical 埋点——两次 startGeneration 调用互相独立 try/catch（safe 包裹）。

## 5. 记录的信息：全量字段定义 ★

> 三类对象（Trace/Generation/Span）各自记录**完整** input/output/metadata，字段见下。backend（langfuse/otel）原样落，不截断。

### 5.1 Trace（= run）

```typescript
interface TraceStart {
  id: string;                       // = runId
  sessionId: string;
  name?: string;                    // [v0.0.61] 由 LoopObservability.startTrace 拼：`${kind} ${sid6} ${input10}`（kind=opts.sessionKind ?? 'session'，sid6=sessionId.slice(0,6)，input10=首条 user 消息所有 TextBlock.text 拼接、`\s+`→单空格 trim 后 slice(0,10)；无 user 消息则空串，trailing 空格由 trimEnd 处理）。adapter 透传不兜底；type 仍 optional（其他 caller 可不传），但 v0.0.61 起 LoopObservability 恒传非空 name（兜底 'session'），故 langfuse UI 不再出现 unnamed-trace。
                                    // [v0.0.78.bug] 加第 4 参 modeKey（forked 用途标识）：modeKey 非空且 ≠ 'current' → kind 段拼后缀 `${kind}[${modeKey}]`（如 `studio-leader[summary] 01KWBPa3 helloworld` / `studio-leader[memory_extract] ...`）；modeKey 缺省 / ='current' → 退原格式（main loop 视觉零回归）。modeKey 段紧贴 kind 不加空格（与 sid6 间仍单空格分隔）。main loop 显式传 'current'（langfuse UI 区分 forked vs main 一目了然）；forked compact 用 'summary'、tier1 consolidation 用 'memory_extract'。
  input?: Message[];                // 触发本 run 的输入消息（= run_start.inputMessageIds 对应 message）
  output?: Message[];               // run 最终产出（endTrace 时填，含最后 assistant message）
  metadata: TraceMetadata;
}
interface TraceEnd {
  output?: Message[];                      // run 最终回答（= 最后一条 assistant message，loop 复用 endGeneration 已收到的 assistantMsg）
  metadata?: Partial<TraceMetadata>;       // { stopReason } 覆盖
}

interface TraceMetadata {
  runId: string;
  sessionId: string;
  parentSessionId?: string;         // P0 不建关联，字段预留（session_usage §6）
  agentName?: string;
  inputMessageIds: string[];        // run_start 传入
  modelId: string;                  // = modelConfig.modelId
  providerImpl?: string;            // e.g. "anthropic"
  protocolImpl?: string;            // e.g. "anthropic_messages"
  providerId?: string;              // [v0.0.353 T2] 真实 provider 实例 id（物理尝试的接入方实例；只进 metadata，不污染 SDK name）
                                    // [v0.0.353 T3] run 级快照填值：build-run-deps 构造 LoopObservability 时传 SessionConfig.providerId（启动时已 resolve 的 provider；可选不强制，未传跳过）
  providerName?: string;            // [v0.0.353 T2] 接入方标识（如 'anthropic_compatible'；只进 metadata，避免中文/特殊字符污染 SDK name）
  /** [v0.0.353 T5 D8] 生效路由方案（planId + planName）；logical gen / TraceMetadata 记录「当时生效方案」；有方案才带，无方案零行为变化（旧 trace 兼容） */
  routingPlan?: { planId: string; planName?: string };
  toolNames: string[];              // config.tools 的 name 清单
  systemPromptHash?: string;        // system prompt 内容 hash（追踪 prompt 变更影响）
  appVersion?: string;
  stopReason?: string;              // endTrace 填（= RunState.stopReason）
  tags?: string[];
}
```

### 5.2 Generation（= LLM 调用）—— 信息最密集

```typescript
interface GenStart {
  parent: SpanHandle | TraceHandle;
  model: string;                    // = modelConfig.modelId（physical：真实尝试 modelId，由 recordAttemptTarget 覆盖）

  /** [v0.0.353 T2] 真实 provider 实例 id（physical 尝试；只进 metadata）。
   * [v0.0.353 T3 A1] logical gen 显式传 null（真实信息下沉 physical 子 span；禁止 undefined 冒充"未填"） */
  providerId?: string | null;
  /** [v0.0.353 T2] 接入方标识（physical 尝试；只进 metadata，避免污染 SDK name）。
   * [v0.0.353 T3 A1] logical gen 显式传 null */
  providerName?: string | null;
  /** [v0.0.353 T3 A1] 业务视图标识：logical gen 标 true（providerId/providerName=null，model 保留 run 级 modelId 快照）；physical 不设 */
  logicalView?: boolean;
  /** [v0.0.353 T5 D8] 生效路由方案（planId + planName）。logical gen / TraceMetadata 记录「当时生效方案」；有方案才带，无方案零行为变化（旧 trace 兼容）。 */
  routingPlan?: { planId: string; planName?: string };

  /** 判别字段：logical（默认）| physical。v0.0.50 起一次 LLM 调用产两条紧邻 generation（同 step span，N 相同）。 */
  kind?: 'logical' | 'physical';

  /** logical 用（既有）：业务视图 messages + system + tools + params。
   * v0.0.50 起经 toLogicalMessages 展平——sender 已变文本前缀，与 LLM 真正看到的 input 一致。 */
  input?: GenInput;

  /** physical 用（v0.0.50 新）：protocol.encode 后的 wire body（任意形状）。
   * 仅 kind='physical' 时使用；logical 不读此字段。 */
  physicalInput?: unknown;

  /** 起始时间（既有） */
  startTime?: Date;

  /** generation 名称（v0.0.50）：logical=`llm-N-logical`，physical=`llm-N-physical`，N=iteration。
   * adapter 优先用 caller 传入的 name；未传时 fallback `llm`（logical）/ `llm-physical`（physical）。 */
  name?: string;
}
interface GenEnd {
  gen: GenHandle;
  output?: GenOutput;               // error 路径（status='error'）/ physical kind 可省略
  usage: Usage;                     // session_usage §1 全字段（token 拆分 + char + cost）；physical 传 {}（mapUsage 后 total=0）
  metadata: GenMetadata;
  status?: 'success' | 'error';     // 缺省 'success'（向后兼容）
  errorCategory?: string;           // status='error' 时填（LlmErrorCategory 字符串值；string 避免反向依赖 llm/caller）
}

interface GenInput {
  system: string;                   // assembled system prompt（完整内容）
  systemCharCount: number;
  messages: Message[];              // assembled snapshot 的 messages（完整，发往 LLM）
  messagesCharCount: number;        // = snapshot.inputCharCount
  tools: ToolDefinition[];          // = snapshot.tools（LLM 可调工具清单）
  params: GenParams;
  modelId: string;
  iteration: number;                // 第几轮 LLM 调用（全局）
}
interface GenParams { temperature?: number; topP?: number; maxTokens?: number; [k: string]: unknown }

interface GenOutput {
  message: Message;                 // LLM 返回的完整 message（含 text/reasoning/tool_call blocks）
  stopReason: string;               // LLM stop_reason（"stop"/"tool_use"/...）
}
interface GenMetadata {
  iteration: number;
  step: number;                     // 所属 step span
  cacheReadTokens: number;          // = usage.input_cache_read
  cacheWriteTokens: number;         // = usage.input_cache_write
  durationMs?: number;              // LLM 调用耗时（start→end）
  /** @deprecated v0.0.50 起停写——物理层 wire body 改走独立 physical generation（kind='physical' + physicalInput 载荷）。
   * 字段声明保留（optional，只读）以兼容旧 trace / 旧读取代码；写路径不再填。 */
  physicalWireBody?: unknown;
  errorCategory?: string;           // 仅 status='error' 写入
  retryChain?: RetryAttempt[];      // 重试链；仅 invoke 内多次 attempt 时非空
  /** [v0.0.353 T2] 真实 provider 实例 id（physical 写；logical 为 null，A1 治理：真实信息下沉 physical） */
  providerId?: string | null;
  /** [v0.0.353 T2] 接入方标识（physical 写；logical 为 null，只进 metadata 不污染 SDK name） */
  providerName?: string | null;
  /** [v0.0.353 T2] 真实尝试 modelId（physical 写；= recordAttemptTarget 上报的真实 model） */
  modelId?: string;
  /** [v0.0.353 T3] logical 视图标记：true = 此 generation 是 logical（业务视图），provider 相关字段置 null */
  logicalView?: boolean;
  /** [v0.0.353 T5 D8] 生效路由方案（与 GenStart.routingPlan 同源）；仅 D9 skipped gen 使用 */
  routingPlan?: { planId: string; planName?: string };
  /** [v0.0.353 T5 D9] 被跳候选标记：true 表示本条 generation 记录的是被跳过的候选，非真实 attempt */
  skipped?: boolean;
  /** [v0.0.353 T5 D9] 被跳原因（与 skipped 配套） */
  skipReason?: 'time_window' | 'disabled' | 'circuit_open' | 'banned' | 'resolve_failed' | 'probe_inflight';
}
interface RetryAttempt {
  providerId: string;
  keyRef?: string;
  attempt: number;                  // 1-based
  category?: string;                // 本次 attempt 的错误分类（成功 attempt 可省略）
  delayMs?: number;                 // 触发重试前的退避延时
}
```

> **input = 完整 LLM 输入，非「最后一条 message」**：GenInput.messages 是发往 LLM 的**全部** history（assemble 后的完整 snapshot）。最后一条 user message 只是本次请求**新追加的触发增量**，不是 input 全部。trace 记完整 history，事后可复现 LLM 真正看到了什么。

### 5.3 step Span（= iteration）

```typescript
interface StepSpanStart {
  parent: TraceHandle;              // step 直接挂 trace
  name: string;                     // `step ${N}`
  input?: { step: number };
  metadata: StepSpanMetadata;
}
interface StepSpanEnd { metadata?: Partial<StepSpanMetadata> }

interface StepSpanMetadata {
  step: number;                     // = RunState.step
  ingestUpTo: string | null;        // 本 step 起始游标（agent_loop §7）
  llmUpTo: string | null;
  newMessageCount: number;          // 本 step ingest 的新消息数
  hasToolCall: boolean;             // 本 step 是否含 tool 执行
}
```

### 5.4 tool Span（= 单次 tool 执行）

```typescript
interface ToolSpanStart {
  parent: SpanHandle;               // 挂 step span，或另一 tool span（深嵌套，见 §3）
  name: string;                     // `tool:${toolName}`
  input: ToolSpanInput;
  metadata: ToolSpanMetadata;
}
interface ToolSpanEnd {
  output: ToolSpanOutput;
  metadata?: Partial<ToolSpanMetadata>;
}

interface ToolSpanInput {
  toolCallId: string;               // ToolCallBlock.id
  toolName: string;
  arguments: Record<string, unknown>;   // 完整 tool call arguments（LLM 产出，原样）
}
interface ToolSpanOutput {
  result: ToolResultBlock;          // 完整 tool result（content 原样）
  isError: boolean;
}
interface ToolSpanMetadata {
  step: number;
  toolCallId: string;
  needsApproval: boolean;           // 工具 needsApproval 判定
  approvalStatus?: "pending" | "approved" | "rejected";   // HITL 状态
  durationMs?: number;              // [v0.0.354] 真实执行时长（start 逐个化：startTime=该 tool 串行开始时刻，不含批内排队等待）
}
```

## 6. ObservabilityAdapter 接口

```typescript
type TraceHandle = { kind:"trace"; id:string };
type SpanHandle  = { kind:"span";  id:string; parent: TraceHandle | SpanHandle };
type GenHandle   = { kind:"gen";   id:string; parent: SpanHandle | TraceHandle };

interface ObservabilityAdapter {
  startTrace(p: TraceStart): TraceHandle;
  endTrace(h: TraceHandle, p?: TraceEnd): void;

  startGeneration(p: GenStart): GenHandle;
  endGeneration(p: GenEnd): void;

  startSpan(p: StepSpanStart | ToolSpanStart): SpanHandle;   // parent 决定是 step 还是 tool
  endSpan(h: SpanHandle, p?: StepSpanEnd | ToolSpanEnd): void;

  shutdown(): Promise<void>;        // electron 关闭前 flush
}
```

- start/end 方法**同步**返回 Handle/void（loop 不 await observability，热路径零阻塞）；仅 `shutdown()` 异步。
- Handle.parent 携带父子关系（step→trace, gen/tool→step），backend 据此建树。

### 6.1 持有与注入

adapter per-session，经 `SessionConfig.observability` 注入（与 `tools` / `client` 同级，不可变共享实例）。注入实例 = `ObservabilityManager`（composite，实现 `ObservabilityAdapter`）；列表空/全 disabled → manager 持 0 child，所有方法 noop，等价 NoopAdapter。loop 用 `this.config.observability` 埋点，traceId=自身 `this.runId`；**对 manager 透明**（埋点代码零改动）。多 agent 各自 loop / 各自 trace / 各自标 sessionId；P0 不标 parentSessionId（独立 trace）。

## 7. 边界

| 零件 | 归属 |
|---|---|
| ObservabilityAdapter 接口 + 概念对齐 + 埋点契约 + **全量字段定义（Trace/Gen/StepSpan/ToolSpan 的 input/output/metadata）** + 注入契约 + NoopAdapter 语义 | 本文 ✅ |
| agent loop 在边界**调用** adapter（填全量字段） | agent_loop（引用本文契约） |
| Trace/Generation/Span 语义 + Session 聚合 | Langfuse 模型（langfuse_adapter 落地） |
| ObservabilityManager composite（fan-out + handle 映射 + 容错） | `observability_manager.md` |
| Langfuse SDK 接入 + 字段映射 + flush | `langfuse_adapter.md` |
| Usage / Message / ToolDefinition / ToolResultBlock 类型 | `../session/[P0]session_usage.md` / `../message/` / `../tools/` |

## 8. langfuse 作为验证 oracle

trace 树除「运维/成本观测」外，第二个用途：**作为验证 oracle**——api verifier 读 langfuse trace **独立断言「agent 做对了吗」**，而不只断「agent 跑了吗」。

### 8.1 oracle 前提（激活 — verify 踩坑固化）

**trace 必须真的被记**才能当 oracle，否则 langfuse API 返空。激活前提：

- server 不读 `LANGFUSE_*` env，只读 `app_config`（group=`runtime`, key=`observability`）的 `ObservabilityConfigItem` 列表。
- 列表空 / 全 disabled → `ObservabilityManager` 持 0 child → **等价 Noop，不记任何 trace** → oracle 无源。
- 运行中 PUT app_config observability **不热更新**（须重启 / 下个 session）。
- test env 须由 `tests/api/lib/langfuse_setup.sh::lf_ensure_observability` 幂等保一条 enabled 项，否则 server 全程 Noop。

### 8.2 oracle 三类

| oracle 类 | 断什么 | 数据源（langfuse） | 数据源（rocky） | 用例 |
|---|---|---|---|---|
| **内容一致性** | `trace.output`（最终 assistant message）== session 实际存的 assistant 回复（含 proof token） | `GET /api/public/traces/:runId`（取 `output`） | `GET /session/:id/messages` | `langfuse_session_content_tc1` |
| **工具结果保真** | `tool span.arguments/output` == 真实落盘文件内容（agent 工具产物的真凭实据） | `GET /api/public/observations/:id`（type=SPAN, name=`tool:*`） | 读文件 | `langfuse_tool_result_tc1` |
| **多轮 generation** | 两轮独立 trace / sessionId 贯穿 / 各轮 ≥1 generation / 轮2 tool span 含 token usage | `GET /api/public/sessions/:sessionId/traces` + 各 trace 下 generation/observation | （无独立数据源，纯 trace 树自洽） | `langfuse_multi_turn_tc1` |

### 8.3 可复用 lib + 流程嵌入

- `tests/api/lib/langfuse_verify.py`（trace 读取/字段断言 helper，被 4 用例复用）+ `provider_resolve.py`（解析真实 `data.id`）+ `langfuse_setup.sh`（observability 自保）。
- api-verifier 增「测完读 trace 验内容/结果一致性」步骤；e2e-verifier 增「工作做完检查 trace」提醒（e2e 截图判定不到 trace，仅提醒后端记录完整）。
