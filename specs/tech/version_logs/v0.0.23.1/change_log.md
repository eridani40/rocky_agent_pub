# v0.0.23.1 技术变更日志 — Browser connectOverCDP bugfix（node worker）

> 概述：**browser bugfix 单版本**——mode①② headless/managed-profile 的 playwright 操作从「bun 主进程直接 connectOverCDP」改为**走 node 子进程一次性执行器**（`NodeWorkerDriver.executeOnce`），绕开 Bun 不支持 playwright connectOverCDP 的 bug（oven-sh/bun#9357）。**对外 API 契约零变化**，纯内部实现栈切换。
> 关联：`states/v0.0.23.1/bugs/BUG-001-browser-connectovercdp-timeout-[fixed].md`（真因 + 方案 + 验证结论权威源）；概念权威源：`specs/tech/agent/tools/[P1]browser_tool.md`（v1.1→v1.2）、`[P1]web_tools.md`（v1.1→v1.2）。
> PRD / API 同步：`specs/prd/version_logs/v0.0.23.1/change_log.md`、`specs/api/version_logs/v0.0.23.1/change_log.md`。

## 1. 真因（直接工具验证，非假设）

**Bun 运行时下 `playwright.chromium.connectOverCDP()` 永久 hang/timeout。** chrome 起来、CDP HTTP `/json/version` 就绪，但 playwright 的 WS 连接 30s 超时。

三组直接验证（绕过 LLM chat-flow，raw 调工具，符合 memory `debug-tool-issue-invoke-directly`）：

1. **raw WebSocket 直连 chrome CDP = 成功**：spawn chrome（chromium-1228，`--headless=new`，`--remote-allow-origins=*`）→ `/json/version` 返 `webSocketDebuggerUrl` → bun `new WebSocket(wsUrl)` 立即 open 成功 → chrome CDP WS 端点完全可达。
2. **A/B 排除 chrome 二进制 / flags**：chromium-1228 vs 系统 Google Chrome 都 connectOverCDP 20s 超时；`--remote-allow-origins=*` 有/无都超时；僵尸端口假设排除（端口干净、chrome 全新启动仍超时）。
3. **Bun vs Node 决定性对比**（同 chrome、同端口、同 playwright）：Bun `chromium.connectOverCDP()` → Timeout 30000ms exceeded（hang）；Node `chromium.connectOverCDP()` → 成功 608ms。

→ 根因 100% 锁定：**Bun 运行时不支持 playwright connectOverCDP**（机制：playwright spawn node driver 子进程 + stdin/stdout pipe 通信，Bun 的 child_process stdio pipe 兼容缺陷 → driver 收/发消息 hang → connectOverCDP 永不返回）。

### 上游 issue（已知 bug）
- oven-sh/bun#9357 — connectOverCDP method of playwright does not work in bun, program just hangs
- oven-sh/bun#9911 — 同样 hang/timeout
- microsoft/playwright#27139 — Playwright 官方不正式支持 Bun

### 首轮"僵尸端口"修复为何无效

首轮（进程组 SIGKILL + per-profile 端口段 + connectOverCDP 重试 + cdp-ready wsUrl 校验）基于错误假设（僵尸 chrome 占固定端口 18800）。真机验证（`/tmp/verify_bug001.ts`）：zombie 占 18800 时新 launch 自动避让到 18801 + chrome 正常就绪，但 `PlaywrightDriver.connect` 仍 `connectOverCDP: Timeout 15000ms exceeded`（两次重试都超时）。**首轮修复的代码改进保留**（进程组清理 / 端口段分配 / 就绪检测增强都是正向改进，且 worker-entry 复用），但**不是根因解**。

## 2. 修复方案（第二轮 — node worker 一次性执行器）

### 2.1 核心思路

browser tool 的 playwright 操作（connectOverCDP + page 操作）整体改走 **Node 子进程执行**，bun 主进程只 spawn worker + 传任务 + 读结果，绝不直接调 playwright.connectOverCDP。

### 2.2 设计依据：browser tool 一次性调用模式

`tool.ts` 每次 `run` = `driver.executeOnce → connectOverCDP → dispatchAction(单个 action) → close`（chrome 每次启停）。→ worker 设计为**一次性执行器**（无需长连接 RPC / 会话状态保持）。

### 2.3 架构

```
bun（NodeWorkerDriver.executeOnce）
  └─ spawn `node browser-worker.cjs`（一次性，detached 进程组）
       ├─ stdin  读一行任务 JSON
       ├─ worker 内（node）: spawn chrome → waitForCdp → connectOverCDP(✅) → dispatchAction → killProcessGroup
       ├─ stdout 输出一行结果 JSON: {ok,text?} | {ok:false,error:{kind?,message}}
       └─ exit
  └─ 读 stdout 第一行 → BrowserExecuteResult；超时 30s / abort → killProcessGroup
```

三流分离：stdin 任务 / stdout 结果（单行 JSON）/ stderr 诊断（失败时拼进 error.message）。

## 3. tech spec 改动清单（concept-first）

| spec | version | 改动摘要 |
|------|---------|---------|
| `agent/tools/[P1]browser_tool.md` | 1.1 → 1.2 | §1 概述表 mode①② driver 改 `NodeWorkerDriver`（playwright 经 node 子进程）；§2 `BrowserDriver` 加可选 `executeOnce`；§3 整段重写为 `NodeWorkerDriver` 架构（§3.1 架构图 / §3.2 一次性执行器依据 / §3.3 文件级实现 / §3.4 复用首轮修复 / §3.5 chrome 发现+启动参数 / §3.6 mode②持久 profile / §3.7 旧 PlaywrightDriver 路径保留）；§7 tool 层 mode①② 走 executeOnce、mode③ 仍走 connect；§10 边界 / §12 版本同步 |
| `agent/tools/[P1]web_tools.md` | 1.1 → 1.2 | §3.3 同步 `browser_tool.md` v1.2——mode①② driver 改 NodeWorkerDriver，`BrowserDriver` 加可选 executeOnce；顶部 version 同步 |

## 4. 落地清单（文件级变更 — 精确到文件/方法）

### 4.1 新增

| 文件 | 角色 | 关键点 |
|---|---|---|
| `app/server/src/tools/browser/worker-entry.ts` | **node 侧**一次性执行器 | `readTaskFromStdin()`（5s 超时防挂起）→ `launchChromeAndConnect()`（复用 chrome-launcher：进程组 spawn + cdp-ready + connectOverCDP）→ `dispatchAction(browser, action, params)`（navigate/snapshot/click/type/listPages/selectPage/evaluate/screenshot，参照 playwright-session.ts 纯 page 操作）→ `kill()` cleanup → `emit({ok,text?}\|{ok:false,error})`；三流分离；可被 `bun build --target=node --format=cjs --external=playwright` 打包 |
| `app/server/src/tools/browser/browser-worker.cjs` | **编译产物**（随包发布） | `bun build worker-entry.ts --target=node --format=cjs --external=playwright` 生成 |
| `app/server/src/tools/browser/__tests__/node-worker-driver.test.ts` | UT（mock spawn） | executeOnce spawn / 传参 / 读 stdout / 超时 / abort / 进程清理 |
| `app/server/src/tools/browser/__tests__/node-worker-driver.e2e.test.ts` | 真机 e2e | node worker → spawn 真 chrome → connectOverCDP → navigate/snapshot/screenshot/evaluate（4/4 绿） |

### 4.2 修改

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/tools/browser/node-worker-driver.ts` | 新增（mode①② driver） | `NodeWorkerDriver.executeOnce(opts, action, params, signal)`：解析连接参数（resolveUserDataDir/allocateCdpPort/mkdtempSync）→ spawn `node browser-worker.cjs`（cwd=worktree 根，detached 进程组）→ stdin 写任务 JSON → 读 stdout 第一行结果 → 超时 30s / abort / exit 非 0 全捕获转 `{ok:false,error}` → finally killProcessGroup；`connect()` 不实现（抛错）；`WorkerSpawnDeps` 可注入 spawn（测试 mock） |
| `app/server/src/tools/browser/types.ts` | 修改 | `BrowserDriver` 加可选 `executeOnce(opts, action, params, signal): Promise<BrowserExecuteResult>`；新增 `BrowserActionParams`（{url?,ref?,text?,format?}）+ `BrowserExecuteResult`（{ok,text?,error?}）类型；executeOnce 注释说明 mode①② 用、connect 仅 mode③ 用 |
| `app/server/src/tools/browser/tool.ts` | 修改 | mode①② 分支优先调 `driver.executeOnce`（executeResult → textResult/errorResult）；仅当 driver 未实现 executeOnce 时兜底走旧 `connect → dispatchAction → close`（兼容旧 PlaywrightDriver UT mock）；新增 `extractActionParams` + `formatExecuteError` helper |
| `app/server/src/tools/browser/pick-driver.ts` | 修改 | `InMemoryDriverRegistry` 注入 NodeWorkerDriver（headless/managed-profile 共用同一实例，mode 在 executeOnce 时按 opts.profileName 推断）；注释说明 v0.0.23.1 起生产用 NodeWorkerDriver |

## 5. 复用的首轮修复（v0.0.23.1 第一轮，保留 + worker 复用）

| 改进 | 落地 | worker 复用 |
|---|---|---|
| 进程组 SIGKILL | `chrome-launcher.killProcessGroup`：spawn `detached:true`，`process.kill(-pgid,'SIGKILL')` 清整个进程树 | worker-entry + NodeWorkerDriver 都用 |
| per-profile CDP 端口段 18800-18899 | `allocateCdpPort` 取段内首个未占用 + `netPortBusy` 探测 | NodeWorkerDriver.executeOnce 用 |
| cdp-ready wsUrl 校验 | HTTP 200 后校验 `webSocketDebuggerUrl` 非空 | worker-entry.launchChromeAndConnect 用 |
| chrome stderr 捕获 | spawn `stdio:'pipe'`，失败拼进 errorDetail | worker-entry + NodeWorkerDriver.stderrBuf 用 |

## 6. 验证结论（PASS — bugfix 生效）

核心铁证：**connectOverCDP 在 node worker 下完全工作，不再超时。**

1. **coder vitest 真机 e2e 4/4 绿**（`node-worker-driver.e2e.test.ts`）：NodeWorkerDriver.executeOnce → node worker → spawn chrome → connectOverCDP（成功）→ navigate/snapshot/screenshot/evaluate 全通。
2. **br_headless_tc1 真服务 PASS**（真 LLM chat-flow 端到端）：LLM 调 browser navigate https://example.com + snapshot，走 NodeWorkerDriver → node worker → connectOverCDP（成功，isError=False，无超时）。
3. **UT 回归 238 passed**（browser + web-fetch，reviewer 改动无回归）+ typecheck 0。
4. managed-profile 走同一 NodeWorkerDriver 链路（profile/singleton-lock 逻辑 UT 覆盖），核心 connectOverCDP 已由 headless 端到端铁证。

**附带 test 基建修复**：`br_headless_tc1/run.sh` 的 SSE 解析 bug（用 `tool_result_end.content`[空] + `tool_call_end`[toolName=None]，应改 `tool_result_delta.delta` + `tool_call_start`，memory `test-env-build-gotchas`）—— pre-existing，顺手修。

## 7. 范围外（pre-existing，不修 — 记录）

- **attach ③**（chrome-devtools-mcp --autoConnect 连不上用户 chrome）：用户另报，单独排查。本次 attach 路径完全不动（仍走 `connectorManager.getAttachSession` → ChromeMcpDriver）。
- **click/type 跨 tool 调用的 refs 状态丢失**：snapshot ref id 是 `role-slug-nth`，name 被 slug 化丢原值；一次性 worker 内 `lastRefs` 每次新建重置 → 跨调用失效。现状即跨调用失效，本次保持现状行为。

## 8. 关联

- BUG 权威：`states/v0.0.23.1/bugs/BUG-001-browser-connectovercdp-timeout-[fixed].md`
- 概念权威：`specs/tech/agent/tools/[P1]browser_tool.md` v1.2 §3 / §7
- memory：`bun-playwright-connectovercdp-bug`、`debug-tool-issue-invoke-directly`、`test-process-cleanup-or-crash`
