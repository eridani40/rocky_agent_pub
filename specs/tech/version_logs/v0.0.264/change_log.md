# v0.0.264 tech change log — Browser Instance Manager（session 级浏览器实例管理）

> 对应需求：`reqs/[working] v0.0.264/req.md`（技术驱动需求，无 PRD——纯工具语义/内部机制改动，无用户可感知界面变化 → 跳过 PRD）。
> 权威契约：`specs/tech/version_logs/v0.0.264/change_plan.md`（method 级 8 列表，frozen）+ 设计文档 `specs/tech/agent/tools/[P1]browser_instance_manager.md`。
> 调研依据：`specs/research/browser-managed-profile-lifecycle.md`。

## 变更摘要

### 需求与动机

browser 工具（headless / managed-profile）每次 tool_call = 新开 Chrome → 执行单个 action → 立刻 SIGKILL 整个进程树。Chrome 寿命 = 单次工具调用——cookie/页面/lastRefs 全丢，`click`/`type` 跨 tool 调用失效（snapshot 拿的 ref 下次调用找不到）。根因：`worker-entry.ts` 注释明言「一次性执行器（无会话状态保持）」，不是 bug 是架构设计——但与用户「浏览器应该像人的浏览器——打开后一直开着，每次操作都在同一个浏览器实例上」的期望冲突（用户原话）。

### T1 — 引擎：worker 常驻循环 + InstanceManager 核心 + 泄漏防护

- **worker-entry.ts 单次执行器 → 循环服务**：`main()` 按 `task.loop === true` 分流——`runPersistent`（launch 后不退出，循环读 stdin 行 `{requestId, action, params}` → `dispatchAction` → emit 响应；`close` 帧 / stdin end → kill chrome → exit(0)）vs `runOnce`（单次：dispatch 一个 action → kill → emit → exit，web_fetch 用）。**`persistent` 字段保留连接模式标记**（managed-profile → `launchChromeAndConnect` ensureProfileFree），与 `loop`（常驻开关）字段拆分——C1 修复（executeOnce + profileName 曾误走 runPersistent、action 被忽略）。
- **worker-actions.ts `dispatchAction` 增 `state: WorkerSessionState` 参数**：`lastRefs` 由函数内新建改为 `state.lastRefs`（跨 action 保持——snapshot 的 ref 后续 click/type 有效，核心收益）；单次调用传新建 state（行为等价旧实现）。
- **instance-manager.ts（新增，300 行压线）`BrowserInstanceManager`**：`instances: Map<key, BrowserInstance>`（key=`sessionId:mode[:profileName]`，owner 天然隔离）；`launch`（幂等：ready 复用 / 清理旧 → spawn 持久 worker + launchConfirm 20s → state=ready + persistInstance）；`execute`（前置校验 instance 存在+ready → idle lazy check → abort 竞速 → worker.send）；`close`（close 帧 → 等 exit 3s → killProcessGroup 兜底 → 三要素清理）；`releaseSession`/`releaseAll`（releaseKeys 共用，幂等）；构造时**开机自检**（readPersistedInstances → 孤儿 kill + headless 删目录 + 删记录）；**shutdown hook 注册**（beforeExit + SIGTERM/SIGINT trap → releaseAll，模块级标记位幂等，对齐 channelManager/workspaceManager/squad-runtime 模式）。
- **泄漏防护四要素（closeInstance 全路径必达）**：① `killProcessGroup(workerPid)`（负 pid 杀 chrome 树，workerPid 在 spawn 后立即记录——失败路径也是锚点）② headless `rmSync(userDataDir)`（mkdtemp 临时目录）③ `usedPorts.delete(cdpPort)`（InstanceManager 独立 Set，与 NodeWorkerDriver private usedPorts 不碰，allocateCdpPort isBusy 探测兜底）④ `unpersistInstance`（删记录文件条目）。失败记 warn 不静默。
- **instance-record.ts（新增，116 行）**：`browser-instances.json` 读写——`readPersistedInstances()` / `persistInstance(rec)` / `unpersistInstance(key)` / `isPidAlive(pid)`（process.kill(pid,0) catch ESRCH）。同步 writeFileSync + catch 吞错（best-effort，不阻塞 launch/close）。
- **persistent-worker.ts（新增，191 行）**：`createPersistentWorker` + `spawnPersistentWorker` + `launchConfirm`（launch 确认帧无 requestId，resolve launchReady）+ `waitExit`（close 帧后等 worker exit）+ `withAbort(signal, sendPromise, onAbort)`（abort → kill instance + 取消错误；sendPromise noop catch 防 unhandled）。
- **node-worker-driver.ts**：`spawnWorker` 公共 helper 抽取（defaultSpawn 双路径 + resolveWorkerPath），`executeOnce` 保留（web_fetch 一次性渲染，**不传 loop** → 单次路径），DRY。

### T2 — 接线：工具 launch/close + 前置校验 + session 兜底 + shutdown hook 装配

- **tool.ts**：action enum 加 `launch`/`close`；attach 分支**零改动**（lazy connect + disconnect 现状）；非 attach：`launch` → `im.launch`（幂等）、`close` → `im.close`、其余 action → `im.execute(sessionId, launchOpts, action, params, ctx.signal)`（内部前置校验）；无 `im` → fail-closed `errorResult('browser: browser instance manager 未注册…')`；screenshot 拦截保留（execute 返回后 decode base64 → saveSnapshot）；`createBrowserTool` deps 增 `instanceManager?`（注入优先于 ctx.config 取）。
- **前置校验铁律（用户铁律「工具调用前必须当前 session 有 chrome instance」）**：非 launch/close action 执行前必须经 InstanceManager 校验（instance 存在 + ready）。无 instance → `{ok:false, error:{kind:'no_browser_instance'}, text:'当前会话没有 headless/managed-profile 浏览器实例，请先调用 browser(action="launch")'}`。attach 模式例外：connectForToolRun lazy connect（attach 不要求显式 launch）。
- **session.ts DELETE handler**：清理链追加 `if (deps.browserInstanceManager) await deps.browserInstanceManager.releaseSession(id).catch(...)`（紧邻 connectorManager.disconnect，幂等，失败不阻塞 204）。
- **session-deps.ts**：`SessionHandlerDeps` 加 `browserInstanceManager?: BrowserInstanceManager`（可选字段，旧装配不破坏）。
- **bootstrap-connectors-phase.ts**：装配 `BrowserInstanceManager`（`new BrowserInstanceManager({dataDir})` **构造即触发开机自检 + shutdown hook 注册**，无需二次挂载）→ noop fallback（失败不阻塞）→ 注入 bootstrap context + session-deps。
- **ctx.config 注入链路（额外 6 文件，超出 coversFiles）**：late-bound.ts / bootstrap.ts / bootstrap-agent-phase.ts(2 处) / router-helpers.ts / session-config.ts / tools-types.ts（+context-types.ts SessionConfig）——`browserInstanceManager` 经 late-bound → bootstrap → agent-phase → router-helpers → session-config 注入（对齐 connectorManager 同款链路；browserTool 模块级单例无法构造注入 → ctx.config 唯一路径）。

### 测试（UT 231 绿 + tsc 0）

- **instance-manager.test.ts（新增）**：launch 幂等（二次 launch 复用 + persistInstance 写记录）/ execute 前置校验（无 instance → no_browser_instance）/ owner 隔离 / close 幂等 + headless rmSync + usedPorts.delete + unpersistInstance / releaseSession kill 全部 / idle timeout / worker exit → worker_crashed / launch 失败透传 + 失败路径清理 / releaseAll 清空 / 开机自检（alive kill / dead 跳过 + 目录删除 + 记录清空）/ shutdown hook 注册幂等 / **abort 2 用例**（前置取消不 kill / 中程 abort kill 进程组+目录+记录+条目）。
- **browser-tool.test.ts**：launch/close 分支（mock im.launch/im.close/im.execute）+ 前置校验（无 im → 未注册）+ attach 回归（不误入 im）+ screenshot 拦截保留（mock im.execute 协议不变）+ SSRF 用例删 makeRegistry。
- **worker-actions.test.ts**：dispatchAction 新签名适配 + 同 state 二次调用 lastRefs 保持断言。
- **node-worker-driver.test.ts**：spawnWorker 抽取适配 + managed-profile 断言 `task.loop === undefined`（单次路径）。

## 设计决策

1. **InstanceManager 粒度 = session × mode[:profile]**（用户原话「每 session 每类型最多一个」）：key = `sessionId:mode[:profileName]`——同一 session 的 managed-profile:a 与 managed-profile:b 是两个独立浏览器（不同 profile = 不同浏览器）；headless 无 profile（临时目录）→ `sessionId:headless` 唯一。attach 走 ConnectorManager（全局一个 connection + owner 门禁，已满足）。
2. **worker 单次 → 常驻循环（方向 A 落地）**：`persistent:true` 标记区分循环/单次（web_fetch 单次不受影响）。跨 action lastRefs 保持 = 「像人的浏览器」关键体验（snapshot 拿 ref → click 同 ref，浏览器还开着）。C1 修复：`loop` 字段独立判常驻，`persistent` 仅连接模式标记（managed-profile 才 ensureProfileFree）。
3. **executeOnce 保留（web_fetch 兼容）**：NodeWorkerDriver.executeOnce 仅服务 web_fetch（一次性渲染）。browser tool 的 headless/managed-profile 改走 InstanceManager。spawn 逻辑抽 spawnWorker 公共 helper 供两者复用。
4. **attach 不动**：attach 用户自启 Chrome，ConnectorManager 已管（owner 门禁 + lazy connect + disconnect），「每 session 一个」语义已满足。launch/close action 对 attach 返回错误（无 launch 概念，close = disconnect 语义）。
5. **launch/close 走工具 action，不加独立 HTTP API**：LLM 直接驱动生命周期最自然（attach 已有 disconnect 先例）；独立 API 需额外权限/路由体系且 LLM 不会主动调。前置校验在工具层（execute 必经 InstanceManager）。
6. **泄漏防护闭环（进程 / 目录 / 端口 / 锁四类全兜底，用户重点要求）**：「正常路径清理 + 崩溃路径兜底」双保险：

| 泄漏类型 | 正常关闭路径 | 崩溃/强杀路径 | 兜底 |
|---|---|---|---|
| **进程**（chrome + worker 树） | close / releaseSession / releaseAll → killProcessGroup(workerPid) | SIGTERM/SIGINT 强杀时 async 清理来不及 → chrome 孤儿 | 开机自检 ② kill 残留（持久化记录 workerPid） |
| **目录**（headless mkdtemp tmp） | close / releaseSession / releaseAll → rmSync(userDataDir) | 残留目录 | 开机自检 ③ 扫描记录删目录 |
| **端口**（CDP 18800-18899） | close / releaseSession / releaseAll → usedPorts.delete(cdpPort) | 重启后 usedPorts 全新（内存态） | 无残留（端口随进程死自动释放；记录里 cdpPort 仅诊断用） |
| **锁**（SingletonLock） | 正常 kill → chrome 退出自动清锁 | 僵尸锁 | ensureProfileFree → clearStaleSingletonLocks（launch 时自动清） |

7. **idle timeout 用 lazy check**（无后台定时器）：默认 `BROWSER_INSTANCE_IDLE_TIMEOUT_MS = 15min`，每次 execute 前置校验时检查 `now - lastUsedAt > idleTimeoutMs` → 自动 close + 返回 idle_timeout 提示重新 launch。显式 close 优先于 idle；session 结束兜底优先于两者。
8. **持久化 `browser-instances.json` 记录 = 残留可发现性锚点**：launch 确认后写（persistInstance）、close/释放删（unpersistInstance）、启动读+清理（构造自检）。instance 本身纯内存态（服务重启即清，下次 launch 重建）；写失败 best-effort（warn 可观测）。
9. **shutdown hook 挂载对齐现有模式**：beforeExit = channelManager/workspaceManager 同款；SIGTERM/SIGINT trap = squad-runtime/scheduler 同款（**只清理不 process.exit**、trap 内吞错）；模块级标记位 `__browserInstanceManagerShutdownHookRegistered` 防重复挂载（bootstrap 多次复用安全）。

## 代码↔spec 核实（doc-modifier 阶段 5）

| 项 | 核验 | 状态 |
|---|---|---|
| tool.ts action enum 加 launch/close | tool.ts:96/105（enum 数组） | ✓ |
| tool.ts attach 分支零改动 | tool.ts:157-191（attach 走 connectorManager.connectForToolRun + disconnect 现状） | ✓ |
| tool.ts 非 attach 全走 im | tool.ts:193-208（launch/close/execute 三分支，无 executeOnce 调用） | ✓ |
| tool.ts 无 im fail-closed | tool.ts:196-198（errorResult「browser instance manager 未注册」） | ✓ |
| tool.ts screenshot 拦截保留 | tool.ts:210-233（execute 返回后 decode base64 → saveSnapshot） | ✓ |
| createBrowserTool deps 增 instanceManager? | tool.ts:57-65（BrowserToolDeps.instanceManager?） | ✓ |
| types.ts 新类型齐全 | types.ts:195-249（BrowserInstance/PersistentWorker/WorkerSessionState/PersistedInstanceRecord/BrowserLaunchOptions） | ✓ |
| launch 幂等（ready 复用） | instance-manager.ts:100-104（existing?.state==='ready' → reuse） | ✓ |
| launch 确认后才 persistInstance | instance-manager.ts:169-174（launchConfirm ok → persistInstance；失败不留记录） | ✓ |
| execute 前置校验 no_browser_instance | instance-manager.ts:186-194（!inst \|\| state!=='ready' → no_browser_instance） | ✓ |
| execute idle lazy check | instance-manager.ts:196-200（nowFn - lastUsedAt > idleTimeoutMs → idle_timeout + closeInstance） | ✓ |
| execute signal 支持（M1 修复） | instance-manager.ts:202-217（aborted 前置检查 + withAbort(signal, send, onAbort)） | ✓ |
| worker 崩溃 → worker_crashed | instance-manager.ts:219-224（catch → state=dead + closeInstance + worker_crashed） | ✓ |
| action 超时 → cdp_timeout + kill | instance-manager.ts:213-217（r.error.kind==='cdp_timeout' → state=dead + closeInstance） | ✓ |
| close 幂等 + 三要素清理 | instance-manager.ts:227-233（无 instance → 'no instance'；closeInstance 统一收尾） | ✓ |
| closeInstance 三要素全路径必达 | instance-manager.ts:269-300（killProcessGroup pid≤0 guard + headless rmSync + usedPorts.delete + unpersist 仅 persisted） | ✓ |
| workerPid 在 spawn 后立即记录 | instance-manager.ts:160（spawned.child.pid ?? 0——失败路径 killProcessGroup 锚点） | ✓ |
| releaseSession 幂等 key 前缀匹配 | instance-manager.ts:235-238（releaseKeys 前缀匹配） | ✓ |
| releaseAll 遍历全部 + 清空 map | instance-manager.ts:240-242（releaseKeys 全部 key） | ✓ |
| 开机自检 cleanupOrphans | instance-manager.ts:66-78（isPidAlive → killProcessGroupByPid + headless rmSync + unpersistInstance） | ✓ |
| shutdown hook 模块级标记位幂等 | instance-manager.ts:86-97（registerShutdownHooks + __browserInstanceManagerShutdownHookRegistered） | ✓ |
| worker-entry loop 分流 | worker-entry.ts:283-295（main()：`task.loop === true` → runPersistent / runOnce） | ✓ |
| persistent 保留连接模式标记 | worker-entry.ts:231（runPersistent 内 `persistent: !!task.persistent` 传 launchChromeAndConnect） | ✓ |
| close / stdin end → kill chrome exit | worker-entry.ts:257-268 / 249-253（close 帧 emit 'closed' exit(0)；stdin end kill exit(0)） | ✓ |
| dispatchAction 增 state 参数 | worker-actions.ts:22-31（签名 state: WorkerSessionState；lastRefs = state.lastRefs） | ✓ |
| lastRefs 跨 action 保持 | worker-actions.ts:60-67（snapshot 更新 state.lastRefs；click/type lookupRef(lastRefs)） | ✓ |
| executeOnce 保留 web_fetch 单次 | node-worker-driver.ts（executeOnce 不传 loop → 单次路径；spawnWorker 抽取） | ✓ |
| session.ts DELETE releaseSession 兜底 | session.ts:261-264（deps.browserInstanceManager.releaseSession(id).catch） | ✓ |
| session-deps 可选字段 | session-deps.ts:102（browserInstanceManager?: BrowserInstanceManager） | ✓ |
| bootstrap 装配 + 构造即自检 | bootstrap-connectors-phase.ts:115-120（new BrowserInstanceManager({dataDir}) + noop fallback） | ✓ |
| ctx.config 注入链路 | session-config.ts:338-340（browserInstanceManager: deps.browserInstanceManager）+ tools-types.ts:139 | ✓ |
| attach 用例回归（不误入 im） | browser-tool.test.ts（attach 分支保持现状断言） | ✓ |
| 文件 ≤300 行 | instance-manager.ts 300 / worker-entry.ts 297 / node-worker-driver.ts 296 / persistent-worker.ts 191 / instance-record.ts 116 / tool.ts 259 | ✓ |

**偏离记录**：
- **M1（Task#2 审查退回）**：instance-manager.execute 缺 `signal?: AbortSignal`——change_plan 行 24/39 明列 signal 参数，实际签名无；旧 executeOnce 有完整 abort 语义，新 execute 无 → 会话取消时 execute 继续等 worker 到 30s cdp_timeout。已修复（execute 增第 5 参 signal + tool.ts 传 ctx.signal + persistent-worker withAbort + 补 2 abort 测试）。
- **C1（Task#1 审查退回）**：executeOnce 的 `task.persistent = !!opts.profileName` 与 worker-entry `if (task.persistent) runPersistent` 语义冲突——executeOnce + profileName 会走 runPersistent、action 被忽略。已修复（worker-entry 用独立字段 `task.loop` 判常驻，persistent 保留连接模式标记）。
- **ctx.config 注入链路额外 6 文件**（超出 coversFiles）：late-bound/bootstrap/bootstrap-agent-phase(2)/router-helpers/session-config/tools-types——browserTool 模块级单例无法构造注入，ctx.config 是唯一路径（与 connectorManager 同款链路）。
- **既有超限文件（非本版本引入）**：bootstrap-agent-phase 417→422 / session-config 377→380 / bootstrap 515→525（base 超 300，本次仅透传 +5/+3/+10）——pre-existing 治理项，后续处理。

## 文档同步（doc-modifier 阶段 5 已完成）

- `[P1]browser_tool.md`：§1 概述图 / §2 executeOnce 注释 / §3 方案+架构图（双形态 A/B）+设计依据+文件级实现 / §7 工具 API（launch/close + 前置校验铁律 + run() 代码）/ §10 边界表——同步常驻实例语义。
- `[P1]browser_instance_manager.md`：本版本新增架构文档（本身即权威，未改）。
- `specs/api/overall/08-web-tools.md` §4：browser 工具 schema action 枚举扩展（+launch/close）+ 输出表 + isError 分支 + 生命周期语义 + 内部实现路径 + 版本尾注 v1.3。
- `specs/tech/agent/tools/log.md`：v0.0.264 条目 + `index.md` browser_tool.md/browser_instance_manager.md 行更新。
- frontend KB：**无前端改动**（v0.0.264 纯后端工具语义，无 UI 变化）→ 不更新。
- `00-app-guide.md`：无 browser 实例管理 UI 入口（v1 无 UI 变化，仅工具语义）→ 不更新。
