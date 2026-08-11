# v0.0.307 变更计划书 — 单进程确认 + tool engine worker pool 统一异步化

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 详细调研见 `states/v0.0.307/context.md`（findings 记录了需求 1 现状与代码事实的矛盾 + worker 化边界分析）。

## 架构决策摘要（D1-D5）

| # | 决策 | 内容 |
|---|---|---|
| **D1** | 需求 1（单进程）**代码层面已达成** | 全项目无「每 agent 一个 node 进程」的 spawn 层；agent 全为 server 进程内对象。**不产出任务**。需 leader 与老板澄清「14 进程 22G」所指（可能指 Rocky 宿主平台）。本版本只做代码可落地部分。 |
| **D2** | 需求 2 收敛为「worker pool + 白名单 worker 化」 | 不搞「所有工具统一扔 worker」（有状态工具依赖进程内单例，无法序列化）。白名单 = 纯 IO 工具（read/write/edit/glob/grep/skill 读）。执行位置从主线程挪 worker pool，工具实现零改动。 |
| **D3** | worker pool 生命周期 = 常驻懒启动 | 首次白名单工具调用时按 `maxWorkers`（默认 min(4, cpus-1)）创建常驻 worker 线程（Bun 实测支持 TS worker + fs）；工具实现文件本身作为 worker 入口（每个工具一个独立 worker 文件，避免整包 import 进 worker）。崩溃自动重建（exit/error → 重建 + 在途任务 reject）。 |
| **D4** | 主线程串行语义不变 | `ToolExecutionEngine.execute` 仍是串行 for...of + await（results 顺序保证、readSet 跨工具链语义不变）。仅 `runTool` 内对白名单工具改为 `await workerPool.submit(...)`——单工具执行挪线程，批内顺序不变。 |
| **D5** | readSet/超时/崩溃三件事主线程兜底 | worker 任务返回 `{ result, readSetAdditions }`，主线程统一 apply 到 `config._readSet`（防跨 worker readSet 断裂）；超时复用 engine 现有 backstop race（worker 侧不设独立 timer，主线程 abort 即弃结果）；worker 崩溃 → 在途任务 reject → engine catch 转 `[RUNTIME_ERROR]` isError（不拖垮主进程）。 |

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

### A 组：worker pool 核心（新增模块）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| worker pool | app/server/src/tools/worker-pool/types.ts | WorkerPoolTask | 新增 | `{ id: string; toolName: string; input: ToolInput; workdir: string }`（序列化任务载荷；不含 ctx 对象） | MUST 仅含可 structuredClone 字段（不传函数/类实例/AbortController） | context.md findings；browser/node-worker-driver.ts 任务 JSON 模式 | +8 |
| worker pool | app/server/src/tools/worker-pool/types.ts | WorkerPoolResult | 新增 | `{ id: string; ok: boolean; content: ContentBlock[]; isError: boolean; readSetAdditions: string[]; error?: string }` | MUST readSetAdditions 由 worker 端收集 read 成功路径（read/file 写入路径） | types.ts ToolRunResult + readSet 语义 | +8 |
| worker pool | app/server/src/tools/worker-pool/types.ts | ToolWorkerRequest | 新增 | `{ id: string; toolName: string; input: ToolInput; workdir: string }`（worker 线程收的消息） | MUST 与 WorkerPoolTask 同构（主线程 submit 序列化） | 同上 | +5 |
| worker pool | app/server/src/tools/worker-pool/types.ts | ToolWorkerResponse | 新增 | `{ id: string; ok: boolean; content: unknown; isError: boolean; readSetAdditions: string[] }`（worker 线程回的消息；content 为序列化 JSON） | MUST 不传函数/类实例（structuredClone 边界） | 同上 | +5 |
| worker pool | app/server/src/tools/worker-pool/worker-entry.ts | workerEntry() | 新增 | worker 线程入口：`parentPort.on('message')` → 按 toolName 路由到白名单工具实现（直接 import 工具模块）→ 构造最小 ctx `{ workdir }` → `await tool.run(input, ctx)` → 收集 readSetAdditions → postMessage 回主线程。异常 → `{ ok:false, error }` | MUST 只依赖白名单工具模块（不 import engine/registry 防整包加载）；MUST try/catch 全包（worker 内任何异常回消息不崩溃线程） | browser-worker.cjs 模式；Bun TS worker 实测通过 | +60 |
| worker pool | app/server/src/tools/worker-pool/worker-entry.ts | WHITELIST | 新增 | `const WHITELIST: Record<string, () => Tool>` 映射：`{ read: () => fileReadTool, write: () => fileWriteTool, edit: () => fileEditTool, glob: () => fileGlobTool, grep: () => fileGrepTool, skill: () => skillTool }` | MUST 惰性 `() =>`（worker 启动不加载全部，按需取） | registry.ts defaultTools 白名单子集 | +12 |
| worker pool | app/server/src/tools/worker-pool/pool.ts | ToolWorkerPool | 新增 | 常驻 worker 池：`constructor(opts: { maxWorkers?: number; workerPath: string })`；`submit(task): Promise<WorkerPoolResult>`（取空闲 worker / 新建 / 排队）；`close(): void` | MUST maxWorkers 默认 `min(4, max(1, cpus-1))`；MUST 空闲 worker 复用（不每次新建）；MUST 单 worker 同时只跑一个任务（新任务排队） | Bun worker_threads 实测；node-worker-driver 每次新建的反模式（本池常驻） | +90 |
| worker pool | app/server/src/tools/worker-pool/pool.ts | submit() | 新增 | 取 worker：空闲队列 pop / 未达上限 new Worker / 否则等 `onTaskDone` 信号。postMessage(task) + 挂 pending map（id → {resolve,reject}）。收 message → resolve；worker 'exit'/'error' 且 pending 非空 → 全部 reject（`WorkerCrashedError`）+ 重建 worker | MUST 单 worker 串行（一次一任务）；MUST 崩溃重建（不复活同一线程）；MUST 所有 reject 带 id（主线程按 id 匹配） | 同上 | +45 |
| worker pool | app/server/src/tools/worker-pool/pool.ts | resolveWorkerPath() | 新增 | 仿 browser resolveWorkerPath：`__dirname` 下探测 `worker-entry.js`（tsc 编译产物，packaged）→ 回退 `worker-entry.ts`（dev bun 源码） | MUST 双路径探测（packaged=dist CJS / dev=TS 源码） | node-worker-driver.ts resolveWorkerPath 同构 | +10 |
| worker pool | app/server/src/tools/worker-pool/pool.ts | WorkerCrashedError | 新增 | `class WorkerCrashedError extends Error`（worker 崩溃时在途任务 reject 用） | MUST 与正常 isError 区分（caller 可识别 worker 层故障） | types.ts ToolErrorCode 体系 | +5 |
| worker pool | app/server/src/tools/worker-pool/index.ts | createToolWorkerPool() | 新增 | 工厂：`(opts?: { maxWorkers?: number }) => ToolWorkerPool`（解析 workerPath + 构造） | MUST 单例缓存（进程级一个池，bootstrap 注入 engine） | bootstrap-agent-phase 装配模式 | +10 |

### B 组：engine 集成（runTool 分流）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| engine | app/server/src/tools/engine.ts | ToolExecutionEngineOptions | 新增 | `{ approvalManager?: ApprovalManager; workerPool?: ToolWorkerPool }`（可选注入，缺省 undefined = 不 worker 化） | MUST 可选（既有构造零改动；UT 可注入 fake pool） | engine.ts:100 现状 | +4 |
| engine | app/server/src/tools/engine.ts | constructor() | 修改 | 接受可选 `workerPool`，存 `this.workerPool` | MUST 缺省 undefined（不 worker 化，向后兼容） | engine.ts:110-112 现状 | +2 |
| engine | app/server/src/tools/engine.ts | runTool() | 修改 | 在调 `tool.run` 前分流：`this.workerPool && isWorkerableTool(call.name)` → `await this.workerPool.submit({ toolName, input, workdir: ctx.workdir })` → 结果 readSetAdditions apply 到 `ctx.readSet` → wrap 返回；非白名单走原 `tool.run` 路径 | MUST 白名单外工具走原路径（行为零变化）；MUST readSetAdditions 在主线程统一 apply（防跨 worker readSet 断裂，D5）；MUST 超时 race/abort/写 log 逻辑不变（超时仍在主线程 race，worker 侧无独立 timer） | tool_execution_engine.md §4；engine.ts:254-301 现状 | +18 |
| engine | app/server/src/tools/engine.ts | isWorkerableTool() | 新增 | `(name: string) => boolean`：白名单判定 `['read','write','edit','glob','grep','skill'].includes(name)` | MUST 与 worker-entry WHITELIST 同一份常量（防两处漂移；可 export 共享或 worker 端 import） | context.md findings 白名单分析 | +4 |
| engine | app/server/src/tools/engine.ts | runTool() catch 扩展 | 修改 | `workerPool.submit` reject（含 WorkerCrashedError）→ 走既有 catch 分支转 `[RUNTIME_ERROR]` isError（worker 崩溃不拖垮主进程） | MUST 崩溃时该工具调用失败但 execute 继续（失败不中断语义不变） | engine.ts:290-295 现状 | +3 |

### C 组：bootstrap 装配

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bootstrap | app/server/src/bootstrap-agent-phase.ts | bootstrapAgentPhase() | 修改 | 构造 `createToolWorkerPool()`（默认 maxWorkers）→ 传给 `new ToolExecutionEngine({ workerPool })`；返回结构不变 | MUST 只装配一次（进程级单池）；MUST worker 创建失败降级为不 worker 化（engine workerPool=undefined，工具仍主线程跑） | bootstrap-agent-phase.ts 现状 ToolExecutionEngine 构造点 | +6 |
| bootstrap | app/server/src/bootstrap.ts | bootstrap() | 修改 | 解构透传 bootstrapAgentPhase 的 worker pool（如返回结构需要）；无需则仅确保 agent-phase 内部完成装配 | MUST 不新增对外字段（除非 UT 需要注入 fake） | bootstrap.ts:417 现状 | +2 |

### D 组：spec 同步

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| spec | specs/tech/agent/tools/[P0]tool_execution_engine.md | §1 概述 / §6 边界 | 修改 | §1 补一句「单工具执行可经 worker pool 挪线程（v0.0.307），批内串行顺序不变」；§6 补「❌ 不并发执行（批内串行；单工具可 worker 化，见 version_logs/v0.0.307）」 | MUST 与实现一致（doc-modifier 阶段同步） | 本 change_plan D1/D4 | +3 |

## 不做的事（明确排除，防范围蔓延）

1. **不做「每个 agent 一个 worker thread」**：agent 是进程内对象且已单进程共享 event loop；14 个 agent 各自一个 worker 线程 = 无收益（线程不隔离内存，反而共享 V8 heap 竞争）。
2. **不做「所有工具统一扔 worker」**：web/browser/computer/agent/send-message/team/todo/cron/panorama/memory/memory-manage/skill-manage 依赖进程内单例（pluginManager/connectorManager/driverRegistry/nativePort/store），序列化进 worker 得不偿失；它们本身走异步网络/IO，不阻塞 event loop。
3. **不做 memory/memory-manage worker 化**：依赖 dataDir/scope 解析 + 目录 store，且已有独立 memory-dir-store 封装，同步读不重。
4. **不做文件锁机制**（req 需求 1 提到「文件写入并发竞争需要锁」）：execute 批内仍串行（D4），worker 并发只发生在不同 session 的 execute 之间——现状多 session 本就并发调工具，文件竞争现状已存在，本版本不引入锁（保持现状语义，避免过度设计）。
5. **不做进程级内存治理**（如 idle GC / heap 限制）：超出 worker pool 范围，单列后续版本。
