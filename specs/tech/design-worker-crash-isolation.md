# worker 崩溃隔离 + 自愈 技术设计（v2 — 进程化主方案）

> 版本：健壮性增强（正式新需求，老板拍板）| 日期：2026-08-11 | 分支：dev1（先设计，确认后编码）
> 需求来源：老板「worker/tool 崩溃弹性处理，当作新需求做」；**老板拍板**：所有工具统一崩溃捕获+隔离机制，零特例（否决 grep 单独移出白名单的做法——「乱七八糟的例外，最后谁能维护」）
> 证据：`temp/crash-0.0.328-search-analysis.md`（researcher 根因 + §9 机制分析）+ coder3 实测（Electron 42.4.1 utilityProcess.fork 真隔离）

## 0. 一句话方案

把白名单工具执行从 **worker_threads 换到独立子进程**（packaged=Electron `utilityProcess.fork`，dev/test=`child_process.fork`），**所有工具统一走同一进程池 + 统一 catch + 自愈重建 + 记录 + 上报**。子进程 native 崩只杀自己，主进程真免疫；`ToolWorkerPool` 接口零改动，调用方（engine/dispatch/bootstrap）一行不改；配全局回退开关（可一键回 worker_threads）。

## 1. 为什么必须进程化（崩溃传播路径，researcher §9 实证）

### 1.1 病根：worker_threads 共享主进程地址空间

| 环节 | 事实 | 证据 |
|------|------|------|
| worker_threads 是**线程**非进程 | 所有 worker + 主线程跑在**同一 OS 进程地址空间** | researcher §9.1-1 |
| native brk 0 是**进程级**终止 | `CHECK` 断言 / `abort()` → SIGTRAP/SIGABRT 直接终止整个 OS 进程，不分线程 | crash log Thread 37 + §9.1-2 |
| JS error/exit handler **完全失效** | 是 JS 回调，需事件循环活着才能触发；native abort 同步杀进程，主线程事件循环没机会跑 | §9.1-3（pool.ts L162-167 handler 形同虚设） |
| Node issue #65100 实证 | worker 首个 abort 即拖垮整个进程（`Worker::Run → uv_run → abort`） | §9.1-4（与本 crash 栈签名一致） |
| engine race/abort 也救不了 | `Promise.race` + `controller.abort()` 是 JS 层超时兜底，abort 信号发不到已死的进程 | §9.1-5（engine.ts L283-303） |

**结论**：native abort 是进程级终止，worker_threads 与主线程同进程 → 「JS 层检测+重建」路线对 native 崩溃**本质无解**。隔离必须在进程边界。现有 `handleWorkerCrash`（reject 在途+移除+重建）逻辑本身正确，只是 worker_threads 下对 native 崩「一行都没机会跑」——迁到子进程后 exit event 可靠触发，这套机制**直接复活**。

### 1.2 现状盘点（researcher §9.2 + 源码核实）

| 维度 | 现状 | 位置 |
|------|------|------|
| 池 | `ToolWorkerPool` 常驻池：懒创建/复用/串行+排队/`maxWorkers=min(4,cpus-1)` | `worker-pool/pool.ts` |
| 白名单 | `WORKERABLE_TOOL_NAMES = ['read','write','edit','glob']`（**grep 已被 coder3 移出**，将回白名单） | `worker-pool/types.ts` |
| 调度 | `isWorkerableTool()` → `runViaWorker(pool.submit)`；非白名单走 `runViaTool` 主线程 | `engine-worker-dispatch.ts` |
| 崩溃检测/重建 | 有（error/exit → handleWorkerCrash），但只对 JS 异常有效 | pool.ts L162-167, L208-213 |
| 注入 | `createToolWorkerPool()` 进程级单例，bootstrap 装配注入 ToolEngine | `worker-pool/index.ts` + bootstrap L495 |
| 消息协议 | `WorkerPoolTask/Result` 全 structuredClone（`postMessage` 序列化边界） | `types.ts` |
| 加固基础 | `file-grep.ts` **已有 jsGrep 降级**（rg 不可用自动降级纯 JS 实现） | file-grep.ts L86-95/L113-117/L167 |

### 1.3 coder3 实测（选型决定证据，Electron 42.4.1 与生产同版）

| 实测 | 结果 |
|------|------|
| `utilityProcess.fork` 可用 | ✅ typeof = function |
| 子进程跑纯 Node fs（readFileSync） | ✅ OK（白名单纯 IO 工具能跑） |
| 子进程 `process.abort()` | ✅ 真崩（exit code 6 SIGABRT，不被 Node 拦截——真隔离信号） |
| **主进程免疫** | ✅ child abort 后 MAIN STILL ALIVE，exit=0 |
| 通信 | `process.parentPort`（postMessage/on message），与 worker 协议同构 |

**结论**：utilityProcess.fork 是正确路径——纯 Node 环境（无 Electron API，正适合纯 IO 白名单工具）、独立地址空间（native 崩只杀子进程）、消息协议同构（迁移成本低）、常驻池可摊销启动开销。

### 1.4 开销实测（老板质疑「进程开销太大」——数据说话，Electron 42.4.1 实测）

> 实测环境：Electron 42.4.1（与生产同版，`~/Library/Caches/electron` 解压独立二进制，不碰生产 app）+ macOS arm64 + 10 核。方法：utilityProcess.fork vs new Worker 各 10 次启动计时；4 单元常驻池测 RSS（worker 线程共享主进程地址空间→主进程 RSS 增量；utilityProcess 独立进程→主进程侧增量 + ps 测子进程自身 RSS）。

#### 1.4.1 启动耗时（各 10 次）

| 载体 | avg | min | max | p50 |
|------|-----|-----|-----|-----|
| worker_threads | **7.62 ms** | 6.62 | 12.88 | 7.05 |
| utilityProcess.fork | **47.57 ms** | 46.86 | 48.97 | 47.47 |
| 差值 | **~40 ms** | | | |

#### 1.4.2 常驻内存（maxWorkers=4 池规模）

| 载体 | 主进程 RSS 增量 | 执行单元自身 RSS | 池总计 |
|------|----------------|-----------------|--------|
| worker_threads（4 线程） | **+34.66 MB**（线程共享地址空间，全部计入主进程） | 无独立（计入主进程） | +34.66 MB |
| utilityProcess（4 进程） | **+4.42 MB**（fork 主进程侧开销） | 各 ~66 MB（Node 空进程基线）× 4 | **+264 MB**（子进程独立，不占主进程） |

> 注：66 MB 是 Node 子进程空基线（含 V8/EventLoop 初始化），**非工具执行开销**；utilityProcess 子进程内存独立于主进程，主进程侧仅 +4.42 MB。

#### 1.4.3 结论：**可接受（可优化）**，老板「进程开销太大」的顾虑有数据缓解

| 维度 | 数据 | 判断 |
|------|------|------|
| 启动耗时 | +40 ms/次，但**常驻池懒创建只付一次**（现状 worker 池就是懒创建+复用，进程化同构） | ✅ 可接受 |
| 内存 | 4 进程 +264 MB vs 4 线程 +35 MB，但**子进程内存独立不占主进程**（主进程侧仅 +4.42 MB）；且工具执行频率低（agent 回合内几次） | ✅ 可接受（需规模控制） |
| 主进程稳定性 | 主进程 RSS 增量反而**更小**（+4.42 vs +34.66）——进程化对主进程内存更友好 | ✅ 加分项 |

**优化点（落地时控制）**：
1. **常驻池 + 懒创建**：启动开销只付一次（现状模型同构），首次工具调用才 fork。
2. **规模控制**：maxWorkers=4 已是上限（10 核 → min(4,9)=4）；可评估降到 **2**（工具串行执行 + 排队，实际并发需求低），内存再减半。
3. **回退开关**：`TOOL_POOL_BACKEND=worker` 一键回线程（若生产实测开销不可接受）。
4. **熔断降级**：崩溃风暴时降级主线程（不进进程池），进程数不膨胀。

**诚实标注**：+264 MB 是 4 个常驻子进程的绝对成本，对一个桌面 app（主进程本身数百 MB）占比可接受，但**不是零成本**——这就是为什么保留回退开关 + 规模可调，让老板有最终控制权。

## 2. 需求规格 → 设计映射（老板 4 条 + 3 红线）

| 老板需求 | 设计落地 |
|---------|---------|
| 1. 记录（工具/操作/错误/时间戳） | 崩溃 → `error.log` 结构化记录（LogWriter error 类型，含 toolName/toolCallId/workdir/reason/ts） |
| 2. 重启 tool（自愈重建） | 子进程 exit event **可靠触发** → 复用 handleWorkerCrash「reject 在途 + 移除 + 重建」+ 熔断防崩溃风暴 |
| 3. 继续工作（主进程+其他工具+agent 免疫） | **进程隔离**：native 崩只杀子进程，主进程真免疫（utilityProcess 实测） |
| 4. 上报（可感知/可追溯） | SSE 事件 → 前端 toast「某工具崩溃已自动恢复」+ error.log 可追溯 |
| 红线① 通用性（零特例） | **一套机制覆盖所有 worker 工具**：grep 回白名单，与 read/write/edit/glob 同池同机制；风险工具在**统一机制内加固**（file-grep 已有 jsGrep 降级，进程化后 spawnSync 崩也只杀子进程） |
| 红线② 可维护性 | 不新增「特殊分支」：白名单常量单一源（types.ts）、入口脚本统一 IPC 适配、池接口零改动、全局回退开关一个 |
| 红线③ 不搞挂 app | 接口/协议/调用方零改动；双路径（packaged/dev）都有实测；回退开关一键回 worker_threads；分阶段可回退 |

## 3. 总体架构

```
【执行载体层】（本次替换）
  ToolProcessPool（新，内部实现）
    ├─ packaged：Electron utilityProcess.fork(path)   ← 真隔离（coder3 实测）
    ├─ dev/test：child_process.fork(path)              ← 纯 Node 兜底（vitest/bun 可测）
    └─ 回退开关 TOOL_POOL_BACKEND=worker → 旧 worker_threads 实现（原样保留）

【进程入口层】（新 process-entry.ts，复用 worker-entry 白名单路由逻辑）
    process-entry.js —— 统一 IPC 适配（utilityProcess 的 process.parentPort / fork 的 process.send 二选一）
                    —— 白名单路由（WORKERABLE_TOOL_NAMES 单一源，含 grep）
                    —— 全程 try/catch（任何异常回 {ok:false}，不崩进程）

【池接口层】（零改动）
  ToolWorkerPool.submit(task) → Promise<WorkerPoolResult>   ← 签名/协议不变
  engine-worker-dispatch / engine.ts / bootstrap             ← 一行不改

【观测/自愈/上报层】（新，池外层包一层）
  onCrash 回调 → LogWriter(error.log) + SSE toast
  熔断：60s 内崩 ≥5 次 → 暂停池（白名单降级主线程 runViaTool）→ 冷却 5min 半开
```

## 4. 详细设计

### D1: 执行载体替换 — pool.ts（修改核心，接口零改动）

**文件**：`app/server/src/tools/worker-pool/pool.ts`（修改）

| 项 | 设计 |
|----|------|
| 核心思路 | `ToolWorkerPool` **类名/接口/方法签名全部不变**（submit/close/nextId/handleWorkerCrash 复用），只把内部 `new Worker(workerPath)`（worker_threads）换成「子进程工厂」 |
| 载体工厂 | 新 `process-factory.ts`：`createIsolatedProcess(scriptPath): IsolatedChild`（薄封装统一 `postMessage(msg)` / `on('message')` / `on('exit')` / `on('error')` / `terminate()`） |
| packaged 路径 | `utilityProcess.fork(scriptPath)`（Electron 主进程内，`require('electron')` 的 `utilityProcess`；**仅 packaged 可用**） |
| dev/test 路径 | `child_process.fork(scriptPath, { stdio: ['ignore','pipe','pipe','ipc'] })`（纯 Node；vitest/bun 可测） |
| 路径探测 | 复用现有 `resolveWorkerPath()` 三路径探测（.js/.cjs/.ts），换入口脚本 `process-entry` 同构探测 |
| 消息协议 | **零改动**：`postMessage(WorkerPoolTask)` / `on('message', WorkerPoolResponse)`，structuredClone 序列化边界不变（researcher §9.4-3 已确认天然兼容） |
| handleWorkerCrash | **原样复用**：子进程 exit event 现在可靠触发 → reject 在途 + 移除 + 重建（§1.1 论证「迁到子进程后复活」） |

**约束**：MUST `ToolWorkerPool` 公共签名/返回逐字段不变（engine/dispatch/bootstrap 零改动）；MUST 双路径工厂按环境自动选择（dev 无 utilityProcess → child_process.fork）；MUST 保留 worker_threads 旧实现代码（回退开关用）；MUST 消息载荷仍仅 structuredClone 字段。

### D2: 进程入口 — process-entry.ts（新建，统一 catch + 白名单路由）

**文件**：`app/server/src/tools/worker-pool/process-entry.ts`（新建，从 worker-entry.ts 演进）

| 项 | 设计 |
|----|------|
| 职责 | 子进程版 worker-entry：收消息 → 白名单路由 → try/catch → 回消息 |
| 统一 IPC 适配 | 入口顶部一行式适配：`const port = (process as any).parentPort ?? process`（utilityProcess 子进程有 `process.parentPort`，child_process.fork 子进程用 `process.send`/`process.on('message')`）→ 统一 `port.postMessage(resp)` / `port.on('message', handler)` |
| 白名单 | **`WORKERABLE_TOOL_NAMES` 单一源**（types.ts），含 grep（回白名单）——与 worker-entry 同源，零漂移 |
| 全程 catch | 复用 worker-entry 的 try/catch 结构（executeWhitelistedTool 全包，任何异常回 `{ok:false}` 不崩进程） |
| **grep 加固（统一机制内）** | `file-grep.ts` 已有 `jsGrep` 降级（rg 不可用自动降级纯 JS）——进程化后 `spawnSync('rg')` 崩也只杀子进程（主进程免疫）+ jsGrep 兜底逻辑不变；如需额外加固：`spawnSync` 包 try/catch + 返回 null 时降级 jsGrep（见 D3） |

**约束**：MUST 白名单从 types.ts 单一源派生（禁两处手写列表）；MUST 入口逻辑与 worker-entry 同构（可维护性：后来者看一个入口就懂）；MUST try/catch 全包（任何异常回消息不崩进程）。

### D3: grep 加固（回白名单 + 统一机制内加固）

**文件**：`app/server/src/tools/file-grep.ts`（修改，小）+ `app/server/src/tools/worker-pool/types.ts`（修改）

| 项 | 设计 |
|----|------|
| 回白名单 | `WORKERABLE_TOOL_NAMES = ['read','write','edit','glob','grep']`（**删除 coder3 的移出改动**，注释更新为「grep 在进程池内跑：spawnSync 崩只杀子进程，主进程免疫；jsGrep 兜底」） |
| spawnSync 加固 | `rgAvailable()` / `runRipgrep()` 的 `spawnSync` 包 try/catch；`runRipgrep` 抛错/返 null → 自动降级 `jsGrep`（现有 L86-95 结构补 catch 分支） |
| 原则 | **不开特例**：grep 与 read/write/edit/glob 同池同机制；「有风险就把它加固做好」= jsGrep 降级 + 进程隔离双保险 |

**约束**：MUST 不新增「grep 单独分支」（与老板红线一致）；MUST 降级逻辑在 file-grep 内部（工具自愈能力），池层不感知工具差异。

### D4: 崩溃记录 — error.log（LogWriter 复用）

**文件**：`app/server/src/tools/worker-pool/pool.ts`（修改，加 onCrash 回调）

| 项 | 设计 |
|----|------|
| 回调 | `ToolWorkerPoolOptions.onCrash?: (rec: ToolCrashRecord) => void`（可选注入，池不直接依赖 LogWriter——解耦 + UT 可 spy） |
| 记录字段 | `{ ts, level:'tool-crash', toolName, toolCallId, workdir, reason, action:'recovered' }`（对齐老板「哪个工具/什么操作/错误/时间戳」） |
| 落盘 | bootstrap 装配时注入「写 LogWriter error 类型」（`enableErrorLog` 开关门禁，fire-and-forget JSONL，失败静默——零开销机制已有） |
| 时机 | 每次 handleWorkerCrash（JS 异常崩 + exit code≠0 + native 崩的 exit event——子进程下**全部可靠触发**，这是 vs worker_threads 的本质改善） |

**约束**：MUST 池不 import LogWriter（依赖注入，UT 友好）；MUST 记录失败静默（不因记录崩）；MUST 门禁走 LogWriter 既有 `enableErrorLog` 开关。

### D5: 崩溃上报 — SSE toast

**文件**：`app/server/src/tools/worker-pool/pool.ts`（onCrash 回调内）+ bootstrap（注入）+ 前端新轻量监听

| 项 | 设计 |
|----|------|
| 通道 | 复用 SSE event bus（`agent/event-bus.ts` / `sse/sse-channel.ts`，bootstrap 已有 `bus`/`sseChannel` 单例） |
| 事件 | `tool-crash` 系统事件（含 toolName + recovered 信息） |
| 前端 | 新增轻量监听 → toast「某工具崩溃已自动恢复」（复用现有 toast 基建） |
| 保守 | toast 仅提示不阻塞；SSE 失败静默（不因上报引入新风险） |

**约束**：MUST 上报失败静默；MUST 前端 toast 非阻塞（提示性）；MUST 不因上报逻辑影响工具执行路径。

### D6: 熔断防崩溃风暴（自愈加固）

**文件**：`app/server/src/tools/worker-pool/pool.ts`（修改）

| 项 | 设计 |
|----|------|
| 现状风险 | 若某工具反复触发崩（如损坏状态），无限重建 → CPU/内存抖动 + agent 工具路径污染 |
| 熔断 | 崩溃计数滑动窗口（60s 内 ≥5 次）→ `isPoolHealthy()=false` → **白名单工具降级主线程跑**（`runViaTool`，engine 已有此路径：workerPool 可选注入，非白名单本就走主线程） |
| 冷却恢复 | 5min 冷却后自动尝试重建池（半开），成功则恢复进程路径 |
| 保守默认 | 阈值 N=5/60s、冷却 5min 宽松可调；宁晚熔断不误伤 |

**约束**：MUST 熔断后 agent 仍可用（降级主线程，非白名单老路）；MUST 熔断参数常量可调；MUST 不阻塞正常路径。

### D7: 回退开关（可回退红线）

| 项 | 设计 |
|----|------|
| 开关 | 环境变量 / appConfig `toolPoolBackend: 'process' \| 'worker'`，**默认 'process'**（新主方案） |
| 回退 | 置 'worker' → `createToolWorkerPool` 走旧 worker_threads 实现（代码原样保留，非删除） |
| 应急 | 出问题一键回退，零代码改动 |
| 说明 | 这是**全局机制开关**（不是给单工具开特例），符合老板「统一机制」精神 |

## 5. 风险评估（老板红线：绝不把 app 搞挂）

| 风险 | 评估 | 缓解 |
|------|------|------|
| 进程化改动大、引入新崩 | 中 | ① 接口/协议/调用方**零改动**（只换执行载体内部实现）② 双路径实测（utilityProcess coder3 已验；child_process.fork 纯 Node UT 可验）③ 回退开关一键回 worker_threads ④ 分阶段：先 D1-D2（载体替换+入口）验证隔离，再 D4-D6（记录/上报/熔断） |
| dev 与 packaged 行为不一致 | 中 | child_process.fork 与 utilityProcess.fork 同为独立 Node 子进程，隔离语义一致；dev/test 走 fork 路径可在 vitest 测隔离（process.abort() 模拟） |
| 进程开销 | 低（实测） | 启动 +40ms/次但常驻池只付一次；内存 4 进程 +264MB（子进程独立）但主进程侧仅 +4.42MB（比线程 +34.66MB 更小）；规模可调（maxWorkers 4→2）；回退开关兜底 |
| 消息协议破坏 | 低 | structuredClone 载荷不变（researcher §9.4-3 天然兼容） |
| 对现有 worker 池影响 | 低 | 只改 pool.ts 内部 createWorker → createIsolatedProcess；submit/dispatch/排队/重建主路径不动 |
| 回退不彻底 | 低 | worker_threads 代码原样保留（git 历史 + 代码分支），开关切换即回退 |

### 5.1 明确不夸大

- 进程化后：**native brk 0 / abort 只杀子进程，主进程真免疫**（coder3 实测 SIGABRT 主进程存活）——这是 vs worker_threads 的本质改善，老板核心诉求达成。
- JS 异常层（tool.run throw）子进程同样 try/catch 回 `{ok:false}`——双保险。
- 残余风险：极端情况下主进程自身 native 崩（非 worker 工具路径）不在本需求范围。

## 6. 分阶段交付 & 回退

| 阶段 | 内容 | 风险 | 回退 |
|------|------|------|------|
| **P1** | D1+D2+D7：载体替换（utilityProcess/fork 双路径）+ process-entry + 回退开关 + grep 回白名单 | 中（核心改动，但接口零改） | 开关回 'worker' 即完全回退 |
| **P2** | D4+D5+D6：onCrash 记录 error.log + SSE toast + 熔断 | 低（池外层包一层） | 各 D 独立 revert |
| **P3** | D3：grep spawnSync 加固（jsGrep 降级补 catch） | 低（file-grep 内部） | 独立 revert |

> P1 完成即可验证「主进程免疫」核心诉求；P2/P3 为完整弹性（记录/上报/熔断/加固）。

## 7. 验证

| 层 | 内容 |
|----|------|
| **UT**（MANDATORY，bun + Node 双跑） | ① 隔离：UT 模拟子进程 `process.abort()` → 断言主进程存活 + exit event 触发 + handleWorkerCrash reject 在途 + 重建（researcher §9.3 建议）② 协议：submit/response 往返逐字段相等 ③ 熔断：60s 崩 ≥5 → isPoolHealthy false + 降级主线程 ④ 回退开关：'worker' → 旧实现 ⑤ file-grep：spawnSync 抛错 → jsGrep 降级 |
| **AT** | 无 API 契约变化；进程化对 HTTP 层透明 → 不新增（test-plan 写明理由） |
| **ET** | packaged 实机：触发子进程 abort（测试钩子）→ 主进程存活 + toast 出现 + 后续工具正常 + error.log 有记录 |

## 8. 待确认（已答 + 剩老板拍板）

| 项 | 状态 |
|----|------|
| utilityProcess 可行性 | ✅ coder3 实测通过（纯 fs 能跑 + abort 主进程免疫 + 协议同构） |
| grep 是否回白名单 | ✅ 老板拍板：回白名单，统一机制内加固（jsGrep 降级 + 进程隔离） |
| 执行载体 | ✅ utilityProcess.fork（packaged）+ child_process.fork（dev/test）双路径 |
| 开销实测 | ✅ 已补 §1.4：启动 +40ms（常驻池只付一次）、内存 4 进程 +264MB（主进程侧仅 +4.42MB，比线程更小）→ **可接受（可优化）** |
| 回退开关 | ✅ `toolPoolBackend: 'process'\|'worker'`（默认 process，一键回退） |
| 熔断参数 | 待确认（默认 N=5/60s、冷却 5min，可调） |
| 版本立项 | 待 leader 定版本号/分支（正式新需求） |
