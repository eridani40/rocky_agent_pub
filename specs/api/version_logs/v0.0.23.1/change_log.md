# v0.0.23.1 API 变更日志 — Browser connectOverCDP bugfix（API 契约零变化）

> 对应 spec：`specs/api/overall/08-web-tools.md`（v1.0→v1.1，纯内部 bugfix，对外 schema/action/result/isError 全不变）。
> 关联：`states/v0.0.23.1/bugs/BUG-001-browser-connectovercdp-timeout-[fixed].md`、tech `specs/tech/version_logs/v0.0.23.1/change_log.md`。
> **本文件是 AT（API Test）browser 域的依据**——v0.0.23.1 不引入新 API、不改契约，AT 用例集（`tests/api/browser/`）零变化，已存 case 直接复用。

## 概述

**v0.0.23.1 是纯内部 bugfix**——mode①② headless/managed-profile browser tool 的 playwright 调用从「bun 主进程直接 connectOverCDP」改为「node worker 子进程一次性执行器」（`NodeWorkerDriver.executeOnce`），绕开 Bun 不支持 playwright connectOverCDP 的 bug。**对外 API（schema / action 集 / ToolResultBlock 形态 / isError 分支）零变化**——内部实现栈切换对调用方完全透明。

| 面向 | v0.0.23.1 变化 |
|------|---------------|
| 工具协议面（LLM 调用） | **零变化**。`browser` tool inputSchema（mode/action/profileName/url/ref/text/cdpUrl）+ 输出 ToolResultBlock（content[0].text 形态 + isError 分支）全不变 |
| HTTP facade 面（客户端调） | **零变化**。无新端点，无字段调整 |
| EP inventory 面 | **零变化** |

## 1. mode①② 内部实现路径（API spec §4.3 补充说明）

`browser` tool `run(input, ctx)`：
- mode=attach → 仍走 `connectorManager.getAttachSession('browser')` → ChromeMcpDriver 长会话（**不变**）。
- mode=headless/managed-profile → 改走 `driver.executeOnce(connectOpts, action, params, signal)`：
  - `NodeWorkerDriver.executeOnce` spawn `node browser-worker.cjs`（一次性 node 子进程）
  - worker 内：spawn chrome → waitForCdp → connectOverCDP（**Node 运行时下正常**，绕开 Bun bug）→ dispatchAction → kill chrome → stdout 返 `{ok,text?} | {ok:false,error:{kind?,message}}`
  - tool 层：`r.ok ? textResult(r.text) : errorResult(formatExecuteError(r))`
- 兜底：driver 未实现 `executeOnce` 时走旧 `connect → dispatchAction → close`（仅旧 PlaywrightDriver UT mock 用）。

**结果形态等价**：executeOnce 返回的 text 与旧 dispatchAction 的输出对齐（navigate→`navigated to <url>` / snapshot→`{snapshot,refs}` JSON / click→`clicked <ref>` / type→`typed into <ref>` / evaluate→JSON.stringify / screenshot→`{mime,data(base64)}` / listPages→`PageInfo[]` JSON）。

## 2. AT 影响（用例零变化，已存 case 直接复用）

| case | v0.0.23.1 行为 | 备注 |
|---|---|---|
| `tests/api/browser/br_headless_tc1/` | **PASS**（真 LLM chat-flow 端到端验证） | LLM 调 browser navigate https://example.com + snapshot，走 NodeWorkerDriver → node worker → connectOverCDP 成功（isError=False，无超时）；tool_result_delta.delta 真实结果：navigate `navigated to https://example.com`；snapshot 完整 a11y tree + refs 表 |

**SSE 解析 bug 顺手修**（pre-existing）：`br_headless_tc1/run.sh` 改用 `tool_result_delta.delta`（原错用 `tool_result_end.content`[空]）+ `tool_call_start`（原错用 `tool_call_end`[toolName=None]）。case 信号现已正确，对齐 memory `test-env-build-gotchas`。

**新增 case**：v0.0.23.1 不引入新 AT case——browser 对外契约零变化，现有 case 已覆盖 headless 核心链路。managed-profile 走同一 NodeWorkerDriver 链路（核心 connectOverCDP 已由 headless 端到端铁证），未额外跑 managed-profile chat-flow（控制 chrome 进程累积风险）。

## 3. isError 分支（v0.0.23 不变，v0.0.23.1 沿用）

所有 isError 分支语义不变（见 `specs/api/overall/08-web-tools.md` §4.3）。executeOnce 失败也走 isError=true 分支：

| 分支 | isError | content[0].text |
|------|---------|-----------------|
| mode=attach 且连接器未 connected | **true** | `browser attach 未连接：请在「连接器 → 浏览器」中开启连接`（不变） |
| mode=② profile 占用冲突 | **true** | `profile <name> in use` + 提示（不变） |
| mode=③ cdpUrl 私网/远程 fail-closed | **true** | SSRF 拒绝（不变） |
| chrome 启动失败 / connectOverCDP 失败 / action 超时 / ref 不存在 | **true** | 原因（executeOnce 失败时 `{kind?,message}` 经 formatExecuteError 转友好文本：`browser <kind>: <message>` 或 `browser 调用失败: <message>`） |

## 4. 不在范围（pre-existing）

- attach ③ chrome-devtools-mcp 连不上用户 chrome（用户另报，单独排查）
- click/type 跨 tool 调用的 refs 状态丢失（一次性 worker 内 lastRefs 每次重置，跨调用失效；现状即如此）

## 5. 关联

- 概念权威：`specs/tech/agent/tools/[P1]browser_tool.md` v1.2 §3 / §7
- BUG 权威：`states/v0.0.23.1/bugs/BUG-001-browser-connectovercdp-timeout-[fixed].md`
- tech 同期变更：`specs/tech/version_logs/v0.0.23.1/change_log.md`
