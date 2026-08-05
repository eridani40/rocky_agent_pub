---
type: spec
title: Leader Agent（协调者）
priority: P1
status: active
updated: 2026-08-02
since: v0.0.33.2
---

# Leader Agent（协调者）

> 定位：squad 的**协调者/管理者**。接用户需求 → 拆解 → @mate 分配 → 跟进 → 收交付；hire/bench/edit member；按需向用户汇报/提问。**不做实质工作**（工具受限，仅协调类）。**有心跳**。
> 参考：`squad_definition.md`（角色分工/hire-bench）、`squad_autonomy.md`（心跳/budget）、`../multi_agent/`（send_message/spawn）。

## 1. 定位

`session.type = "leader"`。**协调者**：接用户需求 → 拆解 → @mate 分配 → 跟进 → 收交付；管理成员（hire/bench/edit）；按需向用户汇报/提问。**不做实际工作**（不写代码/不跑工具活）——活儿全派 member。**固定角色，不可替换**（design §9.2）。

## 2. system prompt 构建链

| section | 内容 |
|---|---|
| **identity** | leader 人设（团队协调者） |
| **rules** | 团队管理协议（hire/bench/edit 规则 + **bench member 须告知用户** + 不可换 leader）+ **"消息从哪来到哪去"**（a2a_protocol §4.1：a2a→send_message 回；非 a2a→自己 session 出 final text；主动问 user 在群聊）+ 升级规则（何时向老板汇报/提问） |
| **reachable_agents** | ★ 动态注入可达对象（`../multi_agent/[P1]a2a_protocol.md §3`）：**squadchat + 同 squad 所有 member**（不含 user——user 在 session UI 旁） |
| **team_status** | ★ **团队当前状态段**（`squad_team_status` reminder）：只列 session 正在 running 的成员及其 presence 标记（`member.currentWork`，可能为空）；睡着的不展示。详 `squad_reminder_providers.md §3` |
| **skills** | 管理/规划类（可选） |
| **tool_guidance** | send_message + team(hire/deploy/bench/edit) + **presence(set/clear)** |
| **context** | 成员花名册 + reports |
| **memory** | 长期（团队历史，累积） |

## 3. tools（受限·**收敛 action 化**——仅协调，无业务工具）

> **[v0.0.48] static-by-type**：leader 工具集 = `TOOL_POLICY['studio-leader'].bound`，不再由 `Member.tools` config 驱动；`buildSessionConfigFromDeps` 调 `resolveTools(role='studio-leader')` 查 policy。**三层门控一致**自动满足（policy 单源，三层都查它）。

工具集 = **`TOOL_POLICY['studio-leader'].bound`**（policy 单一权威，`tool-policy.ts`）：send_message + team + presence + panorama + 6 文件（read/write/edit/glob/grep/bash）+ skill + 3 web（web_search/web_fetch/browser）。

| 工具 | 有？ | 说明 |
|---|---|---|
| `send_message`(→ member/SquadChat/全队) | ✅ | 协调通信 |
| **`team`**(hire/deploy/bench/edit/list/query) | ✅ | 团队管理（squad_tools §2）；**无 fire**（U5：长期 bench = 离队） |
| **`presence`**(set/clear) | ✅ | 标记自己当前工作（进 team-status，squad_tools §4） |
| **`panorama`** | ✅ | 业务全景 DSL 看板（如需搭建业务数据视图，详 panorama_tools.md） |
| **文件工具**(read/write/edit/glob/grep/bash) | ✅ | 写工作目录文档/reports（okf 组织建议见 okf-skill + squad_okf.md）；「不直接编码」是 prompt 软约束（§1 红线），与工具可用性正交 |
| **`skill`** | ✅ | progressive disclosure L1（读 skill 引导：okf-skill） |
| **web 工具**(web_search/web_fetch/browser) | ✅ | leader 联网调研/检索 |
| **`agent`**(spawn/query/abort) | ❌ | **不在 leader bound**（leader 不创建子 agent）；想了解 member 进度→`send_message` 问 / 看 reports / 看 panorama |
| ~~`task`/`goal`/`requirement`~~ | ❌ | v0.0.237 移除（工作项链路全删）；轻量任务用 `todo`（共享工具，非 squad 收敛） |

详见 `../agent/tools/[P0]tool_policy.md §2.2`。

**三层门控一致**（v0.0.48 简化）：policy 单源 = config/schema/exec 三层都查同一份 `TOOL_POLICY['studio-leader'].bound`，由 `resolveTools()` 单方法驱动。

## 4. context engine

**全团队视图**：花名册 + reports + panorama（如搭建）+ 工作目录产出。上下文较大 → compact 正常触发。leader 需全局判断（拆解/调度/升级）。

## 5. 自主性 / 心跳

✅ **参与心跳**（[v0.0.116] squad 级统一调度，autonomy §3-§5）。**不再独立 `HeartbeatConfig`**——全队一份 `squad.heartbeatConfig`（interval/activeWindows/scope），leader 默认在范围内（scope=all 含 leader；whitelist 需在白名单）。到点被投递固定心跳提示词 → 醒来检查 member 状态、team-status、reports，主动调度/升级。受 team budget gate（autonomy §6，off=不限量）。**被唤醒后先 `presence(set)` 标记，无事时 `presence(clear)`**（§2 tool_guidance）。

## 6. 可见性

- 成员花名册：✅
- 工作目录产出（交付/temp/outputs/reports）：✅ 读写
- panorama：✅ 读写（如搭建）

## 7. model

可配（SD2），缺省 `squad.modelDefault`。协调/拆解建议偏强模型。

## 8. 用户入口 / 升级

- 用户可直接聊 leader（任意 session 入口）——此时 user 与 leader 在**同一 session**，leader 想答 user 直接出 final text。
- **升级路径**：leader 按规则**主动问 user**——leader 在自己 session 时直接出 final text；user 不在 leader session 时（如 user 在群聊），leader `send_message(to=SquadChat, needReply=false)`，群聊 UI 直接展示该消息，user 在群聊看见并回复（回复经 SquadChat 路由回到 leader）。

## 9. 衔接

| 零件 | 归属 |
|---|---|
| 角色分工 / hire-bench 权限 | `squad_definition.md §5`、`squad_tools.md §2`、design §9.2 |
| 心跳 / budget | `squad_autonomy.md` |
| send_message | `../multi_agent/[P1]subagent_derivation.md §5` |
| panorama 工具 | `[P1]panorama_tools.md` |

---

> 变更历史见 [\`log.md\`](log.md)（本 KB 位置轴）+ [\`specs/tech/version_logs/vX.Y/change_log.md\`](../version_logs/)（跨版本发布说明）。
