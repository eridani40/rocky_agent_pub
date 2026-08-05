# Rocky Agent

**Local-first multi-agent orchestrator for your desktop.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/eridani40/rocky_agent_pub?include_prereleases)](https://github.com/eridani40/rocky_agent_pub/releases)
[![macOS](https://img.shields.io/badge/platform-macOS%20arm64-lightgrey)](https://github.com/eridani40/rocky_agent_pub/releases)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/eridani40/rocky_agent_pub/blob/main/CONTRIBUTING.md)

English | [简体中文](README.zh-CN.md)

![Rocky Agent — Squad Studio](docs/screenshots/squad.png)

> [!NOTE]
> **Local-first.** Every session, key and plugin config lives in a local `DATA_DIR`. The only outbound traffic goes to the LLM providers you configure — no telemetry, no cloud relay.

## Why Rocky Agent?

| | Rocky Agent | Typical agent tools |
|---|---|---|
| **Local-first** | All data in local `DATA_DIR`, no cloud | Often cloud-hosted or need a self-hosted server |
| **Desktop-native** | Double-click `.dmg`, native GUI | Mostly CLI / web UI / Docker |
| **Multi-agent orchestration** | Built-in Squad Studio: leader + member agents that collaborate | Single agent loop, or roll-your-own orchestration |
| **Hackable in TypeScript** | Full TS, friendly to web/full-stack devs | Many are Python |

## Features

- **Orchestrate agent squads** — a leader agent spawns and coordinates member agents; members inherit context & resolved model, reply async, and stay in sync via SSE.
- **Bring your own LLM** — Anthropic, OpenAI, MiniMax, GLM (Zhipu), DeepSeek, OpenRouter, or any OpenAI-compatible endpoint.
- **Computer Use** — the agent captures your screen and clicks/types through a loopback channel.
- **Tools with human-in-the-loop approval** — `file`, `bash`, `web_fetch`, `cron`, `search`, `ask_question`; risky actions gate behind approval.
- **Skills & plugins** — a built-in skill marketplace; extend the agent by writing a TypeScript plugin and declaring an extension point.
- **Memory & history search** — persistent memory across sessions plus full-text search over conversation history.
- **Academy** — train and refine your own agents in-app.
- **Spec-driven engineering** — the repo ships its own `specs/` design system; features are specified before coded and verified by a 3-layer pipeline (unit tests + real-LLM API tests + agent-plays-app E2E).

## Quickstart

### Option A — Download (recommended)

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | `Rocky.Agent-<version>-arm64.dmg` from [Releases](https://github.com/eridani40/rocky_agent_pub/releases) |
| macOS (Intel) · Windows · Linux | _on the roadmap — see [Roadmap](#roadmap)_ |

> **macOS first launch:** right-click the app → **Open** (bypasses Gatekeeper for unsigned builds).

### Option B — Build from source

Requires [Bun](https://bun.sh) ≥ 1.3 and Node ≥ 22.

```bash
git clone https://github.com/eridani40/rocky_agent_pub && cd rocky_agent_pub
bun install                       # also runs `playwright install chromium`
cp dev.env.example dev.env        # optional: fill in defaults
bun run gen-version
bash scripts/run-dev.sh           # starts backend API + web renderer
```

<details>
<summary><b>Troubleshooting</b></summary>

- **`playwright install chromium` failed** — browser/computer-use features will be unavailable. Retry: `bunx playwright install chromium`.
- **Port already in use** — edit `API_PORT` / `WEB_PORT` in `dev.env` (defaults 3710 / 8788).
- **macOS permission prompts** — Computer Use needs Screen Recording & Accessibility permissions in *System Settings → Privacy & Security*.
</details>

### Configure your LLM key

Launch the app → **Settings → Providers** → pick a provider (Anthropic / OpenAI / MiniMax / …) → paste your API key. Keys are stored locally under `DATA_DIR` and sent **only** to the provider you chose.

## Architecture

<!-- TODO: architecture diagram (orchestrator → squad → tools → LLM providers) -->

```
app/
├── electron/         # desktop shell, main process, zero-secret runtime config injection
├── web/              # React + Vite renderer (chat, squad studio, settings)
├── server/           # Bun HTTP API + agent loop + tools + persistence (node:sqlite)
├── protocols/        # shared IPC + HTTP contract types
├── shared/           # cross-package utilities
└── computer-native/  # native helpers (screen capture, accessibility)
```

A single `server` process runs the agent loop (LLM call → tool dispatch → SSE stream), orchestrates squads, and persists everything to SQLite. The `electron` main process hosts the renderer and injects a **zero-secret** runtime config into the packaged app.

## Screenshots

<table>
  <tr>
    <td align="center"><b>Playground</b><br/><img src="docs/screenshots/playground.png" width="300"/></td>
    <td align="center"><b>Squad Studio</b><br/><img src="docs/screenshots/studio.png" width="300"/></td>
    <td align="center"><b>Settings · Providers</b><br/><img src="docs/screenshots/settings-providers.png" width="300"/></td>
  </tr>
  <tr>
    <td align="center"><b>Skills</b><br/><img src="docs/screenshots/skills.png" width="300"/></td>
    <td align="center"><b>Academy</b><br/><img src="docs/screenshots/academy.png" width="300"/></td>
  </tr>
</table>

## Plugins

A plugin is a manifest (`plugin.json`) plus one or more TypeScript implementations registered against a named **extension point**. Smallest real example (from `app/plugins/builtins/skills_sh/plugin.json`):

```json
{
  "id": "skills_sh",
  "label": "Shell Skills",
  "description": "Provides shell-script skills to the marketplace.",
  "extImpls": [
    {
      "implId": "skills_sh",
      "point": "skill_market_provider",
      "impl": "./skills-sh-provider.ts"
    }
  ]
}
```

Built-in extension points include LLM providers, tools, context sources, skills, and channels. Full contract (manifest schema, cardinality, scopes, packaged loading) in [`specs/tech/plugin_system/`](specs/tech/plugin_system/).

## Configuration

Environment-based for paths & ports; **LLM keys are configured in-app, not via env.**

| Variable | Default (prod) | Purpose |
|----------|----------------|---------|
| `API_PORT` | `3720` | backend HTTP API port |
| `WEB_PORT` | `8789` | renderer port (dev only) |
| `DATA_DIR` | `~/.rocky_agent_prod` | sessions / keys / plugin config root |
| `APP_ENV` | `prod` | `dev` / `test` / `prod` isolation |
| `LOG_LEVEL` | `warn` | `debug` / `info` / `warn` |
| `HTTP_PROXY` / `HTTPS_PROXY` | — | proxy for outbound LLM calls |

Full schemas: [`dev.env.example`](dev.env.example) · [`prod.env.example`](prod.env.example) · [`test.env.example`](test.env.example).

## Telemetry

**None.** Rocky Agent collects no usage data. All sessions, keys and configs stay in `DATA_DIR`; the only outbound traffic is to the LLM providers you configure.

## Roadmap

- Cross-platform builds (Windows, Linux, macOS Intel)
- Plugin marketplace discovery & install
- More Computer Use actions and reliability
- _(see [open issues](https://github.com/eridani40/rocky_agent_pub/issues))_

## Contributing

PRs welcome! This repo follows a **spec-driven** workflow — features are designed in `specs/` before any code, and verified by a 3-layer test pipeline. See [`CONTRIBUTING.md`](CONTRIBUTING.md) to get started, [`AGENTS.md`](AGENTS.md) for the full AI-development methodology, and `specs/` for the design system.

## License

[MIT](LICENSE) © eridani40

<!-- ## Star History — add after first public release -->
