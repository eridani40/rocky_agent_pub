# v0.0.336 change_plan：attach close 进程残留 + launch 复用死连接修复

> 架构期冻结契约。coder 按此实现，reviewer 按此查偏离。coder/doc-modifier 不改本文件；事后偏差写 `change_log.md`。
> 上游：bug-analyst 根因报告 `reports/bug-v0.0.336-attach-close-process-leak-2026-08-12.md`（leader 13:43 派单）。
> worktree：`worktrees/v0.0.336-attach-close-cleanup`（已含 334 userDataDir 修复 2545b939a）。
> 边界：仅优化 close/launch 一致性；不动 attach 连接逻辑（userDataDir 已修）、不动 headless/managed-profile、不扩其他优化。

## 根因核实（代码实证，文件:行 已在 worktree 逐一核对）

### 根因 1（P0）：close 不回收 MCP 进程组（mcp 主进程 + watchdog 残留）

close 链路：`im.close()` → `closeInstance()` → `AttachModeImpl.close()`（attach-mode-impl.ts:120-145）= `disconnectAttachSession()` + `ledger.delete()` + 残留检测（只读）。**全程不杀进程**。

进程杀的唯一机会在 SDK `StdioClientTransport.close()`（`@modelcontextprotocol/sdk/.../client/stdio.js:144-174`）：`stdin.end()` → 2s → `SIGTERM` → 2s → `SIGKILL`，**只杀 `this._process`（mcp 主进程，spawn 选项 :72 无 detached）**。

watchdog 是 `chrome-devtools-mcp/.../telemetry/WatchdogClient.js:32-36` spawn，`detached:true`（**独立进程组**，自己当 pgid）+ `unref()`，自杀依赖 stdin close；但 mcp 主进程被 SIGTERM 后 shutdown 调 `closeBrowser()`（puppeteer.disconnect 老板 Chrome）卡住 → stdin 不关闭 → **watchdog 收不到死亡信号 → 孤儿残留**（老板 Chrome 卡「受自动测试软件控制」横幅）。

**关键架构事实**：`killProcessGroupByPid(mcpPid)` 用 `process.kill(-mcpPid,'SIGKILL')`（instance-record.ts:33-40）杀的是 **mcp 主进程的进程组**；watchdog 因 detached **不在该组内**，单靠它**杀不到 watchdog**。这是 P0 必须显式处理的核心洞。

### 根因 2（P1）：launch 复用死连接 / 谎报成功 —— 真根因 = connect/disconnect cache key 不对称

**实证**（比 bug 报告字面「disconnect 抛错被吞」更准）：
- `connectAttachSession` 调 `driver.connect({ userDataDir })`（attach-instance.ts:83，334 fix 注入）→ cacheKey = `["null","<userDataDir>"]`。
- `disconnectAttachSession` 调 `driver.disconnect({})`（attach-instance.ts:105）→ cacheKey = `["null","null"]`。
- `cacheKey`（chrome-mcp-driver.ts:202-207）序列化 `[profileName??null, userDataDir??null]` → 两 key **必不相等**。
- `disconnect`（chrome-mcp-driver.ts:185-200）`cache.get(mismatchKey)` → **miss → 直接 return（:188），cache 永不清**。
- 下次 `connect`（chrome-mcp-driver.ts:97-100）`cache.get(connectKey)` → **hit 直接 `return hit.session`（:100），不 probe 活性** → 复用死 session → listPages `Not connected` / launch 谎报。

**引入时机**（git 实证）：334 T1（03c0a7dbd）删 cdpUrl 把 disconnect 从 `{cdpUrl}` 改 `{}`；334 fix（2545b939a）给 connect 注入 userDataDir。两者叠加 → key 不对称。这是 334 回归的另一半。

---

## 变更清单（method 级）

| # | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| **P1：cache key 对称 + 活性校验（先修，是谎报根因）** |
| G1 | `attach-instance.ts` | `disconnectAttachSession` | 修改 | `driver.disconnect({})` → `driver.disconnect({ userDataDir })`，userDataDir 用与 `connectAttachSession` **同一解析逻辑**（复用 `resolveDefaultChromeUserDataDir`，见 G2），保证 connect/disconnect cacheKey 一致。失败仍 catch warn 不抛（幂等语义不变）。 | MUST 与 connect 用同一 userDataDir 解析结果；MUST NOT 改 connect 已有 userDataDir 注入 | attach-instance.ts:105,83; chrome-mcp-driver.ts:202-207 | +6 |
| G2 | `attach-instance.ts` | `resolveDefaultChromeUserDataDir` | 修改（提为模块级复用） | 现为 connectAttachSession 内联/局部；提升为模块级可复用（connect/disconnect 共用），签名 `(deps?: ConnectAttachDeps) => string \| undefined`，依赖注入保留（UT mock existsSync/homedir/platform）。 | 单一数据源，禁 connect/disconnect 各自双写解析 | attach-instance.ts:39-44 | +4 |
| ~~G3~~ **（已砍，v0.0.336 编码期裁决：不做）** | ~~`chrome-mcp-driver.ts` `connect`（cache hit 分支）~~ | ~~修改~~ | ~~cache hit 时**不直接 return**，先 probe 活性：对 `hit.session` 跑一次轻量探活（复用 `REQUIRED_MCP_TOOL` 即 list_pages callTool，`hit.client.callTool({name:REQUIRED_MCP_TOOL,arguments:{}})`，查 `isError`）；探活失败/抛错 → 视为死连接：`cache.delete(key)` + `closeMcpClientThenTransport(hit.client,hit.transport)` 清尸，**继续走下方新建连接流程**；探活成功 → `return hit.session`。~~ | ~~MUST 仅 cache hit 路径加探活；cache miss 现有 probe（:130）不动；探活失败必须清 cache+清尸再重连，禁返回死 session~~ | ~~chrome-mcp-driver.ts:97-100,130-137,236~~ | ~~+14~~ |

> **`[v0.0.336]` G3 已砍（编码期裁决，leader + review 确认）**：表项 G3 原计划在 cache hit 分支加 list_pages 探活防死连接复用。实际实现发现——G1/G2 修 cache key 对称后，disconnect 能正常清 cache，死连接复用路径已被根除；cache hit 只可能来自「本 run 内同 session 同 mode 的幂等复用」（connect 后未 disconnect 的合法复用），此时 session 必然活。再加探活属于防御纵深但引入每次复用多一次 MCP round-trip 开销，且 cache hit 死连接场景（跨 run 残留）已被「启动自检清台账 + 失活自愈清账」覆盖。**裁决：不做 G3**，谎报根因由 G1/G2（key 对称）根治。
| **P0：close 显式回收进程组（mcp 主进程 + watchdog）** |
| G4 | `attach-mode-impl.ts` | `AttachModeImpl.close` | 修改 | `disconnectAttachSession(env.attachDriver)` 之后、`ledger.delete` 之前，新增显式回收：① 若 `ah.mcpPid !== undefined && isPidAlive(ah.mcpPid)` → `killProcessGroupByPid(ah.mcpPid)`（杀 mcp 主进程组，SIGKILL，best-effort try/catch warn 不阻断）；② 再调 G5 的 watchdog 兜底回收。复用已 import 的 `isPidAlive`/`killProcessGroupByPid`（:21）。 | MUST best-effort（kill 失败 warn 不阻断后续 ledger.delete + 残留检测）；MUST NOT 杀用户 Chrome（仅 mcp 进程组 + watchdog）；不杀 chrome 语义不变 | attach-mode-impl.ts:120-145,21; instance-record.ts:33-40 | +10 |
| G5 | `attach-mode-impl.ts` | `killOrphanMcpWatchdog`（新增模块级 helper） | 新增 | 兜底杀 watchdog：因 watchdog detached 独立进程组、`killProcessGroupByPid(mcpPid)` 杀不到，按 **mcpPid 定位**（watchdog 启动参数含 `--parent-pid=<mcpPid>`，WatchdogClient.js:15）执行 `pkill -9 -f "chrome-devtools-mcp.*--parent-pid=${mcpPid}"`（经 `execSync`/`spawnSync`，best-effort try/catch）；仅当 `mcpPid` 已知时执行，无 mcpPid 跳过（退化为 G4 进程组杀覆盖 mcp 主进程）。 | MUST 以 mcpPid 精确定位（禁无差别 pkill chrome-devtools-mcp 误杀其他会话/模式的 mcp）；best-effort；仅 POSIX（darwin/linux），win32 跳过（attach 暂不支持 win 调试态路径，对齐 devToolsActivePortCandidates win 仅单候选现状） | WatchdogClient.js:15,32-36; attach-mode-impl.ts:152-157 | +14 |
| G6 | `attach-mode-impl.ts` | `cleanupOrphan` | 修改（补强） | 现有 `killProcessGroupByPid(rec.workerPid)` 后补一句 G5 watchdog 兜底（`rec.workerPid` 即 mcpPid），保证启动自检路径也回收 watchdog。 | 对齐 G4 同一回收逻辑（抽共用） | attach-mode-impl.ts:152-157 | +3 |

## 取舍说明（P2/P3 不纳入）

- **P2（close 后短轮询确认 mcp 死再删台账）**：不纳入。G4/G5 已 SIGKILL 同步强杀（`process.kill(-pid,'SIGKILL')` + `pkill -9` 即时生效，无 SDK 4s 优雅窗等待），mcp+watchdog 当场死，无需轮询确认后再删台账；ledger.delete 保持现有「删后无残留」语义。SIGKILL 不可捕获，不存在「卡住不退」。
- **P3（按进程名独立扫描兜底）**：不纳入为独立机制。G5 已内联「按 `--parent-pid` 精确定位 watchdog」的兜底（=P3 思想的精确化，避免无差别进程名扫描误杀其他会话/模式的 chrome-devtools-mcp）。G4+G5+cleanupOrphan(G6) 已闭环，无需另起全局扫描器。

## 验收标准（锚定，ET 实测）

1. attach → close 后 `pgrep -f chrome-devtools-mcp` 无残留（mcp 主进程 + watchdog 均消失）。
2. 老板 Chrome「受自动测试软件控制」横幅消失（mcp 进程死 → CDP attach 释放）。
3. attach → close → 再 attach：launch 不谎报（cache 已对称清理 + G3 探活），`list_pages` 返回真实标签页（非 `Not connected`）。
4. attach 中强杀 rocky_agent → 重启 → 启动自检 cleanupOrphan 回收 mcp+watchdog（G6）。

## UT 要求（MANDATORY）

仓库根 `bun --bun x vitest run`（**非** `bun test`）。新增/更新（`app/server/src/tools/browser/__tests__/`）：
- **P1**：connect/disconnect 用同一 userDataDir 时 cacheKey 一致（disconnect 后 cache 清空）；`connect` cache hit 探活——活则复用、死则清 cache+清尸重连（mock callTool isError / 抛错两分支）。
- **P0**：`close` 后 mcpPid 存活时 `killProcessGroupByPid` 被调 + watchdog pkill 被触发（mock isPidAlive/killProcessGroupByPid/execSync）；mcpPid undefined 时跳过 kill 不阻断；`cleanupOrphan` 含 watchdog 兜底。
- 全量零回归 + tsc 0 error。

## 影响面 / 风险

- 仅触 attach 模式 close/connect/disconnect/cleanupOrphan；headless/managed-profile 不动。
- G1/G2 修 cache key 对称，对 connect 无行为变更（userDataDir 解析同一逻辑）。
- G3 cache hit 加一次 list_pages 探活，attach 复用场景多一次 round-trip（可忽略）；防谎报收益远大于开销。
- G5 pkill 以 `--parent-pid` 精确锚定，无误杀风险；win32 跳过（对齐现状）。
