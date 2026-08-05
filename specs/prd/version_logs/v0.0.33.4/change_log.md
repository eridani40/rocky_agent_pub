# v0.0.33.4 — 自主性 infra（scheduler 心跳 + budget + file-watch + autonomy）产品变更

> version: 1.0 · 引入版本 v0.0.33.4 · 最后更新：2026-06-30
> 一句话定位：把 v0.0.33.1 已落的**占位字段**（`member.heartbeat` / `squad.budget` / `squad.enableHeartBeat`）真正接通运行时基础设施——squad 角色能**定时自主心跳**（proactive）、**团队 token budget 治理**、**总开关一键停心跳**、**file-watch 事件唤醒**，并在 UI 配置/观测。**Squad 层收官版本**。
> 父版本：v0.0.33（启动 squad）。依赖：v0.0.33.3（board/outputs/reports 已落 → file-watch 有真目标 + 心跳醒来有真东西可看）+ v0.0.33.2（4 scope 对话已通）+ v0.0.33.1（占位字段已落数据）。
> 概念权威源（PRD 必须对齐）：`specs/tech/squad/[P1]squad_autonomy.md`（唤醒双模/心跳归属/budget/总开关，**注：§7 字段名 `autonomyEnabled` 已过时，权威字段 = `enableHeartBeat`，见 §6 修正项**）+ `[P1]data_model.md`（board/outputs/reports 路径 + member.heartbeat schema）+ `specs/tech/multi_agent/[P1]subagent_derivation.md`（deliverTo/enqueue+activate/并发/重激活）+ `specs/ui/overall/06-studio.md` + `specs/ui/components/studio-page/`。
> API 契约：`specs/api/overall/11a-squad-endpoints.md` + 本版本新增（§5）。
> **scheduler + squad 级 file-watch 是现有系统没有的真新增组件**（概念先行：须先落 `specs/tech/squad/[P1]scheduler.md` + file-watch 章节，再编码，见 §6）。

---

## 1. 版本目标 + 验收标准

**目标**：squad 从「能干活」（v0.0.33.3）升级到「**会自己干活**」——角色在工作时段定时醒来翻 board / 推进 task / 必要时 send_message；user 不在场 squad 也持续运转；budget 兜住 token 失控；一键可停。

**用户验收标准**（req §1）：
- 配 leader 心跳（09:00-18:00 / 15min）→ 工作时间内每 15min leader 真醒一次（翻 board、必要时 send_message）
- activeWindow 之外：**完全不醒**
- 关 enableHeartBeat → 全部心跳停 → 用户主动消息仍能响应（reactive 路径不受影响）
- Budget 耗尽 → 心跳停、reactive 仍响应、次日 0 点（squad timezone）回血
- Member 把产物放 `outputs/` → leader 真被 file-watch 唤醒、真去看了
- 重启进程 → 心跳从 `member.heartbeat` **自动重建**（不丢心跳）

---

## 2. 功能模块

### 2.1 Scheduler 子系统（最大新基础设施）[P0]

- **位置**：`runtime/squad/scheduler/`（新目录）。每 squad **独立 scheduler 实例**（TBD9 决策）。
- **职责**：管理该 squad 所有 role（leader + members，**SquadChat 无心跳**）的心跳定时器。
- **实现（借鉴 refs/claude-code cronScheduler）**：
  - **1 秒轮询**（非每角色 setInterval）——每 tick 扫所有 role，到点则触发；稳健、易重启、易 killswitch。
  - **持久化 `lastFiredAt`**（每角色一字段，落 `.rocky_squad/state/scheduler.json`）：重启后从 `member.heartbeat` 重建 timer + 读 lastFiredAt **准确排下次**（TBD1 决策，防漏一次心跳）。
  - **busy 跳过**：deliverTo 前 check 目标 session 状态——role running 时**跳过当周期**不堆 tick（TBD11；activate 幂等会静默 enqueue，故须显式 check）。
  - **killswitch 每 tick 轮询**：每秒读 `squad.enableHeartBeat`，toggle 后**下一 tick 即时生效**（不依赖 timer 内部缓存）。
  - **所有 timer `.unref()`**：不孤立进程。
- **触发后** → 走 §2.2 gate chain → 通过则 `manager.deliverTo(role.sessionId, tickMessage)`（复用 v0.0.31 统一投递，无新机制）。

### 2.2 Gate chain（心跳触发顺序）

```
scheduler.onTick(role):                                   // 1s 轮询到点
  if !squad.enableHeartBeat: return                       // SD7 总开关（killswitch）
  if !withinActiveWindow(role.heartbeat.activeWindow, now, squad.timezone): return  // 双保险
  remaining = squadBudgetRemaining(squad)                 // SD6 团队 budget（§2.4）
  if remaining <= 0: return                               // 预算耗尽 → 停当周期（reactive 不受影响）
  if isRoleRunning(role.sessionId): return                // busy 跳过（TBD11，显式 check）
  manager.deliverTo(role.sessionId, tickMessage(now))      // enqueue(tick)+activate
```

### 2.3 Tick message 格式（TBD2 决策）

- `{ kind: "proactive_tick", at: <ISO>, reason: "heartbeat" | "file-changed", path?: <变更路径> }`
- role prompt 加 tick handling rule（识别 proactive_tick 后自主决定做不做——"啥都不做就 idle"也合法）。
- v0.0.33.3 已注入 board/tasks 上下文（reminder provider），心跳醒来有上下文判断。

### 2.4 Budget 治理（与 token consumption 分离）[P0]

- **两套独立概念**（不混）：
  - **token consumption**（持续记录，永远开）：所有工作（reactive + proactive）走 `session_usage`，用于显示/审计/计费，**不限流**。reactive 也计 consumption（TBD3 决策）。
  - **budget**（仅心跳 gate）：阈值，**仅在 proactive activate 时检查**。
- **聚合 helper（新）**：
  ```
  squadBudgetRemaining(squadId):
    consumed = Σ over {leaderSid, mateSid..., squadChatSid} of getUsageView(sid).total.total_tokens  // 当窗口
    return squad.budget.limit - consumed
  ```
  - **无 `sub_total` 字段**（req §2.4 术语不准）——squad 成员是**顶层 peer**（parentSessionId=null），无自动 usage 提升，须**横向聚合**团队 sessions。sub-agent 递归上报在 usage 模块内部完成，squad 层看到的就是聚合后 total。
  - SquadChat 也算（TBD10，消耗极低但 spec 公式不破）。
- **窗口刷新**：daily，squad 配 timezone（默认 user local），**0 点回血**（重置当窗口 consumed 基线）；明确日期分桶边界（23:59 tick 与 00:00 tick 用不同窗口，TBD4/5 决策）。

### 2.5 enableHeartBeat 总开关（killswitch）[P0]

- 字段 = **`squad.enableHeartBeat`**（boolean，required，**默认 false**；schema_defs/squad/squad.ts:60 权威；data_model §1.1 明确「替代旧 autonomyEnabled」）。
- 关 → scheduler 全 squad 心跳停（gate 第一道即返）；**reactive 照常响应**。
- 开 → 按 heartbeat 配置正常调度。toggle **即时生效**（下一 tick）。

### 2.6 file-watch 事件唤醒（全新 squad 级后台 watcher）[P0]

- **非「接 v0.0.17」**：v0.0.17 是** per-session 前台** watcher（`SessionWorkspaceManager`，chokidar 监听 `session.workspaceDir`=`workspaces/{sessionId}/`，发 `session_workspace_file_changed` → SSE → UI 刷新）。而 `board/`+`outputs/`+`reports/` 是 **squad 共享**（`workspaces/` 同级），v0.0.17 监不到。**本版本新建 squad 级后台 watcher**（chokidar on `board/`+`outputs/`+`reports/`）。v0.0.17 event 保留**仅 UI 刷新**。
- **路由（按路径前缀，TBD6 决策）**：
  - `board/{goals|requirements|tasks}/*` 变更 → **leader 唤醒**（leader 是看板观察者）
  - `reports/{daily,tasks,goals}/*` → **leader 唤醒**
  - `outputs/*` → **路径前缀匹配 owner roleId** 唤醒相关 member；**兜底仅 leader**（outputs 是 squad-shared「全员产出」）
- **唤醒机制**：watcher → adapter → `deliverTo(role.sessionId, tickMessage(reason="file-changed", path))`。
- **debounce**：同路径 1-3s 内重复变更只触发一次（fs 级 100ms 之上，TBD7 决策）。
- **生命周期**：squad 启动建 watcher，squad 销毁停 watcher；前台 watch（进程退出即停）。

### 2.7 UI 配置入口 [P1]

对齐 `specs/ui/overall/06-studio.md` + `specs/ui/components/studio-page/`（组件 testid 契约由 coder 编码前补组件 spec）：
- **Squad 面板 - 管理 tab**：**Autonomy toggle**（v0.0.33.1 已 disabled 显示，本版启用，绑 `enableHeartBeat`）+ **Budget meter**（进度条 剩余/总量 + 当日已消耗 vs limit + daily 回血时刻显示）。
- **Squad 面板 - 成员行**：每个 role 行可点开心跳配置（activeWindow time picker + interval 选择 + timezone 默认跟随 squad）；**SquadChat 行无心跳配置入口**。
- **Squad 面板新增 tab「自动工作」**：最近 N 次心跳 wake 历史（who / when / reason / 行动摘要）+ file-watch 唤醒历史。
- **角色面板「心跳」section** 实跑（v0.0.33.1 占位）：role 自己的 heartbeat 配置 + 最近活动。
- **布局稳定性（MANDATORY）**：按钮只有「始终可见」或「hover 出现」两种；出现/消失**绝不导致相邻元素位移**（预留固定空间 / 绝对定位，禁 `display:none` 致跳动）。

---

## 3. 关键用户路径（测试最低覆盖 — 14 条）

| # | 路径 | 覆盖类型 |
|---|------|---------|
| P1 | 基础心跳触发：配 leader heartbeat(09:00-18:00/5min) → 工作时间 → 每 5min leader 真触发 run（drain tick + 按 prompt 决定行动） | AT |
| P2 | activeWindow 之外不醒：18:01 之后 → scheduler 不触发心跳 | AT |
| P3 | enableHeartBeat 关：toggle 关 → 所有心跳停 → user 仍能群聊（reactive 路径） | AT |
| P4 | Budget 耗尽：消耗到 limit → 心跳停 → reactive 仍正常 → 跨日 → 0 点回血 → 心跳恢复 | AT |
| P5 | Budget 跨日回血：跑 23:59 → 00:00 → daily 窗口切换 → remaining 重置（不同窗口） | AT |
| P6 | 进程重启：跑着 squad 重启 app → 心跳从 `member.heartbeat` + lastFiredAt 自动重建 → 下次到点继续触发 | AT |
| P7 | file-watch board 触发 leader：member 改 `board/tasks/{id}.json` → ≤3s file-watch event → leader deliverTo(tick, reason="file-changed") → leader run → 看板比对 | AT |
| P8 | file-watch outputs 触发 member：leader 写 `outputs/x.md` → 路径前缀匹配 owner roleId → 相关 member 唤醒（兜底 leader） | AT |
| P9 | file-watch debounce：1s 内同文件改 10 次 → 仅 1 次唤醒 | AT |
| P10 | Heartbeat 配置实时：UI 改 interval 5→10min → 下一 tick 间隔变 10min（无需重启） | ET |
| P11 | Budget meter 实时：reactive 消耗 → meter 实时刷新（reactive 也计 consumption） | ET |
| P12 | 自动工作历史：触发 N 次 tick → 「自动工作」tab 看到对应记录 | ET |
| P13 | Concurrency gate：squad role running → tick busy 跳过（不堆积） | AT |
| P14 | 多 squad 隔离：squad A 心跳 / budget 与 squad B 互不影响 | AT |

> P10-P12 纯 UI（ET 覆盖，无设计稿 → visual_compare=0）；其余全 HTTP（AT 直接 curl 验）。

### 3a. E2E Use Cases（MANDATORY）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 打开 Studio → 进 squad 管理 tab → 开 enableHeartBeat → 配 leader 心跳(09:00-18:00/15min) → 等待 15min | leader 在工作时段真醒一次，自动工作 tab 出现一条 wake 记录 |
| UC-2 | UC-1 后改 activeWindow 为 09:00-10:00 → 当前时间 10:01 | scheduler 不再触发心跳（activeWindow 外纯 reactive） |
| UC-3 | UC-1 后 toggle 关 enableHeartBeat → 在群聊发消息 | 心跳全停；群聊 reactive 路径仍正常响应 |
| UC-4 | UC-1 后通过对话消耗 token 到 budget.limit → 等下一 tick → 次日 0 点(squad tz) | 耗尽后心跳停、reactive 仍响应；跨日 0 点 remaining 重置、心跳恢复 |
| UC-5 | 跑着 squad → 重启 app → 观察日志 | 心跳从 member.heartbeat + lastFiredAt 自动重建，不丢心跳 |
| UC-6 | member 改 board/tasks/{id}.json → 等待 ≤3s | leader 被 file-watch 唤醒，run 中翻看该 task |
| UC-7 | leader 写 outputs/{prefix}/x.md → 等待 ≤3s | owner member（路径前缀匹配）被唤醒；无匹配则 leader |
| UC-8 | 1s 内连续改 board/tasks/{id}.json 10 次 | 仅 1 次唤醒（debounce 生效） |
| UC-9 | role panel 改 interval 5→10min → 观察 | 下一 tick 间隔变 10min，无需重启 |
| UC-10 | 管理 tab 观察 budget meter → 触发一次 reactive 对话 | meter 实时刷新（reactive 也计 consumption） |

---

## 4. 11 TBD 决策（researcher 判决，PRD 落定）

| # | TBD | 决策 |
|---|-----|------|
| 1 | Scheduler 持久化深度 | 从 `member.heartbeat` 重建 timer + **持久化 `lastFiredAt`**（每角色一字段，重启准确排下次） |
| 2 | Tick 消息内容 | `{kind:"proactive_tick", at, reason, path?}` |
| 3 | Budget 计费口径 | reactive 计 consumption（显示/审计），**budget gate 仅 proactive** |
| 4 | Daily 回血时刻 + 时区 | squad 配 timezone，默认 user local 0 点；明确日期分桶边界 |
| 5 | ActiveWindow 时区 | 跟随 squad timezone（单一 timezone 字段） |
| 6 | file-watch outputs 路由 | 路径前缀匹配 owner roleId，**兜底仅 leader** |
| 7 | file-watch debounce | 1-3s（fs 级 100ms 之上） |
| 8 | 重启 in-flight tick | 重启后立即触发一次 + 从当前重排（无堆，claude-code 模式） |
| 9 | multi-squad scheduler | 每 squad **独立 scheduler 实例** |
| 10 | SquadChat 算 budget | 算（消耗极低，spec 公式不破） |
| 11 | Tick 重激活策略 | busy 跳过（**deliverTo 前 check session 状态**，activate 幂等会 enqueue） |

---

## 5. API 补充（req §2.8）

| 端点 | 用途 | 备注 |
|------|------|------|
| `PATCH /squad/:id` | v0.0.33.1 已有，本版本字段生效：`enableHeartBeat` / `budget` / `timezone` | 写后 scheduler 即时重载（killswitch + window + budget） |
| `PATCH /squad/:id/member/:mid/heartbeat` | 改 `member.heartbeat`（activeWindow/interval），实时刷新 timer（写后 `scheduler.reloadRole(mid)`） | 路径用 `/member/:mid`（无独立 role 实体，leader 也是 member，leaderId=member.id，与现有 `/member/:mid` 路由一致）；SquadChat 无 member record → 天然无入口（404 自然） |
| `GET /squad/:id/budget/usage` | 当前窗口 consumed + remaining + limit + 窗口边界 | 横向聚合 team sessions（§2.4 helper） |
| `GET /squad/:id/scheduler/history?limit=N` | 自动工作历史（tick wake + file-watch wake） | who / when / reason / path / 行动摘要 |

> 详细 request/response schema 由 arch 落 `specs/api/version_logs/v0.0.33.4/change_log.md` + `11a-squad-endpoints.md`。

---

## 6. 概念先行 + spec 对齐修正（MANDATORY）

**新概念（须先落 tech spec 再编码，不擅自发明）**：
- **scheduler 子系统** → arch 先落 **新 spec** `specs/tech/squad/[P1]scheduler.md`（1s 轮询 / lastFiredAt 持久化 / busy 跳过 / killswitch / .unref / 多 squad 隔离）。
- **squad 级 file-watch watcher** → arch 在 `specs/tech/squad/[P1]squad_workspace.md` 补「§N squad 级后台 watcher」章节（chokidar on board/+outputs/+reports/ + 路径前缀路由 + debounce；与 v0.0.17 per-session 前台 watcher 边界划清）。
- **squadBudgetRemaining helper** → arch 在 `squad_autonomy.md §6` 细化（横向聚合 team sessions，无 sub_total）。
- **UI 组件**（autonomy toggle / budget meter / heartbeat config / 自动工作 tab）→ coder 编码前按 `specs/ui/components/_conventions.md` 补组件 spec（testid 契约，e2e-test-designer 读）。

**发现 spec 过时（须 arch 修正，PRD 不沿用错误）**：
- ⚠️ `specs/tech/squad/[P1]squad_autonomy.md §7` 写 `SquadSpec.autonomyEnabled: boolean（缺省 true）` —— **已过时**。权威字段 = `enableHeartBeat`（schema_defs/squad/squad.ts:60，`{type:'boolean', required:true}`，data_model §1.1 明确「替代旧 autonomyEnabled」，**默认 false**）。**本 PRD 全程用 `enableHeartBeat`**；arch 须同步修正 autonomy spec §7 + §5/§2 文中 `autonomyEnabled`→`enableHeartBeat`。
- ⚠️ req.md 多处沿用旧名（`autonomyEnabled` / `tasks.json` 单文件 / 「接 v0.0.17」）—— 本 PRD 已按 researcher 发现 + 权威 schema/路径纠正，以本 PRD 为准。

**multi_agent §3.1 并发限不直接适用 squad 角色**：squad 成员是顶层 peer（parentSessionId=null），非 spawn 父子；tick busy 跳过靠 **deliverTo 前 check session 状态**（§2.2 gate），非 §3.1 计数器。

---

## 7. 范围边界

**IN SCOPE**：scheduler 子系统（1s 轮询+lastFiredAt+busy 跳过+killswitch+.unref）/ budget 横向聚合 helper / enableHeartBeat killswitch / squad 级 file-watch watcher（board+outputs+reports 路径路由+debounce）/ UI（autonomy toggle+budget meter+heartbeat config+自动工作 tab+角色面板心跳 section）/ 4 API 端点。

**OUT OF SCOPE（显式不做，归 backlog）**：
- 多 squad 协同（squad A 委托 squad B）/ 跨 user 协作 / squad 模板市场（req §4）
- v0.0.17 per-session 前台 watcher 改造（保留仅 UI 刷新）
- budget 滑动窗口（仅 daily）/ budget 告警通知
- 心跳多时区（每 role 各自时区）—— 本版本单一 squad timezone 字段

---

## 8. 量级预估（req §8）

- **新文件数**：12-16（scheduler 子系统 + squad 级 file-watch adapter + budget aggregator + UI 配置组件 + 自动工作历史 tab + tech spec）
- **估算代码行**：2500-3500
- **风险溢价**：scheduler + 重启续接 + file-watch debounce corner case 多，预留 30% buffer

---

## 9. 风险点 / 设计注意

- scheduler 是**全新基础设施**：timer 内存管理、重启续接、多 squad 隔离是新挑战。
- budget 与 session_usage 同步：consumption 上报后 budget 须立即反映（实时聚合）。
- file-watch 过载：debounce + 路径订阅规则要严格，否则 board 每次微改全员都醒。
- 重启一致性：重建 timer 不能漏（尤其 hire 过 member 但还没下次 tick 就重启）——靠 lastFiredAt 兜。
- enableHeartBeat toggle 即时生效：不依赖 timer 内部缓存（每 tick 轮询）。
- tick 触发 + reactive 并发：tick 醒来时正好 user 来消息 → busy 跳过 + reactive 走 enqueue。
- 时区：activeWindow + daily 回血都涉时区，统一 squad timezone 单字段避免 UTC/local 混用 bug。

---

## 10. 版本

v0.0.33.4 — 自主性 infra 收官（scheduler 1s 轮询+lastFiredAt+busy 跳过+killswitch+.unref / squad 级 file-watch watcher 路径路由+debounce / budget 横向聚合 helper / enableHeartBeat killswitch / UI autonomy toggle+budget meter+heartbeat config+自动工作 tab）。Squad 层收官版本。权威变更日志：本文。依赖 v0.0.33.3（OKF 双轨）+ v0.0.33.2（4 scope 对话）+ v0.0.33.1（占位字段）。

