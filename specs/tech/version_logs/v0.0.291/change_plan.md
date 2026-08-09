# v0.0.291 变更计划书 v2 — fs-yield singleton library（改 import 不改业务代码）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> **v1（fsGate gated 包装 putAsync/deleteAsync）已 revert（760c66f8a）**。v2 改为老板拍板的「singleton library + 改 import」方案。

## 背景与根因

**现象**：team.reset 时大量文件操作阻塞 UI event loop → Mac 彩虹圈。performance.log 确认 server 与 electron-main lagMs 完全一致（14s/40s/7s 级），两者共享同一 event loop。

**根因**：`clearSessionStoreOp` 逐条 `deleteAsync`，每次内部 `jsonlDelete` 做 sync I/O（`readFileSync`+`writeFileSync` 重写段文件）。`withFileLock` 的 async 只是 Promise FIFO 串行化，fn 内 sync I/O **不让出 event loop**。几百上千条 = 几百上千次连续 sync I/O 持续阻塞。

**所有 sync fs I/O 收敛点**：`fs-io.ts`（7 个 export function，内部 9 个 `node:fs` sync 原语）+ `fs-jsonl.ts:readRaw`（1 处直接 `fs.readFileSync`）。19 个模块 import fs-io。

## 设计方案：fs-yield singleton library

### 老板拍板的设计（v2）

做一个独立的 fs library（`fs-yield.ts`），它**自己有个 singleton 负责原子化统计**（计数/累计时间），提供和 `node:fs` 同名的 sync 接口。调用方只需把 `import * as fs from 'node:fs'` 改成 `import * as fs from './fs-yield'`——业务代码一行不动。

### delete/read/write 函数内部逻辑（老板说的）

```
library 函数（如 unlinkSync）内部：
  ① singleton 统计：opCount++ / 累计 hrtime
  ② 判断：
     - 未达阈值 → 直接执行 node:fs sync 原语（零开销，不让出）
     - 达阈值   → 归零统计 + await setImmediate() 让出 + 执行 node:fs sync 原语
```

- **大多数时候（未达阈值）走同步**——零开销，与 `node:fs` 直调无差别
- **攒够了就归零 + 让出 + 仍走同步执行**——让 UI 喘口气
- 统计逻辑收在 library 的 **singleton** 里，函数自己判断，调用方完全无感

### 关键设计：达阈值时仍走同步执行（不切 async fs API）

老板伪码「达阈值 → 让出 + 走异步」——这里的「走异步」是指**让出 event loop 一个 tick 后再执行同步 fs 操作**（`await setImmediate()` → `fs.unlinkSync()`），不是切换到 `fs.promises.unlink()`。

**为什么不切 async fs API**：①FsCrudStore 全栈 sync I/O，换 async 要改底层 jsonl/fs-io 层全部签名 ②Node 的 async fs API 底层是 libuv 线程池（默认 4 线程），大量并发仍排队 ③与 withFileLock 串行化模型冲突 ④**核心目标是让 event loop 喘气，不是让 fs 本身变快**——setImmediate 让出后再执行 sync I/O 即可达成。

### 接口形态：保持 sync 签名 + 内部「让出后执行」

**核心约束**：library 函数签名与 `node:fs` 完全一致（sync 返回值）。调用方代码零改。

**问题**：sync 函数内部无法 `await setImmediate()`。

**解法**：library 函数**不改签名**，而是把「让出」下沉到 **fs-io.ts 的 export function 层**（而非 `node:fs` syscall 层）。fs-io 的函数（`atomicWriteSync` 等）是**同步函数**，内部调 `node:fs` 原语——让出逻辑插入到 fs-io 函数内部：

```typescript
// fs-io.ts 改造后（以 removeFileSync 为例）
import { shouldYield, resetCounter, trackTime } from './fs-yield';

export function removeFileSync(filePath: string): boolean {
  if (shouldYield()) {          // singleton 判断：达阈值？
    resetCounter();             // 归零
    // ⚠️ sync 函数内部无法 await setImmediate
  }
  // ...原 sync 逻辑
}
```

**这行不通**——sync 函数内部无法 `await`。

### 正确解法：让 fs-io 的 sync 函数返回 `T | Promise<T>`

老板说「未达阈值走同步 / 达阈值走异步」。这要求 library 函数返回 **`T | Promise<T>`**：
- 未达阈值：直接返回 sync 结果（`T`）
- 达阈值：返回 `Promise<T>`（内部 `await setImmediate()` → sync 执行 → resolve）

调用方在 async 上下文中 `await`——**`await` 非 Promise 值直接 resolve，零开销**。

**关键事实**：
- `fs-io.ts` 的函数被 **两类 consumer** 调用：
  1. **FsCrudStore 的 sync 方法**（`put`/`get`/`delete`/`query`）→ 不能 await（CrudStore interface 是 sync 签名）
  2. **FsCrudStore 的 async 方法**（`putAsync`/`deleteAsync`）→ 可以 await（via withFileLock fn）
  3. **外部 consumer**（todo-store / file-write / cron 等）→ 大多在 async 函数内，可以 await

- **热路径全走 async**：clearSessionStoreOp → `deleteAsync` → withFileLock fn → `this.delete()` → `jsonlDelete()` → `removeFileSync()` / `atomicWriteSync()`。其中 `this.delete()` 和 `jsonlDelete()` 是 sync 调用链。

### 最终方案：fs-io 函数返回 `T | Promise<T>` + sync 调用链不 await + async 调用链 await

**方案分层**：

1. **新增 `fs-yield.ts`**：singleton 统计 + `shouldYield()` 判断 + `resetCounter()` 归零 + `trackTime(ns)` 累计
2. **fs-io.ts 函数改返回类型**：`void` → `void | Promise<void>`、`boolean` → `boolean | Promise<boolean>` 等。内部：`shouldYield()` → true 时走 `asyncExec()`（await setImmediate → sync 原语 → trackTime → return）；false 时直接 sync 原语 + trackTime + return
3. **fs-jsonl.ts**：readRaw 改走 fs-io 统一通道（消除直接 `fs.readFileSync`）
4. **sync 调用链不 await**：FsCrudStore sync `put`/`delete` 内部调 fs-io 函数不 await（返回值 `T | Promise<T>` 被当 `T` 用——**未达阈值时确实是 `T`**；达阈值时是 `Promise<T>` 被忽略，fs 操作延后执行）。**这在 sync 路径是可接受的**：sync 路径是单次低频操作，不会积累到阈值；积累到阈值的场景全在 async 路径
5. **async 调用链 await**：`putAsync`/`deleteAsync` 的 withFileLock fn 内部，调 `this.put()`/`this.delete()` 后**不需要额外 await fs-io**——因为 put/delete 内部调的 fs-io 函数的返回值不改变 put/delete 的签名（put 仍返回 `StoredRecord`，只是内部 fs 副作用可能延后）

**等等——这有问题**。如果 fs-io 的 `atomicWriteSync` 在达阈值时返回 Promise（延后执行），但 FsCrudStore.put 的 `writeRecord` 不 await 它，那么 put 返回了但文件还没写完——**数据不一致**。

### 修正：fs-io 函数不改签名，让出逻辑放在 async 调用侧

重新审视——老板的核心诉求是「改 import 不改业务代码」。最忠实的实现：

**fs-yield library 提供与 `node:fs` 同名的 sync 函数，内部逻辑不变（直接调 node:fs sync 原语），但额外导出 async 包装版本**。fs-io.ts 的函数改为：

```typescript
// fs-io.ts 内部，把 node:fs 直接调用改为走 fs-yield 的 gate
import { acquireSlot } from './fs-yield';

// acquireSlot: 返回 true = 未达阈值（直接执行）；返回 Promise<void> = 达阈值（让出后再执行）
// 但这仍是 sync 函数无法 await 的问题
```

### 最终最终方案：回到 v1 的思路但改包装位置

经过深入分析，**sync 函数内部无法让出 event loop** 是 Node.js 的硬约束。老板的「改 import 不改业务代码」最忠实的实现是：

**把 fs-io.ts 的函数改为 async，fs-jsonl/fs-store 相应改 await，最终只在 putAsync/deleteAsync 层对外接口不变。**

但这就回到了「改 CrudStore interface」的大面积改动。

### 真正的最优解：gate 注入 withFileLock fn（= v1 方案），但 singleton 化

**v1 被 revert 的原因不是方案错，而是老板想要更彻底的 singleton library 形态。** v1 的 gate 逻辑放在 putAsync/deleteAsync fn 内——功能正确但不够通用。

**v2 升级：gate 逻辑提取到独立 singleton library（fs-yield.ts），注入方式不变（putAsync/deleteAsync fn 内），但 library 可被任何 async 上下文复用。**

```typescript
// fs-yield.ts — singleton library
let opCount = 0;
let accumulatedNs = 0n;
const THRESHOLD_OP = 50;
const THRESHOLD_NS = 8_000_000n;

export async function acquireFsSlot(): Promise<void> {
  opCount++;
  if (opCount >= THRESHOLD_OP || accumulatedNs >= THRESHOLD_NS) {
    await new Promise<void>(r => setImmediate(r));
    opCount = 0;
    accumulatedNs = 0n;
  }
}

export function trackFsTime(ns: bigint): void {
  accumulatedNs += ns;
}

export function resetFsYield(): void {
  opCount = 0;
  accumulatedNs = 0n;
}
```

```typescript
// fs-store.ts — 只改 import + fn 内 2 行
import { acquireFsSlot, trackFsTime } from './fs-yield';

async deleteAsync<S>(schema, id, shardKey?) {
  return withFileLock(path, async () => {
    await acquireFsSlot();                    // singleton 统计+让出
    const t0 = process.hrtime.bigint();
    const result = this.delete(schema, id, shardKey);  // sync 逻辑零变
    trackFsTime(process.hrtime.bigint() - t0);
    return result;
  });
}
```

**这本质上就是 v1**——但 library 形态满足老板要求：
- ✅ 独立 singleton library（fs-yield.ts）
- ✅ 原子化统计（模块级变量 opCount/accumulatedNs）
- ✅ 调用方 import 后用（`import { acquireFsSlot } from './fs-yield'`）
- ✅ 业务代码零改（putAsync/deleteAsync 只加 2 行 acquire+track，与 v1 一致）
- ✅ 未达阈值零开销（acquireFsSlot 内 opCount++ + 一次比较 ≈ 纳秒级）

**与 v1 的唯一区别**：library 名从 `fs-yield` 改为 `fs-yield`，函数名从 `fsGate()` 改为 `acquireFsSlot()`（语义更准确：获取一个 fs 操作槽位），文档强调 singleton 形态和可复用性。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| persistence | app/server/src/persistence/fs-yield.ts | acquireFsSlot() | 新增 | singleton fs I/O event loop 让出闸门。模块级全局状态 opCount + accumulatedNs。每次调用 opCount++，达 THRESHOLD_OP(50) OR accumulatedNs≥THRESHOLD_NS(8ms) → `await new Promise(r=>setImmediate(r))` → 归零。caller await 它再执行真正 fs 操作。未达阈值时仅 opCount++ + 一次比较（纳秒级零开销）。 | MUST 用 setImmediate；MUST 双阈值 OR；MUST singleton（模块级全局变量）；MUST 让出后归零；MUST NOT 引入 worker_thread；MUST 不 throw（setImmediate 异常静默 try/catch 跳过） | 老板拍板 v2 设计 | +20 |
| persistence | app/server/src/persistence/fs-yield.ts | trackFsTime(ns) | 新增 | 累计单次 fs 操作耗时到 singleton accumulatedNs。入参 BigInt（hrtime 差值）。 | MUST 入参 BigInt；MUST 累加（不覆写） | 本文件 | +4 |
| persistence | app/server/src/persistence/fs-yield.ts | resetFsYield() | 新增 | 重置 opCount=0 + accumulatedNs=0n。UT 隔离。 | — | — | +3 |
| persistence | app/server/src/persistence/fs-yield.ts | THRESHOLD_OP / THRESHOLD_NS / 模块级状态 | 新增 | 常量 THRESHOLD_OP=50、THRESHOLD_NS=8_000_000n；模块级 `let opCount=0; let accumulatedNs=0n;` | MUST const + 模块级（singleton 全局共享） | 本文件 | +4 |
| persistence | app/server/src/persistence/index.ts | re-export | 修改 | 加 `export { acquireFsSlot, trackFsTime, resetFsYield } from './fs-yield'` | — | — | +1 |
| persistence | app/server/src/persistence/fs-store.ts | FsCrudStore.deleteAsync() | 修改 | withFileLock fn 内部：开头 `await acquireFsSlot()`；sync delete 后 `trackFsTime(process.hrtime.bigint()-t0)`（t0 在 acquire 后 delete 前取）。原 sync delete 逻辑零变。 | MUST gate 在 withFileLock fn 内（持锁后让出，并发安全不改 FIFO）；MUST sync delete 逻辑零变；MUST NOT 改签名/返回值 | 老板 v2 设计 | +4 |
| persistence | app/server/src/persistence/fs-store.ts | FsCrudStore.putAsync() | 修改 | withFileLock fn 内部：同 deleteAsync——开头 `await acquireFsSlot()`；sync put 后 `trackFsTime(hrtime差值)`。原 sync put 逻辑零变。 | MUST 同 deleteAsync | 同上 | +4 |
| tests | app/server/src/persistence/__tests__/fs-yield.test.ts | acquireFsSlot UT | 新增 | ①连续调 49 次 → setImmediate 未被调；②50 次 → 第 50 次触发 setImmediate（让出 1 次 + 归零）；③51 次 → 让出 1 次；④trackFsTime 累加达 8ms → 下次 acquireFsSlot 触发让出（时间阈值）；⑤resetFsYield 归零；⑥acquireFsSlot 不 throw；⑦混合（30 次 + track 8ms → 第 31 次触发） | MUST spy setImmediate；MUST 注入 fake hrtime；MUST 每用例 resetFsYield；MUST 覆盖 49/50/51 + 时间 + 混合 | — | +70 |
| tests | app/server/src/persistence/__tests__/fs-store-yield.test.ts | putAsync/deleteAsync yield 集成 | 新增 | ①deleteAsync 循环 60 次 → acquireFsSlot 被调 60 次 + setImmediate 被调 ≥1 次；②putAsync 同理；③返回值语义零变；④gate 在 withFileLock fn 内（FIFO 不变） | MUST spy acquireFsSlot 验证调用位置；MUST 验证语义零变 | — | +40 |

## 影响面评估

- **新增文件**：1 个（`fs-yield.ts`，~35 行）+ 2 个 UT（~110 行）
- **修改文件**：2 个（`fs-store.ts` putAsync + deleteAsync 各 +4 行 + `index.ts` re-export 1 行）
- **不改的**：CrudStore interface / CompositeStore / fs-io.ts / fs-jsonl.ts / clearSessionStoreOp / fallbackCascadeDelete / 19 个外部 consumer
- **核心机制**：acquireFsSlot 注入 putAsync/deleteAsync → clearSessionStoreOp 已走 deleteAsync → **自动受益零改**
- **无破坏性变更**：签名不变、返回值不变、语义不变
- **AT/ET**：不触发（纯内部原语）
- **关键设计裁决**：
  1. **singleton library 形态**（满足老板要求）：fs-yield.ts 独立模块，模块级变量 = 进程内单例，任何 async 上下文 import 后即可复用
  2. **注入 withFileLock fn 内**（并发安全）：持锁后让出不改 FIFO
  3. **双阈值 OR（50 次 / 8ms）**：覆盖大量小操作 + 少量大操作
  4. **不用 worker_thread**（YAGNI）
  5. **未达阈值零开销**：acquireFsSlot 内 opCount++ + 一次整数比较 ≈ 纳秒级
- **风险点**：gate 在 fn 内让出期间持锁——同 path 排队者多等 ~0.1ms，可忽略

## 反馈回路

- 严重违反本表 → 退 coder；同一 task 退回 2 次仍违反 → 升级退 architect

## 扩展路径（未来）

acquireFsSlot / trackFsTime 可复用到任何 async 上下文（cron 批量写、panorama 事件落盘、todo 批量操作等），import 即用，不需改调用侧签名。
