---
type: concept
title: 三角色对比汇总
priority: P2
status: active
updated: 2026-08-02
since: v0.0.33.2
---

# 三角色对比汇总（SquadChat / Leader / Mate·执行者）

> 三角色 agent 的差异速查。每角色细节见各自 spec：`[P1]agent_squad_chat.md` / `[P1]agent_leader.md` / `[P1]agent_member.md`（agent_member.md 标题已改 Mate Agent，文件名保留）。
> 哲学：**真实团队隐喻**——路由员(SquadChat) / 管理者(leader) / 执行者(mate)，分工照真实团队。
> 旧草稿中的 `session.type=member` / 标题 Member 已统一为 `mate` / Mate·执行者；`member` 仅保留作持久化实体名。

## 对比矩阵

| 维度 | **SquadChat** | **Leader** | **Mate（执行者）** |
|---|---|---|---|
| session.type | `squad` | `leader` | `mate` |
| 定位 | 哑路由分拣器 | 协调者/管理者 | 执行者 |
| 做实质工作 | ❌ | ❌（仅协调） | ✅ |
| **system prompt 链** | identity + rules + tool_guidance + 花名册 | identity + rules + skills + 工具 + team-status + memory | identity + rules + skills + 工具 + 花名册 + memory |
| **业务工具**(file/web/bash) | ❌ | ❌ | ✅ |
| `agent`(spawn/query/abort) | ❌ | ❌（sub-agent 是 mate 私产，不插手） | ✅ 全（自己派的） |
| `send_message` 目标 | → leader/mate | → 全队 + SquadChat | → 全队（leader+peer） |
| `team`(hire/deploy/bench/edit/list/query) | ❌ | ✅ 全（**无 fire**，U5：长期 bench = 离队） | **list/query 只读**（看花名册） |
| `presence`(set/clear) | ❌ | ✅ | ✅ |
| `todo` | ❌ | ✅（共享 session 级工具） | ✅ |
| `panorama` | ❌ | ✅（业务全景 DSL 看板搭建） | ✅（搭建） |
| **context engine** | 最小（路由历史） | 全团队视图（花名册+reports+panorama+team-status） | 工作记忆（transcript+workspace+花名册） |
| **心跳** | ❌ reactive only | ✅ squad 级统一调度 | ✅ squad 级统一调度 |
| 成员花名册可见 | ✅（路由要） | ✅ | ✅（Q1，peer 协作） |
| 工作目录产出（交付/temp/outputs/reports） | ❌ | ✅ 读写 | ✅ 读写 |
| panorama | ❌ | ✅ 读写 | ✅ 读写 |
| model | team default | 可配（偏强） | 可配（按需） |
| `<EOS>` 结束 run | ✅ | — | — |
| 用户可直聊 | ✅ | ✅ | ✅ |
| budget gate（心跳） | — | ✅ | ✅ |
| 可替换/解雇 | — | ❌ 固定 | ✅（leader/user bench；长期 bench = 离队，U5 无 fire） |

> `[v0.0.237 removed]`：原 charter / task / goal / requirement / board 工作项链路全删——对比矩阵不再有 charter 可见 / board 读写 / task 视角 / goal·requirement 工具行。业务数据看板由 panorama（独立 DSL 体系）承载；轻量任务由 todo（session 级共享工具）承载。

## 通信拓扑（结构可达）

```
用户 ──┐
        ├──▶ SquadChat ──▶ {Leader, Mates}        (路由派发)
        │     ▲
        │     └── 角色回复进群聊 inbox
用户 ──┼──▶ Leader ◀──▶ Mates (peer)              (任意 session 直聊 + peer 自由通信 Q2)
        └──▶ Mate ◀──▶ 其 Sub-agents (只回 parent)
```
- SquadChat：路由 user↔roles，`<EOS>` 结束。
- Leader↔Mate、Mate↔Mate：**peer 自由通信**（Q2，人类社会可）。
- Mate→Sub-agent：派生，sub-agent 只回 parent（multi_agent 拓扑编码）。

## prompt 链构建（都复用 v0.0.22 prompt builder section 体系，组装不同 section）

| section | SquadChat | Leader | Mate（执行者） |
|---|---|---|---|
| identity | ✅ 路由器 | ✅ 协调者 | ✅ 执行者 |
| rules | ✅ 路由+EOS | ✅ 管理协议+升级规则 | ✅ 接分配自己汇报+不越权 |
| skills | ❌ | 管理/规划 | 业务 |
| tool_guidance | ✅ send_message | ✅ 全协调工具+presence | ✅ send+spawn+业务+presence |
| context（花名册/产出/team-status） | 花名册 | 花名册+reports+team-status | 花名册+workspace |
| memory | ❌ | ✅ 长期 | ✅ 长期 |

## 一句话区分

- **SquadChat** = 嘴（路由，不思想不干活，`<EOS>` 闭嘴）
- **Leader** = 脑 + 嘴（接需求/拆解/分配/跟进/收交付，不手——不干活）
- **Mate（执行者）** = 手（接分配、自己推进、自己汇报，可拉 sub-agent 帮手，可找同事协作）

---

> 变更历史见 [\`log.md\`](log.md)（本 KB 位置轴）+ [\`specs/tech/version_logs/vX.Y/change_log.md\`](../version_logs/)（跨版本发布说明）。
