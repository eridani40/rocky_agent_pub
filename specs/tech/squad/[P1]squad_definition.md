---
type: concept
title: Squad / 角色定义（概念权威）
priority: P1
status: active
updated: 2026-08-04
since: v0.0.33.1
---

# Squad / 角色 定义（squad 层）

> 定位：squad 层**概念权威**——定义 squad 是什么、member/leader/mate 角色语义、SquadChat EOS。建在 multi_agent 地基上。
> 参考：`design.md`（SD1/SD2/SD3/SD8）；`states/v0.0.33.1/design.md`（v0.0.33.1 实体 + API 锁定）；`[P1]data_model.md`（SchemaDef + 存储 + 事务）；`../multi_agent/[P1]subagent_derivation.md`（session.type §2、spawn_agent §4、send_message §5、重激活 §3.2）。
> **命名体系（B 方案锁定）**：**squad-member-subagent** + `member.role = leader | mate`；session.type 统一 `'squad'|'leader'|'mate'|'subagent'`（原 `member` → `mate`，避免和 member entity 名撞）。
> - `member` = 一个团队成员（entity，含 leader+mate，role 字段区分）
> - `leader` / `mate` = member.role 的两个值（mate 替代原 member）

---

## 1. 定位

**squad = 一个自主协作单元** = 1 leader member + N mate member + 1 SquadChat session（哑路由）+ budget（占位 v4）。每个 member = 一个 session（`type=leader|mate`）+ 自己的 agent-loop（v0.0.33.1 chat 全占位，loop 留 v0.0.33.2）。

member 用 multi_agent 的 `spawn_agent` 派生 sub-agent 干活、用 `send_message` 互相通信（v2+ 接通）。leader 接需求后拆解并 @mate 分配，mate 自己推进、自己汇报。

**member vs sub-agent**（关键区别）：
| | member（leader/mate） | sub-agent |
|---|---|---|
| model | **可配**（SD2，缺省团队） | inherit only（D8） |
| 自主心跳 | **有**（SD5，v4 scheduler） | 无 |
| budget | **团队级**（SD6，v4 占位） | 按 parent 计 |
| 创建方式 | hire（fresh/derive），**不走模板**（SD1） | 走 spawn_agent + 模板 |
| 生命周期 | member 不单删（bench 兜底无 fire）；team 可整体硬删（解散，v0.0.111 → member 随之物理删） | terminated 不删 session |

---

## 2. Squad（概念；SchemaDef 见 data_model.md）

```typescript
// 概念契约；完整字段 / engine / 分片 / 信封 → [P1]data_model.md §1.1
interface Squad {
  id: string;
  name: string;
  description: string;
  modelDefault: string;               // ModelRef
  leaderId: string;                   // → member（双向，应用层维护）
  memberIds: string[];                // → member[]（含 leader）
  squadChatSessionId: string;         // → session（squadChat 哑路由）
  budget: Budget | null;              // 占位 v4（存但不生效）
  enableHeartBeat: boolean;           // 默认 false（替代旧 autonomyEnabled；v4 scheduler 用）
  // createdAt / updatedAt / version
}
```

**[v0.0.33.1 design.md 锁定变更 vs 0.1 draft]**：
- `members: RoleSpec[]` → `memberIds: string[]`（member 是独立 entity，双向关联；SchemaDef 见 data_model.md）。
- `squadChat: { systemPrompt, eosRule }` → `squadChatSessionId`（SquadChat 是 session，type=squad；systemPrompt/eosRule 留 v2 build）。
- `autonomyEnabled` → `enableHeartBeat`（默认 **false**；占位 v4）。
- `budget` 改 optional（`| null`；占位 v4）。
- **新增：无 status 字段 / 无 archived / 不可删**（design.md §1.1；req.md 旧版 `DELETE /squad → _archived` **已推翻**）。

---

## 3. Member（概念；SchemaDef 见 data_model.md）

```typescript
// 概念契约；完整字段 / engine / 分片 / 信封 → [P1]data_model.md §1.2
interface Member {
  id: string;
  squadId: string;                    // → squad（双向）
  sessionId: string;                  // → session（双向；仅 leader/mate）
  name: string;                       // squad 内唯一（a2a 寻址符）
  intro?: string;                     // 一句话介绍（渲染进 Team Roster；fresh 必填/leader 固定模板/derive 继承父，schema optional 见 data_model §1.2a）
  role: "leader" | "mate";            // ★ B 方案（原 type=leader|member）
  // [v0.0.33.3] systemPrompt 已移除（身份正文由 squad_role mapper + fragment 组装，不落库；prompt_sections §7）
  tools: string[];                    // [v0.0.48] dead（entity 字段保留，不再被读取）
  skills: string[];
  model: string;                      // ModelRef，缺省 = squad.modelDefault
  state: "deployed" | "benched";      // 状态机
  benchReason?: string; benchedAt?: string;
  heartbeat: HeartbeatConfig | null;  // 占位 v4
  deriveFrom?: string;                // → member（hire derive 模式，一次性）
  // createdAt / updatedAt / version
}
```

**[v0.0.33.1 design.md 锁定变更 vs 0.1 draft RoleSpec]**：
- 名 `RoleSpec` → `Member`（实体化；不再叫 "spec"）。
- `type: "leader" | "member"` → `role: "leader" | "mate"`（B 方案：mate 替代 member，避免和 entity 名撞）。
- `roleId` → `id`（member 是独立 entity，自有 ULID）。
- **新增 `state` 状态机 + `benchReason`/`benchedAt`**：`(none) ─hire─▶ deployed ⇌ bench/deploy`（U5：无 fire；长期 bench = 离队但不删 record）。
- **leader 永远 `state=deployed`**——不可 bench（API 返 403）。
- `skills?` → `skills`（required，缺省空数组）。
- `model?` → `model`（required，缺省值由 service 从 squad.modelDefault 填）。
- `heartbeat?` → `heartbeat: HeartbeatConfig | null`（占位 v4，默认 null）。
- 派生字段 `deriveFrom?` 保留（hire 时一次性记；派生后两 member 完全独立）。memory 不复制（已团队盘共享）。

---

## 4. member 派生 / hire（SD1）

**member 不走模板**。两种 hire 模式（详见 `[P1]data_model.md §5 createMemberService`）：

- **fresh**：填新 Member 字段（含必填 `intro` 一句话介绍）→ 建独立 member + session（空白记忆）。
- **derive**（`deriveFrom: <memberId>`）：
  - **复制父 member config**（intro / tools / skills / model / heartbeat；systemPrompt 已移除）+ overrides 覆盖子集。
  - **复制父成员个人差异 AGENTS.md** → `.rocky/agents/{子name}-{子memberId}.md`（路径字面拼；父无 → 静默 no-op 不回滚，子继续用团队级 AGENTS.md 兜底）。不碰 skills/memory（团队级，仅 derive_academy 才 merge）。
  - **新独立 member + session**（**不共享 session**——各自 state/usage/心跳/记忆）。
  - 派生后两 member 完全独立，无后续联动。

---

## 5. 角色分工（leader 协调 / mate 执行）

- **leader 是协调者**——接用户需求 → 拆解 → @mate 分配 → 跟进 → 收交付；通过 team 工具 hire/bench/deploy/edit 管理成员；不做实质业务工作。
- **mate 是执行者**——接 leader 分配、自己推进、自己汇报；有业务工具、可 spawn sub-agent。
- **leader 按 escalation 语义在 squad chat 主动问用户**（汇报/提问）——escalation 不再是 charter 字段，由 leader prompt 直接承载「何时向老板（用户）汇报/提问」的指引。
- SquadChat 只看路由所需最小信息。

---

## 6. SquadChat EOS（SD3）= 保留字 `<EOS>`

SquadChat = 哑路由 agent（`session.type="squad"`），**reactive only**（无心跳）：

- **EOS = 保留字 `<EOS>`**：SquadChat agent loop 输出 `<EOS>` 这个保留 token（stop sequence）即**静默结束当前 run**（run 终止，**非销毁 session**）。
- **session 持久**；**新消息到达 → 再 activate**（复用 multi_agent §3.2 重激活：idle → 情况2 markRunning → 新 run）。
- 共享 session 基础设定**不破坏**——SquadChat 只是"能 silently end"，下一消息自然续上。
- `<EOS>` 是**本轮 run 的停止信号**，不是"squad 结束"。
- **用户入口不限 SquadChat**：用户可在**任意 session** 直接聊天——群聊（SquadChat）、leader、或任一 member。SquadChat 是入口之一（路由入口），非唯一。

---

## 7. session.type 映射（v0.0.33.1：member→mate）

| type | 含义 |
|---|---|
| `squad` | SquadChat / 群聊 session（哑路由 agent） |
| `leader` | leader member 的 session |
| `mate` | mate member 的 session（**原 `member`**，B 方案改名避免与 member entity 撞） |
| `subagent` | sub-agent session（multi_agent） |

- 顶层非-squad session（standalone playground）的 type 字段**不填**（optional，详见 `[P0]session_store.md §2`）；顶层 standalone 归 playground bizType（详见 `[P0]session_biztype.md`）。
- **v0.0.33.1 chat 全占位**：session.type=squad/leader/mate 字段持久化，但**不跑 agent loop**（POST messages 返 403 `studio_chat_not_ready`）；loop 留 v0.0.33.2。

---

## 8. 生命周期（部分；SD7）

- **无 TTL**——squad / member 不自动过期，由用户管理（建 squad / hire-bench / edit）。
- **squad 可整体硬删除（解散，v0.0.111）**——`DELETE /squad/:id` → `dissolveSquad`（teardown 停调度 → 删各会话 → deleteSquad → 删办公室管理性子目录，`data_model.md §1.1`）。硬删不可逆（session+历史物理删）、不留软归档（旧 `DELETE /squad → _archived` 方案已推翻）。squad 本身无 status/archived 字段。
- **member 不单删**（bench 兜底，无 fire；长期 bench = 离队，record 保留可审计）——仅在 team 整体解散时随之物理删。
- **leader 不可 bench**（永远 deployed；API 返 403）。
- `enableHeartBeat`（默认 false，替代旧 autonomyEnabled）+ budget = 占位 v4，scheduler 留 v4，详见 `squad_autonomy.md §7`。

---

## 9. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| Squad / Member 概念 + 角色分工语义 + member 派生概念 + SquadChat-EOS | 本文 ✅ |
| Squad / Member **SchemaDef + 存储布局 + 建队/hire 事务流程** | `[P1]data_model.md`（v0.0.33.1 新建） |
| Session interface 增量字段（type member→mate / bizType / squadId / memberId） | `specs/tech/agent/session/[P0]session_store.md §2` |
| bizType 二分（playground|studio）+ 隔离规则 | `specs/tech/agent/session/[P0]session_biztype.md`（v0.0.33.1 新建） |
| 心跳/scheduler/budget/enableHeartBeat | `squad_autonomy.md` |
| session.type=squad/leader/mate/subagent（member→mate 同步） | `../multi_agent/[P1]subagent_derivation.md §2` |
| spawn_agent / send_message / 重激活 / 并发 / abort 级联 | `../multi_agent/[P1]subagent_derivation.md` |
| usage 聚合（budget 数据源） | `../agent/session/[P0]session_usage.md` |
| Squad / Member HTTP API 端点 | 架构阶段产出 `specs/api/overall/` |

---

## 10. 待定（v0.0.33.1 非阻塞，架构/PRD 阶段细化）

- **leader 升级问用户的消息路径**：leader → SquadChat → 用户 → 用户回 → SquadChat 路由 role。role→user 反向确切流待定。
- **SquadChat role→user 路由**：router 主要 user→role，反向（role 升级消息给用户）需明确。
- **bench 通知 user UI 形态**（design.md §6.1，PRD 拍板）：toast / 系统消息卡 / Playground 主 chat 系统消息。

> **顶层 standalone session type 归属**（0.1 draft TBD）已解决：standalone 不填 type，归 playground bizType（`[P0]session_biztype.md`）。

---

---

> 变更历史见 [\`log.md\`](log.md)（本 KB 位置轴）+ [\`specs/tech/version_logs/vX.Y/change_log.md\`](../version_logs/)（跨版本发布说明）。
