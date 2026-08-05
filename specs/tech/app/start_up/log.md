---
type: log
title: Start-Up KB 变更记录
updated: 2026-07-16
---

# Start-Up KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-07-16 · v0.0.156（bootstrap 拆 7 phase + late-bound holder，装配顺序等价）

- **`bootstrap.ts` 1132 → 412 行**：保留 `BootstrapResult` interface + `bootstrapBuiltinPlugins` 入口 + promptAssetsCheck + workdir mkdir + `process.on('unhandledRejection')` hook；主函数变薄为依次调 7 个 phase helper + 收集 BootstrapResult。装配顺序（INV-C-1）严格按原 line 顺序（scheduler → search → workspace → connectors，与 change_plan 预估相反，按实际 line 强制）。
- **7 phase 文件（`app/server/src/bootstrap-*-phase.ts`）**：
  - `bootstrap-plugin-phase.ts`（171 行，Phase 1+2+3）：Registry + BUILTIN_EXTENSION_POINTS + BuiltinLoader.loadAll + registerTestFixtures + loadScopeConfigs + GroupMetaLoader + ScopeConfigValidator + PluginPolicyStore + PluginConfigService + PluginManager + AppConfigService
  - `bootstrap-bus-phase.ts`（148 行，Phase 6）：EventHub.singleton + ReplayableEventBus × 3 + wrapBusWithLog + SseChannel + SSE test interceptor
  - `bootstrap-store-phase.ts`（150 行，Phase 7）：FsCrudStore + CompositeStore mount 4 schema + SessionUnreadRuntime + SessionMetaBroadcaster + wrapStatusBusForUnread + SessionStore 构造 + setSessionStoreEpDelegate + **`stateMachine.reconcileOnStartup()`**（原 `bootstrap.ts:277`，迁至本文件 `:91`）+ **`SessionTaskLock.reconcileOnStartup()`**（原 `bootstrap.ts:281`，迁至本文件 `:97`）+ `unreadRuntime.start()`。reconcile 关键时序保留（reconcile 在 unreadRuntime enabled=false 期间 emit 不产未读）。
  - `bootstrap-agent-phase.ts`（324 行，Phase 8）：ToolExecutionEngine + approvalManager.setStore + ContextEngine + AgentManagerImpl + setResolveConfig + setBuildAgentToolContext + setForkedRunner + setConsolidationRunner + setSquadReminderDeps
  - `bootstrap-scheduler-phase.ts`（131 行，Phase 9）：BudgetState + createEngine + squadRuntime + bootScheduler + SIGTERM trap
  - `bootstrap-connectors-phase.ts`（181 行，Phase 10）：connectorManager + channelManager + browserDriverRegistry + computerNativePort（三态：AT=mock / dev=loopback / packaged=registry）
  - `bootstrap-search-phase.ts`（244 行，Phase 11）：SearchEngine + HistoryIndexer + workspaceManager
- **`bootstrap-late-bound.ts`**（59 行）新增：`LateBound<T>` holder（`{ value: T | undefined }`）+ `createLateBound()`。agent-phase 定义的 lambda 通过 `lateBound.X.value` 前向引用 scheduler/connectors/search phase 的输出（activate 时才读，符合时序）。
- **INV-PKG-1~3 packaged 护栏满足**：phase helper 内无 `process.env` 直读（除 connectors-phase 保留 `resolveMockComputerNativePort` / `resolveLoopbackComputerNativePort` 透传 `process.env` 的 pure move 行为——文档化三态机制，packaged 模式下两者返 undefined → getComputerNativePort() 走 registry）；无相对路径 / 字面 `~` / `process.cwd()`；`__dirname` 解析 plugins/scopes/groups.json 保留 CJS 语义。
- **`[P0]startup_reconcile.md` §3 引用更新**：bootstrap 接入点 `bootstrap.ts:277/281` → `bootstrap-store-phase.ts:91/97`（v0.0.156 phase 拆分）。
- **`index.md § ③ 与系统的关系` 更新**：`bootstrap.ts.reconcileOnStartup()` 行号引用同步迁到 `bootstrap-store-phase.ts:91/97`。
- 详情：`specs/tech/version_logs/v0.0.156/change_log.md` + `change_plan.md`（段 C-1 + INV-C-1 + INV-PKG-1~3）。

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起）+ 本 `log.md`。
- `[P0]startup_reconcile.md` 已带 frontmatter（small-B 加）；清理散文 inline 版本号（§1 设计源 / §2.1 §2.2 标题中的 `v0.0.12 已有` / `v0.0.13 新增 D2.3` / §2.2 注 `（D2.3）`）→ 现状形态。

## 历史版本详情

- 五态 reconcileOnStartup 接入：详见 `specs/tech/version_logs/v0.0.12/`。
- summaryTask reconcile（旁路 CAS，D2.3 决策）：详见 `specs/tech/version_logs/v0.0.13/`。
