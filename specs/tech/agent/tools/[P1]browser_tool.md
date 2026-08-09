---
type: spec
title: Browser Tool（chrome 自动化三 mode）
priority: P1
status: active
updated: 2026-08-07
since: v0.0.23
---

# Browser Tool — chrome 自动化（统一协议 + 三 mode 实现）

browser 工具：chrome 浏览器自动化。仅支持 chrome 系。**统一 `BrowserDriver`/`BrowserSession` 协议**，三 mode 各自实现：① headless ② 启动持久 profile ③ attach 已开 chrome（无需手动端口）。
体系定位见 `[P1]web_tools.md`；调研依据 `specs/research/v0.0.23-browser-use.md`。
**共同底座**：Chrome DevTools Protocol (CDP)。**驱动模型**：accessibility tree + element ref（非截图坐标）。
**驱动分裂 + 统一抽象**：①② 用 Playwright/CDP（走 node 子进程绕开 Bun bug），③ 用 chrome-devtools-mcp（MCP 协议），两栈封装在 driver 内，调用方只见 `BrowserSession` 协议层。

## 1. 概述

```
browser Tool（统一 schema: mode + action + args）
   ↓ 按 mode 选执行路径
mode①②（headless/managed-profile）── BrowserInstanceManager（v0.0.264 常驻实例：launch/execute/close）
   └─ spawn 持久 node worker（loop:true）→ 常驻循环：launch chrome → connectOverCDP → 循环 dispatch action → close/stdin-end kill
mode③（attach）── ChromeMcpDriver（chrome-devtools-mcp MCP 协议）→ connect() → BrowserSession 长会话
NodeWorkerDriver.executeOnce（v0.0.264 起仅服务 web_fetch 一次性渲染，单次执行器）
mode①② worker 内：spawn chrome → connectOverCDP → dispatch action（常驻循环保持页面/lastRefs）→ close 时 kill chrome
mode③ BrowserSession.listPages / selectPage / navigate / snapshot(a11y+ref) / click(ref) / type(ref) / evaluate / screenshot
```

| mode | BrowserDriver 实现 | 底层 | chrome 要求 | 风险 |
|---|---|---|---|---|
| ① headless | NodeWorkerDriver（ephemeral userDataDir，`headless=true`） | Playwright/CDP（**node 子进程**） | 装了即可 | 低 |
| ② managed-profile | NodeWorkerDriver（持久 userDataDir） | Playwright/CDP（**node 子进程**） | 装了即可 | 低 |
| ③ attach | ChromeMcpDriver（默认 `--autoConnect`，显式 cdpUrl 走 `--browserUrl`/`--wsEndpoint`） | chrome-devtools-mcp | **144+** + 用户开 remote debugging | 高（真实已登录 session） |

> ①② 同一 driver（NodeWorkerDriver），区别仅在 userDataDir 是否持久命名 + headless 开关。③ 独立 driver（MCP）。
> ①② 之所以走 node 子进程而非 bun 主进程直接调 playwright：Bun 运行时下 `playwright.chromium.connectOverCDP()` 永久 hang/timeout（oven-sh/bun#9357，driver stdio pipe 兼容缺陷），Node 下正常。详见 §3。

## 2. BrowserDriver 协议抽象（统一接口 · 权威）

**设计（用户决策）**：底层驱动栈分裂（Playwright CDP / chrome-devtools-mcp MCP），但**统一抽象一层协议**——browser Tool 与上层只见 `BrowserSession`，各 mode 的 driver 实现此接口，底层差异封装在 driver 内部。

```typescript
/** 浏览器驱动工厂——按 mode 产出会话或一次性结果。三 mode 各一个实现。 */
interface BrowserDriver {
  readonly mode: 'headless' | 'managed-profile' | 'attach';
  /**
   * 启动/连接（mode ③ attach 用）：spawn chrome-devtools-mcp（默认 `--autoConnect`
   * ，见 §4）→ 长会话。mode ①② 不走此方法（走 executeOnce）——
   * NodeWorkerDriver.connect() 会抛错。
   */
  connect(opts: BrowserConnectOptions, signal?: AbortSignal): Promise<BrowserSession>;
  /**
   * 一次性执行（v0.0.264 起仅 web_fetch headless render 用）：spawn node worker 子进程
   * → worker 内 connectOverCDP + dispatch 单个 action + cleanup chrome → stdout 返 {ok,text?,error?}。
   * 绕开 Bun 不支持 playwright connectOverCDP 的 bug。无跨调用状态（refs 不跨 action）。
   * browser tool 的 headless/managed-profile 不再走此方法（改走 BrowserInstanceManager 常驻实例）。
   */
  executeOnce?(opts: BrowserConnectOptions, action: string, params: BrowserActionParams, signal?: AbortSignal): Promise<{ ok: boolean; text?: string; error?: { kind?: string; message: string } }>;
}

/** 统一会话协议——所有 mode 实现同一组操作。底层（Playwright page / MCP tool）封装在实现内。 */
interface BrowserSession {
  listPages(): Promise<PageInfo[]>;                 // { id, url, selected? }
  selectPage(pageId: string): Promise<void>;
  navigate(url: string): Promise<void>;
  /** a11y snapshot + element ref（统一驱动模型，见 §6）。format 默认 'aria'。 */
  snapshot(opts?: { format?: 'aria' | 'ai' }): Promise<{ snapshot: string; refs: Record<string, RefInfo> }>;
  click(ref: string): Promise<void>;                // ref 来自 snapshot
  type(ref: string, text: string): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  screenshot?(): Promise<{ mime: string; data: Buffer }>;  // 辅助（attach/兜底 connect 路径用；impl 内经 ctx.snapshot 落盘 + 路径文本，不 inline 进上下文，见 §7）
  close(): Promise<void>;                            // mode 决定：①② 杀 chrome 进程；③ 只清 emulation 不杀用户浏览器
}

interface BrowserConnectOptions {
  profileName?: string;        // mode ②③：profile 名（持久目录 / attach 定位）
  headless?: boolean;          // mode ①②（与 profile 正交）
  cdpUrl?: string;             // mode ③ fallback（用户已手动 --remote-debugging-port）
  executablePath?: string;     // mode ①② chrome 路径（覆盖自动发现）
}
```

**关键约束**：
- `snapshot` 是统一入口——无论底层 Playwright 还是 chrome-devtools-mcp，都返回同形 `{ snapshot, refs }`（a11y tree + ref）。这是「驱动模型统一」的落点（见 §6）。
- `close` 语义按 mode 分化（①② 杀进程 / ③ 不杀）——封装在实现内，调用方不感知。
- driver 选择由 browser Tool 按 `input.mode` 路由（见 §7）。v0.0.264 起 mode①② 走 BrowserInstanceManager 常驻实例（`launch`/`execute`/`close`），mode③ 调 `connect`（长会话）；`executeOnce` 仅服务 web_fetch 一次性渲染。

## 3. NodeWorkerDriver（mode ① headless / ② managed-profile，生产用）

> **架构变更背景（BUG-001 真因）**：Bun 运行时下 `playwright.chromium.connectOverCDP()` **永久 hang/timeout**（oven-sh/bun#9357）——chrome 起来、CDP `/json/version` 就绪，但 playwright 的 WS 连接 30s 超时。三组直接验证锁定：raw WebSocket 直连 chrome CDP 正常、A/B 排除 chrome 二进制/flags、Bun vs Node 同 chrome 同端口同 playwright 决定性对比（Bun 超时 / Node 608ms 成功）。机制：playwright 通过 spawn node driver 子进程 + stdin/stdout pipe 通信，Bun 的 child_process stdio pipe 在此场景有兼容缺陷。详见 `states/v0.0.23.1/bugs/BUG-001-browser-connectovercdp-timeout-[fixed].md`。
>
> **方案（v0.0.264 起）**：mode①② 的 playwright 操作（connectOverCDP + page 操作）整体改走 **node 子进程执行器**。bun 主进程只 spawn worker + 传任务 + 读结果，绝不直接调 playwright.connectOverCDP。v0.0.264 起执行器分两种形态：
> - **常驻循环**（browser tool 的 headless/managed-profile 用）：`BrowserInstanceManager` 管理，worker 一次 launch 后循环读 stdin 任务，跨 action 保持页面/lastRefs，直到显式 close / session 结束 / idle 超时 / 崩溃（见 `[P1]browser_instance_manager.md`）。
> - **单次执行器**（web_fetch headless render 用）：`NodeWorkerDriver.executeOnce` 保留，一次任务执行完 kill chrome 退出，不引入常驻。
>
> 差异判别 = worker 协议 launch 任务的 `loop:true` 标记（InstanceManager 传；executeOnce 不传）。

### 3.1 架构（bun → node worker → chrome；v0.0.264 起双形态）

**形态 A：常驻循环（browser tool headless/managed-profile，v0.0.264 主路径）**

```
bun（BrowserInstanceManager）                    ← 见 [P1]browser_instance_manager.md
  ├─ instances: Map<key, BrowserInstance>（key = sessionId:mode[:profileName]，每 session 每类型最多一个）
  ├─ launch(sessionId, {mode, profileName}) → spawn 持久 worker（loop:true + persistent 按模式）
  ├─ execute(sessionId, opts, action, params, signal) → 前置校验（instance 存在+ready+owner+idle）→ worker.send
  ├─ close / releaseSession / releaseAll → 泄漏防护三要素清理（killProcessGroup + headless rmSync + usedPorts.delete）
  └─ 构造时开机自检（读 browser-instances.json → 清孤儿）+ shutdown hook（beforeExit/SIGTERM/SIGINT → releaseAll）
      └─ defaultSpawn(workerPath)（spawn binary 按 dev/packaged 分支，见下「packaged spawn 护栏」）
          ├─ stdin  逐行任务 JSON: {requestId, action, params}（首行 launch 含 launch config）
          ├─ worker 内（node 运行时）:
          │    launchChromeAndConnect（spawn chrome + waitForCdp + connectOverCDP，✅ Node 下正常）
          │    → emit {ok:true,'launched'}（InstanceManager 等确认帧 → state=ready）
          │    → 循环读 stdin：close → kill chrome → emit → exit(0)
          │                 其它 action → dispatchAction(browser, action, params, state) → emit 响应（不退出）
          │                 stdin end（父进程关闭）→ kill chrome → exit(0)
          └─ stdout 逐行响应 JSON: {requestId, ok:true,text?} | {requestId, ok:false,error:{kind?,message}}
```

**形态 B：单次执行器（web_fetch headless render，保留）**

```
bun（NodeWorkerDriver.executeOnce）
  └─ defaultSpawn(workerPath)（一次性，detached 进程组；workerPath = resolveWorkerPath() 双路径
       existsSync 探测：优先同目录 worker-entry.js（packaged tsc 产物），否则 browser-worker.cjs（dev bundle）；
       spawn binary 按 dev/packaged 分支，见下「packaged spawn 护栏」）
       ├─ stdin  读一行任务 JSON: {executablePath,userDataDir,cdpPort,headless,persistent,action,params}
       ├─ worker 内（node 运行时）:
       │    spawn chrome（进程组 SIGKILL，复用 chrome-launcher.launchChromeAndConnect）
       │    → waitForCdp（HTTP 200 + webSocketDebuggerUrl 非空校验）
       │    → connectOverCDP（✅ Node 下正常）
       │    → dispatchAction(单个 action)（worker-actions.ts，含 render）
       │    → killProcessGroup（chrome 整进程树清理）
       ├─ stdout 输出一行结果 JSON: {ok:true,text?} | {ok:false,error:{kind?,message}}
       └─ exit（0 成功 / 1 失败）
  └─ NodeWorkerDriver 读 stdout 第一行 → 返回 BrowserExecuteResult
     超时 30s / AbortSignal abort → killProcessGroup(child)（防 worker hang）
```

**三流分离**：stdin 任务 / stdout 结果（单行 JSON）/ stderr 诊断（失败时拼进 error.message 利排障，避免 chrome stderr 污染结果 JSON）。

**packaged spawn 护栏（`defaultSpawn`，核心设计原则）**：spawn 的 binary 按 server 运行态分支——**dev**（bun 跑 server，`process.env` 有 shell PATH）→ `spawn('node', [workerPath], { detached:true })`；**packaged Electron**（server 经 `require('@app/server')` 在 Electron 主进程进程内跑、`process.env` 干净无 PATH）→ `spawn(process.execPath, [workerPath], { env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1' }, detached:true })`，Electron 二进制 under `ELECTRON_RUN_AS_NODE=1` = 纯 node 语义跑 worker（packaged 自带永远可寻址，绕开 PATH 缺失 → 否则 `spawn node ENOENT`）。分支检测 = `process.versions.electron`（packaged 有定义 / dev undefined），args（`[workerPath]`）/ stdio 不变。属 CLAUDE.md「持续可打包护栏」③ 的标准应用（详见 memory `packaged-spawn-external-binary-exec-path`）——dev 全绿 packaged 专属崩溃，packaged 真机由用户验收。

### 3.2 设计依据：一次性执行器 → v0.0.264 常驻循环（browser tool 主路径）

**v0.0.263 及以前**：`tool.ts` 每次 `run` = `driver.executeOnce → connectOverCDP → dispatchAction(单个 action) → close`（chrome 每次启停）。worker 设计为**一次性执行器**——worker 内 spawn chrome + 1 action + cleanup，无需长连接 RPC / 会话状态保持。副作用：worker 内 `lastRefs`（snapshot 解析的 ref 表）每次新建重置 → `click`/`type` 跨 tool 调用失效（pre-existing 限制）。

**v0.0.264 起**：用户意图「浏览器像人的浏览器常驻」→ browser tool 的 headless/managed-profile 改走 **BrowserInstanceManager 常驻实例**（launch 后保持，跨 action 保持页面/登录态/lastRefs；snapshot 拿的 ref 在后续 click/type 有效）。worker 协议升级为循环服务（`loop:true` 判常驻），`NodeWorkerDriver.executeOnce` 保留仅服务 web_fetch（一次性渲染，不引入常驻）。根因分析 + 方向决策见 `[P1]browser_instance_manager.md` §1/§3 + `specs/research/browser-managed-profile-lifecycle.md`。

### 3.3 文件级实现

| 文件 | 角色 | 关键点 |
|---|---|---|
| `app/server/src/tools/browser/worker-entry.ts` | **node 侧**：任务解析 + chrome 连接/清理 + 入口编排（v0.0.264 起单次/常驻双形态） | `readTaskFromStdin()`（5s 超时防挂起）→ `launchChromeAndConnect()`；**`main()` 按 `task.loop === true` 分流**：`runPersistent`（常驻循环：emit launched 确认帧 → 循环读 stdin 行 → close/stdin-end → kill chrome → exit；`persistent` 字段仅作连接模式标记传 launchChromeAndConnect，managed-profile 才 ensureProfileFree）vs `runOnce`（单次：dispatch 一个 action → kill → emit → exit，web_fetch 用）；三流分离；模块级 `void main()` 有副作用（读 stdin/exit，UT 不能直接 import）；只依赖 chrome-launcher/worker-actions/types（可被 `bun build --target=node` 打包） |
| `app/server/src/tools/browser/worker-actions.ts` | **node 侧**：`dispatchAction` 纯函数模块（从 worker-entry.ts 拆出，无副作用可 UT） | action 集：navigate/snapshot/click/type/listPages/selectPage/evaluate/screenshot/**render**；`render` = `page.goto(url,{waitUntil:'domcontentloaded'})` → `page.content()` 返回渲染后 HTML（web_fetch headless 子分支专用——直调 `executeOnce`，不经 browser Tool inputSchema 的 action 枚举）。**v0.0.264**：签名增 `state: WorkerSessionState` 参数，`lastRefs` 由函数内新建改为 `state.lastRefs`（常驻循环下跨 action 保持——snapshot 的 ref 后续 click/type 有效）；单次调用传新建 state（行为等价旧实现） |
| `app/server/src/tools/browser/browser-worker.cjs` | **编译产物**（dev 用 bundle） | `bun build worker-entry.ts --target=node --format=cjs --external=playwright`（`bun run build:worker`）生成；避免运行时 build 依赖；node 从 cjs 位置向上找 `node_modules/playwright`。**packaged 下无此文件**（tsc 不拷 .cjs 进 dist）——packaged 由 resolveWorkerPath 命中 dist 同目录 `worker-entry.js`（见下行） |
| `app/server/src/tools/browser/node-worker-driver.ts` | **bun 侧**：`executeOnce(opts, action, params, signal)`（v0.0.264 起仅服务 web_fetch；browser tool 改走 InstanceManager） | `resolveUserDataDir`/`allocateCdpPort`/`mkdtempSync` 解析连接参数 → `defaultSpawn(resolveWorkerPath())`（cwd=worktree 根，detached 进程组；spawn binary 按 dev/packaged 分支，dev=`spawn('node')` / packaged=`spawn(process.execPath,{env:{ELECTRON_RUN_AS_NODE:'1'}})`，见 §3.1「packaged spawn 护栏」）→ stdin 写任务 JSON（**不传 loop** → worker 走单次路径）→ 读 stdout 第一行结果 → 超时/abort/exit 非 0 全捕获转 `{ok:false,error}` → finally `killProcessGroup`；`connect()` 不实现（抛错，headless/managed-profile 不走长 session）。**`resolveWorkerPath()` 双路径 existsSync 探测**：优先同目录 `worker-entry.js`（tsc 编译产物，packaged dist/ 真实命中，其 `require('./chrome-launcher'/'./worker-actions'/'./snapshot-ref'/'playwright')` 在 dist 均可解析）；不存在则退回 `browser-worker.cjs`（dev bundle，`__dirname`=src 时命中）。两者同源（worker-entry.ts），通信协议一致。v0.0.264：spawn 逻辑抽 `spawnWorker` 公共 helper 供 InstanceManager 复用 |
| `app/server/src/tools/browser/instance-manager.ts` | **bun 侧（v0.0.264 新增）**：`BrowserInstanceManager` 平台级实例管理器 | `instances: Map<key, BrowserInstance>`（key=`sessionId:mode[:profileName]`）；`launch`（幂等：ready 复用 / spawn 持久 worker + launchConfirm 20s → state=ready + persistInstance）/ `execute`（前置校验 instance 存在+ready + idle lazy check + abort 竞速）/ `close`（close 帧 → 等 exit 3s → killProcessGroup 兜底 → 三要素清理）/ `releaseSession` / `releaseAll`；构造时开机自检（读 browser-instances.json 清孤儿）+ shutdown hook（beforeExit + SIGTERM/SIGINT → releaseAll，模块级标记位幂等）。泄漏防护四要素全路径必达：killProcessGroup / headless rmSync / usedPorts.delete / unpersistInstance。详见 `[P1]browser_instance_manager.md` |
| `app/server/src/tools/browser/persistent-worker.ts` | **bun 侧（v0.0.264 新增）**：持久 worker 封装 | `createPersistentWorker` + `spawnPersistentWorker` + `launchConfirm`（launch 确认帧 resolve）+ `waitExit`（close 帧后等 worker exit）；stdout 行解析按 requestId 路由 pending；worker exit reject 全部 pending；`withAbort(signal, sendPromise, onAbort)`（abort → kill instance + 取消错误） |
| `app/server/src/tools/browser/instance-record.ts` | **bun 侧（v0.0.264 新增）**：`browser-instances.json` 持久化记录 | `readPersistedInstances()` / `persistInstance(rec)` / `unpersistInstance(key)` / `isPidAlive(pid)`（process.kill(pid,0) catch ESRCH）——同步 writeFileSync + catch 吞错（best-effort，不阻塞 launch/close） |
| `app/server/src/tools/browser/pick-driver.ts` | `InMemoryDriverRegistry` 注入 `NodeWorkerDriver`（headless/managed-profile 共用同一实例） | `InMemoryDriverRegistry({headless: nodeWorker, chromeMcp?})`；mode①② 共用同一 NodeWorkerDriver 实例（mode 在 executeOnce 时按 opts.profileName 推断）。**v0.0.264**：browser tool 不再经 driverRegistry 选 driver（改走 InstanceManager）；pick-driver 仍供 web_fetch headless render 用 |

### 3.4 复用的首轮修复（保留 + worker 复用）

首轮基于错误假设（僵尸 chrome 占固定端口）但**代码改进保留**，且被 worker-entry 复用：

1. **进程组 SIGKILL**（`chrome-launcher.killProcessGroup`）：spawn `detached:true` 建进程组，kill 用 `process.kill(-pgid,'SIGKILL')` 清整个进程树（renderer/GPU/network-service 子进程一并清），避免孤儿 chrome。
2. **per-profile CDP 端口段** 18800-18899：`allocateCdpPort` 取段内首个未占用 + `netPortBusy` 探测避让僵尸残留（不再固定 18800）。
3. **cdp-ready 增强**：launch 后轮询 `http://127.0.0.1:<port>/json/version` HTTP 200 **后校验 `webSocketDebuggerUrl` 非空**（僵尸 chrome HTTP 200 但 ws 字段空 → 继续轮询不误判）。
4. **chrome stderr 捕获**：spawn `stdio:'pipe'`，失败时拼进 errorDetail 利排障。

### 3.5 chrome 二进制发现 + 启动参数（worker-entry 复用 chrome-launcher）

**chrome 二进制发现**（三级 fallback，复刻 openclaw `chrome.executables.ts`）：1. 用户配置 `executablePath` → 2. 系统默认浏览器探测（macOS LaunchServices plist + osascript / Linux `xdg-settings` / Windows `reg query`）→ 3. 硬编码候选路径（+ Playwright 缓存）。**macOS 优先**：系统 chrome 优先于 playwright chromium（避免依赖）。**Playwright 缓存枚举**：`readdirSync(ms-playwright).filter(name => name.startsWith('chromium-'))` 列版本目录再拼路径 + `existsSync` 验证二进制（`execFileSync('ls',[glob])` 不经 shell 收到字面 glob 不展开=坏，故走 `readdirSync`）；macOS 列 `chrome-mac-arm64`/`chrome-mac` 两 arch，Linux 列 `chrome-linux/chrome`。`chrome-discover.ts` `DiscoverDeps.readdir` 注入（UT mock）。

**启动参数**（照搬 openclaw `buildOpenClawChromeLaunchArgs`）：
```
--remote-debugging-port=<port> --user-data-dir=<dir>
--no-first-run --no-default-browser-check --disable-sync --disable-background-networking
--disable-component-update --password-store=basic
--headless=new --disable-gpu          (headless 时，Chrome 109+ 新无头)
--no-sandbox (按需) --disable-dev-shm-usage (linux)
```
**Linux 无 `$DISPLAY`/`$WAYLAND_DISPLAY` → 强制 headless**。

### 3.6 mode ② 持久 profile（登录态复用，核心需求）

- profile 目录：`~/.rocky_agent/browser/<profileName>/user-data`（chrome `--user-data-dir` 指向它，cookie/localStorage/登录态/扩展/历史 持久保留，同名 profile 复用 = 复用登录态）。
- profile 命名 `/^[a-z0-9][a-z0-9-]*$/` ≤64；多 profile 由 config `browser.profiles.<name>` map + `browser.defaultProfile`。
- **CDP 端口段** 18800-18899（见 §3.4(2)）。**持久化进 profile config**（跨进程稳定）仍由 connectors 任务接入。
- **SingletonLock（必须做）**：同一持久 profile 不能被两 chrome 进程同时开。读锁解析持锁 pid → 清僵尸锁（进程已死）→ "profile in use" 检测报错+重试（复刻 openclaw `readSingletonLockTarget`/`clearStaleChromeSingletonLocks`）。**占用冲突策略**：报错 + 提示用户，不抢锁不排队。

### 3.7 旧 PlaywrightDriver 路径（保留逻辑，不用于生产）

`playwright-driver.ts` / `playwright-session.ts` / `chrome-launcher.ts` 的 bun 侧 `connectOverCDP` 路径**不再用于生产**（Bun 下永久 hang）——但代码保留：UT 仍可用、worker-entry 复用其 launch/dispatch 逻辑。`tool.ts` 仅当 driver 未实现 `executeOnce` 时兜底走旧 `connect/dispatch/close`（兼容旧 mock driver UT）。

> **关联**：`web_fetch` 工具 local fetcher 的 headless 子分支同样走本 driver——`web-fetch/tool.ts:buildHeadlessRenderer` 从 `browserDriverRegistry` 取 headless driver，检测 `executeOnce` 并调 `executeOnce({headless:true}, 'render', {url}, signal)`（worker `render` action：goto waitUntil:domcontentloaded → `page.content()` 返回渲染 HTML），与 browser tool mode①② 共用同一 NodeWorkerDriver 一次性模型，不走 connect 长 session。契约详见 `[P1]web_fetch_tool.md` §3.3/§6.5。

## 4. ChromeMcpDriver（mode ③ attach，无需手动端口）

> **前置门禁（`[v0.0.46]` lazy connect + 门禁分层 → `[v0.0.266]` 纳入 InstanceManager → T3 registry 重构）**：attach 模式的**连接建立/释放全部由 BrowserInstanceManager 管理**（`launch(mode='attach', cdpUrl?)` = ChromeMcpDriver.connect，key=`sessionId:attach` 幂等复用；`close(mode='attach')` = attachDriver.disconnect 不杀用户 chrome）。用户须先在「连接器 → 浏览器」开启开关（`switch=on`），bootstrap 把共享 attachDriver 单例 + `isAttachEnabled`（读 switch）注入 InstanceManager（经 ModeImplEnv 透传 AttachModeImpl）。操作类 action 统一走 `execute`（registry 路由 AttachModeImpl，impl 内 dispatchAction + screenshot 经 ctx.snapshot 落盘）；CDP 断线失活 → impl 内文本检测 `isAttachConnectionLost` → 置 handle.state=dead + 返回 `attach_lost` → manager 收尾 close（disconnect + 删条目）→ 下次 `no_browser_instance` 引导重新 launch。`switch=off` → `not_enabled` 引导错误；连接失败 → `attach_failed`（沿用 `[v0.0.34]` 失败即停）。ConnectorManager 瘦身为「switch 门禁 + UI 状态」（enable/disable/bootstrap/getState/getAll/isReady），不再持有 attach session/owner。详见 `specs/tech/config/[P1]connectors.md` §5/§6 + `specs/tech/agent/tools/[P1]browser_instance_manager.md` §3.3/§4。

**机制（复刻 openclaw + 治理 + ）**：spawn 官方 npm 包 `chrome-devtools-mcp` 作 stdio MCP server，**attach 默认走 `--autoConnect`**（chrome 144+ chrome://inspect 远调模式唯一可用——该模式不暴露 `/json/version`，`--browserUrl` 在主路径必失败）。用户显式给 cdpUrl 时走 `--browserUrl`/`--wsEndpoint`（用户自负 chrome 端点契约）。不扫端口、不用 native messaging、不用扩展。
```
node <chrome-devtools-mcp bin 绝对路径> --autoConnect [--userDataDir <dir>]
  --experimentalStructuredContent --experimental-page-id-routing
→ StdioClientTransport 连 stdio → handshake
→ listTools 校验含 list_pages（快速失败）
→ **真跑一次 list_pages round-trip（client.callTool）确认已 attach 上目标 chrome（判据真实化）**
```
> command 解析见 `resolveChromeMcpLaunch()`（chrome-mcp-driver.ts，BUG-003）：`require.resolve` 拿 chrome-devtools-mcp bin 绝对路径 → node 直连本地 bin（避免 npx 冷下载 + registry 查询）；resolve 失败兜底 `npx -y chrome-devtools-mcp`（packaged 下 npx 不可用，兜底保持现状）。**packaged Electron 适配**（与 §3.1 NodeWorkerDriver `defaultSpawn` 同款护栏）：`process.versions.electron` 为真 → `{command: process.execPath, baseArgs:[binAbs], env:{ELECTRON_RUN_AS_NODE:'1'}}`（Electron 二进制 under `ELECTRON_RUN_AS_NODE=1` = 纯 node 语义跑 MCP server，绕开 packaged 主进程无 PATH → 裸 `node` spawn ENOENT）；dev 保持 `{command:'node', baseArgs:[binAbs]}` 不回归。env 透传链：`connect()` → `StdioTransportOptions.env`（mcp-types.ts）→ mcp-factory `createStdioTransport`（env 仅有值时传入，dev 走 SDK 默认环境）→ MCP SDK `StdioClientTransport`（内部与默认环境 merge）。上为示意 flags。

### 4.1 connect 治理 （判据真实化 + 失败清理 + 默认 autoConnect）

**根因（BUG-009 判据虚假，仍生效）**：chrome-devtools-mcp **惰性连接**——`ensureBrowserConnected`（puppeteer.connect）只在首个 page 工具调用时触发（index.js getContext 经 ToolHandler.handle 调），handshake/listTools 阶段根本不碰 chrome。故旧判据「handshake && listTools 含 list_pages」恒过（不开 chrome 也 100% 通过），测的是「MCP 进程起没起」而非「attach 没 attach 上」。

**关于 BUG-008 自启（autoConnect 副作用）**：曾试图把默认从 `--autoConnect` 改为 `--browserUrl http://127.0.0.1:9222` 禁止自启，**真机失败**——chrome 144+ chrome://inspect 远调模式（本 spec §4 主路径用户操作）**不暴露 HTTP `/json/version`**（返 404 是正常的；chrome-devtools-mcp `--browserUrl` 实现去拉 `/json/version` 拿 webSocketDebuggerUrl → 在该模式必失败 `Failed to fetch ... HTTP Not Found`），故默认回退到 `--autoConnect`。**autoConnect "没开 chrome 时自启空 chrome" 的副作用承认存在**——治理2 list_pages probe 虽连得上自启 chrome 返回成功，但 connect 后 agent 操作仍会因没有用户真实 tab 暴露问题（比旧 handshake 判据严格）。彻底根治自启需 chrome-devtools-mcp 上游支持「connect-only 不 launch」flag，列为 upstream 跟进，不在本版范围。

**治理动作**：
1. **判据真实化**：`connect()` listTools 校验后**真跑一次 `client.callTool({name:'list_pages',arguments:{}})`**——`result.isError` 为真（chrome-devtools-mcp 连不上返 `{isError:true, content:[{text:'Could not connect to Chrome...'}]}`，**不抛**，故须查 isError）→ 抛 `attach_failed`。两道判据递进：listTools=快速失败，list_pages round-trip=真实性确认（对齐 openclaw `pageReady`）。
2. **失败清理**：connect 失败（含 probe 失败）catch 抽 helper `closeMcpClientThenTransport`——先 `client.close()`（graceful 释放 CDP attach）再 `transport.close()`（kill MCP 进程兜底），对齐 disconnect（BUG-007），不留 orphan。
3. **默认 `--autoConnect` **：`buildChromeMcpArgs` 默认 push `--autoConnect`（chrome 144+ inspect 模式唯一可用）。`DEFAULT_ATTACH_CDP_URL` 常量及 `autoConnect:boolean` 入参保留以兼容 UT + 未来若 chrome 重新暴露 `/json/version` 可切换。用户显式 cdpUrl（http→`--browserUrl` / ws→`--wsEndpoint`）行为不变（用户自负 chrome 端点契约：必须能提供 `/json/version` 或 WS endpoint）。

> **设计教训**：改 attach 连接方式前必须用最小脚本测真 chrome 主路径（用户已开 + remote debugging on）；不能只测反面场景（没开 chrome 时不自启）而漏测主路径——曾因此让用户挂掉。证据：`states/v0.0.29/diag-attach.mjs`（早已证 chrome 144+ /json/version 返 404 正常，应早被参考）。

**BrowserSession 实现 = MCP tool 映射**：`listPages`→`list_pages`、`selectPage`→`select_page`、`navigate`→`navigate_page`、`snapshot`→`snapshot`、`click`→`click`、`type`→`type`、`evaluate`→`evaluate_script`。

**用户操作（chrome 144+ remote debugging）**：① 打开 `chrome://inspect/#remote-debugging`（Brave/Edge 对应 brave/edge）；② Enable remote debugging；③ chrome **144+**；④ 批准 attach 同意 prompt。 rocky 默认走 `--autoConnect`（chrome 144+ inspect 模式不暴露 `/json/version`，无法用 `--browserUrl`）；若 chrome 启动时显式 `--remote-debugging-port=9222` 并暴露 `/json/version`，可经 `cdpUrl` 显式指定走 `--browserUrl`。连不上 chrome-devtools-mcp 抛 "Could not connect to Chrome. Check if Chrome is running and remote debugging is enabled..." 引导用户。

**target 解析（ 默认 autoConnect，cdpUrl 为显式覆盖）**：`opts.cdpUrl` 缺省 → `--autoConnect`（chrome 144+ inspect 模式唯一可用）；显式 cdpUrl（http→`--browserUrl` / ws→`--wsEndpoint`）覆盖默认。**userDataDir 透传**：attach Brave/Edge 等非默认 profile 时必需。**session 缓存** key=`[profileName,userDataDir,cdpUrl]`（两次缺省 connect 同 key，复用同一 loopback session）。**触发方（`[v0.0.266]`）**：`launch(mode='attach')` 经 InstanceManager 注入的 attachDriver 调 `connectAttachSession`（attach-instance.ts），不再由 ConnectorManager lazy connect。**错误归类**：匹配 "Could not connect / DevToolsActivePort / ECONNREFUSED / Failed to connect" → `attach_failed`（**不自动重连**，失败收敛见 `connectors.md` §3.3）；handshake ~30s。**close**：`close(mode='attach')` → `disconnectAttachSession`（attachDriver.disconnect），只清 MCP 连接不杀用户浏览器。

## 5. 生命周期 / 安全

- **生命周期**：跟踪每 session 开的 tab，session 结束按 sessionKey 关 agent 开的 tab（attach 模式不杀浏览器）。配 idle 扫描清僵尸 tab（参考 openclaw `browser-lifecycle-cleanup.ts` + `browser.tabCleanup`）。
- **孤儿 chrome 对账回收（`[v0.0.272]`，mode①② worker-based）**：chrome 泄漏（崩溃/强杀/异常路径残留）由 `BrowserInstanceManager.reconcileOrphans` 结构性收敛——marker 白名单识别 rocky chrome（`rocky-browser-worker-`/`rocky-browser-instance-`/`et<digits>-prof`/CDP 18800-18899 段，绝不用进程名匹配）+ 双段扫描（all 全量进程表 + candidates marker chrome）+ 三层判定（pid∈活跃 chromePidSet / ppid∈活跃 workerPidSet / ppid cmdline 含 worker-entry → 活跃，否则孤儿）+ 回收（kill 组 + 删 rocky userDataDir + unpersist + warn）。触发 = 启动 fire-and-forget + 10min 周期 setInterval unref + close 后 isPidAlive 校验补 kill。**用户主 Chrome 零接触**（attach 模式 close=disconnect 不杀浏览器，对账只认 rocky marker）。详 `browser_instance_manager.md §4.9` + `orphan-scan.ts`。
- **SSRF（attach cdp，两层语义 ）**：参考 openclaw `cdp-reachability-policy.ts` 注释原文「The browser SSRF policy protects page/network navigation, not ... local CDP control plane」——CDP 控制面 ≠ 页面导航 SSRF。
  - **本地 loopback 豁免**：`cdpUrl` host = `127.x`（127/8 全段）/ `::1` / `localhost` → **不做** SSRF（attach 本机 chrome 是正常用法，不该自我拦截）。对应 openclaw `resolveCdpReachabilityPolicy`：`cdpIsLoopback && !isRemote → return undefined`。
  - **非 loopback 仍 fail-closed**：远程私网（10.x / 192.168.x / 172.16-31.x）、link-local 云元数据（169.254.169.254）、`file://` → 走 `assertSsrfSafe` 拒绝（防内网穿透 + 云元数据 SSRF）。
  - **实现**：`app/server/src/tools/web-fetch/ssrf.ts` 新增 `isLoopbackIp(ip)` / `isLoopbackHost(url)`（127/8 + ::1 + hostname=localhost；**纯字面量比对，不 DNS 解析**——防 DNS rebinding 把公网域名解析到 127/8 绕过）；`app/server/src/tools/browser/tool.ts:106-115` 门禁 `!isLoopbackHost(cdpUrl)` 才 `assertSsrfSafe`。
  - **根因（BUG-001）**：旧实现把 web-fetch 的 blanket `assertSsrfSafe`（IP 私网黑名单）套到 attach cdpUrl，127.0.0.1 被当私网拒。loopback CDP 不消费页面导航，本就不在 SSRF 边界内。
  - **附带 follow-up（BUG-002，pre-existing）**：`isPrivateIp`/`isLoopbackIp` 用 regex `::ffff:([0-9.]+)$` 只认 IPv4-mapped **点分形式**，hex 压缩形（URL 规范化后 `::ffff:a00:5`）不匹配 → 非 loopback 私网可绕过。`isLoopbackIp` 的同款 gap 零影响（hex/点分殊途同归到「放行」）。根因修（统一 IPv6 normalize）见 BUG-002，非本版范围。
- **attach 鉴权**：单机本地单用户场景**不做** token 鉴权（control server 不强制 auth）；多用户/远程场景后续再加。
- **反检测**：**不做**（hermes camofox 路线复杂易失效，openclaw 也不做）。

## 6. 驱动模型：a11y tree + element ref（统一）

- `snapshot()` 统一返回 `{ snapshot: string, refs: Record<id,{role,name,nth}> }`；`click`/`type` 按 ref 定位（精度高、token 省、不需 vision 二次定位）。无论底层 Playwright 还是 chrome-devtools-mcp，**协议层同形**。
- 截图（`screenshot?`）作**辅助**，tool_result 永远是**路径文本**（v0.0.157 起，dispatchAction 拦截 `{mime, data:Buffer}` → `saveSnapshot` 落盘 → `textResult(formatSnapshotText)`；主上下文永不 inline image，INV-157-1）。多模态模型按需调 `see_image({imagePaths:['snapshots/<id>.png']})` 看图。
- **截图+坐标（computer-use 路线，已决策）**：**本版本不支持**（P2 再说），主用 a11y+ref。

## 7. browser Tool 层（v0.0.266：attach 纳入 InstanceManager，三模式统一前置校验）

```typescript
const browserTool: Tool = {
  definition: { name: 'browser', description: 'Automate Chrome: headless / persistent-profile / attach modes.',
    inputSchema: { type:'object', required:['mode','action'],
      properties: { mode:{enum:['headless','managed-profile','attach']},
        action:{ enum:['launch','navigate','snapshot','click','type','listPages','selectPage',
                       'evaluate','screenshot','close'] },   // [v0.0.266] -disconnect（统一 close：attach close = 断 MCP 连接不杀 chrome）
        profileName:{type:'string'}, url:{type:'string'}, ref:{type:'string'}, text:{type:'string'}, /* ... */ } } },
  needsApproval(input, ctx) { return input.mode === 'attach'; },   // attach 操作真实浏览器 → HITL

  async run(input, ctx) {
    const im = instanceManager ?? ctx.config.browserInstanceManager;
    if (!im) {
      return errorResult('browser: browser instance manager 未注册（三模式均不可用）');
    }
    const launchOpts = toLaunchOptions(input, input.mode);   // { mode, profileName?, cdpUrl? }
    if (input.action === 'launch') {
      // 三模式统一：headless/managed-profile spawn worker；attach = ChromeMcpDriver.connect（幂等复用）
      return toToolResult(await im.launch(ctx.config.sessionId, launchOpts));
    }
    if (input.action === 'close') {
      // 三模式统一 close：mode①② 三要素清理；attach = disconnectAttachSession（不杀用户 chrome）
      return toToolResult(await im.close(ctx.config.sessionId, launchOpts));
    }
    // [v0.0.266 T3] 操作类 action 三模式统一走 execute（registry 路由 impl，零 mode 分叉）。
    // attach 不再单独走 getReadyInstance + tool.ts dispatchAction（attach impl 内部 dispatch + 失活自愈）。
    const params = extractActionParams(input.action, input);
    const r = await im.execute(ctx.config.sessionId, launchOpts, input.action, params, {
      signal: ctx.signal,
      snapshot: { save: (data, mediaType) => saveSnapshot({ workdir: ctx.workdir, toolCallId: ctx.toolCallId, data, mediaType }).then((x) => ({ relPath: x.relPath })) },
    });
    if (!r.ok) return errorResult(formatExecuteError(r));   // no_browser_instance / idle_timeout / worker_crashed / cdp_timeout / attach_lost
    return textResult(r.text ?? '');   // screenshot 落盘在 impl 内经 ctx.snapshot，结果已是路径文本
  },
};
```
> `[v0.0.46]` `ctx.config.sessionId` 由 session-config 构造期注入（已存在字段，见 `tools/types.ts` `ToolSessionConfigLike.sessionId`）。[v0.0.266 T3] attach 实例建立/断开/失活清理下沉 AttachModeImpl（attach-instance.ts 纯 helper）；browser tool 层只做「launch/close/execute 三入口 + SnapshotSink ctx 构造」——零 attach 分叉。
>
> **[v0.0.264 + v0.0.266 + T3] 工具调用前置校验（用户铁律「工具调用前必须当前 session 有 chrome instance」）**：非 launch/close 的所有 action（navigate/snapshot/click/type/listPages/selectPage/evaluate/screenshot），执行前必须经 InstanceManager 前置校验——instance 存在 + ready（assertReadyInstance，三模式共用）。无 instance → `{ok:false, error:{kind:'no_browser_instance'}, text:'当前会话没有 {mode} 浏览器实例，请先调用 browser(action="launch")'}`（attach 不再隐式 lazy connect；T3 起 attach 与 headless/managed-profile 统一走 execute）。instance 匹配 = session+mode[:profileName] 自动匹配（key 含 sessionId，owner 天然隔离，跨 session 不可复用）。
>
> **[v0.0.157 + T3] 截图落盘（下沉 impl）**：screenshot 落盘统一经 `ExecuteCtx.snapshot: SnapshotSink`——tool.ts 构造闭包（绑 `ctx.workdir` + `ctx.toolCallId`，调 `saveSnapshot`），impl 内落盘：worker（`r.text` JSON parse → decode base64 → `ctx.snapshot.save`）、attach（`session.screenshot()` Buffer 直交）。impl 返回路径文本（`formatSnapshotText({relPath, source:'browser'})`），tool.ts 只透传。`ctx.workdir` + `ctx.toolCallId` 必透传（落盘命名用）。

## 8. 已锁定决策（用户/AFK）

| 项 | 决策 |
|---|---|
| ★ attach 驱动分裂 | **接受**（MCP + Playwright 两栈）+ **抽象 BrowserDriver/BrowserSession 统一协议**（用户） |
| 反检测（camofox） | 不做 |
| 截图+坐标（computer-use） | 本版本不支持（P2） |
| profile 占用冲突 | 报错+提示，不抢锁/排队 |
| 多 profile 上限 / 端口段 | 100 / 18800-18899 |
| attach 鉴权 | 单机本地不做 |
| 远程 chrome attach | 支持 cdpUrl fallback + SSRF 校验（本地 loopback cdpUrl 豁免 SSRF——CDP 控制面 ≠ 页面导航；仅非 loopback 远程/私网 fail-closed） |
| chrome-devtools-mcp 版本 | `@latest`（跟官方，openclaw 默认） |

> 其余实现细节（chrome 发现各平台具体路径、SingletonLock 恢复算法、CDP 就绪轮询参数）在编码阶段按调研报告 `v0.0.23-browser-use.md` 关键代码索引实现。

## 9. 共性约定（见 `[P1]web_tools.md` §2）

代理（chrome 下载等走 undici）/ 超时（ctx.signal）/ 审批（attach 模式 HITL）/ 截断（snapshot 超大走 context offload）。

## 10. 边界

| 零件 | 归属 |
|---|---|
| BrowserDriver/BrowserSession 协议抽象（含 executeOnce）+ 三 mode driver 设计 + a11y/ref 模型 + 已锁决策 | 本文 ✅ |
| **BrowserInstanceManager**（v0.0.264 常驻实例管理：launch/execute/close/releaseSession/releaseAll + 泄漏防护 + 开机自检 + shutdown hook） | `[P1]browser_instance_manager.md` ✅ |
| NodeWorkerDriver（mode①②，node worker 子进程 + worker-entry.ts（v0.0.264 双形态：常驻循环 loop:true / 单次）+ worker-actions.ts（dispatchAction 含 render，v0.0.264 增 state 参数）+ persistent-worker.ts + instance-record.ts + browser-worker.cjs + resolveWorkerPath 双路径探测）+ ChromeMcpDriver（mode③ 默认 `--autoConnect` + list_pages 判据，§4.1）实现 | 编码阶段（已落地） |
| 共性约定（代理/截断/审批/超时） | `[P1]web_tools.md` §2 |
| 串行执行 + ToolResultBlock + 审批 | `tool_execution_engine.md` |

## 11. 依赖

| mode | chromium 二进制 | 说明 |
|---|---|---|
| ① headless | **需要** | PlaywrightDriver 用 playwright 的 chromium（macOS `~/Library/Caches/ms-playwright/chromium-XXXX/`） |
| ② managed-profile | **需要** | 同 ① |
| ③ attach | **不需要** | 用用户自己的 chrome（≥144，开 remote debugging），不走 playwright chromium |

- **自动安装**：根 `package.json` 配了 `postinstall` 脚本——`bun install` 后自动 `playwright install chromium` 拉取浏览器二进制到 `ms-playwright` 缓存。
- **非致命**：postinstall 失败（离线/受限环境）**不阻断** install，仅打印 skip 提示。此时 mode ①② 不可用，mode ③ 仍可用。
- **手动补装**：`bunx playwright install chromium`。
- **错误引导**：mode ①② launch 时若检测到 chromium 缺失特征（`Executable doesn't exist` / `browserType.launch` / `chromium not found`），`BrowserError('launch_failed')` 的 message 会追加 `chromium 未安装，请运行 bunx playwright install chromium`（见 `chrome-launcher.ts` `withChromiumHint()`）。
- **系统 chrome fallback**：mode ①② 在 macOS/Linux 也会优先探测系统已装 chrome（LaunchServices/xdg-settings/硬编码候选），找到则用系统 chrome（此时不需要 playwright chromium）。仅当系统无 chrome 且 playwright chromium 也缺时才报 launch_failed。

> 变更历史见 `log.md`（本 KB 位置轴）+ `specs/tech/version_logs/vX.Y/change_log.md`（跨版本发布说明）。
