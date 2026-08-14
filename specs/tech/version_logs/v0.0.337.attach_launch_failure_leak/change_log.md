# v0.0.337 change_log — attach launch 失败/超时 mcp+watchdog 残留修复

> 对应需求：`reqs/[working] v0.0.337.attach-launch-failure-leak.md` + bug-analyst 报告 `reports/bug-v0.0.336-attach-launch-failure-process-leak-2026-08-12.md`（leader 2026-08-12 14:52 派单）。
> 权威契约：`specs/tech/version_logs/v0.0.337.attach_launch_failure_leak/change_plan.md`（H1-H9，frozen）。
> commit：`785908066`（T1 主体：11 files +495/-39，含 5 个测试文件 +25 UT）。

## 变更摘要（已合并编码）

### 根因（bug-analyst 报告 + 代码实证，337 worktree）

| # | 根因 | 文件:行（修复前） |
|---|---|---|
| ① | driver.connect 失败清理只 SDK graceful close（只杀 mcp 主进程本身），**无 kill 进程组 + 无 watchdog kill**——与 336 修复前 close 同构 | `chrome-mcp-driver.ts:138-150` catch → `closeMcpClientThenTransport` |
| ② | tool.ts launch/close 分支**不透传 ctx.signal**（仅 execute 分支透传）→ engine backstop 30s abort 后底层 connect 继续跑（handshake 30s / SDK callTool 60s 超时），期间进程无人管 | `tool.ts:141-146`；`instance-manager.ts:209`；`mode-impl.ts:80`；`attach-mode-impl.ts:64` |
| ③ | ledger.insert **仅 launch 成功时** → 失败不入台账 → 启动自检 cleanupOrphans 找不到 → 极端残留（P0 清理失败时）无人回收 | `attach-mode-impl.ts:88-99` |

## 实现核对（method 级）

| 计划项 | 实现一致性 |
|---|---|
| H1（ChromeMcpDriverOptions 加 killDeps DI） | ✅ `ChromeKillDeps` 接口 `{isPidAlive?; killProcessGroup?; execPkill?}` + `ChromeMcpDriverOptions.killDeps?`；constructor 装配 `Required<ChromeKillDeps>`，缺省 instance-record 实现（isPidAlive / killProcessGroupByPid）+ `execSync(cmd, {stdio:'ignore'})`——与 336 AttachKillDeps 同构 |
| H2（connect catch 补 kill 组 + watchdog） | ✅ `closeMcpClientThenTransport` 之后：`pid = transport.pid`；`pid !== undefined && isPidAlive(pid)` → try killProcessGroup(pid) catch{}（best-effort）；随后 `killOrphanMcpWatchdog(pid)`。新私有方法 `killOrphanMcpWatchdog(mcpPid)`：win32 跳过 + `killDeps.execPkill(\`pkill -9 -f "chrome-devtools-mcp.*--parent-pid=${mcpPid}"\`)` try/catch（best-effort）——逻辑与 336 G5 一致；清理顺序 graceful close → kill 组 → watchdog ✅ |
| H3（connect 支持 signal abort） | ⚠️ **实现形态偏离**（见偏离 1）：用私有 `withAbort` 包装（abort 监听 reject BrowserError('attach_failed')，then 回调吞 settle 不留 unhandled rejection；无 signal 原样返回零变化）替代 change_plan 的「Promise.race + abortPromise」；**abort → 走现有 catch → H2 清理** ✅（契约语义达成） |
| H4（connectAttachSession 第三参 signal + 失败透传 spawnPid） | ✅ 签名 `connectAttachSession(driver, deps = {}, signal?)`；signal 透传 `driver.connect({userDataDir}, signal)`；失败分支经 `driver.getLastSpawnPid()` 取 spawnPid 返回 `{ok:false, error, spawnPid?}`（拿不到 undefined 不阻塞） |
| H5（lastSpawnPid spawn 即记 + getLastSpawnPid） | ✅ `this.lastSpawnPid = transport.pid`（mcpFactory.create 后立即，成功失败都记）；`getLastSpawnPid()` getter；disconnect 分支 `if (this.lastSpawnPid === hit.pid) this.lastSpawnPid = undefined`（与 lastMcpPid 同条件同步清）——与 lastMcpPid（仅成功 set）语义分离 |
| H6（ModeImpl.launch 可选第 4 参 signal） | ✅ `launch(key, opts, env, signal?)`；接口注释「attach 超时 abort 感知用；worker impl 忽略不实现」 |
| H7（manager.launch 可选第 3 参 ctx:{signal}） | ✅ `launch(sessionId, opts, ctx?: {signal?})` → `impl.launch(key, opts, env, ctx?.signal)`；既有调用不破坏 |
| H8（tool.ts launch 透传 ctx.signal） | ✅ launch 分支 `im.launch(sessionId, launchOpts, {signal: ctx.signal})`；**close 分支不透传**（注释：清理动作必须完整执行，被 abort 反而中断清理三层分裂） |
| H9（launch 失败分支入台账 insert 不 delete） | ✅ `!r.ok` 且 `r.spawnPid !== undefined` → `try { env.ledger.insert({key, mode:'attach', workerPid: r.spawnPid, createdAt: env.now()}) } catch warn`（best-effort）；**不 delete**（进程可能残留，留给启动自检 cleanupOrphan 回收；下次成功 INSERT OR REPLACE 覆盖；启动自检 kill 已死 pid no-op + delete 无害） |

## 偏离记录（编码期新增/调整，超出 change_plan H1-H9）

### 偏离 1：H3 实现形态 = `withAbort` 包装，非「Promise.race + abortPromise」

- **change_plan 契约**：connect 流程包 `Promise.race([流程, abortPromise])`。
- **实际实现**：私有 `withAbort<T>(p, signal, msg)`——`signal` 缺省 undefined 直接返回 p（行为零变化）；已 aborted 直接 throw；否则 Promise 包装（abort 监听 once 触发 reject BrowserError('attach_failed', msg)，p.then 回调 cleanup + resolve/reject，已 settled 后 no-op 不留 unhandled rejection）。try 内三处 await（mcpFactory.connect / listTools / callTool probe）全部经 withAbort 包装。
- **语义等价**：abort → reject attach_failed → 落现有 catch → H2 清理；信号语义、清理触发点与契约一致。**以代码为准**（形态更简洁且避免 race 竞态挂监听）。

### 偏离 2：signal 是函数签名参数，非 BrowserConnectOptions 字段

- **change_plan 契约**：「BrowserConnectOptions 支持 signal?: AbortSignal」（H3 表内注）。
- **实际实现**：signal 为独立函数参数——`driver.connect(opts, signal?)` / `connectAttachSession(driver, deps, signal?)` / `ModeImpl.launch(..., signal?)` / `manager.launch(..., ctx?: {signal?})` / tool.ts `ctx.signal`。未扩展 BrowserConnectOptions/launch options 数据结构（避免污染选项类型，且 signal 属调用上下文非连接配置）。**以代码为准**。

### 偏离 3：H2 watchdog 在 pid 非 undefined 时无条件执行（不依赖 isPidAlive）

- change_plan H2 写「① killProcessGroup（isPidAlive 守卫）② killOrphanMcpWatchdog(pid)」——代码同此序：kill 组有 isPidAlive 守卫（避免对已死 pid 发信号），watchdog 无守卫（pkill 对已死 pid 是 no-op，best-effort 恒执行）。语义与契约一致，细节以代码为准。

## 取舍说明（change_plan 已定，实现确认）

- **砍「launch 失败分支重复 kill」**：driver 是唯一持 pid 处，P0（H1/H2）已在 driver 内部清完；P2（H9 失败入台账）兜底极端残留。实现确认无重复 kill 引入。
- **P2 轻量版采纳**：lastSpawnPid（H5）+ impl 失败 insert 不 delete（H9），启动自检兜底。
- **close 不透传 signal（H8）**：close 必完整执行，被 abort 反而三层分裂。实现确认 close 分支未透传。

## 已知缺陷（本版不做）

（无新增；沿用 336 记录：close 残留检测仍只覆盖默认 user data dir，非默认目录 Chrome 漏报——保守方向，不误报优先。）

## 关键文件（编码产出）

| 文件 | 变更 |
|---|---|
| `app/server/src/tools/browser/chrome-mcp-driver.ts` | H1 killDeps DI + H2 catch 补 kill 组/watchdog + H3 withAbort + H5 lastSpawnPid/getLastSpawnPid（+104） |
| `app/server/src/tools/browser/attach-instance.ts` | H4 connectAttachSession 第三参 signal + 失败透传 spawnPid（+21） |
| `app/server/src/tools/browser/attach-mode-impl.ts` | H6 launch 第 4 参 signal + H9 失败入台账 insert 不 delete（+28） |
| `app/server/src/tools/browser/mode-impl.ts` | H6 ModeImpl.launch 签名加可选 signal（+3） |
| `app/server/src/tools/browser/instance-manager.ts` | H7 manager.launch ctx:{signal} 透传（+9） |
| `app/server/src/tools/browser/tool.ts` | H8 launch 分支传 ctx.signal，close 不透传（+4） |
| `app/server/src/tools/browser/__tests__/{attach-instance,attach-mode-impl,browser-tool,chrome-mcp-driver,instance-manager}.test.ts` | UT +25（killDeps mock / abort / spawnPid 入台账 / signal 透传 / close 不透传）；全量 10398 passed 零回归；tsc 0 error |

## 文档同步

- **tech OKF KB**：`specs/tech/agent/tools/[P1]browser_instance_manager.md`（§4.1 attach launch 补失败路径三层一致：driver connect catch 组杀/watchdog、signal abort 链路、H9 失败入台账 insert 不 delete 留给启动自检 + 文件头注记）+ `[P1]browser_tool.md`（§4.1 失败清理段升级 + target 解析补 signal 透传 launch/close 不透传 + lastSpawnPid vs lastMcpPid 语义）+ `specs/tech/agent/tools/log.md`（本条目）。
- **api**：`specs/api/overall/08-web-tools.md`（§4.3 attach 连接失败行补失败清理 + 版本尾注 +1.8）。
- **336 补记**：已满足——336 change_plan.md 已标 G3 已砍 + change_log.md 已含决策记录（12facdb92 随合并进入本 worktree），无需重复补记。
