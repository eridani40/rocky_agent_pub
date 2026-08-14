# v0.0.337 change_plan：attach launch 失败/超时 mcp+watchdog 残留修复

> 架构期冻结契约。coder 按此实现，reviewer 按此查偏离。coder/doc-modifier 不改本文件；事后偏差写 `change_log.md`。
> 上游：`reqs/[working] v0.0.337.attach-launch-failure-leak.md` + bug-analyst 报告 `reports/bug-v0.0.336-attach-launch-failure-process-leak-2026-08-12.md`（leader 2026-08-12 14:52 派单）。
> worktree：`worktrees/v0.0.337-attach-launch-failure-leak`（**已含 336 close 修复 G4/G5/G6**：AttachKillDeps DI + killOrphanMcpWatchdog 实例方法）。
> 边界：只补 launch 失败/超时路径的进程清理；不改 336 已修的 close 路径、不改正常 attach 行为；复用 336 已验证机制（killProcessGroupByPid + watchdog --parent-pid 锚定），不发明新机制。

## 根因核实（代码实证，337 worktree）

| # | 根因 | 文件:行（337 现状） |
|---|---|---|
| ① | driver.connect 失败清理只 SDK graceful close（只杀 mcp 主进程本身），**无 kill 进程组 + 无 watchdog kill** —— 与 336 修复前 close 同构 | `chrome-mcp-driver.ts:138-150` catch → `closeMcpClientThenTransport`（:236-250） |
| ② | tool.ts launch/close 分支**不透传 ctx.signal**（仅 execute 分支 :150-151 透传）→ engine backstop 30s abort 后底层 connect 继续跑（handshake 30s / SDK callTool 60s 超时），期间进程无人管 | `tool.ts:141-146`；`instance-manager.ts:209` launch 无 signal；`mode-impl.ts:80` ModeImpl.launch 无 signal；`attach-mode-impl.ts:64` launch 无 signal |
| ③ | ledger.insert **仅 launch 成功时**（attach-mode-impl.ts:88-99）→ 失败不入台账 → 启动自检 cleanupOrphans 找不到 → 极端残留（P0 清理失败时）无人回收 | `attach-mode-impl.ts:88-99` |

336 修复参照（已含于本 worktree）：`attach-mode-impl.ts:33-47` AttachKillDeps（isPidAlive/killProcessGroup/execPkill DI）、`:150-240` close 的 G4/G5 清理、`:212-240` killOrphanMcpWatchdog（`pkill -9 -f "chrome-devtools-mcp.*--parent-pid=${mcpPid}"`，win32 跳过）。

## 变更清单（method 级）

| # | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| **P0：driver connect 失败清理升级（治本单点）** |
| H1 | `chrome-mcp-driver.ts` | `ChromeMcpDriverOptions` + constructor | 修改 | options 加可选 `killDeps?: { isPidAlive?; killProcessGroup?; execPkill? }`（对齐 336 AttachKillDeps 形态，DI 便于 UT mock）；constructor 装配 `this.killDeps = { isPidAlive: ..., killProcessGroup: ..., execPkill: ... }`（缺省 instance-record 实现 + execSync stdio ignore）。 | MUST 与 336 AttachKillDeps 同构（不发明新 DI 形态）；MUST 缺省真实实现 | attach-mode-impl.ts:33-47 | +10 |
| H2 | `chrome-mcp-driver.ts` | `connect` catch 分支（:138-150）+ 新私有 `killOrphanMcpWatchdog` | 修改/新增 | catch 里 `closeMcpClientThenTransport` 之后补：①`const pid = transport.pid; if (pid !== undefined && this.killDeps.isPidAlive(pid)) try { this.killDeps.killProcessGroup(pid) } catch {}`（杀 mcp 主进程组，SIGKILL）②`if (pid !== undefined) this.killOrphanMcpWatchdog(pid)`（杀 detached watchdog）。新私有方法 `killOrphanMcpWatchdog(mcpPid)`：win32 跳过 + `try { this.killDeps.execPkill(\`pkill -9 -f "chrome-devtools-mcp.*--parent-pid=${mcpPid}"\`) } catch {}`（best-effort）——**逻辑与 336 G5 完全一致**。 | MUST best-effort（kill 失败不阻断后续 throw attach_failed）；MUST 以 transport.pid 锚定（禁无差别 pkill）；win32 跳过；失败清理顺序：graceful close → kill 组 → watchdog | 336 attach-mode-impl.ts:150-240 | +16 |
| **P1：超时 abort 感知（signal 透传 launch 分支）** |
| H3 | `chrome-mcp-driver.ts` | `connect(opts)` | 修改 | `BrowserConnectOptions` 支持 `signal?: AbortSignal`（types.ts 见 H6 注）。connect 流程（mcpFactory.connect + listTools + callTool 整段）对 abort 敏感：abort 时抛 BrowserError('attach_failed', ...) → **走现有 catch → H2 清理**。实现：将 try 内流程包 `Promise.race([流程, abortPromise])`，abortPromise = signal 监听 once('abort') reject；finally 移除监听。 | MUST abort → 走 catch（触发 H2 清理），不另起清理路径；无 signal 时行为零变化；handshake 30s withTimeout 保留 | chrome-mcp-driver.ts:97-157; mcp-factory.ts:70-78 | +12 |
| H4 | `attach-instance.ts` | `connectAttachSession` | 修改 | 签名加可选 `signal?: AbortSignal`（第三参），透传 `driver.connect({ userDataDir, signal })`。失败时透传 driver 暴露的 spawn pid（见 H5）供 impl 台账兜底：返回 `{ ok:false, error, spawnPid? }`。 | MUST 透传 signal 不改 driver 语义；spawnPid 仅在 driver 暴露时返回（缺省 undefined 不阻塞） | attach-instance.ts:72-93 | +6 |
| H5 | `chrome-mcp-driver.ts` | `lastSpawnPid` + `getLastSpawnPid()` | 新增 | **spawn 即记**（mcpFactory.create 后立即 `this.lastSpawnPid = transport.pid`，成功失败都记；disconnect 清 undefined）；新 getter `getLastSpawnPid(): number \| undefined`。与现有 `lastMcpPid`（仅成功 set）区分：lastSpawnPid = 最近一次 spawn 的 pid（含失败）。 | MUST spawn 即记（失败也可读）；MUST NOT 复用 lastMcpPid 语义（那是成功锚点） | chrome-mcp-driver.ts:88-90,153-166 | +6 |
| H6 | `mode-impl.ts` | `ModeImpl.launch` 接口 | 修改 | 签名加**可选第 4 参** `signal?: AbortSignal`（worker impl 忽略不实现）。 | 可选参数（worker impl 不破坏）；接口注释注明「attach 超时 abort 感知用」 | mode-impl.ts:80 | +1 |
| H7 | `instance-manager.ts` | `launch(sessionId, opts)` | 修改 | 签名加可选第 3 参 `ctx?: { signal?: AbortSignal }`，透传 `impl.launch(key, opts, env, ctx?.signal)`。 | 可选参（既有调用不破坏）；仅透传不改语义 | instance-manager.ts:209-230 | +3 |
| H8 | `tool.ts` | run() launch 分支（:141-142） | 修改 | `await im.launch(sessionId, launchOpts)` → `await im.launch(sessionId, launchOpts, { signal: ctx.signal })`。**close 分支不透传**（close 是清理动作，被 abort 反而中断清理，无意义）。 | MUST 仅 launch 透传；close 分支保持现状（理由：close 必完整执行） | tool.ts:141-146 | +1 |
| **P2：失败入台账（启动自检兜底，轻量版）** |
| H9 | `attach-mode-impl.ts` | `launch` 失败分支（:75-76） | 修改 | `if (!r.ok)` 分支：若 `r.spawnPid !== undefined`（H4 透传）→ `try { env.ledger.insert({ key, mode:'attach', workerPid: r.spawnPid, createdAt: env.now() }) } catch warn`（**不 delete**——进程可能残留，留给启动自检 cleanupOrphan 回收；下次成功 launch INSERT OR REPLACE 覆盖同 key；启动自检 kill 已死 pid no-op + delete，无害）。 | MUST best-effort（insert 失败 warn 不阻断 return error）；MUST 不 delete（启动自检兜底语义）；key 用 launch 传入 key | attach-mode-impl.ts:75-76,88-99,212-221 | +6 |

## 取舍说明（砍/留决策）

- **砍「launch 失败分支重复 kill」（bug 报告 P1 前半）**：launch 失败时 impl **拿不到本次失败 pid**（`getLastMcpPid` 仅 connect 成功才 set，attach-instance 失败分支无 pid）；driver 是唯一持有 transport/pid 处，P0（H1/H2）已在 driver 内部完成 kill 组+watchdog 清理。impl 兜底需 driver 暴露失败 pid + 重复清理，收益重复。**用 P2（H9 失败入台账）替代**——覆盖「driver 清理失败」的极端场景（进程残留 → 台账在 → 启动自检回收），改动更小（+6 行）且不重复。
- **P2 采纳（轻量版）**：原 P2「spawn 后立即 insert、失败清理时 delete」需 driver 在 spawn 时刻通知 impl，改动面大。轻量版 = driver 记 lastSpawnPid（H5，+6 行）+ impl 失败分支 insert 不 delete（H9，+6 行），让启动自检兜底。若进程实际已被 P0 清掉，台账留死记录由启动自检 no-op 清理，无害。
- **close 分支不透传 signal（H8）**：close 是清理动作必须完整执行，被 abort 反而中断清理造成三层分裂，与老板「风雨无阻清理」原则相悖。

## 验收标准（锚定）

1. attach launch 失败（9222 404 / 未授权）→ `pgrep -f chrome-devtools-mcp` 无残留（mcp 主进程 + watchdog 均消失）。
2. attach launch 超时（30s backstop abort）→ abort 立即触发清理，mcp+watchdog 无残留。
3. 正常 attach → close 仍三层一致（336 已验证行为不回归）。
4. 失败残留极端场景（kill 失败）→ 台账有记录 → 启动自检 cleanupOrphan 回收。

## UT 要求（MANDATORY）

仓库根 `bun --bun x vitest run`（**非** `bun test`）。新增/更新：
- **H1/H2**（chrome-mcp-driver.test.ts）：mock killDeps（isPidAlive/killProcessGroup/execPkill spy）→ connect 失败（注入 handshake 失败/工具缺失/probe isError）→ 断言 killProcessGroup 被调（transport.pid）+ execPkill 收到含 `--parent-pid=<pid>` 命令；win32 跳过分支。
- **H3**（chrome-mcp-driver.test.ts）：mock AbortSignal（abort 触发）→ connect 抛 attach_failed + killDeps 清理被调；无 signal 时行为不变。
- **H4/H5**：connectAttachSession 失败时透传 spawnPid（mock driver.getLastSpawnPid）；signal 透传断言。
- **H9**（attach-mode-impl.test.ts）：launch 失败 + r.spawnPid 存在 → ledger.insert 被调（key/workerPid 断言）；不 delete；insert 失败 warn 不阻断。
- **H7/H8**：manager.launch signal 透传断言；tool.ts launch 传 ctx.signal（browser-tool.test.ts）。
- 全量零回归 + tsc 0 error。

## 影响面 / 风险

- 仅触 attach launch 失败/超时路径 + 接口可选参数透传；close 路径（336 已修）零改动；正常 attach 行为零改动（signal 缺省 undefined 时与现状逐字节一致）。
- H6/H7 接口加可选参：worker impl / 既有调用不破坏（可选参数向后兼容）。
- H5 lastSpawnPid 与 lastMcpPid 并存：语义分离（spawn 锚点 vs 成功锚点），disconnect 清两者。
- H9 失败入台账：死记录由启动自检兜底清理，无泄漏（cleanupOrphan kill 已死 pid no-op + delete）。
