# Rocky Agent

> **Run a squad of AI agents — on your desktop, under your control.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/eridani40/rocky_agent_pub?include_prereleases)](https://github.com/eridani40/rocky_agent_pub/releases)
[![CI](https://github.com/eridani40/rocky_agent_pub/actions/workflows/ci.yml/badge.svg)](https://github.com/eridani40/rocky_agent_pub/actions/workflows/ci.yml)
[![macOS](https://img.shields.io/badge/platform-macOS%20arm64-lightgrey)](https://github.com/eridani40/rocky_agent_pub/releases)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

**English** | [简体中文](README.zh-CN.md)

<p align="center">
  <img src="docs/screenshots/squad.png" alt="Rocky Agent — Squad Studio" width="720"/>
</p>

---

### 🏠 Local-first　·　🔒 Zero telemetry　·　🧩 Plugin-extensible

Rocky Agent is a **desktop-native multi-agent orchestrator**. Spin up a *leader* agent that spawns and coordinates *member* agents — each with its own model, tools and memory — all running against your own LLM keys, with every byte of data staying on your machine.

No cloud relay. No usage tracking. No lock-in.

---

## ✨ Why Rocky Agent?

| | Rocky Agent | Typical agent tools |
|---|---|---|
| 🏠 **Local-first** | All sessions, keys & configs in a local `DATA_DIR` | Cloud-hosted, or roll your own server |
| 🖥️ **Desktop-native** | Double-click a `.dmg` → native macOS GUI | CLI / web UI / Docker |
| 🤝 **Multi-agent built-in** | Squad Studio: leader delegates to members, synced via SSE | Single agent loop, or DIY orchestration |
| 🔧 **Hackable in TypeScript** | Full TS codebase, friendly to web/full-stack devs | Mostly Python |
| 📐 **Spec-driven** | Every feature specced in `specs/` before coded, verified by a 3-layer test pipeline | Tests-as-afterthought |

---

## 🚀 Features

**🤝 Agent squads** — A leader agent spawns member agents, delegates work, and keeps everyone in sync over SSE. Members inherit context and resolved models; they reply asynchronously and report back.

**🧠 Bring your own LLM** — Anthropic, OpenAI, MiniMax, GLM (Zhipu), DeepSeek, OpenRouter, or any OpenAI-compatible endpoint. Configure once in-app; keys never touch the filesystem outside `DATA_DIR`.

**🖱️ Computer Use** — The agent captures your screen and clicks/types through a native loopback channel — automate real apps, not just sandboxes.

**🛠️ Tools with human-in-the-loop** — `file`, `bash`, `web_fetch`, `cron`, `search`, `ask_question`. Risky actions gate behind explicit approval.

**🧩 Skills & plugins** — A built-in skill marketplace plus a TypeScript plugin system: declare an extension point, ship new providers, tools, context sources, skills or channels.

**💾 Memory & history** — Persistent cross-session memory plus full-text search over every conversation.

**🎓 Academy** — Train, evaluate and refine your own agents entirely in-app.

---

## 🎬 Screenshots

<table>
  <tr>
    <td align="center"><b>Playground</b><br/><img src="docs/screenshots/playground.png" width="280"/></td>
    <td align="center"><b>Squad Studio</b><br/><img src="docs/screenshots/studio.png" width="280"/></td>
    <td align="center"><b>Settings · Providers</b><br/><img src="docs/screenshots/settings-providers.png" width="280"/></td>
  </tr>
  <tr>
    <td align="center"><b>Skills</b><br/><img src="docs/screenshots/skills.png" width="280"/></td>
    <td align="center"><b>Academy</b><br/><img src="docs/screenshots/academy.png" width="280"/></td>
  </tr>
</table>

---

## ⚡ Quickstart

### Option A — Download (recommended)

Grab the latest `Rocky.Agent-<version>-arm64.dmg` from [**Releases**](https://github.com/eridani40/rocky_agent_pub/releases).

> **macOS first launch:** right-click the app → **Open** (bypasses Gatekeeper for unsigned builds).

### Option B — Build from source

```bash
git clone https://github.com/eridani40/rocky_agent_pub && cd rocky_agent_pub
bun install                       # also runs `playwright install chromium`
cp dev.env.example dev.env        # optional: pre-fill defaults
bun run gen-version
bash scripts/run-dev.sh           # backend API + web renderer
```

Requires [Bun](https://bun.sh) ≥ 1.3 and Node ≥ 22.

<details>
<summary><b>Troubleshooting</b></summary>

- **`playwright install chromium` failed** — browser & Computer Use features unavailable. Retry: `bunx playwright install chromium`.
- **Port in use** — edit `API_PORT` / `WEB_PORT` in `dev.env` (defaults 3710 / 8788).
- **macOS permission prompts** — Computer Use needs Screen Recording & Accessibility in *System Settings → Privacy & Security*.
</details>

### Plug in your LLM key

Launch the app → **Settings → Providers** → pick a provider → paste your API key. Stored locally; sent **only** to that provider.

---

## 🧩 Plugins

A plugin = one manifest (`plugin.json`) + TypeScript implementations registered against named **extension points**. Minimal real example (from `app/plugins/builtins/skills_sh/`):

```json
{
  "id": "skills_sh",
  "label": "Shell Skills",
  "extImpls": [
    { "implId": "skills_sh", "point": "skill_market_provider", "impl": "./skills-sh-provider.ts" }
  ]
}
```

Built-in extension points: LLM providers, tools, context sources, skills, channels. Full contract → [`specs/tech/plugin_system/`](specs/tech/plugin_system/).

---

## 🏗️ Architecture

```
app/
├── electron/         # desktop shell · main process · zero-secret runtime config
├── web/              # React + Vite renderer (chat, squad studio, settings)
├── server/           # Bun HTTP API · agent loop · tools · node:sqlite persistence
├── protocols/        # shared IPC + HTTP contract types
├── shared/           # cross-package utilities
└── computer-native/  # native helpers (screen capture, accessibility)
```

A single `server` process runs the agent loop (LLM call → tool dispatch → SSE stream), orchestrates squads, and persists everything to SQLite. The Electron main process hosts the renderer and injects a **zero-secret** runtime config into the packaged app.

---

## ⚙️ Configuration

Environment-based for paths & ports. **LLM keys are configured in-app, never via env.**

| Variable | Default (prod) | Purpose |
|----------|----------------|---------|
| `API_PORT` | `3720` | backend HTTP API port |
| `WEB_PORT` | `8789` | renderer port (dev only) |
| `DATA_DIR` | `~/.rocky_agent_prod` | sessions / keys / plugin config root |
| `APP_ENV` | `prod` | `dev` / `test` / `prod` isolation |
| `LOG_LEVEL` | `warn` | `debug` / `info` / `warn` |
| `HTTP_PROXY` / `HTTPS_PROXY` | — | proxy for outbound LLM calls |

Full schemas: [`dev.env.example`](dev.env.example) · [`prod.env.example`](prod.env.example) · [`test.env.example`](test.env.example).

---

## 🔒 Privacy

**Zero telemetry. By design.**

- No usage analytics, no crash reporting, no phone-home.
- Every session, key and config stays under `DATA_DIR` on your machine.
- The **only** outbound traffic goes to the LLM providers you configure — nowhere else.

---

## 🗺️ Roadmap

- ⬜ Cross-platform builds (Windows · Linux · macOS Intel)
- ⬜ Plugin marketplace discovery & install
- ⬜ More Computer Use actions and reliability
- _(see [open issues](https://github.com/eridani40/rocky_agent_pub/issues))_

---

## 🤝 Contributing

PRs welcome! This repo follows a **spec-driven** workflow — features are designed in [`specs/`](specs/) before any code, then verified by a 3-layer test pipeline (unit + real-LLM API + agent-plays-app E2E).

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — get started
- [`AGENTS.md`](AGENTS.md) — full AI-development methodology
- [`specs/`](specs/) — the design system

---

## 📄 License

[MIT](LICENSE) © eridani40

---

<!-- ## ⭐ Star History — add after first public release -->
