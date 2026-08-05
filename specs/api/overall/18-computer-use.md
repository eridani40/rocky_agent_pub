---
type: spec
title: Computer Use API（v0.0.105 — 无公共 HTTP 端点；dev loopback 通道）
priority: P1
status: active
updated: 2026-07-16
since: v0.0.105
---

# Computer Use API

> 管什么：computer use 能力的对外调用面契约。**结论：无公共 server HTTP 端点**——agent 走 tool → `ComputerNativePort`（进程内/注入），UI 权限走 Electron IPC，唯一「HTTP-ish」面是 dev-only loopback 通道（Electron 主进程 ↔ bun 后端）。
> 不管什么：工具协议（→ `specs/tech/agent/tools/[P1]computer_use_tool.md`）；port 接口/注入（→ `specs/tech/agent/platform/[P1]computer_native_capability.md`）；UI（→ `specs/ui/overall/05-connectors.md`）。

## 1. 无公共 HTTP 端点（pivot 结论）

v0.0.105 曾设计 computer 作连接器，配套 HTTP 端点 `GET /connector/computer/permissions` + `PUT /config/connectors/computer`。**架构 pivot 后这些端点全部废弃**（裸 spawn Swift helper 拿不到 TCC 权限 → 改主进程注入 `ComputerNativePort`，computer 去连接器语义）：

| 旧端点（v0.0.105 设计，已废弃） | 现状 |
|---|---|
| `GET /connector/computer/permissions` | **不存在**。UI 权限查询走 Electron IPC（`window.rockyComputer.getPermissions()`，见 §3）；agent 侧权限门禁走 `port.checkPermissions()`（进程内） |
| `PUT /config/connectors/computer` | **不存在**。computer 无 toggle/连接器状态机；`VALID_CONNECTOR_IDS = ['browser']`（`handlers/connector.ts`），`:id='computer'` 返 400 |
| `GET /config/connectors` items 含 computer | **不含**。仅返 browser 一条 |

**agent 调用面**：agent 通过单 `computer` tool（LLM tool_call）→ `ctx.config.computerNativePort.<method>()`。**不经任何 HTTP**——port 是进程内直调（packaged）/ mock（AT）/ dev loopback（dev）三态注入（precedence 见 platform KB §3）。

## 2. dev loopback 通道（dev-only，非公共 API）

**唯一 HTTP-ish 面**：dev 模式下 bun 独立后端够不到 Electron 主进程的 native addon，故 Electron 主进程起一个极小 `node:http` loopback server（`app/electron/src/computer-loopback-server.ts`），供 bun 后端的 `LoopbackComputerNativePort` 纯 fetch 调用。

- **bind**：`127.0.0.1:${ROCKY_DEV_COMPUTER_LOOPBACK_PORT}`（仅 dev.env 设；packaged/AT 不设）。
- **鉴权**：每请求校验 header `x-rocky-dev-token` == `${ROCKY_DEV_COMPUTER_LOOPBACK_TOKEN}`（缺/错 → 403）；仅 127.0.0.1 bind，防同机其他进程误撞。
- **非公共**：这是「Electron 主进程 → bun 后端」的后端间 dev 通道，不经渲染层/vite proxy，不对外暴露；packaged 走进程内直调（无此通道）。

| 方法 | 路径 | 语义 | 响应 |
|---|---|---|---|
| `GET` | `/permissions` | `port.checkPermissions()` | `{accessibility, screenRecording}`（两态） |
| `POST` | `/screenshot` | `port.screenshot(opts)`（body = 截图 opts `{app?}`） | `ComputerScreenshotResult`（`{ok, mediaType?, data?, width?, height?, windowBounds?, scaleFactor?, reason?}`） |
| `POST` | `/invoke` | 泛路由：`port[method](...params)`（body `{method, params}`；method 白名单校验，承接全部 native 方法） | 对应 method 的返回类型（截图/AX 树/动作结果，JSON） |

**`/invoke` 白名单**（`ALLOWED_METHODS`）：`screenshot`/`getAppState`/`readAxTree`/`listApps`/`click`/`type`/`scroll`/`pressKey`/`drag`/`setValue`/`performSecondaryAction`（防按 method 名调 port 上任意属性/内部方法）。未知 method → 404 `{ok:false, reason}`；异常 → 500 `{ok:false, reason}`（fail-closed，不挂连接）。

`/invoke` body 示例（非省略）：
```json
{ "method": "click", "params": [{ "elementIndex": 3 }, { "app": "com.apple.Safari" }] }
```

## 3. UI 权限查询走 Electron IPC（非 HTTP）

连接器页「电脑 tab」的权限卡片走 `window.rockyComputer`（preload contextBridge → 主进程 IPC，`app/electron/src/computer-permissions-ipc.ts`），**不走后端 HTTP**：`getPermissions()` / `requestAccessibility()` / `openScreenRecordingSettings()` / `testScreenshot()`。契约详见 `specs/ui/overall/05-connectors.md §3.2` + `specs/ui/components/connector-page/section-computer-connector.md`。

## 4. AT 影响

无 HTTP endpoint AT（无端点）。computer use AT 走 **mock port + mock-llm directive**（`@@cu:<json>@@` → 单 `computer` tool_call）测 tool 逻辑（11 action dispatch / 门禁 / 结果映射），断言 `ToolResultBlock` 内容（TextBlock 路径/AX 文本/errorResult）。**`[v0.0.157 modified]`**：screenshot/get_app_state 断言从「ImageBlock content」改为「text content 含 `snapshots/` + `see_image` + size」+ 验证文件落盘到 mock ctx.workdir（mock ctx 须加 `toolCallId:'call_test_*'`）。真操作走 dev dogfood 手验（不进 run_all）。详见 `specs/tech/agent/tools/[P1]computer_use_tool.md §6`。

## 5. 版本

version: 2.1 `[v0.0.157 modified]`（2.0 → 2.1：**AT 断言改 TextBlock 路径**——tool 层 screenshot/get_app_state 不再产出 ImageBlock，改落盘 + 路径文本。ComputerNativePort 接口与 dev loopback 通道未动。详 `specs/tech/version_logs/v0.0.157/log.md`）

---

历史：version: 2.0 `[v0.0.105 modified]`（1.0 → 2.0：**废弃所有公共 HTTP 端点**——architecture pivot 后 computer 去连接器语义，`GET /connector/computer/permissions` + `PUT /config/connectors/computer` 全废（不存在）；agent 走 tool→port 进程内注入，UI 走 Electron IPC；文档化唯一 dev-only loopback 通道（`GET /permissions` + `POST /screenshot` + `POST /invoke` 泛路由，127.0.0.1 + token）。详 `specs/tech/version_logs/v0.0.105/change_log.md`）
