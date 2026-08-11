# v0.0.307 — Tool Engine Worker Pool 异步化

> 纯技术版本（无 PRD）。白名单纯 IO 工具执行从主线程挪 worker_threads 线程池，避免大 grep/read 阻塞 event loop。串行顺序保证不变。

## T1：worker pool 核心模块

新增 `app/server/src/tools/worker-pool/`（5 文件）：

| 文件 | 职责 |
|------|------|
| `types.ts` | 类型定义 + 白名单常量 `WORKERABLE_TOOL_NAMES`（唯一源：`['read','write','edit','glob','grep']`）+ `WorkerPoolTask`/`WorkerPoolResult`/`ToolWorkerRequest`/`ToolWorkerResponse`（全部可 structuredClone） |
| `pool.ts` | `ToolWorkerPool` 常驻线程池：懒创建（首次 submit）→ 空闲复用 → 崩溃重建（exit/error → reject 在途 + 新建替代）→ close() 全终止。`resolveWorkerPath()` 三路径探测 |
| `index.ts` | 工厂 + 进程级单例缓存：`createToolWorkerPool()` 首次构造后续复用；`_resetToolWorkerPoolSingleton()` 仅供 UT 隔离 |
| `worker-entry.ts` | worker 线程入口：`parentPort.on('message')` → 白名单工具映射 `WHITELIST[toolName]` → 构造最小 ctx → `tool.run(input, ctx)` → 收集 readSet 增量 → postMessage 回主线程 |
| `worker-bundle.cjs` | esbuild 预构建 bundle（677 行 CJS）。Node 原生 Worker 线程是独立 V8 isolate，不走 vitest/bun TS transform，无法直接加载 .ts → dev/test 环境用此 bundle 绕过。bun runtime 原生支持 TS Worker，直接加载 .ts |

**白名单边界**：仅含纯 IO 工具（read/write/edit/glob/grep），依赖仅 workdir + readSet，可序列化。skill 不在列——依赖 `ctx.config.skills` catalog（进程内对象，无法序列化进 worker）。有状态型工具（memory/web/browser/computer/agent/team 等）依赖进程内 manager/store/driver，不可 worker 化，本就走异步 IO 不阻塞。

**三路径探测**（`resolveWorkerPath()`，仿 `browser/node-worker-driver.ts` 同构模式）：
1. `worker-entry.js`（tsc 编译产物，packaged dist/ 命中）→ `new Worker(path)`
2. `worker-bundle.cjs`（esbuild 预构建 bundle，dev/test 用）→ `new Worker(path)`
3. `worker-entry.ts`（bun 源码，bun runtime 原生加载 TS）→ `new Worker(path)`

> **worker-bundle.cjs 构建注意**：源码（worker-entry.ts + file-read/write/edit/glob/grep）改动后需重新生成 bundle。packaged 走 tsc 编译不需要 bundle，但 dev/test（npx vitest / node）依赖 bundle 加载 worker。

**readSet 跨 worker 一致性（D5）**：worker 内构造临时 readSet，工具执行后收集增量路径（`readSetAdditions`），返回主线程后统一 apply 到 `ctx.readSet`（权威单一源 `config._readSet`），防跨 worker readSet 断裂导致 write/edit「先 read」校验失效。

## T2：engine runTool 分流

新增 `app/server/src/tools/engine-worker-dispatch.ts`（73 行，从 engine.ts 拆出保持 ≤300 行）：
- `isWorkerableTool(name)`：从 `WORKERABLE_TOOL_NAMES` 派生判定
- `runViaWorker(pool, call, ctx)`：submit → readSetAdditions 主线程 apply → 返回 `{content, isError}`；worker 崩溃抛错由 runTool catch 转 RUNTIME_ERROR
- `runViaTool(tool, call, ctx)`：走原 `tool.run` 路径（非白名单或未注入 pool）

修改 `app/server/src/tools/engine.ts`：
- constructor 加 `workerPool?: ToolWorkerPool` 可选注入
- `runTool` 分流逻辑：`_workerPool && isWorkerableTool(call.name)` → `runViaWorker`；否则 → `runViaTool`。两条路径返回 `ToolRunResultLike` 统一形状，进同一 `Promise.race([runPromise, timeoutPromise])` 超时 race 结构不变。worker 侧无独立 timer，超时仍由主线程 backstop race 控制。

**执行顺序保证**：execute 层仍串行（for...of + await），批内工具调用顺序不变。worker pool 只改单个白名单工具的执行位置（主线程 → worker 线程），不改批量调度语义。

## T3：bootstrap 装配

修改 `app/server/src/bootstrap-agent-phase.ts`：
- `createToolWorkerPool()` 进程级单例注入 `ToolExecutionEngine` constructor
- try-catch 降级：创建失败 → workerPool=undefined，工具仍主线程跑（向后兼容）
- `_resetToolWorkerPoolSingleton()` 确保 bootstrap 从干净状态开始（防热重载残留）

修改 `app/server/src/bootstrap.ts`：
- `BootstrapResult` 加 `toolEngine: ToolExecutionEngine` 字段（UT 验证 workerPool 注入用；router 不直接消费）

## C1：esbuild bundle 方案修复

Node 原生 `new Worker(path)` 无法加载 .ts 文件（独立 V8 isolate 不走 vitest/bun TS transform）。首次实现用 .ts 路径直接 spawn worker → vitest/node 下 worker 加载失败。修复：引入 esbuild 预构建 `worker-bundle.cjs`（CJS 格式），三路径探测中置于 `.js`（编译产物）之后、`.ts`（bun 源码）之前。
