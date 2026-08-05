---
type: concept
title: Squad 自主性 infra（心跳 / scheduler / budget）
priority: P1
status: active
updated: 2026-07-11
since: v0.0.33.1
---

# Squad 自主性 infra（心跳 / scheduler / budget）

> 定位：角色 **proactive 自主工作**的基础设施——scheduler（心跳/唤醒）+ budget 治理 + autonomy 总开关。**scheduler 是现有系统没有的真新增组件**。
> 参考：`design.md`（SD4/SD5/SD6/SD7）；`../multi_agent/[P1]subagent_derivation.md`（enqueue+activate §5、并发 §3.1、重激活 §3.2）；`../agent/session/[P0]session_usage.md`（budget 数据源）。

---

## 1. 定位

| 模式 | 触发 | 谁有 |
|---|---|---|
| **reactive**（被动响应） | 消息到达（send_message / 用户） | 所有 agent（含 SquadChat） |
| **proactive**（自主心跳） | scheduler 定时唤醒 | leader + member（**SquadChat 无**，SD5） |

角色同时具备两种；SquadChat 只 reactive。budget 仅 gate proactive。

---

## 2. 唤醒双模（SD4）

| 模式 | 触发 | gate | 投递 |
|---|---|---|---|
| **事件唤醒（reactive）** | 任何 send_message / 用户消息到达 | **仅并发上限**（multi_agent §3.1） | 直接 `enqueue + activate`（恒开，**不受 budget / autonomy 开关限制**——"有人发消息必工作"） |
| **心跳唤醒（proactive）** | **[v0.0.116] squad 级 scheduler 在任一 `activeWindow` 内每 `interval` 到点整队一次** | `enableHeartBeat`（§7）+ activeWindows 时段 + **团队 budget 余量**（§6，off=不限量）+ 逐成员 scope∩deployed∩非busy | scheduler 逐成员 `deliverTo(固定心跳提示词)`（§5） |

> 两种唤醒**同一原语**（enqueue + activate，复用 multi_agent）。区别只在触发源 + gate。

---

## 3. 心跳配置（[v0.0.116] squad 级统一，替代 per-member SD4）

**心跳粒度从 per-member 升级为 squad 级**——整队一份配置，到点整团队一次。配置落 `squad.heartbeatConfig`（`data_model.md §1.1a`）：

```typescript
interface SquadHeartbeatConfig {
  interval: 5 | 15 | 30 | 60;       // 唤醒间隔（分钟），默认 15
  activeWindows: Array<{ start: string; end: string }>;  // 多工作时间段（跟 squad.timezone；段间不重叠 + 单段不跨0点；空数组=全天）
  scope: { mode: "all" | "whitelist"; memberIds: string[] };  // off=全员(含leader)/on=白名单（新增成员不自动纳入）
}
```

- **activeWindows 之外**：scheduler 不触发心跳（角色此时纯 reactive）。空数组 = 全天可调度。
- **activeWindows 之内**：每 `interval` 触发一次整队心跳（经 §5 gate）。
- **scope**：`all`=全员；`whitelist`=仅白名单。benched 任何模式不唤醒。
- **配置演进**：v0.0.33.4 的 `member.heartbeat`（per-member activeWindow/interval）**废弃**；心跳节奏 + 范围现由 squad 级 `heartbeatConfig` 单一源驱动（`data_model.md §1.2` member.heartbeat 标 dead）。

---

## 4. 心跳归属（[v0.0.116] squad 级，覆盖 per-member SD5）

- **SquadChat：无心跳**（纯 reactive，SD5 不动）。
- **squad 一份心跳配置**：到点对**范围内 deployed 成员**（scope=all 全员 / whitelist 白名单，含 leader）逐个投递固定心跳提示词。
- **不再 per-member 独立 activeWindow/interval**——全队同一节奏（`squad.heartbeatConfig`）。leader 与 mate 同一份配置，靠 scope 白名单决定谁被唤醒。

---

## 5. Scheduler（[v0.0.116] squad 级 job + 逐成员展开）

一 squad 一个 heartbeat job（公共 `SchedulerEngine` 上），到点整队一次，按 `heartbeatConfig` 展开投递。权威实现 = `../scheduling/[P1]heartbeat_handler.md §2`。

```typescript
// scheduler 触发一次整队心跳（任一 activeWindow 内 interval 到点）：
onSquadHeartbeatTick(squad):
  if !squad.enableHeartBeat: return                    // gate0 总开关关（默认 false）→ 跳过（不唤醒）
  windows = squad.heartbeatConfig.activeWindows ?? []
  if windows.length > 0 && !windows.some(w => withinActiveWindow(w, now, squad.timezone)): return  // gate1 多段（空=全天）；now=进程UTC，函数内转 squad.timezone
  if squad.budget !== null && squadBudgetRemaining(squad) <= 0: return  // gate2 budget（null=off=不限量放行；非null&&<=0 停当周期）
  // 队级 gate 全通过 → 逐成员展开投递（gate3 成员级 scope+deployed+busy）
  scope = squad.heartbeatConfig.scope ?? {mode:'all', memberIds:[]}
  for member in squad.members:
    if scope.mode==='whitelist' && member.id not in scope.memberIds: continue  // 非白名单跳过（新增成员不自动纳入）
    if member.state !== 'deployed': continue           // benched 不唤醒
    if isSessionBusy(member.sessionId): continue        // busy 跳过该成员（deliverTo 前 check，防堆 tick）
    manager.deliverTo(member.sessionId, buildHeartbeatTickMessage(now))  // 固定心跳提示词（含 <EOS> 出口句）
```

- **tick 消息内容**（[v0.0.116] 固定心跳提示词，`../scheduling/[P1]heartbeat_handler.md §0.1` 权威文案）：req 原文提醒 + `<EOS>` 出口句。成员被唤醒后无工具调用自然 no_tool_call 结束——**`<EOS>` 零机制改动**（不扩 stop token）。
- **busy check 必要性**：`deliverTo = enqueue(msg) + activate(sessionId)`；activate 幂等——session running 时返现有 run 但 enqueue 已执行 → tick 堆积。故 deliverTo 前 check `session.state==='running'`，busy 跳过该成员当周期。
- **reactive 唤醒不经 scheduler**（消息直达 enqueue+activate）。

---

## 6. Budget 治理（SD6）—— 与 token consumption 分离

**两个独立概念，不混为一谈：**
- **token consumption（持续记录）**：**所有**工作（reactive + proactive）的 token **持续记录**，走 `session_usage`（已追踪，永远开）——用于显示/审计/计费，**不限流**。
- **budget（仅心跳 gate）**：一个**阈值**，**仅在心跳(proactive)唤醒时检查**；不是消费记录器。

```typescript
// [v0.0.116] off/on 语义显式化：
//   squad.budget = null  → **off = 不限量**（gate 放行，proactive 正常触发）
//   squad.budget = { ... } → **on = 限量**
interface Budget {
  limit: number;        // token 阈值（仅心跳 gate 用；UI on 时默认 1_000_000/天）
  window: "daily";      // 天级刷新
  scope: "team";        // 团队级（Σ team 总消耗/天，不新增调度分桶）
}
```

- **gate 范围**：**仅 proactive（心跳）activate 查 budget**；**reactive（消息）activate 不查 budget**（只记 consumption，不限流）。
- **[v0.0.116] off=不限量**：`budget=null` 即 req「预算 switch off = 不限量」——现有 `null → gate 放行` 语义天然对齐，无需新增「无限量」态字段。`on` = 配 limit（默认 1M token/天），gate 用 `Σ team session_usage total`（团队总消耗，现有口径）判断。
- **耗尽行为**：当周期心跳停（scheduler §5 跳过 proactive）；**reactive 照常响应**（照常记 consumption）。
- **[v0.0.33.4] null=无 gate**：`squad.budget===null`（未配）→ **跳过 budget gate**（proactive 正常触发，等同无限制）。budget gate 仅当 `budget!==null && remaining<=0` 才生效。注意与 Display 语义分离：GET /budget/usage 对 null 仍返 `limit=-1/remaining=-1`（UI 显示「无限制」），consumed 照算——但该 -1 **不进 gate**（scheduler §4 gate2 先 check null 再调 remaining()）。权威实现见 `[P1]scheduler.md §4 gate2 + §5`。
- **数据源（聚合公式，C5 决议）**：

```
squadBudgetRemaining(squad):
  consumed = Σ over squad.members(含 SquadChat + leader + all members) of session_usage.total.total_tokens
  return budget.limit - consumed
```

> 含义：squad 下**所有 session**的预算与使用——**SquadChat / leader / member 各自**。各角色派生的 **sub-agent 自动统计到他们身上**（已走 session_usage §6.2 递归 sub 上报），不需另外横扫；squad 层只横向遍历团队 sessions，不递归。这与"parent→sub 递归"正交（递归在 usage 模块内部完成，squad 层看到的就是聚合后的 total）。
- **无 `sub_total` 字段**：`getUsageView(sid).total.total_tokens` 已含 sub-agent 递归（usage 模块内部完成聚合）；squad 成员是顶层 peer（parentSessionId=null），无自动 usage 提升，须**横向 Σ** team sessions 的 `total`。
- **`[v0.0.33.4]` drift 订正（数据源实现细节，权威见 scheduler.md §5）**：(1) `session_store.getUsageView` 真签名 `getUsageView(sessionId): Promise<SessionUsageView>`——**无 windowStart 参数**，返全时累计 total（公式中的「当窗口」靠 budget **baseline-delta** 实现：`budget-state.json` 维护 per-session baseline，`consumed = 全时 total − baseline`，窗口翻转重置）；(2) squad record 无 `leaderSessionId`/`memberSessionIds` 字段，各 role sessionId 经 `memberStore.listMembers` → `member.sessionId` 取（memberIds 含 leader）。
- **目的**：budget 单纯防自动工作 token 失控；consumption 是全程账本。
- **daily 窗口**（TBD4/5 决）：squad 配单一 `timezone` 字段（默认 user local），当日 0 点回血（baseline-delta 窗口翻转重置 baseline；非「重置 total」——total 永远全时累计，只是窗口内 consumed delta 归零）；23:59 tick 与 00:00 tick 属不同窗口（日期分桶）。
- **实时刷新**：`session_usage_update` event（session-store emit）→ UI budget meter 实时刷新（reactive 消耗也反映，P11）。
- **实现**：`budget-aggregator.ts` + `budget-state.ts`（baseline-delta）+ `squad-runtime.ts`（wiring 包装 getUsageView→getConsumed），详见 `[P1]scheduler.md §5`。

---

## 7. autonomy 总开关（SD7）

```typescript
// SquadSpec.enableHeartBeat: boolean（默认 false；schema_defs/squad/squad.ts:60 权威，替代旧 autonomyEnabled）
```

- **关（false）**：scheduler **停所有 leader/member 心跳**（§5 第一道 gate 即返），角色**只 reactive**。
- **开（true）**：心跳按配置正常触发。
- 用户随时切换；切换不影响 reactive 与 in-flight run。

---

## 8. 唤醒原语 = enqueue tick + activate（复用 multi_agent）

- 心跳唤醒 = `manager.deliverTo(role.sessionId, tick)`——**复用 multi_agent 的统一投递入口**（enqueue+activate 收敛到 deliverTo，无新投递机制）。
- activate 走 multi_agent §3.2 三情况：role idle → 情况2 markRunning → 新 run → drain tick + 按 prompt 行动 → run_end → idle（等下次心跳/消息）。

---

## 9. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| 心跳配置 + scheduler + budget + 总开关 | 本文 ✅ |
| enqueue + activate / 并发 / 重激活 | `../multi_agent/[P1]subagent_derivation.md` |
| usage 聚合（budget 数据源） | `../agent/session/[P0]session_usage.md` |
| SquadSpec/RoleSpec（heartbeat 字段） | `squad_definition.md` |

---

## 10. 待定（v0.0.33.4 已决，见 PRD §4 + `[P1]scheduler.md`）

> 原 §10 五项 TBD 在 v0.0.33.4 全部拍板，落 `[P1]scheduler.md`（权威）+ PRD §4。以下为决议摘要：

- **tick 消息内容/格式**（TBD2 决）：`{ kind:"proactive_tick", at, reason:"heartbeat"|"file-changed", path? }`。**[v0.0.116] 心跳 tick** 改用固定心跳提示词（`../scheduling/[P1]heartbeat_handler.md §0.1`），file-changed 仍走原格式。
- **scheduler 持久化**（TBD1 决 / **[v0.0.116] 覆盖为 squad 级**）：v0.0.33.4 从 `member.heartbeat` 重建 timer + per-role lastFiredAt；**v0.0.116 上收 squad 级**——从 `squad.heartbeatConfig` 重建 1 job + scheduler.json v2 squad 级 lastFiredAt（去 roles 分桶，`../scheduling/[P1]heartbeat_handler.md §3`）。
- **budget 计费口径**（TBD3 决）：reactive 计 consumption（显示/审计，不限流）；budget gate 仅 proactive。
- **daily 回血时刻/时区**（TBD4/5 决）：squad 配单一 `timezone`（默认 user local），0 点回血 + activeWindow 都跟它。
- **activeWindow 时区**：见上（单一 timezone 字段，TBD5）。

---

---

> 变更历史见 [\`log.md\`](log.md)（本 KB 位置轴）+ [\`specs/tech/version_logs/vX.Y/change_log.md\`](../version_logs/)（跨版本发布说明）。
