# v0.0.34 Tech Change Log — browser attach 连接治理（禁止自启 + 判据真实化）

> version: 1.0 · 2026-06-28
> 范围红线（严守）：**唯一实现文件 `app/server/src/tools/browser/chrome-mcp-driver.ts`**。无新 API、无 UI 变更、无新 PRD。两个 bug 修复（BUG-008 禁止自启 + BUG-009 判据真实化）+ 确认一个「无需代码」的失败即停语义（BUG-009 配套）+ 撤回一项（进程树杀）。
> 权威输入：`reqs/v0.0.34/req.md` + `specs/research/v0.0.34-attach-connect.md` + `states/v0.0.34/design.md`（architect 产出）。
> 简化流程：coding → code-review → api-verify → doc-modifier（本文件）。

---

## 1. 改动摘要

browser 工具 mode③（attach）的**连接治理**：

1. **BUG-008 禁止自启 chrome**：attach 默认走 `--browserUrl loopback`（不再 `--autoConnect`），连不上即报错，绝不静默自启空 chrome。
2. **BUG-009 判据真实化**：`connect()` 在 handshake + listTools 后真跑一次 `list_pages` round-trip 确认已 attach 上目标 chrome——对齐 chrome-devtools-mcp 1.4.0 惰性连接机制（handshake/listTools 阶段根本不碰 chrome）。
3. **失败即停**：connect 失败（含 probe 失败）→ `connection=error`、`switch=off`，intent 保持 on 但不自动重连——无新代码（现状已满足），本版文档化该语义于 `connectors.md §3.3`。
4. **撤回**：进程树杀（`terminateChromeMcpProcessTree`）不做——实测 chrome-devtools-mcp watchdog 随父进程死，SDK 阶梯杀（stdin.end→SIGTERM→SIGKILL）足够。

---

## 2. 根因分析

### BUG-008（自启）

`buildChromeMcpArgs` 无 `browserUrl` 时 push `--autoConnect` → 落 chrome-devtools-mcp channel 分支 → 目标 chrome 没开时 puppeteer 用 channel **静默自启一个空 chrome**（实测「不开 chrome，list_pages 仍返 5 页」即此空 chrome）。

### BUG-009（判据虚假）

chrome-devtools-mcp **惰性连接**（源码 `index.js` + `ToolHandler.js` 验证）：`ensureBrowserConnected`（含 puppeteer.connect）只在 `getContext()` 首次被调用时执行，而 `getContext` 仅在 `ToolHandler.handle()` 跑某个 page 工具时触发。**MCP handshake / listTools 阶段根本不碰 chrome** → 旧判据「handshake && listTools 含 list_pages」恒过，不管 chrome 开没开——测的是「MCP 进程起没起」而非「attach 没 attach 上」。

**互补性**：两个治理缺一不可——`--browserUrl`（治理1）让「无 chrome」从「静默自启」变「连接抛错」；惰性连接下唯有 `list_pages` 探测（治理2）能把这个抛错在 connect 阶段如实暴露为 `error` 态。

---

## 3. 代码变更清单

**唯一变更文件**：`app/server/src/tools/browser/chrome-mcp-driver.ts`

| 变更项 | 内容 |
|--------|------|
| **新增常量** | `export const DEFAULT_ATTACH_CDP_URL = 'http://127.0.0.1:9222'`（单一真源，loopback 已 SSRF 豁免） |
| **`buildChromeMcpArgs` 默认路径** | 无 `browserUrl` 且未显式 `autoConnect:true` → push `--browserUrl DEFAULT_ATTACH_CDP_URL`（不再 push `--autoConnect`） |
| **`buildChromeMcpArgs` 参数** | 新增 `autoConnect?: boolean`（显式 opt-in，默认 false；生产路径永不传 true） |
| **`connect()` probe 判据** | listTools 校验后新增：`await client.callTool({name:'list_pages',arguments:{}})` → `result.isError` 为真则抛 `BrowserError('attach_failed', ...)` |
| **`connect()` 失败清理** | catch 块：`transport.close()` 前先 `try { await client.close() } catch {}`（graceful 释放 CDP attach → kill MCP 进程兜底），对齐 v0.0.29 BUG-007 disconnect 语义 |

**helper 抽取**：`closeMcpClientThenTransport`——封装「client.close() graceful → transport.close() 兜底」顺序，connect 失败和正常 disconnect 均复用。

---

## 4. Spec 变更清单（architect 已完成）

| 文件 | 变更 | 版本 |
|------|------|------|
| `specs/tech/agent/tools/[P1]browser_tool.md` | §4.1 新增「connect 治理 `[v0.0.34]`」——根因分析 + 两个治理动作 + 互补性；§1/§2 表 + §4 heading + §10 边界行 去 autoConnect 默认表述；§12 版本段追加 1.4 `[v0.0.34 modified]` 详细摘要 | 1.3 → 1.4 |
| `specs/tech/config/[P1]connectors.md` | §3.3 重写「失败即停」语义（connect 失败 → error/switch off/intent on/不自动重连，bootstrap 一次性，无重试循环/周期探测）`[v0.0.34]`；§3.2 迁移表对齐（attach 成功判据加 list_pages round-trip、失败/断线保持 off + 不自动重连）；§5 修正「周期探测」为「未实现」；§8 版本追加 1.1 `[v0.0.34 modified]` | 1.0 → 1.1 |

---

## 5. 设计决策要点

| 决策 | 结论 | 理由 |
|------|------|------|
| `--browserUrl` 兜底位置 | `buildChromeMcpArgs`（非 connect 层） | driver 自洽，可直接 UT；connect 调用处不改（`browserUrl: opts.cdpUrl`，undefined 时由 args builder 兜底） |
| `--autoConnect` 去留 | 保留为显式 opt-in（`autoConnect:true`，默认 false） | 忠实用户可显式传入；为 autoConnect+userDataDir 安全路径（DevToolsActivePort）留口；有 UT + 文档注，非死代码 |
| probe 放 driver 内（非 connector 层） | `ChromeMcpDriver.connect()` 内 | driver 自洽；connector UT 用 mock driver，不耦合 probe 细节 |
| probe 失败归类 | `attach_failed` | result.isError 路径或 callTool reject（文本含 "Could not connect"）均命中 `ATTACH_FAIL_RE` |
| handshake + listTools 保留 | 两道判据递进 | listTools 快速失败（MCP 进程没起 / 工具缺失）；list_pages round-trip 真实性确认——缺一不可 |
| 进程树杀 | 不做（撤回） | watchdog 随父死（实测）；SDK 阶梯杀足够；macOS/Linux 无 Windows 进程树孤儿问题 |
| 失败即停自动重连 | 不做 | bootstrap 一次性已是现状；反复 spawn chrome-devtools-mcp 孤儿根治依赖治理1+2，失败后等用户手动重试即可 |

---

## 6. 关联 BUG

| BUG | 状态 | 说明 |
|-----|------|------|
| **BUG-008** | fixed | attach 默认 `--autoConnect` 导致 chrome-devtools-mcp 静默自启空 chrome |
| **BUG-009** | fixed | handshake/listTools 恒过（惰性连接）→ list_pages round-trip 判据真实化 |

---

## 7. 范围外（明确不做）

- **进程树杀**：`terminateChromeMcpProcessTree` / `ps` 枚举子孙——watchdog 随父死，SDK 阶梯杀已足够（详见 `states/v0.0.34/design.md §3`）。
- **连接断线自动重连**：本版确认语义（失败即停），自动退避重连列后续 enhancement。
- **connector config 注入 cdpUrl 默认端口**：当前 `connectOptions` 恒为 `{}`，端口由 `DEFAULT_ATTACH_CDP_URL` 兜底，从 config 读端口是后续增强。
- **周期探测 session 存活**：`bootstrap` 仅 app 启动一次，无周期轮询（断线靠 tool 调用失败暴露），探测列后续 enhancement。
- **无 PRD 变更**：纯 bug 修复，无新用户路径，无 `prd/version_logs/v0.0.34/`。

---

## 8. 验证结论

- **UT**：`chrome-mcp-driver.test.ts` 覆盖：(a) `buildChromeMcpArgs` 默认 → `--browserUrl loopback`；(b) `autoConnect:true` 显式 → `--autoConnect`；(c) probe `isError:true` → `attach_failed`；(d) probe callTool reject → `attach_failed`；(e) probe 成功（isError falsy）→ connected。
- **AT（真服务）**：toggle on + chrome 未开 → `connection=error`（判据真实化，不再假 connected）；toggle on + chrome 已开 → `connection=connected`。
- **无 regression**：mode①②（NodeWorkerDriver）路径不受影响（attach 独立 driver）；connector-manager UT（mock driver）不耦合 probe。

---

## 9. 版本

version: 1.0 `[v0.0.34]`（首版：browser attach 连接治理——BUG-008 禁止自启（`--browserUrl` loopback 取代 `--autoConnect`）+ BUG-009 判据真实化（list_pages round-trip probe + result.isError 检查）+ 失败清理增强（client.close graceful 前置）+ 失败即停文档化（无新代码，connectors.md §3.3）。唯一实现文件 `chrome-mcp-driver.ts`。两个 spec 更新（browser_tool 1.3→1.4 + connectors 1.0→1.1，architect 已完成）。撤回：进程树杀不做。）

---

## v0.0.34.1 HOTFIX — 默认连接方式回退到 --autoConnect

> 2026-06-28 紧急回滚。v0.0.34 默认 `--browserUrl` 在 chrome 144+ chrome://inspect 主路径必失败。

### 失误根因（self-postmortem）
v0.0.34 把默认从 `--autoConnect` 改为 `--browserUrl http://127.0.0.1:9222` 试图禁止 autoConnect 静默自启。**真机失败**：chrome 144+ chrome://inspect 远调模式（本仓库 spec §4 主路径用户操作）**不暴露 HTTP `/json/version`**（返 404 是正常的，记忆 `browser-attach-debug-run-directly` 早已明记）。chrome-devtools-mcp 的 `--browserUrl` 实现去拉 `/json/version` 拿 webSocketDebuggerUrl → 在该模式必失败 `Failed to fetch browser webSocket URL from http://127.0.0.1:9222/json/version: HTTP Not Found`。

调研/编码/code-review/真机验证**全程只测了反面场景**（没开 chrome 时不自启），漏测主路径（chrome 144+ inspect 已开）——这是流程性失误，所有 agent 都按"已定方案"执行没回头质疑前提。

### Hotfix（dev1 0413022）
唯一文件 `app/server/src/tools/browser/chrome-mcp-driver.ts`：
- `buildChromeMcpArgs`：默认 push `--autoConnect`（不再 `--browserUrl DEFAULT_ATTACH_CDP_URL`）。
- 保留 `DEFAULT_ATTACH_CDP_URL` 常量 + `autoConnect:boolean` 入参（UT 兼容、未来若 chrome 重新暴露 `/json/version` 可切换）。
- 用户显式 `cdpUrl` 时仍走 `--browserUrl`/`--wsEndpoint`（用户自负 chrome 端点契约）。

### 治理项现状（HOTFIX 后）

| 治理项 | 状态 | 说明 |
|--------|------|------|
| 治理1 禁止自启（BUG-008） | **撤回** | chrome 144+ inspect 不暴露 /json/version，--browserUrl 主路径必失败；autoConnect 自启副作用承认存在，留 upstream 跟进 |
| 治理2 判据真实化（BUG-009） | ✅ 仍生效 | list_pages probe 查 isError，比旧 handshake/listTools 判据严格 |
| 治理2 失败清理 | ✅ 仍生效 | client.close graceful → transport.close kill，不留 orphan |
| 撤回项 进程树杀 | ✅ 仍不做 | watchdog 随父进程死，SDK 阶梯杀够用 |

### 真机验证
用户真 chrome 9222 → driver 默认 `--autoConnect` → handshake + listTools + probe（list_pages）成功 → 返回 7 个真实用户 tab。

### 验证测试 UT
`bun run typecheck` 0 error；`npx vitest run app/server/src/tools/browser` 181 passed。
