# Changelog

All notable changes to **Rocky Agent** are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning follows [semver](https://semver.org/) — currently `0.0.x` pre-release (APIs & storage layouts still evolving).

> Rocky Agent ships one release per milestone. This file aggregates the **important** milestones rather than listing all 300+ patch releases; full per-version history lives in `git log`.

## [0.0.347–0.0.365] — 2026-08 · Model routing, quota era & the prompt-cache rewrite

The quota/provider era: coding-plan quotas became first-class, model routing grew a fallback ladder, and the context engine was rewritten around prompt caching.

### Added
- **Four-channel coding-plan native support** (v0.0.350): Anthropic/OpenAI/MiniMax/GLM coding-plan providers fetch quota & balance directly from upstream APIs
- **Quota overview v2** (v0.0.352): grouped dual-bar usage display, fast-burn badge, balance with thousand separators, collapsible provider list with disabled-card visuals
- **Squad quota entry** (v0.0.356): per-member balance popover from the squad panel — four-source hook, dual-state cards, i18n
- **Global quota sync** (v0.0.363): 5-minute background task + store as single source of truth + incremental fetch on open + SSE push to open pages
- **Model routing fallback ladder** (v0.0.347): composite-plan + per-attempt routing with three-state circuit breaker
- **Live config during runs** (v0.0.351): model/effort/approval-mode changes take effect at each iteration boundary — no restart needed
- **Per-tool SSE streaming** (v0.0.354): multi-tool results stream to the UI one by one instead of arriving as a batch

### Changed
- **Prompt-cache rewrite** (v0.0.361): session state (env/work-dir/team-roster) moved into the system prompt as a stable fragment; per-turn reminders became an ordered KV queue — run-first turn emits the full dynamic chain + queue clear, subsequent turns only the time segment + drained deltas (same-key supersede). Measured effect: per-turn non-cached input drops from ~4500 chars to ~179 tokens, cache hit rate 99.9%
- Retired 4 reminder providers (time/env/workspace/squad_workspace) in favor of the queue + `session_states` system-prompt fragment
- Token usage attribution now lands on the actually-hit physical model (v0.0.359), including plan-fallback paths
- Workspace search follows symlinks with chain-of-authorization semantics aligned to the file tree (v0.0.360); mention file-picker and search now share one backend (`workspace-search-core`, v0.0.346)
- Run-end reporting deduped (v0.0.362): mates that already reported via `send_message` in the last 3 turns no longer emit an exit notification

### Fixed
- Browser attach defaults + instance-key convergence + debug-state residue detection (v0.0.330)
- A2A envelope blank-page root cure (v0.0.331)
- Member panel live-status four-layer hydration (v0.0.348)
- Worker-pool removal: tool layer back to true-async `fs.promises` after worker_threads shared-address-space crashes (v0.0.345)
- Picker default semantics gained the plan dimension; quota-ring rendering (v0.0.356–357)
- kimi-2 full-quota tier missing from the plan popover (v0.0.357); tier time-range display now renders the complement of excluded hours in reference format (v0.0.364)

## [0.0.320–0.0.329] — 2026-08 · File preview ecosystem & the Door

The biggest UI milestone since Squad Studio: the chat area gained a **file preview column** with real editing, and the chat/preview split became a sliding **door**.

### Added
- **File preview area** (v0.0.320): three-column layout `chat | preview | workspace` with a 4-slot layout engine — open files from the workspace tree or chat links into preview tabs (multi-tab, horizontal scroll, close buttons)
- **Built-in editing**: view/edit modes, markdown rendering, structured formats (JSON/JSONL/YAML/XML/TOML/CSV/TSV) with format/validate actions, 37 programming-language extensions as plain-text code view
- **Version conflict detection** (v0.0.320): files are read with a server `version`; saves send `expectedVersion`; external changes → 409 conflict modal (reload / force overwrite)
- **Dirty guard**: switching/closing/opening tabs while unsaved changes exist → save-and-switch / discard / cancel modal; edit-mode guard blocks all navigation
- **Workspace file search** (v0.0.320 + v0.0.324): backend search endpoint + debounced frontend filter, merged & de-duplicated; v0.0.324 upgraded to semantic backend search with a **pruned result tree** (file tree stays mounted, capped at 100 hits); v0.0.327 made results interactive (defensive 500 ms debounce + Enter to search immediately)
- **Floating action capsule** (v0.0.323): preview actions moved into an always-visible floating capsule — save / undo / format / validate / open-in-browser, with tooltips
- **Plain-text file support** (v0.0.328): `.env` / `.env.*` / `.properties` / `.conf` / `.cfg` / `Dockerfile` / `Makefile` / `.gitignore` open in the built-in editor instead of the system app
- **HTML preview → open in browser** (v0.0.325)
- **The Door** (v0.0.329): the chat↔preview divider is a sliding three-state door — `center` (split view, default) / `left` (document fills the frame) / `right` (chat fills the frame) — with chevron handles on the divider, clickable rail to restore, and per-session persistence (`pv-door-<sid>`, migrates legacy `pv-collapsed`); visual polish: 7 px rail with dual border, 8 px handle, edge-aligned
- Team export picker (v0.0.321): choose which squad to export when downloading team config
- Usage ring optimization (v0.0.326): percentage inside a 36 px ring, whole-ring click trigger, button moved into panel head

### Changed
- Chat-link & workspace-file opening unified into one `openLocalPath` dispatcher (v0.0.280 lineage): images → in-app viewer, text → preview tab, `.url` → browser, others → system app
- Legacy file-editor modals retired in favor of the inline preview area (v0.0.320)
- Tool execution engine worker pool hardening (v0.0.307–309): single-process tool engine with `worker_threads` async offload + cross-thread readSet fix + crash self-heal (grep timeout & fallback, v0.0.328)

### Fixed
- Worker pool readSet lost across thread boundary (v0.0.309)
- Search race / debounce issues; `.env` files opening in system app (v0.0.328)
- Door-state persistence not restored after refresh (v0.0.329, sessionId re-read fix)

## [0.0.310–0.0.319] — Team collaboration & unified SaveBar

### Added
- **send_message enveloping** (v0.0.310–312): tool calls promoted to envelope messages — flattened global interception, bidirectional a2a envelope rendering, sender name resolution from agent ref
- **Unified SaveBar** (v0.0.316–317): all config panels moved to a controlled save model — member edit panel, seats panel, tools/observability tabs, language switch applies only on save, logs toggle tracks dirty state, tab-switch dirty protection; global `SaveBar` component (common/ + variant prop)
- **Config sync** (v0.0.318): import/export app configuration
- **Team sync** (v0.0.319): import/export an entire squad as a zip (team-sync API) — templates, members, memory & skills; leader agent real-name fix on both template & zip import paths
- Markdown viewer frontmatter rendering (v0.0.313) and paragraph newline preservation (v0.0.314)

### Changed
- SaveBar now the single authority for unsaved changes across the app (v0.0.316–317)

### Fixed
- Squad delete dialog uppercasing the squad name (`confirmLabel` no longer forces uppercase, v0.0.315)
- Markdown viewer: multi-line paragraph newlines preserved (v0.0.314)

## [0.0.300–0.0.309] — Orchestration & performance

### Added
- **Worker pool async tool execution** (v0.0.307): tool engine moved to a single process with `worker_threads` async offload (types / worker-entry / pool / index + runTool dispatch + bootstrap singleton) — heavy tools no longer block the event loop
- **Cron panel realtime** (v0.0.303): API + SSE (`session_cron_changed` on every write op)
- **Squad list UI upgrade** (v0.0.305): avatar + two-line rows + pinned-first sorting + live `squad_meta` SSE updates
- **a2a envelope de-avataring** (v0.0.300–301): envelope messages drop the left avatar (invisible placeholder keeps layout)
- KV config read cache + transcript JSONL append optimization (v0.0.302)
- Auto-navigate to the squad page after creating a squad (v0.0.304)
- Squad Template Guide built-in skill (v0.0.299, shipped in this window)
- Template AGENTS.md workdir consensus (v0.0.300)

### Changed
- Markdown ordered-list numbering reset/jump detection (v0.0.306); Playground pin interaction aligned with Studio (v0.0.306 + icon alignment v0.0.308)

### Fixed
- Worker pool readSet lost across thread boundary (v0.0.309)
- send_message envelope: targetName parsing, sending-state placeholder, body expansion, timestamps (v0.0.311); inbound sender name from `message.sender.agent.ref.name` (v0.0.312)

## [0.0.290–0.0.299] — Rendering, home redesign & templates

### Added
- **fs-yield singleton library** (v0.0.290–291): a global yield gate wrapping fs I/O so heavy file operations don't block the event loop
- **Squad Templates** (v0.0.298): built-in team templates + create-a-squad-from-template UI
- **Squad Template Guide** built-in skill (v0.0.299)
- Bash tool sandbox switch (v0.0.296): `PassthroughBashEngine` + frontend toggle
- a2a message envelope folding (v0.0.295): collapsible envelope on the left side
- Sender granularity down to block level (v0.0.294)

### Changed
- **Squad home redesign** (v0.0.288 + 292): three-section layout (token card + member card + panorama), leader card modern dark theme, panorama self-adaptive; five follow-up issues fixed
- Queued-message display: collapsed first line + expanded max-height scroll + mutual exclusion (v0.0.285), then top-alignment & soft-wrap fixes (v0.0.293)
- Color blocks stabilized (v0.0.297)

### Fixed
- Stream-scroll sticky-bottom race (v0.0.287) — four-state decision model
- Input-draft newline loss (v0.0.289, resolved by v0.0.284 hardBreak serialization)

## [0.0.280–0.0.289] — Rendering & home rebuild

### Added
- **Markdown image rendering** (v0.0.286): block-level images — web / local relative (resolved per md file dir) / absolute IPC base64 / `data:image` whitelist; click to fullscreen lightbox (Esc / overlay / ✕)
- **team.reset action** (v0.0.282): clear a member's session context, presence and todo
- Editor size unified content-driven (v0.0.283): textarea auto-heights to content

### Changed
- **Chat link opening unified ≡ right-side file area** (v0.0.280): shared `openLocalPath` dispatcher — `.url` sniffing → browser, images → in-app viewer, text → editor, others → system app; new IPC channels `shell:writeFileText` / `shell:readFileBinary`
- User-bubble newlines preserved (v0.0.281, `whitespace-pre-wrap`)
- hardBreak serialization keeps newlines (v0.0.284)

### Fixed
- Queued-message layout & overflow (v0.0.285)

## [0.0.270–0.0.279] — Chat experience & team navigation

### Added
- **Group chat switch** (v0.0.270): `enableGroupChat` — server schema + injection gate + routing + prompt, web UI toggle hides entry
- **Squad member status navigation** (v0.0.268): status context + entry panel + memo cascade guard (non-member SSE doesn't re-render the chat tree); v0.0.269 moved entry to the chat float menu (5th item) with anti-nesting protection
- **Workspace image preview** (v0.0.269): 5-way file dispatch (folder > `.url` > image viewer > text editor > system) + binary channel (`GET /workspace/file?binary=1` → base64 data URL)
- **Mate exit notification** (v0.0.273): leader hook on mate run exit + unified `[squad:agents]` status block (replaces reachable_agents + squad_team_status)
- Team default reasoning effort (v0.0.279): `effortDefault` + PATCH/echo + resolveEffort override chain
- Squad-status modal visual tuning (v0.0.278): running spinner + de-emphasized idle

### Changed
- **fs watch** (v0.0.271 + 275): watch-set computed from the file tree, full recompute + diff to prevent leaks; event-driven recompute
- **system_reminder injection** broadened (v0.0.274): triggers on user/tool/a2a roles (assistant/system excluded) + density-tier design
- Squad home refreshes on entry (v0.0.276): seats activation re-pulls detail

### Fixed
- **Chrome orphan process leak** (v0.0.272): orphan scan + chromePid reporting + close fallback + reconcile cycle
- Bash tool login shell (v0.0.265): `-l` now inherits user PATH (build script no longer needs bun→node symlink)

## [0.0.260–0.0.269] — Chat experience & team navigation

### Added
- **Scroll guide bubble + auto-scroll fix** (v0.0.262): floating "new messages / back to bottom" bubble; content-signature auto-scroll (rows + text length) so streaming deltas always follow
- **Workspace symlink browsing** (v0.0.263): chain-authorized symlink resolution in the file tree (link badge + hover tooltip + expand-through)
- **Browser Instance Manager** (v0.0.264): per-session persistent browser worker with lifecycle + leak protection
- **Session input draft cache** (v0.0.267): per-session unsent input cached in memory, restored on remount (draft > prefill)
- Token-stats dropdown overlay fix (v0.0.261)

### Changed
- **Attach-mode lifecycle unification** (v0.0.266): attach lifecycle engine + ActionExecutor registry refactor (protocol + two impls + registry)
- chrome-devtools-mcp alignment (v0.0.29 lineage → 1.4.0 API: take_snapshot / fill / pageId / uid / list_pages arguments)

### Fixed
- attach disconnect resource release (v0.0.29 BUG-007), list_pages empty results (BUG-006 root cause)
- Chrome orphan leak (v0.0.272, see above)

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
