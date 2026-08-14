# [P1] Browser Instance Manager（session 级浏览器实例管理）

> v0.0.264 新增架构文档。对齐 `[P1]browser_tool.md`（一次性执行器现状）与 `specs/research/browser-managed-profile-lifecycle.md`（根因分析 + 方向 A/B）。
> `[v0.0.272]` 增对账兜底回收（§4.9）：marker 白名单 + 双段扫描 + 三层判定 + 周期/启动/close 触发——孤儿 chrome 结构性收敛（修 BUG-chrome-orphan-process-leak）。
> `[v0.0.330]` instanceKey 三模式统一 `${sessionId}:${mode}`（profileName 不进 key，owner 天然隔离）+ close 无实例明确报错 + attach close 断 MCP 后检测 Chrome 调试态残留并返回引导提示（透传至 text）。
> `[v0.0.334]` 删 cdpUrl（attach 仅 autoConnect）+ 持久化记录从 `browser-instances.json` 迁移到 **sqlite 台账表**（`browser_instances`，launch insert / close 硬删 / 启动按表清理残留，attach MCP 子进程入台账）。
> `[v0.0.334.fix]` **attach 失活即时清账**（Bug2 计数虚高根治）：impl 失活分支 `env.ledger.delete` + `env.discardInstance`（best-effort 幂等），manager 收尾退化防御 catch；manager 暴露 `discardInstance` 最小同步摘表口经 env 注入（§4.2）。
> `[v0.0.336]` **close 三层一致**（老板定调：真实资源层 + 记录层 + 感知层同步清、失败诚实上报）：`ModeImpl.close` 返回 **CloseResult**（ok/error 失败通道）；attach close 显式回收 mcp 主进程组 + 兜底杀 detached watchdog（G4/G5）+ connect/disconnect cache key 对称（G1/G2，根除 launch 复用死连接）；closeInstance 清理失败不删表可重试（close_incomplete）。
> `[v0.0.337]` **attach launch 失败/超时清理升级**（H1-H9）：driver connect 失败路径补 kill 进程组 + watchdog（对齐 close 三层清理）+ signal abort 感知（launch 超时 → 立即清理）+ **失败入台账**（insert 不 delete，留给启动自检回收）。
> 用户设计意图（原话）：browser 工具应该像人的浏览器——打开后一直开着，每次操作都在同一个浏览器实例上。工具本身无状态，但浏览器实例本身就是状态。应该有一个 browser instance manager 管理 session 和 instance 的关系。每 session 每类型最多一个 instance。工具调用前必须当前 session 有 chrome instance 才能发起。

## 1. 问题定义

### 1.1 现状（v0.0.263 及以前）

| mode | 生命周期 | 每次 tool_call 行为 |
|------|---------|--------------------|
| headless | 调用级 | `NodeWorkerDriver.executeOnce` 全新 spawn worker → 启动 Chrome（临时目录）→ 1 个 action → SIGKILL 进程组 → exit |
| managed-profile | 调用级 | 同上，但用持久 user-data-dir（SingletonLock 保护）；**每次调用都重新启动 Chrome**，状态（cookie/页面/lastRefs）全丢 |
| attach | 会话级（用户自启） | `[v0.0.266]` InstanceManager 持有（key=`sessionId:attach`，存 BrowserSession；`[v0.0.334]` -cdpUrl）；launch=connect（仅 autoConnect）/ 操作经 execute 统一路由（attach impl dispatch，T3）/ close=断 MCP + 杀 mcp 进程组 + watchdog 兜底 + 检测调试态残留并提示（`[v0.0.330]`→`[v0.0.334]` 恒检测 →`[v0.0.336]` 显式回收进程组），不 kill 用户 Chrome |

**根因**：`worker-entry.ts` 注释明言「一次性执行器（无会话状态保持）」。不是 bug，是架构设计——但与用户「浏览器像人的浏览器常驻」的期望冲突。

### 1.2 用户期望

1. browser 实例**常驻**：launch 后一直活着，直到显式 close 或 session 结束
2. 每次操作都在**同一个实例**上（页面、登录态、lastRefs 跨 tool_call 保持）
3. 每 session 每类型（attach / managed-profile / headless）**最多一个** instance
4. 工具调用**前置校验**：当前 session 无对应类型 instance → 报错（提示先 launch）
5. 显式生命周期入口：launch / close
6. **泄漏防护**：服务器关闭清理、headless 临时目录清理、CDP 端口释放、残留进程开机自检（用户重点要求）

## 2. 概念定义

- **BrowserHandle**（`[v0.0.266 T3]` 原 BrowserInstance 更名）：句柄表条目（manager 持有），`{ key, mode, state: 'starting'|'ready'|'closing'|'dead', createdAt, lastUsedAt }`；`key = sessionId:mode`（`[v0.0.330]` 三模式统一，profileName 不进 key——profile 由 handle 承载；`[v0.0.334]` -cdpUrl）每 session 每 mode 最多一个。worker 细节（userDataDir/cdpPort/worker/workerPid/persisted）在 WorkerHandle（WorkerModeImpl 私有扩展），attach 细节（session/mcpPid）在 AttachHandle（AttachModeImpl 私有扩展）——**manager 只读公共字段，不碰私有**。
- **ModeImpl / ModeImplRegistry**（`[v0.0.266 T3]`）：无状态策略集 `{ launch(key,opts,env), execute(handle,action,params,ctx), close(handle,env), cleanupOrphan?(rec,env) }`；headless/managed-profile 注册**同一 WorkerModeImpl 实例两键**，attach 注册 AttachModeImpl（自带主进程 dispatch + 失活自愈）。manager 经 `registry.get(mode)` 分发，**零 `mode ===` 判断**。
- **BrowserInstanceManager**：平台级管理器 = 句柄表 + registry + 状态机，管生命周期（launch/execute/close 全经 impl）+ 前置校验 + idle + session 结束兜底清理 + 泄漏防护（进程/目录/端口/锁）。
- **持久 worker**：node 子进程，循环读 stdin 任务 → 调 playwright → stdout 响应，**不退出**（区别于现状一次性 worker；仅 mode①② 用）。
- **owner 门禁**：key 含 sessionId（attach=`sessionId:attach` / managed-profile=`sessionId:managed-profile` / headless=`sessionId:headless`，`[v0.0.330]` 起三模式统一 `${sessionId}:${mode}`），instance 属于 launch 它的 session，其他 session 不能复用（owner 天然隔离）。

## 3. 架构方案

### 3.1 总览

```
browser tool (tool.ts)
 └─ 三 mode 统一 ─────────────→ BrowserInstanceManager（`[v0.0.266]` attach 纳入；T3 registry 重构）
        ├─ instances: Map<key, BrowserHandle>（句柄表）
        ├─ launch(sessionId, opts) → registry.get(mode).launch(key, opts, env)（幂等；attach = connect）
        ├─ execute(sessionId, opts, action, params, ctx) → assertReadyInstance → registry.get(mode).execute(...)（三模式统一路由，T3 起 attach 也走 execute）
        ├─ close(...) → registry.get(mode).close(...)（mode①② 三要素清理；attach = disconnect 不杀 chrome）
        ├─ releaseSession(sessionId) / releaseAll() → 兜底清理（经 impl.close）
        └─ 构造时开机自检（扫残留孤儿 → registry.get(mode).cleanupOrphan）+ `[v0.0.272]` fire-and-forget 对账扫描兜底（reconcileOrphans，覆盖无记录孤儿）

持久 worker（worker-entry.ts 改造：单次执行器 → 循环服务；仅 mode①②）
 ├─ stdin: 每行 {requestId, action, params}（含 launch/close）
 ├─ stdout: 每行 {requestId, ok, text?, error?}
 └─ Chrome 常驻：launch 后不退出，跨 action 保持 page/ctx/lastRefs
```

### 3.2 BrowserInstance 数据结构

```ts
// manager 句柄表条目（只读公共字段，不碰 impl 私有扩展）
interface BrowserHandle {
  key: string;                 // `${sessionId}:${mode}`（`[v0.0.330]` 三模式统一；profileName 不进 key，`[v0.0.334]` -cdpUrl）
  mode: 'headless' | 'managed-profile' | 'attach';
  state: 'starting' | 'ready' | 'closing' | 'dead';
  createdAt: number;
  lastUsedAt: number;          // idle timeout 判定（manager 刷新，impl 不碰）
}
// WorkerModeImpl 私有扩展（仅 worker-mode-impl.ts 读写）
interface WorkerHandle extends BrowserHandle {
  userDataDir: string;         // managed-profile: 持久目录; headless: mkdtemp
  profileName?: string;
  cdpPort: number;             // 该 instance 独占端口
  worker: PersistentWorker;    // { child, nextReqId, pending: Map<reqId, resolve> }
  workerPid: number;           // killProcessGroup 用 + 持久化记录核心
  chromePid?: number;          // `[v0.0.272]` launch 确认帧携带（browser.process()?.pid）；close 兜底 kill chrome 组 + 对账精确判定用；旧 worker undefined 兼容
  persisted: boolean;
}
// AttachModeImpl 私有扩展（仅 attach-mode-impl.ts 读写）
interface AttachHandle extends BrowserHandle {
  session: BrowserSession;
  /** `[v0.0.334]` -cdpUrl；新增 mcpPid（chrome-devtools-mcp 子进程 pid，台账锚点） */
  mcpPid?: number;
}
```

**泄漏防护三要素（贯穿实例生命周期）**：
- **进程**：workerPid 是 killProcessGroup 的锚点（负 pid 杀 chrome 树）——close / releaseSession / releaseAll / 开机自检共用。
- **目录**：headless 的 userDataDir 是 `mkdtempSync(join(tmpdir(), 'rocky-browser-worker-'))` 临时目录，close 时必须 `rmSync`；managed-profile 是用户数据（持久，不删）。
- **端口**：InstanceManager 持有自己的 `usedPorts: Set<number>`，close 时 `delete(cdpPort)`；与 NodeWorkerDriver 的 usedPorts 独立（private 不碰），冲突靠 `allocateCdpPort` 的 isBusy 真实探测兜底。

### 3.3 与 ConnectorManager 的关系

- **attach（`[v0.0.266]` 纳入 InstanceManager；T3 下沉 AttachModeImpl；`[v0.0.334]` -cdpUrl + mcpPid；`[v0.0.336]` close 显式回收进程组）**：attach 的「instance」= InstanceManager 条目（key=`sessionId:attach`，存 AttachHandle{session, mcpPid}，不走 worker）。launch = ChromeMcpDriver.connect（仅 autoConnect；attach impl 经 ModeImplEnv 注入共享 attachDriver 单例 + isAttachEnabled 门禁）；操作经 execute 统一路由（attach impl 内 dispatchAction + 失活自愈 + screenshot 落盘）；close = attachDriver.disconnect（传 userDataDir 对称清 cache）+ killProcessGroup(mcpPid) + killOrphanMcpWatchdog + 台账 delete（`[v0.0.336]` G4/G5，不杀用户 Chrome）+ CloseResult 诚实上报。ConnectorManager 瘦身为「switch 门禁 + UI 状态」（enable/disable/bootstrap/getState/getAll/isReady），不再持有 attach session/owner。
- **headless/managed-profile**：新增 `BrowserInstanceManager`。attach 与 headless/managed-profile 统一由 InstanceManager 管理，三模式共用 launch/close/前置校验入口，互不干扰。
- **统一 owner 门禁语义**：key 含 sessionId（attach=`sessionId:attach` / managed-profile=`sessionId:managed-profile:x` / headless=`sessionId:headless`），owner 天然隔离，跨 session 不可复用。

### 3.4 与 NodeWorkerDriver / web_fetch 的关系

- **NodeWorkerDriver.executeOnce 保留**：`web_fetch` 的 headless render 子分支依赖它（一次性渲染，不需要常驻）。**不得破坏**。
- browser tool 的 headless/managed-profile 改走 InstanceManager（常驻）；NodeWorkerDriver 仅服务 web_fetch。
- worker 协议升级后，executeOnce 与持久 worker **共用** spawn/launch/action 逻辑，差异仅在「执行完是否退出」。

## 4. 生命周期

### 4.1 launch（显式启动）

**attach（`[v0.0.266]`）**：
```
browser(mode='attach', action='launch')   // `[v0.0.334]` -cdpUrl：仅 autoConnect（driver 恒 --autoConnect）
→ InstanceManager.launch(sessionId, {mode:'attach'}, ctx)   // `[v0.0.337]` H7：ctx?:{signal?} 透传（attach 超时 abort 感知）
   ├─ key = sessionId:attach
   ├─ 门禁① isAttachEnabled()（读 connectorManager switch）false → {ok:false, error:{kind:'not_enabled'}}
   ├─ 门禁② attachDriver 缺省（bootstrap 降级）→ {ok:false, error:{kind:'attach_failed', message:'驱动未注册'}}（fail-closed）
   ├─ 幂等：instances.get(key) 且 state=ready → 复用，返回 {ok:true, text:'reuse attach'}
   ├─ 无/starting/closing/dead → 清理旧 → connectAttachSession(driver, {}, ctx?.signal)   // `[v0.0.337]` H4：signal 透传
   │    = ChromeMcpDriver.connect({userDataDir}, signal)（spawn chrome-devtools-mcp --autoConnect + list_pages round-trip 判据）→ BrowserSession + mcpPid
   │    `[v0.0.337]` H5：driver spawn 即记 lastSpawnPid（成功失败都记，disconnect 清；与 lastMcpPid 仅成功 set 语义区分）
   │    `[v0.0.337]` H3：signal abort → 抛 attach_failed → 走 connect catch → H2 清理（graceful close → kill 进程组 → watchdog）
   │    `[v0.0.337]` H2：connect 失败 catch 补 killProcessGroup(transport.pid) + killOrphanMcpWatchdog（win32 跳过，best-effort）
   ├─ 成功：组装 instance：{ key, mode:'attach', sessionId, session, mcpPid, state:'ready' }
   │    env.ledger.insert({ key, mode:'attach', worker_pid: mcpPid, created_at })   // `[v0.0.334]` attach 入台账
   │    返回 {ok:true, text:'launched attach'}
   └─ 失败（`[v0.0.337]` H9）：r.spawnPid !== undefined → env.ledger.insert({key, mode:'attach', workerPid: r.spawnPid, createdAt: now})
        —— **insert 不 delete**：进程可能残留（driver 清理失败的极端场景），留台账给启动自检 cleanupOrphan 回收；
        下次成功 launch INSERT OR REPLACE 覆盖同 key；启动自检 kill 已死 pid no-op + delete 无害；insert 失败 warn 不阻断 return error
```

**mode①②（worker-based）**：
```
browser(mode='managed-profile', action='launch', profileName='x')
→ InstanceManager.launch(sessionId, {mode, profileName})
   ├─ key = sessionId:managed-profile（`[v0.0.330]` 三模式统一，profileName 不进 key）
   ├─ instances.get(key) 且 state=ready → 复用，返回 {ok:true, text:'reuse managed-profile (profile: x)'}（文本用 handle 存的首次 profileName，不读 opts——`[v0.0.330]` D-B）
   ├─ 无/starting/dead → 清理旧 instance（若有）→ 创建：
   │    userDataDir = resolveUserDataDir(dataDir, profileName)   // managed-profile
   │    cdpPort = allocateCdpPort(usedPorts) + usedPorts.add(cdpPort)
   │    spawn 持久 worker（node，detached）→ 记录 workerPid
   │    stdin 写 {requestId:0, action:'launch', launch:{executablePath,userDataDir,cdpPort,headless,persistent:true}}
   │    等 launch 确认帧（worker 内 launchChromeAndConnect 成功）→ state=ready；`[v0.0.272]` 确认帧携带 chromePid（browser.process()?.pid）→ handle.chromePid
   │    persistInstance(instance)  // `[v0.0.334]` → env.ledger.insert（sqlite 台账；`[v0.0.272]` 起含 chromePid）
   └─ 返回 {ok:true, text:'launched profile x'}
```

- 失败：launch 帧 `ok:false` 或 worker exit → state=dead，返回 {ok:false, error}（profile_in_use 等原样透传）；**失败路径同样要释放端口 + 删临时目录（headless）**；attach 失败（门禁/connect）不落 map，但 `[v0.0.337]` H9 connect 失败且 spawnPid 存在时**入台账**（insert 不 delete，留给启动自检回收；门禁失败不 spawn 无 pid 不入账）。
- **幂等**：已 ready 的 launch 复用（不重复 spawn / connect）。**同 session 同 mode 重复 launch（即使 profileName 不同）= 复用已有实例，不换 profile**（`[v0.0.330]` 老板语义：创建后使用/关闭只需 mode）；想换 profile 先 close 再 launch。

### 4.2 action 执行（navigate/snapshot/click/...）

**attach（`[v0.0.266 T3]`）**——操作类 action 统一走 execute（registry 路由 AttachModeImpl，impl 内 dispatch，不再 tool.ts 主进程分叉）：
```
browser(mode='attach', action='navigate', url='...')
→ InstanceManager.execute(sessionId, {mode:'attach'}, action, params, ctx)
   ├─ 前置校验①：assertReadyInstance（无 instance/非 ready → no_browser_instance 引导先 launch）
   ├─ 前置校验②：idle check（同 mode①②）
   ├─ registry.get('attach') = AttachModeImpl.execute → dispatchAction(session, action, params, ctx)
   │    ├─ 失活检测：isAttachConnectionLost(文本) → 置 handle.state='dead' + **impl 即时清账（`[v0.0.334.fix]` Bug2 计数虚高根治）**：
   │    │   ① `env.ledger.delete(handle.key)`（sqlite 台账同步删；try/catch best-effort，失败 warn 不阻断）
   │    │   ② `env.discardInstance?.(handle.key)`（内存 instances Map 即时摘表——`size`/`listAll` 实时准确）
   │    │   语义：attach 失活 = Chrome 已被关、MCP 连接已断，资源实际已死，无需等 close 惰性兜底（旧 manager.execute 兜底只在「同 key 再次 execute」才触发，失活后用户不再操作 → 残留虚高）。env 来源：launch 缓存（ModeImpl.execute 接口无 env 参数，AttachModeImpl 单例缓存安全）。两操作均幂等（后续 closeInstance 兜底再删 no-op）。MUST NOT 调 disconnectAttachSession（连接已断，重复 disconnect 无意义）。返回 {ok:false, error:{kind:'attach_lost', message:'连接已断开（Chrome 可能被关闭），请重新 launch'}}
   │    └─ 非失活错误/成功 → 原样透传（screenshot 落盘在 impl 内经 ctx.snapshot）
   └─ manager 收尾（防御 catch `[v0.0.336]`）：execute 返回后 state==='dead' → closeInstance（impl.close = disconnect + 删条目）——impl 已即时清账后此处退化为防御兜底（重复删 no-op）
```

**mode①②（worker-based）**：
```
browser(mode='managed-profile', action='navigate', url='...', profileName='x')
→ InstanceManager.execute(sessionId, {mode, profileName}, action, params)
   ├─ 前置校验①：instances.get(key) 无/非 ready → {ok:false, error:'no_browser_instance', text:'当前会话没有 ... 实例，请先 launch'}
   ├─ 前置校验②：owner 门禁（key 匹配即 owner 匹配——key 含 sessionId，天然隔离）
   ├─ idle check：now - lastUsedAt > idleTimeoutMs → 自动 close → {ok:false, error:'idle_timeout', text:'实例已闲置关闭，请重新 launch'}
   ├─ worker.send(requestId++, {action, params}) → 等响应
   └─ 更新 lastUsedAt，返回 {ok, text?, error?}
```

- **M1 防御分支已下线（`[v0.0.266 T3]`）**：旧「execute 对 attach 拒绝」删除——execute 经 registry 正确路由 attach impl（失活自愈下沉 impl），不再有 mode 分叉。
- per-action timeout 保持 WORKER_TIMEOUT_MS=30s；超时 → kill instance + state=dead + {ok:false, error:'cdp_timeout'}。worker 中途 exit（崩溃）→ pending 全部 reject + state=dead → {ok:false, error:'worker_crashed'}。

### 4.3 close（显式关闭）

```
browser(mode='managed-profile', action='close', profileName='x')
→ InstanceManager.close(sessionId, {mode, profileName})
   ├─ 无 instance → {ok:false, error:{kind:'no_browser_instance', message:'当前会话没有 {mode} 浏览器实例，请先调用 browser(action="launch")'}}（`[v0.0.330]` D-C，不再静默 no-op）
   ├─ 有 → 发 close 帧（worker kill chrome）→ 等 exit（3s 超时 killProcessGroup 兜底）
   ├─ 清理（三要素，全路径必达）：
   │    ① 进程：killProcessGroup(workerPid) 兜底（close 帧失败/超时）
   │    ② 目录：headless → rmSync(userDataDir, {recursive:true, force:true})
   │    ③ 端口：usedPorts.delete(cdpPort)
   └─ 删 map 条目 + env.ledger.delete(key)（`[v0.0.334]` 硬删台账），返回 {ok:true, text:'closed'}（impl.close 返回提示文本时透传）
```

- **`[v0.0.336]` close 三层一致（老板定调：风雨无阻、无条件清干净 + 诚实上报）**：
  - **真实资源层**（进程/连接）+ **记录层**（driver cache + sqlite 台账）+ **感知层**（不谎报）三层同步清，任何一步失败**不中断整体清理**（try/catch best-effort 全清），但**失败要收集最终诚实上报**。
  - `ModeImpl.close` 返回类型升级为 **`CloseResult`**：`{ok:true, text?}` 清理成功（text 为残留引导提示，无则 manager 输出 'closed'）/ `{ok:false, error:{kind?, message}}` 清理失败（任一清理步骤失败 → kind='close_incomplete'，message 汇总各步失败）。
  - `closeInstance`：impl.close 返回 ok=false 或抛错 → **不删 instances**（保留表项让调用方知状态未归零，可重试 close）+ 记 warn；manager.close catch → 返回 `{ok:false, error:{kind:'close_incomplete', message:'close 清理不完整（实例保留可重试）: ...'}}`，不穿透调用方。
  - **防御 catch（`[v0.0.336]` 独立复审裁决）**：execute 失活收尾 / idle timeout 两处 closeInstance 调用补 try/catch——清理失败不逃逸出 execute/assertReadyInstance（catch 住保留表项可重试），仍返回原预期文案（attach_lost / worker_crashed / idle_timeout），不降级 RUNTIME_ERROR。
  - worker-mode-impl close 适配 `{ok:true}`；幂等语义不变。

- **attach 的 close = 断 MCP + 杀进程组 + 台账硬删 + 检测调试态残留**（`[v0.0.266]` 断连接 → `[v0.0.330]` Delta 3 升级 → `[v0.0.334]` 恒检测 + 台账 delete → `[v0.0.336]` 显式回收进程组）：`close(mode='attach')` 按序执行（每步 try/catch best-effort，失败收集进 failures[]）：
  1. **断 MCP 连接**：attachDriver.disconnect（graceful client.close + transport.close kill MCP 主进程；`[v0.0.336]` 传 userDataDir 与 connect 同解析 → driver cache key 对称正常清 cache）；
  2. **杀 mcp 主进程组**：`ah.mcpPid` 已知且存活 → `killProcessGroupByPid(ah.mcpPid)`（SIGKILL 当场死，不等 SDK 4s 优雅窗）；
  3. **兜底杀 detached watchdog**：`killOrphanMcpWatchdog(ah.mcpPid)`（watchdog detached 独立进程组，killProcessGroupByPid 杀不到；按 `--parent-pid=<mcpPid>` 精确 `pkill -9 -f`，不误杀其他会话/模式 mcp；仅 POSIX，win32 跳过）；
  4. **硬删台账**：env.ledger.delete(handle.key)（`[v0.0.334]` B9，幂等）；
  5. **残留检测（只读）**：`detectChromeDebugResidual()`（见 `[P1]browser_tool.md §4.2`）——检测到调试态残留（9222 监听）→ tip 引导文本（chrome://inspect 取消 Allow remote debugging / 重启 Chrome）；检测失败降级无提示。
  - **不杀用户 Chrome / 不删目录 / 不释放端口** 语义不变；`AttachKillDeps` DI 注入（isPidAlive/killProcessGroup/execPkill，UT mock 不真杀进程）。
- **close 返回提示透传**（`[v0.0.330]` D3-A/D3-D → `[v0.0.336]` CloseResult）：`ModeImpl.close` 返回类型 `Promise<void>` → `Promise<string | void>`（`[v0.0.330]`）→ `Promise<CloseResult>`（`[v0.0.336]`）；closeInstance/close 收集 impl 返回文本，ok=true 有 text → `text` 用之，无 → 保持 'closed'；ok=false → 报 close_incomplete。releaseSession/releaseAll 同路径透传（异常路径提示不丢失）。
- **幂等**：有实例重复 close 仍幂等（impl.close 幂等兜底）；close 后同 key 再 close → 无实例报错提示先 launch（`[v0.0.330]` D-C）；已 dead 的 instance close 也走清理路径（防半清理残留）。
- **清理失败不静默（`[v0.0.336]` 升级）**：killProcessGroup / pkill / ledger.delete 等任一步 catch 后仍继续后续清理（全清），但收集进 failures[] 最终 ok=false 诚实上报（防「close 没清干净却报成功」）；用户视角收到 close_incomplete 错误而非假 closed。

### 4.4 session 结束兜底

`app/server/src/handlers/session.ts` DELETE handler（v0.0.266 起不再有 connectorManager.disconnect 兜底——attach 归 InstanceManager）：

```ts
if (deps.browserInstanceManager) await deps.browserInstanceManager.releaseSession(id).catch(...);
```

- `releaseSession(sessionId)`：kill 该 session 全部 instance（key 前缀匹配 `sessionId:`，含 attach 的 `sessionId:attach`），幂等。**mode①② 每个 instance 走与 close 相同的三要素清理**（killProcessGroup + headless rmSync + usedPorts.delete + 删记录）；**attach 走断 MCP + 杀 mcp 进程组 + watchdog 兜底 + 残留检测提示**（`[v0.0.330]` 与 close 同路径，经 closeInstance 透传 impl 文本，见 §4.3；`[v0.0.336]` 与 close 同 5 步流程 + CloseResult 诚实上报）。

### 4.5 idle timeout（配套机制，防资源泄漏）

- 默认 `BROWSER_INSTANCE_IDLE_TIMEOUT_MS = 15 * 60_000`（15 分钟，可配置）。
- **lazy check**（无后台定时器）：每次 execute 前置校验时检查 lastUsedAt 超时 → 自动 close + 返回错误提示重新 launch。简单可靠，避免常驻扫描线程。
- 显式 close 优先于 idle；session 结束兜底优先于两者。

### 4.6 服务器关闭清理（shutdown hook，MUST）

InstanceManager 挂两个 shutdown hook（对齐现有 bootstrap 模式）：
- ① 正常退出：`process.on('beforeExit', () => void releaseAll())`（对齐 channelManager/workspaceManager）
- ② 强杀：`process.on('SIGTERM'/'SIGINT', () => void releaseAll())`（对齐 squad-runtime/scheduler，**只清理不 process.exit**、trap 内吞错）
- 均用模块级标记位 `__browserInstanceManagerShutdownHookRegistered` 防重复挂载。

- `releaseAll()`：遍历全部 instance → 每个走 close 三要素清理（killProcessGroup + headless rmSync + usedPorts.delete + 删记录）→ 清空 map。
- **挂载位置**：`bootstrap-connectors-phase.ts` 装配 InstanceManager 后注册（对齐 channelManager 的 beforeExit 注册位置）。
- 兜底闭环：强杀时 async 清理若来不及（进程已被 kill）→ chrome 变孤儿 → **开机自检（§4.7）+ 对账扫描（§4.9）下次启动/周期兜底清理**。

### 4.7 开机自检 / 残留清理（MUST）

**持久化 instance 台账（`[v0.0.334]` sqlite 表替换 browser-instances.json）**：
- 库文件：`<dataDir>/browser.sqlite`（复用 `createSqlDriver`：dev=BunSqlDriver(bun:sqlite) / packaged=NodeSqlDriver(node:sqlite) / better-sqlite3 fallback——PACKAGED-GUARD 已解决双运行时，不引新依赖）。
- 表 `browser_instances`（`BrowserInstanceLedger` 构造 `CREATE TABLE IF NOT EXISTS`）：
  ```sql
  CREATE TABLE IF NOT EXISTS browser_instances (
    key TEXT PRIMARY KEY,          -- `${sessionId}:${mode}`
    mode TEXT NOT NULL,            -- headless | managed-profile | attach
    profile_name TEXT,
    user_data_dir TEXT,            -- mode①②（headless 临时目录 / managed 持久目录）
    cdp_port INTEGER,              -- mode①②
    worker_pid INTEGER NOT NULL,   -- mode①② worker 进程 / attach MCP 子进程（`[v0.0.334]`）
    chrome_pid INTEGER,            -- mode①②（`[v0.0.272]` 起）
    created_at INTEGER NOT NULL
  );
  ```
- 生命周期：launch ready → `insert`（INSERT OR REPLACE）；close / releaseSession / releaseAll / cleanupOrphan → **硬删 `delete`（DELETE 非 soft delete）**——表保持小规模；启动自检 = `listAll()` 逐条清理 → `clearAll()`（启动无合法实例，全部记录=残留，一次性清空）。
- 写失败 catch 吞错（best-effort，不阻塞主流程；对齐旧 instance-record 语义）。

**构造时自检 = 台账 + 扫描双源（`[v0.0.272]` 起 + `[v0.0.334]` 台账数据源）**：
- **① 台账源（同步）**：`ledger.listAll()` → 每条记录：① `isPidAlive(workerPid)`（process.kill(pid,0) catch ESRCH；attach 记录 workerPid=MCP 子进程 pid）② alive → `killProcessGroup(workerPid)`（清残留 chrome 树 / MCP 代理）③ headless → `rmSync(userDataDir, {recursive:true, force:true})`（managed-profile 不删用户数据）④ 硬删 `ledger.delete(key)`。`[v0.0.272]` 起 cleanupOrphan 优先精确杀 `rec.chromePid` 组（detached 独立组；负 pid 杀全家含 worker），旧记录无 chromePid 退回杀 workerPid 组。处理完 `ledger.clearAll()`（启动无合法实例，全部记录=残留，一次性清空）。
- **② 扫描源（异步 fire-and-forget）**：构造器末尾 `void this.reconcileOrphans().catch(warn)`——全量扫描 rocky marker chrome，diff 活跃集合回收孤儿（见 §4.9）。覆盖泄漏面 A「无记录孤儿」（persist 失败/异常路径）。

- **为什么安全**：服务启动时无合法 instance（纯内存态），所有持久化记录 = 上次崩溃/强杀残留 = 孤儿，一律清理；扫描源只认 rocky marker（白名单），用户主 Chrome 零接触。
- **managed-profile 的 SingletonLock 僵尸**：现有 `ensureProfileFree`（singleton-lock.ts）在 launch 时清 stale 锁（`clearStaleSingletonLocks`），无需额外动作。

### 4.8 泄漏路径对照表（全路径兜底确认）

| 泄漏类型 | 正常关闭路径 | 崩溃/强杀路径 | 兜底 |
|---|---|---|---|
| **进程**（chrome + worker 树） | close / releaseSession / releaseAll → killProcessGroup(workerPid) + `[v0.0.272]` close 末尾 chromePid 存活校验补 kill（detached 独立组） | SIGTERM/SIGINT 强杀时 async 清理来不及 → chrome 孤儿 | 开机自检 ② kill 残留（持久化记录 workerPid）+ `[v0.0.272]` 对账扫描回收无记录孤儿（§4.9） |
| **目录**（headless mkdtemp tmp） | close / releaseSession / releaseAll → rmSync(userDataDir) | 残留目录 | 开机自检 ③ 扫描记录删目录 + `[v0.0.272]` 对账扫描按孤儿 cmdline 提取 rocky userDataDir 删（rmSync 前二次验证 marker 前缀防误删） |
| **端口**（CDP 18800-18899） | close / releaseSession / releaseAll → usedPorts.delete(cdpPort) | 重启后 usedPorts 全新（内存态） | 无残留（端口随进程死自动释放；记录里 cdpPort 仅诊断用） |
| **锁**（SingletonLock） | 正常 kill → chrome 退出自动清锁 | 僵尸锁 | ensureProfileFree → clearStaleSingletonLocks（launch 时自动清） |
| **无记录孤儿**（`[v0.0.272]`） | —（persist 失败/异常路径从未入表） | 同左 | **对账扫描（§4.9）**：全量 ps 扫描 rocky marker chrome → 三层判定孤儿 → kill 组 + 删目录 + unpersist（若匹配记录） |

**结论**：进程 / 目录 / 端口 / 锁 / 无记录孤儿五类泄漏均有正常路径清理 + 崩溃路径兜底；`[v0.0.272]` 起对账扫描是进程/目录/无记录孤儿的**结构性收敛兜底**（不依赖 launch/close 绝对配对正确性）。

### 4.9 对账兜底回收（全量扫描 diff，`[v0.0.272]`）

**动机**：泄漏面 A（persist 失败/异常 → 无记录孤儿，开机自检扫不到）+ 泄漏面 B（chrome detached 独立进程组，kill(-workerPid) 杀不到）——靠 launch/close 配对无法闭环。对账模型 = **活跃 pid 集合 + 全量扫描 diff**，不在集合里的 rocky marker 孤儿一律回收。

**孤儿识别 marker 白名单（`orphan-scan.ts` isRockyChromeMarker，纯函数）**：
- 命中任一即 rocky：`rocky-browser-worker-` / `rocky-browser-instance-`（临时目录前缀）/ `et<digits>-prof`（ET playwright user-data-dir）/ `--remote-debugging-port ∈ [18800,18899]`（rocky CDP 段，cdp-port.ts 常量）。
- **白名单过滤，不是黑名单排除**——无 marker 一律 false（attach 用户 Chrome 9222 段不命中）；**绝不用进程名匹配**（用户主 Chrome 也是 chrome 名）。

**双段扫描（`scanRockyChromeProcesses`，exec 可注入）**：`ps -axo pid,ppid,command` → 返回 `ChromeScanResult { all, candidates }`——`all` = 全量进程表（建 procByPid，ppid 反查 worker-entry 第三层判定用）、`candidates` = marker chrome 候选（**只对候选判定回收**；worker-entry 进程本身无 marker 天然不在候选不被回收）。

**三层孤儿判定（`isOrphanChrome`，纯函数防误杀）**：
- ① `pid ∈ 活跃 chromePidSet` → 活跃（新实例 chromePid 精确）
- ② `ppid ∈ 活跃 workerPidSet` → 活跃（旧记录 v0.0.272 前无 chromePid 兼容）
- ③ `ppid cmdline 含 worker-entry` → 活跃（launch 中：worker 已 spawn 但 handle 未入 instances 的窗口）
- ④ 否则 → 孤儿（真孤儿 reparent 到 PPID=1 / 无 worker-entry）

**活跃集合（reconcileOrphans）**：遍历 `this.instances.values()`（**含 starting/closing 态**——launch/close 中 chrome 也算活跃，防误杀）+ 持久化记录同字段（workerPid + chromePid）。

**回收**（对每个孤儿候选）：`killProcessGroupByPid(proc.pid)`（chrome 组长负 pid 杀全家）+ 按 cmdline 提取 rocky userDataDir `rmSync`（rmSync 前二次验证 rocky marker 前缀防误删）+ 匹配记录 `ledger.delete`（`[v0.0.334]` 台账硬删）+ `console.warn` 记录 pid/ppid。单项失败 catch warn 不中断（best-effort）。

**触发时机**：
- 启动：cleanupOrphans（记录同步）+ 构造器末尾 fire-and-forget reconcileOrphans（扫描兜底，不阻塞构造）。
- 周期：`setInterval(reconcile, deps.reconcileIntervalMs ?? BROWSER_INSTANCE_RECONCILE_INTERVAL_MS)`（默认 10min）+ `unref()`（不阻塞进程退出）；`≤0` 关闭；deps 可注入（测试短间隔）。
- close 后：close 末尾统一 `isPidAlive(chromePid)` 校验补 kill（轻量，仅本 key pid，无全量扫描）——覆盖 waitExit 超时 / worker 崩溃 / 正常退出但 chrome 残留。

**chromePid 上报链路（`[v0.0.272]` 协议小改）**：worker-entry launch 确认帧 `emitLine({ok:true, text:'launched', chromePid: browser.process()?.pid ?? undefined})` → persistent-worker launchReady 透传 → WorkerHandle.chromePid + toRecord 持久化。**这是 close 兜底 + 对账精确判定的基础**；旧 worker/旧记录无 chromePid 由第②层 PPID 兼容。

**边界**：泄漏面 C（端口递增）无需额外改动——孤儿 chrome 死后端口 OS 层释放，`allocateCdpPort` isBusy 真实探测自动复用。**对账误杀是红线**：任何孤儿判定改动必须先过「不误杀用户 Chrome + 不误杀活实例」双用例再合。

## 5. API 设计

### 5.1 browser 工具 action 扩展

`BrowserAction` enum 新增两个 action（`app/server/src/tools/browser/tool.ts` definition + types）：

| action | 适用 mode | 语义 |
|--------|-----------|------|
| `launch` | headless / managed-profile / attach | 启动/复用 instance（mode①② spawn worker；attach = ChromeMcpDriver.connect，幂等复用）`[v0.0.266]` |
| `close` | headless / managed-profile / attach | 关闭 instance（mode①② 三要素清理）；attach 断 MCP + 检测调试态残留并提示（不杀用户 Chrome）`[v0.0.266]` → `[v0.0.330]` 残留检测 + 无实例报错 |

### 5.2 工具调用前置校验（用户铁律）

- **非 launch/close 的所有 action**：执行前必须通过 InstanceManager 前置校验（instance 存在 + ready）。mode①② 无 instance → `{ok:false, error:{kind:'no_browser_instance'}, text:'当前会话没有 headless/managed-profile 浏览器实例，请先调用 browser(action="launch")'}`；mode③ attach 无 instance → `text:'当前会话没有 attach 浏览器实例，请先调用 browser(action="launch", mode="attach")'`（`[v0.0.266]` attach 不再 lazy connect，前置校验统一三模式）。
- **三模式统一 execute 路由**（`[v0.0.266 T3]`）：attach 操作类 action 与 headless/managed-profile 一样走 execute（registry 分发 attach impl）；M1「execute 拒绝 attach」防御分支已下线。

### 5.3 instance 与 tool_call 匹配

- **按 session+mode 自动匹配**（不加 action 参数）：key = `sessionId:mode`（`[v0.0.330]` 三模式统一；profileName 由 handle 承载，后续 execute/close 无需重传；`[v0.0.334]` -cdpUrl）。
- managed-profile 的 profileName 仅 launch 初始化参数（handle 存首次值，复用/execute/close 均不依赖 opts.profileName）；headless 无 profileName。
- 用户意图「每 session 每 mode 最多一个」→ key 天然保证。

## 6. worker 协议改造（单次 → 循环）

### 6.1 协议

```
stdin（每行一个任务 JSON）:
  {requestId, action:'launch', launch:{executablePath, userDataDir, cdpPort, headless, persistent:true}}
  {requestId, action:'navigate'|'snapshot'|..., params:{...}}
  {requestId, action:'close'}
stdout（每行一个响应 JSON）:
  {requestId, ok:true, text} | {requestId, ok:false, error:{kind?, message}}
```

### 6.2 worker-entry.ts 改造

```
main():
  1. 读第一行（launch 任务，含 launch config）→ launchChromeAndConnect（复用 chrome-launcher.ts）
  2. emit {requestId, ok:true, text:'launched'}
  3. 循环读 stdin 行：'close' → kill chrome → emit → exit(0)；其它 → dispatchAction（跨 action 保持状态）→ emit 响应
  4. stdin end（父进程关闭）→ kill chrome → exit
```

### 6.3 跨 action 状态保持（核心收益）

- `worker-actions.ts` `dispatchAction` 现签名 `dispatchAction(browser, action, params)`，每次新建 `lastRefs = {}`（注释明言「lastRefs 跨调用重置 = pre-existing 限制」）。
- 改造：worker 内持一个**会话状态对象** `WorkerSessionState = { lastRefs, ctx?, page? }`，dispatchAction 增参 `state`，跨 action 复用。
- 效果：click/type 引用的 ref（snapshot 拿到的 `ref`）在**同 instance 内跨 tool_call 有效**——这正是「像人的浏览器」的关键体验（先 snapshot 拿 ref，再 click 那个 ref，浏览器还开着）。

### 6.4 executeOnce 兼容

- `NodeWorkerDriver.executeOnce` 保留（web_fetch 用）。worker 协议升级后它内部走同一套 spawn/launch/dispatch，但**执行完 kill + exit**（现状行为）。
- 实现建议：worker-entry 支持环境/参数区分「循环模式 vs 单次模式」——launch 任务带 `persistent:true` 时循环，否则单次。或拆两个入口函数共用 launch/action 逻辑。

## 7. 错误处理

| 场景 | 检测点 | 返回 |
|------|--------|------|
| 无 instance 调 action | execute 前置校验（assertReadyInstance，三模式共用） | `no_browser_instance` + 提示先 launch |
| launch 失败（profile_in_use / chrome 启动失败） | launch 帧 ok:false | 原样透传错误 kind |
| attach 失活（CDP 断线/chrome 被关） | attach impl execute 内 isAttachConnectionLost | `attach_lost` + 置 dead + **impl 即时清账（ledger.delete + discardInstance，best-effort 幂等）** + manager 收尾 disconnect（防御 catch）+ 提示重新 launch |
| worker 崩溃 | pending reject / 状态检测 | `worker_crashed` + 提示重新 launch |
| action 超时 | WORKER_TIMEOUT_MS | `cdp_timeout` + kill instance |
| idle 超时 | execute idle check | `idle_timeout` + 提示重新 launch |
| 其他 session 抢同 profile | SingletonLock（chrome 层）| `profile_in_use`（原样透传） |

## 8. 边界与限制（v0.0.264 + `[v0.0.266]`）

- **attach 已纳入 InstanceManager**（`[v0.0.266]`；T3 registry 重构；`[v0.0.330]` close 升级）：launch=connect / 操作经 execute 统一路由（AttachModeImpl 内 dispatch + 失活自愈 attach_lost）/ close=断 MCP + 检测调试态残留并返回引导提示（不杀用户 Chrome）；manager 零 mode 分叉、不读 handle 私有字段。ConnectorManager 瘦身为 switch 门禁 + UI 状态。
- **web_fetch 不受影响**：executeOnce 保留，一次性渲染。
- **headless 也常驻**：用户意图「每类型一个」——headless 实例 launch 后常驻（临时目录在 close/session 结束时清理）。
- **instance 纯内存态 + 台账表（`[v0.0.334]` sqlite 替换记录文件）**：运行时实例全在内存（服务重启即清，下次 launch 重建）；仅持久化 sqlite 台账 `browser_instances`（供开机自检/残留清理，非运行时状态；launch insert / close 硬删 / 启动 clearAll；attach MCP 子进程入台账）。
- **单 worker 单任务**：串行处理（一次一个 action），对齐 executeOnce 串行语义。
- **不做 cross-session 共享**：instance 严格 owner 隔离（key 含 sessionId）。

## 9. 文件级变更清单

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/tools/browser/instance-manager.ts` | 新增 | `BrowserInstanceManager` 类：instances Map + launch/execute/close/releaseSession/releaseAll + idle check + **泄漏防护四件套**（killProcessGroup / headless rmSync / usedPorts.delete / persist-unpersist 记录）+ 构造时开机自检 + beforeExit/SIGTERM/SIGINT shutdown hook |
| `app/server/src/tools/browser/instance-ledger.ts`（新，`[v0.0.334]`） | 新增 | `BrowserInstanceLedger`：sqlite 台账表 `browser_instances` 读写（建表幂等 / insert OR REPLACE / delete 硬删 / listAll / clearAll），复用 `createSqlDriver`（dev=bun:sqlite / packaged=node:sqlite）——替换 instance-record.ts 的 JSON 文件读写 |
| `app/server/src/tools/browser/worker-entry.ts` | 修改 | 单次执行器 → 循环服务：launch 后保持，循环读 stdin 任务，close/stdin-end 退出 |
| `app/server/src/tools/browser/worker-actions.ts` | 修改 | `dispatchAction` 增 `state: WorkerSessionState` 参数，lastRefs 跨调用保持 |
| `app/server/src/tools/browser/browser-worker.cjs` | 修改 | 编译产物（build 重新生成） |
| `app/server/src/tools/browser/types.ts` | 修改 | 加 `BrowserInstance`/`PersistentWorker`/`WorkerSessionState`/`BrowserLaunchOptions`/`PersistedInstanceRecord` 类型；BrowserAction enum 加 launch/close |
| `app/server/src/tools/browser/tool.ts` | 修改 | run() 增加 launch/close action 分支；headless/managed-profile action 改走 InstanceManager.execute（前置校验） |
| `app/server/src/tools/browser/node-worker-driver.ts` | 修改 | 保留 executeOnce（web_fetch）；spawn/launch 逻辑抽公共 helper 供 InstanceManager 复用 |
| `app/server/src/handlers/session.ts` | 修改 | DELETE handler 追加 `browserInstanceManager.releaseSession(id)` |
| `app/server/src/handlers/session-deps.ts` | 修改 | SessionHandlerDeps 加 `browserInstanceManager?` |
| `app/server/src/bootstrap-connectors-phase.ts` | 修改 | 装配 `BrowserInstanceManager`（注入 dataDir + spawn 依赖 + 触发开机自检）+ **注册 shutdown hook**（beforeExit + SIGTERM/SIGINT trap → releaseAll，模块级标记位防重复）+ 注入 bootstrap context + session-deps |
| `app/server/src/tools/browser/__tests__/worker-actions.test.ts` | 修改 | dispatchAction 新签名适配 |
| `app/server/src/tools/browser/__tests__/browser-tool.test.ts` | 修改 | launch/close action + 前置校验用例 |
| `app/server/src/tools/browser/__tests__/instance-manager.test.ts` | 新增 | launch 幂等 / execute 前置 / close / releaseSession / idle / **releaseAll + 端口释放 + headless 目录清理 + 开机自检残留清理** |
| `app/server/src/tools/browser/__tests__/node-worker-driver.test.ts` | 修改 | 适配 spawn helper 抽取（如有破坏） |
| **T3（v0.0.266 registry 重构）** | | |
| `app/server/src/tools/browser/mode-impl.ts`（新） | 新增 | ModeImpl 接口 + ModeImplEnv + ExecuteCtx + SnapshotSink + LaunchResult + BrowserHandle + InMemoryModeImplRegistry（headless/managed 共键 + attach 键） |
| `app/server/src/tools/browser/worker-mode-impl.ts`（新） | 新增 | WorkerModeImpl：launch（mkdtemp/resolveUserDataDir + spawn + confirm + persist）/ execute（worker 协议 + cdp_timeout + screenshot 落盘）/ close（三要素清理）/ cleanupOrphan |
| `app/server/src/tools/browser/attach-mode-impl.ts`（新） | 新增 | AttachModeImpl：launch（门禁 + connect）/ execute（dispatchAction + 失活自愈 attach_lost + screenshot 落盘）/ close（disconnect 幂等） |
| `app/server/src/tools/browser/instance-manager.ts` | 重构 | 句柄表 + registry 分发 + 状态机（<200 行）；删 getReadyInstance/handleAttachLost/attach 分支/worker 逻辑 |
| `app/server/src/tools/browser/tool.ts` | 修改 | 操作 action 统一 im.execute（零 attach 分叉）；SnapshotSink ctx 构造 |
| `app/server/src/tools/browser/tool-dispatch.ts` | 修改 | dispatchAction 返回 BrowserExecuteResult + DispatchCtx{snapshot?}；screenshot 经 ctx.snapshot 落盘 |
| `app/server/src/tools/browser/types.ts` | 修改 | 删 BrowserInstance（BrowserHandle 迁 mode-impl.ts） |
| `app/server/src/tools/browser/attach-instance.ts` | 修改 | 保留纯 helper（connect/disconnect/isAttachConnectionLost），删 hooks 相关 |
| `app/server/src/tools/browser/bootstrap-connectors-phase.ts` | 修改 | 装配 InMemoryModeImplRegistry（worker 两键 + attach）注入 manager |
| `app/server/src/tools/browser/__tests__/worker-mode-impl.test.ts`（新） | 新增 | 13 tests：launch/execute/close/cleanupOrphan 全路径 |
| `app/server/src/tools/browser/__tests__/attach-mode-impl.test.ts`（新） | 新增 | 14 tests：launch/execute 路由/失活自愈/close |
| `app/server/src/tools/browser/__tests__/instance-manager.test.ts` | 修改 | M1 改造：execute attach 拒绝 → 正确路由 attach impl |
| `app/server/src/tools/browser/__tests__/browser-tool.test.ts` | 修改 | 统一 execute 断言（attach 操作不再走 getReadyInstance/dispatchAction） |
| **T4（v0.0.272 对账兜底）** | | |
| `app/server/src/tools/browser/orphan-scan.ts`（新） | 新增 | isRockyChromeMarker（marker 白名单）/ extractUserDataDir（二次验证）/ scanRockyChromeProcesses（双段 ChromeScanResult{all,candidates}）/ isOrphanChrome（三层判定）/ buildOrphanCtx（纯函数，exec 可注入） |
| `app/server/src/tools/browser/worker-entry.ts` | 修改 | launch 确认帧加 chromePid（browser.process()?.pid ?? undefined） |
| `app/server/src/tools/browser/persistent-worker.ts` | 修改 | launchReady 透传 chromePid（BrowserExecuteResult 加 chromePid?） |
| `app/server/src/tools/browser/types.ts` | 修改 | BrowserExecuteResult / WorkerResult / PersistedInstanceRecord 加 `chromePid?: number`（optional 向后兼容） |
| `app/server/src/tools/browser/worker-mode-impl.ts` | 修改 | WorkerHandle.chromePid + close 末尾 isPidAlive(chromePid) 补 kill（detached 独立组兜底）+ cleanupOrphan chromePid 优先/旧记录 workerPid 退回 |
| `app/server/src/tools/browser/instance-record.ts` | 修改 | toRecord 持久化 chromePid（可选字段，旧记录读取不强制） |
| `app/server/src/tools/browser/instance-manager.ts` | 修改 | reconcileOrphans（活跃集合含 starting/closing + 记录 + 双段扫描 diff 回收）+ 构造器 fire-and-forget 扫描兜底 + 10min 周期 interval unref + close 后兜底；InstanceManagerDeps 加 reconcileIntervalMs?/scanProcesses? |
| `app/server/src/tools/browser/__tests__/orphan-scan.test.ts`（新） | 新增 | marker 命中/排除（用户 Chrome 9222 不命中）/ extract / 三层判定 / 双段扫描 mock |
| `app/server/src/tools/browser/__tests__/instance-manager.test.ts` | 修改 | reconcile 用例（活跃跳过/孤儿回收/旧记录 PPID 兼容/launch 中 worker-entry 保护/周期触发/close 兜底） |
| `app/server/src/tools/browser/__tests__/worker-mode-impl.test.ts` | 修改 | chromePid 存值 + close 兜底 kill chrome 断言 |
| `tests/e2e/lib/et-chrome-cleanup.sh`（新） | 新增 | ET playwright chrome 孤儿清理 lib（pgrep -f et<digits>-prof kill + /tmp/et*-prof 严格删 + _pid_cmdline_matches fallback）——env.sh 拆出守 300 行 |
| `tests/e2e/env.sh` | 修改 | _ORPHAN_MARKERS 扩充 chrome\|playwright\|remote-debugging + cmd_stop 补 _cleanup_et_chrome（顺序在 pidfile kill 后）+ 头注释/usage |

## 10. 关键设计决策

1. **不加独立 HTTP API**：launch/close 作为 browser 工具 action（LLM 直接驱动生命周期；attach 的 close = disconnect 语义，`[v0.0.266]` action 枚举去 disconnect 统一 close）。
2. **前置校验 = 非 launch/close action 一律 require instance**（用户铁律「工具调用前必须当前 session 有 chrome instance」）。
3. **instance 匹配 = session+mode 自动匹配**（key 含 sessionId，天然 owner 隔离）。
4. **idle timeout 用 lazy check**（无定时器，execute 时判断），默认 15min。
5. **worker 常驻 + 跨 action lastRefs**：click/type 的 ref 跨 tool_call 有效（同 instance 内）。
6. **NodeWorkerDriver.executeOnce 保留**（web_fetch 依赖，不破坏）。
7. **attach 纳入 InstanceManager**（`[v0.0.266]`；T3 registry 重构）：attach 与 headless/managed-profile 三模式统一 launch/close/前置校验；T3 起 attach 操作也统一走 execute（registry 路由 AttachModeImpl，impl 内 dispatch + 失活自愈 attach_lost + screenshot 落盘），零 mode 分叉；M1「execute 拒绝 attach」防御分支下线。
8. **泄漏防护闭环**：进程（killProcessGroup）/ 目录（headless rmSync）/ 端口（usedPorts.delete）/ 锁（ensureProfileFree 清僵尸）四类泄漏各有正常路径清理 + 崩溃路径兜底（shutdown hook releaseAll + 开机自检扫残留）；持久化 sqlite 台账 `browser_instances` 是残留可发现性的锚点（`[v0.0.334]` 替换 browser-instances.json，attach MCP 子进程入台账）。
