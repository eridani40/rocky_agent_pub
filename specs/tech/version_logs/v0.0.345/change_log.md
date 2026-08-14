# v0.0.345 change_log — 撤 worker pool + 工具层 fs.promises 真异步

> 对应需求：`reqs/[working] v0.0.345.worker-pool-removal.md`（两次 crash brk 0 SIGTRAP 根因 = worker_threads 共享地址空间，见 researcher 报告 + v0.0.307 引入记录）。
> 权威契约：`specs/tech/version_logs/v0.0.345/change_plan.md`（D1-D5，frozen）。
> commit：`bc6c8ba71`（refactor 主体：25 files +490/-2143）+ `752ad3316`（code-review Minor 修复）。

## 变更摘要

v0.0.307 引入的 worker_threads 线程池（白名单纯 IO 工具挪线程）是两次 native crash（brk 0 SIGTRAP）的崩溃面——worker_threads 与主线程共享同一 OS 进程地址空间，native abort 直接终止整个进程，JS exit/error handler 形同虚设。本版本**整体删除 worker pool**，工具回主线程串行执行；阻塞风险改由**工具层 fs 操作全部 `node:fs/promises` 真异步**（libuv 线程池、进程内、Electron 自身天天用，无 worker 那类 native 崩溃）解决。老板 13:33 否定分散化（sync+fs-yield 混合）、13:37 最终拍板 fs.promises 全改。

| 决策 | 内容 |
|---|---|
| D1 | worker-pool/ 目录 6 文件 + engine-worker-dispatch.ts + 2 测试文件全删（~2143 行）；engine 分流接线拆除；工具回主线程 |
| D2 | read/write/edit/glob/grep 五工具 IO 改 `node:fs/promises` + await；`spawnSync('rg')` 保留（子进程 + 5s timeout 强杀） |
| D3 | 分层边界：工具层 = fs.promises 真异步（本次全改）；persistence 层存量 sync fs = fs-yield 兜底（**不动**） |
| D4 | 工具对外行为契约不变（输入/输出/isError/错误码/文案/readSet 全不变，仅 IO 调用层换实现） |

## 根因边界声明（bug-analyst 报告 2026-08-13 14:29 诚实标注）

依据 `states/worker-crash-isolation/bugs/BUG-345-worker-crash-root-cause-[open].md`（机器码级实证）：崩溃指令 = Electron Framework 内 async_hooks `push_async_context` 路径的 CHECK trap（brk/hlt/brk 三连）。**撤池消除的是 worker 高频触发面（放大器），不是根因**——同一 trap 在主线程也可达（08-08 0.0.295 主线程崩溃、早于 pool 引入为证），本版本**不保证崩溃彻底消除**。长期候选方向 = Electron 升级（42.4.1 → 内嵌 Node 24 新补丁）直接消除 Node 层 CHECK 缺陷，列为后续版本评估，非本次范围。

## 实现核对（A-E 组）

| 计划项 | 实现一致性 |
|---|---|
| A 组 worker pool 删除 | ✅ 6 文件 + engine-worker-dispatch.ts + engine-worker-pool.test.ts + bootstrap-worker-pool.test.ts 全删；全仓 `worker_threads`/`worker-pool`/`WORKERABLE_TOOL_NAMES`/`ToolWorkerPool` 零残留（`build:worker` 为 browser playwright 产物，合同豁免） |
| B 组 engine + bootstrap 接线拆除 | ✅ engine.ts 构造恢复单参 `(approvalManager?)`、`_workerPool`/`workerPool` getter 删、runTool 直调 `tool.run(...)`（对照旧 `runViaTool` 源码 = 纯直调，语义等价）；Promise.race backstop / TIMEOUT_SENTINEL / abort / try-catch 转 RUNTIME_ERROR 全部未动；bootstrap-agent-phase 装配段删、`new ToolExecutionEngine(undefined)`；全仓 `new ToolExecutionEngine(` 调用点均单参/零参 |
| C 组 atomicWriteAsync | ✅ fs-io.ts 新增 `atomicWriteAsync`（同目录 `.tmp` → fsync → rename，异常清理 tmp）；`atomicWriteSync` 原函数未动（persistence 层存量 54 处调用方，本次不迁移） |
| D 组五工具 fs.promises | ✅ read：stat/readFile await 化；write：stat 捕获判存在 + mkdir recursive + 锁内 atomicWriteAsync；edit：锁内 readFile await + occurrences 锁内重判 + atomicWriteAsync；glob：walk 改 async 递归（MAX_DEPTH=20 未动、每 entry stat 保留）；grep：仅 jsGrep 降级路径 async 化，runRipgrep 的 spawnSync('rg') 保留。错误码/文案逐字未变，readSet 语义未动 |
| E 组测试 | ✅ 新增 fs-io.test.ts（69 行，mkdtempSync 隔离）；现有测试零断言改动；全量 UT 10413 passed / 4 skipped / 0 failed + tsc -b 全过 |

## 实现偏差（编码/评审期，以代码为准）

1. **code-review Minor 修复**（`752ad3316`）：atomicWriteAsync 原实现仅 rename 失败清理 tmp，writeFile/sync 抛错（磁盘满/权限）会残留 `.tmp` 半成品，违反「MUST 异常时清理 tmp（finally 兜底）」。已修复：finally 内 `written` 标记 + `if (!written) unlink(tmp)` 兜底。
2. **fs-io.test 异常清理用例用真实 EISDIR 触发**：目标路径设为已存在目录 → open/写/fsync 成功、`rename(file → dir)` 必失败（EISDIR），真实触发 rename 失败路径而非 mock。
3. **bootstrap.ts 注释变更实际 3 处**（change_plan 写 2 处）：L41 import 注释 + L114 BootstrapDeps.toolEngine 字段注释 + L495 注入注释，均为「[v0.0.307] …（UT 验证 workerPool 注入用）」改普通描述，无物理字段动。

## 标准沉淀（分层边界，本版本起生效）

1. **工具层 fs 操作标准**：tools/ 下新增/修改 fs 操作一律 `node:fs/promises` + await（真异步，libuv 线程池，不阻塞 event loop）；禁止在工具层新增 sync fs 调用（spawnSync 子进程类除外，如 grep 的 rg）。→ 已落 `[P0]file_op_tools.md §7` + `[P0]tool_execution_engine.md §1/§6/§7`。
2. **persistence 层边界**：存量 sync fs 路径用 fs-yield 兜底（acquireFsSlot/trackFsTime），本版本不动、不强制迁移（fs-store.ts 继续现状）。
3. **atomicWriteSync/Async 并存**：sync 版服务 persistence 存量调用方；async 版服务工具层（write/edit）。存量调用方迁移（54 处，>10 文件跨模块）列为后续版本，不在 v0.0.345 范围。

## 关键文件（编码产出）

| 文件 | 变更 |
|---|---|
| `app/server/src/tools/worker-pool/`（6 文件）+ `engine-worker-dispatch.ts` | 全删（-819/-74） |
| `app/server/src/tools/engine.ts` | 构造单参恢复 + runTool 直调（-25） |
| `app/server/src/bootstrap-agent-phase.ts` / `bootstrap.ts` | 装配段拆除（-11）/ 仅注释（3 处） |
| `app/server/src/persistence/fs-io.ts` | 新增 atomicWriteAsync（+32，含 review 修复） |
| `app/server/src/tools/file-{read,write,edit,glob,grep}.ts` | 五工具 IO 改 fs.promises + await（各 ~10 行） |
| `app/server/src/persistence/__tests__/fs-io.test.ts` | 新增（+69，原子写 + 真实 EISDIR 异常清理） |
| `app/server/src/tools/__tests__/engine-worker-pool.test.ts` + `app/server/src/__tests__/bootstrap-worker-pool.test.ts` | 全删（-470） |

## 文档同步（doc-modifier，本版本）

- **`specs/tech/agent/tools/[P0]tool_execution_engine.md`**：§1 串行段删「可经 worker pool 挪线程」改「工具一律在主线程执行；工具层 fs 操作一律 fs.promises 真异步」；§6 边界「不并发执行」条同步；§7 零件表 worker 线程池行改为「工具在主线程串行执行 + fs.promises 真异步（指向本文 §1；历史 worker 池见 v0.0.307/v0.0.345 change_log）」。
- **`specs/tech/agent/tools/[P0]file_op_tools.md`**：新增 **§7 工具层 fs 操作标准**（IO 一律 node:fs/promises + await；persistence 层存量 sync 用 fs-yield 兜底；禁止工具层新增 sync fs；write/edit 落盘走 atomicWriteAsync）；原 §7 边界顺延 §8 并补标准归属行。
- **`specs/tech/persistence/[P1]file_write_lock.md`**：§5 工具改动点 sync 伪码改 async 版（withFileLock 包 readFile/atomicWriteAsync）；§6.3 callsite 表 fileWriteTool.run/fileEditTool.run 行更新为 atomicWriteAsync + 现行号（file-write.ts:93 / file-edit.ts:100）。
- **KB log.md**：`specs/tech/agent/tools/log.md` + `specs/tech/persistence/log.md` 各补本版本条目。
- **v0.0.307/v0.0.309 历史 change_log 不改**（历史版本叙述保留原样，worker pool 沿革以本 change_log 终结）。
