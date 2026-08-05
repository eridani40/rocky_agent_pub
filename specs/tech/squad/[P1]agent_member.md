---
type: spec
title: Mate Agent（执行者）
priority: P1
status: active
updated: 2026-08-02
since: v0.0.33.2
---

# Mate Agent（执行者）

> 定位：squad 的**执行者**。**接 leader 分配、自己推进、自己汇报**——干分配的活，报告 leader，与 peer 协作，派 sub-agent 干子活。**有业务工具 + 心跳**。
> 参考：`squad_definition.md`（派生/model）、`squad_autonomy.md`（心跳/budget）、`../multi_agent/`（spawn_agent/send_message）。

## 1. 定位

`session.type = "mate"`（B 方案：session.type 一律用 mate，避免与 Member entity 名撞，详见 `squad_definition.md §3` + `data_model.md §1.2`）。**执行者**：接 leader 分配 → 自己推进 → 完成报告（send_message 回 leader）→ 与 peer 协作；必要时 `spawn_agent` 派 sub-agent 干子活。**认领后干活，没落文件=没交付**。

## 2. system prompt 构建链

| section | 内容 |
|---|---|
| **identity** | member 人设（角色/专长） |
| **rules** | 接 leader 分配、自己推进、完成汇报 leader、可与 peer 协作 + **不越权**（不擅自做重大决策、不清楚就问）+ **"消息从哪来到哪去"**（a2a_protocol §4.1：a2a→send_message 回；非 a2a→自己 session 出 final text；主动问 user 在群聊） |
| **reachable_agents** | ★ 动态注入可达对象（`../multi_agent/[P1]a2a_protocol.md §3`）：**squadchat + leader + 同 squad 其他 member（peers）+ 自己派的 sub-agent**（不含 user——user 在 session UI 旁） |
| **skills** | 按角色（业务技能） |
| **tool_guidance** | send_message(全队) + spawn_agent + 业务工具 |
| **context** | 团队花名册（peer，Q1/Q2 协作用）+ 自己 workspace |
| **memory** | 长期（工作历史，累积） |

## 3. tools

> **[v0.0.48] static-by-type**：mate 工具集 = `TOOL_POLICY['studio-mate'].bound`，不再由 `Member.tools` config 驱动；`buildSessionConfigFromDeps` 调 `resolveTools(role='studio-mate')` 查 policy。mate `agent` 工具 = ✓（mate 派生 subagent 干活）。

| 工具 | 有？ | 说明 |
|---|---|---|
| `send_message`(→ leader + peer 全队) | ✅ | 协作/汇报/提问（Q2 peer 直连） |
| **`agent`**(spawn/query/abort) | ✅ | 派 sub-agent 干子活 + 查/中断**自己派的**（squad_tools §3；sub-agent 是 member 私产）|
| **`team`**(list/query 只读) | ✅（只读） | 看花名册（Q1 见全队，agent_member §6）；管理动作 hire/deploy/bench/edit 拒 |
| **`todo`** | ✅ | 轻量任务清单（共享 session 级工具，非 squad 收敛）|
| **`presence`**(set/clear) | ✅ | 标记自己当前工作（进 leader team-status，squad_tools §4） |
| **`panorama`** | ✅ | 业务全景 DSL 看板（如需搭建业务数据视图） |
| 业务工具（file×5 + bash + skill + web×3 = 10） | ✅ | **实际工作**（member 干活）：read/write/edit/glob/grep/bash/skill/web_search/web_fetch/browser |
| ~~`task`/`goal`/`requirement`~~ | ❌ | v0.0.237 移除（工作项链路全删） |

详见 `../agent/tools/[P0]tool_policy.md §2.2`。

## 4. context engine

**工作记忆**：自己 transcript（工作历史）+ workspace 文件 + 花名册（peer）。上下文随工作增长 → compact 正常触发。usage 上报 parent（无 parent 时为顶层）+ 进 team budget 聚合。

## 5. 自主性 / 心跳

✅ **参与心跳**（[v0.0.116] squad 级统一调度，autonomy §3-§5）。**不再独立 `HeartbeatConfig`**——全队一份 `squad.heartbeatConfig`；mate 在 scope 范围内（all 全员 / whitelist 需在白名单）且 deployed 时被投递固定心跳提示词 → 醒来推进手头工作（drain tick + 按 prompt 决定做不做，无事则输出 `<EOS>` 自然结束）。受 team budget gate（off=不限量）。**被唤醒/接任务后先 `presence(set)` 标记，无事时 `presence(clear)`**（便于 leader 掌握团队状态）。

## 6. 可见性 + 权限

- 成员花名册：✅ **全队**（Q1，peer 协作）
- 工作目录产出（交付/temp/outputs/reports）：✅ 读写
- panorama：✅ 读写（如搭建）
- spawn sub-agent：✅（sub-agent 只回 parent，multi_agent 拓扑）

## 7. model

可配（SD2），缺省 `squad.modelDefault`。执行类按需选（如便宜模型跑常规、强模型跑难活）。

## 8. 用户入口

用户可直接聊任一 member（任意 session 入口）——此时 user 与 member 在**同一 session**，member 想答 user 直接出 final text（"消息从哪来到哪去"，a2a_protocol §4.1）。member **不能** `send_message(to=user)`（user 不在 a2a 拓扑）。member 想主动问 user 又不在 user 当前 session 时 → `send_message(to=SquadChat, needReply=false)` → 群聊 UI 透传。

## 9. 衔接

| 零件 | 归属 |
|---|---|
| 角色分工 / 接分配自己汇报 | `squad_definition.md §5` |
| 派生 / model 可配 | `squad_definition.md §4/SD2` |
| 心跳 / budget | `squad_autonomy.md` |
| spawn_agent / send_message | `../multi_agent/[P1]subagent_derivation.md §4/§5` |
| panorama 工具 | `[P1]panorama_tools.md` |

---

> 变更历史见 [\`log.md\`](log.md)（本 KB 位置轴）+ [\`specs/tech/version_logs/vX.Y/change_log.md\`](../version_logs/)（跨版本发布说明）。
