# v0.0.33.4 技术变更日志 — Scheduler 心跳 + Budget + file-watch + autonomy infra

> 范围红线：把 v0.0.33.1 占位的 `member.heartbeat` / `squad.enableHeartBeat` / `squad.budget` 真正接通运行时——squad 角色定时自主心跳（proactive）+ 团队 budget 治理 + 总开关一键停 + file-watch 事件唤醒 + UI 配置/观测。**Squad 层收官版本**。
> 权威输入：PRD `specs/prd/version_logs/v0.0.33.4/change_log.md`（14 路径 P1-P14 + 11 TBD 决策）+ 3 个新/改 [P1] spec（**scheduler / squad_filewatch / squad_autonomy 改**）。
> 父版本：v0.0.33（启动 squad）；**直接地基**：v0.0.33.3（board/outputs/reports 已落 → file-watch 有真目标 + 心跳醒来有真东西可看）+ v0.0.33.2（4 scope 对话 + deliverTo 统一投递）+ v0.0.33.1（占位字段已落数据）。

---

## 1. 改动总览（6 块）

| # | 子系统 | 改动核心 | 权威 spec |
|---|---|---|---|
| **A** | scheduler 子系统（NEW） | 1s 轮询（单 setInterval/squad，否决每角色 setInterval）+ timerStates Map + 重启续接（从 member.heartbeat 重建 + 持久化 lastFiredAt）+ in-flight 补偿 + gate chain（enableHeartBeat→activeWindow→budget→busy→deliverTo）+ 多 squad 独立实例 + .unref + trap 清理 | `[P1]scheduler.md` |
| **B** | file-watch watcher（NEW） | squad 级后台 chokidar watcher on board/+outputs/+reports/（区别 v0.0.17 per-session 前台仅 UI）+ 路径前缀路由（board/reports→leader，outputs→owner 前缀匹配兜底 leader）+ 2s debounce + 复用 scheduler gate（activeWindow 放宽） | `[P1]squad_filewatch.md` |
| **C** | budget 治理 | `squadBudgetRemaining(squadId)` 横向聚合 team sessions total.total_tokens（无 sub_total）+ daily 窗口（squad.timezone 0 点回血）+ consumption vs budget 分离 + session_usage_update 实时刷新 | `[P1]squad_autonomy.md §6` + scheduler §5 |
| **D** | autonomy 总开关 | `squad.enableHeartBeat`（默认 false）killswitch 每 tick 轮询（toggle ≤1s 生效）；关→心跳+file-watch 停，reactive 仍响应 | `[P1]squad_autonomy.md §7` + scheduler §4 |
| **E** | autonomy spec 修正 | `squad_autonomy.md §5` gate chain：`concurrencySlotAvailable`→`isRoleRunning` busy check（TBD11）；§6 去重 budget 公式 + 无 sub_total；§10 五项 TBD 决议 | `[P1]squad_autonomy.md` v0.2 |
| **F** | UI 层 | autonomy toggle（启用）+ budget meter（实时）+ heartbeat config（per role）+ 自动工作 tab + 角色面板心跳 section；testid 契约由 coder 编码前补组件 spec | `specs/ui/overall/06-studio.md` + 组件 spec（coder 产出） |

**核心不变量**（MUST NOT violate）：
1. **deliverTo 前 check session busy**（TBD11）——`deliverTo=enqueue+activate`，activate 幂等返现有 run 但 enqueue 已执行 → 不 check 会堆 tick。multi_agent §3.1 并发限是 spawn 父子限，**不适用** squad 顶层 peer 角色。
2. **1s 轮询 + killswitch 每 tick 轮询**（非 timer 内缓存）——toggle 后 ≤1s 生效，不依赖 reloadSquad。
3. **file-watch activeWindow 放宽**——file-changed 是实时事件（不限时段）；但受 enableHeartBeat + budget + busy 约束（autonomy 关 file-watch 也停）。
4. **consumption vs budget 分离**——consumption always-on（reactive 也计，显示/审计）；budget 仅 gate proactive。
5. **SquadChat 无 scheduler**（SD5：纯 reactive，不入 timerStates，无 heartbeat 端点入口）。

---

## 2. 核心设计原则（落 overall.md §8）

1. **1 秒轮询模型**：单 setInterval/squad 遍历所有 role timer（否决每角色 setInterval）——重启健壮 + killswitch 每 tick 轮询 + N 角色易管理 + 单 timer .unref。借鉴 refs/claude-code cronScheduler。
2. **lastFiredAt 续接**：每角色一字段持久化 `.rocky_squad/state/scheduler.json`，重启从 member.heartbeat 重建 timer + 读 lastFiredAt 准确排下次（防漏心跳）；in-flight 跨过到点 → 重启后立即补一次 + 从当前重排（无堆）。
3. **gate chain 顺序**：enableHeartBeat(killswitch) → activeWindow(跟 squad.timezone) → budget(横向聚合) → busy(session.state) → deliverTo。每 gate 独立跳过当周期（不堆）。
4. **busy 前 check**：deliverTo 的 enqueue 不可撤，故 busy check 必须在 deliverTo 前；session.state==='running' 跳过（activate 幂等会静默 enqueue 致堆）。
5. **file-watch squad 级后台 watcher**：board/+outputs/+reports/（squad 共享根，非 workspaces/{memberId}/），区别 v0.0.17 per-session 前台（仅 UI 刷新，保留不动）；路径前缀路由 + 2s debounce。
6. **budget 横向聚合**：squad 成员顶层 peer（parentSessionId=null）无自动 usage 提升，须 Σ team sessions 的 getUsageView(sid).total.total_tokens（total 已含 sub-agent 递归）；无 sub_total 字段。

---

## 3. 改动文件清单（A/M，按子系统）

### 3.1 scheduler 子系统（A）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/squad/scheduler/scheduler.ts` | 新增 | `SquadScheduler` class：start/stop/reloadRole/reloadSquad/tick（1s 轮询 + timerStates Map + 重启续接 + in-flight 补偿） |
| `app/server/src/squad/scheduler/gate-chain.ts` | 新增 | `tryFire()` + `withinActiveWindow(activeWindow, now, tz)` + `isDue(ts, now)` |
| `app/server/src/squad/scheduler/tick-message.ts` | 新增 | `tickMessage(at, reason, path?)` builder + `TickMessage` interface（{kind:proactive_tick, at, reason, path?}） |
| `app/server/src/squad/scheduler/scheduler-state.ts` | 新增 | `read/writeLastFiredAt()` 持久化 `.rocky_squad/state/scheduler.json` |
| `app/server/src/squad/scheduler/scheduler-history.ts` | 新增 | ring buffer（N=100）+ append history.jsonl + `getHistory(squadId, limit)` |
| `app/server/src/squad/budget/budget-aggregator.ts` | 新增 | `squadBudgetRemaining(squadId)` 横向 Σ team sessions total.total_tokens（daily 窗口按 squad.timezone）+ `getBudgetUsage(squadId)`（含 perSession 明细 + 窗口边界） |
| `app/server/src/squad/squad-runtime.ts` | 新增 | squad 启动/销毁 wire scheduler + filewatch watcher 生命周期（start/stop + trap 清理） |

### 3.2 file-watch watcher（B）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/squad/filewatch/squad-file-watcher.ts` | 新增 | `SquadFileWatcher` class：start/stop/onFsEvent（chokidar + 2s debounce） |
| `app/server/src/squad/filewatch/path-router.ts` | 新增 | `routeEvent(relPath, squad)` 路径前缀路由 + `matchOutputsOwner()` |
| `app/plugins/builtins/skills/teamwork-mate.md` | 修改 | 教 member 产物落 `outputs/{selfName}/`（owner 前缀约定，软约束） |

### 3.3 现有代码修改（A/B/C/D 触达）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/agent/agent-manager.ts` | 修改 | 暴露 `isSessionBusy(sessionId): Promise<boolean>`（check `session.state==='running'`），供 gate-chain gate3 调用 |
| `app/server/src/agent/schema_defs/squad/squad.ts` | 修改 | 加 `timezone: {type:'string', required:false}`（IANA tz，默认 user local；TBD4/5 单一 squad timezone） |
| `app/server/src/stores/squad-store.ts` | 修改 | createSquadService 不变（`.rocky_squad/state/` 已建）；squad 启动 hook 调 squad-runtime 启 scheduler+watcher |
| `app/server/src/handlers/squad-*.ts` | 修改/新增 | 4 端点变更（见 API change_log §7）：PATCH /squad/:id（reloadSquad）+ 3 新端点 |
| `app/server/src/routes.ts` | 修改 | 注册 3 新路由（heartbeat/budget-usage/scheduler-history） |
| `app/plugins/builtins/rocky_context/prompt/squad_role.ts`（或 content fragment） | 修改 | leader/mate fragment 加 tick handling rule（识别 proactive_tick 后自主决定做不做） |

### 3.4 spec 文档（概念先行）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `specs/tech/squad/[P1]scheduler.md` | 新增 | scheduler 子系统唯一权威设计（14 章） |
| `specs/tech/squad/[P1]squad_filewatch.md` | 新增 | squad 级 file-watch watcher 设计（11 章） |
| `specs/tech/squad/[P1]squad_autonomy.md` | 修改 | §5 gate（isRoleRunning）+ §6 去重+无sub_total+窗口/tz + §10 TBD 决议；v0.2 |
| `specs/tech/squad/[P1]squad_workspace.md` | 修改 | §5/§8 标注 file-watch 唤醒已落 `[P1]squad_filewatch.md`（pointer） |
| `specs/tech/squad/overall.md` | 修改 | 文件索引加 scheduler/filewatch + §8 核心原则 |
| `specs/api/version_logs/v0.0.33.4/change_log.md` | 新增 | 4 端点变更 + AT 映射 |
| `specs/ui/components/studio-page/`（组件 spec） | 新增（coder 编码前） | autonomy-toggle / budget-meter / heartbeat-config / auto-work-tab / role-heartbeat-section 的 testid 契约 |

---

## 4. state 目录决策（拍板，squad_workspace §8 未决）

**决策**：scheduler state 走 `.rocky_squad/state/scheduler.json`（squad-store.ts:163 建队时已建此目录，零新 mkdir）。counters 继续 `.state/counters.json`（board-shared.ts:200，**不动**，out of scope）。

**理由**（简单优先）：
- `.rocky_squad/state/` 已存在（建队即建），scheduler 直接用零代码改 mkdir。
- 移 counters 到 `.rocky_squad/state/` 是 scope creep（动 board-shared.ts 风险），留 backlog。
- 两系统内部目录并存（`.state/` + `.rocky_squad/state/`）有认知负担但非阻塞——统一进单一目录（推荐 `.rocky_squad/state/`）留后续 hygiene 版本。

**doc 落点**：`[P1]squad_workspace.md §8` 未决项标注已决（本节决议）。

---

## 5. 11 TBD 决议对照表（PRD §4 落地确认）

| TBD | 决议 | 落点 |
|---|---|---|
| 1 持久化深度 | 重建 timer + lastFiredAt | scheduler §3/§7 |
| 2 tick 消息 | {kind,at,reason,path?} | scheduler §11 |
| 3 budget 口径 | reactive 计 consumption；budget gate 仅 proactive | autonomy §6 |
| 4 daily 回血 | squad.timezone 0 点 | autonomy §6 + scheduler §5 |
| 5 activeWindow tz | 单一 squad.timezone | autonomy §5 |
| 6 outputs 路由 | 前缀匹配 owner 兜底 leader | filewatch §3 |
| 7 debounce | 2s | filewatch §4 |
| 8 in-flight tick | 立即补一次 + 从当前重排无堆 | scheduler §6 |
| 9 multi-squad | 每 squad 独立实例 | scheduler §9 |
| 10 SquadChat 算 budget | 算（公式不破） | autonomy §6 |
| 11 busy 策略 | deliverTo 前 check，跳过当周期 | scheduler §4 gate3 + autonomy §5 |

---

## 6. 验证范围（test-plan 锚点）

- **UT**：scheduler 1s 轮询 + gate chain 5 分支（killswitch/window/budget/busy/fired）+ 重启续接（lastFiredAt）+ in-flight 补偿 + debounce + 路径路由 4 case（board/reports/outputs-owner/outputs-fallback）+ budget 聚合 + daily 窗口分桶。
- **AT**：14 路径（PRD §3，P1-P14 全 HTTP curl）+ 4 端点契约（API change_log §6 映射表）。
- **ET**：P10-P12 纯 UI（UC-1~UC-10，无设计稿 visual_compare=0）。
- **测试环境注意**（memory）：scheduler interval + watcher 是常驻进程，env_shutdown 必须 pkill 清理（test-process-cleanup-or-crash）；1s 轮询测试用 mock clock 加速（不真等 1s）。

---

## 7. 版本

version: 1.0 `[v0.0.33.4]`：scheduler 子系统（1s 轮询+lastFiredAt 续接+gate chain+busy 前 check+.unref+trap 清理）/ squad 级 file-watch watcher（board+outputs+reports 路径路由+2s debounce+activeWindow 放宽）/ budget 横向聚合 helper（无 sub_total+daily 窗口）/ enableHeartBeat killswitch（每 tick 轮询）/ autonomy spec §5/§6/§10 修正 / 4 API 端点 / state 走 .rocky_squad/state/scheduler.json。Squad 层收官。权威设计 = 3 个 [P1] spec（scheduler + squad_filewatch + squad_autonomy v0.2）。
