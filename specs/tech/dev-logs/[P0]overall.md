---
type: spec
title: Dev Logs（dev 调试日志开关 + LogWriter）
priority: P0
status: active
updated: 2026-08-05
since: v0.0.30
---

# Dev Logs（dev 调试日志开关 + LogWriter）

> 管什么：app_config `logs` group 7 个 boolean 开关背后的 **LogWriter 模块**（把结构化记录以 JSONL 追加写 `<DATA_DIR>/logs/*.log`，经 **LogQueue 有界消费者队列**异步批聚合落盘）+ **7 个 hook 点契约**（在 LLM 调用 / 工具执行 / 入站 HTTP / event emit / agent loop breadcrumb / run 错误 / 慢查询 哪里注入、捕获什么字段、何时写）+ **按 type size-based 文件轮转**（§2.5）。
> 不管什么：开关 schema（→ `specs/tech/config/[P0]app_config.md §3.8` **v0.0.89 迁入 app_config**）、HTTP facade（→ specs/api）、UI 呈现（→ `specs/ui/components/app-dev-config-page/`）、truncate 体内容/控制台输出（**不在范围**，见 §6）。
> 总览见 `specs/tech/config/index.md`；DATA_DIR 见 `specs/tech/app/envs/[P0]environments.md`。
>
> **[v0.0.89] 存储迁移**：`logs` group 从 `dev_config` 整组迁入 `app_config`（group/key 名零变更，仅 entity 名改）；LogWriter 构造形参 `devConfig: DevConfigService` 改 `appConfig: AppConfigService`，`shouldWrite` 读取改 `appConfig.get('logs', <key>)`。本文剩余章节以 `appConfig` 表述，等价于 v0.0.88 前的 `devConfig`。

## 1. 定位：dev 调试日志（opt-in，文件落盘）

Dev Logs 是给开发者**临时排障**用的开关型日志：7 个 boolean 各自独立控制一类流量是否追加写本地文件。**默认全 false（零开销）**，需要时打开对应开关 → 对应流量追加写 `<DATA_DIR>/logs/<type>.log`（v0.0.138 起经 LogQueue 异步批聚合落盘，见 §2.3）。

**不是** observability（那是 langfuse 跨进程聚合，见 `specs/tech/agent/observability/`），**不是** 应用运行日志（console/LOG_LEVEL，见 envs spec）。Dev Logs 只写本地 JSONL 文件，dev feature，无远程上报。

## 2. LogWriter 模块

### 2.1 位置与职责

- **位置**：`app/server/src/dev-logs/log-writer.ts`（LogWriter 模块）+ `app/server/src/dev-logs/log-queue.ts`（有界消费者队列，LogWriter 内部持一份）。
- **职责**：把一条结构化记录（object）序列化为一行 JSON，**经 LogQueue 有界消费者队列异步追加**写入 `<DATA_DIR>/logs/<type>.log`。
- **单例/工厂**：模块级单例（`getLogWriter(dataDir, appConfig)`），启动期 ensure 目录 + 缓存 dataDir/appConfig；hook 点调 `getLogWriter().write(type, record)`。每 LogWriter 实例持**独占 LogQueue**（多 consumer 并发 appendFile 无序，禁止共享）。

### 2.2 文件与目录

- **目标目录**：`<DATA_DIR>/logs/`（DATA_DIR 见 envs spec；dev=`~/.rocky_agent_dev`，test 可由 env 覆盖到临时目录）。启动时（首次 `getLogWriter(dataDir)`）`mkdir {recursive: true}` ensure 存在，失败静默（不阻塞启动）。
- **文件**：7 个固定文件名（活跃文件恒为此基础名，轮转切到 `<type>-<ts>.log`，见 §2.5），与开关一一对应：
  - `logs/llm.log` ← `enableLlmRequestLog`
  - `logs/tool.log` ← `enableToolResultLog`
  - `logs/api.log` ← `enableAppApiLog`（v0.0.138 加 `durationMs` 字段）
  - `logs/event.log` ← `enableEventLog`
  - `logs/agent.log` ← `enableAgentLog`
  - `logs/error.log` ← `enableErrorLog`
  - `logs/performance.log` ← `enablePerformanceLog`（性能日志：慢查询 §3.7 + 卡顿 episode §3.8）
- **格式**：JSONL（每行一个 JSON 对象）。时间戳 ISO8601（`new Date().toISOString()`）。

### 2.3 写入语义（有界消费者队列 — 核心契约）

> v0.0.138 起落盘机制改为**异步有界消费者队列**（`LogQueue`，`log-queue.ts`）。此前是 `write` 内逐条直调 `appendFile`——字面兑现 fire-and-forget 但违背「不阻塞」精神：每条 = open/write/close syscall + 同步 `JSON.stringify`，squad leader 巨型状态同步消息下疯狂序列化+写盘致 API 慢。现回归 spec **意图**（fire-and-forget + 不阻塞）。

**生产者（`LogWriter.write` 同步路径）**：

1. 零开销门禁（§2.4）：开关 false 早 return（不 stringify、不 enqueue）。
2. 开关 true → `JSON.stringify({ts, ...record})`（**stringify 留在生产者侧**：入队后 record 即可被 GC，内存峰值低；消费者只做纯 IO，零序列化成本）。
3. `this.queue.enqueue(type, line)`（O(1)：仅 `Buffer.byteLength` 算 size + push；**不 await、不调 IO**）。
4. 同步返回 void（**fire-and-forget**：调用方不等落盘）。

**消费者（`LogQueue._consumerLoop` 单 async loop，lazy 启动 on first enqueue）**：

1. queue 空 → `await sleep(IDLE_WAIT_MS=50ms)` 轮询。
2. queue 非空 → 按 type 分桶取 batch（每 type ≤ `BATCH_MAX_COUNT=64` 且 ≤ `BATCH_MAX_BYTES=1MB`，先到先止）。
3. 每 type 单次 `appendFile({flag:'a'})` 写盘（批 join `\n`，**不覆盖**历史）。
4. **批间 `await sleep(BATCH_INTERVAL_MS=250ms)` yield 让出 event loop**（核心修复，不可破；MUST NOT 退回同步 while 排空——async 标记不等于真异步，必须有真 await 让出，见 memory `async-marked-fn-sync-io-blocks-eventloop`）。所有 setTimeout 用 `unref` sleep helper（不阻塞进程退出）。

**500MB byte 有界 buffer + drop-new（保 FIFO 老）**：

- `enqueue` 算 size = `Buffer.byteLength(line)+1`（+1 for `\n`）→ `bufferedBytes + size > MAX_BUFFER_BYTES=500MB` → **drop new（丢新保老）** + 节流 warn（`WARN_THROTTLE_MS=10s` 窗口聚合 N 条计数，避免刷屏）。
- drop 是 dev 日志可接受的（旁观者），老条目对排障价值高 → FIFO 保老。稳态下 queue 几乎恒空（250ms 消费 64 条/批 = 256 条/s，远超 ingest 率），只在 burst 触发。

**失败静默**（核心红线）：

- 消费者 `appendFile`/`stat`/`rename`/`unlink` 全 try/catch 吞（权限/磁盘满等），**绝不抛、绝不影响业务**。dev 日志是旁观者，绝不能因它让 LLM 调用/工具执行/HTTP 请求出错。

**flush 契约 + `writing` flag 实现**：

- 契约：`flush()`（仅 UT 用，生产 shutdown 不调——dev 日志可丢）返回后 queue 已消费到空 **且** 当前批 appendFile 已完成。
- 实现关键：consumer 在 appendFile **前**就把条目从 q `shift()` 掉，故 `q.length === 0` ≠ IO 完成（race：consumer 在 appendFile pending 时 flush 误判完成）。加 `writing` flag（appendFile 段内置 true / finally false），flush 条件 `q.length > 0 || writing`。

### 2.5 日志文件轮转（size-based，per-type，FIFO — v0.0.138 新增）

> v0.0.138 改造#5 补磁盘轮转：内存 buffer 有 500MB 上限，但磁盘文件此前无界增长（api.log 180M / llm.log 1G 现状）。补 size-based 轮转：每文件 ≤50MB，每类型最多 10 个 = 每类型磁盘 ≤500MB（6 类型 ≤3GB），FIFO 删最老。

**规格（消费者 `_rotateIfNeeded` 内执行，写前检查）**：

- **按类型**：每个 log type（llm/tool/api/event/error/agent/performance）独立轮转。
- **触发**：consumer 每批 appendFile 前 `stat` 当前活跃文件 size ≥ `ROTATION_MAX_FILE_BYTES=50MB` → 轮转。
- **命名**：活跃文件恒为 `<type>.log`（保 `tail -f` 约定 + `appendFile({flag:'a'})` 基础名）；轮转时 rename `<type>.log` → `<type>-YYYYMMDD-HHMMSS-mmm.log`（创建时间，filename-safe，带毫秒防同秒碰撞；碰撞再 +序号后缀兜底）→ 新建空 `<type>.log`。
- **FIFO 上限**：轮转后 `readdir` 筛该 type 的 `<type>-*.log`，> `ROTATION_MAX_FILES=10` → 按名（=时间戳字典序）`unlink` 最老直到剩 9（活跃文件是第 10 个）。
- **size 跟踪**：consumer 内 `fileSizeByType: Map<LogType, number>`（单线程 consumer 无并发）；首次写某 type 前 `stat` 既有 `<type>.log` 初始化（接续重启前 size，避免失同步），写后累加 batchBytes。
- **失败静默**：`rename`/`unlink`/`stat` 失败 try/catch 吞（同 §2.3 核心红线）；rename 失败不重置 fileSize（下次再试）。
- **隔离**：不做线程/进程隔离——async consumer 的 appendFile/stat/rename/unlink 全 await 让出 event loop（后台线程池），响应路径零 IO；500MB 内存 buffer + 轮转已封顶。

### 2.4 零成本门禁（开关 false 时零开销）

每次 `write(type, record)` 前**先读开关**：

```typescript
import type { AppConfigService } from '../config/app-config-service';

class LogWriter {
  private readonly queue: LogQueue;  // 有界消费者队列（constructor 创建，单实例）

  constructor(private dataDir: string, private appConfig: AppConfigService) { /* mkdir + this.queue = new LogQueue(dataDir) */ }

  /** 写一条记录；对应开关 false 时早 return（不 stringify、不 enqueue、不开 IO）。 */
  write(type: LogType, record: Record<string, unknown>): void {
    const key = TYPE_TO_KEY[type];  // 'llm' → 'enableLlmRequestLog' ...
    const enabled = this.appConfig.get('logs', key) ?? false;  // 可选覆盖语义（缺省 false）
    if (enabled !== true) return;  // 零开销早 return
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record });  // 生产者侧 stringify
    this.queue.enqueue(type, line);  // O(1) 入队，fire-and-forget（不 await）
  }
}
const TYPE_TO_KEY = {
  llm: 'enableLlmRequestLog', tool: 'enableToolResultLog',
  api: 'enableAppApiLog', event: 'enableEventLog',
  error: 'enableErrorLog', agent: 'enableAgentLog',
  performance: 'enablePerformanceLog',
} as const;
```

**关键约束**：
- **门禁在 write 内部**，不在调用方——调用方（hook 点）无需判断开关，直接调 `logWriter.write(...)`；writer 内部 `?? false` 早 return。这让 hook 点代码干净，且开关读取是本地 KV（cheap，无需热更新订阅）。
- **`?? false` 必须用 appConfig service 读**（不是模块级缓存），保证用户在 UI 改开关后**下一次 write 立即生效**（无需重启）。开关读取 O(1) 文件 KV，每请求一次成本可接受。
- **开关 false 时零开销**：不 stringify、不 enqueue、不调任何 IO（队列本身也是 lazy 启动，开关全关时 consumer loop 根本不启动）。

### 2.6 依赖注入与装配

LogWriter 需两个依赖：`dataDir`（绝对路径）+ `appConfig`（AppConfigService；v0.0.89 前为 DevConfigService）。

- **装配点**：`app/server/src/bootstrap.ts` 的 `bootstrapBuiltinPlugins(dataDir)` 内，紧接 `appConfig = new AppConfigService({ root: dataDir })` 之后，`const logWriter = new LogWriter(dataDir, appConfig)`。
- **注入 hook 点**：logWriter 需被各 hook 点拿到。注入路径（按 hook 点所在模块；agent/error hook 经 `spec.config.logWriter` 在 `run-react-loop.ts` 内取用，见 §3.5/§3.6）：
  - LLM hook：经 `InvokeContext` 新增可选字段 `logWriter?: LogWriter`（agent loop 装配 invoke 时从 session config 透传；与 `observability` 端口同套路，见 llm_caller `ObservabilityPort`）。
  - tool hook：`ToolSessionConfigLike` 新增可选字段 `logWriter?: LogWriter`（session 装配 tool config 时注入，engine 在 `executeOne` 取用）。
  - api hook：router 级单例——`router.handleRequest(req, dataDir)` 内 `getBootstrap(dataDir)` 后从 `BootstrapResult.logWriter` 取（已透传 devConfig，再加 logWriter 同路径）。
  - event hook：bus 实例级——见 §3.4。
  - agent breadcrumb + error hooks：经 session `spec.config.logWriter` cast 为 `LogWriter | undefined` 在 `run-react-loop.ts` 取用（§3.5/§3.6）。
- **BootstrapResult**：新增字段 `logWriter: LogWriter`（router 取用）。

## 3. 7 个 hook 点契约

每个 hook 写清「注入位置（具体文件/函数）+ 捕获字段 + 调用 LogWriter 的时机 + 开关 false 零开销保证」。§3.1-§3.4 是 v0.0.30 原 4 hook；§3.5（agent breadcrumb）+ §3.6（error）后续新增；§3.7（performance 慢查询）+ §3.8（performance 卡顿 episode）均走 `performance.log`，共享 `enablePerformanceLog` 门禁，靠 `kind` 字段区分来源（`'slowquery'` / `'hang'`）。`LogType='llm'|'tool'|'api'|'event'|'error'|'agent'|'performance'`。

### 3.1 LLM request hook（→ `logs/llm.log`）

- **开关**：`logs.enableLlmRequestLog`。
- **注入位置**：`app/server/src/llm/caller/llm_caller.ts` 的 `invoke(baseReq, ctx)` 函数（spec `agent/llm_caller/[P0]llm_caller.md`）。
- **依赖路径**：`ctx.logWriter`（`InvokeContext` 新增可选字段，agent loop 装配 invoke 时透传；缺省=不写）。
- **捕获字段**：
  - `provider`：target.providerId（最终成功或最后失败的 provider）
  - `model`：target.model.name
  - `request`：`baseReq`（canonical 请求：messages + params 如 maxTokens/temperature 等，即组装给 LLM 的完整入参）
  - `response`：成功 → `InvokeResponse`（message + usage + stopReason）；失败 → error（`{ category, message }`，来自 `ClassifiedLlmError`）
- **时机**：invoke 返回前（成功 try 末尾 / 失败 catch / 重试耗尽 throw 前），**每次 invoke 一条**（不是每 attempt 一条——attempt 重试是内部细节，dev 日志只关心一次逻辑 LLM 调用的最终结果）。
- **零开销**：`ctx.logWriter` 未注入（undefined）→ 不调 write；开关 false → write 内部早 return。
- **参照既有 hook 模式**：`ObservabilityPort.recordWireBody/endGenerationOk/endGenerationError`（每 attempt 记 wire body、成功/失败回调）。dev log 是 invoke 级（聚合），不重复 attempt 级 observability 的语义。
- **大 body 处理**：messages 可能很大（长 context）；本版**不做截断**（dev 排障需要全量，且开关默认 false 用户主动打开即接受成本）。后续若需可加 maxBodyBytes 截断（follow-up，见 §6）。

### 3.2 Tool result hook（→ `logs/tool.log`）

- **开关**：`logs.enableToolResultLog`。
- **注入位置**：`app/server/src/tools/engine.ts` 的 `ToolExecutionEngine.executeOne(config, call, readSet)`（spec `agent/tools/[P0]tool_execution_engine.md §4`）。executeOne 是单个工具调用的完整生命周期（resolve → validate → run → wrap），返回单个 `ToolResultBlock`。
- **依赖路径**：`config.logWriter`（`ToolSessionConfigLike` 新增可选字段，session 装配 tool config 时注入；缺省=不写）。
- **捕获字段**：
  - `tool`：`call.name`（工具名）
  - `input`：`call.arguments`（工具入参对象）
  - `output`：`result.content`（ToolResultBlock 的 content，string 或 structured）；`isError`：`result.isError`（boolean，区分正常结果/错误）
- **时机**：executeOne return 前（拿到 result 后），**每次工具调用一条**（execute 串行循环内每 call 一条）。
- **零开销**：`config.logWriter` 未注入 → 不调；开关 false → write 早 return。
- **大 output 处理**：file_read/browser 等工具 output 可能很大；同 §3.1 本版不截断。
- **不在此 hook**：`execute` 的 not-allowed 分支（call.name ∉ allowedTools → 不执行直接返 not-allowed result）——这是门控拒绝，非真正工具执行，**不写 tool.log**（避免噪音）。

### 3.3 App API hook（入站 HTTP，→ `logs/api.log`）

- **开关**：`logs.enableAppApiLog`。
- **注入位置**：`app/server/src/router.ts` 的 `handleRequest(req, dataDir)`（HTTP 路由分发入口，所有业务请求经此；http-server.ts 是 node:http 适配层，不在此 hook——只在 router 层覆盖业务流量）。
- **依赖路径**：`handleRequest` 内 `getBootstrap(dataDir)` 后从 `bs.logWriter` 取。
- **捕获字段**：
  - `method`：`req.method`（GET/POST/PUT/DELETE）
  - `path`：`url.pathname`（如 `/session/01K.../messages`）
  - `status`：response.status（200/400/404/500/...）
  - `durationMs`：`Date.now() - start`（dispatch 全程耗时；v0.0.138 新增——2 行级改动，dispatch 前 `const start = Date.now()`，write 时算差值）
  - `requestBody`：**req body 原文（raw text，http 原文，不 parse JSON）**——dispatch 前 `req.clone().text()` 读；GET/HEAD 无 body（空串）则省略该字段。
  - `responseBody`：**response body 原文（raw text，http 原文，不 parse JSON）**——dispatch 后 `response.clone().text()` 读；空则省略。
  - **记 http 原文而非解析后 JSON 的理由**：调试/排障要看原始报文（含未规整的 JSON、非 JSON 体、错误页 HTML 等），parse 会丢真或抛错。raw text 透传最忠实、零信息损失、也不会因 parse 失败影响日志。
- **时机**：
  - **dispatch 前**：先读开关 + `req.clone().text()`（**必须在 `dispatchRequestInternal` 之前 clone 读**——body 是一次性流，dispatch 内 handler 消费后 clone 再读会得空）+ `const start = Date.now()`（v0.0.138，记 RT 起点，须在 dispatch 前）。
  - **dispatch 后**：`dispatchRequestInternal` 拿到 response 后 `response.clone().text()` 读 resp 原文，组装日志行（含 `durationMs`）。
  - **每次入站请求一条**（排除项除外）。
- **零开销**：开关 false → write 早 return。但注意**读 req/resp body 有成本**（需 clone 再读，因 body 一次性）——为保零开销，**开关 false 时不 clone 不读 body**：先读开关，false → 直接 dispatch + return response 不 clone 不读；true → clone req（dispatch 前）+ clone resp（dispatch 后）读原文（原 req/response 透传给下游/return，不受影响）。
- **排除项**（不写 api.log，避免噪音/死循环）：
  - `/sse` 与 `/sse/*`（SSE 长连接流，不适用 req/resp JSON 模型）
  - `/health`（健康检查，高频无业务含义）
  - OPTIONS 预检（在 http-server 层已 204 短路，不进 router，天然不写）
- **流式 response 处理**：SSE 已排除；若未来有其他流式端点，responseBody 记 `{ _note: 'stream response, body omitted' }` 不读流（避免缓冲整个流）。

### 3.4 Event emit hook（→ `logs/event.log`）

- **开关**：`logs.enableEventLog`。
- **难点**：event emit 是**直接调 `bus.emit(group, {data, timestamp})`**（bus 实例级，散落在 agent-manager / agent-loop-stage-llm / abort-finalize / session-clear-op 等多处），**不经 EventHub**（hub 是 sub 侧路由，emit 在 bus 实例上）。design.md 担心「漏某个 bus」——需统一 tap 点。
- **方案**：在 **bus 实例创建处包一层 emit 拦截**，而非改每个 emit 调用点。
  - `app/server/src/bootstrap.ts` 创建 bus 后、`registerTopic` 前，包一层：
    ```typescript
    const rawBus = new ReplayableEventBus({ replayable: true });
    const bus = wrapBusWithLog(rawBus, logWriter);  // emit 时调 logWriter.write('event', ...)
    hub.registerTopic('agent_loop', bus);
    ```
  - `wrapBusWithLog(inner, logWriter, topic)` 返回一个 proxy：`emit(group, event)` 时先 `logWriter.write('event', { topic, group, event: event.data })`，再委托 `inner.emit(group, event)`。**其余所有方法（subscribe / wakePendingSubscribers / clearReplay / isReplayable / subscriberCount / …）用 JS `Proxy` 的 get trap 默认转发 inner 全部属性**——机制上不可能漏方法（**禁止手列方法**：BUG-001 首版手列 `{emit,subscribe,wakePendingSubscribers}` 漏 `clearReplay` → agent loop 每 run `bus.clearReplay is not a function` → 所有对话 SERVER_ERROR 全挂）。
  - **覆盖全部 topic 的 bus**：bootstrap 里每 `registerTopic(topic, bus)` 前都包一层（当前 agent_loop + session_panel 两个 bus，未来新增 topic 同路径包，保证不漏）。
- **捕获字段**：
  - `topic`：bus 所属 topic（wrap 时闭包传入，bus 自己不知道 topic）
  - `group`：emit 的 group（如 `session_id:01K...`）
  - `event`：`event.data`（EventBusEvent unwrap data 后的业务事件对象；timestamp 用 logWriter 自己的 ts）
- **时机**：每次 `bus.emit(...)` 一条（proxy 层拦截）。
- **零开销**：开关 false → write 早 return（proxy 包装本身的 emit 委托开销极小，可接受；如需更彻底可在 wrapBusWithLog 时读一次开关决定是否包 proxy，但那样失去运行时切换能力，故选 write 内部门禁）。
- **不在此 hook**：`wakePendingSubscribers`（cancel 用，非业务事件）、replay buffer 内部操作。

### 3.5 Agent loop breadcrumb hook（→ `logs/agent.log`）

- **开关**：`logs.enableAgentLog`。
- **注入位置**：`app/server/src/agent/run-react-loop.ts`（loop 各阶段边界）+ inbox/state 变更处；经 `spec.config.logWriter` cast 为 `LogWriter | undefined` 取用（缺省=不写）。
- **用途**：诊断 agent hang / stuck-running——loop 卡住时仍记 `loop_step` 但永不 `loop_exit`（冒烟枪）；点名卡在哪个 tool（`loop_tools_begin` toolNames/toolCallIds）还是 HITL 悬挂（`loop_tools_end` pendingCount）。
- **捕获字段（`event` 判别 + 上下文）**：统一带 `sessionId`/`runId`，按 `event`：
  - `loop_enter`（mode=main/forked + triggerInputIds）/ `loop_step`（step）/ `loop_exit`（stopReason + rounds + interrupted）
  - `loop_tools_begin`（step + toolNames + toolCallIds）/ `loop_tools_end`（step + resultCount + pendingCount）
  - `state_change`（session 六态机转移）/ `inbox_enqueue` `inbox_drain` `inbox_cancel` `inbox_remove`（入队/消费/取消）
  - **只记 id/类型/计数，绝不记消息内容**（PII/隐私）。
- **与 SSE 阶段事件的关系（[v0.0.130.hang]）**：`loop_tools_begin/end` breadcrumb 与 SSE `tool_execution_start/end` **同址、同字段**（一机制两用——breadcrumb 落文件供 dev 排障，SSE 事件推前端外显阶段，见 `../agent/agent_interface_and_loop/[P0]agent_event.md §5.6`）。
- **时机**：各阶段边界一条；**每轮迭代一条 `loop_step`**。
- **零开销**：`logWriter` 未注入 → 不调；开关 false → write 早 return。

### 3.6 Error hook（→ `logs/error.log`）

- **开关**：`logs.enableErrorLog`。
- **两个注入点（`layer` 字段区分来源，[v0.0.144]）**：
  - **run 层**（`layer:'run'`）：`run-react-loop.ts` catch 块（run 失败，含 LLM 整链全 dead 的 SERVER_ERROR 终态）。**每次 run 失败一条**。
  - **LLM 层**（`layer:'llm'`）：`llm/caller/llm_caller.ts` `invokeCore` 的 `result.kind==='error'` 分支（`appendRecentError` 后、`decideAction` 前）。此点在所有 decide 分支（RETRY/ROTATE_KEY/FALLBACK/NO_RETRY/backgroundPath-fail）上游 → **每次 attempt 失败一条（含重试中每次、含 TIMEOUT）**。invoke 级 all_dead / max_tokens 硬顶的终态由 run 层（`layer:'run'`）兜底，不在此重复记。
- **工具层注入点（无 `layer` 字段，`tool` 字段区分来源）**：`web-fetch/tool.ts:writeWebFetchErrorLog`——web_fetch 三类失败路径各写一条：SSRF 拒绝/异常（`stage:'ssrf'`）、fetchContent 抛错（`stage:'race'`）、两路皆空（`stage:'race'`）。字段 `tool:'web_fetch'`/`url`/`stage`/`reason`/`failures?`（两路皆空时带 `[{fetcher,reason}]` 各 fetcher 归因）。经 `ctx.config.logWriter` 鸭子类型探测（缺省 no-op），日志自身异常静默不冒泡。
- **捕获字段**：run/LLM 层统一带 `layer`（`'run' | 'llm' | ...`）。
  - run 层：`sessionId`/`runId`/`category`/`message`/`stack`/`displayReason`。
  - LLM 层：`sessionId`/`category`/`message`/`attempt`/`providerId`/`modelId`/`keyRef`（per-attempt 精简失败事件，无 stack）。
  - 工具层（web_fetch）：`tool`/`url`/`stage`/`reason`/`failures?`（无 `layer`，见上）。
- **与 `llm.log` 职责不重叠（都保留）**：`llm.log`（§3.1）= invoke 级完整请求/响应快照（debug 全貌）；`error.log(layer=llm)` = per-attempt 失败事件精简条目（跨层统一失败视图）。定位不同，不去重。
- **时机**：见上两注入点；**零开销**同上（开关 `enableErrorLog` 默认 false，`write` 内部早 return，重试链上每 attempt 判一次开关成本可接受）。

### 3.7 Slow query performance hook（→ `logs/performance.log`）

- **开关**：`logs.enablePerformanceLog`。
- **用途**：定位 prod 卡顿真凶——不猜哪个 entity 慢，让慢日志说话。抓到具体慢查询后再决定优化方向（迁 sqlite / 加索引 / 缓存，另立版本）。
- **注入位置**：persistence 两个 engine 的 `query` 入口——`persistence/fs-store.ts` `FsCrudStore.query()` + `persistence/sqlite-store.ts` `SqliteCrudStore.query()`，统一经 `persistence/slow-query.ts` 的 `queryWithSlowLog(engine, schema, filter, fn, nowMs)` 计时包装：执行原查询 → 耗时**严格大于** `SLOW_QUERY_MS=200`（恰好 200ms 不算慢）→ 上报模块级 sink。
- **依赖路径（sink 注册点模式）**：persistence 是底座层，**不反向 import dev-logs**（依赖方向保持 上层 → 底座）。slow-query.ts 只定义 `SlowQuerySink` 回调接口 + 模块级注册点 `setSlowQuerySink`，由 `bootstrap.ts`（组合根）在 LogWriter 创建后注入 `info => logWriter.write('performance', info)`（与 `setSessionStoreEpDelegate` / `setTokenUsageSubscriberDeps` 同范式）。sink 未注册 = 完全不产出慢日志（UT 隔离传 null 注销）。
- **捕获字段**（`SlowQueryInfo`，`ts` 由 LogWriter 补）：
  - `kind`：恒 `'slowquery'`（与 hang episode 的 `'hang'` 对称，`grep kind:` 统一筛 performance.log）
  - `engine`：`'fs' | 'sqlite'`（区分全扫 fs / sqlite）
  - `entity`：`schema.entity`（定位「哪个实体卡」的核心字段）
  - `shardKey`：`filter.shardKey`（不分片或 scatter 全 shard 为 null）
  - `ms`：查询耗时毫秒（取整）
  - `count`：返回记录数（过滤 + limit 后调用方真实拿到的条数，反映扫描工作量）
  - `filter`：原始 QueryFilter（排查复现用，全字段可 JSON 序列化）
- **时机**：每次 query 调用计时一次，超阈值一条；**异步不阻塞主路径**——sink 适配到 `LogWriter.write` = O(1) stringify + enqueue（§2.3），查询主路径零磁盘 IO；500MB drop-new + 失败静默由 LogQueue 内建，本 hook 不重复实现。
- **零开销**：sink 未注册 → 仅一次 `nowMs()` 调用（不构造任何对象）；sink 已注册但开关 false → `write` 内部 `?? false` 早 return（§2.4），调用方零感知。`nowMs` 时钟由 engine 构造注入（`FsCrudStore` opts / `SqliteCrudStore` opts，缺省 `Date.now`），UT 可控。
- **阈值参数化**：`SLOW_QUERY_MS` 先固定常量 200ms（后续版本可接 app_config，见 slow-query.ts 注释）。

### 3.8 Hang episode performance hook（→ `logs/performance.log`）

- **开关**：`logs.enablePerformanceLog`（与 §3.7 共享，同一文件同一门禁）。
- **用途**：prod GUI 单进程 stdout 不落盘 → event-loop-monitor 的 console.warn/info 蒸发。本 hook 把卡顿 episode（enter/recover）落 performance.log，让用户开 `enablePerformanceLog` 后能看到文字日志。
- **注入位置**：`app/server/src/observability/event-loop-monitor.ts` 的 `tick()`——episode enter 分支调 `reportHang({kind:'hang',phase:'enter',...})`，recover 分支调 `reportHang({kind:'hang',phase:'recover',source})`。console 保留（双写：dev 即时反馈 + 文件落盘互不排斥）。
- **依赖路径（sink 注册点模式，同 §3.7）**：observability 是底座层，**不反向 import dev-logs**。`hang-sink.ts` 只定义 `HangSink` 回调接口 + 模块级 `_sink` 变量 + `setHangSink()` / `reportHang()`，由 `bootstrap.ts`（组合根）在 LogWriter 创建后注入 `record => logWriter.write('performance', record)`（紧接 `setSlowQuerySink`，同一 logWriter 实例）。sink 未注册（null）→ `reportHang` 仅判一次 `_sink` 短路（零开销）。
- **捕获字段**（`HangRecord`，`ts` 由 LogWriter 补；详见 `specs/tech/agent/observability/[P1]hang_monitor.md §3.8`）：
  - `kind`：恒 `'hang'`（与 slowquery 对称）
  - `phase`：`'enter'`（进入卡顿）/ `'recover'`（恢复）
  - `source`：来源标识（`'server'` / `'electron-main'`）
  - `lagMs` / `cpuUserMs` / `cpuSysMs` / `elu` / `profileFile`：仅 enter 阶段（metric 快照 + profile 路径，recover 不带）
- **时机**：episode enter 一条 + episode recover 一条；`profileFile` 与 console warn 的 tsIso 同源（grep `kind:hang` → 路径 → 拖入 DevTools）。
- **零开销**：sink 未注册 → reportHang 短路；sink 已注册但开关 false → `write` 内部 `?? false` 早 return（§2.4）。

## 4. group 注册（前端 KV_GROUPS）

后端**无 group 枚举注册点**——AppConfigService 通用 KV 按 `(group, key)` 任意读写，`logs` group 自动落盘到 `app_config/logs/`。**「注册 logs group」= 前端 `app/web/src/components/app-dev-config-page/app-settings-config-defs.ts` 的 `KV_GROUPS` 常量加一条**（渲染在 app 设置页「可观测性」tab 的日志 group；label/desc 走 i18n key `schema.logs.<key>.{label,desc}`，zh-CN/en 双语资源必须同步加，见 memory `i18n-key-add-checklist`）：

```typescript
{
  groupId: 'logs',
  domain: 'app',
  keys: [
    { key: 'enableLlmRequestLog',  type: 'boolean', ... },  // logs/llm.log
    { key: 'enableToolResultLog',  type: 'boolean', ... },  // logs/tool.log
    { key: 'enableAppApiLog',      type: 'boolean', ... },  // logs/api.log
    { key: 'enableEventLog',       type: 'boolean', ... },  // logs/event.log
    { key: 'enableErrorLog',       type: 'boolean', ... },  // logs/error.log（run/LLM/工具失败）
    { key: 'enableAgentLog',       type: 'boolean', ... },  // logs/agent.log
    { key: 'enablePerformanceLog', type: 'boolean', ... },  // logs/performance.log（慢查询，§3.7）
  ],
},
```

挂载逻辑（`loadAll`）已有：逐 group `GET /config/app?group=<g>` 取已落盘 key → 填 value（缺失用 `defaultFor('boolean')` = false）。保存（`handleSaveGroup`）已有：`PUT /config/app` 整组提交 `{group:'logs', items:[{key,data},...]}`。**后端零改动**（kv-config-handlers 通用路径已支持任意 group）。`[v0.0.89]` 端点随 dev_config 废弃迁 `/config/app`（logs group 迁入 app_config，group/key 名零变更）。

## 5. 关键代码路径

```
UI 改 logs 开关 → PUT /config/app {group:'logs', items:[{key:'enableLlmRequestLog', data:true},...]}   # [v0.0.89] 迁 /config/app
  → router.handleRequest → handleKvConfigPut → appConfig.setGroup('logs', items)
  → 落盘 app_config/logs/<id>.json

下次 LLM 调用：
  agent-loop-stage-llm → llm_caller.invoke(baseReq, ctx{logWriter})
  → invoke 成功/失败 → ctx.logWriter.write('llm', {provider, model, request, response|error})
  → write: appConfig.get('logs','enableLlmRequestLog') ?? false → true → JSON.stringify(line)
  → this.queue.enqueue('llm', line)                                   # [v0.0.138] 入队（O(1) fire-and-forget）
  → LogQueue._consumerLoop（lazy 启）→ 按 type 批聚合 → _rotateIfNeeded → appendFile({flag:'a'}) logs/llm.log

api.log 加 durationMs（v0.0.138）：
  router.handleRequest → dispatch 前 const start = Date.now()
  → write('api', {method, path, status, requestBody?, responseBody?, durationMs: Date.now() - start})

performance.log 慢查询（§3.7）：
  bootstrapBuiltinPlugins → new LogWriter(dataDir, appConfig)
  → setSlowQuerySink(info => logWriter.write('performance', info))   # 组合根注入（persistence 不反向依赖 dev-logs）
  查询时：FsCrudStore.query / SqliteCrudStore.query
  → queryWithSlowLog(engine, schema, filter, fn, nowMs)              # 计时包原查询
  → ms > SLOW_QUERY_MS(200) → sink({kind:'slowquery', engine, entity, shardKey, ms, count, filter})
  → LogWriter.write('performance', ...) 门禁（enablePerformanceLog ?? false）→ enqueue → logs/performance.log

performance.log 卡顿 episode（§3.8）：
  bootstrapBuiltinPlugins → setHangSink(record => logWriter.write('performance', record))  # 紧接 setSlowQuerySink
  卡顿时：event-loop-monitor.tick() → lag ≥ threshold
  → reportHang({kind:'hang', phase:'enter', source, lagMs, cpuUserMs, cpuSysMs, elu, profileFile})
  → LogWriter.write('performance', ...) 门禁 → enqueue → logs/performance.log
```

## 6. 明确不做（scope 外，follow-up）

- **控制台输出**：只写文件，不 echo console（避免与 LOG_LEVEL 应用日志混淆）。
- **日志查看 UI 面板**：用户选了「日志文件」方案（非实时面板）。看日志直接读文件 / `tail -f`。
- **body 截断**：大 messages / tool output 不截断（dev 排障需全量）。后续可加 maxBodyBytes。
- **跨进程聚合 / langfuse**：那是 observability 域（`specs/tech/agent/observability/`），独立。
- **truncate 体内容 / 压缩归档**：轮转只切片（rename）+ FIFO 删最老，不做内容 truncate / gzip 压缩（dev 日志旁观者，不值）。

## 7. UT 范围

- **LogWriter + LogQueue**：写正确文件（type→filename 映射）、JSONL 格式（每行一个 JSON、可 JSON.parse）、开关 false 不写、append 不覆盖（多次 write 累加行）、失败静默（mock appendFile reject 不抛）。队列改造后加（v0.0.138）：批聚合（write 100 条 → flush 后文件 100 行）、批间 yield（write 后立即返同步 + consumer 异步落盘）、drop new（bufferBytes 近 500MB 后 write 1 条未落盘 + console.warn 被调）、500MB byte 计量、文件轮转（≥50MB rename + FIFO 删最老）、flush 用 `queue.flush()` 等队列（不用 wall clock）。
- **零开销门禁**：开关 false 时 write 内部早 return（mock appConfig.get 返 false → 不调 appendFile / 不 enqueue）。
- **config**：`logs` group 读默认 false（record 缺失 `?? false`）、override 生效（set true 后 get 返 true）、`logs` 出现在前端 DEV_GROUPS（component test 侧）。
- **6 hook 各自**：开关 on 时各产一条正确字段记录（llm=provider/model/request/response；tool=tool/input/output/isError；api=method/path/status/durationMs/requestBody/responseBody；event=topic/group/event；agent=loop_enter/step/exit breadcrumb；error=layer+category/message/stack（run 层）/ layer=llm 的 per-attempt attempt/providerId/modelId/keyRef）、off 时 no-op（不调 write / write 早 return）。
- **performance hook §3.7（`persistence/__tests__/slow-query.test.ts`）**：超阈值上报一条正确字段记录（kind='slowquery'/engine/entity/shardKey/ms/count/filter，ts 由 LogWriter 补）；恰好等于阈值不上报（严格大于）；sink 未注册零副作用（不构造对象、结果原样透传）；`setSlowQuerySink(null)` 注销后不再上报；`nowMs` 注入时钟控制耗时；开关 false 时 write 门禁早 return。
- **performance hook §3.8（`observability/__tests__/event-loop-monitor.test.ts`，hang sink 块）**：episode enter → reportHang 被调 + record.kind='hang'/phase='enter'/含 lagMs/cpuUserMs/cpuSysMs/elu/profileFile；episode recover → record.phase='recover'；sink null（`setHangSink(null)`）→ episode 触发但不调 sink（零副作用）；每 test 后 `setHangSink(null)` 隔离。
- **event bus proxy**：wrapBusWithLog 拦截 emit 写日志 + 委托 inner.emit 不破坏原 sub/replay 行为。

## 8. 版本

version: 1.0 `[v0.0.30 新增]`（LogWriter 模块 + 4 hook 点契约：llm=invoke 级 req+resp、tool=executeOne 级 input+output、api=handleRequest 级 method/path/req/resp 排除 sse/health、event=bus 实例 wrap proxy 拦截 emit；零成本门禁 write 内部 `?? false` 早 return；明确不做轮转/截断/控制台/面板）。
