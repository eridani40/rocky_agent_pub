# worker 崩溃隔离 + 自愈 变更计划书（v2 — 进程化主方案）

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 change_log.md。
> 技术设计：`specs/tech/design-worker-crash-isolation.md`（v2 进程化主方案，老板拍板）
> 证据：`temp/crash-0.0.328-search-analysis.md` §9 + coder3 实测（utilityProcess.fork 真隔离）
> **版本未立项**：本表先落 `specs/tech/` 根级；版本号/分支由 leader 定后迁入 `version_logs/vX.Y.Z/`。

## 0. 方案一句话

白名单工具执行从 worker_threads 换到独立子进程（packaged=Electron `utilityProcess.fork` / dev-test=`child_process.fork`），**所有工具统一同池同机制（grep 回白名单，零特例）**；子进程 native 崩只杀自己，主进程真免疫；`ToolWorkerPool` 接口/协议/调用方零改动；配全局回退开关 + 记录 + 上报 + 熔断。

## 1. 架构判断（已核实源码）

| 判断项 | 结论 | 核实依据 |
|--------|------|----------|
| 崩溃传播路径 | worker_threads 共享主进程地址空间；native brk 0 进程级终止；JS error/exit handler 对 native 崩失效（事件循环已死） | researcher §9.1（Node issue #65100 实证）；crash log Thread 37 |
| 现有池 JS 层自愈 | `handleWorkerCrash`（reject 在途+移除+重建）逻辑正确，但 worker_threads 下 native 崩时「一行都没机会跑」 | pool.ts L162-167（on error/exit）+ L208-213（handleWorkerCrash） |
| 载体选型 | utilityProcess.fork（packaged 真隔离）+ child_process.fork（dev/test 兜底） | coder3 实测：子进程 abort → 主进程免疫存活 exit=0；纯 fs 工具能跑；process.parentPort 协议同构 |
| 消息协议兼容 | WorkerPoolTask/Result 全 structuredClone，postMessage ↔ IPC 天然兼容 | types.ts（researcher §9.4-3） |
| 池接口零改动 | ToolWorkerPool 类名/签名不变，只换内部 createWorker → createIsolatedProcess | pool.ts + engine.ts L289-294（useWorker 分流）+ engine-worker-dispatch.ts |
| grep 回白名单 | 删除 coder3 移出特例（b1034dd5e 已回退），`WORKERABLE_TOOL_NAMES` 含 grep | types.ts L27 + 老板拍板 |
| grep 加固基础 | file-grep.ts 已有 jsGrep 降级（rg 不可用自动降级纯 JS） | file-grep.ts L86-95/L113-117/L167 |
| 记录/上报基建 | LogWriter error 类型（bootstrap L360 实例）+ SSE bus（bootstrap L387-388）+ 前端 toast 基建 | bootstrap.ts L360/L387-388 |
| 回退开关 | 环境变量/appConfig（参考 appConfig.get('runtime','bash_seatbelt') 先例，bootstrap L328） | bootstrap.ts L328 |

## 2. 设计红线（review 卡这几点）

1. **通用性（老板红线）**：一套机制覆盖所有 worker 工具，零特例（grep 与 read/write/edit/glob 同池同机制；风险工具在统一机制内加固）。
2. **池接口零改动**：ToolWorkerPool 签名/返回逐字段不变，engine/dispatch/bootstrap 一行不改。
3. **不搞挂 app**：双路径实测 + 回退开关一键回 worker_threads + 分阶段可回退 + 记录/上报失败静默。
4. **可维护性**：白名单单一源（types.ts）、入口与 worker-entry 同构、无「grep 单独分支」。

## 3. 设计决策（D 编号，method 级契约）

### D1: 执行载体替换 — pool.ts（修改核心，接口零改动）

**文件**：`app/server/src/tools/worker-pool/pool.ts`（修改）+ `process-factory.ts`（新建）

| 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|-----------|------|---------|------|------|--------|
| `createIsolatedProcess` | 新增 | 新文件 `process-factory.ts`：返回 `IsolatedChild { postMessage, on('message'\|'error'\|'exit'), terminate }`；packaged → `utilityProcess.fork(scriptPath)`；dev/test → `child_process.fork(scriptPath, {stdio:['ignore','pipe','pipe','ipc']})` | MUST 双路径按环境自动选择（dev 无 utilityProcess → fork）；MUST 封装统一接口（pool 不感知差异） | tech §4 D1 | 新文件 ~60 行 |
| `ToolWorkerPoolOptions.backend` | 新增 | 可选 `backend?: 'process' \| 'worker'`（缺省 'process'=新主方案） | MUST 缺省 process；MUST 'worker' 走旧实现 | tech §4 D7 | +2 |
| `createWorker`（private） | 修改 | `new Worker(workerPath)` → `createIsolatedProcess(processPath)`；注册 on message/error/exit 不变 | MUST 消息协议不变（structuredClone）；MUST worker_threads 旧代码保留（回退用） | tech §4 D1 | ~12 |
| `resolveWorkerPath` | 修改 | 探测入口脚本增加 `process-entry.js/.cjs/.ts`（同构三路径探测） | MUST 与现有 worker 路径探测同构 | tech §4 D1 | +6 |
| 回退开关读取 | 新增 | 环境变量 `TOOL_POOL_BACKEND` / appConfig `toolPoolBackend` 读 backend（bootstrap 注入 opt） | MUST 默认 'process'；MUST 开关全局（非单工具） | tech §4 D7 | +5 |

### D2: 进程入口 — process-entry.ts（新建，统一 catch + 白名单路由）

**文件**：`app/server/src/tools/worker-pool/process-entry.ts`（新建，~110 行，从 worker-entry.ts 演进）

| 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|-----------|------|---------|------|------|--------|
| `processEntry()` | 新增 | 子进程版入口：统一 IPC 适配 `const port = (process as any).parentPort ?? process` → `port.on('message', handleRequest)` / `port.postMessage(resp)` | MUST 与 worker-entry 逻辑同构；MUST 白名单从 WORKERABLE_TOOL_NAMES 单一源派生 | tech §4 D2 | ~30 |
| `executeWhitelistedTool` | 新增 | 复用 worker-entry 的 try/catch 全包结构（任何异常回 `{ok:false}` 不崩进程） | MUST 与 worker-entry executeWhitelistedTool 同构 | tech §4 D2 | ~50 |
| 自动启动 | 新增 | 文件尾 `processEntry()`（对齐 worker-entry 自动启动） | MUST 仅子进程环境生效（parentPort 或 fork 环境判断） | tech §4 D2 | +3 |

### D3: grep 回白名单 + 加固 — types.ts + file-grep.ts（修改）

**文件**：`app/server/src/tools/worker-pool/types.ts`（修改）+ `app/server/src/tools/file-grep.ts`（修改）

| 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|-----------|------|---------|------|------|--------|
| `WORKERABLE_TOOL_NAMES` | 修改 | `['read','write','edit','glob','grep']`（回白名单）；注释更新「grep 在进程池内跑：spawnSync 崩只杀子进程，主进程免疫；jsGrep 兜底」 | MUST 删除 grep 特例（老板拍板）；MUST 注释同步（可维护性） | tech §4 D3 | +2 |
| `rgAvailable()` | 修改 | `spawnSync` 包 try/catch，异常 → `_rgAvailable=false`（降级 jsGrep） | MUST 不新增「grep 单独分支」（统一机制内加固）；MUST 降级逻辑在 file-grep 内部 | tech §4 D3 | +4 |
| `runRipgrep()` | 修改 | `spawnSync` 包 try/catch，异常 → return null（调用方 L86-95 已降级 jsGrep） | 同上 | tech §4 D3 | +4 |

### D4: 崩溃记录 — pool.ts onCrash 回调（修改）

**文件**：`app/server/src/tools/worker-pool/pool.ts`（修改）

| 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|-----------|------|---------|------|------|--------|
| `ToolCrashRecord` | 新增 | `{ ts, level:'tool-crash', toolName, toolCallId, workdir, reason, action:'recovered' }` 类型（types.ts 或 pool.ts） | MUST 对齐老板「工具/操作/错误/时间戳」 | tech §4 D4 | +10 |
| `ToolWorkerPoolOptions.onCrash` | 新增 | 可选 `onCrash?: (rec: ToolCrashRecord) => void` 回调 | MUST 池不 import LogWriter（依赖注入，UT spy）；MUST 记录失败静默 | tech §4 D4 | +3 |
| `handleWorkerCrash` | 修改 | 崩溃时调 `this.onCrash?.(rec)`（toolName 从在途任务取；reason=崩溃原因；action='recovered'） | MUST 在 reject 在途任务后调（数据完整）；MUST 不阻塞重建主路径 | tech §4 D4 | +8 |

### D5: 崩溃上报 — SSE toast（bootstrap 注入 + 前端监听）

**文件**：`app/server/src/bootstrap.ts`（修改）+ 前端新轻量监听

| 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|-----------|------|---------|------|------|--------|
| bootstrap 注入 onCrash | 修改 | `createToolWorkerPool` 装配时注入 onCrash：① `logWriter.write('error', rec)`（L360 实例）② `bus`/`sseChannel` 发 `tool-crash` 事件（L387-388 单例） | MUST 复用现有 LogWriter + SSE 单例；MUST 失败静默 | tech §4 D4/D5 | +10 |
| 前端 toast 监听 | 新增 | 轻量监听 `tool-crash` SSE 事件 → toast「某工具崩溃已自动恢复」（复用现有 toast 基建） | MUST 非阻塞提示；MUST 失败静默 | tech §4 D5 | 前端 ~20 |

### D6: 熔断防崩溃风暴 — pool.ts（修改）

**文件**：`app/server/src/tools/worker-pool/pool.ts`（修改）

| 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|-----------|------|---------|------|------|--------|
| 熔断常量 | 新增 | `CRASH_WINDOW_MS=60_000`、`CRASH_THRESHOLD=5`、`COOLDOWN_MS=5*60_000` | MUST 常量可调（宽松默认，宁晚熔断不误伤） | tech §4 D6 | +4 |
| 崩溃计数 | 新增 | 滑动窗口记录崩溃时间戳数组；`isPoolHealthy(): boolean`（窗口内崩 < 阈值） | MUST 不阻塞正常路径；MUST 冷却后半开自动恢复 | tech §4 D6 | +25 |
| `handleWorkerCrash` | 修改 | 崩溃时 push 时间戳 + 触发熔断状态 | MUST 与 D4 记录并存；MUST 熔断后池仍可 submit（降级主线程） | tech §4 D6 | +5 |
| `isPoolHealthy` 消费 | 修改 | `engine.ts` L289-294：`useWorker = workerPool && workerPool.isHealthy() && isWorkerableTool(...)`；不健康 → runViaTool 主线程 | MUST engine 已有降级路径（非白名单老路）；MUST 不新增分支给单工具 | tech §4 D6 | +3 |

## 4. 回归保护（review 必查）

| 项 | 保护 |
|----|------|
| 池接口 | ToolWorkerPool 公共签名/返回逐字段不变；既有 `worker-pool.test.ts` 断言不改（除新增用例） |
| 消息协议 | WorkerPoolTask/Result structuredClone 载荷不变 |
| engine 分流 | `useWorker = pool && pool.isHealthy() && isWorkerableTool()` 向后兼容（pool 无 isHealthy 前视为健康） |
| worker_threads 旧实现 | 代码原样保留（回退开关 'worker' 路径），非删除 |
| grep 功能 | 回白名单后：rg 可用走 rg、不可用走 jsGrep（现有降级结构 + 新 catch 分支）；进程化后 spawnSync 崩只杀子进程 |
| 无预览区/无 worker 场景 | engine 未注入 pool → 全部主线程（现状路径零改） |

## 5. 验证（三层）

- **UT**（MANDATORY，bun + Node 双跑）：① 隔离：UT 模拟子进程 `process.abort()` → 断言主进程存活 + exit event 触发 + handleWorkerCrash reject 在途 + 重建（researcher §9.3）② 协议：submit/response 往返逐字段相等 ③ 熔断：60s 崩 ≥5 → isPoolHealthy false + engine 降级主线程 ④ 回退开关：'worker' → 旧实现 ⑤ file-grep：spawnSync 抛错 → jsGrep 降级。
- **AT**：无 API 契约变化；进程化对 HTTP 层透明 → 不新增（test-plan 写明理由）。
- **ET**：packaged 实机：触发子进程 abort（测试钩子）→ 主进程存活 + toast 出现 + 后续工具正常 + error.log 有记录。
