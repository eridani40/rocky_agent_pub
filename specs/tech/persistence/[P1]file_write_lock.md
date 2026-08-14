---
type: spec
title: File Write Lock（进程内文件写加锁）
priority: P1
status: active
updated: 2026-08-13
since: v0.0.38
---

# File Write Lock（进程内文件写加锁）

## 1. 概述

**管什么**：FsCrudStore 写路径 + file-write/file-edit 工具 + board 子 store（直写 fs-io）的**进程内并发串行化**；以及锁原语 `file-lock.ts` 的设计。
**不管什么**：CrudStore 契约（→ `[P0]crud_store_interface.md`，**不动**）、SQLite engine（→ `[P0]sqlite_crud_store_engine.md`，**零影响**）、多进程共享写（→ §5 out of scope）、watcher / 目录预建 / 可观测 metric（v0.0.38 notInScope）。

**问题**：FS engine 现状是 sync read-modify-write + `atomicWriteSync`，**只保崩溃原子、不保并发原子**。squad 多角色 = 单 Node 进程内 async agent 并发（child 是 session 非 process），同一 session/squad 的多个写操作可能在 await 点交错，导致：
- 丢更新（A 读旧值 → B 读旧值 → A 写 → B 写覆盖 A）
- jsonl 段文件 tmp 互相覆盖（同段并发重写）
- `counters.json` / 信封 version 的 read-modify-write 竞态
- file-edit 的 read-modify-write 竞态

**解**：进程内 async mutex（按绝对路径 key），写操作经 `withFileLock(path, fn)` 串行；FS engine 提供 async 扩展方法 `putAsync/deleteAsync`（不动 sync 契约）；工具与直写 fs-io 的 store 直接用 `withFileLock`。

## 2. 进程模型与并发范围（关键前提）

| 事实 | 推论 |
|---|---|
| squad 多角色 = **单 Node 进程内 async agent**（child=session 不是 process） | 锁原语 = 进程内 async mutex，**无需 flock / 跨进程协调** |
| Agent loop 在 await LLM/工具时让出事件循环 | 同 session 多个写操作的 sync 段虽不真并发，但**跨 await 点**会交错（A 的 put 在 await 之间被 B 的 put 插队） |
| `atomicWriteSync` 是 sync 调用，单次 put/delete 内部不让出 | 单次 sync put 内部无竞态；竞态发生在**两次 sync put 之间**的 read-modify-write 序列里 |

**结论**：锁的颗粒 = **路径（文件 or 目录）**；持锁范围 = **整个 read-modify-write 序列**（含 sync 落盘）。锁实现无须中断 sync 代码，只须在序列外层包一层 async 函数。

## 3. 锁原语设计 `app/server/src/persistence/file-lock.ts`

### 3.1 API（两模式）

```typescript
/** 模式 1：同步等待 — await 返回 fn 结果；fn 抛错则冒泡给调用方 */
export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T>;

/** 模式 2：fire-and-forget — 入队后立即返回 void；fn 错误 log 不抛 */
export function enqueueFileWrite(filePath: string, fn: () => Promise<unknown>): void;
```

**语义**：
- 同 `filePath`（normalize 后）的调用按 FIFO 串行；不同 filePath 并行。
- `withFileLock` 持锁直至 fn settle（resolve/reject）；下一个排队项 then 接管。
- `enqueueFileWrite` 内部 = `withFileLock` 但 swallow 错误（`catch(e => log)`），不阻塞调用方。
- 两模式共享同一队列（同 path 的 withFileLock 与 enqueueFileWrite 互斥串行）。

### 3.2 key 规范化

```typescript
const key = path.resolve(filePath);  // 绝对 + 去 ./../ + 去尾斜杠
```
- 不解析 symlink（避免 IO，且本工程数据 root 不用 symlink）。
- 大小写敏感（macOS dev 环境 case-sensitive 不强制，但工程内路径调用方一致）。

### 3.3 非重入（同 path 嵌套禁止 — 简化决策）

**结论**：锁**非重入**；同 path 在同一 async chain 内**不得嵌套** `withFileLock`，否则自死锁。
**理由（为何不需要可重入）**：核查全部 callsite，无一嵌套同路径锁——
- `putAsync`/`deleteAsync` 内部是 **sync put/delete**（直接 `atomicWriteSync`/`jsonlPut`，不再调 `withFileLock`），不二次入锁；
- fire-and-forget 走 `void crud.putAsync(...).catch(log)`（**非** `enqueueFileWrite(path, () => putAsync)` 外层包锁），无嵌套；
- 直写 fs-io 的 store / 工具 / idGen 各自**单层** `withFileLock`。
故可重入永不被触发，引入 `AsyncLocalStorage`/depth 是无收益复杂度（YAGNI）。
**约束**：callsite 禁止 `withFileLock(p, () => ... withFileLock(p, ...) ...)` 同 path 嵌套（code-review 逐 callsite 核）。不同 path 嵌套合法（独立锁 key，无死锁）。

### 3.4 实现策略（无第三方依赖）

```typescript
// 概念伪码（实现见代码）— 非重入、FIFO 串行、错误隔离
const locks = new Map<string, Promise<unknown>>();

function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const prev = locks.get(key) ?? Promise.resolve();
  // 串到 prev 之后；prev 的错误已被吞（见下），不会短路本项
  const run = prev.then(
    () => fn(),
    () => fn(),            // prev reject 也照常执行本项（隔离）
  );
  // tail 永不 reject：吞掉本项错误，防整条链断裂
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  // 本项是最后一个且已 settle → 清 entry（防内存泄漏）
  tail.finally(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;               // 调用方拿到的 promise 仍会 reject（错误冒泡）
}
```
- `enqueueFileWrite` = `withFileLock(...).catch(e => log('file-write', e))`。
- 无 `setTimeout` / 超时（v0.0.38 不加；YAGNI）。
- Map 在 entry 归零后即删（防内存泄漏）。

### 3.5 并发安全保证范围

| 保证 | 不保证 |
|---|---|
| 同进程内、同 path 的写操作 FIFO 串行（无丢更新、无 tmp 覆盖） | 多进程共享同 root 的并发写（out of scope，spec §5） |
| read-modify-write 序列原子（持锁期间无插入写） | 跨 path 的写原子（无事务；与 CrudStore 契约一致） |
| 崩溃原子（沿用 `atomicWriteSync`） | 持锁进程崩溃后队列恢复（进程崩了锁也消失，不需要恢复） |

## 4. FsCrudStore async 扩展方法

### 4.1 设计（engine 专有，不动 CrudStore interface）

类比已有的 `now` engine 扩展（`FsCrudStoreOptions.now`），新增两个 **FsCrudStore 类上的 async 方法**（不在 `CrudStore` interface 上）：

```typescript
export class FsCrudStore implements CrudStore {
  // ... 既有 sync put/get/delete/query（不动）

  /** async put — 在 sync put 外包 withFileLock；返回 stored 记录（同步等待） */
  async putAsync<S extends SchemaDef>(
    schema: S, record: InferRecord<S>, opts?: PutOptions,
  ): Promise<StoredRecord<S>>;

  /** async delete — 在 sync delete 外包 withFileLock；返回是否实际删（同步等待） */
  async deleteAsync<S extends SchemaDef>(
    schema: S, id: string, shardKey?: string,
  ): Promise<boolean>;
}
```

- **sync put/delete 保留不动**（事件循环原子、非并发路径仍可用，零回归）。
- `putAsync`/`deleteAsync` 内部 = `withFileLock(targetPath, () => this.put(...))`（同步等待模式）。
- **没有 fire-and-forget 版**：FsCrudStore 不下场的 best-effort 语义判断。fNF 由 callsite 自决：
  - **本版采纳的 fNF 模式** = `void crud.putAsync(...).catch(e => log(...))`（不 await 即 fire-and-forget；锁仍生效串行落盘，错误 catch 吞）——见 §6.1 `SessionUnreadOps`。
  - `enqueueFileWrite` 是顶层原语（spec §3.1 模式 2），**当前无生产 callsite**（本版 fNF 全走 `void putAsync().catch()`）；保留为 future best-effort 写（如 watcher 唤醒写、metric 落盘）的入选项。

### 4.2 targetPath 算法（putAsync/deleteAsync 共用）

复用 `fs-paths.ts` 现有路径计算：
- **json 单文件**（不分片 / 分片 json）：`targetPath = resolveRecordPath(root, schema, id, { shardKey })`（即 `{id}.json` 完整路径）。锁此文件路径 → 同 record 并发 put 串行。
- **jsonl 段文件**（分片 jsonl）：put/delete 会读段、可能 roll 新段、可能改段名（删首行后）——**多个 record 可能落到同段**。锁颗粒 = **entity 段目录** `entitySegmentDir(schema, shardKey)`（即 `{root}/{dirTemplate}/{entity}/`），同 shard 同 entity 的所有 jsonl 写串行。
  - 理由：jsonl 段写是「读段→改段→重写段」，多个 record 改同段需互斥；段名（= 段首 id）也可能变，锁段文件路径会漏。锁整个段目录更粗但简单正确。
  - 反例：若按段文件锁，roll 时段名变化会导致两次写锁不同 key 仍可能竞态（roll 改名 + 并发 insert 同段）。

```typescript
// putAsync 伪码
private targetWritePath(schema, id, shardKey): string {
  if (this.isJsonl(schema)) return this.entitySegmentDir(schema, shardKey); // 锁段目录
  return resolveRecordPath(this.root, schema, id, { shardKey });            // 锁单文件
}
async putAsync(schema, record, opts) {
  const id = (record as any).id;
  const shardKey = this.isSharded(schema) ? this.extractShardKey(schema, record) : undefined;
  const lockPath = this.targetWritePath(schema, id, shardKey);
  return withFileLock(lockPath, () => this.put(schema, record, opts));
}
```

### 4.3 CompositeStore forwarder（engine-aware）

`CompositeStore` 增同名 async forwarder，让 caller（`SquadStore` / `SessionStore` 等）继续用 CompositeStore surface，不必直持 FsCrudStore 引用：

```typescript
export class CompositeStore implements CrudStore {
  async putAsync<S>(schema: S, record, opts?): Promise<StoredRecord<S>> {
    const engine = this.route(schema.entity);  // 既有路由
    // engine 有 putAsync（FsCrudStore）→ 委托；否则（SqliteCrudStore）→ 退化为 sync 包 Promise
    return typeof (engine as any).putAsync === 'function'
      ? (engine as any).putAsync(schema, record, opts)
      : Promise.resolve(engine.put(schema, record, opts));
  }
  // deleteAsync 同构
}
```
- **sqlite-store 零影响**：SqliteCrudStore 无 putAsync → CompositeStore 走 `Promise.resolve(engine.put(...))`（SQLite 自身用 db 事务串行，无需文件锁）。
- 不在 CrudStore interface 上加 → SqliteCrudStore 不需要实现 putAsync。
- engine 类型签名用 `MaybeAsyncEngine = CrudStore & { putAsync?<...>; deleteAsync?<...> }`（可选方法），`route(entity) as MaybeAsyncEngine` 后 `typeof engine.putAsync === 'function'` 守卫委托。

## 5. write/edit 工具改动点（`app/server/src/tools/file-{write,edit}.ts`）

- **加锁**：把写动作包进 `withFileLock(filePath, async () => { ... })`（**同步等待**模式，工具须返回成功失败给 agent）。
- **补崩溃原子**：裸 `writeFile` → `atomicWriteAsync`（fs-io.ts，v0.0.345 起工具层用 async 版；`atomicWriteSync` 继续服务 persistence 层存量调用，spec §3.6）。
- **edit 的 read-modify-write 整段在锁内**：`readFile → replace → atomicWriteAsync` 三步须在同一 `withFileLock` 闭包内，否则 read 与 write 之间可能被插入写。
- `ctx.readSet` 语义不变（仍是工具层的「已读」标记），加锁不影响 readSet 维护点。
- 错误处理：锁内 fn 抛错由 withFileLock 冒泡，工具 catch 后照旧返回 `errorResult`。

```typescript
// file-write 伪码（关键 diff，v0.0.345 起工具层 IO 真异步）
- writeFileSync(filePath, content, 'utf8');
+ await withFileLock(filePath, async () => { await atomicWriteAsync(filePath, content); });

// file-edit 伪码（关键 diff，read-modify-write 整段入锁）
- const body = readFileSync(filePath, 'utf8');
- const next = ...replace...;
- writeFileSync(filePath, next, 'utf8');
+ await withFileLock(filePath, async () => {
+   const body = await readFile(filePath, 'utf8');
+   const next = ...replace...;            // 唯一性/未找到 在锁内重判（防 read 后被插写改了计数）
+   await atomicWriteAsync(filePath, next);
+ });
```
- edit 的「occurrences 统计 + 唯一性判定」**移入锁内重判**：避免 read 时唯一、read 到 write 之间另一 edit 插入第二次出现导致 replace 走非预期分支（保守：锁内重新 countOccurrences）。

## 6. callsite 迁移表

> 规则：经 CrudStore.put/delete 的并发写 callsite → 改 `crud.putAsync/deleteAsync`（CompositeStore forwarder）；直写 fs-io 的 store → 用 `withFileLock`；工具 → 用 `withFileLock`。**模式标注**：[wait]=同步等待（结果依赖），[fNF]=fire-and-forget（best-effort 副作用）。不迁的标 [skip]+理由。

### 6.1 CrudStore 路径（→ putAsync/deleteAsync）

| callsite | 文件 | 操作 | 模式 | 理由 |
|---|---|---|---|---|
| SquadStore.putSquad | stores/squad-store.ts:57 | putAsync | [wait] | HTTP createSquad 需返回 stored；并发 charter init 与 member join 会争写 squad record |
| SquadStore.deleteSquad | stores/squad-store.ts:83 | deleteAsync | [wait] | HTTP 触发，须确认完成 |
| MemberStore.putMember | stores/squad-store.ts:101 | putAsync | [wait] | HTTP createMember 需返回 stored；同 squad 并发 join 热点 |
| MemberStore.deleteMember | stores/squad-store.ts:116 | deleteAsync | [wait] | 补偿回滚须确认 |
| CharterHistoryStore.appendHistory | stores/squad-store.ts:134 | putAsync | [wait] | charter 变更历史须串行；HTTP 触发 |
| SessionStore.createSession（含 cascading） | agent/session-store.ts:107 | putAsync | [wait] | HTTP create 返回 session；同 parent 并发建 child 会争 children index |
| SessionStore.updateSession / patchConfig | session-store.ts:153,447,515 | putAsync | [wait] | HTTP 更新返回 session；config 字段 read-modify-write 竞态 |
| SessionStore.deleteSession（cascade msgs/runs/summaries） | session-store.ts:251,267 | deleteAsync | [wait] | HTTP clear 须确认；cascade 是 read-modify-write 索引 |
| SessionStore.appendMessage | session-store.ts:342 | putAsync | [wait] | agent loop 须 await stored 才能 emit event；同 session 多工具并发 emit |
| SessionStore.createRun / updateRun | session-store.ts:285,317 | putAsync | [wait] | run lifecycle 须 await；同 session 多 run 并发 |
| SessionStore.appendSummary | session-store.ts:416 | putAsync | [wait] | compaction 后写 summary |
| SessionStateMachine.* 状态转换 puts | agent/session-state-machine.ts:107,126,139,153,167,190,214,253,268,283,298,319 | putAsync | [wait] | 状态机一致性关键，丢更新会卡死 loop；多路径并发触发（user interrupt + agent finish） |
| SessionUnreadOps.markUnread / markRead | agent/session-unread-ops.ts:53,77 | putAsync | [fNF] | best-effort UI 标记；调用方（event-hub 派发）不应阻塞；偶尔丢失 = UI 短暂 stale，可恢复 |
| SessionWorkspaceStore.* | agent/session-workspace-store.ts:49,99 | putAsync | [wait] | 首次 setup 须确认完成；workspaceDir 是后续路径依赖 |
| SessionClearOp clear（cascade + summary + session） | agent/session-clear-op.ts:83,85,94,120 | putAsync/deleteAsync | [wait] | HTTP clear 须确认完成；cascade 索引 read-modify-write |

**[fNF] 实现注记**：`SessionUnreadOps` 调用方用 `enqueueFileWrite(targetPath, () => crud.putAsync(...))` —— 但 putAsync 内部已 withFileLock 同 path，外层再包 enqueueFileWrite 会重复入队（同 path 仍串行，无死锁，只是冗余）。**更简洁**：crud 层提供 `putAsyncFireAndForget` 一等 API？**否决**（YAGNI）。**采纳**：SessionUnreadOps 调用方 `void crud.putAsync(...).catch(e => log(...))`（不 await 即 fire-and-forget；锁仍生效，错误由 catch log）。

### 6.2 直写 fs-io 的 board 子 store（→ withFileLock）

| callsite | 文件 | 操作 | 模式 | 理由 |
|---|---|---|---|---|
| GoalStore.createGoal / addKr / updateGoal / updateKrProgress | stores/goal-store.ts:83,128,157,182 | withFileLock(goalFile) 包 atomicWriteSync | [wait] | T3 工具需返回 stored；updateKr 是 read-modify-write（read goal → push kr → 重算 health → 写回） |
| RequirementStore.createRequirement / updateRequirement | stores/requirement-store.ts:56,84 | withFileLock(reqFile) | [wait] | T3 工具需返回 stored；update 是 read-modify-write |
| TaskStore.createTask / updateTask | stores/task-store.ts:64,92 | withFileLock(taskFile) | [wait] | 同上；CAS claim 是 read-modify-write（read task → 验 assignee===null → set） |
| BoardContext.idGen.next（counters.json 读改写） | stores/board-shared.ts | withFileLock(countersFile) | [wait] | **并发热点**：同 squad 并发 createGoal+createTask 必须串行读改写计数器，否则同 id 重复 |

> board 子 store 锁颗粒 = 单 record 文件路径（`{root}/squads/{squadId}/board/{goals\|requirements\|tasks}/{id}.json`），**不锁整个 board 目录**（不同 record 可并行；idGen 锁 counters.json 单独路径）。

### 6.3 工具（→ withFileLock）

| callsite | 文件 | 操作 | 模式 |
|---|---|---|---|
| fileWriteTool.run | tools/file-write.ts:93 | withFileLock(filePath) 包 atomicWriteAsync（v0.0.345 起工具层 IO 真异步） | [wait] |
| fileEditTool.run | tools/file-edit.ts:100 | withFileLock(filePath) 包 read+replace+atomicWriteAsync（occurrences 锁内重判） | [wait] |

### 6.4 不迁 [skip]

| callsite | 理由 |
|---|---|
| bootstrap.ts 启动期一次性写（ensureDir / seed default config） | 单写者、启动期无并发 |
| `Map`/`Set` 内存结构（event-hub.subs / inbox.buckets / agent-manager.loops 等） | 非文件 IO，事件循环原子 |
| 查询路径（get/query/list*） | 只读，无须锁 |
| SqliteCrudStore 全部路径 | SQLite 自身事务串行；CompositeStore forwarder 自动走 `Promise.resolve(sync put)` |

## 7. 并发写场景（= 测试覆盖最低要求）

UT 与 AT 至少覆盖以下场景（test-plan 据此选 case）：

| # | 场景 | 期望 |
|---|---|---|
| C1 | 两并发 `putAsync` 同 record（同 id json） | 串行执行，无丢更新，最终 version=2（两次信封自增） |
| C2 | N=10 并发 `putAsync` 同 record | 全串行，最终 version=N，无 tmp 互相覆盖 |
| C3 | 两并发 jsonl `putAsync` 同 shard 同段 | 串行入段，无段文件 tmp 覆盖，段名=段首 id 不变式保持 |
| C4 | 两并发 jsonl `putAsync` 同 shard 不同段（不同 id 范围） | 可并行（不同 entitySegmentDir? 否，同 shard 同 entity → 锁段目录 → 串行；期望=串行，因锁颗粒是段目录） |
| C5 | 并发 put + tool-write 同 path（agent loop 写 crud + tool 写同文件） | 二者经不同锁入口（putAsync vs 工具 withFileLock）但 path 一致 → 互斥串行 |
| C6 | 两并发 `updateTask` 同 taskId CAS（read 旧 → patch → 写） | 串行；后者的 read 在前者写后，正确看到新值 |
| C7 | 并发 `idGen.next` 同 squad 两前缀 | counters.json 串行读改写，两 id 唯一 |
| C8 | 两并发 `fileEdit` 同文件不同 oldString | 串行；后者的 read 看到前者写后内容；occurrences 锁内重判不误判 |
| C9 | 并发 `fileEdit` 同文件**相同** oldString（replaceAll=false） | 第二个在锁内重判发现 occurrences 已 0 → 报 STRING_NOT_FOUND（不盲改） |
| C10 | fire-and-forget 写（unread mark）不阻塞调用方 | 调用方 `void crud.putAsync().catch()` 立即返回；写仍串行落盘 |
| C11 | `putAsync` 与 sync `put` 同 path（混合调用） | **不互斥**（sync put 不走锁）—— 明确边界：迁移后**禁止**同 path 混用 sync+async（spec §8 反例） |
| C12 | 非重入约束：核查全部 callsite 无同 path 嵌套 `withFileLock`（code-review 逐处验） | 静态保证：无 `withFileLock(p, () => …withFileLock(p,…)…)`；不同 path 嵌套合法 |
| C13 | 两并发 `deleteAsync` 同 record | 串行；第二个返回 false（已删） |

## 8. 反例（禁止）

- ❌ **CrudStore interface 加 async 方法**：破坏 sync 契约，sqlite-store 被迫实现空 async，污染所有 engine。
- ❌ **sync `put` 与 `putAsync` 混用同 path**：sync 不走锁，绕过串行 → 等于没锁。迁移时**整路径切换**（同一 record 要么全 sync 要么全 async）。
- ❌ **跨进程共享 root 仍称安全**：本锁纯进程内，多进程场景须上层协调或换 SQLite engine（spec §5）。
- ❌ **锁颗粒 = 整个 root**：过粗，所有 entity 串行；本设计按文件/段目录分锁。
- ❌ **edit 的 occurrences 判定留在锁外**：read 时唯一不代表 write 时唯一（中间被插写）；必须锁内重判。
- ❌ **fire-and-forget 用于结果依赖写**（如 createSession 返回 stored）：HTTP 响应拿不到 stored。
- ❌ **持锁内做长 IO**（如同步 fsync 多次 / 网络）：放大串行影响；锁内只做最小 read-modify-write。

## 9. 边界

| 零件 | 归属 |
|------|------|
| 锁原语 `file-lock.ts`、withFileLock/enqueueFileWrite、key 规范化、非重入约束 | 本文件 ✅ |
| FsCrudStore.putAsync/deleteAsync targetPath 算法 + CompositeStore forwarder | 本文件 §4.2/§4.3 ✅ |
| write/edit 工具锁包装 + callsite 迁移归类（wait vs fNF） | 本文件 §5/§6 ✅ |
| CrudStore 契约、sync put/get/delete/query | `[P0]crud_store_interface.md`（不动） |
| atomicWriteSync 崩溃原子 + jsonl 段文件读写（段名/排序/roll） | `[P0]fs_crud_store_engine.md §3.2-§3.6`（不动） |
| SQLite engine | `[P0]sqlite_crud_store_engine.md`（零影响） |

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 [`specs/tech/version_logs/v0.0.38/change_log.md`](../version_logs/)。
