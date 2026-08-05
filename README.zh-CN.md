# Rocky Agent

**本地优先的桌面多 agent 编排器。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/eridani40/rocky_agent_pub?include_prereleases)](https://github.com/eridani40/rocky_agent_pub/releases)
[![macOS](https://img.shields.io/badge/平台-macOS%20arm64-lightgrey)](https://github.com/eridani40/rocky_agent_pub/releases)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/eridani40/rocky_agent_pub/blob/main/CONTRIBUTING.md)

**English** | 简体中文

![Rocky Agent — Squad Studio](docs/screenshots/squad.png)

> [!NOTE]
> **本地优先。** 所有会话、密钥与插件配置都落在本地 `DATA_DIR`。唯一的出站流量只发往你配置的 LLM provider —— 不收集遥测、不经过云中转。

## 为什么用 Rocky Agent？

| | Rocky Agent | 常见 agent 工具 |
|---|---|---|
| **本地优先** | 数据全在本地 `DATA_DIR`，不上云 | 常是云端托管或要自建 server |
| **桌面原生** | 双击 `.dmg` 启动，原生 GUI | 多为 CLI / web UI / Docker |
| **多 agent 编排** | 内置 Squad Studio：leader + member agent 协作 | 单 agent loop，或自己写编排 |
| **TypeScript 可改** | 全 TS，前端/全栈开发者零门槛二次开发 | 很多是 Python |

## 特性

- **编排 agent 小队** —— leader agent 派生并协调 member agent；member 继承上下文与已解析模型、异步回报、经 SSE 保持同步。
- **自带 LLM** —— Anthropic、OpenAI、MiniMax、GLM（智谱）、DeepSeek、OpenRouter，或任意 OpenAI 兼容端点。
- **Computer Use** —— agent 截屏并通过 loopback 通道点击/输入。
- **工具 + HITL 审批** —— `file`、`bash`、`web_fetch`、`cron`、`search`、`ask_question`；高风险动作需人工审批。
- **技能与插件** —— 内置技能市场；用 TypeScript 写插件、声明扩展点即可扩展 agent。
- **记忆与历史搜索** —— 跨会话持久记忆 + 对话历史全文搜索。
- **Academy** —— 在 app 内训练、打磨你自己的 agent。
- **Spec 驱动工程** —— 仓库自带 `specs/` 设计体系；功能先写规格再编码，经三层测试（单元测试 + 真实 LLM API 测试 + agent 玩 app 的 E2E）验证。

## 快速开始

### 方式 A — 下载（推荐）

| 平台 | 下载 |
|------|------|
| macOS（Apple Silicon） | [Releases](https://github.com/eridani40/rocky_agent_pub/releases) 里的 `Rocky.Agent-<version>-arm64.dmg` |
| macOS（Intel）· Windows · Linux | _在路线图中 —— 见 [Roadmap](#路线图)_ |

> **macOS 首次启动：** 右键 app → **打开**（绕过 Gatekeeper 对未签名构建的拦截）。

### 方式 B — 源码构建

需要 [Bun](https://bun.sh) ≥ 1.3 与 Node ≥ 22。

```bash
git clone https://github.com/eridani40/rocky_agent_pub && cd rocky_agent_pub
bun install                       # 会顺带 `playwright install chromium`
cp dev.env.example dev.env        # 可选：填入默认值
bun run gen-version
bash scripts/run-dev.sh           # 启动后端 API + web 渲染层
```

<details>
<summary><b>常见问题</b></summary>

- **`playwright install chromium` 失败** —— 浏览器/Computer Use 功能将不可用。重试：`bunx playwright install chromium`。
- **端口被占用** —— 改 `dev.env` 里的 `API_PORT` / `WEB_PORT`（默认 3710 / 8788）。
- **macOS 权限弹窗** —— Computer Use 需在 _系统设置 → 隐私与安全性_ 里授予屏幕录制与辅助功能权限。
</details>

### 配置 LLM 密钥

启动 app → **设置 → Providers** → 选一个 provider（Anthropic / OpenAI / MiniMax / ……）→ 粘贴 API key。密钥仅存在本地 `DATA_DIR`，**只**发往你选的那个 provider。

## 架构

<!-- TODO: 架构图（orchestrator → squad → tools → LLM providers） -->

```
app/
├── electron/         # 桌面外壳、主进程、零密钥运行时配置注入
├── web/              # React + Vite 渲染层（聊天、squad studio、设置）
├── server/           # Bun HTTP API + agent loop + 工具 + 持久化（node:sqlite）
├── protocols/        # 共享 IPC + HTTP 契约类型
├── shared/           # 跨包工具
└── computer-native/  # 原生辅助（截屏、辅助功能）
```

单个 `server` 进程跑 agent loop（LLM 调用 → 工具派发 → SSE 流），编排 squad，把一切持久化到 SQLite。`electron` 主进程托管渲染层，并向打包后的 app 注入**零密钥**的运行时配置。

## 截图

<table>
  <tr>
    <td align="center"><b>Playground</b><br/><img src="docs/screenshots/playground.png" width="300"/></td>
    <td align="center"><b>Squad Studio</b><br/><img src="docs/screenshots/studio.png" width="300"/></td>
    <td align="center"><b>设置 · Providers</b><br/><img src="docs/screenshots/settings-providers.png" width="300"/></td>
  </tr>
  <tr>
    <td align="center"><b>技能</b><br/><img src="docs/screenshots/skills.png" width="300"/></td>
    <td align="center"><b>Academy</b><br/><img src="docs/screenshots/academy.png" width="300"/></td>
  </tr>
</table>

## 插件

一个插件 = 一份清单（`plugin.json`）+ 一个或多个注册到具名**扩展点**的 TypeScript 实现。最小真实示例（取自 `app/plugins/builtins/skills_sh/plugin.json`）：

```json
{
  "id": "skills_sh",
  "label": "Shell Skills",
  "description": "向技能市场提供 shell 脚本技能。",
  "extImpls": [
    {
      "implId": "skills_sh",
      "point": "skill_market_provider",
      "impl": "./skills-sh-provider.ts"
    }
  ]
}
```

内置扩展点涵盖 LLM provider、工具、上下文源、技能、channel。完整契约（清单 schema、cardinality、scope、打包加载）见 [`specs/tech/plugin_system/`](specs/tech/plugin_system/)。

## 配置

路径与端口走环境变量；**LLM 密钥在 app 内配置，不走 env。**

| 变量 | 默认值（prod） | 用途 |
|------|----------------|------|
| `API_PORT` | `3720` | 后端 HTTP API 端口 |
| `WEB_PORT` | `8789` | 渲染层端口（仅 dev） |
| `DATA_DIR` | `~/.rocky_agent_prod` | 会话 / 密钥 / 插件配置根目录 |
| `APP_ENV` | `prod` | `dev` / `test` / `prod` 隔离 |
| `LOG_LEVEL` | `warn` | `debug` / `info` / `warn` |
| `HTTP_PROXY` / `HTTPS_PROXY` | — | 出站 LLM 调用代理 |

完整 schema：[`dev.env.example`](dev.env.example) · [`prod.env.example`](prod.env.example) · [`test.env.example`](test.env.example)。

## 遥测

**无。** Rocky Agent 不收集任何使用数据。所有会话、密钥与配置都留在 `DATA_DIR`；唯一出站流量只发往你配置的 LLM provider。

## 路线图

- 跨平台构建（Windows、Linux、macOS Intel）
- 插件市场发现与安装
- 更多 Computer Use 动作与可靠性
- _（见 [open issues](https://github.com/eridani40/rocky_agent_pub/issues)）_

## 贡献

欢迎 PR！本仓库遵循 **spec 驱动** 工作流 —— 功能先在 `specs/` 设计、再编码，经三层测试管线验证。入门见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，完整 AI 开发方法论见 [`AGENTS.md`](AGENTS.md)，设计体系见 `specs/`。

## 协议

[MIT](LICENSE) © eridani40
