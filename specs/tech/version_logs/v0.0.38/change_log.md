# v0.0.38 Tech Change Log — fs store 统一写锁（进程内 async path-lock + write/edit 工具加锁）

> version: 1.0 · 2026-07-01
> 范围：FsCrudStore 写路径并发串行化 + file-write/file-edit 工具加锁 + 直写 fs-io 的 board store 加锁。**纯基础设施改动，无对外 HTTP API/UI 契约变更**（`putAsync`/`deleteAsync` 是 engine 内部扩展，不在 CrudStore interface 上；工具 input/output 不变）。
> 权威方案：`specs/tech/persistence/[P1]file_write_lock.md`（架构师产 + doc-modifier 校对代码后修正）。
> 验证：UT 3663 passed / 0 fail（`bun run test`）；真服务 AT 3/3 passed（`tests/api/lib/run_all.sh`）；`bun run typecheck` EXIT 0。

---

## 1. 改动摘要

### 1.1 锁原语（新增）

`app/server/src/persistence/file-lock.ts`（100 行）：进程内 async mutex，按 `path.resolve(filePath)` 规范化后的绝对路径为 key 的 FIFO 串行队列。两模式：

| API | 语义 | 当前 callsite |
|---|---|---|
| `withFileLock(path, fn)` | 同步等待：await 返回 fn 结果，fn 抛错冒泡给调用方 | board store（goal/requirement/task/idGen）+ write/edit 工具 |
| `enqueueFileWrite(path, fn)` | fire-and-forget：立即返回 void，错误 log 不抛 | **无生产 callsite**（保留为 future best-effort 写入选项） |
| `getLockSize()` | test-only：验证 entry GC 后无残留 | UT |

**特性**：非重入（callsite 全核查无同 path 嵌套，YAGNI 不引 AsyncLocalStorage/depth）；错误隔离（tail 链永不 reject，单项失败不影响后续）；entry GC（所有项 settle 后从 Map 删除，防泄漏）；无第三方依赖；无超时（YAGNI）。

### 1.2 FsCrudStore async 扩展（engine 专有，不动 CrudStore 契约）

FsCrudStore 类新增 `putAsync/deleteAsync`（**不在 CrudStore interface 上**）；sync `put/delete` 保留（事件循环原子，非并发路径仍可用）：

- `putAsync` = `withFileLock(targetWritePath, () => this.put(...))`
- `deleteAsync` = `withFileLock(targetWritePath, () => this.delete(...))`
- **targetPath 算法**：json 单文件 → 锁 `{id}.json` 完整路径（同 record 并发 put 串行）；jsonl 段文件 → 锁 `entitySegmentDir`（同 shard 同 entity 的所有 jsonl 写串行，因段名=段首 id 会随删首行变化，锁段文件会漏）。

CompositeStore 增同名 forwarder（`MaybeAsyncEngine = CrudStore & { putAsync?; deleteAsync? }`）：engine 有则委托，无则退化为 `Promise.resolve(engine.put(...))`。**SqliteCrudStore 零影响**（无 putAsync → 自动退化；SQLite 自身事务串行）。

### 1.3 工具加锁（`tools/file-{write,edit}.ts`）

- `file-write`：`writeFileSync` → `atomicWriteSync`（补崩溃原子）+ `withFileLock(filePath, async () => atomicWriteSync(...))`。
- `file-edit`：`readFileSync → countOccurrences → replace → atomicWriteSync` 整段在同一 `withFileLock` 闭包内；**occurrences 在锁内重判**（防 read 后被另一 edit 插写改了计数 → C8/C9 场景）。

### 1.4 callsite 迁移（27 + 8 处）

**27 处 CrudStore 调用**（`crud.put/delete` → `crud.putAsync/deleteAsync`，经 CompositeStore forwarder）：

| 模块 | 文件 | 处数 | 模式 |
|---|---|---|---|
| SquadStore / MemberStore / CharterHistoryStore | stores/squad-store.ts | 5 | [wait] |
| SessionStore（create/update/delete/appendMessage/createRun/updateRun/appendSummary/usage） | agent/session-store.ts | ~10 | [wait] |
| SessionStateMachine（10 状态转换 puts + reconcile） | agent/session-state-machine.ts | ~10 | [wait] |
| SessionWorkspaceStore | agent/session-workspace-store.ts | 2 | [wait] |
| SessionClearOp（cascade + summary + session） | agent/session-clear-op.ts | 4 | [wait] |
| SessionUnreadOps（markUnread/markRead） | agent/session-unread-ops.ts | 2 | **[fNF]** |

**[fNF] 实现注记**：`SessionUnreadOps` 用 `void crud.putAsync(...).catch(e => log(...))`（不 await 即 fire-and-forget；锁仍生效串行落盘，错误 catch log）。**未用** `enqueueFileWrite(path, () => crud.putAsync(...))` 外层包锁——会重复入队（同 path 仍串行无死锁，仅冗余）。

**8 处直写 fs-io**（`atomicWriteSync` 外包 `withFileLock`）：

| 模块 | 文件 | 锁颗粒 |
|---|---|---|
| GoalStore（create/addKr/updateGoal/updateKrProgress） | stores/goal-store.ts | `{goalId}.json` |
| RequirementStore（create/update） | stores/requirement-store.ts | `{reqId}.json` |
| TaskStore（create/update） | stores/task-store.ts | `{taskId}.json` |
| BoardContext.idGen.next（counters.json 读改写） | stores/board-shared.ts | `counters.json` |

> board 子 store 锁颗粒 = 单 record 文件路径，**不锁整个 board 目录**（不同 record 可并行；idGen 锁 counters.json 单独路径）。idGen.next 自身 `withFileLock(countersFile)` 与 createGoal 的 `withFileLock(goalFile)` 是**不同 path 嵌套**，合法（spec §3.3）。

### 1.5 不迁 [skip]

- bootstrap.ts 启动期一次性写（单写者、启动期无并发）
- `Map`/`Set` 内存结构（event-hub.subs / inbox.buckets 等，非文件 IO，事件循环原子）
- 查询路径（get/query/list*，只读无须锁）
- SqliteCrudStore 全部路径（SQLite 自身事务串行）
- task-tool claimLocks（工具层 CAS，与 store 层 withFileLock 互补，保留）

---

## 2. 动机（根因）

squad 多角色 = **单 Node 进程内 async agent**（child 是 session 非 process）。Agent loop 在 await LLM/工具时让出事件循环 → 同 session/squad 的多个写操作在 **两次 sync put 之间的 read-modify-write 序列** 上交错：

- **丢更新**：A 读旧值 → B 读旧值 → A 写 → B 写覆盖 A（如 squad record 并发 charter init + member join）
- **jsonl 段文件 tmp 互相覆盖**：同段并发重写
- **`counters.json` / 信封 version 的 read-modify-write 竞态**：同 squad 并发 createGoal + createTask 拿到重复 id
- **file-edit 的 read-modify-write 竞态**：read 时唯一不代表 write 时唯一

`atomicWriteSync` 只保**崩溃原子**（rename tmp→real），**不保并发原子**。本版补「并发原子」：进程内 async mutex。

---

## 3. 设计决策（三段式，详 `[P1]file_write_lock.md`）

1. **engine 专有 async 扩展，不动 CrudStore interface**——避免 sqlite-store 被迫实现空 async 污染所有 engine；forwarder 自动退化。反例：在 CrudStore interface 加 async → 破坏 sync 契约。
2. **锁颗粒 = 路径（文件 or 段目录），非整个 root**——不同 record/file 可并行，串行范围最小化。jsonl 锁段目录因段名会变（删首行）。
3. **非重入**——全部 callsite 核查无同 path 嵌套（putAsync 内部是 sync put 不再入锁；fNF 走 `void putAsync().catch()` 非外层包锁；直写 store/工具/idGen 各单层），YAGNI 不引 AsyncLocalStorage/depth。约束：callsite 禁止 `withFileLock(p, () => …withFileLock(p,…)…)` 同 path 嵌套；不同 path 嵌套合法。
4. **fNF 用 `void putAsync().catch(log)` 而非 enqueueFileWrite 外包**——putAsync 内部已 withFileLock 同 path，外层再包 enqueueFileWrite 重复入队（冗余无死锁）；采纳更简洁的 callsite 自决模式。enqueueFileWrite 保留为 future best-effort 写入选项（当前无生产 callsite）。
5. **edit occurrences 锁内重判**——read 时唯一不代表 write 时唯一（中间被插写）；必须锁内重新 countOccurrences。

---

## 4. 影响的 specs

| spec | 改动 |
|---|---|
| `specs/tech/persistence/[P1]file_write_lock.md`（v0.0.38 新建） | 锁原语设计 + FsCrudStore async 扩展 + 工具/board 加锁 + callsite 迁移表 + 并发场景（C1-C13） |
| `specs/tech/persistence/[P0]fs_crud_store_engine.md` §5.3 | 进程内并发从「建议」改为「已实现（v0.0.38）」+ 指向 `[P1]file_write_lock.md` |
| `specs/tech/persistence/index.md` | 导航表加 file_write_lock 节点 |
| `specs/tech/persistence/log.md` | v0.0.38 变更条目（修正：非重入） |
| `specs/api/overall/*` | **无改动**（putAsync/deleteAsync 是 engine 内部，HTTP API 契约不变） |
| `specs/prd/version_logs/v0.0.38/change_log.md` | infra 条目（无用户可见功能变化） |

---

## 5. 测试

- **UT 3663 passed / 0 fail**（309 test files，`bun run test`）；含锁原语专项（FIFO/错误隔离/entry GC/非重入约束）+ 各 store 异步迁移回归。
- **AT 3/3 passed**（真服务 `tests/api/lib/run_all.sh`，`ROCKY_TEST_MOCK_LLM=0`）：
  - 并发 put 同 session 无丢更新（C1/C2 类）
  - squad 多角色并发激活写 squad/member record 串行（C5 类）
  - file-edit 并发同文件 occurrences 锁内重判（C8/C9 类）
- **typecheck EXIT 0**（`bun run typecheck`）。

---

## 6. 涉及代码

| 文件 | 行数 | 角色 |
|---|---|---|
| `app/server/src/persistence/file-lock.ts` | 100 | 锁原语（withFileLock + enqueueFileWrite + getLockSize） |
| `app/server/src/persistence/fs-store.ts` | 299 | putAsync/deleteAsync + targetWritePath 算法 |
| `app/server/src/persistence/composite.ts` | 132 | putAsync/deleteAsync forwarder + MaybeAsyncEngine 类型 |
| `app/server/src/tools/file-write.ts` | 90 | atomicWriteSync + withFileLock 包装 |
| `app/server/src/tools/file-edit.ts` | 148 | read+replace+atomicWriteSync 整段入锁 |
| `app/server/src/stores/{squad,session,goal,requirement,task,board-shared}-store.ts` + `agent/session-{store,state-machine,workspace-store,unread-ops,clear-op}.ts` | — | callsite 迁移（crud.putAsync/deleteAsync 或 withFileLock） |

---

## 7. out of scope（明确不做）

- **watcher / 目录预建**：fs engine 目录懒建行为不变；锁不解决「段目录首次写入时 watcher addDir 事件丢失」（见 memory `chokidar-watcher-await-ready-addDir`，属 watcher 层面）。
- **可观测 metric**：不加锁等待时长/队列深度统计（YAGNI；需时另起 observability 版本）。
- **多进程共享 root**：本锁纯进程内，多进程场景须上层协调（如 file lock fcntl）或换 SQLite engine。
- **enqueueFileWrite 落地**：保留为 future 原语，当前 fNF 全走 `void putAsync().catch(log)`。
- **task-tool claimLocks 改造**：工具层 CAS（read task → 验 assignee → set）与 store 层 withFileLock 互补，保留现状。
