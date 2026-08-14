# v0.0.345 变更计划书 — 撤 worker pool + 工具层 fs.promises 真异步

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 需求：`reqs/[working] v0.0.345.worker-pool-removal.md`

## 架构决策摘要（D1-D5）

| # | 决策 | 内容 |
|---|---|---|
| **D1** | worker pool 整体删除 | v0.0.307 引入的 worker_threads 池是两次 crash（brk 0 SIGTRAP）崩溃面。pool.ts / worker-entry.ts / worker-bundle.cjs / types.ts / index.ts / __tests__ 全删，engine 分流接线拆除，工具回主线程。 |
| **D2** | 工具层 fs 操作全部 fs.promises 真异步（老板 13:37 最终拍板） | read/write/edit/glob/grep 五个工具的 IO 调用改 `node:fs/promises` + await。libuv 线程池执行、进程内、Electron 自身天天用，无 worker 那类 native 崩溃。不做 sync+fs-yield 混合方案（老板 13:33 已否定分散化）。 |
| **D3** | 分层边界 | 工具层 = fs.promises 真异步（本次全部改完）；persistence 层存量 sync fs = fs-yield 兜底（**不动**，fs-store.ts 等继续用 acquireFsSlot/trackFsTime）；其他层低频 sync fs（启动/配置路径）不在本次范围。 |
| **D4** | grep 的 spawnSync('rg') 保持不动 | 子进程执行、非本线程 native fs、已有 5s timeout 强杀（RG_TIMEOUT_MS）。仅 jsGrep 降级路径（readdirSync/statSync/readFileSync）改 promises。 |
| **D5** | 工具对外行为契约不变 | 输入/输出/isError 语义/错误码/错误文案/readSet 语义全部不变；仅 IO 调用层换实现。Tool.run 签名已是 `async run(): Promise<ToolRunResult>`（types.ts:279），无需签名改造。 |

## 关键事实（已核实，grep/读码确认）

- 全仓 `worker_threads` 引用仅存在于 `worker-pool/` 目录（5 文件）；`tests/`、`app/electron/`、`tools/browser/` 均无引用 → 删除后崩溃面清零。package.json `build:worker` 是 browser（playwright）的，与本次无关，不动。
- engine 执行链全 async：`execute()` → `runTool()` → `Promise.race([runPromise, timeout])`；5 工具 `run()` 均为 async 且测试均 `await` 调用 → async 化无隐藏同步依赖点。
- write/edit 依赖 `persistence/fs-io.ts` 的 `atomicWriteSync`（tmp→fsync→rename 崩溃原子）；需新增 async 版 `atomicWriteAsync`，**保留** atomicWriteSync（persistence 层存量用）。
- file-lock `withFileLock` 是 async fn（Promise 返回）→ 锁内换 async IO 零障碍。

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

### A 组：worker pool 删除（整体删除）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| worker pool | app/server/src/tools/worker-pool/pool.ts | ToolWorkerPool / WorkerCrashedError / resolveWorkerPath / PoolWorker / QueuedTask / ToolWorkerPoolOptions | 删除 | 整个文件删除（常驻 worker 池实现） | MUST 删除前确认无其他 import（已 grep：仅 engine-worker-dispatch + bootstrap-agent-phase） | v0.0.307 change_plan A 组 | -278 |
| worker pool | app/server/src/tools/worker-pool/worker-entry.ts | workerEntry / WHITELIST | 删除 | 整个文件删除（worker 线程入口） | MUST 一并删除 | 同上 | -129 |
| worker pool | app/server/src/tools/worker-pool/types.ts | WORKERABLE_TOOL_NAMES / WorkerPoolTask / WorkerPoolResult / ToolWorkerRequest / ToolWorkerResponse | 删除 | 整个文件删除（含白名单常量单一源） | MUST NOT 在其他文件保留 WORKERABLE_TOOL_NAMES 副本（白名单随池一并消亡） | v0.0.307 change_plan A 组 | -88 |
| worker pool | app/server/src/tools/worker-pool/index.ts | createToolWorkerPool / _resetToolWorkerPoolSingleton / singleton | 删除 | 整个文件删除（工厂 + 单例缓存） | MUST 删除 | 同上 | -38 |
| worker pool | app/server/src/tools/worker-pool/worker-bundle.cjs | — | 删除 | 整个文件删除（esbuild 预构建 worker bundle，无独立构建脚本引用） | MUST 删除（已 grep：无 build 脚本产出它，是手工构建产物） | pool.ts 头部注释 | -1（文件） |
| worker pool | app/server/src/tools/worker-pool/__tests__/worker-pool.test.ts | 全部 describe/it | 删除 | 整个文件删除 | MUST 删除 | v0.0.307 T1 | -285 |

### B 组：engine + bootstrap 接线拆除

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tool engine | app/server/src/tools/engine-worker-dispatch.ts | isWorkerableTool / runViaWorker / runViaTool / ToolRunResultLike | 删除 | 整个文件删除（分流辅助）；engine.ts 不再 import/re-export | MUST 删除（已 grep：仅 engine.ts 消费） | v0.0.307 change_plan B 组 | -74 |
| tool engine | app/server/src/tools/engine.ts | ToolExecutionEngine constructor | 修改 | 删除第二参 `workerPool?: ToolWorkerPool`，恢复单参 `constructor(approvalManager?: ApprovalManager)`；删除 `_workerPool` 字段与 `workerPool` getter | MUST 删除 import `ToolWorkerPool` / engine-worker-dispatch 三符号 / `export { isWorkerableTool }`；MUST 其余构造语义不变 | specs/tech/agent/tools/[P0]tool_execution_engine.md §3 | -25 |
| tool engine | app/server/src/tools/engine.ts | ToolExecutionEngine.runTool | 修改 | 删除 `useWorker` 分流三元：`const runPromise = tool.run(call.arguments as ToolInput, ctx);`（直接调用）。Promise.race backstop 结构、TIMEOUT_SENTINEL、abort、writeToolLog 全部不动 | MUST 超时/abort/HITL 语义不变；MUST 异常仍被 try-catch 转 [RUNTIME_ERROR]（工具 async 化后 reject 路径不变） | 同文件 v0.0.130.hang 三层超时体系 | -7/+1 |
| bootstrap | app/server/src/bootstrap-agent-phase.ts | bootstrapBuiltinPlugins（装配段） | 修改 | 删除 import `createToolWorkerPool/_resetToolWorkerPoolSingleton/ToolWorkerPool`；删除 workerPool try-catch 降级装配段（L95-105），改 `new ToolExecutionEngine(undefined)` | MUST 装配结果行为等价（engine 无 pool 注入）；MUST 无 worker-pool import 残留 | v0.0.307 change_plan C 组 | -11 |
| bootstrap | app/server/src/bootstrap.ts | BootstrapDeps.toolEngine 注释 | 修改 | 两处 `[v0.0.307] ToolExecutionEngine（UT 验证 workerPool 注入用）` 注释改为普通描述（去掉 workerPool 字样） | MUST 仅注释变更，不动物理字段 | bootstrap.ts L114/L495 | 0 |

### C 组：fs-io 新增 async 原子写

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| persistence | app/server/src/persistence/fs-io.ts | atomicWriteAsync | 新增 | `async function atomicWriteAsync(filePath, content): Promise<void>`：同目录 `.tmp` 写入 → fsync → rename 覆盖（fs.promises 版，语义同 atomicWriteSync 的 tmp→fsync→rename 崩溃原子） | MUST 目标与 tmp 同目录（rename 不跨 fs）；MUST 异常时清理 tmp（finally 兜底）；MUST 保留 atomicWriteSync 原函数不动（persistence 层存量调用） | specs/tech/persistence/[P1]file_write_lock.md §5；fs-io.ts atomicWriteSync 实现 | +25 |

**调用方迁移评估（已核实）**：`atomicWriteSync` 全仓 54 处引用，分布 tools/skill-manage-actions.ts（3 处）、memory/memory-dir-write.ts、scheduling/cron-adapter.ts 等多模块。**迁移面大（>10 文件跨模块），本次不迁移**，仅 write/edit 两工具换 async 版；存量 sync 调用方标为后续版本（change_log 记录）。

### D 组：五工具 IO 改 fs.promises

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tools | app/server/src/tools/file-read.ts | fileReadTool.run | 修改 | `statSync` → `await stat`；`readFileSync` → `await readFile`（node:fs/promises）。cat -n / offset / limit / 空文件 / 目录 isError / readSet 逻辑全部不动 | MUST 错误码与文案逐字不变（NOT_FOUND/INVALID_INPUT/RUNTIME_ERROR）；MUST readSet.add 语义不变 | specs/tech/agent/tools/[P0]file_op_tools.md §2 | -4/+4 |
| tools | app/server/src/tools/file-write.ts | fileWriteTool.run | 修改 | `existsSync+statSync` → `await stat(filePath)` 捕获 ENOENT 判不存在；`mkdirSync` → `await mkdir(recursive)`；锁内 `atomicWriteSync` → `await atomicWriteAsync`。readSet/防盲改/目录 isError 逻辑不动 | MUST 覆盖前先 read 校验不变（NOT_READ）；MUST withFileLock 包裹不变（锁内 async）；MUST 错误文案逐字不变 | file_op_tools.md §3 + file_write_lock.md §5 | -8/+8 |
| tools | app/server/src/tools/file-edit.ts | fileEditTool.run | 修改 | `existsSync+statSync` → `await stat` 捕获判不存在；锁内 `readFileSync` → `await readFile`；`atomicWriteSync` → `await atomicWriteAsync`。锁内重判/occurrences/replaceAll 逻辑不动 | MUST read-modify-write 整段仍在 withFileLock 闭包内（C8/C9）；MUST STRING_NOT_FOUND/MULTIPLE_MATCHES 文案与唯一性语义不变 | file_op_tools.md §4 + file_write_lock.md §5 | -8/+8 |
| tools | app/server/src/tools/file-glob.ts | fileGlobTool.run + walk | 修改 | `statSync(root)` → `await stat`；`walk` 改 async：`readdirSync` → `await readdir(withFileTypes)`、`statSync` → `await stat`，递归 `await walk(...)`。globToRegExp/排序/mtime 语义不动 | MUST MAX_DEPTH=20 防爆栈不变；MUST 无权限/stat 失败 → 跳过（catch continue）语义不变；MUST 每 entry stat 保留（mtime 排序依赖） | file_op_tools.md §5 | -6/+8 |
| tools | app/server/src/tools/file-grep.ts | fileGrepTool.run + jsGrep | 修改 | `jsGrep` 改 async（walk 内 `readdirSync/statSync/readFileSync` → await promises 版），run 内 `await jsGrep(...)`。**runRipgrep/rgAvailable 的 spawnSync('rg') 保持不动**（子进程 + 5s timeout 强杀，非本线程 native fs） | MUST rg 优先/JS 降级顺序不变；MUST headLimit/glob 过滤/正则 lastIndex 重置语义不变；MUST 非法正则 isError 文案不变 | file_op_tools.md §6 + v0.0.328 P3 加固 | -10/+12 |

### E 组：测试处置

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tests | app/server/src/tools/__tests__/engine-worker-pool.test.ts | 全部（AC#1-#5 fake pool 分流） | 删除 | 整个文件删除（分流逻辑已不存在，无对应代码可测） | MUST 删除 | v0.0.307 T2 | -384 |
| tests | app/server/src/__tests__/bootstrap-worker-pool.test.ts | 全部（AC#1/#2 装配） | 删除 | 整个文件删除（装配段已删，engine.workerPool getter 已删） | MUST 删除 | v0.0.307 T3 | -86 |
| tests | app/server/src/tools/__tests__/tools.test.ts / file-write.test.ts / file-edit.test.ts / file-grep-robust.test.ts | 各 run 调用 | 修改（仅如需要） | 已全部 `await tool.run(...)`，**预期零改动**；全量 UT 后如有断言依赖 sync 时序再同步 | MUST 行为断言不改（契约不变）；MUST 全量 `bun run test` 绿 | 现有测试 | 0 |
| tests | app/server/src/persistence/__tests__/fs-io 相关（如有） | atomicWriteAsync | 新增 | 补 atomicWriteAsync 单元测试（原子写 + 异常清理 tmp），对齐 atomicWriteSync 现有测试结构 | MUST 覆盖 tmp→rename + 失败清理 | fs-io.ts | +30 |

## 影响面评估

- **删除面**：`worker-pool/` 目录 6 文件（~819 行）+ `engine-worker-dispatch.ts`（74 行）+ 2 个测试文件（470 行）。全为 v0.0.307 专项产物，无其他消费方（已 grep 全仓）。
- **修改面**：engine.ts（-25）、bootstrap-agent-phase.ts（-11）、bootstrap.ts（注释）、fs-io.ts（+25 新增函数）、5 个工具文件（各 ~10 行变动）、fs-io 测试（+30）。
- **破坏性变更**：`ToolExecutionEngine` 构造签名从 `(approvalManager?, workerPool?)` 变回 `(approvalManager?)`。已 grep：现有测试仅单参构造（engine-hitl/permission-gate/runtool-timeout 等），无破坏。`isWorkerableTool` re-export 删除，无外部消费方（仅 engine.ts 自用）。
- **依赖顺序**：A 组（删 pool）与 B 组（拆接线）同 task（同一 reviewer 核对引用清零）；C 组（atomicWriteAsync）先于 D 组 write/edit；D 组各工具独立。
- **风险点**：
  1. glob/grep 递归改 async 后，大目录遍历变成数千个 microtask 级 await stat——单次 await 成本 ~μs，对比原 sync 全程阻塞（UI 彩虹圈）是净收益；若实测吞吐劣化严重（>2x），在 change_log 记录并评估 Dirent.isDirectory() 免 stat 优化（本次不做，保持契约）。
  2. read 超大文件：已有 limit（默认 2000 行）截断输出；readFile 一次性读入内存的行为与现状一致（sync 版同样全量 readFileSync），不新增风险。超大文件截断/分段策略：依赖 offset/limit 分页（现状机制，不新增阈值）。
  3. grep jsGrep 改 async 后 headLimit 提前终止语义（emitted >= headLimit 即 return）不变，异步化不影响计数顺序（串行 for...of await）。
  4. write/edit 锁内 async IO：withFileLock 持锁范围 = 整个 fn（含 await 落盘），FIFO 串行语义不变（file-lock.ts 已是 async 设计）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计

## 标准沉淀（分层边界，随 change_log 记录）

1. **工具层 fs 操作标准（本版本起生效）**：tools/ 下新增/修改 fs 操作一律 `node:fs/promises` + await（真异步，libuv 线程池，不阻塞 event loop）；禁止在工具层新增 sync fs 调用（spawnSync 子进程类除外，如 grep 的 rg）。
2. **persistence 层边界**：存量 sync fs 路径用 fs-yield 兜底（acquireFsSlot/trackFsTime），本版本不动、不强制迁移（fs-store.ts 继续现状）。
3. **atomicWriteSync/Async 并存**：sync 版服务 persistence 存量 54 处调用方；async 版服务工具层。存量调用方迁移列为后续版本，不在 v0.0.345 范围。

## 附：specs 同步点（doc-modifier 在版本验证后执行，非 coder 范围）

1. `specs/tech/agent/tools/[P0]tool_execution_engine.md` L19/L272/L284：删除 worker pool 描述（"单工具执行可经 worker pool 挪线程"等），改为「工具在主线程串行执行；工具层 fs 操作一律 fs.promises 真异步（libuv 线程池），不阻塞 event loop」。
2. `specs/tech/agent/tools/[P0]file_op_tools.md`：补规范小节「工具层 fs 操作标准：IO 调用一律 node:fs/promises + await；persistence 层存量 sync 路径用 fs-yield 兜底；禁止在工具层新增 sync fs 调用」。
3. `specs/tech/version_logs/v0.0.345/change_log.md`：记录上述标准 + 实现偏差。
