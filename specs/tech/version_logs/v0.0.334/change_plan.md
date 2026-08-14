# v0.0.334 change_plan：browser tool 简化（删 cdpUrl）+ 资源生命周期 sqlite 台账

> 架构期冻结契约。planner 按此切 task，coder 按此实现，reviewer 按此查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 上游：`reqs/[todo] v0.0.334.browser-tool-simplify-and-resource-lifecycle.md`（老板 2026-08-12 10:00-10:05 逐条拍板）。

## 调查结论（chrome-devtools-mcp 1.4.0 无法 attach 时的行为）

**源码实证**（`node_modules/.bun/chrome-devtools-mcp@1.4.0/.../build/src/`）：

1. **autoConnect 机制**（`index.js` L75-82 + `browser.js` L47-109）：传 `--autoConnect` → `ensureBrowserConnected` 走 channel 分支（`channel: serverArgs.autoConnect ? serverArgs.channel : undefined`，channel 缺省 `'stable'`）→ `connectOptions.channel = 'chrome'` → puppeteer.connect 的 channel 分支（`third_party/index.js` L67240-67260）→ `resolveDefaultUserDataDir` 定位用户 Chrome 默认 user data dir → 读 `DevToolsActivePort` 文件拿端口 + ws path → `ws://localhost:<port><path>` 连 CDP。**无任何 URL 输入，纯自动连接**。
2. **未开调试态**：DevToolsActivePort 文件不存在/为空 → puppeteer 抛 `Could not find DevToolsActivePort for chrome at <portPath>`（cause ENOENT）→ `browser.js` L109 catch 包装为 `Could not connect to Chrome. Check if Chrome is running and remote debugging is enabled by going to chrome://inspect/#remote-debugging.`（autoConnect=true 时含 inspect 引导）。
3. **版本 <144**：chrome-devtools-mcp **不检测 Chrome 版本**——`chrome://inspect/#remote-debugging` 远调模式是 144+ 才有的能力，低版本用户无法开启调试态 → DevToolsActivePort 不存在 → **与「未开调试态」落同一个错误**（`Could not connect to Chrome...`），无版本提示。
4. **用户拒绝同意 prompt / 端口半开**：DevToolsActivePort 写了但 WS 连不上 → puppeteer.connect 抛 → 同样被包装为 `Could not connect to Chrome...`。

**结论**：chrome-devtools-mcp 对「无法 attach」统一报 `Could not connect to Chrome. Check if Chrome is running and remote debugging is enabled...`——**已是明确报错 + inspect 引导**（非模糊 Could not connect）。但有两个缺口：
- **版本不足（<144）无针对性提示**——与未开调试态不可区分；
- driver 现有错误消息重复拼接引导，未利用「探测本机 Chrome 版本」做差异化提示。

**本版实现方向**：attach 失败（probe isError / 连接 catch）时**主动探测本机 Chrome 版本**（复用 chrome-discover 发现二进制 → `--version` 解析）：
- 版本存在且 **<144** → 错误消息明确「检测到 Chrome v<v>（<144），attach 需 Chrome ≥144（chrome://inspect 远调模式），请升级 Chrome 后重试」；
- 版本 **≥144 或探测失败** → 引导「确认 Chrome 已开 remote debugging（chrome://inspect/#remote-debugging → Enable remote debugging）并批准同意 prompt 后重试」。
- 该实现满足需求 2（明确报错 + 引导，含版本不足提示），且不需要改 chrome-devtools-mcp（上游包不 patch）。

## 方案总览

| Part | 内容 | 核心 |
|---|---|---|
| A | 删 cdpUrl + desc 简化 + 错误消息明确化 | attach 只支持 autoConnect；schema 删 cdpUrl；SSRF 门禁段删除；buildChromeMcpArgs 固定 `--autoConnect`；失败时版本探测差异化引导 |
| B | 资源生命周期 sqlite 台账（全资源类型） | `browser-instances.json` → sqlite 表 `browser_instances`；launch insert / close 硬删；启动按表清理残留（孤儿 MCP 代理 / playwright worker / 临时目录）；attach 的 MCP 子进程也入台账 |

**B 的设计要点**：
- **sqlite 引擎**：复用 `createSqlDriver(path)`（`persistence/search-sql-driver.ts`，dev=BunSqlDriver / packaged=NodeSqlDriver / fallback，PACKAGED-GUARD 已解决双运行时）——**不引新依赖**。路径 `join(resolveDataDir(), 'browser.sqlite')`（对齐 search.sqlite/crud.sqlite 的 PACKAGED-GUARD-2 绝对路径约定）。
- **台账类 `BrowserInstanceLedger`**（新文件 `instance-ledger.ts`）：构造建表（`CREATE TABLE IF NOT EXISTS`）；方法 `insert(rec)`（INSERT OR REPLACE）/ `delete(key)`（DELETE，硬删）/ `listAll()` / `clearAll()`；同步 API（SqlDriver prepare/exec 同步），失败 catch 记 warn（best-effort，对齐旧 instance-record 语义）。
- **表 schema**：
  ```sql
  CREATE TABLE IF NOT EXISTS browser_instances (
    key TEXT PRIMARY KEY,          -- `${sessionId}:${mode}`
    mode TEXT NOT NULL,            -- headless | managed-profile | attach
    profile_name TEXT,
    user_data_dir TEXT,            -- mode①②（headless 临时目录 / managed 持久目录）
    cdp_port INTEGER,              -- mode①②
    worker_pid INTEGER NOT NULL,   -- mode①② worker 进程 / attach MCP 子进程
    chrome_pid INTEGER,            -- mode①②
    created_at INTEGER NOT NULL
  );
  ```
- **生命周期**：launch ready → insert；close / releaseSession / releaseAll / cleanupOrphan → **硬删**（delete 非 soft delete）→ 表保持小规模；启动自检 = `listAll()` 逐条清理 → `clearAll()`（启动时无合法实例，全部记录=残留，一次性清空）。
- **attach 入台账（新增能力）**：attach 的 chrome-devtools-mcp 子进程（MCP 代理）是 server spawn 的资源，崩溃/强杀后成孤儿——`McpTransport` 暴露 `pid`（mcp-factory 从 `t._process.pid` 取，现有代码已用 `t._process` 收 stderr），connect 成功 → AttachHandle 记 pid → insert（mode=attach, worker_pid=mcpPid）；close → disconnect 后 delete；cleanupOrphan（attach 新增）→ killProcessGroupByPid(mcpPid) + delete。
- **app 退出统一回收**：沿用现有 shutdown hook（beforeExit/SIGTERM/SIGINT → releaseAll，browser_instance_manager.md §4.6）——releaseAll 经 impl.close 全路径走台账 delete，无需新 hook。
- **「锁 / 端口」无需入台账**：SingletonLock 已有 launch 时 clearStaleSingletonLocks；CDP 端口随进程死 OS 释放 + allocateCdpPort isBusy 真实探测。

## method 级变更清单

### Part A：删 cdpUrl + desc 简化 + 错误消息明确化

| # | 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|---|
| A1 | agent-tools | `app/server/src/tools/browser/tool.ts` | `BrowserInput.cdpUrl` | 删除 | interface 删 `cdpUrl?: unknown` 字段 | MUST：一并删 run() 内 SSRF 门禁段（A4）与 toLaunchOptions 传递（A5），不留死引用 | req 1 | -2 |
| A2 | agent-tools | 同上 | `inputSchema.properties.cdpUrl` | 删除 | schema 删 cdpUrl property（剩 mode/action/profileName/url/ref/text） | MUST NOT：动其他 property；MUST：desc 同步（A3） | req 1 | -8 |
| A3 | agent-tools | 同上 | `definition.description` + `mode` 字段 desc | 修改 | **desc 整体简化重写**：① attach 段明确「自动连接用户已打开的 Chrome（chrome://inspect 远调模式，**无需指定地址/URL**）」+ 前置条件（Chrome ≥144 + chrome://inspect/#remote-debugging → Enable remote debugging）+ 同意流程（launch 触发用户 Chrome 同意 prompt，需用户批准）+ 失败引导（连不上提示开启/批准/升级 Chrome）+ 共享浏览器安全警告（attach 操作的是用户真实浏览器，谨慎操作）+ close 语义（断连接+残留检测提示，不杀用户浏览器）；② **模式路由**：「我的 chrome→attach / 登录态→managed-profile / 默认→headless」；③ 删「仅当 Chrome 以 --remote-debugging-port 显式启动时才传 cdpUrl」等 cdpUrl 相关句 | MUST：不含 cdpUrl 字样；MUST：保留三模式示例 + 参数传递铁律 + 未 launch 报错提示；MUST NOT：引入新参数概念 | req 1+3；browser_tool.md §4 desc 契约 | ~15 |
| A4 | agent-tools | 同上 | `run()` SSRF 门禁段（L132-148） | 删除 | 删 cdpUrl 非 loopback → assertSsrfSafe 校验段（无 URL 输入，SSRF 面消失） | MUST：删干净（含 import assertSsrfSafe/SsrfError/isLoopbackHost——确认 web-fetch 侧无其他引用后移除）；MUST NOT：动 web-fetch/ssrf.ts 本体（isLoopbackIp 等保留，web-fetch 仍用） | req 1；browser_tool.md §5 SSRF 段删除 | -17 |
| A5 | agent-tools | 同上 | `toLaunchOptions()` | 修改 | 删 `if (mode==='attach' && typeof typed.cdpUrl==='string') opts.cdpUrl = ...`；`BrowserLaunchOptions` 不再含 cdpUrl | MUST：attach launch 不传任何连接端点（driver 固定 autoConnect） | req 1 | -2 |
| A6 | agent-tools | `app/server/src/tools/browser/chrome-mcp-driver.ts` | `buildChromeMcpArgs()` | 修改 | 入参删 `browserUrl?: string`（与 `autoConnect` deprecated 入参一并清理）；函数体固定 push `--autoConnect`，删 browserUrl→`--browserUrl`/`--wsEndpoint` 分支 | MUST：产出 flags 恒含 `--autoConnect`；MUST：同步删 connect() 调用处传 browserUrl（A7）；MUST：同步更新 UT（chrome-mcp-driver.test.ts 相关用例） | req 1；browser_tool.md §4 机制 | ~-12 |
| A7 | agent-tools | 同上 | `connect(opts)` | 修改 | `buildChromeMcpArgs({...browserUrl: opts.cdpUrl})` → `buildChromeMcpArgs({profileName, userDataDir})`；session 缓存 key 删 cdpUrl 维度（A8） | MUST：connect 入参 BrowserConnectOptions 已无 cdpUrl（A9），编译期强制 | req 1 | -2 |
| A8 | agent-tools | 同上 | `SessionCacheKey.cdpUrl` + `cacheKey()` | 修改 | 删 cdpUrl 字段；key 三元组 → 二元组 `[profileName, userDataDir]` | MUST：disconnect 用同 key（对称幂等） | req 1 | -3 |
| A9 | agent-tools | `app/server/src/tools/browser/types.ts` | `BrowserConnectOptions.cdpUrl` | 删除 | 删 `cdpUrl?: string`（mode ③ 仅 autoConnect） | MUST：同步删 BrowserLaunchOptions.cdpUrl（A10） | req 1 | -2 |
| A10 | agent-tools | 同上 | `BrowserLaunchOptions.cdpUrl` | 删除 | 删 `cdpUrl?: string` 字段 | MUST：AttachHandle 删 cdpUrl（A12） | req 1 | -2 |
| A11 | agent-tools | `app/server/src/tools/browser/attach-instance.ts` | `connectAttachSession(driver, cdpUrl?)` / `disconnectAttachSession(driver, cdpUrl?)` | 修改 | 签名删 cdpUrl 参数；`driver.connect({ cdpUrl })` → `driver.connect({})`；disconnect 同 | MUST：调用方（attach-mode-impl）同步（A12） | req 1 | -6 |
| A12 | agent-tools | `app/server/src/tools/browser/attach-mode-impl.ts` | `AttachHandle.cdpUrl` / `launch()` / `close()` | 修改 | AttachHandle 删 cdpUrl；launch 调 `connectAttachSession(env.attachDriver)`；close 调 `disconnectAttachSession(env.attachDriver)`；残留检测 `detectChromeDebugResidual(env, ah)` 不再依赖 ah.cdpUrl（A13） | MUST：attach close 恒检测调试态残留（autoConnect-only 语义） | req 1 | -6 |
| A13 | agent-tools | `app/server/src/tools/browser/attach-debug-state.ts` | `detectChromeDebugResidual(env, ah, deps)` | 修改 | 删 `if (ah.cdpUrl) return {residual:false}` 分支——autoConnect-only 后恒检测；ah 参数仅保留占位（或改 `_ah`） | MUST：行为 = 恒按默认 user data dir 检测；MUST：同步 UT（attach-debug-state 用例） | req 1；browser_tool.md §4.2 | -3 |
| A14 | agent-tools | `app/server/src/tools/browser/chrome-version.ts` | **新增** `detectChromeVersion(executablePath?): Promise<number \| undefined>` | 新增 | 复用 chrome-discover 发现 Chrome 可执行文件（未显式给时）→ `execFileSync(chromePath, ['--version'])` → 解析 `Chrome <major>.<minor>...` 首段数字；探测失败/非 chrome → undefined（不抛，best-effort） | MUST：只读探测不启动 chrome；MUST：超时/异常 catch 返 undefined 不阻断 attach 主流程 | req 2；chrome-discover.ts | ~30 |
| A15 | agent-tools | `app/server/src/tools/browser/chrome-mcp-driver.ts` | `connect()` 错误消息增强 | 修改 | probe isError / 连接 catch 两个错误消息处：先 `await detectChromeVersion()` → 版本存在且 <144 → 消息含「检测到 Chrome v<v>（<144），attach 需 Chrome ≥144（chrome://inspect 远调模式），请升级 Chrome 后重试」；≥144 或探测失败 → 现有引导（开启/批准 remote debugging）保留并去重（不再重复拼接 stderr 之外的重复引导） | MUST：版本检测失败不改变错误 kind（仍 attach_failed）；MUST：错误消息单处权威（不双拼）；MUST：引导文本含 chrome://inspect 路径 + ≥144 + 批准同意 prompt | req 2；browser_tool.md §4.1 判据真实化 | ~10 |

### Part B：资源生命周期 sqlite 台账（全资源类型）

| # | 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|---|
| B1 | agent-tools | `app/server/src/tools/browser/instance-ledger.ts` | **新增** `BrowserInstanceLedger` class | 新增 | 构造 `(driver: SqlDriver)` 建表 `browser_instances`（schema 见方案总览 B）；方法：`insert(rec)`（INSERT OR REPLACE）/ `delete(key)`（硬删）/ `listAll()` / `clearAll()`；全部同步（SqlDriver prepare/exec 同步）；失败 catch 记 warn（best-effort 不抛，对齐旧 instance-record） | MUST：delete 为硬删（DELETE 非 soft）；MUST：insert/delete 幂等；MUST：不引新依赖（复用 createSqlDriver）；MUST：单文件 ≤300 行 | req 4；browser_instance_manager.md §4.7（记录文件→台账） | ~80 |
| B2 | agent-tools | `app/server/src/tools/browser/mode-impl.ts` | `ModeImplEnv.ledger` | 新增 | env 增 `ledger: BrowserInstanceLedger`（manager 经 env 透传 impl，对齐 attachDriver 模式） | MUST：dataDir 保留（resolveUserDataDir 仍用）；MUST NOT：impl 直接 new ledger | req 4；mode-impl.ts 现有 env 结构 | +2 |
| B3 | agent-tools | `app/server/src/tools/browser/instance-manager.ts` | `InstanceManagerDeps.ledger` + `cleanupOrphans()` | 修改 | deps 增 `ledger: BrowserInstanceLedger`（必填）；`cleanupOrphans()`：`ledger.listAll()` 逐条 → `registry.get(rec.mode).cleanupOrphan?.(rec, env)` → 处理完 `ledger.clearAll()`（启动无合法实例，全清）；构造注入 env.ledger | MUST：启动自检 = 台账单一数据源（删 readPersistedInstances 依赖）；MUST：reconcileOrphans 读台账（listAll 替换 readPersistedInstances）；MUST：释放端口/删目录逻辑不变 | req 4；browser_instance_manager.md §4.7/§4.9 | ~12 |
| B4 | agent-tools | `app/server/src/tools/browser/worker-mode-impl.ts` | `launch()` / `close()` / `cleanupOrphan()` | 修改 | `persistInstance(env.dataDir, ...)` → `env.ledger.insert(rec)`；`unpersistInstance(env.dataDir, key)` → `env.ledger.delete(key)`；cleanupOrphan 末 delete；toRecord 改用台账记录形态（mode 扩展 attach 允许） | MUST：launch ready 后 insert（幂等）；close 全路径 delete（含失败路径）；MUST NOT：改 worker 协议/端口/目录语义 | req 4；browser_instance_manager.md §4.1/§4.3 | ~8 |
| B5 | agent-tools | `app/server/src/tools/browser/mcp-types.ts` | `McpTransport.pid` | 新增 | transport 接口加 `pid?: number`（MCP 子进程 pid，attach 台账锚点） | MUST：可选字段（旧 mock 不破坏） | req 4 | +2 |
| B6 | agent-tools | `app/server/src/tools/browser/mcp-factory.ts` | `wrapTransport()` | 修改 | wrapper 暴露 `pid: t._process?.pid`（现有代码已用 `t._process` 收 stderr，同源） | MUST：拿不到 pid 时 undefined（不抛）；MUST NOT：改 close 语义 | req 4 | +2 |
| B7 | agent-tools | `app/server/src/tools/browser/chrome-mcp-driver.ts` | `CachedSession` + `connect()` | 修改 | CachedSession 增 `pid?: number`（connect 成功后从 transport.pid 取）；`connect()` 返回的 BrowserSession 不变，但新增导出 `getLastMcpPid()` 或由 attach-instance 经 connect 结果取 | MUST：disconnect 时清 cache；MUST NOT：破坏 BrowserSession 协议 | req 4 | ~5 |
| B8 | agent-tools | `app/server/src/tools/browser/attach-instance.ts` | `connectAttachSession()` 返回值 | 修改 | 返回 `{ok:true, session, mcpPid?}`（driver 透传 MCP 子进程 pid）；disconnect 不变（A11 已删 cdpUrl） | MUST：pid 缺省 undefined 不阻塞 launch | req 4 | +4 |
| B9 | agent-tools | `app/server/src/tools/browser/attach-mode-impl.ts` | `launch()` / `close()` / `cleanupOrphan?` | 修改 | launch 成功后：AttachHandle 增 `mcpPid?` → `env.ledger.insert({key, mode:'attach', worker_pid: mcpPid, created_at})`（userDataDir/cdpPort 空）；close：disconnect 后 `env.ledger.delete(key)`；**新增 cleanupOrphan(rec, env)**：`killProcessGroupByPid(rec.workerPid)` + `env.ledger.delete(rec.key)`（孤儿 MCP 代理回收） | MUST：attach insert 仅 launch 成功且拿到 pid 时；MUST：close 硬删；MUST：cleanupOrphan 幂等（pid 已死 no-op） | req 4；browser_instance_manager.md §4.7（attach 纳入台账） | ~12 |
| B10 | agent-tools | `app/server/src/tools/browser/instance-record.ts` | 全文件 | 重构 | 删 `browser-instances.json` 读写（readPersistedInstances/persistInstance/unpersistInstance/INSTANCE_RECORD_FILE/instanceRecordPath）；保留 `isPidAlive` / `killProcessGroupByPid` / `errMsg` / `toRecord`（台账记录形态） | MUST：删净（无死引用）；MUST：toRecord 形态对齐 ledger insert 字段（含 attach 允许） | req 4 | ~-50 |
| B11 | agent-tools | `app/server/src/bootstrap-connectors-phase.ts` | `bootstrapConnectorsPhase()` | 修改 | 装配：`const sqlDriver = await createSqlDriver(join(resolveDataDir(), 'browser.sqlite'))` → `new BrowserInstanceLedger(sqlDriver)` → `new BrowserInstanceManager({ ..., ledger })`（deps 必填）；装配失败仍 noop fallback（不阻塞 server 启动） | MUST：createSqlDriver 复用 persistence 工厂（dev= bun:sqlite / packaged= node:sqlite）；MUST：路径走 resolveDataDir 绝对路径（PACKAGED-GUARD-2）；MUST：await 在 async bootstrap 内 | req 4；search-sql-driver.ts | ~6 |

### UT 同步

| # | 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|---|
| U1 | server test | `app/server/src/tools/browser/__tests__/chrome-mcp-driver.test.ts` | buildChromeMcpArgs / connect 用例 | 修改 | 删 browserUrl/wsEndpoint 分支用例；固定 `--autoConnect` 断言；错误消息含版本引导断言（mock detectChromeVersion） | MUST：覆盖 A6/A15 | A6/A15 | ~15 |
| U2 | server test | `app/server/src/tools/browser/__tests__/browser-tool.test.ts` | cdpUrl / SSRF 用例 | 修改 | 删 cdpUrl 入参用例 + SSRF 门禁用例；desc 断言同步（无 cdpUrl 字样） | MUST：覆盖 A1-A5 | A1-A5 | ~10 |
| U3 | server test | `app/server/src/tools/browser/__tests__/attach-mode-impl.test.ts` | launch/close 用例 | 修改 | launch 无 cdpUrl；close 恒残留检测（无显式 cdpUrl 跳过分支）；attach 台账 insert/delete 断言（mock ledger） | MUST：覆盖 A11-A13 + B9 | A11-A13/B9 | ~15 |
| U4 | server test | `app/server/src/tools/browser/__tests__/instance-manager.test.ts` | cleanupOrphans / reconcile 用例 | 修改 | 台账数据源（mock ledger listAll/clearAll 替换 readPersistedInstances）；attach cleanupOrphan 用例 | MUST：覆盖 B3/B9 | B3/B9 | ~15 |
| U5 | server test | `app/server/src/tools/browser/__tests__/instance-ledger.test.ts` | **新增** BrowserInstanceLedger 用例 | 新增 | 建表幂等 / insert OR REPLACE / delete 硬删 / listAll / clearAll / 失败吞错（mock driver 抛） | MUST：覆盖 B1 全方法 | B1 | ~40 |
| U6 | server test | `app/server/src/tools/browser/__tests__/worker-mode-impl.test.ts` | persist/unpersist 断言 | 修改 | persistInstance → env.ledger.insert 断言（mock ledger 经 env）；close 后 delete 断言 | MUST：覆盖 B4 | B4 | ~8 |
| U7 | server test | `app/server/src/tools/browser/__tests__/attach-debug-state.test.ts` | 显式 cdpUrl 跳过用例 | 修改 | 删「显式 cdpUrl → 不检测」用例（autoConnect-only 恒检测） | MUST：覆盖 A13 | A13 | ~-6 |

## 影响面评估

- **Part A 破坏性**：`browser` 工具 schema 删 `cdpUrl` 字段 + desc 重写——LLM 调用面变化（attach 不再可能传 URL）；`BrowserConnectOptions`/`BrowserLaunchOptions`/`AttachHandle`/`SessionCacheKey` 删 cdpUrl，编译期强制连锁；**SSRF 门禁段删除**（无 URL 输入，SSRF 面消失）——web-fetch/ssrf.ts 本体不动（web_fetch 仍用）。
- **Part B 破坏性**：持久化记录从 `browser-instances.json` 迁移到 sqlite 表 `browser_instances`——启动自检数据源切换；attach 首次入台账（孤儿 MCP 代理可被回收）；bootstrap 需 await createSqlDriver（async 装配，现有 async bootstrap 支持）。
- **依赖顺序**：B1（ledger）→ B2/B3/B4（manager/impl 接入）→ B11（bootstrap 装配）；A6/A7/A8（driver）→ A11/A12/A13（attach 链）→ A15（版本探测）。
- **风险点**：A15 版本探测需 chrome-discover 在 attach 失败时可用（探测失败降级为现有引导，不阻断）；B9 attach cleanupOrphan 用 killProcessGroupByPid 杀 MCP 子进程组——MCP 进程无子 chrome（attach 不 launch），单进程 kill 安全。
- **不做**（req 已知缺陷）：重启后 session 记忆幻觉（台账已删但 agent 以为有 instance）——后续版本优化，本版只保证清理干净。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
