---
type: research
title: Browser managed-profile 模式生命周期问题调研
priority: P1
status: active
updated: 2026-08-06
author: researcher
---

# Browser managed-profile 生命周期调研 — 为什么 Chrome 窗口「动一下就消失」

## 1. 问题现象

用户报告：browser 工具以 `managed-profile` 模式启动后，Chrome 窗口「动一下就消失了」——agent 没有主动关闭它，但 browser 实例不在了。用户预期 browser 以 **instance 方式**工作，可以跨多次交互持续存在。

## 2. 根因（一句话）

**managed-profile 模式每次 tool_call 都是「全新 spawn Chrome → 执行单个 action → 立刻 SIGKILL 整个 Chrome 进程树」**——Chrome 进程寿命 = 单次工具调用。窗口消失不是 bug，是当前架构的必然结果。

## 3. 代码证据链

### 3.1 入口：headless/managed-profile 走 executeOnce（一次性执行）

`app/server/src/tools/browser/tool.ts:188-224`：

```ts
// headless/managed-profile：自启 driver
// 走 driver.executeOnce（node worker 子进程绕开 Bun playwright bug）。
const driver = pickDriver(reg, mode);
if (driver.executeOnce) {
  const params = extractActionParams(action, typed);
  const r = await driver.executeOnce(connectOpts, action, params, ctx.signal);
  ...
}
```

### 3.2 driver：每次 executeOnce 全新 spawn worker 子进程

`app/server/src/tools/browser/node-worker-driver.ts:94-121`：

```ts
async executeOnce(opts, action, params, signal) {
  const persistent = !!opts.profileName;          // managed-profile = 有 profileName
  const userDataDir = opts.userDataDir ?? (persistent
    ? resolveUserDataDir(this.dataDir, profileName)  // 持久目录 ~/.rocky_agent/browser/<name>/user-data
    : mkdtempSync(join(tmpdir(), 'rocky-browser-worker-')));  // headless 用临时目录
  ...
  return this.runWorker(task, signal);            // spawn node worker 子进程
}
```

worker 退出兜底也杀进程组（`node-worker-driver.ts:148-163` `finish()` → `killProcessGroup(child)`）。

### 3.3 worker：launch chrome → 1 个 action → kill chrome → exit

`app/server/src/tools/browser/browser-worker.cjs:648-684`（worker-entry.ts 编译产物）：

```js
async function main() {
  task = await readTaskFromStdin();              // 读一个任务（单次）
  const r = await launchChromeAndConnect({...}); // spawn Chrome（--remote-debugging-port + --user-data-dir）
  browser = r.browser; kill = r.kill;
  const text = await dispatchAction(browser, task.action, task.params);  // 执行【单个】action
  await kill();                                  // ← SIGKILL 杀 Chrome 整个进程树
  emit(result, ...);                             // 输出结果 → worker 退出
}
```

`kill` 实现（`chrome-launcher.ts:401-407, 414-424`）：`killProcessGroup(child)` = `process.kill(-pid, 'SIGKILL')`（detached 进程组，renderer/GPU/network-service 全清）。

### 3.4 Chrome 窗口出现的原因

`node-worker-driver.ts:115`：`headless: persistent ? opts.headless : opts.headless ?? true` —— managed-profile（persistent=true）时 headless 未显式设置则为 **false** → Chrome **有头**启动（spec §3.6「登录态复用」需要可见窗口）。所以用户看得到窗口；headless 模式 `headless=true` 无窗口。

## 4. managed-profile 的设计意图 vs 实际行为

| 维度 | 设计意图（spec + 代码注释） | 实际行为 | 用户预期 |
|---|---|---|---|
| profile 数据 | **持久**（`~/.rocky_agent/browser/<name>/user-data`，登录态/扩展/历史复用，spec §3.6） | ✅ 持久（userDataDir 跨调用不变） | — |
| Chrome 实例 | 「一次性执行器，无会话状态保持」（spec §3.2 明确设计） | ❌ 每次 tool_call spawn+kill | **常驻 instance，跨交互持续存在** |
| 跨调用状态 | 无（refs 不跨 action，spec §3.2/§9 已声明 pre-existing 限制） | ❌ 每次全新 | 页面/登录态/操作连续性 |
| 生命周期持有者 | worker 进程（单任务后自杀） | 无任何方持有 | 平台/agent 持有 |

**核心语义错位**：`managed-profile` 这个名字 + 用户预期暗示「平台管理一个 Chrome **实例**」；实际实现管理的只是「profile **数据目录**」，Chrome **进程**每次用完即杀。**设计意图本身就不是 instance**——这是 BUG-001（Bun 不支持 playwright.connectOverCDP）workaround 的架构副产物，spec §3.2 白纸黑字：「worker 设计为一次性执行器」。

## 5. 三 mode 生命周期对比

| mode | driver | Chrome 进程 | 生命周期 | 跨调用状态 |
|---|---|---|---|---|
| ① headless | NodeWorkerDriver.executeOnce | 平台 spawn，**action 后 SIGKILL** | tool_call 级 | 无（临时目录） |
| ② managed-profile | NodeWorkerDriver.executeOnce | 平台 spawn，**action 后 SIGKILL** | tool_call 级 | 仅 profile 数据，无进程/页面状态 |
| ③ attach | ChromeMcpDriver.connect + ConnectorManager | **用户自启**，平台不杀（chrome-mcp-driver.ts:25「只清 emulation / detach，不杀用户 chrome」） | session 级（attachSession 缓存复用，connector-manager.ts 门禁 3） | 有（真实浏览器页面/登录态） |

**结论**：① ② 是「一次性执行器」（每次 spawn+kill）；③ 是真正的长生命周期 instance（但要求用户手动开 Chrome + remote debugging，门槛高）。用户报的问题 = ② 被当成 ③ 用了。

**headless 为什么「没问题」**：它**同样被清理**（每次 SIGKILL），只是 `--headless=new` 无窗口 + 临时目录全新状态，用户感知不到。不是行为不同，是可见性不同。

## 6. 修复方向（让 managed-profile 成为真 instance）

### 方向 A：长生命周期 worker 常驻（推荐，改动最平滑）

把 worker 从「单任务 + exit」升级为「循环读任务 + 响应 + 保持」：

- worker 内 `launchChromeAndConnect` 后**不退出**，进入 stdin/stdout JSON-RPC 循环（每行一个请求/响应）
- driver 侧按 `profileName` 缓存 worker 子进程（首次 spawn + launch，后续 action 复用同一 worker + 同一 Chrome）
- 关闭时机：agent session 结束 / 显式 disconnect / idle 超时 → 才 kill chrome + worker
- 优点：复用现有 playwright-in-node 技术栈（node 下 connectOverCDP 正常）；改动局限在 worker 协议 + driver 生命周期管理；Chrome 窗口常驻，refs/登录态/页面天然跨调用保持
- 需处理：SingletonLock（profile 锁）在常驻模式下由持有者长占；多 session 并发访问同一 profile 的 owner 语义（对齐 attach ConnectorManager 门禁）；worker 崩溃恢复（检测 exit → 下次调用重建）

### 方向 B：平台级 Browser Instance Manager（对齐 attach 治理模型）

仿 ConnectorManager 建一个「managed-profile 实例管理器」：平台 spawn 并持有常驻 Chrome（仍经 node worker 连 CDP，或原生 WebSocket CDP），tool_call 只 connect 执行 action，不负责 kill。生命周期 = session 结束 / 显式关闭。

- 优点：与 attach 的 owner/session 治理模型统一，语义最干净
- 缺点：新增一个常驻管理器，架构成本高于 A

### 方向 C：弃 playwright，Bun 主进程直连 CDP（puppeteer-core / 原生 WS）

Chrome `--remote-debugging-port` 本身暴露标准 CDP over WebSocket，Bun 原生 WebSocket/fetch 可直连，彻底绕开 playwright 的 Bun bug。

- 优点：无 worker 进程，架构最简
- 缺点：listPages/snapshot/click/type/evaluate 全部要自封装 CDP 命令，工作量最大；与现有 worker-actions.ts 能力重叠

### 建议

1. **产品语义确认**（需 leader/用户拍板）：managed-profile 应定义为「常驻 Chrome 实例（窗口保持 + 跨调用状态）」——用户报告已明确表达此预期，方向上应支持。
2. **短期**：方向 A 落地（长生命周期 worker），与现有代码路径最近、风险可控。
3. **长期**：方向 B 统一三 mode 治理（attach 已有 ConnectorManager，managed-profile 并入同类模型），方向 C 视 puppeteer-core 引入成本再评估。
4. headless 保持现状（一次性 + 临时目录）无用户可感知问题，不强制改。

## 7. 关键文件索引

| 文件 | 作用 |
|---|---|
| `app/server/src/tools/browser/tool.ts:188-224` | mode①② 入口，executeOnce 路由 |
| `app/server/src/tools/browser/node-worker-driver.ts:94-121,148-163` | 每次 spawn worker + 兜底杀进程组 |
| `app/server/src/tools/browser/browser-worker.cjs:648-684` | worker 主循环：launch → 1 action → kill → exit |
| `app/server/src/tools/browser/chrome-launcher.ts:401-424` | killProcessGroup SIGKILL |
| `app/server/src/tools/browser/connector-manager.ts:172-252` | attach 长生命周期参照（门禁 3 同 owner 复用） |
| `app/server/src/tools/browser/chrome-mcp-driver.ts:25,159-188` | attach close 语义：不杀用户 chrome |
| `specs/tech/agent/tools/[P1]browser_tool.md §3.2` | 「一次性执行器」设计依据（架构根因） |
| `states/v0.0.23.1/bugs/BUG-001-browser-connectovercdp-timeout-[fixed].md` | Bun playwright bug 原始证据 |
