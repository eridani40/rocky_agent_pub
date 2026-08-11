# v0.0.309 变更计划书 — fix: worker pool readSet 跨线程传递断裂

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## Bug 根因

v0.0.307 把 read/write/edit/glob/grep 挪 worker 线程执行后，readSet（已读文件路径集合）跨线程传递断裂：

1. **submit 没传 readSet**：`engine-worker-dispatch.ts` L45-51 `pool.submit()` 只传了 workdir，没传 `ctx.readSet` 快照
2. **worker 端每次 new 空 readSet**：`worker-entry.ts` L94 `const readSet = new Set<string>()`

结果：read 在 worker A 内 `readSet.add(path)` 成功 → 回传 readSetAdditions 给主线程 apply。但下次 edit 去时（可能分配到 worker B 或同一线程），worker 又拿到空 readSet → `readSet.has(path)` false → 报 `[not_read] File has not been read yet`。

## 修复方案

**快照传入法**：每次 submit 时把主线程当前 `ctx.readSet` 全量快照（`Array.from(ctx.readSet)`）传给 worker。worker 端用传入数组初始化 `new Set(request.readSet)`。

**为什么不共享而非快照**：worker_threads 间 Set 对象不共享（structuredClone 序列化边界），快照传入是 postMessage 唯一可行方式。单次快照成本极低（readSet 通常 <100 条路径，Array.from + 序列化 <1ms），不影响性能。

## 架构决策

| # | 决策 | 内容 |
|---|---|---|
| **D1** | 全量快照传入 | 每次 submit 传 `Array.from(ctx.readSet)`；worker `new Set(request.readSet)`。简单可靠，无需持久化 readSet 到 worker 生命周期。 |
| **D2** | 三处类型同步 | `WorkerPoolTask` + `ToolWorkerRequest` + `ToolWorkerResponse` 三接口需同步加 readSet 字段（前两个加传入字段，Response 已有 readSetAdditions 不变）。 |
| **D3** | worker-bundle.cjs 必须同步 | bundle 是 esbuild 预构建产物，改完源码必须重新生成 bundle。coder 用 `npx esbuild worker-entry.ts --bundle --platform=node --format=cjs --outfile=worker-bundle.cjs`。 |
| **D4** | 向后兼容 | readSet 字段可选（`readSet?: string[]`）；undefined 时 worker 回退 `new Set()`（当前行为），不破坏已有 fake pool UT。 |

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

### A 组：类型定义 — readSet 字段加入请求载荷

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| worker pool | app/server/src/tools/worker-pool/types.ts | WorkerPoolTask | 修改 | 加 `readSet: string[]` 字段（主线程快照 ctx.readSet 的数组形式） | MUST 与 ToolWorkerRequest 同构；字段名 readSet | types.ts:29-40 现状 | +1 |
| worker pool | app/server/src/tools/worker-pool/types.ts | ToolWorkerRequest | 修改 | 加 `readSet: string[]` 字段（worker 线程收到的 readSet 快照） | MUST 与 WorkerPoolTask 同构 | types.ts:65-71 现状 | +1 |

### B 组：主线程 — submit 传入 readSet 快照

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响 |
|---|---|---|---|---|---|---|---|
| engine-dispatch | app/server/src/tools/engine-worker-dispatch.ts | runViaWorker() | 修改 | `pool.submit()` 调用处加 `readSet: ctx.readSet ? Array.from(ctx.readSet) : []`（主线程 readSet Set → 数组快照传 worker） | MUST `Array.from` 序列化（Set 不能跨 postMessage）；MUST ctx.readSet 为 undefined 时传空数组（向后兼容）；MUST NOT 传 Set 实例（structuredClone 边界） | engine-worker-dispatch.ts:45-51 现状；engine.ts:204 ctx.readSet 来源 | +1 |

### C 组：worker 端 — 用传入 readSet 初始化

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响 |
|---|---|---|---|---|---|---|---|
| worker-entry | app/server/src/tools/worker-pool/worker-entry.ts | executeWhitelistedTool() | 修改 | `new Set<string>()` 改为 `new Set<string>(req.readSet)`（用主线程传入的 readSet 快照初始化，而非空 Set） | MUST 用 `req.readSet`（主线程快照）；MUST `readSetAdditions` 仍回传全量 `Array.from(readSet)`（含传入+本次新增） | worker-entry.ts:94 现状 | +1/-1 |
| worker-bundle | app/server/src/tools/worker-pool/worker-bundle.cjs | executeWhitelistedTool() | 修改 | 同上：`new Set()` 改为 `new Set(req.readSet)`（bundle 内等价逻辑同步） | MUST 与 worker-entry.ts 逻辑完全一致；MUST coder 改完源码后重新生成 bundle（`npx esbuild ... --bundle ...`） | worker-bundle.cjs:643 现状 | +1/-1 |

### D 组：UT — read→edit 跨 worker 链路覆盖

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响 |
|---|---|---|---|---|---|---|---|
| UT | app/server/src/tools/__tests__/engine-worker-pool.test.ts | describe('read→edit 跨 worker 链路') | 新增 | 新增 test case：真实 read→edit 同一文件，走 worker pool（非 fake），验证 edit 不报 `[not_read]`。需要注入真实 ToolWorkerPool 或验证 submit 传参含 readSet。 | MUST 覆盖 read→edit 链路（核心 bug 复现路径）；MUST 验证 submit task 中 readSet 字段被正确传递；涉及 worker_threads = Node 原生 API，必须 bun + Node 双 runtime 跑 | engine-worker-pool.test.ts:79-130 现有 fake pool 框架 | +40 |

## 文件级变更清单

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| app/server/src/tools/worker-pool/types.ts | 修改 | WorkerPoolTask + ToolWorkerRequest 各加 `readSet: string[]` 字段 |
| app/server/src/tools/engine-worker-dispatch.ts | 修改 | runViaWorker() submit 调用加 `readSet: Array.from(ctx.readSet)` 快照 |
| app/server/src/tools/worker-pool/worker-entry.ts | 修改 | executeWhitelistedTool() `new Set()` → `new Set(req.readSet)` |
| app/server/src/tools/worker-pool/worker-bundle.cjs | 修改 | 同步 worker-entry 改动（重新生成 bundle） |
| app/server/src/tools/__tests__/engine-worker-pool.test.ts | 修改 | 新增 read→edit 跨 worker 链路 test case |

## 不做的事（明确排除）

1. **不做 worker 内持久 readSet**：不在 worker 生命周期维护 readSet 状态。每次请求传入全量快照——简单可靠、无状态一致性问题。worker 池多线程场景下各 worker 各自快照天然隔离。
2. **不做增量 readSet 传递**：不优化为只传 diff。readSet 通常 <100 条路径，全量快照 <1ms，增量逻辑复杂度不值得。
3. **不改 readSetAdditions 回传机制**：worker 仍回传 `Array.from(readSet)` 全量（含传入+本次新增），主线程统一 apply。这部分 v0.0.307 D5 设计正确，不需动。
