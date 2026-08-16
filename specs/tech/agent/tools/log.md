---
type: log
title: Tools KB 变更记录
updated: 2026-08-15
---

# Tools KB 变更记录（ISO 倒序，最新在前）

## 2026-08-15 · v0.0.361（todo 工具接 reminder queue — 增量变化行写侧投递）

- **`[P1]todo_tools.md`**：§6 新增 reminder queue 接线段——各写 action 成功后 `ReminderQueueStore.write(sid, 'todo:{itemId}', 已渲染行)`，写失败 catch 吞（best-effort 不阻断工具返回），per-call new 实例；消费侧 incremental 轮 `queueDrain`；frontmatter `updated`。

## 2026-08-15 · v0.0.354（engine 增量回调 onResult — 多 tool 结果逐个 SSE 推送）

- **`[P0]tool_execution_engine.md`**：§3 引擎接口 `execute` 签名补第 4 参 `opts?: ExecuteRunCtx`（`onResult?: (result, index) => void` 增量结果回调——每个 result push 同时立即调用，不等整批；7 条产出路径全覆盖；回调抛错 fail-silent；不传=零行为变化）；§4 串行流程伪代码 `pushResult` helper 化（push + try/catch 调回调），`for...of` → indexed loop。
- **消费方**：`agent-loop-stage-tool.ts executeAndEmit`（emit/span 逐个化，见 agent_interface_and_loop KB 同日条目）。
- 详情：`specs/tech/version_logs/v0.0.354/change_log.md`

## 2026-08-13 · v0.0.345（撤 worker pool + 工具层 fs.promises 真异步）

- **`[P0]tool_execution_engine.md`**：§1 串行段删「单工具执行可经 worker pool 挪线程（白名单纯 IO 工具走 worker_threads 线程池）」改「工具一律在主线程执行（v0.0.345 撤 worker pool 后无线程池分流）；工具层 fs 操作一律 fs.promises 真异步（libuv 线程池），批内串行顺序不变」；§6「不并发执行」条同步；§7 零件表 worker 线程池行（含三路径探测 + readSet 跨 worker apply 描述）改为「工具在主线程串行执行 + fs.promises 真异步（历史 worker 线程池沿革见 v0.0.307/v0.0.345 change_log）」。
- **`[P0]file_op_tools.md`**：新增 **§7 工具层 fs 操作标准**（v0.0.345 起生效：IO 调用一律 node:fs/promises + await；persistence 层存量 sync 路径用 fs-yield 兜底不强制迁移；禁止工具层新增 sync fs，例外仅子进程类 spawnSync('rg')；write/edit 落盘走 atomicWriteAsync 与 atomicWriteSync 并存）；原 §7 边界顺延 §8 并补标准归属行。
- 详情：`specs/tech/version_logs/v0.0.345/change_log.md`（撤 worker pool + 五工具 fs.promises + atomicWriteAsync + 标准沉淀 + 实现偏差）

## 2026-08-13 · v0.0.309（readSet 快照传入 spec 补同步）

- **`[P0]tool_execution_engine.md` §7 零件表**：worker 行补「readSet 跨 worker apply」的快照传入机制——submit 端 `engine-worker-dispatch.ts` 传 `Array.from(ctx.readSet)` 序列化、worker 端 `worker-entry.ts` `new Set(req.readSet)` 初始化局部副本，增量经 `readSetAdditions` 回主线程统一 apply（D5 防跨 worker readSet 断裂）。v0.0.309 编码期实现此前未落 spec，本次补记。

## 2026-08-12 · v0.0.337（attach launch 失败/超时 mcp+watchdog 残留修复 H1-H9）

- **`[P1]browser_instance_manager.md`**：文件头补 `[v0.0.337]` 注记；§4.1 attach launch 补**失败路径三层一致**——H7 manager.launch `ctx?:{signal?}` 透传 + H4 connectAttachSession signal + H5 driver `lastSpawnPid`（spawn 即记，成功失败都记，disconnect 清；与 lastMcpPid 仅成功 set 语义区分）+ H3 signal abort → attach_failed 走 catch + H2 connect catch 补 kill 进程组 + watchdog（graceful close → kill 组 → watchdog，win32 跳过 best-effort）+ **H9 失败入台账**（`r.spawnPid !== undefined` → `ledger.insert({key, mode:'attach', workerPid: spawnPid, createdAt})`，**insert 不 delete** 留给启动自检 cleanupOrphan 回收；下次成功 INSERT OR REPLACE 覆盖；insert 失败 warn 不阻断）。
- **`[P1]browser_tool.md`**：§4.1 治理动作 2「失败清理」升级三层一致（`[v0.0.337]` H2 补 killProcessGroup + killOrphanMcpWatchdog，顺序 graceful close → kill 组 → watchdog）；target 解析补 **launch 失败/超时清理**（signal 沿 manager.launch ctx → impl.launch → connectAttachSession → driver.connect 透传；**tool.ts 仅 launch 分支透传 ctx.signal，close 不透传**——清理动作必须完整执行）+ **spawn 锚点语义**（lastSpawnPid vs lastMcpPid）。
- **`specs/api/overall/08-web-tools.md`**：§4.3 attach 连接失败行补失败清理说明（driver 内部清进程组+watchdog，失败入台账留给启动自检）；版本尾注 +1.8。
- **`specs/tech/version_logs/v0.0.337.attach_launch_failure_leak/`**：change_log.md 新增（H1-H9 实现核对 + 偏离记录：H3 withAbort 替代 Promise.race + signal 为函数签名参数非 options 字段 + H2 watchdog 无 isPidAlive 守卫）。
- 详情：`specs/tech/version_logs/v0.0.337.attach_launch_failure_leak/change_plan.md` + `change_log.md`

## 2026-08-12 · v0.0.336（attach close 三层一致 + cache key 对称）

- **`[P1]browser_instance_manager.md`**：文件头补 `[v0.0.336]` 注记；§4.3 close 契约重写——**CloseResult 结构化返回**（`{ok:true,text?}` / `{ok:false,error}`）+ **三层一致**（真实资源层 mcp 进程组 + watchdog / 记录层 driver cache + sqlite 台账 / 感知层不谎报，任一失败 ok=false 诚实上报）+ **closeInstance 失败不删表可重试** + execute/idle 收尾防御 catch；attach close 5 步流程（断 MCP（传 userDataDir 对称清 cache）→ killProcessGroup(mcpPid) → killOrphanMcpWatchdog（--parent-pid 精确 pkill）→ ledger.delete → 残留检测）+ AttachKillDeps DI；「清理失败不静默」从「记 warn 仍返回 ok」升级为「收集 failures 最终 ok=false」。
- **`[P1]browser_tool.md`**：§4.1 target 解析补 cache key 对称（disconnect 与 connect 同一 `resolveDefaultChromeUserDataDir` 解析）+ close 链补 killProcessGroup + killOrphanMcpWatchdog + CloseResult；§4.2 接入段 close 返回类型 `Promise<string | void>` → `Promise<CloseResult>`。
- **`specs/api/overall/08-web-tools.md`**：§4.2 close 行补 close_incomplete；§4.3 isError 分支新增「close 清理失败 `[v0.0.336]`」行（kind='close_incomplete'，不删表可重试）；生命周期语义补 mcp 进程组 + watchdog 回收 + cache key 对称；版本尾注 +1.7。
- **`specs/tech/version_logs/v0.0.336.attach_close_process_leak/change_plan.md`**：G3 标注**已砍**（编码期裁决：G1/G2 修 key 对称后死连接复用路径已根除，cache hit 只剩本 run 合法幂等复用，加探活收益低开销高）+ 决策记录。
- 详情：`specs/tech/version_logs/v0.0.336.attach_close_process_leak/change_log.md`（G1/G2/G4/G5/G6 实现核对 + G3 已砍 + CloseResult 三层一致偏离记录 + cache key 对称根因修正）

## 2026-08-12 · v0.0.334（browser tool 简化 — 删 cdpUrl + 资源生命周期 sqlite 台账）

- **`[P1]browser_tool.md`**：§1 三 mode 表 attach 行改「固定 `--autoConnect`，`[v0.0.334]` 删 cdpUrl，仅自动连接」；§2 BrowserConnectOptions 删 cdpUrl；§4 机制改「恒走 `--autoConnect`，删 cdpUrl 参数/`--browserUrl`/`--wsEndpoint` 分支」+ **新增「无法 attach 明确报错」调查结论**（chrome-devtools-mcp 1.4.0 源码实证：统一报 `Could not connect to Chrome...`，未开调试态=DevToolsActivePort 缺失、<144 无独立检测 → 实现 = connect 失败时探测本机 Chrome 版本差异化引导，新增 `chrome-version.ts`）；§4.1 target 解析改「仅 autoConnect」+ session 缓存 key 二元组 + close 恒检测残留（删显式 cdpUrl 跳过分支）；§4.2 判据改 autoConnect-only 恒检测；**§5 SSRF 段改「`[v0.0.334]` 已删——attach 无 URL 输入」**（web-fetch/ssrf.ts 本体保留）；§7 tool 层 schema 删 cdpUrl + desc 简化（自动连接 + 前置条件 + 同意流程 + 失败引导 + 共享浏览器安全警告 + 模式路由）；§8 锁定决策「远程 chrome attach 不做」；frontmatter updated。
- **`[P1]browser_instance_manager.md`**：文件头 + §1 现状 + §2 概念（AttachHandle -cdpUrl +mcpPid）+ §3.2 AttachHandle 数据结构 + §3.3 attach 段落 + §4.1 attach launch（仅 autoConnect + mcpPid + ledger.insert）+ §4.3 close（台账硬删 + 恒检测残留）+ **§4.7 持久化改 sqlite 台账**（`browser.sqlite` + 表 `browser_instances` schema + launch insert / close 硬删 / 启动 clearAll）+ §4.9 对账回收 ledger.delete + §5.3 instance 匹配 -cdpUrl + §8 边界（台账替换记录文件）+ §9 文件清单（instance-ledger.ts 新增替换 instance-record.ts）+ §10 泄漏防护闭环（台账锚点）。
- **`specs/api/overall/08-web-tools.md`**：§4.1 ToolDefinition 删 cdpUrl + §4.1 字段表删 cdpUrl 行（补 `[v0.0.334]` 说明）+ §4.3 isError 分支删 SSRF 两行 + attach 连接失败行补版本引导 + 生命周期语义段补 sqlite 台账；版本尾注 +1.6。
- **`specs/tech/config/[P1]connectors.md`**：§6 attach launch 注释删 cdpUrl（仅 autoConnect）。
- 详情：`specs/tech/version_logs/v0.0.334/change_plan.md` + `change_log.md`

## 2026-08-12 · v0.0.330（browser attach 修复 — 缺省 autoConnect + instanceKey 收敛 + close 残留检测）

- **`[P1]browser_tool.md`**：§4 前置门禁 + §4.1 治理动作（`DEFAULT_ATTACH_CDP_URL` 常量已删——attach 缺省 cdpUrl 原样传 undefined 走 `--autoConnect`，不再塞 127.0.0.1:9222）+ target 解析 close 语义；**新增 §4.2 attach close 调试态残留检测**（能力边界实证 + `attach-debug-state.ts` 检测模块 + `ModeImpl.close` 返回类型 `Promise<string|void>` + closeInstance 透传 + `scripts/cleanup-chrome-debug.sh` 一次性清理指引 + desc 契约）；§7 前置校验 instance 匹配改 `sessionId:mode` 统一 key；§3.3 browser-worker.cjs 行补 `[v0.0.330]` 构建机制（gitignore + run-dev.sh/env_start.sh 启动 build:worker）；§10 边界表加 attach-debug-state.ts + cleanup 脚本；frontmatter updated 2026-08-12。
- **`[P1]browser_instance_manager.md`**：文件头 + §2 概念（BrowserHandle key=`sessionId:mode` 三模式统一，profileName/cdpUrl 不进 key；owner 门禁同步）+ §3.2 数据结构 key 注释；§4.1 attach launch 注释（缺省 undefined → autoConnect）+ mode①② key/reuse 文本（handle 存首次 profileName）+ 幂等语义（同 session 同 mode 重复 launch 复用不换 profile）；**§4.3 close 重写**（无实例 → `no_browser_instance` 报错提示先 launch；attach close = 断 MCP + 残留检测提示；impl.close 提示文本透传至 text；幂等语义更新）；§4.4 releaseSession attach 同路径；§5.1 close action 语义 + §5.3 instance 匹配（session+mode 自动匹配）。
- **代码↔spec 偏离核实（3 项 Minor 边界，落 change_log）**：① releaseSession/releaseAll 的 close 提示文本无出口（API 为 void），仅 `close()` 有 text 出口——U8 测试已改名对齐；② `attach-debug-state.ts` 检测仅覆盖默认 user data dir（非默认目录 Chrome 漏报——保守方向，不误报优先）；③ instance-manager.ts 行数微超 300 推荐线（既有累积）。
- 详情：`specs/tech/version_logs/v0.0.330/change_plan.md` + `change_log.md`

## 2026-08-07 · v0.0.272（Chrome 孤儿进程对账回收 — marker 白名单 + 三层判定 + 双段扫描）

- **`[P1]browser_instance_manager.md`**：§3.1 总览 + §3.2 WorkerHandle 加 chromePid 字段；§4.1 launch 确认帧携带 chromePid；§4.6 兜底闭环加对账扫描；**§4.7 开机自检改「记录 + 扫描双源」**（记录源 cleanupOrphans 同步 + 扫描源构造器末尾 fire-and-forget reconcileOrphans 覆盖无记录孤儿；cleanupOrphan chromePid 优先/旧记录 workerPid 退回）；**§4.8 泄漏路径对照表补「无记录孤儿」行**（进程/目录行加 v0.0.272 对账兜底）；**新增 §4.9 对账兜底回收（全量扫描 diff）**——marker 白名单（isRockyChromeMarker：rocky-browser-worker-/rocky-browser-instance-/et<digits>-prof/CDP 18800-18899 段，白名单非黑名单，绝不用进程名匹配）/ 双段扫描（ChromeScanResult{all,candidates}）/ 三层判定（①pid∈chromePidSet ②ppid∈workerPidSet ③ppid cmdline 含 worker-entry → 活跃，否则孤儿）/ 活跃集合含 starting/closing / 回收（kill 组 + rmSync rocky userDataDir 二次验证 + unpersist + warn）/ 触发（启动 + 10min 周期 unref + close 后 isPidAlive 补 kill）/ chromePid 上报链路（worker-entry 确认帧 → launchReady 透传 → toRecord 持久化）；§9 文件级变更清单追加 T4（v0.0.272 对账兜底）行。
- **`[P1]browser_tool.md §5`**：进程生命周期补孤儿 chrome 对账回收说明（marker 白名单 + 双段扫描 + 三层判定 + 触发时机 + 用户主 Chrome 零接触），frontmatter updated 2026-08-07。
- **代码↔spec 偏离核实（doc-modifier 阶段 5，6 项）**：① marker 白名单不误杀用户 Chrome（attach 9222 不命中，白名单过滤非黑名单）✅ ② 活跃表含 starting/closing（instances.values() 全量 + 持久化记录）✅ ③ 三层判定（chromePidSet / workerPidSet / worker-entry ppid 反查）✅ ④ detached 进程组 kill（close 末尾 isPidAlive(chromePid) 补 killProcessGroupByPid 负 pid 杀全家；cleanupOrphan chromePid 优先旧记录退回 workerPid）✅ ⑤ ET 端口段隔离（ET API 43xxx/WEB 45xxx/CDP 46xxx，_ORPHAN_MARKERS 只在 ET 段内用）✅ ⑥ /tmp 严格模式（et-chrome-cleanup.sh `^et[0-9]+-prof 正则双验证 + return 0 防护）✅。**偏离记录**：① T2 清理函数拆 `tests/e2e/lib/et-chrome-cleanup.sh`（coversFiles 外新增——env.sh 297 基线 + 预计 312 超 300 硬约束，拆 lib 守拆分精神，MUST 约束全保持）；② close 兜底改为 close 末尾统一 isPidAlive 校验（不依赖 waitExit 超时判断，覆盖更全）；③ cleanupOrphan chromePid 精确杀组（旧记录退回 workerPid）。
- 详情：`specs/tech/version_logs/v0.0.272/change_plan.md` + `change_log.md`；BUG `states/bugs/BUG-chrome-orphan-process-leak-[open].md`

## 2026-08-06 · v0.0.264（Browser Instance Manager — 常驻实例 + 前置校验 + 泄漏防护）

- **`[P1]browser_instance_manager.md`（新增）**：session 级浏览器实例管理架构文档——问题定义（一次性执行器根因 vs 用户「像人的浏览器常驻」期望）/ 概念（BrowserInstance / BrowserInstanceManager / 持久 worker / owner 门禁）/ 架构（launch/execute/close/releaseSession/releaseAll + 开机自检 + shutdown hook）/ 生命周期（launch 幂等 / action 前置校验 + idle lazy check / close 三要素清理 / session 兜底 / idle 15min / shutdown hook / 开机自检）/ API（launch/close action + 前置校验铁律）/ worker 协议（单次 → 循环）/ 错误处理（no_browser_instance / worker_crashed / cdp_timeout / idle_timeout / profile_in_use）/ 边界（attach 不动、web_fetch 不受影响、headless 也常驻、instance 纯内存 + 记录文件）/ 泄漏防护对照表（进程/目录/端口/锁四类双保险）。
- **`[P1]browser_tool.md §1/§2/§3/§7/§10`**：mode①② 从「NodeWorkerDriver.executeOnce 一次性执行器」改为「BrowserInstanceManager 常驻实例」（v0.0.264 主路径）——§1 概述图更新为三执行路径（mode①② InstanceManager 常驻 / mode③ attach connect / executeOnce 仅 web_fetch）；§2 executeOnce 注释标「仅 web_fetch 用」；§3 方案段分双形态（常驻循环 loop:true vs 单次执行器）、§3.1 架构图加形态 A（InstanceManager 常驻循环）/形态 B（executeOnce 单次）、§3.2 设计依据改「一次性 → v0.0.264 常驻循环」、§3.3 文件级实现加 instance-manager.ts/persistent-worker.ts/instance-record.ts + worker-entry 双形态描述 + worker-actions state 参数 + node-worker-driver spawnWorker 抽取 + pick-driver 仅 web_fetch；§7 工具 API 加 launch/close action + 前置校验铁律（非 launch/close 必须经 InstanceManager 校验，无 instance → no_browser_instance 提示先 launch）+ run() 代码更新（attach 分支保留，非 attach 走 im.launch/execute/close，无 im fail-closed 报「未注册」）；§10 边界表加 BrowserInstanceManager 归属行。
- **代码↔spec 偏离核实**：`tool.ts`（action enum 加 launch/close；attach 分支零改动；非 attach launch/close/execute 全走 im；无 im → errorResult「未注册」；screenshot 拦截保留；createBrowserTool deps 增 instanceManager?）/ `types.ts`（BrowserInstance/PersistentWorker/WorkerSessionState/PersistedInstanceRecord/BrowserLaunchOptions 类型齐全）/ `instance-manager.ts`（launch 幂等 + spawnPersistentWorker + launchConfirm 20s + persistInstance 仅确认后写；execute 前置校验 + idle lazy check + abort 竞速 withAbort + cdp_timeout/worker_crashed 分类；close/releaseSession/releaseAll 共用 closeInstance 三要素清理；cleanupOrphans 开机自检；registerShutdownHooks 模块级标记位幂等；300 行压线）/ `worker-entry.ts`（main() 按 `task.loop === true` 分流 runPersistent/runOnce；persistent 保留连接模式标记；close/stdin-end kill chrome exit）/ `worker-actions.ts`（dispatchAction 增 state 参数，lastRefs 跨 action 保持）/ `node-worker-driver.ts`（executeOnce 保留 web_fetch，spawnWorker 抽取）/ `persistent-worker.ts`（launchConfirm/waitExit/withAbort）/ `instance-record.ts`（read/persist/unpersist/isPidAlive）/ `session.ts` DELETE releaseSession 兜底 / `bootstrap-connectors-phase.ts`（new BrowserInstanceManager({dataDir}) 构造即自检 + noop fallback）/ session-deps + session-config + tools-types 注入链路——均与 change_plan/设计文档一致，无静默偏离。
- 详情：`specs/tech/version_logs/v0.0.264/change_plan.md` + `change_log.md`

## 2026-08-05 · v0.0.260（browser attach packaged Electron spawn — execPath + ELECTRON_RUN_AS_NODE）

- **`[P1]browser_tool.md §4`**：`resolveChromeMcpLaunch()` 说明扩写——补 packaged Electron 分支：`process.versions.electron` 为真 → `{command:process.execPath, baseArgs:[binAbs], env:{ELECTRON_RUN_AS_NODE:'1'}}`（Electron 二进制纯 node 语义跑 MCP server，绕开 packaged 无 PATH → 裸 `node` spawn ENOENT），与 §3.1 NodeWorkerDriver `defaultSpawn` 同款护栏；dev 保持 `{command:'node'}` 不回归；npx 兜底在 packaged 不可用保持现状。同条补 env 透传链：`connect()` → `StdioTransportOptions.env`（mcp-types.ts）→ mcp-factory `createStdioTransport`（env 仅有值时传入）→ SDK `StdioClientTransport` 内部 merge。
- **`[P1]browser_tool.md §1 表格 / §2 注释`**：两处「attach 默认 `--browserUrl` loopback」过期描述修正为「默认 `--autoConnect`」（与 §4/§4.1 及 `buildChromeMcpArgs` 一致——chrome 144+ inspect 模式不暴露 `/json/version`，`--browserUrl` 主路径必失败）。
- **代码↔spec 偏离核实**：`chrome-mcp-driver.ts:279-298 resolveChromeMcpLaunch`（electron 分支 + npx 兜底）/ `:103-113 connect`（launch.env 透传 mcpFactory.create）/ `mcp-factory.ts:120-128 createStdioTransport`（`...(opts.env ? {env: opts.env} : {})`，dev 走 SDK 默认环境）/ `:243-258 buildChromeMcpArgs`（无 browserUrl → `--autoConnect`）与 spec 一致；无静默偏离。

## 2026-08-03 · v0.0.246（spawn D8 inherit 改用 parent resolved model + providerId 从 client.getInfo 取）

- **`[P1]agent_tools.md`**：本文不重复 D8 resolution 伪码（指向 `[P1]subagent_derivation.md §4` + `[P1]subagent_templates.md §4`），本次仅实现层 parentModelId/providerId 来源调整，本文 schema/可见性章节无改动。
- **代码↔spec 偏离核实**：`agent-tool.ts:211-216 runSpawn` 注释 `[v0.0.246]` 标 D8 inherit 改 resolved——调 `resolveConfigBySid(parentSid)` 取 `parentConfig.modelId` + `parentConfig.client.getInfo().providerId`（**providerId 偏离 change_plan**：原写 `parentConfig.providerId`，但 `SessionConfig`（context-types.ts:88）顶层无 providerId 字段——providerId 是 resolver 局部变量只挂在 `client.getInfo()` 上，故从 client 取；详见 version_logs/v0.0.246/change_log.md）；`spawn-action.ts:113-116` createChildSession childConfig 透传 `providerId: ctx.parentProviderId`（+注释「resolved，非 raw hint」）；`agent-tool.ts:298/315/329 createChildSessionImpl` childConfig 入参类型加 `providerId?` + 落库 `providerId: input.childConfig.providerId`（替代旧 `parent?.providerId` raw）+ 注释明「getSession 仍读 parent 取 biz/role/squadId/workspaceDir（非 model 维度，保留）」。`template-loader.ts:92` 不改（parentModelId 现已是 resolved，`template?.modelId ?? parentModelId` D8 语义自然成立）。
- 详情：`specs/tech/version_logs/v0.0.246/change_plan.md` + `change_log.md`

## 2026-08-01 · v0.0.236（bash spawn EBADF — escaped-grandchild fd 回收 + spawn errno 透出）

- **`[P0]bash_tools.md §4.6`（新增）**：escaped-grandchild pipe fd 回收机制——孙子进程 `setsid`/double-fork 脱离进程组后，组杀（§4.5 detached）打不到它，它继承 child stdout/stderr pipe 写端且存活 → `close` 永不触发 → pipe 读端 fd +2/run 永久钉死（repro 实测累积到 EMFILE）。新增 `wireChildLifecycle.reclaimStreams()` helper（destroy child stdout/stderr 读端 fd），**解耦 fd 回收与孙子生死**；仅在 SIGKILL 兜底后调（不动 close 正常路径、不动 SIGTERM 优雅窗口）；双收益 = fd 立即释放 + close 正常触发（promise 不 hang）；try/catch+`?.` 幂等。`child.unref()` 防 event loop 被 close 永不触发的 child 拖住 hang。
- **`[P0]bash_tools.md §4.6`（spawn errno 透出）**：原 `child.on('error',()=>finish(1))` 吞 errno → 现透 `(err as NodeJS.ErrnoException)?.code` 进 `ShellResult.spawnErrno?`（§4.1 接口加可选字段）；close 正常路径 `finish(code??1, undefined)`；`bash.ts run()` 非零退出分支在 spawnErrno 存在时前置 `[RUNTIME_ERROR] spawn <errno>` 文本。真机一跑即可区分 EBADF/EMFILE/ENOENT/EACCES。type 用 `string`（errno 是 POSIX 开放集，非 union）。
- **`[P0]bash_tools.md §4.1`**：`ShellResult` 加可选 `spawnErrno?: string` 字段。§3 边界表加一行「escaped-grandchild pipe fd 回收 + spawn errno 透出 → §4.6」。
- **代码↔spec 偏离核实**：`bash-engine.ts:35`（spawnErrno 可选字段）/ `:132/137`（finish 签名+resolve 携带）/ `:152-159`（reclaimStreams try/catch+`?.`）/ `:165-168`（SIGKILL 后调 reclaimStreams + unref，不动 close L186）/ `:185`（error 透 errno）/ `:186`（close undefined）；`bash.ts:109/138/142`（spawnErrno 前置 RUNTIME_ERROR 文本）与 spec 一致；无静默偏离。
- 详情：`specs/tech/version_logs/v0.0.236/change_plan.md` + `change_log.md`

## 2026-08-01 · v0.0.234（defaultSpawn packaged 分支 — browser worker spawn node ENOENT 修复）

- **`[P1]browser_tool.md §3.1`**：ASCII spawn 行从 `spawn node <workerPath>` 改述为 `defaultSpawn(workerPath)`，并在「三流分离」段后新增核心设计原则段「packaged spawn 护栏」——记 `defaultSpawn` 按 `process.versions.electron` 分支：dev（bun 跑 server，PATH 有 node）→ `spawn('node')`；packaged Electron（server 经 `require('@app/server')` 在主进程进程内跑、`process.env` 无 PATH）→ `spawn(process.execPath, { env:{...,'ELECTRON_RUN_AS_NODE':'1'}, detached:true })`（Electron binary under ELECTRON_RUN_AS_NODE=1 = 纯 node 语义，packaged 自带永远可寻址，绕开 PATH 缺失）。属 CLAUDE.md「持续可打包护栏」③ 标准应用（memory `packaged-spawn-external-binary-exec-path`），dev 全绿 packaged 专属崩溃。
- **`[P1]browser_tool.md §3.3`**：`node-worker-driver.ts` 行 spawn 描述从 `spawn node <resolveWorkerPath()>` 改述为 `defaultSpawn(resolveWorkerPath())` + 内联 dev/packaged 两分支 binary + 指向 §3.1「packaged spawn 护栏」（resolveWorkerPath 双路径描述不变）。
- **代码↔spec 偏离核实**：`node-worker-driver.ts:261 defaultSpawn`（process.versions.electron 分支 + ELECTRON_RUN_AS_NODE=1 + detached:true）/ `runWorker:135` 调 `this.spawnFn('node',[workerPath])`（spawnFn=opts.spawnDeps?.spawn ?? defaultSpawn）/ `resolveWorkerPath:286` 双路径与 spec 一致；§3.3 worker-entry.js 4 require（chrome-launcher/worker-actions/snapshot-ref/playwright）= transitive 闭包核实无误（worker-entry.ts 直接 import chrome-launcher+worker-actions+types；snapshot-ref/playwright 经 worker-actions/chrome-launcher 传递）。无静默偏离。
- 详情：`specs/tech/version_logs/v0.0.234/change_plan.md`

## 2026-07-31 · v0.0.228（TodoStore emit 注入 — todo SSE 实时化）

- **`[P1]todo_tools.md §4`**：`TodoStoreDeps.statusBus?: ReplayableEventBus`（optional 构造注入，bootstrap 传 wrap 前 raw sessionStatusBus）；写成功后私有 `emitChanged(sid)` 发 `session_todo_changed`。
- **`[P1]todo_tools.md §7`**：HTTP 段落「polling 兜底 / SSE 归 follow-up」改为 SSE 已落地（store 层单点 emit 覆盖 agent 工具 + HTTP handler 两条写路径；前端 60s 轮询退役）。
- **drift 修正（doc-modifier）**：§2.1 `TodoItem.source/output` + §3 add_item 入参改为 optional——代码（todo-tool / todo-handler / TodoItem interface）自 v0.0.223 起即接受省略，spec 写必填是 v0.0.223 遗留偏差。
- **代码↔spec 偏离核实**：todo-store.ts（三写方法 emit 位置 / 三不原则 / removeAll 不 emit）与 spec 一致；无静默偏离。
- 详情：`specs/tech/version_logs/v0.0.228/change_plan.md` + `change_log.md`

## 2026-07-30 · v0.0.225（chrome-discover readdirSync + jina 超时放宽 20→28s + headless err 真实透出）

- **`[P1]browser_tool.md §3.5`**：补 Playwright 缓存枚举机制——`chrome-discover.ts:listChromiumDirs` 用 `readdirSync(ms-playwright).filter(name => name.startsWith('chromium-'))` 列版本目录 + 拼路径 `existsSync` 验证（原 `execFileSync('ls',[glob])` 不经 shell 收到字面 glob 不展开=坏）；macOS 列 `chrome-mac-arm64`/`chrome-mac` 两 arch，Linux 列 `chrome-linux/chrome`。`DiscoverDeps.readdir` 注入字段（UT mock）。三级 fallback 顺序不变。
- **`[P1]web_fetch_tool.md §3.2/§7`**：jina 默认超时 `DEFAULT_JINA_TIMEOUT_MS` 20s→28s（≤ race 总超时 `OVERALL_TIMEOUT_MS` 30s 留 2s 余量；原 20s 对大页不够）。§3.2 构造注 `jinaTimeoutMs~20s`→`~28s` + 关键注补 28s 由来；§7 共性约定 `jina ~20s`→`~28s`。
- **`[P1]web_fetch_tool.md §3.3`**：headless 渲染器抛错时捕获真实 message（`chrome_not_found`/worker stderr/等）拼进 `FetchResult.err`（非笼统「headless 渲染失败」）。§3.3 伪码补 `fetchHeadless` try/catch + `headlessReason` 透出；关键注补 `HeadlessOutcome.err` 字段承载。headless 触发条件（静态不足才起）+ 契约不变。
- **代码↔spec 偏离核实**：`chrome-discover.ts`（`listChromiumDirs` readdirSync + `DiscoverDeps.readdir`）/ `jina-fetcher.ts`（`DEFAULT_JINA_TIMEOUT_MS=28_000` + 注释 28s 由来）/ `local-fetcher.ts`（`HeadlessOutcome.err` + `fetchHeadless` catch 透出 `e.message`）三处与 spec 一致；无静默偏离。
- 详情：`specs/tech/version_logs/v0.0.225/change_plan.md`（3 行）+ `change_log.md`

## 2026-07-30 · v0.0.223 新增 todo 工具（session 级双层待办，与 task 拆开）

- **新建 `[P1]todo_tools.md`**：todo = 当前 session 手头双层待办（主 item source/output/memo + 步骤；5 态 free-form 状态机仅校验 enum），session 级、持久化、agent 自主维护；**todo ≠ task**（task=squad 团队跨 session 工作项）。action-based dispatch 7 action（add_item/update_item/add_step/update_step/delete_item/list/cleanup_finished），无角色/无 DAG/CAS；独立 store `<DATA_DIR>/sessions/<sid>/todos.json`（仿 cron-adapter，resolveDataDir 展开）；HTTP 7 端点（`specs/api/overall/20-todo.md`）。
- **注册**：`registry.ts defaultTools()` 加 todoTool（taskTool 后，默认集 26→30 口径刷新，index.md ③ 同步）；profile.toolBound 写 `todo` 于全部 7 个 `*.parent.main`（studio×3 + academy×3 + playground-rocky 经 default.yaml 继承）；subagent/forked/consolidate/summary 不绑。
- **配套**：todo reminder 填壳（`reminder/todo.ts`，标头 `[todo]`，parent.main only）+ ReminderCtx 扩展 `todoStore`（见 `../context/log.md` 同版本条目）；HTTP 写操作返小对象 `{itemId}`/`{itemId,stepId}`/`{id,deleted}`/`{removed}`，完整 item 走 GET。
- **代码↔spec 偏离核实（doc-modifier 阶段 5）**：todo-tool.ts 7 action / todo-store.ts（185 行）/ todo-handler.ts 响应契约 / bootstrap todoStore 三处接线（含 `bootstrap-agent-phase.ts` rtc.sessionDeps 注入，review C-1 修复）与 spec 一致；无静默偏离。
- 详情：`specs/tech/version_logs/v0.0.223/change_plan.md`（A/B/H 节）

## 2026-07-30 · v0.0.224（web_fetch 全挂修复 — lookup options.all / headless 接回 executeOnce / packaged worker 路径 / error.log）

- **`[P1]web_fetch_tool.md`**：§3.3 headless 生产实现从「PlaywrightDriver connect 长 session」改述为「`tool.ts buildHeadlessRenderer` 检测 `driver.executeOnce` → NodeWorkerDriver `executeOnce({headless:true},'render',{url})` 一次性渲染」（headlessRenderer 契约 `(url,signal)=>Promise<string>` 不变；无 executeOnce → undefined 优雅降级）；§6.5/§3.5 清理表/§8/§1 管线同步。§3.1 `FetchResult` 加可选 `err` 字段（fetcher 失败原因观测）。§3.4 race runner 加 `options.onFailure`——两路皆空（AggregateError）归集 `[{fetcher,reason}]` 同步透出（观测用途）。§2 run 三类失败路径写 `LogWriter('error')`（`writeWebFetchErrorLog`：url/stage∈ssrf|race/reason/failures?；鸭子类型 `ctx.config.logWriter`，`enableErrorLog` 开关在 LogWriter 内部，缺省 no-op，日志失败静默）。§4 `createPinnedDispatcher` lookup 兼容 undici `options.all` 形态（all→`cb(null,[{address,family}])`，缺此 Node runtime 抛 `Invalid IP address: undefined`）。§9 陈旧「v1.2→v1.3 重写清单」（引用已不存在的 fetch-content.ts）替换为当前文件清单。顺带对齐 §3.1 `FetchContext`={url}（signal 构造注入后 fetch 不再传 signal，代码实际如此）。
- **`[P1]browser_tool.md`**：§3.1/§3.3/§10 `resolveWorkerPath()` 双路径 existsSync 探测（优先同目录 `worker-entry.js`——tsc 产物 packaged dist/ 命中；否则 `browser-worker.cjs` dev bundle；原 packaged dist 无 .cjs → spawn ENOENT，browser 工具在 prod 连带坏，本版本顺带修复）。§3.3 新增 `worker-actions.ts` 行（`dispatchAction` 从 worker-entry.ts 拆出为无副作用纯函数模块可 UT，worker-entry 模块级 `void main()` 有副作用不能 import；含新 `render` action：`page.goto(url,{waitUntil:'load'})` → `page.content()` 返渲染 HTML——web_fetch headless 专用，直调 executeOnce，不经 browser Tool inputSchema 枚举）。§3.7 关联注从「web_fetch headless 不在范围（pre-existing）」改为「web_fetch headless 已走 NodeWorkerDriver executeOnce render」现状。
- 详情：`specs/tech/version_logs/v0.0.224/change_plan.md`


## 2026-07-30 · v0.0.222（agent_tools §2.2 subagent 实例 override 补 tools 三态）

- **`[P1]agent_tools.md §2.2`**：subagent 实例 override 行从「最终 = instanceOverride.tools ∩ bound」（漏 undefined 分支）改述为完整三态 `instanceOverride.tools !== undefined ? (∩ bound) : new Set(bound)`——undefined=继承 subagent profile toolBound 全集（默认）/ []=显式空 / 非空=与 bound 取交集；优先级描述补「前两者均不传时落到 profile bound 全集，而非空集」。本 KB 只改这一行（三态主权威在 `multi_agent/[P1]subagent_derivation.md §4`）。
- **背景**：`agent-tool.ts:330` 落库曾用 `tools ?? []` 把 undefined（未指定=该继承 bound）降级成 []（显式空），resolveToolSet 走交集得空集 → 不传 tools 的 subagent 零工具 + tool_guidance prompt 段缺席。v0.0.222 去 `?? []` 透传 undefined，resolveToolSet 本有的 `undefined → new Set(bound)` 全集分支恢复生效。
- 详情：`specs/tech/version_logs/v0.0.222/change_plan.md`

## 2026-07-29 · v0.0.217 工具白名单交集统一 resolveToolSet 单源（tool-policy.ts 删除）

- **`[P0]tool_policy.md §3/§4.2`**：旁路（summary/consolidate）allowedTools 派生从 `filterAllowedTools`（`tool-policy.ts`，整文件已删）统一为 `resolveToolSet(effectiveKind, {tools: snapshot.tools 名表})`（= snapshot ∩ toolBound，注册序；旁路与主链同一单源）。§3 补旁路调用形态一句；§4.2 reminder 行改述同源产出。不变量不变：旁路 toolDefinitions 仍 = snapshot.tools 原样（host-snapshot cache 契约，resolveToolSet 产的三件套只取 allowedTools）；summary=[] / consolidate=[skill_manage,memory_manage]∩snapshot 行为等价（顺序变注册序，消费点均顺序无关）。
- **代码↔spec 偏离核实（doc-modifier 阶段 5）**：`build-run-deps.ts:96-105` 旁路分支 = `resolveToolSet(kind, {tools})` 只解构 `allowedTools`，`toolDefinitions = providedSnapshot.tools` 原样；`filterAllowedTools`/`FilterAllowedToolsResult` 全仓（app/）零残留。无偏离。
- 详情：`specs/tech/version_logs/v0.0.217/change_plan.md`

## 2026-07-28 · v0.0.208 academy 板块整体删除（影响：ACADEMY_COACH_EXTRA / academy toolBound 行删除）

- **`[P0]tool_policy.md §2`** + **`index.md` ④** + **`[P1]agent_tools.md`**：删 `ACADEMY_COACH_EXTRA` 常量引用 + `academy-coach.parent.main.yaml` / `academy-trainer.parent.main.yaml` profile 行；toolBound 数据迁移表只留 playground/studio 行；registry.defaultTools 去 academy 工具描述。

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-07-25 · v0.0.204 收尾（policy deps 单路注入 + trainer/squad toolBound 补齐）

- **`[P0]tool_policy.md §4.1（新增）`**：SessionTypePolicy 注入改 **deps 单路 fail-fast**——bootstrap 装配 → `SessionHandlerDeps.sessionTypePolicy` → buildSessionConfigFromDeps 直读（未注入 throw；lazy 单例 + 双构造路径删除）；测试经 buildRealSessionTypePolicy/mock 注入 deps fixture。
- **`[P0]tool_policy.md §2/§3/§5`**：trainer.main toolBound=18 / squad.main=3（各补 skill_manage+memory_manage，consolidate 交集非空 invariant）；旁路 toolDefinitions 删「无 snapshot 重建」分支（snapshot 必填，rebuild 死兜底已删）。

## 2026-07-24 · v0.0.204（bound 迁 profile yaml + resolveToolSet + TOOL_POLICY 删除）

- **`[P0]tool_policy.md`（重写）**：bound 从 TS 常量（`TOOL_POLICY`/`SHARED_PLAYGROUND_BOUND`/`ACADEMY_COACH_EXTRA`，已删）迁入 `app/plugins/session-types/*.yaml` 的 `toolBound` 字段；`resolveTools()` 单方法重写为 `SessionTypePolicy.resolveToolSet(kind, instanceOverride)`（保注册序 + 剔幽灵名）；三层一致（config/schema/exec）查同一份 profile.toolBound；`ToolPolicyRole` 类型 + `deriveToolPolicyRole` helper 全删（SessionKind 即唯一身份键）；runKind 粒度（summary=零工具 / consolidate=[skill_manage, memory_manage]，后者迁自 CONSOLIDATION_ALLOWED_TOOLS）；`RunSpec.enableToolWhitelist`/`toolWhitelist` + `SessionConfig.scope` 死字段全删。
- **`[P1]agent_tools.md §2.2/§2.3`**：删 v0.0.48 旧版「SessionConfig.scope 双层门控」描述（scope 字段已删，零消费）；subagent 不可再派生不变量保留（profile.toolBound 不含 agent），但走 profile 而非独立 scope 字段。
- **`index.md`**：核心概念表加 `[v0.0.204] SessionTypePolicy.resolveToolSet`；原则 5 重写（policy 单源 = profile yaml，替代 TS 常量）；对外协作点更新（tool-policy.ts 重写为 filterAllowedTools 纯函数 + lazy 单例 policy 从 app/plugins/session-types/ 加载）。
- **代码↔spec 偏离核实**：tool-policy.ts 重写为 `filterAllowedTools` 纯函数（保注册序 + 剔幽灵名），session-config.ts 走 lazy 单例 policy（从 `app/plugins/session-types/` 加载）；@app/shared 删 `ToolPolicyRole` 类型 + `deriveToolPolicyRole` helper（grep 零残留，仅注释残留）；build-deps/build-forked-deps LoopObservability sessionKind 改读 `kind.canonicalId()`（替 deriveToolPolicyRole）——与 spec 对齐，无新偏离。
- 详情：`specs/tech/version_logs/v0.0.204/change_plan.md`

## 2026-07-24 · v0.0.203.learning_agent_fix（write 工具新建文件自动 mkdir -p 父目录）

- **`[P0]file_op_tools.md §3`** write 行为修订：新建文件时父目录不存在 → 自动 `mkdir -p`（recursive）。旧约束「父目录不存在 → isError」已改（BUG-002 子项：trainer subagent 白名单无 bash，写 `.rocky/skills/<name>/SKILL.md` 创新 skill 时父链不存在即失败、无 mkdir 工具可救；recursive 对已存在目录 no-op，main agent 不受影响）。UT `file-write.test.ts`「父目录不存在 → isError」改断言「自动 mkdir -p」。
- 代码定位：`app/server/src/tools/file-write.ts:70-81`（新建文件分支：`mkdirSync(parent, { recursive: true })` + 失败返 RUNTIME_ERROR）。
- 详情：`specs/tech/version_logs/v0.0.203/change_log.md`

## 2026-07-22 · v0.0.190（AT 去 record/replay — 出站 fetch 还原纯 proxyFetch）

- **`[P1]see_image_tool.md` 4 处 + `[P1]web_search_tool.md` 2 处删 `pickWebFetch(getRegistry()) ?? proxyFetch` 描述**：AT record/replay 机制整体删除（`app/server/src/testing/` 整目录，见 `../../testing/at-framework.md` §5），5 个 plugin impl（see_image/minimax-provider、see_image/zhipu-image-provider、zhipu_web_search/zhipu-api-provider、zhipu_web_search/zhipu-coding-plan-provider、skills_sh/skills-sh-provider）的出站 fetch 从「pickWebFetch 决策（record/replay 时换回放 fetch）」还原为直接 `proxyFetch`（统一代理层）。spec 对齐代码（§4 协议注释 / §5 内置 vender / §9 共性约定）。
- **代码-spec 一致核实（doc-modifier 阶段 5）**：`app/plugins/builtins/see_image/minimax-provider.ts` + `skills_sh/skills-sh-provider.ts` 均 `import { proxyFetch }` 直接调用，无 getRegistry/pickWebFetch 残留。无偏离。

## 2026-07-18 · v0.0.171（read 工具 offset 越界返 error — 防 LLM 400 空 text block）

- **`[P0]file_op_tools.md §2` read 错误列表新增 offset 越界分支**：`startIdx >= lines.length`（即 `offset > 实际行数`）→ 返 `errorResult`（`isError:true`，`ToolErrorCode.INVALID_INPUT`，文案 `offset N out of range (file has M lines): <path>`，M = 内容行数 = `lines.length - (raw.endsWith('\n') ? 1 : 0)`）。修复：原 `slice(startIdx, …)` 越界返 `[]` → `textResult('')` 发出空 text content block 撞 Anthropic 400 "text content is empty"。报给 LLM 的「实际行数」按内容行计（尾换行产生的尾空串不算）。
- **代码定位**：`app/server/src/tools/file-read.ts:88-93`（offset 越界 guard，紧跟 `raw.length === 0` 空文件提示之后、`slice` 之前）。
- **不动**：read 工具 inputSchema（offset/limit 语义未变）/ 其他 4 个 file 工具（write/edit/glob/grep）/ tool_execution_engine。
- 详情：`specs/tech/version_logs/v0.0.171/change_log.md`（如有）

## 2026-07-16 · v0.0.160（computer tool 微更新 — text_limit max / secondary_action pretty|raw / state_unavailable 友好文案 / list_apps 输出）

- **`[P1]computer_use_tool.md §2`**：`get_app_state` / `read_ax_tree` 行 `text_limit?` 注 `(number\|'max')`——'max' = 无上限关键字（Swift `SnapshotTextLimit.parse`；schema `oneOf`）；`list_apps` 结果说明改「v0.0.160 起 = 运行中 + Spotlight recent 合并单行渲染 `<name> — <bundleId> [flags]`」+ 无可控 app 时头「未发现可控 app」（原「未发现运行中的可控 app」措辞已不准）；`perform_secondary_action` 参数注 v0.0.160 pretty 别名（`Press`/`Show Menu`/`Raise`）或 raw（`AXPress`/`AXShowMenu`/`AXRaise`）**双写法**——Swift `matchingAction` case-insensitive 两级 match（rawActions exact → prettyActions 位置索引反查）。
- **`[P1]computer_use_tool.md §2` 底部注**：加两条 v0.0.160 说明——① `text_limit: 'max'` 语义 + schema oneOf；② `type_text` / `set_value` handler 识别 `res.code === 'state_unavailable'` 时返「先建立坐标上下文再重试 / 无 focused editable 请先 click」类友好中文前缀 + 保留 native 原始 message 供 debug。
- **不涉及**：run() dispatch 四层 / ACTION_PERMS / session-state / snapshot-store / tool-policy bound 全无变化——纯 tool schema/actions 微改，不改流程契约。

详情：`specs/tech/version_logs/v0.0.160/log.md`（主变更为 platform/ 层，本次 tool 层仅微改）

## 2026-07-16 · v0.0.157（截图本地化：不 inline 进对话上下文 — computer/browser 统一落盘）

- **新增 `tools/snapshot-store.ts`（共享单一落盘出口）**：`saveSnapshot({workdir, toolCallId, data: Buffer|base64, mediaType, width?, height?})` → mkdir -p `<workdir>/snapshots/` + writeFile `<toolCallId>.<ext>` → `{absPath, relPath, mediaType, width?, height?}`；`formatSnapshotText({relPath, width?, height?, mediaType?, source:'computer'|'browser'})` 构造 tool_result 文案（computer 带 WxH/mediaType 段；browser 固定无 size 段）。toolCallId 缺省 fallback `'unknown-'+Date.now()` 并 warn。
- **`[P0]tool_execution_engine.md §2`**：`ToolCtx` 加可选字段 `toolCallId?: string`——engine per-call 从 `call.id` 注入（唯一源），saveSnapshot 落盘命名消费；可选字段不破坏旧 UT。
- **`[P1]computer_use_tool.md`**：§2 action 表 screenshot/get_app_state 结果包装改 TextBlock（落盘路径 + size；get_app_state 两 TextBlock 顺序固定 [path, axText]）；§4 run() 示例 handler 段改 `saveSnapshot + formatSnapshotText`（删 wrapScreenshot）；§7 文件清单删 `image-block.ts` 行 + 加 `snapshot-store.ts` 行 + actions 行标注落盘。
- **`[P1]browser_tool.md`**：§2 BrowserSession.screenshot 注释改「路径文本，不 inline」；§6 驱动模型「截图作辅助」改「tool_result 永远是路径文本（dispatchAction 拦截落盘）」；§7 tool.ts run() 示例补 dispatchAction ctx 透传 + headless executeOnce 分支 `action==='screenshot'` 拦截（JSON.parse → Buffer.from base64 → saveSnapshot）+ 兜底 connect 分支 dispatchAction ctx；尾段加「driver.executeOnce 协议未动（worker boundary 不传 Buffer 是既定约束）」。
- **`index.md` ④/⑤**：加核心原则 11（截图不 inline + 统一落盘 + 多模态走 see_image）；导航 computer_use_tool/browser_tool 描述补 v0.0.157 落盘。
- **删 `tools/computer-use/image-block.ts`（整文件）**：`wrapScreenshot` + 文件本体全删（无死代码）；同步清所有 import（actions/{screenshot,get-app-state}.ts / permissions.test.ts / computer.test.ts）。
- **INV**（实现 + review 硬约束）：① tool_result.content 绝不含 ImageBlock（grep `type:'image'` 在 tools/ 归零）② 文件名必含 toolCallId 禁 Date.now/random ③ 落盘必走 saveSnapshot 禁 actions 内 fs.writeFile ④ 落盘失败 → isError 不回退 inline image ⑤ see_image + tool 协议不改（路径已兼容）。

详情：`specs/tech/version_logs/v0.0.157/change_plan.md` + `log.md`

## 2026-07-15 · v0.0.146.tool_desc（ToolDefinition 加 intro — system prompt 用短简介，消除 tool 介绍冗余）

- **`index.md §1` 概念表 + `[P0]tool_execution_engine.md §2`**：`ToolDefinition` 加可选 `intro?: string`（一句话短简介，供 system prompt Tool Guidance 用；无则 fallback `description`）。完整 `description` 仍留给 tool schema（`snapshot.tools` → LLM function calling）不变。消除 system prompt 与 tool schema 的 description 冗余——mapper `tool_guidance.ts` 改用 `intro ?? description`。26 个默认 tool 全补 intro（≤~12 词，去掉 schema 已覆盖的细节）。可选字段，外部/非默认 plugin 不强制，向后兼容。修正 `tool_execution_engine.md §2` stale `[P0]overall.md §2` ref → `app/server/src/tools/types.ts`。

详情：`specs/tech/version_logs/v0.0.146.tool_desc/change_log.md`

## 2026-07-14 · v0.0.141.see_img（新增 see_image 视觉理解工具 — 双 vender）

- **新增 `[P1]see_image_tool.md`**：多 vender 视觉理解工具，与 web_search **完全同构**——`SeeImageProvider` 协议（`understand(text, imagePaths[], cfg, signal)→SeeImageResult{text}`）+ `see_image_provider` list EP（新 `vision` group）+ `app_config.see_image` 路由（`{type, credentials}`）+ resolveProvider 三错误分支（type 未配置 / impl 未激活 / isAvailable false）。**硬约束**：base64/图片二进制绝不进 tool 入参/出参——tool 层用 `ctx.workdir` resolve 相对路径 + stat/扩展名校验（不读内容），读文件→base64 只在 provider.understand 内部。
- **2 个 builtin ext impl（1 plugin `see_image`）**：`minimax_m3`（MiniMax-M3 anthropic 兼容端点 `api.minimaxi.com/anthropic/v1/messages`，base64 image block，**多图按 imagePaths 顺序**，model/temperature=1.0/endpoint 全写死，轻量自拼 body 照 vision_check.py，**不挂平台 LlmClient/provider**）/ `zhipu_image`（智谱 GLM 视觉 REST `/api/paas/v4/chat/completions`，image_url base64 data URL，model=`glm-4.5v` 写死，**imagePaths.length≠1 抛错**）。出站均走 `pickWebFetch(getRegistry()) ?? proxyFetch`（record/replay），零新第三方依赖。
- **注册**：`registry.ts defaultTools()` 加 `seeImageTool`；`tool-policy.ts` 加 `'see_image'` 到 playground-rocky/studio-leader/studio-mate/subagent 四 bound（**非 studio-squad**）；`extension-point.ts` 加 `SeeImageProviderPoint` + `BUILTIN_EXTENSION_POINTS`；`scopes/default.yaml` 加 `vision` group；`groups.json` 加 `vision` group。
- **前端**：`section-see-image-config.tsx` 自渲染 section（照 section-web-search-config 复刻），注入 section-tab-panel `tools` case；@图片 mention 零前端改动。
- **index.md**：⑤ 导航加 `see_image_tool.md`；④ 加核心原则 10（base64 只在 provider impl 内部）；③ plugin_system 关系加 see_image_provider。

详情：`specs/tech/version_logs/v0.0.141.see_img/change_log.md`

## 2026-07-13 · v0.0.130.hang（tool 超时体系 + bash 子进程组杀 — agent hang 修复）

- **`[P0]tool_execution_engine.md §2/§4.2`（承诺→已兑现）**：§2/§4 早声明 `ctx.signal` + engine overall timeout 但代码从未装配（`ctx.signal` 恒 undefined = 死线）；本版实现该契约。新增 §4.2：三层超时（per-call `arguments.timeout` > per-tool `defaultTimeoutMs`（file×5=10s/web×2=30s/bash=120s/agent=600s/未声明=30s）> engine 默认 30s，`clamp(1,600000)`）+ backstop=`min(effective+GRACE 5s,600000)` + `runTool` per-call AbortController→`ctx.signal` + 超时→abort+`formatTimeoutText` 统一文本 `[timeout] <tool> exceeded <ms>ms` + **HITL 结构性豁免**（pending 分支在 runTool 前 continue，永不进 race）+ `ExecuteRunCtx.childRegistry` 装配。落 `tools/engine-timeout.ts`（常量+resolveEffectiveTimeout+formatTimeoutText，engine.ts re-export）。§2 补 `Tool.defaultTimeoutMs?` + `ToolCtx.childRegistry?`。
- **`[P0]bash_tools.md §4.5`（新增）**：双症状根因（孙进程继承 pipe→close 永不触发→tool.run 永不 resolve→hang）；修法 = 两处 spawn `detached:true` 建进程组 + `killProcessGroup`（负 pid 组杀，SIGTERM→500ms→SIGKILL，ESRCH fallback child.kill）+ `wireChildLifecycle` 三条 kill 路径全走组杀 + `opts.childRegistry` register/unregister 收支平衡。§2 超时文本统一前缀。ExecOpts 加 `childRegistry?`。
- **边界裁决**：run 级 abort 走 `childRegistry.killAll`（杀树→pipe 释放→resolve），不硬链 ctx.signal 到 run controller；单 tool 超时 ctx.signal 自清不调 killAll；reconcile 不接 killAll（死代码，排除）。
- 各 tool 单例加 `defaultTimeoutMs`；新文件 `child-process-registry.ts`（run 级 killAll sweep，挂 `AbortControllerHandle.childRegistry`）。

详情：`specs/tech/version_logs/v0.0.130.hang/change_log.md`

## 2026-07-12 · v0.0.126.history_search（新增 2 个 history 工具 — search + get_context）

- **新增 `[P1]history_search_tool.md`**：LLM tool（read-only，`policy.kind='auto'` 免审批），FTS5 BM25 召回 + snippet；inputSchema 字段 `query`/`keywords`/`scope`/`time_range`/`top_k`（query/keywords 至少一个，schema 不标 required，run 内校验）。run 调 `ctx.config.historyToolDeps.searchEngine.search(query, opts)` 双参签名；scope 映射 `exclude_current` + `ctx.sessionId` → `{scope, currentSession}`；time_range 平铺到 opts.after/before；top_k → topK。UT 覆盖 query/keywords/scope/exclude_current/empty/缺参/top_k 上限。
- **新增 `[P1]history_get_context_tool.md`**：LLM tool（read-only），按 messageId 回 transcript 取上下文窗（含 image/tool_use/tool_result 结构化 block）。**around 窗口语义用两次 getMessages 组合实现**（不改 MessageRange）：`Promise.all([getMessages(beforeId=msgId, limit=before), getMessages(fromId=msgId, limit=after+1)])` → 合并去重保 id 升序。两层独立截断（block 级 tool_result > 25k 截 / image → `[image: omitted]`；message 级 text 累加 > 8k 截 + offload 标记）。
- **§2 SearchEngine.search 双参签名对齐**：tool 调代码实际签名 `search(query, opts)`（非单参数对象）；SearchOptions 字段 camelCase（`currentSession`/`topK`/`after`/`before`，非 snake_case）。
- 依赖注入：两 tool 共用 `HistoryToolDeps = { searchEngine, sessionStore }`，`resolveHistoryDeps(ctx)` 从 `ctx.config.historyToolDeps` 取（bootstrap 装配注入）。
- 实现：`app/server/src/tools/history-search-tool.ts` + `history-get-context-tool.ts`；UT `__tests__/history-{search,get-context}-tool.test.ts`。

详情：`specs/tech/version_logs/v0.0.126/change_log.md`

## 2026-07-12 · v0.0.124.hitl（审批回填补发 tool_result SSE — 审批卡实时翻转）

- **`[P0]tool_permission.md §6`**：补跑机制新增「emit 一致性」约束——approval 三分发（allow/allow_always/deny）编辑出的 `newBlock` 与其它 handleType 一样，由 `handleToolReply` 在持久化后统一经 `emitToolResult` 补发 tool_result 三帧 SSE（不分 branch），审批卡因此批准/拒绝后实时翻转 success/fail/isError 无须刷新。emit-after-persist 时序契约见 `../agent_interface_and_loop/[P0]agent_hitl.md §2 步骤 4.5 + INV-8`。
- 详见 `../agent_interface_and_loop/log.md`（同版本 agent_hitl/agent_loop_base 主变更）+ `states/v0.0.124.hitl/`。

## 2026-07-12 · v0.0.123（web_search 内置 Zhipu provider 拆 2 个独立 impl）

- **`[P1]web_search_tool.md` §7 拆 2 provider**：内置 Zhipu 从单 implId `zhipu` 拆为 `zhipu_coding_plan`（MCP `open.bigmodel.cn/api/mcp/web_search_prime/mcp`，两步 initialize→tools/call，Coding Plan 订阅额度，`zhipu-coding-plan-provider.ts`）+ `zhipu_api`（REST `/api/paas/v4/web_search`，按量计费，`zhipu-api-provider.ts` 从 git `0b64ae54^` 恢复）。同 `web_search_provider` list EP，各 key 隔离，label 各异供 ToolError 区分。plugin id `zhipu_web_search` / `WebSearchProvider` 协议 / `resolveProvider` 路由零改动。
- **§7 收口架构期历史内容**：删旧单 impl 示例代码（`get label(){return 'Zhipu 智谱'}`、单 `credentials.zhipu.apiKey`），改两 impl 并列骨架 + `<implId>` 占位；§1 概述 + §8 边界表同步 2 impl；frontmatter updated → 2026-07-12。
- **凭证/迁移在 config KB**：`credentials.<implId>.apiKey` 隔离 + 旧 `zhipu` 一次性迁 `zhipu_coding_plan`，见 `config/[P0]app_config.md §3.6`。
- 详见 `specs/tech/version_logs/v0.0.123/change_log.md`。

## 2026-07-12 · v0.0.122（工具权限系统三层：策略 / 审批 / 执行，范围=bash）

- **新建 `[P0]tool_permission.md`**：策略层 + 审批层完整 spec——`PermissionDecision`（allow / deny+reason / ask+reason+approvalKey）+ `Tool.checkPermission?(input, ctx)` 可选钩子（与 interaction 并列）；引擎集成点=`execute()` 白名单门后、interaction 前（deny→isError 不悬挂；ask→查 ApprovalManager，未同意则引擎构造 `need_approval` interaction 走 buildPendingResult）；`ApprovalManager`（内存 Map，(sessionId, approvalKey) 记忆，D2 不落盘）；approval 回填三分发（allow 补跑 tool.run / allow_always 补跑+recordAlways / deny isError）；与 allowedTools + interaction 三门正交（INV-P1~P7）。
- **`[P0]bash_tools.md` §4/§5 新增**：执行层 `BashEngine.exec` / `SecureBashEngine`（seatbelt profile 编译 allow-default+逐条 deny，`sandbox-exec -p <profile>` 内联不写文件，`~` 走 config.ts expandTilde；非 darwin passthrough）+ `BashSecurityPolicy`（denyRead/denyWrite）；策略层两条 bash 策略（`ssh-read` deny / `rm-wildcard` ask，deny 优先）；`runShell` 收编为 engine 实现，超时/abort/截断语义不破。**删除 `dangerouslyDisableSandbox` 死字段**（未消费且与安全模型冲突）。
- **`../agent_interface_and_loop/[P0]agent_hitl.md`**：approval handleType 从「留位」转「**v0.0.122 已实例**」；§2 三分发补 allow/allow_always/deny 语义；§3 情况 a 触发源补「引擎 checkPermission ask」（与 tool.interaction 殊途同归走 buildPendingResult）。
- **`../../../api/overall/04-agent-session.md §3.2`**：handleType='approval' 实例化说明（payload=`{decision}`，端点零新增）。
- **`../../../ui/components/chat-page/component-pending-approval-card.md`（新）**：审批卡组件 spec（同位互斥提问卡 + 三按钮 + testid `pending-approval-{id}`/`approval-command`/`approval-reason`/`approval-{allow,deny,allow-always}-btn`）。
- **`index.md`**：概念表加 checkPermission 行 + 核心原则 8（工具安全三层）+ 导航 tool_permission.md 行。
- **事后偏差**：`expandTilde` 在 bash-engine.ts 本地重实现（config.ts 只 export resolveDataDir 未 export expandTilde，逻辑等价护栏不破）；`compileSeatbeltProfile` 加 `assertSafePath` 防护（拒绝含 `"`/`\` 路径）。见 `[P0]bash_tools.md §4.2`。
- 详见 `specs/tech/version_logs/v0.0.122/change_log.md`（发布说明）+ `change_plan.md`（method 级契约）。

## 2026-07-12 · v0.0.121（jina-fetcher masked-key 观测日志）

- **`[P1]web_fetch_tool.md §3.2`**：`JinaContentFetcher.fetch` 发请求处新增 masked-key 观测日志——有 key `console.log('[jina-fetcher] key=<masked>')` / 无 key `'[jina-fetcher] key=anonymous'`，仅观测本次走 Bearer 鉴权还是匿名，不泄真值。仅日志 side-effect，抓取链路/Authorization 逻辑零改动。
- **新增 `app/server/src/tools/web-fetch/mask-key.ts`**（纯函数 `maskKey`）：脱敏规则与前端 `secret-input.tsx:maskSecret` 完全一致（len≤4 全 `*`；4<len≤8 首 1+`*`+末 1；len>8 首 4+`*`+末 4；len=0 空串），server 侧不跨包引前端组件。
- 详见 `specs/tech/version_logs/v0.0.121/change_log.md`（如有跨版本发布说明）。

## 2026-07-10 · v0.0.105（单 computer tool + 11 action + ImageBlock 打通；pivot 后）

- **新建 `[P1]computer_use_tool.md`**：**单一 `computer` tool + 11 action**（get_app_state/list_apps/screenshot/read_ax_tree/click/perform_secondary_action/scroll/drag/type_text/press_key/set_value，对齐 open-codex）——**非** 多独立 tool、**非** 连接器。run() 按 action dispatch 到 port method；fail-closed 分层（action 校验 / port undefined / ACTION_PERMS 按 action 权限门禁 / handler）；扁平 action-discriminated schema（snake_case 参数 `element_index`/`max_tree_nodes` 等）；app-scoped（app 参数 + Swift resolvePid）；window-relative 三段式坐标（session-state 缓存 windowBounds+scaleFactor）；image block 包装（wrapScreenshot）。仅 bound playground-rocky（控 OS 风险；subagent/leader/mate/squad 不加）。
- **新建 `../../platform/` OKF KB**（index.md + log.md + `[P1]computer_native_capability.md`）：`ComputerNativePort`（纯 TS 11 能力）+ 主进程 native addon（Swift dylib + N-API）+ 三态注入 precedence（AT mock / dev loopback / packaged registry）。**pivot**：废旧 spawn Swift helper（拿不到 TCC 权限），改主进程注入。
- **ImageBlock 全链路打通（P0 前置）**：`message/types.ts ContentBlock` union 加 ImageBlock（v0.0.8 砍了的补回）+ `protocol-encode.ts encodeContentBlock case 'image'` 适配 spec 形→wire 形翻译 + ToolResultBlock.content 承载 image。详 `../../message/[P0]agent_message_interface.md §4.2`。
- **`index.md`**：导航更新 computer_use_tool.md 行（单 tool + 11 action）；工具数 26（加单 `computer` tool）。
- **`tool-policy.ts`**：`TOOL_POLICY['playground-rocky'].bound` 加单 `'computer'`（1 条覆盖全部 11 action）。
- 蓝本 iFurySt open-codex（能力集 1:1 对齐 + postToPid + ScreenCaptureKit）。
- 详见 `specs/tech/version_logs/v0.0.105/change_log.md` + `change_plan_v2.md` + `change_plan_v2_batch2.md`。

## 2026-07-09 · v0.0.101（Tool 钩子改造 needsApproval→interaction/onReply + bash cwd 绝对路径修复 + ask-question tool）

- **`[P0]tool_execution_engine.md §2/§4/§5/§7`**：`Tool.needsApproval?():boolean` → `Tool.interaction?(input,ctx): ToolInteraction|null`（null=普通 tool 立即 run）+ `Tool.onReply?(payload,ctx)`（仅 callback）；execute 返签名 breaking `Promise<{results, pending}>`；§4 executeOne 伪码加 interaction 分流（取代旧 step 3 approval 占位）；§5 从「恒跳过」改为「interaction 返非 null → 生成 pending result 不真跑 + 入队」；§7 边界表 + ownership 同步。
- **`[P0]tool_policy.md §2.2`**：5 角色 bound 加 ask-question 到 **4 角色**（playground-rocky=21/studio-leader=24/studio-mate=24/subagent=12，非 studio-squad——群聊哑路由不直接调 leader/mate 代行）。
- **`[P0]bash_tools.md`**：cwd `<workdir>/workspace` → `<workdir>`（不多层）；file 工具已绝对路径零改动（drift：req 说的 resolveInWorkspace 不存在）。
- **`index.md`**：概念表 Tool/execute/interaction 行 + 工具数 16→17（加 ask-question）+ 导航 tool_execution_engine 描述对齐 interaction 钩子。
- **新增 `ask-question` tool**（首消费者，handleType=direct_result，恒悬挂无 run）。
- 详见 `specs/tech/version_logs/v0.0.101/change_log.md` + `change_plan.md`（模块 A/G/H）。

## 2026-07-05 · v0.0.72（web_search 协议重构：EP list + 协议加 cfg + 凭证迁 app_config + Zhipu 删 env 回退）

- **`[P1]web_search_tool.md`**（重大修订）：① EP cardinality 由 `exclusive` 改 `list`（多 provider 共存，tool 按 `app_config.web_search.type` 单点路由不融合）；② `WebSearchProvider` 协议 `search`/`isAvailable` 加 `cfg: WebSearchCfg` 入参（不透明 map，由 tool 从 `app_config.web_search.credentials[type]` 构造传入），impl 不再从 `this.cfg`/env 读凭证；③ 凭证归属从 ext impl `configSchema` 迁到 `app_config.web_search` group（D2，详 config KB §3.6），删 `plugin.json` 的 `configSchema.apiKey` + 删 `process.env.ZHIPU_SEARCH_API_KEY` 回退；④ §4 `resolveProvider` 重写（读 `appConfig.get("web_search","default")` → 按 type 精确匹配 impl.id → `cfg = credentials[type] ?? {}`），三错误分支均返 ToolError 不回退；⑤ §5.4 推翻原 exclusive 决策，§7 Zhipu impl 改从 cfg.apiKey 读 + key 空抛错；⑥ frontmatter `updated`/`title` 更新（title 加「+ List EP + app_config 路由」）。
- **关联**：EP 改 list 见 `specs/tech/plugin_system/log.md` v0.0.72；凭证 group 见 `specs/tech/config/log.md` v0.0.72；API 端点见 `specs/api/version_logs/v0.0.72.md`。
- 实现层（task T1）：`app/server/src/tools/web-search/types.ts` 协议加 cfg + WebSearchCfg 类型；`tool.ts` `resolveProvider` 重写（按 type 精确路由 + cfg 构造透传）；`app/plugins/builtins/zhipu_web_search/zhipu-provider.ts` 改从 `cfg.apiKey` 读 + 删 env 回退 + key 空抛错；`plugin.json` 删 configSchema；UT 三路径（type=zhipu/apiKey 空/type 未知）+ zhipu-provider UT（isAvailable/search cfg 透传）。
- **coder 汇报偏离（已同步 spec）**：① `scopes/default.json` 删 `exclusivePicks.web_search_provider`（change_plan section A 未列，是 cardinality 改 list 的强制下游）；② `ZhipuWebSearchProvider.isAvailable(cfg = {})/search(..., cfg = {})` 加默认值（防御性，协议契约 §2 仍写必传）；③ `scopes/default.json` `_meta.secretPolicy` 文案「由 dev config / env 注入」已过时（apiKey 不再走 scope config/env，迁 app_config），spec 同步。

详情：`specs/tech/version_logs/v0.0.72/change_log.md`

## 2026-07-05 · v0.0.68（validateInput default-fill 通用机制 + send_message needReply default:true）

- **`[P1]agent_tools.md`**：补 §validateInput 末尾 default-fill 通用机制——`for (const [k,sub] of Object.entries(schema.properties)) if (obj[k]===undefined && sub.default!==undefined) obj[k]=sub.default`。D5 决策：放 validateInput 末尾（所有工具受益），不特例化 send_message。**首个消费者**：send_message needReply=true default。
- **send_message schema 改动**（spec 落在 `specs/tech/multi_agent/`）：needReply 从「★ 必填」改可选 default:true；normalize 容错链路 `?? true`（缺省视为 true，符合 spec 「通常需回复」语义；显式 false 不被覆盖）。
- **代码同步**：`app/server/src/tools/engine.ts` validateInput 末尾加 default-fill 循环；`app/server/src/agent/tools/send-message-tool.ts` required 移出 needReply + properties.needReply 加 `default:true` + normalize 改 `?? true`；UT 「needReply 缺失 → error」断言改「needReply 缺失 → default 生效（落库 needReply=true）」。

详情：`specs/tech/version_logs/v0.0.68/change_log.md` §R5

## 2026-07-04 · v0.0.57（删 capByParent 冗余）

- **`[P0]tool_policy.md §1/§2.2/§3/§5`**：删除 capByParent 设计——subagent 的第三道 `∩ parent.bound` 是冗余（`subagent.bound` 已是所有 parent.bound 的子集，永远裁不掉任何东西）。`ToolPolicyRoleEntry.capByParent` 字段、`TOOL_POLICY.subagent.capByParent: true`、`resolveTools` subagent 分支的 `kind.parentToolPolicyRole` 派生 + `∩ parent.bound` 全删；subagent 实际白名单简化为 `mainAllowedTools ∩ subagent.bound`。
- **代码同步**：`app/server/src/agent/tool-policy.ts` 删 `capByParent` 字段 + ∩ parent 分支；UT 删 capByParent 断言（subagent resolve 语义不变）。
- **关联**：`session/[P0]session_kind.md` 同步删 `parentToolPolicyRole` getter（capByParent 是唯一消费者）。

## 2026-07-03 · v0.0.56（resolveRole→SessionKind.toolPolicyRole + scope 字段删除）

- **`[P0]tool_policy.md §2.3`**：旧 `resolveRole({bizType, type})` 函数删除；调用方改读 `SessionKind.toolPolicyRole` getter（映射表不变，输入从 {bizType,type}→{biz,role,derivation}）。§4.1 session-config 调用点同步更新（kind.toolPolicyRole 替代旧 resolveRole）。
- **`[P1]agent_tools.md §2`**：scope 字段删除声明（v0.0.56 起 subagent 可见性走 derivation='subagent' + TOOL_POLICY，不再靠独立 scope 字段）。旧 §2.1-§2.4 保留为历史背景。

详情：`specs/tech/version_logs/v0.0.56-session_type/change_log.md`

## 2026-07-03 · v0.0.56 hotfix（resolveTools 入参 kind 替代 role+parentRole + 删 parent-role.ts）

- **`[P0]tool_policy.md §2.3`**：标注 hotfix——`resolveParentRole(parent)` 函数 + `parent-role.ts` 文件 + `subAgentConfig.parentRole` 字段全删；capByParent 改读 `kind.parentToolPolicyRole`。ToolPolicyRole re-export from @app/shared。
- **`[P0]tool_policy.md §3.1`**：`resolveTools` 签名重写——入参从 `{role?, parentRole?, ...}` 改为 `{kind?: SessionKind, ...}`（顶层/subagent 必传，forked 可省）。
- **`[P0]tool_policy.md §3.2/§4.1/§4.5/§5`**：流程伪码 + session-config 调用点 + spawn 链 + subagent resolve 表全部改用 `kind.toolPolicyRole` / `kind.parentToolPolicyRole`（删独立 role/parentRole 入参）。
- **`[P0]tool_policy.md §7`**：文件清单加 `app/shared/src/types/session-kind.ts`（v0.0.56 新增）；标 `parent-role.ts` 已删；`session-store-types.ts` 标删 `parentRole?` 字段。

详情：`specs/tech/version_logs/v0.0.56-session_type/change_log.md`（hotfix 节）

## 2026-07-02 · v0.0.48（tool policy 单源 + resolveTools 收敛 + 统一拒绝错误）

- **新增 `tool_policy.md`**：5 角色 bound + capByParent 落 `TOOL_POLICY` TS 常量（`tool-policy.ts`，**非 JSON 文件**，对齐 SchemaDef 风格 + 编译期类型 + IDE 跳转）；`resolveTools()` 单方法读 policy resolve（顶层=sub.bound / subagent=mainAllowedTools ∩ subagent.bound ∩ 父 bound / forked=enableToolWhitelist+toolWhitelist）；产出三件套（tools/toolDefinitions/allowedTools）三处消费；4 调用点改造（session-config/call-main/stage-llm/build-deps + spawn-action）；subagent mainAllowedTools 流（eff.tools → subAgentConfig.tools → resolveTools ∩ bound）。
- **修订 `tool_execution_engine.md §3.1`**：合并 `engine.ts:89 unknown_tool` + `engine.ts:146-158 notAllowedResult` 两路径为一条 `tool_not_allowed` code 的 ToolResultBlock（isError=true）；文案模板 `[tool_not_allowed] Tool '<name>' is not allowed in this session (<reason>).`；不进 errorInfo（保持轻量）；中文 notAllowedResult retire。
- **修订 `index.md`**：④ 加新原则 5（policy 单源/三层一致/bound=上限）+ 6（统一拒绝 code）；旧原则 5（scope 双层门控）标退役，指向新原则 5/6。⑤ 导航加 `tool_policy.md`。
- **修订 `agent_tools.md §2.2`**：标注 v0.0.28 引 `agent-loop.ts:278` 已 stale（v0.0.40 拆分为 `agent-loop-stage-tool.ts`，v0.0.48 改走 `build-deps.ts:204` → resolveTools）；「每次 toolCall 前 derive」订正为「每 run 一次（build-deps 装配 RunSpec.allowedTools）」。
- **`scope-allowed-tools.ts`**：v0.0.48 标 deprecated（thin re-export from `tool-policy.ts`，保 migrate 期 import 兼容）。
- 修 research §8 spec↔code 偏差：tools/index.md:52「双层」→「三层」（policy 单源 = Layer A config/B schema/C exec 三层查同一份 policy）。

详情：`specs/tech/version_logs/v0.0.48/change_log.md`

## 2026-07-15 · v0.0.46.connector_opt（browser attach 时机重构）

- `browser_tool.md`：§4 前置门禁改写——attach connect 时机由 tool.run lazy 触发（不再由 ConnectorManager bootstrap/toggle 触发）；引入 `connectForToolRun(ctx.config.sessionId)` 门禁分层三态 `not_enabled` / `in_use_by_other` / `connect_failed`。§7 tool 层示例更新：新增 `action='disconnect'` 分支（LLM 主动断开）+ `connectForToolRun` 调用替换 `getAttachSession/isReady`；`inputSchema.action` 增加 `disconnect` 枚举。driver 层（`--autoConnect`、list_pages round-trip 判据）**不改**——只改「谁触发/何时触发/触发前判定」。详见 `states/v0.0.46.connector_opt/design.md`。

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起）+ 本 `log.md`；`overall.md` 按类拆流并入 index 后归档到 `soft_deleted/`。
- 全部 9 文件加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文清理 inline `[vX.Y]` / `[vX.Y modified]` / `> version:` blockquote / 尾部 `## 版本` 段噪声，迁移到 frontmatter `since` 或本 log；代码注释里的 `[vX.Y]` 保留。
- `tool_execution_engine.md` §3 `execute` 签名补 `allowedTools?` 参数（v0.0.15 T4 已加，spec 未跟进）+ §4 `sharedReadSet` 跨工具 read 跟踪补注释。
- `task_tools.md` §2 补指向：实际实现已迁至 `../../squad/[P1]squad_tools.md §3`。
- 审计发现 BUG 4 项（详见 `states/v0.0.35/bugs/BUG-AGENT-TOOLS-00{1..4}-*-open.md`）：defaultTools 计数过时 / HITL needsApproval 引擎恒跳过 / agent_tools §2.2 TODO 过时 / browser attach 默认 flag 代码-spec 偏离。

## 2026-06-28 · v0.0.34（browser attach 连接治理）

- `browser_tool.md` v1.4：attach 默认改 `--browserUrl DEFAULT_ATTACH_CDP_URL`（loopback，纯 attach 连不上即抛绝不 launch）+ `connect()` 真跑 `list_pages` round-trip 作判据（chrome-devtools-mcp 惰性连接，旧判据恒过）+ 失败 catch `client.close()`+`transport.close()` 双清。
- 撤回进程树杀（watchdog 随父死够用）。

详情：`specs/tech/version_logs/v0.0.34/change_log.md`

## 2026-06-27 · v0.0.29（attach SSRF loopback 豁免）

- `browser_tool.md` v1.3：cdpUrl SSRF 按 loopback 豁免（修 BUG-001 本地 attach `127.0.0.1` 被当私网误拦）。`ssrf.ts` 加 `isLoopbackIp`/`isLoopbackHost`（127/8 + ::1 + localhost，纯字面量不 DNS 解析防 rebinding）；`tool.ts:106-115` 门禁 `!isLoopbackHost(cdpUrl)` 才 `assertSsrfSafe`。

详情：`specs/tech/version_logs/v0.0.29/change_log.md`

## 2026-06-27 · v0.0.28（agent 工具 + scope 工具可见性）

- `agent_tools.md` v1.0：`agent` 单工具 3 action（spawn/query/abort），契约引 `multi_agent/subagent_derivation.md §4/§7`。
- scope = extension point 概念：subagent scope 不含 `agent` 工具 → 结构上不可再派生（非 prompt 劝说）。
- 实现路径：`allowedTools` 白名单（执行层）+ engine.ts not-allowed 门控复用；schema 层当时未裁剪（TODO）。
- v0.0.26 连线 bug 修：bootstrap 注入 activationStore 到 PluginManager。
- 实现后勘误：Bug1 inputSchema 补全 + Bug2 Session 加 `subAgentConfig` 持久化 effective config。

详情：`specs/tech/version_logs/v0.0.28/change_log.md`

## 2026-06-26 · v0.0.23.1（browser NodeWorkerDriver）

- `browser_tool.md` v1.2：mode①② playwright 调用从「bun 主进程直接 connectOverCDP」改为「node worker 子进程一次性执行器」（绕开 Bun playwright connectOverCDP bug oven-sh/bun#9357）。新增 §3 NodeWorkerDriver 架构 + §2 BrowserDriver 加可选 `executeOnce`。

详情：`specs/tech/version_logs/v0.0.23.1/change_log.md`

## 2026-06-25 · v0.0.23（web 三工具）

- 新增 `web_tools.md` / `web_search_tool.md` / `web_fetch_tool.md` / `browser_tool.md`：三工具定位 + 共性约定（undici 代理/wrapExternalContent/SSRF/截断）。
- web_search = 协议 + exclusive EP（group=`web`）；v0.0.23 内置 Zhipu provider（ext impl，凭证走 configSchema 非-dev_config）。
- web_fetch v1.3 = ContentFetcher 契约 + 2 实现 race（jina ∥ local 含 headless 子分支）+ 共享 AbortController 构造注入 + detached 清理 + SSRF-first。
- browser v1.1 = 三 mode + BrowserDriver/BrowserSession 统一抽象 + attach 受连接器门禁。
- `overall.md` v1.2：defaultTools 由 7 扩至 10（+ web×3）。

详情：`specs/tech/version_logs/v0.0.23/change_log.md`（如存在）

## 2026-06-22 · v0.0.21（skill 工具）

- skill 读工具接 `defaultTools()`（+1，从 6 扩至 7）：纯读 SKILL.md，progressive disclosure L1。详见 `../skills/log.md`。

## 2026-06-19 · v0.0.15（allowedTools 门控）

- `tool_execution_engine.md` execute 加 `allowedTools?` 参数：undefined=全集（向后兼容 eager），[]=NO_TOOLS 全拦（forked summary），非空=按白名单过滤不在者返中文 not-allowed result（isError=true 让 LLM 自修正）。

## 2026-06-16 · v0.0.8（串行引擎落地）

- `tool_execution_engine.md` v1.0：execute 串行执行 + resolve/validate/approval/run/wrap + 失败不中断。
- 简化：无 HITL（needsApproval 永跳过，字段保留）；轻量 schema 校验（必填+primitive，不引 ajv）。

## 2026-07-15 · v0.0.148（ApprovalManager 持久化纠正 D2 + 绿灯短路）

- **纠正 v0.0.122 D2**：`[P0]tool_permission.md` §5/§10.4 删「D2 纯内存不落盘」决策——ApprovalManager backing 从内存 Map 改 **cache-through + ApprovalStorePort**（setStore 注入，对齐 `contextEngine.setSessionStore` 模式）。isApproved/recordAlways 改 async（cache miss 读 session.alwaysApprovedKeys，write-through 写 store + 更新 cache）。「always approve」现在**跨 app 重启保留**（per-session），名实相符。
- **绿灯短路（approvalMode）**：§4 加 `approvalMode='greenlight'` 短路——engine.execute ask 分支内、isApproved 判定前加 `if (config.approvalMode === 'greenlight') fall through`。**安全 invariants 不动**：deny 路径（L187）在 ask 之前天然不被绕过；执行层 SecureBashEngine 沙箱不变。绿灯只动审批层。
- **维度正交**：always = approvalKey 粒度（`{toolName}:{policyId}`）+ store I/O；greenlight = session 级总开关 + config 直读（无 store I/O）。两者均在 ask 分支内判定。
- ApprovalStorePort 薄端口（2 方法：getAlwaysApprovedKeys/addAlwaysApprovedKey），SessionStore 直接 implements。

详情：`specs/tech/version_logs/v0.0.148/change_plan.md`（链路 C/D）

## 2026-07-30 · v0.0.226（web_fetch render 参数 + render waitUntil 修）

- **`[P1]web_fetch_tool.md`**：§2 inputSchema 加 `render?:boolean`（强制 headless 渲染，跳过静态直起 headless；用于已知 JS 页或静态内容不全时）；§2 run `forceHeadless = render===true` 透传；§3.3 LocalFetcherCtor.forceHeadless + fetchHeadlessOnly（forceHeadless=true 跳过静态直起 headless，无 renderer 优雅降级）；§3.4 FetchContentOptions.forceHeadless；§1/§3.3/§6.5 render action `waitUntil:'load'→'domcontentloaded'`（load 对持续加载页面超时，domcontentloaded 后 DOM 就绪）。
- **`[P1]browser_tool.md`**：render action waitUntil domcontentloaded 同步。
- 详情：`specs/tech/version_logs/v0.0.226/change_plan.md`

## 2026-08-06 · v0.0.266（attach 生命周期统一）

- **`[P1]browser_tool.md`**：§4 前置门禁改写——attach 由 ConnectorManager lazy connect → **纳入 BrowserInstanceManager**（launch=ChromeMcpDriver.connect / close=disconnect 不杀 chrome）；§4.1 触发方更新 + close 语义；§7 代码示例重写——action 枚举去 disconnect 统一 close、三模式统一 launch/close/execute。
- **`[P1]browser_instance_manager.md`**：§3.3 attach 从「保持现状（ConnectorManager）」改「纳入 InstanceManager」；§4 生命周期 attach 分支（launch=connect / close=disconnect 不杀 chrome / releaseSession 覆盖 attach）。
- **`[P1]connectors.md`**：§3.2 状态机删 lazy connect/owner/disconnect 行；§5 ConnectorManager 接口删 connectForToolRun/getAttachSession/disconnect/getOwner；§6 attach 可用性门禁改 isAttachEnabled（读 switch）注入 InstanceManager。
- **`[P1]browser_instance_manager.md` + `[P1]browser_tool.md` + `[P1]connectors.md`（T3 registry 重构，追加）**：老板拍板 ActionExecutor registry 重构——抽象 `mode-impl.ts` protocol（BrowserHandle/ModeImpl/ModeImplEnv/SnapshotSink/InMemoryModeImplRegistry）+ WorkerModeImpl（headless/managed 注册同一实例两键）+ AttachModeImpl（失活自愈下沉 impl）；manager 收敛为句柄表 + registry 分发（197 行，零 `mode ===` 路由、不读 handle 私有字段）；**execute 变正确路由（M1「execute 拒绝 attach」防御分支下线）**——attach 操作类 action 与 headless/managed-profile 统一走 `im.execute`，tool.ts 零 attach 分叉（attach 分支 L163-181 删除）；screenshot 落盘下沉 impl 经 `ExecuteCtx.snapshot`（SnapshotSink）；attach-instance.ts 保留纯 helper（connect/disconnect/isAttachConnectionLost），删 hooks 相关。
- 详情：`specs/tech/version_logs/v0.0.266/change_plan.md`（含 Delta 追加章节）+ `change_log.md`
