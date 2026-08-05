# Changelog

All notable changes to **Rocky Agent** are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning follows [semver](https://semver.org/) — currently `0.0.x` pre-release (APIs & storage layouts still evolving).

> Rocky Agent ships one release per milestone. This file aggregates the **important** milestones rather than listing all 250+ patch releases; full per-version history lives in `git log`.

## [Unreleased]

- **v0.0.259** (working): Panorama authoring fixes — coerce / system-entity / create idempotency

## [0.0.25x] — 2026-08 · UX polish & performance observability

### Added
- **Panorama** (panoramic authoring) UX: idle guide → leader 1:1 chat + composer plaintext prefill
- Chat-area link rendering & click dispatch (http → system browser / 12 local formats → built-in read-only viewer / others → system app)
- Async subagent reply fallback (system sends on behalf, preventing silent dropped replies)
- Hard caps on memory / skill storage count (quota)
### Changed
- ESC terminal interrupt UX (queued injection + focus management + mention deserializer)
- Cross-process stall auto-monitoring (`performance.log` + `enablePerformanceLog` toggle)
### Fixed
- Packaged `spawn EBADF` (root-caused fd leak — fd number hit ceiling, not fd exhaustion)
- OpenRouter single-model token stats filtering for modelId with trailing slash
- Panorama archive Chinese-id task 404 (router path param `decodeURIComponent`)
- tool_use ordering 400 (clean_view text-bubble reducer)

## [0.0.23x–0.0.24x] — Agent definition & orchestration

### Added
- Custom agent definition (`AGENTS.md` injection transparency + `agent_profile` section, single-mapper dynamic render)
- Task kanban + todo panel SSE realtime
- Spawned subagent inherits parent resolved model
- Squad member list hides bench by default (on-duty view + view filter)
- Prompt injection quality / consolidation health
### Changed
- Task refactored to plain entity (split out builtin channel)
- Model picker display unified; classroom default requires a concrete model
### Removed
- Studio squad slim-down: dropped task / okr / requirement / charter / board chain, focusing on todo / panorama / member

## [0.0.20x–0.0.22x] — Academy rebuild & interaction unification

### Added
- Academy (agent training) rebuild (new_academy) + coach enhancement
- Academy skills view
- Markdown editor
### Changed
- Chat area unified (chat_unify)
- Toolset resolve unified (unify-toolset-resolve)
- Action-key stable interaction anchor convention (replacing fragile text-based targeting, initial rollout)
- Session list realtime sort + pin

## [0.0.188–0.0.190] — Test framework overhaul — 2026-07-22

### Changed
- **E2E**: rebuilt as "agent plays app" paradigm (playwright-cli + natural-language case.md + executor free-judgment pass/small/blocking + per-step 4-artifact evidence), replacing the old declarative dom-assertion framework
- **API tests**: removed record/replay; each case now calls real LLM providers; 429/529/503 → `skipped` (no retry, non-blocking)
### Removed
- Legacy checkpoint.json / case.yaml declarative-assertion framework (archived to `tests_old_v1/`)

## [0.0.166–0.0.187] — Skill marketplace & Academy v1

### Added
- Skill marketplace frontend + backend (skill_market_backend + skill_market_ui)
- Plugin config center
- Academy v1 (academy + student_training + training_engine)
- `see_image` (image understanding tool), memory
- Auto context compaction (consolidate)

## [0.0.128–0.0.165] — Squad multi-agent & UI upgrade

### Added
- **Squad Studio**: multi-agent team orchestration (team_mgmt + squad_ui + member_page + squad_home_ui)
- Member workstyle, studio model picker
### Changed
- Frontend UI overhaul (ui_upgrade), chat layer refactor (chat-layer-refactor)
### Fixed
- Markdown render OOM, bounded log queue, lazy workspace watch

## [0.0.100–0.0.127] — Tool system & HITL

### Added
- Tools: `ask_question` / `cron` / `search` / `history_search` / `web_fetch` (with jina reader)
- **Computer Use**: desktop automation (screenshot + click, loopback channel)
- **HITL**: tool approval (approval / effort_approval / squad_effort_approval)
- Lark/Feishu integration, LLM call retry (llm_retry)

## [0.0.108] — Desktop packaging — 2026-07-10

### Added
- electron-builder producing macOS arm64 `dmg`
- Continuous-packageability guardrails: four packaged-only crash protections (dependency ownership / plugin into asar / runtime-config injection zero-secret / path expansion)

## [0.0.1–0.0.30] — Engineering foundation & chat mainline — 2026-06 ~ 07

### Added
- Bun + Electron desktop app scaffold (6 workspaces: electron / web / server / protocols / shared / computer-native, one-way deps)
- `test` / `dev` / `prod` three-environment isolation (ports + data dirs kept apart)
- LLM chat mainline (multi-provider: Anthropic / OpenAI / MiniMax / GLM / DeepSeek / OpenRouter)
- Session management + provider/model id mechanism
- Rocky branding (app icon + chatbot avatar, from hail mary project)
- Three-layer test pipeline (UT + AT + ET), auto-compaction, memory optimization
