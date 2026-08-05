---
type: spec
title: Agent Loop — Base（机制层原语）
priority: P0
status: active
updated: 2026-07-20
since: v0.0.16
---

# Agent Loop — Base（机制层）

> 定位：所有 loop runKind（main=eager-drain / lazy-drain future / summary / consolidate 旁路 run）共享的**单轮执行积木 + 循环契约**机制库。v0.0.40 起统一骨架 `runReActLoop(spec)` 调用 base 原语（runKind 不再各写 while）。
> 参见：runKind 不变量 → `[P0]agent_loop_eager_drain.md`（main）/ `[P2]agent_loop_lazy_drain.md`（lazy future）/ `[P0]agent_loop_side_run.md`（旁路 run）；统一契约 → `[P0]agent_interface.md`；事件定义 → `[P0]agent_event.md`；中断 → `[P0]agent_interrupt.md`；埋点 → `../observability/[P0]observability_manager.md`；snapshot → `../context/[P0]context_snapshot_interface.md`；**LLM 调用编排 → `../llm_caller/[P0]llm_caller_overview.md`**。

---

## 1. 定位与边界

`agent_loop_base` 是**机制库**，不是可执行 loop。它提供「一轮 LLM 调用 + 流式 + tool 执行 + emit + 中断检查」这些**与 runKind 无关**的积木；**消息从哪来、写不写 store、压不压缩、状态机怎么转**这些**驱动/编排/策略**归各 runKind。

**为什么分层**：单轮机制相同 → 抽 base 原语；v0.0.40 起统一骨架 `runReActLoop` 调 base，runKind 差异全在 RunSpec 字段 + RunLifecyclePort（v0.0.204 合并的单 port，按 profile.runShape 字段分派）。

### 1.1 两个正交维度：persistence × drain timing

runKind 是「持久化维度」与「drain 维度」的笛卡尔积切片：

| 维度 | 取值 | 区分点 |
|------|------|--------|
| **持久化维度** | 主对话 loop（main：写 store / 转状态机 / 计 usage / compact） vs **旁路 run**（summary/consolidate：内存 buffer、不持久化、不发主对话消息、无 transcript） | 是否影响主 session 数据 |
| **drain 维度** | **eager**（同 1 个 run 内每轮 iteration 开头都 drain inbox） vs **lazy-drain**（run 内不 re-drain；run 结束时若 inbox 非空则一次性 drain 全部并启动新 run；整个 loop 跨多个 run） | 多久把 inbox 里的新消息拿出来一次 |

当前已落地的 runKind：

| runKind | 持久化 | drain | 典型场景 | 文件 |
|---------|--------|-------|---------|------|
| **main**（eager-drain） | 主对话 loop（全副作用） | eager（每轮 ① drain） | 主对话 ReAct，用户可在 tool 执行中途插话 | `[P0]agent_loop_eager_drain.md` |
| **lazy-drain**（future） | 主对话 loop（全副作用） | lazy（run 内不 re-drain，run 结束后若 inbox 非空启新 run） | 严格「一批输入对一批输出」的对话节奏 | `[P2]agent_loop_lazy_drain.md`（概念未落地，代码零实现） |
| **summary / consolidate**（旁路 run） | 旁路（内存 buffer，无持久化） | 不消费 inbox（拿快照） | compact summary / memory consolidation 等旁路任务 | `[P0]agent_loop_side_run.md` |

> 「旁路 + lazy-drain」是空格——旁路 run 不消费 inbox，自然没有 drain 维度。

### 1.2 base vs runKind 分工

| base 提供（机制） | runKind 负责（编排/策略） |
|------------------|----------------------|
| callLLM 原语（流式 + emit + 聚合 message/usage） | 消息驱动模型（main 每轮 drain inbox / 旁路 run drainMode='none' 读 buffer） |
| executeTools 原语（+ allowedTools 门控 + emit） | 副作用策略（ingest 写 store / 追加内存 / 累计 usage / 转状态机 / compact） |
| isInterrupted 原语（controller 检查） | 中断语义（条件判定 / 收尾责任，见 §5） |
| checkDoomLoop / checkMaxIter 原语 | 循环编排（v0.0.40 前各 runKind 写 while；v0.0.40 后统一骨架调 base，runKind 差异在 RunSpec 字段） |
| Event 产出契约（group + 各阶段事件） | group 选择（main=`session_id:<sid>_amt:main` / 旁路=`session_id:<sid>_amt:<runKind>`，详见 [P0]agent_interface.md §5） |
| RunState 共享字段 + StopReason 全集 | RunState 游标扩展（store 游标 / 内存游标） |

> **D1（design §4）**：base 提供原语函数；v0.0.40 前 runKind 各写 `while` 调用，v0.0.40 后统一骨架 `runReActLoop` 调 base。不用模板方法（runKind 循环结构差异大，模板方法会让钩子爆炸）。
>
> **统一骨架（v0.0.40 起）**：main/旁路共用一份 `runReActLoop(spec)` 骨架（见 `[P0]agent_loop_unified.md`），runKind 差异下沉为 RunSpec 字段 + RunLifecyclePort + emit（v0.0.49 删 ContextPort/FinalizePort 后 = 单 LifecyclePort 含 onInterrupted + emit + observability；v0.0.204 合并 Main/Forked LifecyclePort 为单 RunLifecyclePort）。`AgentLoop` / `ForkedLoop` 类的 `while` 编排退役；base 原语本身**不变**（callLLM / executeTools / extractToolCalls / checkDoomLoop / checkMaxIter / controller.aborted 仍是骨架调用的积木）。runKind 特有不变量（store 游标 / append-only 保缓存 / 五态机）保留在各 runKind spec。

---

## 2. 单轮执行原语

base 的两个核心原语。**它们只执行 + emit，不 ingest / 不写 store**（副作用归 mode）。**v0.0.49 起骨架直调**（不再经 callLLMForMain/callLLMForForked 包装层——已删）：`runReActLoop` 骨架直调 `base.callLLM`，差异（`backgroundPath` / `modeKey` / `stop` / `maxOutputTokens` 等）由 RunSpec 字段透传，骨架不再经 hook 间接调用。

### 2.1 `callLLM`（流式 LLM 调用）

```typescript
interface CallLLMInput {
  modelId: string;
  messages: CanonicalMessage[];     // 已组装（eager-drain=assemble 产出；forked=内存 buffer 组装）
  tools?: ToolDefinition[];          // toolDefinitions（缓存契约，原样传 LLM）
  controller: AbortController;       // mode 注入的内存 controller { runId, aborted }（agent_interrupt §1.1）
  emit: (e: AgentEvent) => void;     // mode 注入的 emit（决定发哪个 group / 是否发）
  observability: ObservabilityPort;  // 埋点端口
  maxOutputTokens: number;           // 输出预算（snapshot.contextWindowUsage.maxOutputTokens）→ wire max_tokens
  /** RunState 引用（读 llmErrorState 跨 iteration overlay） */
  runState: LoopStateBase;
  /** 后台路径标记（true=overload 直接 fail 不重试，防雪崩） */
  backgroundPath?: boolean;
}
interface CallLLMResult {
  assistantMessage: Message;         // 聚合所有 text/tool block
  usage: Usage;                      // per-call usage（caller 决定累不累计）
  rawStopReason: ProtocolStopReason; // protocol 原始（no_tool_call 判定由 caller）
}
async function callLLM(input: CallLLMInput): Promise<CallLLMResult>
```

**契约**：
- 流式产出事件：`message_start` → `text_block_*` / `reasoning_block_*` / `tool_call_*` → `usage_block` → `message_end`（事件定义见 agent_event §4-§5）
- **每条 emit 前检查 `controller.aborted`**，命中即停止流式、不再 emit（中断生效点）
- **流式 chunk 循环中断**：callLLM 局部创建 Web AbortController（`const webAbort = new AbortController()`），fetch 用 `webAbort.signal`；流式 chunk 循环每个 chunk 检查 `controller.aborted`，命中即 `webAbort.abort()` + break 停止读后续 chunk。webAbort 随 callLLM 生灭（局部作用域），**controller 保持纯 `{runId, aborted}`，不派生 Web AbortSignal**。fetch 等待期（chunk 循环前）的 abort 接受短暂延迟——第一个 chunk 到达后 chunk 循环立即生效

```typescript
async function callLLM(input) {
  const webAbort = new AbortController();        // 局部，随 callLLM 生灭
  const stream = await client.stream(req, webAbort.signal);
  for await (const chunk of stream) {            // chunk 循环
    if (input.controller.aborted) {              // 每个 chunk 检查内存位
      webAbort.abort();                          // 打断 fetch、释放连接
      break;                                     // 停止读后续 chunk
    }
    // 处理 chunk + emit
  }
}
```
- system 不在此组装——`messages` 内已含（eager-drain 由 system_prompt 链构建进 snapshot.System；forked 由 snapshot.system prepend，见 forked §system 注入）
- usage 返回给 caller；**base 不调 accumulateUsage**（caller=eager-drain 累 current 分区 / forked 累 forked 分区 / 或不累）
- **wire `max_tokens` 必须非 0**：`input.maxOutputTokens`（输出预算）透传到 `CanonicalRequest.params.maxTokens`，由 protocol encode 成 wire `max_tokens`。**禁止漏传**——encode 兜底为 0 会被严格 provider（volcengine ark / 原生 anthropic）按字面截断成 0 输出（`stop_reason:"max_tokens"`、无内容）；宽松 provider（minimax）容忍 0 掩盖该 bug。caller（eager/forked）从 `snapshot.contextWindowUsage.maxOutputTokens` 注入。

**callLLM 内部走 `llmCaller.invoke(req, ctx)`**（错误归一化 + adaptive retry + provider 降级 + 分阶段超时 + length 处理收口到 LlmCaller，见 `../llm_caller/[P0]llm_caller_overview.md §4`）：
- callLLM 组装 `baseReq: CanonicalRequest`（messages + tools + params）+ `ctx: InvokeContext`（errorState / controller / observability / backgroundPath / `onEvent` 转发到 `input.emit`）。LlmCaller 内部消费 stream，通过 `ctx.onEvent` 回调转发 StreamEvent（保留 mode 的 group 选择责任）。
- catch 块 throw `ClassifiedLlmError`（带 category，agent loop 据此决定 stopReason / emit）。LlmClient（4 件套）不动，仍由 LlmCaller 持有句柄调 `client.stream`。

### 2.2 `executeTools`（工具执行 + allowedTools 门控）

```typescript
interface ExecuteToolsInput {
  toolCalls: ToolCallBlock[];
  allowedTools: string[];            // 执行门控白名单（tool name 集合）
  execContext: ToolExecContext;       // mode 注入的执行上下文（config 等）
  controller: AbortController;       // mode 注入的内存 controller { runId, aborted }
  emit: (e: AgentEvent) => void;
  observability: ObservabilityPort;
}
async function executeTools(input: ExecuteToolsInput): Promise<ToolResultBlock[]>
```

**门控逻辑（D3 tool 双维度的执行侧）**：
- `toolCall.name ∈ allowedTools` → 交 toolEngine 执行，产出真实 result
- `toolCall.name ∉ allowedTools` → **不执行**，构造 `not-allowed` tool_result（role=tool，content=`[{type:"text", text:"工具 '<name>' 在当前会话不允许调用，请仔细阅读任务说明，不要再次尝试调用该工具"}]`）喂回 LLM
  - 多轮 loop 下 LLM 下一轮看到 not-allowed 结果，可自我修正换思路
  - eager-drain 的 `allowedTools` = 全集（= toolDefinitions 的 name 集合）→ 等价不过滤
  - forked 的 `allowedTools` = option 白名单 → 拦截
- **每个 tool step 前检查 `controller.aborted`**（已在执行中的工具不可中断，见 agent_interrupt §4 场景 B/C）
- emit `tool_result_start → delta* → end`；result 返回给 caller 决定 ingest / 追加内存
- **HITL 悬挂**：底层 `ToolExecutionEngine.execute` 返签名改 `{ results, pending }`（悬挂型 tool 经 `Tool.interaction()` 钩子产 pending wrapper 不真跑 run）；`executeAndEmit` 包装层透传 pending 给 caller（runReActLoop ③ 段据 pending.length>0 决定 StopReason=tool_pending + 落盘 + suspended）。详见 `../tools/[P0]tool_execution_engine.md §4/§5` + `agent_hitl.md §1`。
- **HITL 回填路径也 emit**：占位 pending block 首发时经本原语 emit 三帧；后续 tool_reply 回填**重新执行/编辑**该 block（`handleToolReply` 走 prepareStage 而非本原语）后，同样补发 tool_result 三帧（`emitToolResult`，与本原语 emit 同构）。emit 不是「正常执行路径专属」——凡 tool_result block 内容变更（首发 / HITL 回填后编辑）都须 emit，否则前端停留旧态。详见 `agent_hitl.md §2 INV-8`。

---

## 3. tool 双维度（缓存契约 ↔ 行为契约）

两正交维度，是 forked「保缓存 + 限行为」的关键：

| 维度 | 含义 | 决定 | 影响 |
|------|------|------|------|
| `toolDefinitions` | 传 LLM 的工具**声明** | mode（eager-drain=config.tools；forked=**复用主对话**） | **缓存命中**（与主对话一致才命中；变则从 tools 之后失效） |
| `allowedTools` | 执行**门控**白名单 | mode（eager-drain=全集；forked=白名单） | **行为限制**（哪些 tool_call 真执行） |

> forked 复用主对话 toolDefinitions 保证缓存前缀一致（system+tools+messages），同时用 allowedTools 收窄执行——对外声明不变、对内执行受限。这是绕过「子集 vs 独立工具」权衡的设计。

---

## 4. RunState 基础结构

base 定义**共享字段**；游标由 mode 各自扩展（D2）：

```typescript
interface LoopStateBase {
  step: number;                       // 当前迭代步数
  done: boolean;                      // 是否退出
  stopReason?: StopReason;            // 退出原因（§9）
  snapshot: ContextSnapshot | null;   // 当前上下文（eager-drain=assemble 产出；forked=内存组装）
  lastAssistantContent?: ContentBlock[]; // ②→③ 传递，避免反查 snapshot
  /** LLM 错误状态（跨 iteration 继承的 overlay）—— 见 ../llm_caller/[P0]llm_request_config.md §2 */
  llmErrorState: LlmErrorState;
}
```

**llmErrorState 字段说明**：跨 iteration 继承的 overlay（maxTokensOverlay / precompress / prefillPartial / consecutiveContextLength / lastError / partialResult），供 LlmCaller.buildRequest 读它算实参。schema 完整定义见 `../llm_caller/[P0]llm_request_config.md §2`。RunState 是 per-run 的（run 结束销毁），llmErrorState 随之销毁——**不随 session 落盘**（arch 决定：重启后清空，理由见 `../llm_caller/[P0]llm_caller_overview.md §6.3`）。

mode 扩展：
- **eager-drain**：`+ ingestUpTo / llmUpTo`（store 游标，不变量 `llmUpTo ≤ ingestUpTo`，见 eager_drain §游标）
- **forked**：`+ messages buffer`（内存追加，无 store 游标，见 forked §内存模型）

---

## 5. 中断原语

```typescript
// AbortController：自定义内存对象（非 Web API），由 AgentManager 在 activate 时创建并注入 loop
interface AbortController {
  runId: string;    // 目标 runId，AgentManager.abort() 校验匹配后才置位
  aborted: boolean; // 内存布尔位；置 true 后 loop 下一个检查点立即停
}
function isInterrupted(controller: AbortController): boolean  // = controller.aborted
```

> 定义同 `[P0]agent_interrupt.md §1`。base 只提供单一读取原语；**判定 + 收尾因 mode 不同**（caller 负责）：

| runKind | 判定 | 收尾 |
|---------|------|------|
| **main**（eager-drain） | `controller.aborted`（单一内存检查，O(1)） | 被 abort → **不收尾**（abort api 接管，见 agent_interrupt §2-§3）；正常/error → markIdle/markError |
| **lazy-drain**（future） | `controller.aborted`（同 main） | 同 main |
| **summary / consolidate**（旁路） | `controller.aborted`（同 main，controller 由 AgentManager.sideRun 创建注入） | 被 abort → **直接退出无收尾**（无副作用可收，D4；不走 4 步，见 agent_interrupt §3.0） |

> controller 由 AgentManager 创建持有并注入 loop（生产-持有-触发见 agent_interrupt §1.1）。main/lazy 走主 session 的 abort api 4 步收尾（有持久化 half-data 需补全）；旁路 run 默认无副作用，被中断直接丢弃内存 buffer 退出、不走 4 步。

---

## 6. 退出检查原语

```typescript
function checkDoomLoop(toolCalls, recentSigs: string[]): boolean  // 连续 N(=3) 轮同签名
function checkMaxIter(step: number, maxIter: number): boolean     // step >= maxIter
```

- `maxIter` 由 caller 传：eager-drain = `config.maxIterations ?? 25`；forked = `option.maxIter`（**=1 即单次 call 快路径**，>1 多轮）
- 命中任一 → mode 置 `done=true` + 对应 stopReason
- **`checkMaxIter` 判定点在轮次边界（④ Exit Check 的 `state.step++` 之后）**——一轮 = LLM 调用→工具执行→tool_result 落盘；判定落在完整轮末尾，保证**凡落盘的 tool_use 必有配对 tool_result**（消灭 dangling 半轮），且第 `maxIter+1` 次 LLM 调用不再发生。off-by-one：`step` 从 0 起、每轮末 `++`，`step>=maxIter`，故 `maxIter=25` 恰 25 完整轮后停。原语本身（`step>=maxIter`）不变，仅调用位置从「② callLLM 后、③ 执行前」迁到轮次边界（骨架伪码见 `agent_loop_unified.md §2`）。

---

## 7. Event 产出契约

base 定义「loop 该产出哪些事件、何时产出」；**group 由 mode 选**（emit 函数 mode 注入）。

### 7.1 group 约定

| mode | group | 说明 |
|------|-------|------|
| eager-drain | `session_id:<sid>_amt:current` | 主对话流，消费者经 AgentManager.subscribe 订阅 |
| lazy-drain | `session_id:<sid>_amt:current` | 主对话流（同 eager 共用 current group） |
| forked | `session_id:<sid>_amt:<modeKey>` | **future（forked 当前 emit 关闭）**；独立 group，不污染主对话（D5）；modeKey=summary/memory_extract；option 关 emit 则不发任何事件 |

### 7.2 各阶段产出事件

| 阶段 | 事件 | 说明 |
|------|------|------|
| run 开始 | `run_start` | loop 启动一次 |
| LLM 流式 | `message_start` → `text_block_*` / `reasoning_block_*` / `tool_call_*` → `usage_block` → `message_end` | callLLM 产出 |
| 工具执行 | `tool_execution_start` → `tool_result_start` → `tool_result_delta*` → `tool_result_end` → `tool_execution_end` | ③ 段 execute 前后 emit `tool_execution_start/end`（阶段边界）；中间各工具 result 流（含 not-allowed result） |
| run 结束 | `run_end` | loop 退出一次（forked 若开 emit 才发） |

> enqueue 级事件（`message_enqueued` / `enqueued_message_processed` / `enqueued_message_canceled`）是 **eager-drain 独有**（inbox 驱动），见 eager_drain §cancel 配对，**不在 base**。

### 7.3 事件流时间线

```
run_start
  ├─ message_start (LLM 轮 1) → ... → message_end
  ├─ tool_result_start/delta/end
  ├─ message_start (LLM 轮 2) → ... → message_end (no tool call)
run_end (stopReason: "no_tool_call")
```

（eager-drain 在 ① 额外产出 user query / enqueued 消息事件，见 eager_drain §emit。）

---

## 8. observability 埋点契约

loop 是 observability 唯一 producer，在边界调 `observability.*`（默认 NoopAdapter 零成本）：

| 边界 | 调用 |
|------|------|
| `run_start` / `run_end` | `startTrace` / `endTrace(metadata.stopReason)` |
| 每 iteration | `startSpan("step N")` … `endSpan` |
| callLLM 前/后 | `startGeneration` / `endGeneration`（model + 完整 input/output + usage） |
| executeTools 前/后 | `startSpan("tool:…")` / `endSpan`（完整 arguments/result） |

generation / tool span 的 parent = 所属 step span。埋点契约 + 全量字段见 `../../observability/[P0]overall.md §4/§5`。

---

## 9. StopReason 联合（base 定义全集）

```typescript
type StopReason =
  | "no_tool_call"      // LLM 无 tool call，回复完成（forked 单次主路径）
  | "no_new_messages"   // 无新消息（eager-drain 准入失败）
  | "max_iterations"    // 超最大迭代（forked maxIter=1 触发即单次终结）
  | "doom_loop"         // 死循环检测
  | "error"             // 执行错误
  | "tool_pending"      // 通用悬挂退出：tool 串行执行遇悬挂型(interaction()返非null)→生成 pending result+入 pendingToolCalls 队列→loop 退出+session=suspended。ask-question 首消费者，未来 tool-approval 共用
  | "interrupted";      // 被 abort（eager-drain 由 abort api emit；forked 直接退出）
```

- **eager-drain** 用全集
- **forked** 主要用：`no_tool_call`（正常）/ `max_iterations`（多轮到顶）/ `error` / `interrupted`

### 9.1 Run error 字段（stopReason="error" 时携带 RunErrorInfo）

```typescript
interface RunErrorInfo {
  errorCategory: LlmErrorCategory;   // LlmErrorCategory 枚举值（19 值，见 ../llm_caller/[P0]error_normalization §1）
  displayReason: string;             // 用户可读理由（从 category 派生，见映射表）
  errorDetail?: string;              // 完整细节（raw provider message，给 tooltip / log）
}
```

**run 收尾逻辑**：agent loop run 主循环 catch 到 `ClassifiedLlmError`（来自 LlmCaller.invoke throw）→ 判定：
- `category === ABORTED_BY_USER` → `stopReason="interrupted"`（用户 abort 走 interrupted，不走 error；不填 RunErrorInfo）。
- 其他 category → `stopReason="error"` → `Run.error = { errorCategory: err.category, displayReason: deriveDisplayReason(err), errorDetail: err.rawError?.message ?? err.message }`。

**落点**：RunErrorInfo 是 Run/RunRecord 的可选字段（仅 stopReason="error" 时存在）；eager-drain 落 SessionStore 持久化（`GET /session/:id` 可读 currentRun.error / 历史 run.error），forked 不落（旁路，仅 emit / log）。

**完整收尾伪代码 + errorCategory→displayReason 映射表 + SSE error 事件形态** 见 `specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md §1 §3`（权威定义）+ `specs/api/version_logs/v0.0.25/change_log.md §1.2 §1.5`。

## 10. （版本史见 `log.md`）
