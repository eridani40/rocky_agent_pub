---
type: spec
title: SquadChat Agent（哑路由 / 群聊）
priority: P1
status: active
updated: 2026-07-07
since: v0.0.33.2
---

# SquadChat Agent（哑路由 / 群聊）

> 定位：squad 的**群聊 agent**——纯消息**路由分拣器**。不创作内容、不做实质工作；收 user 消息→决定派给哪个角色→`send_message`→收回复（或群聊 UI 透传）→输出 `<EOS>` 结束 run。**reactive only**。
> 参考：`squad_definition.md §6`（EOS）、`squad_autonomy.md §4`（无心跳）、`../multi_agent/[P1]a2a_protocol.md`（AgentRef/回复规则/reachable_agents）、`../multi_agent/[P1]subagent_derivation.md §5`（send_message）。

## 1. 定位

`session.type = "squad"`。群聊的**分拣器**：收 user 在群聊的消息 → 决定派给哪个（些）角色 → `send_message` → 角色回复进群聊 inbox（**UI 直接渲染展示**，user 在群聊看见）→ SquadChat 可继续派发 或 输出 `<EOS>` 结束本轮 run。**永不创作 answer**。

> **UI 透传**：角色回给 SquadChat 的 a2a 消息（`sender.source="agent"`, `to=SquadChat`）由群聊 UI 直接渲染（"alice: …"），SquadChat agent **不需要逐条处理**——其 system prompt 已知转发由 UI 透传，可直接 `<EOS>` 收尾。

## 2. system prompt 构建链（复用 prompt builder section 体系）

| section | 内容 |
|---|---|
| **identity** | "你是 SquadChat，消息路由器。永不创作内容，只把 user 消息派给合适角色，本轮完成则输出 `<EOS>`" |
| **rules** | 路由规则（如何选角色）+ "不写答案/不干活" + `<EOS>` 规则（§5.1）+ **"消息从哪来到哪去"**（a2a_protocol §4.1：群聊里 user 消息由你路由，回复透传 UI；不需你创作） |
| **tool_guidance** | `send_message` 用法（目标 = leader/member；**不含 user**——user 在群聊 UI 旁） |
| **reachable_agents** | ★ 动态注入可达对象（`../multi_agent/[P1]a2a_protocol.md §3`）：**同 squad leader + members**（不含 user） |
| **context_files** | 成员花名册（name + 一行角色描述）——路由要用 |
| ~~memory~~ | 无（路由对话短，不留长记忆） |
| ~~skills~~ | 无 |

**路由消息时透传 inReplyTo**：SquadChat 把 user 原消息派给 role 时，传 `inReplyTo = user 原消息.id`——让 user↔role 群聊对话双向可追溯（细节 `../multi_agent/[P1]a2a_protocol.md §4`）。

### 2.1 转发 content 3 段模板（v0.0.85.ui_opt F3）

SquadChat 把 user 消息转发给 member 时，`send_message` 的 **content text blocks** 必须按下面 3 段结构化模板产出（按字面 `###` 标题分隔，让接收方 LLM 好解析；**不扩 a2a §5 消息体**）：

| 段 | 字面标题（vision/AT 断言用） | 内容 | 数据来源 |
|---|---|---|---|
| ①说明 | `### 说明` | 这是一条来自群聊 `{{squad_name}}` 的转发，由群聊 router（SquadChat）向你转发；按 needReply 决定是否回复；如需回复，必须回复给来源 session（即群聊），用 `send_message(to=SquadChat)` | 群聊名：squad_role mapper 加载 squad_chat.md 时 `fillTemplate({{squad_name}} → ctx.config.studioContext.squad.name)`（代码注入，非 LLM 自填——LLM 会把 `{xxx.yyy}` 点号 brace 当字面量 echo，必须代码替换）；router 名 = "SquadChat" 固定 |
| ②原文 | `### 原文` | 本条消息在群聊中来自 `{sender}`，对话原始内容为：`{一字不差的 user 原文}` | sender 标识：user → "user"；mate/leader → `{name} ({sessionId})`（SquadChat 从 transcript 解析）；原文必须一字不差 |
| ③相关上下文 | `### 相关上下文` | 群聊中相关上下文包括：`{概括/改写让收信人好理解；无则填 "无"}` | SquadChat 从最近群聊 transcript 自行概括（轻方案，先不代码注入） |

**needReply 决策**：
- `needReply` 是 `send_message` 的**顶层字段**（不进 content；a2a §4.2），**默认 true**（v0.0.68 R5 已落地 schema default + normalize `?? true` 兜底）。
- user 消息 → 默认 needReply=true（要求 member 回复）；leader `@mate` 下达 / mate `@leader` 提问 → SquadChat 按语义判断 needReply（命令式可 false，提问式 true）。

**Invariants（MUST NOT 破坏）**：
- ①转发仍是 `send_message` 的 content text blocks（**不扩** a2a §5 消息体）。
- ②sender 永远是 SquadChat 自己（reply 走 `to=sender.agent.ref` 必回群聊；不能改成 sender=原 user）。
- ③needReply 是顶层字段不进 content。
- ④接收方前缀渲染不变（`[Message from SquadChat (squad, needReply=...)]:`）。
- ⑤红线：**永不改写 user 原文**（②原文段一字不差）；**永不创作 answer**（③上下文段只概括已有群聊内容，不发明新信息）。


## 3. tools

| 工具 | 有？ |
|---|---|
| `send_message`(→ leader/member) | ✅ |
| 业务工具（file/web/bash…） | ❌ |
| `spawn_agent` | ❌ |
| hire/bench/edit/panorama | ❌ |

## 4. context engine

**最小**：路由历史（transcript）。不需长工作记忆；compact 极少触发。**不读** 工作目录产出 / panorama。

## 5. 自主性 / 心跳

❌ **无心跳**（reactive only，autonomy §4/SD5）。只在消息到达时 activate；run 到 `<EOS>` 静默结束（session 持久，新消息再 activate，definition §6）。

### 5.1 `<EOS>` 处理机制（C4 决议）

`<EOS>` = 保留字 token，**不新增 StopReason**：
1. **SquadChat system prompt 强制说明**：不创作 answer；不需要调工具时**直接输出 `<EOS>`** 结束当轮。
2. **stop sequence 配置**：LLM 调用配 `stop = ["<EOS>"]`，token stream 在 `<EOS>` 处自然停（缓存友好；如 provider 不支持 stop seq，后处理 strip）。
3. **answer 中含 `<EOS>` 不展示给 user**：客户端 / SquadChat agent 收尾时 strip 掉 `<EOS>` 标记（即"路由完毕"的信号，不该露给用户）。
4. **stopReason 仍为 `no_tool_call`**：LLM 无 tool_call + 输出 final text（含 `<EOS>`）→ 标准 normal exit，五态机走 `markIdle`。session 持久，下条消息进 inbox 自然 re-activate。

## 6. 可见性

- 成员花名册：✅（路由要）
- panorama：❌（最小，不需要）

## 7. model

`squad.modelDefault`（路由不需强模型）。

## 8. 用户入口

用户在群聊（SquadChat session）打字 → 进 SquadChat inbox（`sender.source="user"`）→ SquadChat 路由给角色 → 角色回复经 send_message 到 SquadChat inbox → **群聊 UI 渲染**给用户。群聊是用户入口之一（非唯一，用户也可单人聊 leader/member）。

## 9. 衔接

| 零件 | 归属 |
|---|---|
| session.type=squad、`<EOS>` 语义 | `squad_definition.md §6/§7` |
| AgentRef / reachable_agents / 回复规则 | `../multi_agent/[P1]a2a_protocol.md` |
| send_message / enqueue+activate | `../multi_agent/[P1]subagent_derivation.md §5` |
| reactive only（无心跳） | `squad_autonomy.md §4` |

---

> 变更历史见 [\`log.md\`](log.md)（本 KB 位置轴）+ [\`specs/tech/version_logs/vX.Y/change_log.md\`](../version_logs/)（跨版本发布说明）。
