---
type: spec
title: Tool Execution Engine（串行执行引擎）
priority: P0
status: active
updated: 2026-08-13
since: v0.0.8
---

# Tool Execution Engine（串行执行引擎）

接收 `ToolCallBlock[]` → **串行**逐个执行 → 产出 `ToolResultBlock[]`。调度 / 超时 / 错误 / allowedTools 白名单门控 / 人工审批钩子（needs_approval，**当前引擎恒跳过**，见 §5）。
消息形态见 `../message/[P0]agent_message_interface.md`（ToolCallBlock §4.6 / ToolResultBlock §4.7 / ApprovalResultBlock §4.10）；agent loop ③ 工具调用阶段见 `../agent_interface_and_loop/[P0]agent_loop_eager_drain.md`；工具体系总览见 `index.md`。

## 1. 概述

工具执行引擎是 agent loop ③ 的核心。LLM 产出一批 `ToolCallBlock`（在一条 assistant message 里），引擎**串行**逐个执行，每个产出对应的 `ToolResultBlock`，回灌对话供 LLM 下一轮看到。

**串行**：一次只执行一个工具调用，`await` 完成才下一个。不做并发（避免文件竞争 / 资源冲突 / 顺序依赖问题）。工具一律在**主线程**执行（v0.0.345 撤 worker pool 后无线程池分流）；工具层 fs 操作一律 `node:fs/promises` 真异步（libuv 线程池，避免大 grep/read 阻塞 event loop），但批内串行顺序不变。

## 2. 核心类型

```typescript
// ToolDefinition（给 LLM 的声明：name + description + inputSchema + 可选 intro）权威定义见 app/server/src/tools/types.ts
// [v0.0.146] intro?: string —— 一句话短简介，供 system prompt Tool Guidance 用（tool_guidance mapper 优先 intro、fallback description）；
//   完整 description 仍由 tool schema（snapshot.tools → LLM function calling）传递，消除 system prompt 与 tool schema 冗余。

/** 工具实现：引擎执行的实际对象，从 config.tools 按 name 取 */
interface Tool {
  definition: ToolDefinition;
  /** per-tool 默认超时（ms，可选）。engine.runTool 三层超时解析的第二优先级
   *  （per-call `call.arguments.timeout` > 本字段 > engine 兜底默认 30s），封顶 600s（§4.2）。
   *  未声明 → 沿用 engine 默认 30s；仅声明数值，不改 run 逻辑（超时由 engine 层 race 控制）。 */
  defaultTimeoutMs?: number;
  /** [v0.0.101] 是否悬挂型 + 怎么处理回填（取代旧 needsApproval）。
   *  返非 null = 悬挂型：引擎不真跑 run、生成 pending 占位 result（status='pending'）+ 入 pendingToolCalls 队列 → loop StopReason=tool_pending 退出 + session=suspended。
   *  返 null / 不实现 = 普通 tool 立即 run。*/
  interaction?(input: ToolInput, ctx: ToolCtx): ToolInteraction | null;
  /** [v0.0.101] 仅 handleType=callback 需要：回填进 inbox 后 pre-process 调它返回 result（编辑进占位 block）。
   *  direct_result/approval 不实现（direct_result=payload 序列化即 result；approval=补跑 run）。*/
  onReply?(payload: unknown, ctx: ToolCtx): Promise<ToolRunResult>;
  /** 执行（串行，引擎 await）；返回结果内容 + 是否出错 */
  run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult>;
}

/** [v0.0.101] 悬挂型 tool 的交互声明（interaction() 返回值） */
interface ToolInteraction {
  subType: "need_feedback" | "need_approval";        // 渲染分发 key（前端弹什么 UI：提问卡 / 审批卡）
  handleType: "direct_result" | "approval" | "callback"; // 回填处理分发 key（pre-process 怎么编辑 block）
  data: FeedbackData | ApprovalData;                  // 交互载荷（tool 给，前端渲染用）
}

type ToolInput = Record<string, any>;   // 对应 ToolCallBlock.arguments

interface ToolRunResult {
  content: ContentBlock[];              // 结果内容（通常是 TextBlock，可含 ImageBlock 等）
  isError: boolean;                     // 是否执行出错（→ ToolResultBlock.isError）
}

/** 执行上下文（引擎构造，传给 tool.run） */
interface ToolCtx {
  config: SessionConfig;                // session 配置（sessionId / 工作目录 / 权限等）
  signal?: AbortSignal;                 // 取消信号：runTool 内每次真实 run 建 per-tool AbortController 赋值（§4.2）
  workdir: string;                      // config.workdir 快捷引用（bash 默认 cwd 基址）
  readSet?: Set<string>;                // 跨工具 read 跟踪集（file_op 共用）
  childRegistry?: ChildProcessRegistry; // run 级子进程注册表（bash 等 spawn 型工具注册子进程，供 run 终止级 sweep，§4.2）
  /**
   * [v0.0.157] 当前 LLM tool_call 的 id（截图落盘命名用）。
   * engine per-call 从 `ToolCallBlock.id`（call.id）注入（唯一注入源）；snapshot-store.saveSnapshot
   * 消费：文件名 `<toolCallId>.<ext>` 确定性（INV-157-2，record/replay 下 LLM stub 返相同 id →
   * 路径稳定，避 stub 漂移）。可选字段：外部 mock 跳过 engine 时缺省 → saveSnapshot fallback
   * `'unknown-'+Date.now()` 并 warn（仅 dev 诊断，不影响主路径）。
   */
  toolCallId?: string;
}
```

> `ToolDefinition` 是「声明」（给 LLM），`Tool` 是「实现」（给引擎）。`Tool[]` 由 `SessionConfig.tools` 持有（单一源，见 overall §3）；引擎从 `config.tools` 按 `definition.name` 路由，assemble 用 `config.tools.map(t => t.definition)`。

## 3. 引擎接口

```typescript
interface ToolExecutionEngine {
  /**
   * 串行执行一批 tool_call，产出对应 tool_result。
   * - 逐个执行（for...of + await），顺序与 toolCalls 一致
   * - 每个结果顺序对应 toolCalls[i]（按 toolCallId 关联）
   * - allowedTools 白名单门控：undefined=全集（向后兼容 eager）；
   *   非 undefined 时 toolCall.name ∉ allowedTools → 不执行，返拒绝 result（isError=true，[v0.0.48] 统一 code `tool_not_allowed`，见 §3.1）
   * - [v0.0.101 breaking] execute 返签名从 `Promise<ToolResultBlock[]>` 改 `Promise<{ results: ToolResultBlock[]; pending: PendingToolCall[] }>`
   *   （悬挂型 tool 经 §5 interaction 钩子产 pending wrapper；caller=runReActLoop ③ 据 pending.length>0 决定 StopReason=tool_pending）
   */
  execute(config: SessionConfig, toolCalls: ToolCallBlock[], allowedTools?: string[]): Promise<{ results: ToolResultBlock[]; pending: PendingToolCall[] }>;
}
```

> `allowedTools` 参数（v0.0.15 T4 加）：`undefined`=全集（eager 默认）；`[]`=NO_TOOLS 全拦（forked summary）；非空=按白名单过滤。同一批 execute 内共享一个 `config._readSet`（跨工具 read→write/edit 链生效，见 §4）。
> **[v0.0.48]** `allowedTools` 内容由 `resolveTools()` 单方法产出（`[P0]tool_policy.md §3`），不再由 `scope-allowed-tools.ts:deriveAllowedTools` 派生。

### 3.1 统一拒绝错误（[v0.0.48] — 合并 engine.ts:89 + engine.ts:146-158）

**问题**：v0.0.48 前两条拒绝路径不统一：
- `engine.ts:146-158 notAllowedResult`（Layer C 白名单外）：中文 `isError` 文本，**无错误码**
- `engine.ts:89`（Layer B 未注册）：`[unknown_tool] unknown tool: <name>`

LLM 看到两种文案，识别「这工具不能调」的认知成本高。PRD §3.3 收口为一条带稳定 code 的路径。

**决策**：

| 项 | 决策 |
|---|---|
| **code 命名** | `tool_not_allowed`（PRD §3.3 候选采用） |
| **文案模板** | `[tool_not_allowed] Tool '<name>' is not allowed in this session (<reason>).` |
| **reason 短语** | `not in whitelist`（白名单外）/ `not registered`（未注册工具名）/ `not in forked whitelist`（forked 零工具场景） |
| **进 errorInfo？** | **不进**——ToolResultBlock.isError=true + content[0].text 已含 `[tool_not_allowed]` 前缀（机读 + 人读兼容）；不引入额外 errorInfo 字段（保持轻量） |
| **language** | 英文 code + reason；移除中文 `notAllowedResult` 文案（v0.0.15 T4 历史中文文案 retire） |

**改造后 engine.execute 拒绝分支伪码**（替代现 `notAllowedResult` + executeOne line 88-90 unknown_tool 两处）：

```
execute(config, toolCalls, allowedTools?):
  ...
  for call of toolCalls:
    // ① Layer C：allowedTools 白名单门控
    if (allowedSet !== undefined && !allowedSet.has(call.name)):
      results.push(rejectToolCall(call, 'not in whitelist')); continue
    // ② Layer B：resolve（按 name 从 config.tools 路由）
    tool = resolveTool(config.tools, call.name)
    if (!tool):
      results.push(rejectToolCall(call, 'not registered')); continue   // ★ [v0.0.48] 统一 code（不再用 unknown_tool）
    // ③ validate + run + wrap（不变，见 §4）
    ...

/** 统一拒绝 helper（替代 notAllowedResult） */
rejectToolCall(call: ToolCallBlock, reason: string): ToolResultBlock {
  return {
    type: 'tool_result',
    toolCallId: call.id,
    content: [{ type: 'text', text: `[tool_not_allowed] Tool '${call.name}' is not allowed in this session (${reason}).` }],
    isError: true,
  }
}
```

**调用方影响**：调用方（agent loop / forked loop / API test）按 `isError=true` 判定的逻辑不变；按文本前缀 `[tool_not_allowed]` grep 的测试需更新断言（旧断言匹配「工具.*不允许调用」中文或 `[unknown_tool]`）。

> `ToolErrorCode.UNKNOWN_TOOL` 常量保留（其他场景仍可能用），但 engine.execute 路径不再产出该 code——所有不在 allowedTools 或未注册的 toolCall 统一产 `tool_not_allowed` 文本（无独立 errorInfo code）。

## 4. 串行执行流程

```
// [v0.0.101 breaking] execute 返签名从 ToolResultBlock[] 改 {results, pending}
execute(config, toolCalls, allowedTools?, ctx?):
  results: ToolResultBlock[] = []
  pending: PendingToolCall[] = []
  if (!config._readSet) config._readSet = new Set<string>()       // 跨 execute 共享 read 跟踪
  sharedReadSet = config._readSet
  allowedSet = allowedTools === undefined ? undefined : new Set(allowedTools)
  for call of toolCalls:                                          // 串行，逐个
    if (allowedSet !== undefined && !allowedSet.has(call.name))
      results.push(rejectToolCall(call, 'not in whitelist')); continue  // [v0.0.48] 统一 `tool_not_allowed` code，见 §3.1
    result, p = await executeOne(config, call, sharedReadSet, ctx)
    results.push(result)
    if (p) pending.push(p)                                        // [v0.0.101] 收集悬挂 wrapper（一次性收集，不逐个退出）
  return { results, pending }

executeOne(config, call, sharedReadSet, ctx?):
  1. resolve:  tool = config.tools.find(t => t.definition.name === call.name)
     ↓ 未注册 → **[v0.0.48]** rejectToolCall(call, 'not registered')（统一 code `tool_not_allowed`，见 §3.1）
  2. validate: 按 tool.definition.inputSchema 校验 call.arguments（轻量：必填 + primitive 类型，不引 ajv）
     ↓ 不符 → ToolResultBlock(isError=true, 校验错误描述)
     2a. default-fill **[v0.0.68 R5 / D5]**: validate 通过后，遍历 schema.properties，对 `obj[k] === undefined && sub.default !== undefined` 的字段注入 `obj[k] = sub.default`（详见 §4.1）
  3. [v0.0.101] interaction 分流（取代旧 needsApproval）:
     const interaction = tool.interaction?.(input, ctx)
     ↓ 返 null（或 tool 未实现 interaction）→ 走 step 4 正常 run
     ↓ 返非 null（悬挂型）→ buildPendingResult(call, interaction) 产出:
         - 占位 ToolResultBlock { status:'pending', content:[人话占位], subState, data }
         - PendingToolCall wrapper（sessionId/runId/toolCallId/toolName/handleType/subState/data/resultMessageId/resultBlockIndex 占位，后两字段由 caller ingest 后回填）
       return { 占位 block, pending wrapper }（不调 run）
  4. run（仅 interaction 返 null 时执行）: runTool(call, tool, ctx, effectiveTimeoutMs)
     effectiveTimeoutMs = resolveEffectiveTimeout(call.arguments.timeout, tool)（三层超时，§4.2）
     runTool 内：建 per-tool AbortController → ctx.signal；Promise.race([tool.run(input,ctx), backstop timer]）
       ↓ backstop 命中（timer=min(effective+GRACE,600000)）→ controller.abort()（触发工具真实清理）+ 返
         `[timeout] <name> exceeded <ms>ms (engine backstop)` isError result（不留 dangling tool_use）
       ↓ 正常 resolve（含工具自产 isError=true）→ 原样透传不吞；finally clearTimeout
       ↓ 抛错 → ToolResultBlock(isError=true, RUNTIME_ERROR)
  5. wrap:     return { ToolResultBlock { toolCallId: call.id, content, status:'success'|'fail'(按 isError), isError }, pending: null }
```

**关键**：
- **顺序保证**：results[i] 对应 toolCalls[i]（按 toolCallId 关联）；串行执行不重排。
- **失败不中断**：单个工具失败（isError）不中断整批，产出 isError=true 的 ToolResultBlock 继续下一个（LLM 下轮能看到错误并自行处理）。
- **sharedReadSet 跨工具 read 跟踪**：同一批 execute 内（乃至跨 execute）共享 `config._readSet`，让 read→write/edit 跨工具链生效（write/edit 覆盖前查 `sharedReadSet.has(filePath)`，未 read 则拒）。
- **allowedTools 三态**：undefined=全集（eager 默认，向后兼容）；[]=NO_TOOLS 全拦（forked summary）；非空=按白名单过滤不在者产 `[tool_not_allowed]` ToolResultBlock（isError=true，[v0.0.48] 统一拒绝 code 见 §3.1，多轮下 LLM 可自修正）。
- **超时/取消**：`ctx.signal` 由 `runTool` 每次真实 run 建的 per-tool `AbortController` 赋值（工具自行响应，如 bash abort→组杀进程树）；引擎层 backstop timeout 兜底（§4.2）。

### 4.1 default-fill 通用机制（[v0.0.68 R5 / D5]）

`validateInput`（`app/server/src/tools/engine.ts:186`）末尾对 schema 声明 default 的字段做兜底注入——**所有工具受益，不特例化任何工具**：

```typescript
// validateInput 末尾（必填 + 类型校验通过之后）
if (schema.properties) {
  for (const [key, sub] of Object.entries(schema.properties)) {
    if (obj[key] === undefined && sub.default !== undefined) {
      obj[key] = sub.default;
    }
  }
}
```

**时机决策（D5）**：放 required + 类型校验**之后**——default 不绕过必填/类型约束；只填「真正缺失」的字段。判定用 `obj[k] === undefined && sub.default !== undefined`（**不是 truthy 判定**），所以 `default: false` / `default: 0` / `default: ''` 等 false-y 值也会被注入。

**mutate 语义**：直接 mutate 入参 `input` 对象（reference 透传到 `tool.run`，让工具拿到 default-filled 入参）。

**首个消费者**：`send_message` needReply——schema required 移出 needReply + properties.needReply 加 `default:true` + normalize 改 `?? true`（详见 `specs/tech/multi_agent/[P1]subagent_derivation.md §5` / `[P1]a2a_protocol.md §4.2`）。后续工具如有同类需求（schema 声明 default），无需改 engine，自动受益。

### 4.2 三层超时 + AbortSignal 真实清理（[v0.0.130.hang] 已兑现）

**背景**：v0.0.8 起 §2/§4 声明「`ctx.signal` 传入 tool.run + 引擎可加 overall timeout 兜底」，但代码从未装配 signal、也无 overall timeout（`ctx.signal` 恒 undefined → bash `signal: ctx.signal` 是死线）。live 案例：bash 跑 bge 下载卡死无超时 → session 永 running（hang）。v0.0.130.hang 实现该契约。落 `app/server/src/tools/engine-timeout.ts`（常量 + `resolveEffectiveTimeout` + `formatTimeoutText`；engine.ts re-export，caller 仍从 `../engine` 引用）。

**三层超时优先级**（`resolveEffectiveTimeout(perCall, tool)` 纯函数，`clamp(base, 1, 600000)`）：

| 层 | 来源 | 值 |
|---|---|---|
| ① per-call | `call.arguments.timeout`（LLM 显式传，非 finite/≤0 忽略） | 任意（受硬天花板封顶） |
| ② per-tool | `Tool.defaultTimeoutMs` | file×5=10000 / web×2=30000 / bash=120000 / agent=600000 |
| ③ engine 兜底 | 未声明 defaultTimeoutMs 的工具 | `DEFAULT_TOOL_TIMEOUT_MS`=30000 |
| 硬天花板 | 所有工具（含 per-call） | `TOOL_TIMEOUT_CEILING_MS`=600000（10min） |

**backstop 语义**（`runTool`）：为每次真实 `tool.run` 建 per-tool `AbortController` → `ctx.signal`；`Promise.race([tool.run(input,ctx), timeoutPromise])`，timer=`min(effective + TIMEOUT_GRACE_MS(5000), 600000)`。GRACE 是给**工具自身超时机制**（如 bash 内部 timer）优先触发优雅清理的余量——engine 只在工具自身处理失效时才补刀。命中 backstop → `controller.abort()`（触发工具真实清理，非仅丢弃 promise）+ 弃用的 runPromise `.catch(()=>{})` 防 unhandled rejection + 返 `formatTimeoutText` 文案 isError result（`ToolErrorCode.TIMEOUT`）。正常 resolve（含工具自产 isError=true）原样透传不吞；`finally` 必 `clearTimeout`。

**统一超时文案契约**：`formatTimeoutText(name, ms, suffix?)` 是 `[timeout]` 文案唯一权威格式化点，恒以 **`[timeout] <name> exceeded <ms>ms`** 开头。engine backstop 分支附 `(engine backstop)`；bash 内部超时分支（bash.ts）复用同函数并附部分输出——两条路径 LLM 读到的前缀一致（可稳定识别「这次超时了」）。

**HITL 结构性豁免**（用户强约束）：`checkPermission=ask`（未批准）/ `interaction()` 返非 null 的悬挂分支在 `execute()` 内**于 `runTool` 之前就 continue**（走 `buildPendingResult`）——结构上永不进入超时 race，ask-question / 审批卡永不被超时杀。这是位置保证（分支物理早于 runTool），非定时对抗，不 flaky。

**ChildProcessRegistry 装配 + run 级 abort 边界**：`ExecuteRunCtx.childRegistry?` 沿现有 opts 透传链（`executeToolsForSpec → executeAndEmit → executeTools → engine.execute`）从 `AbortControllerHandle.childRegistry`（run 级唯一源，agent-manager 建 controller 时一并 `new`）下沉，`execute()` 装配进每个 `ctx.childRegistry`。两类触发泾渭分明：
- **单 tool 超时** → `ctx.signal.abort()` 触发工具自身清理（bash 走 `wireChildLifecycle` 组杀，见 `bash_tools.md §4.5`），**不**调 `killAll`。
- **run 级 abort/interrupt** → `abort-finalize.abortRun` 在 `controller.aborted=true` 后 fire-and-forget `childRegistry.killAll()`（杀树 → 卡死 tool 的 pipe 释放 → `tool.run` resolve → loop 到检查点退出 interrupted）。**不硬链 `ctx.signal` 到 run controller**（`AbortControllerHandle` 是单 bit 无事件源，改结构超范围）；非 spawn 工具 mid-abort 由自身 timeout 兜底。reconcile 不接 killAll（重启后新进程 registry 空，旧子进程组杀在存活期已防孤儿 = 死代码，明确排除）。

## 5. 悬挂型 tool 钩子（v0.0.101 落地，原 HITL approval 钩子泛化）

`Tool.interaction?(input, ctx): ToolInteraction | null`（取代旧 `needsApproval?(): boolean`）。设计意图：部分 tool call 需要外部输入（用户回答问题 / 审批危险操作）才能产出真实 result。引擎串行执行时：

```
executeOne(config, call, sharedReadSet):
  1. resolve / 2. validate / 2a. default-fill（不变，见 §4）
  3. [v0.0.101] interaction 分流:
     const interaction = tool.interaction?.(input, ctx)
     ↓ 返 null（或 tool 未实现 interaction）→ 走 step 4 正常 run
     ↓ 返非 null（悬挂型）→ 不真跑 run，调 buildPendingResult(call, interaction) 生成:
        - ToolResultBlock { status:'pending', content:[人话占位「用户回答中…'], subState, data }（合法 pair，入 transcript）
        - PendingToolCall wrapper（sessionId/runId/toolCallId/toolName/handleType/subState/data/resultMessageId/resultBlockIndex 占位）
        → 收集到 pending 数组，execute 返 { results, pending }
  4. run（仅 interaction 返 null 时执行）: { content, isError } = await tool.run(input, ctx)
  5. wrap: return ToolResultBlock { toolCallId, content, status:'success', isError }
```

**execute 返签名（v0.0.101 breaking）**：从 `Promise<ToolResultBlock[]>` 改为 `Promise<{ results: ToolResultBlock[]; pending: PendingToolCall[] }>`。caller（runReActLoop ③）拿 pending → 落 `SessionStore.setPendingToolCalls` + 回填各 pending 的 resultMessageId/resultBlockIndex（ingest 后知 message id）+ emit `require_human_input`（队首）+ StopReason=`tool_pending` 退出 + session=suspended。

**回填处理（pre-process，handleType 三分发）**：见 `../agent_interface_and_loop/[P0]agent_hitl.md`（落地 canonical）。回填进 inbox（`tool_reply` message）→ pre-process 按 toolCallId 匹配 pending → 按 handleType：
- `direct_result`：payload（FeedbackAnswer）序列化 → 编辑进 result block；status pending→success（ask-question）
- `approval`：`allow`→补跑原 tool 拿真实 result 编辑进 block→success；`deny`→拒绝 result→fail（未来 tool-approval，本版 spec 留位不实例）
- `callback`：调 `tool.onReply?(payload, ctx)` 返回 result → 编辑进 block（扩展点）

三分支后统一：`resolvePendingToolCall` 删一条；仍有 pending → emit 下一个 + 回 suspended；无 → 续 LLM。

> **旧 `needsApproval` 废弃（O7 代决）**：v0.0.8 起引擎恒跳过（`engine.ts` 注释「无 HITL 恒跳过」），全代码零 consumer。v0.0.101 删除字段 + 泛化为 `interaction()`。详见 `specs/tech/version_logs/v0.0.101/change_log.md`。

## 6. 不做的事（边界）

- ❌ **不并发执行**（批内串行；工具在主线程执行，不挪线程——工具层 fs 操作经 fs.promises 走 libuv 线程池，但不改变批量串行调度顺序）
- ❌ **不自己注册/持有工具**（`Tool[]` 由 `SessionConfig.tools` 持有，引擎从 config 取，见 overall §3）
- ❌ **不构造 ToolDefinition**（由 `Tool.definition` 提供）
- ❌ **不管执行时机**（何时调 execute 归 agent loop ③）
- ❌ **不持久化审批状态**（pending approval 归 session）

## 7. 边界

| 零件 | 归属 |
|---|---|
| 串行执行 + resolve/validate/interaction 分流/run/wrap + allowedTools 门控 + sharedReadSet + buildPendingResult | 本文（tool_execution_engine）✅ |
| 三层超时解析（resolveEffectiveTimeout）+ runTool backstop race + ctx.signal 装配 + formatTimeoutText 契约 + childRegistry 装配 | 本文 §4.2（engine-timeout.ts）✅ |
| 工具在主线程串行执行（v0.0.345 撤 worker pool 后无线程池分流）；工具层 fs 操作一律 `node:fs/promises` 真异步（libuv 线程池，不阻塞 event loop） | 本文 §1 ✅（历史 worker 线程池见 v0.0.307/v0.0.345 change_log） |
| 各工具实现（run / interaction / onReply / schema / defaultTimeoutMs） | file_op / bash / web / agent / skill / ask-question |
| ChildProcessRegistry 类 + run 级 killAll sweep + bash 组杀清理 | `child-process-registry.ts` + `bash_tools.md §4.5` + `../agent_interface_and_loop/[P0]agent_interrupt.md §3.1` |
| Tool[] 持有（SessionConfig.tools）+ 工具清单 | `index.md` |
| tool_call / tool_result 三态 / tool_reply 消息形态 | agent_message_interface |
| 执行时机（loop ③ 悬挂分流）+ 回填处理（handleToolReply 三分发） | agent_loop / agent_hitl |
| pendingToolCalls 落盘（peek/set/resolve）+ markSuspended | session |
| allowedTools 派生（scope→白名单）+ ask-question bound 4 角色 | `agent_tools.md §2` + `tool_policy.md` + `scope-allowed-tools.ts` |

> 变更历史见 `log.md`（本 KB 位置轴）+ `specs/tech/version_logs/vX.Y/change_log.md`（跨版本发布说明）。
