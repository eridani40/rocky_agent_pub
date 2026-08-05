---
type: design
title: Squad 层设计（决策日志 SD1-SD8）
priority: P1
status: active
updated: 2026-08-04
since: v0.0.33.1
---

# Squad 层设计（draft）— 团队 / 角色 / 自主性

> **状态**：SD1-SD8 已定（本轮）；§7 待探讨项见各子 spec 落地决议。
> **范围**：在 multi_agent 地基（session / spawn_agent / send_message / usage 递归）之上，加「团队/角色定义 + 自主性（scheduler 心跳 + budget）+ charter」。**本层不含 sub-agent 派生**（已 done，见 `../multi_agent/`）。
> **参考**：`../multi_agent/{overall, design, [P1]subagent_derivation}.md`；调研 `../../research/multi_agent_squad/`（AgentScope + CrewAI）；用户首轮 squad 概念（squad/角色/sub-agent 三类、leader/member、SquadChat 哑路由 + EOS）。

---

## 0. TL;DR

squad 层 = **multi_agent 地基**（已就位）+ 三组新东西：
1. **团队/角色定义**（`SquadSpec` / `RoleSpec` + `Charter`）
2. **自主性 infra**：`scheduler`（心跳/唤醒）+ budget 追踪——**核心新增组件**（现有系统无）
3. **角色派生**（共享 config、新 session，复制父成员个人差异 AGENTS.md；memory 不复制——已团队盘共享）

> 角色与 sub-agent 的关键区别：角色**可配 model**（SD2）、**有自主心跳**（SD5）、**走团队级 budget**（SD6）；sub-agent 是 model inherit、无心跳、按 parent 计。

---

## 1. 已定决策（SD1-SD8）

| # | 决策 | 内容 |
|---|---|---|
| **SD1** | 角色创建/派生 | **不走模板**。新建（fresh）或 `deriveFrom` 已有角色（**共享 config、新 session**）；派生时**复制父成员个人差异 AGENTS.md**（`.rocky/agents/{父name}-{父id}.md` → `{子name}-{子id}.md`，父无 → no-op）。memory 不复制（已团队盘共享） |
| **SD2** | 角色 model | **可配置**，缺省 = 团队 `modelDefault`（区别 sub-agent D8 inherit-only——角色更 first-class） |
| **SD3** | SquadChat EOS | agent loop 到 EOS = **静默结束当前 run**（非销毁）；session 持久，**新消息 → 再 activate**（复用 multi_agent O3 重激活）。共享 session 模型不破坏，只是"能 silently end" |
| **SD4** | 唤醒机制 | **双模**：①事件唤醒（消息）**恒开**——有人发消息必工作；②心跳（proactive）= **活跃时段 + 间隔**。唤醒 = **enqueue 一个定时 tick 消息 + 尝试 activate**（复用 enqueue+activate） |
| **SD5** | 心跳归属 | **SquadChat 无心跳**（纯 reactive）；**leader + member 各有独立心跳**，各是各的 |
| **SD6** | budget | **团队级**、**天窗口**、**仅 gate 心跳(proactive)**；耗尽 → **停当周期心跳、reactive 仍响应**。数据来自 `session_usage`（已追踪）。目的：防自动工作烧太多 token |
| **SD7** | 生命周期/总开关 | **无 TTL**（用户管理状态）；squad 有 `enableHeartBeat` 总开关（默认 false，schema_defs/squad/squad.ts:60 权威；替代旧 autonomyEnabled），**关 → 所有 leader/member 心跳停、只 reactive** |
| **SD8** | Charter（leader 管理 + member 任务驱动） | charter（goals/workingStyle/collaboration/escalation）**由 leader 持有管理**（非全员共享）；leader 据此拆 goals→tasks→分配 member；**member 任务驱动（不看 charter）**；leader 按 escalation 在 squad chat 问用户 |

---

## 2. 数据结构

```typescript
interface SquadSpec {
  squadId: string;
  leader: RoleSpec;                       // 自动分配
  members: RoleSpec[];                    // 初始成员（后续 hire/bench）
  squadChat: { systemPrompt: string; eosRule: string };  // 哑路由器（reactive only）
  charter: Charter;                       // SD8
  budget: Budget;                         // SD6 团队级
  enableHeartBeat: boolean;               // SD7 总开关（默认 false；替代旧 autonomyEnabled，schema_defs/squad/squad.ts:60 权威）
  modelDefault?: ModelRef;                // 团队默认 model（角色可覆盖，SD2）
}

interface RoleSpec {
  roleId: string; name: string;
  role: "leader" | "mate";        // [v0.0.33.1] B 方案：原 type:"leader"|"member" → role:"leader"|"mate"（避免与 entity/type 名撞，详见 squad_definition.md §3）
  systemPrompt: string;
  tools: string[];                        // allowedTools（含 send_message 可达集）
  skills?: string[];
  model?: ModelRef;                       // SD2：缺省 = squad.modelDefault
  heartbeat?: HeartbeatConfig;            // SD4/SD5：leader/member 各有；SquadChat 无
  // —— 派生（SD1）——
  deriveFrom?: string;                    // 从已有 roleId 派生（共享 config）
}

interface HeartbeatConfig {               // SD4
  activeWindow: { start: string; end: string; timezone?: string };  // 活跃时段（之外不自动工作）
  interval: number;                       // 活跃时段内唤醒间隔（ms/min）
}

interface Budget {                        // SD6
  limit: number;                          // token 上限
  window: "daily";                        // 天级刷新
  scope: "team";                          // 团队级（后续可扩 per-role）
}

interface Charter {                       // SD8
  goals: string;
  workingStyle: string;
  collaboration: string;
  escalation: string;                     // 何时向老板（用户）汇报/提问
}
```

---

## 3. 心跳 / 唤醒机制（SD4 / SD5）

**两种唤醒，同一原语（enqueue + activate）：**

| 模式 | 触发 | gate | 说明 |
|---|---|---|---|
| **事件唤醒（reactive）** | 任何 send_message / 用户消息到达 | 仅并发上限（multi_agent §3.1） | **恒开**，不受 budget / autonomy 开关限制——"有人发消息必工作" |
| **心跳唤醒（proactive）** | scheduler 在 `activeWindow` 内每 `interval` 触发 | enableHeartBeat（SD7）+ 团队 budget 余量（SD6）+ 并发上限 | leader/member 各有；SquadChat 无 |

**心跳唤醒 = scheduler 定时 `enqueue(tick 消息) + activate(role)`**——复用 multi_agent 的 enqueue+activate，无新投递机制。tick 消息内容/格式 = §7 待定。

**Scheduler（新子系统）**：管理各 role（leader+member）的心跳定时器；按 `activeWindow`+`interval` 触发；触发前查 autonomy 开关 + budget + 并发，通过才 enqueue+activate。reactive 唤醒不经 scheduler（直接 enqueue+activate）。

---

## 4. budget 治理（SD6）

- **粒度**：团队级（一个 squad 一个 budget）。
- **窗口**：daily（每日 0 点回血，时区待定）。
- **gate 范围**：**仅心跳(proactive) activate**；**reactive(消息) 不受 budget 限制**（仍受并发限制）。
- **耗尽行为**：当周期心跳停（scheduler 跳过 proactive activate）；reactive 照常响应。
- **数据源**：`session_usage`（已追踪 each session usage）→ 按 squad 聚合（leader+member+SquadChat 的 current+sub+forked）。
- **目的**：单纯防自动工作 token 失控，不是硬性配额。

---

## 5. 角色派生（SD1）

- **新建**：fresh RoleSpec，建独立 session。
- **派生**（`deriveFrom: roleId`）：**复制父角色 config**（systemPrompt/tools/skills/model/heartbeat）→ **新独立 session**（不共享 session）+ **复制父成员个人差异 AGENTS.md**（`.rocky/agents/{父name}-{父id}.md` → `{子name}-{子id}.md`，父无 → no-op；不碰 memory，memory 已团队盘共享）。
- 派生后两角色完全独立（各自 session/state/usage/心跳）。

---

## 6. 与 multi_agent 地基的复用

| multi_agent 机制 | squad 层复用为 |
|---|---|
| session.type=squad/leader/mate（O4，`[v0.0.33.1]` 原 member→mate） | 角色 session 直接用 |
| enqueue + activate（D5/send_message） | 唤醒原语（事件 + 心跳都走它） |
| activate 三情况 + O3 重激活 | SquadChat EOS 后再 activate（SD3） |
| 并发上限 §3.1（全局主/sub/单主sub） | 角色/sub-agent 激活都受约束 |
| spawn_agent（D4） | member 派生 sub-agent 干活 |
| session_usage 递归 sub 上报 | 角色+sub 的 usage 聚合 → budget 数据源 |
| abort 单向级联（D6） | squad 取消 → 级联 leader/member → sub |

---

## 7. 待探讨

- **tick 消息内容/格式**：心跳唤醒 enqueue 的 tick 是什么（时间戳标记？空信号？），role prompt 据此决定做不做。
- **Charter 投递方式**：charter 怎么给角色——注入各 role systemPrompt？共享 context block？每个角色看全 charter 还是按 type 裁剪？
- **leader 升级问用户的路径**：leader 按 charter escalation 在 squad chat 发问 → 用户看到（group chat 是用户视图）→ 用户回 → SquadChat 路由给相关角色。role→user（升级）的确切消息流待定。
- **activeWindow 时区**：默认用户时区？squad 配置？
- **Scheduler 持久化**：进程重启后心跳怎么续——从 RoleSpec.heartbeat 重建定时器（cron 式）够吗？还是要持久化 schedule 状态？
- **budget 计费口径**：reactive 工作（不受 gate）是否也计入 budget（记账但不限）？大概率是——用于显示/审计。
- **SquadChat 如何路由 role→user 升级消息**（与上一条相关）：router 主要 user→role，role→user 反向需明确。

---

## 8. 衔接现有 spec

| 零件 | 归属 |
|---|---|
| 团队/角色定义 + charter + 心跳 + budget + 派生 | 本目录（待 formal spec） |
| scheduler 子系统（新） | 本目录（待 spec，可能独立 `[P1]scheduler.md`） |
| session.type=squad/leader/mate（`[v0.0.33.1]` member→mate） | `../multi_agent/[P1]subagent_derivation.md §2` |
| enqueue+activate / 重激活 / 并发 / abort 级联 | `../multi_agent/[P1]subagent_derivation.md` |
| usage 聚合（budget 数据源） | `../agent/session/[P0]session_usage.md` |

---

## 9. 后续轮次决策补充

### 9.0 设计哲学（指导原则 ⭐）
**把 squad 建模成真实人类团队**——用形式化定义 + 程序化方式表达真实团队动态。设计存疑时问"真实团队怎么做"：成员互相可见、自由通信、各有 workspace、共享看板/产出、新人靠共享结构 onboard。

### 9.1 成员可见性 + 通信（Q1/Q2 定）
- **member 看得到全队成员列表**（Q1）。
- **member↔member 可直接通信**（Q2）——"人类社会可以，本模型照做"。

### 9.2 Hire/Bench 权限（Q4 定 + 后续 §9.5 收敛 + U5 删 fire）
- **不能换 leader**——leader 是固定**协调者**，不做实际工作，**工具受限**（仅协调类：send_message / team / task / goal 等）。
- **leader 可 bench member**（替代旧 disable，详见 §9.5），**必须通知用户**。
- **leader 可 edit member 配置**（工作方式 systemPrompt、skills 等）。
- **U5：删 fire，仅 bench**——"永久剔除"语义由 bench 承担：长期 bench 不 deploy 即等价于离队。session 留盘可读，token 消耗已计入历史 budget，UI 隐藏 benched 成员即可。
- member 不能 hire/bench/edit。

### 9.5 工具收敛（✅ 已落 `[P1]squad_tools.md`）
管理工具收敛为 action-based 单工具：**`team`**(hire/deploy/bench/edit/update_charter/list/query/get_charter) + **`task`**(create/assign/claim/update_status/query)，省 LLM tool slot。**deploy/bench** 替代旧 enable/disable（真实团队动词）。member 新增 **claim** 动作（认领未分配 task，"其他人不能新建 task"但可认领）。**U5 已删 fire**（长期 bench = 离队）；**U3 已加 update_charter / get_charter**（charter 由对话驱动演化，详见 `squad_tools.md §2.1`）。goal/requirement 暂不强制收敛（建议待 MVP 后观察）。

### 9.3 任务系统（Q3/Q5 定）
- **任务 = 全员共享**，**共享 store + 工具**（create/assign/update_status/query）。
- **看板内容**：**目标 + 当前任务 + 任务依赖**（Q5）。
- leader 创建/分配 task；member 任务驱动（context 注入"分配给我的 task"）。
- 看板 leader + user 可见；member 看自己的 task。

### 9.4 团队目录结构（✅ 已落 `[P1]squad_workspace.md`）
squad 有**结构化目录**（团队"办公室"）：`.rocky` 隐藏内置（系统内部 state/memory/skills）+ `board`（公共看板）+ `outputs`（公共产出）+ `reports`（按类型分 daily·tasks·goals）+ `workspaces`（各员工工位）。**无 inbox 目录**——输入复用 session message inbox（`agent_inbox_enqueue`），不另设。结构化为新 hire onboard；接 v0.0.17 workspace + file-watch。
