# v0.0.264 变更计划书 — Browser Instance Manager（session 级浏览器实例管理）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 技术驱动需求（无 PRD）。设计文档：`specs/tech/agent/tools/[P1]browser_instance_manager.md`。版本上下文：`states/v0.0.264/context.md`。调研：`specs/research/browser-managed-profile-lifecycle.md`。
> **架构期裁决**：① 新增 `BrowserInstanceManager`（session×mode[:profile] 粒度 owner 门禁 + 前置校验 + idle timeout + session 兜底）；② worker 单次执行器 → 常驻循环服务（launch 后保持，跨 action 保持 lastRefs）；③ `NodeWorkerDriver.executeOnce` **保留**（web_fetch 依赖，不破坏）；④ attach 模式**不动**（ConnectorManager 已满足「每 session 一个」）；⑤ launch/close 作为 browser 工具 action（不加独立 HTTP API）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（browser-tool / session） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| browser-tool | app/server/src/tools/browser/instance-manager.ts（新） | BrowserInstanceManager class | 新增 | 平台级实例管理器：`instances: Map<key, BrowserInstance>`；`launch(sessionId, opts)`（幂等：ready 复用 / 无则 spawn 持久 worker + launchChromeAndConnect + state=ready + **persistInstance 写记录**）、`execute(sessionId, opts, action, params, signal)`（前置校验①instance 存在②owner 匹配③idle check → worker.send → 响应）、`close(sessionId, opts)`（发 close 帧 → 等 exit → killProcessGroup 兜底 → **三要素清理**：headless rmSync + usedPorts.delete + unpersistInstance → 删条目）、`releaseSession(sessionId)`（key 前缀匹配全部 close 语义，幂等）、`releaseAll()`（遍历全部 close 语义 + 清空 map，shutdown hook 用）、**构造时开机自检**（读记录 → 孤儿 kill + headless 删目录 + 删记录）、**shutdown hook 注册**（beforeExit + SIGTERM/SIGINT trap → releaseAll，模块级标记位）。key = `${sessionId}:${mode}[:${profileName}]` | MUST key 含 sessionId（owner 天然隔离，跨 session 不可复用）；MUST launch 幂等（已 ready 复用不重复 spawn）；MUST 前置校验失败返回 `{ok:false, error:{kind:'no_browser_instance'|'idle_timeout'|'worker_crashed'|'cdp_timeout'}}` 且 text 提示先 launch；MUST idle 用 lazy check（execute 时 `now-lastUsedAt > idleTimeoutMs` → 自动 close + 返回 idle_timeout），无后台定时器；MUST 单 worker 单任务串行（pending 一次一个）；MUST worker exit 时 reject 全部 pending + state=dead；MUST 三要素清理在 close/releaseSession/releaseAll/launch 失败路径全必达（进程 killProcessGroup / headless rmSync / usedPorts.delete / 删记录）；MUST 清理 catch 记 warn 不静默；MUST shutdown hook 模块级标记位防重复挂载（对齐 channelManager/workspaceManager/squad-runtime 模式） | 设计文档 §3.2/§4.2/§4.3/§4.4/§4.5/§4.6/§4.7/§7/§8 | +260 |
| browser-tool | app/server/src/tools/browser/instance-manager.ts（新） | BrowserLaunchOptions interface | 新增 | `{ mode:'headless'\|'managed-profile'; profileName?: string; executablePath?: string }`——launch/execute 的实例选择参数 | MUST 与 tool.ts toConnectOpts 语义对齐（profileName 仅 managed-profile 有意义） | 设计文档 §3.2/§5.3 | +6 |
| browser-tool | app/server/src/tools/browser/types.ts | BrowserInstance interface | 新增 | `{ key, mode, profileName?, sessionId, userDataDir, cdpPort, worker: PersistentWorker, workerPid, persisted, state:'starting'\|'ready'\|'closing'\|'dead', createdAt, lastUsedAt }`——workerPid 是 killProcessGroup/持久化记录锚点；persisted 防重复写记录 | MUST 字段完整供 InstanceManager 生命周期判定 + 泄漏防护（killProcessGroup 锚点） | 设计文档 §3.2 | +14 |
| browser-tool | app/server/src/tools/browser/types.ts | PersistentWorker interface | 新增 | `{ child: ChildProcess; nextReqId: number; pending: Map<number, {resolve, reject}>; send(action, params): Promise<BrowserExecuteResult> }`——requestId 递增 + pending map 匹配响应 | MUST 每个响应按 requestId 路由到对应 pending；MUST worker exit → reject 全部 pending | 设计文档 §3.2/§6.1 | +18 |
| browser-tool | app/server/src/tools/browser/types.ts | WorkerSessionState interface | 新增 | `{ lastRefs: Record<string, RefInfo> }`——worker 内跨 action 状态（snapshot 的 ref 供后续 click/type 用） | MUST lastRefs 在 worker 生命周期内保持（不再每次 dispatch 重置） | 设计文档 §6.3；worker-actions.ts 现状注释「lastRefs 跨调用重置 = pre-existing 限制」 | +4 |
| browser-tool | app/server/src/tools/browser/types.ts | PersistedInstanceRecord interface | 新增 | `{ key, mode, profileName?, userDataDir, cdpPort, workerPid, createdAt }`——`browser-instances.json` 记录条目（开机自检/残留清理的数据锚点） | MUST 与 BrowserInstance 字段子集一致（持久化不存运行时 worker 对象/state） | 设计文档 §4.7 | +8 |
| browser-tool | app/server/src/tools/browser/instance-record.ts（新） | readPersistedInstances() | 新增 | 读 `<dataDir>/browser-instances.json` → 解析 JSON 数组 → `PersistedInstanceRecord[]`；文件不存在/损坏 → `[]`（catch 吞错，不阻塞启动） | MUST 文件缺失/JSON 损坏返回空数组（启动不炸）；MUST 同步读（构造期执行） | 设计文档 §4.7 | +15 |
| browser-tool | app/server/src/tools/browser/instance-record.ts（新） | persistInstance(rec) | 新增 | 写实例记录：读现有 → append rec → 同步 writeFileSync 重写 `<dataDir>/browser-instances.json`；失败 catch 吞错（best-effort，不阻塞 launch） | MUST 同步写（单进程内顺序安全）；MUST 写失败不影响 launch 主流程（记 warn） | 设计文档 §4.7 | +18 |
| browser-tool | app/server/src/tools/browser/instance-record.ts（新） | unpersistInstance(key) | 新增 | 删实例记录：读现有 → filter 掉 key → 同步 writeFileSync 重写；key 不存在 → no-op | MUST 幂等（key 不在时无副作用）；MUST 写失败不影响 close 主流程（记 warn） | 设计文档 §4.7 | +16 |
| browser-tool | app/server/src/tools/browser/instance-record.ts（新） | isPidAlive(pid) | 新增 | pid 存活检查：`process.kill(pid, 0)` 成功 → true；ESRCH → false；EACCES → true（进程存在无权限信号） | MUST 纯函数无副作用（不真 kill）；MUST ESRCH 判定死亡 | 设计文档 §4.7 | +6 |
| browser-tool | app/server/src/tools/browser/worker-entry.ts | main() | 修改 | 单次执行器 → 循环服务：读第一行（launch 任务）→ launchChromeAndConnect → emit {ok:true,'launched'} → **循环**读 stdin 行 → 每行 `dispatchAction(browser, state, action, params)` → emit 响应（不 exit）；收到 `action:'close'` → kill chrome → exit(0)；stdin end（父进程关闭）→ kill chrome → exit(0) | MUST launch 失败仍 emit fail + exit（同现状）；MUST 循环模式仅在 launch 任务带 `persistent:true` 时启用（web_fetch 单次任务 persistent 缺省 → 走现状单次路径）；MUST 每次 dispatch 后不 kill（chrome 常驻）；MUST close/stdin-end 必 kill chrome（防孤儿） | 设计文档 §6.2/§6.4；worker-entry.ts 现状 main() | +45/-20 |
| browser-tool | app/server/src/tools/browser/worker-entry.ts | readTasksFromStdin()（或循环读改造） | 新增 | 循环读 stdin 行 JSON → 逐行返回任务；父进程关闭 stdin → null（触发退出） | MUST 复用 readTaskFromStdin 的行解析（5s 首行超时保留）；MUST 后续行无首行超时（常驻等待，父进程 close 触发退出） | 设计文档 §6.1/§6.2 | +18 |
| browser-tool | app/server/src/tools/browser/worker-actions.ts | dispatchAction() | 修改 | 签名增 `state: WorkerSessionState` 参数；`let lastRefs` 从函数内新建改为 `state.lastRefs`（跨 action 保持）；ctx/page 保持复用（`browser.contexts()[0]` 已存在则复用） | MUST 现有单次调用路径（web_fetch）传新建 state 对象（行为等价）；MUST 各 action 分支逻辑不变（仅状态来源改 state） | 设计文档 §6.3；worker-actions.ts 现状 | +6/-2 |
| browser-tool | app/server/src/tools/browser/node-worker-driver.ts | spawnWorker() | 新增 | 从 executeOnce 抽出公共 spawn helper：`spawnWorker(task, signal?) → { child, stderrBuf }`——defaultSpawn（dev node / packaged ELECTRON_RUN_AS_NODE）+ resolveWorkerPath 双路径 + 写 stdin + stdout/stderr 监听装配 | MUST 与 executeOnce 现 spawn 行为逐字节一致（defaultSpawn 分支、detached、环境变量）；MUST executeOnce 改为调用本 helper（DRY） | 设计文档 §3.4/§9；node-worker-driver.ts 现状 | +40/-30 |
| browser-tool | app/server/src/tools/browser/node-worker-driver.ts | executeOnce() | 修改 | 保留现有语义（web_fetch 一次性渲染用）：spawn → 写任务 → 等第一行 → killProcessGroup → resolve。改为内部复用 spawnWorker + 单次协议（persistent 缺省 → worker 单次路径） | MUST web_fetch 调用方零改动（executeOnce 签名/返回不变）；MUST 不引入常驻 | 设计文档 §3.4/§6.4 | +0/-10 |
| browser-tool | app/server/src/tools/browser/tool.ts | run() | 修改 | ① action 枚举加 `'launch'`/`'close'`（description 更新）；② `mode==='attach'` 分支不动（lazy connect + disconnect 现状）；③ 非 attach：`action==='launch'` → `InstanceManager.launch(sessionId, {mode, profileName})` 返回；`action==='close'` → `InstanceManager.close(...)` 返回；④ 其余 action：`InstanceManager.execute(sessionId, {mode, profileName}, action, params, ctx.signal)`（内部前置校验）替代 `driver.executeOnce(...)`；⑤ screenshot 落盘拦截逻辑保留（execute 返回后同现状 decode base64 → saveSnapshot） | MUST attach 分支零行为变化；MUST 非 attach 的 navigate/snapshot/click/type/listPages/selectPage/evaluate/screenshot 全部经 InstanceManager.execute（前置校验铁律）；MUST InstanceManager 从 `ctx.config.browserInstanceManager` 取（缺省报「browser instance manager 未注册」）；MUST 不再直接调 driver.executeOnce（headless/managed-profile 走常驻）；MUST screenshot 拦截逻辑原样保留（execute 返回后处理） | 设计文档 §5.1/§5.2；tool.ts 现状 run() | +40/-25 |
| browser-tool | app/server/src/tools/browser/tool.ts | createBrowserTool() 签名/依赖 | 修改 | 构造参数增 `instanceManager?: BrowserInstanceManager`（注入优先于 ctx.config 取） | MUST 可选参数（UT 可缺省）；MUST 与 connectorManager 注入模式一致 | 设计文档 §9；tool.ts 现状 | +4 |
| browser-tool | app/server/src/bootstrap-connectors-phase.ts | createAndBootstrapConnectorManager() / 装配 | 修改 | 装配 `BrowserInstanceManager`（注入 dataDir + spawn 依赖，**构造即触发开机自检**）→ **注册 shutdown hook**（beforeExit + SIGTERM/SIGINT trap → `void instanceManager.releaseAll()`，模块级标记位 `__browserInstanceManagerShutdownHookRegistered` 防重复挂载，对齐 channelManager/workspaceManager/squad-runtime 模式）→ 挂 bootstrap context + 注入 browserTool 构造 | MUST 与现有 connectorManager 装配并列（attach 与 instance manager 并存）；MUST 失败不阻塞（noop fallback 同 connector 模式）；MUST shutdown hook 只做资源清理不 process.exit（与 squad-runtime 同模式，trap 内吞错）；MUST 标记位防重复挂载（对齐现有模式） | 设计文档 §3.1/§4.6/§9；bootstrap-connectors-phase.ts 现状（channelManager beforeExit 注册位置） | +20 |
| session | app/server/src/handlers/session.ts | DELETE handler | 修改 | session 删除清理链追加 `if (deps.browserInstanceManager) await deps.browserInstanceManager.releaseSession(id).catch(...)`（紧邻 connectorManager.disconnect） | MUST 幂等（无 instance 时 no-op）；MUST 失败 catch 不阻塞 204（同 disconnect 模式） | 设计文档 §4.4；session.ts 现状 line ~250 | +3 |
| session | app/server/src/handlers/session-deps.ts | SessionHandlerDeps interface | 修改 | 加 `browserInstanceManager?: BrowserInstanceManager` 字段 | MUST 可选字段（旧装配不破坏） | 设计文档 §9；session-deps.ts 现状 | +2 |
| browser-tool | app/server/src/tools/browser/__tests__/instance-manager.test.ts（新） | launch/execute/close/releaseSession/idle/泄漏防护测试 | 新增 | ① launch 幂等（同 key 二次 launch 复用不重复 spawn）+ **persistInstance 写记录断言**；② execute 前置校验（无 instance → no_browser_instance）；③ owner 隔离（其他 session 同 profile → 不可复用）；④ close 幂等 + 发 close 帧 + **headless rmSync 断言 + usedPorts.delete 断言 + unpersistInstance 断言**；⑤ releaseSession kill 全部 + 幂等 + 三要素清理；⑥ idle timeout（mock Date/注入 now → 超时自动 close）；⑦ worker exit → pending reject + worker_crashed；⑧ launch 失败透传 profile_in_use + **失败路径端口/目录清理**；⑨ **releaseAll 清空全部 + 三要素**；⑩ **开机自检：预置记录文件 → alive pid killProcessGroup / dead pid 跳过 kill + headless 目录删除 + 记录清空**；⑪ **shutdown hook 注册幂等（标记位）** | MUST mock spawn（vi.mock child_process / NodeWorkerDriver spawn helper）不真启 Chrome；MUST 断言错误 kind 精确；MUST 泄漏防护用例 mock fs（rmSync/writeFileSync）断言被调 | 设计文档 §4.3/§4.4/§4.6/§4.7/§7/§9 | +210 |
| browser-tool | app/server/src/tools/browser/__tests__/worker-actions.test.ts | dispatchAction 调用适配 | 修改 | dispatchAction 新签名（传 state 对象）；新增断言：同 state 二次调用 lastRefs 保持（snapshot 后 click 同 ref 有效） | MUST 现有断言语义不破坏（单次调用传新 state 等价）；MUST 新增跨 action ref 保持用例 | 设计文档 §6.3 | +15/-2 |
| browser-tool | app/server/src/tools/browser/__tests__/browser-tool.test.ts | launch/close/前置校验用例 | 修改 | 新增：① launch action（mock InstanceManager.launch 返回 ok）；② 无 instance 时 navigate → errorResult 提示先 launch（mock execute 返 no_browser_instance）；③ close action；④ attach 分支回归（不误入 instance manager） | MUST attach 用例保持现状断言（零行为变化回归）；MUST mock InstanceManager（不真 spawn） | 设计文档 §5.1/§5.2 | +40 |
| browser-tool | app/server/src/tools/browser/__tests__/node-worker-driver.test.ts | spawnWorker 抽取适配 | 修改 | spawnWorker 新增后的测试适配（若 mock 点变化）；executeOnce 语义断言不变 | MUST executeOnce 测试全部保持（web_fetch 回归护栏） | 设计文档 §3.4 | +5/-5 |

## 影响面评估

- **跨模块**：browser-tool（instance-manager 新 + worker-entry/worker-actions/tool.ts/node-worker-driver/types 改 + browser-worker.cjs 重新 build）+ session（DELETE 兜底 + deps）。attach 模式零改动（ConnectorManager 保持）。
- **破坏性变更**：**无 API 契约破坏**——browser 工具 action 新增 launch/close（枚举扩展向后兼容）；executeOnce 保留（web_fetch 零影响）；attach 行为不变。**行为变更（预期内）**：headless/managed-profile 从「每次调用新实例」变「常驻实例」——跨 tool_call 的页面/refs 保持（这正是本版本目标）；无 instance 时 action 报错提示先 launch（前置校验铁律）。
- **依赖顺序**：T1 worker 常驻化 + InstanceManager 核心 + 泄漏防护（instance-manager.ts 新 + instance-record.ts 新 + worker-entry/worker-actions/types 改 + node-worker-driver spawnWorker 抽取 + 对应测试）→ T2 工具接线 + session 兜底 + shutdown hook 装配（tool.ts launch/close/前置 + bootstrap 装配+hook + session.ts + session-deps.ts + browser-tool.test.ts）。T1 是引擎（含泄漏防护主体），T2 是接线（含 shutdown hook 挂载），串行依赖（T2 依赖 T1 的 InstanceManager API——契约已冻结，可并行编码但保守串行）。
- **风险点**：
  1. **Bun playwright bug（BUG-001）**：worker 必须在 node 子进程跑（InstanceManager spawn 走 defaultSpawn node/ELECTRON_RUN_AS_NODE，绝不能 Bun 直跑）。
  2. **孤儿进程**：worker 常驻后 kill 路径必须完整——四重兜底：close 帧 → 等 exit → 3s killProcessGroup → releaseAll（shutdown hook）→ 开机自检（持久化记录 kill 残留）。**killProcessGroup(workerPid) 是唯一锚点，workerPid 必须在 launch 后立即记录（含失败路径清理）**。
  3. **worker 协议向后兼容**：web_fetch 单次任务（无 persistent）必须走现状单次路径——worker 循环改造不能破坏 executeOnce。
  4. **文件 ≤300 行**：instance-manager.ts 预计 ~260-280 行（含泄漏防护，接近上限——若超限把开机自检/持久化调用拆到 instance-record.ts + 私有 helper，coder 按需压缩）；instance-record.ts 新 ~60 行 OK；worker-entry.ts 154 → ~200 行 OK；tool.ts 259 → ~280 行（接近上限，coder 注意）。
  5. **idle timeout 配置**：默认 15min 硬编码常量（`BROWSER_INSTANCE_IDLE_TIMEOUT_MS`），环境变量覆盖可留后续版本（v1 常量即可）。
  6. **shutdown hook 幂等**：bootstrap 多次复用（bootstrapCache/测试）会重复挂 hook → 模块级标记位 `__browserInstanceManagerShutdownHookRegistered` 防重复（对齐 channelManager/workspaceManager 既有标记位模式）；SIGTERM/SIGINT trap 只清理不 exit（与 squad-runtime 并存安全）。
  7. **持久化记录写入失败**：磁盘满/权限 → writeFileSync 抛 → catch 吞错不阻塞主流程（launch/close 仍完成），但记录缺失 → 下次崩溃残留无法被发现 → 记 warn 可观测。
- **doc-modifier 阶段 5 待同步**：`[P1]browser_tool.md` §3（一次性执行器 → 常驻）+ §7（工具 API launch/close）+ `[P1]browser_instance_manager.md`（本版本新增，本身即权威）；`04-agent-session.md` §2.6.1（browser 工具 schema action 枚举扩展）；`00-app-guide.md`（若 UI 有 browser 实例管理入口——v1 无 UI 变化，仅工具语义）。

## 架构决策记录（用户意图落地 + 实现差异裁决）

### 决策 ①：InstanceManager 粒度 = session × mode[:profile]
用户原话「每 session 同时只能拥有一个 instance，或者每个类型（attach、独立 profile、headless）各自只能有一个」。落地取「mode + profile」粒度（key = `sessionId:mode[:profileName]`）：同一 session 的 managed-profile:a 与 managed-profile:b 是两个独立浏览器（不同 profile = 不同浏览器，符合「独立 profile」语义）；headless 无 profile（临时目录）→ `sessionId:headless` 唯一。attach 走 ConnectorManager（全局一个 connection + owner 门禁，已满足）。

### 决策 ②：worker 单次 → 常驻循环（方向 A 落地）
worker-entry main 循环读 stdin 任务，launch 后不退出。`persistent:true` 标记区分循环/单次（web_fetch 单次不受影响）。跨 action lastRefs 保持 = 「像人的浏览器」关键体验（snapshot 拿 ref → click 同 ref，浏览器还开着）。

### 决策 ③：executeOnce 保留（web_fetch 兼容）
NodeWorkerDriver.executeOnce 仅服务 web_fetch（一次性渲染）。browser tool 的 headless/managed-profile 改走 InstanceManager。spawn 逻辑抽 spawnWorker 公共 helper 供两者复用。

### 决策 ④：attach 不动
attach 用户自启 Chrome，ConnectorManager 已管（owner 门禁 + lazy connect + disconnect），「每 session 一个」语义已满足。launch/close action 对 attach 返回错误（无 launch 概念，close = disconnect）。

### 决策 ⑤：launch/close 走工具 action，不加独立 HTTP API
LLM 直接驱动生命周期最自然（attach 已有 disconnect 先例）；独立 API 需额外权限/路由体系且 LLM 不会主动调。前置校验在工具层（execute 必经 InstanceManager）。

### 决策 ⑥：泄漏防护闭环（进程 / 目录 / 端口 / 锁四类全兜底）
用户明确要求着重检查泄漏。设计为「正常路径清理 + 崩溃路径兜底」双保险：
- **进程**：正常 = close/releaseSession/releaseAll → killProcessGroup(workerPid)；崩溃/强杀 = SIGTERM/SIGINT trap（releaseAll）+ 开机自检（持久化记录 kill 孤儿）。
- **目录**：headless mkdtemp 临时目录正常 close rmSync；崩溃残留 = 开机自检删目录。managed-profile 用户数据不删（SingletonLock 僵尸由 ensureProfileFree 清）。
- **端口**：InstanceManager 独立 usedPorts Set，close/releaseAll/失败路径 delete；重启后内存态全新无残留（跨管理器冲突靠 allocateCdpPort isBusy 真实探测兜底）。
- **锁**：正常 kill chrome 自动清；崩溃残留锁由现有 clearStaleSingletonLocks（ensureProfileFree launch 时自动清）。
- **可发现性锚点**：持久化 `<dataDir>/browser-instances.json` 记录（key/mode/userDataDir/cdpPort/workerPid）——launch 写、close/释放删、启动读+清理。写失败 best-effort（warn 可观测）。
- **shutdown hook 挂载**：对齐现有 bootstrap 模式（beforeExit = channelManager/workspaceManager 同款；SIGTERM/SIGINT trap = squad-runtime/scheduler 同款；模块级标记位防重复挂载）。
