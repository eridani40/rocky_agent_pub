---
type: interface
title: Squad 工具收敛设计（Action-based Tools）
priority: P1
status: active
updated: 2026-08-04
since: v0.0.33.2
related: [[P1]squad_definition.md, [P1]squad_reminder_providers.md]
---

# Squad 工具收敛设计（Action-based Tools）

> 定位：把 squad 层管理工具**收敛**成少量 action-based 工具——`team`（成员管理）+ `agent`（sub-agent 派生，复用 multi_agent）+ `presence`（成员当前工作标记）；外加全局共享的 `todo`（轻量任务清单，独立 session 级工具，非 squad 收敛范围）+ `panorama`（业务全景，独立子体系见 `panorama_*.md`）。
> 参考：`squad_definition.md`（hire/bench/edit/member 派生）；`[P1]squad_reminder_providers.md §5`（lastWriteMessageId 变化检测）；`agent_{leader,member}.md`（工具配置）；multi_agent `[P1]subagent_derivation.md §4/§7`（agent 工具契约权威）。

---

## 0. 通用约定

- 权限按 caller 角色校验（leader / mate / user），越权 → `forbidden`。
- caller 上下文来自 `SessionConfig.{sessionType, squadId, memberId}`（req6 方案 A）。
- 错误码风格沿用现有（`squad_*` / `team_*` 前缀）。
- **`inputSchema.properties` = LLM 参数契约**（核心设计原则）：`protocol-encode.ts:encodeTools()` 把 `inputSchema` **原样透传**给 LLM（无 strict / 无 `additionalProperties:false`），故 `properties` 里声明的字段 = LLM 会发的参数。handler 实读的每个 flat 顶层字段**必须**在此声明为 flat 顶层 property，否则 LLM 不发 → write action 崩。仅 `action` 是 required；action 专属参数均 optional（具体必填由 handler 按 action 运行时校验）。**handler 读啥 flat 字段，schema 就声明啥 flat 顶层 property**——schema 与 handler 实读字段的一致性由 `__tests__/squad-tool-schema.test.ts` 静态扫源码断言兜底。
- **lastWriteMessageId**：member 写 action（hire/deploy/bench/edit）写 store 时记当前 message id（caller 不直传，工具从执行上下文自动取）→ 驱动 reminder 变化检测（`squad_reminder_providers.md §5`）。

---

## 1. 收敛原则

- **同概念合并为单工具 + action 分派**：team 管理（hire/deploy/bench/edit/list/query/reset）→ `team(action, ...)`。
- **少占 tool slot**：LLM 上下文里 tool definition 是稀缺资源，收敛后每个收敛工具只占 1 个 slot。
- **action 名 = 真实团队动词**（不用 enable/disable 等技术词）。
- **权限按 action 内嵌**：工具层校验"谁能做什么 action"（leader-only / 全员）。
- **业务校验由 service 单源兜底**（v0.0.128）：member 写 action 的业务校验（name 唯一/model 合法/leader 不可 bench/intro trim）抽共享 service，HTTP 与 agent tool 双入口调同一 service，禁 inline 复制（`index.md ④#11`）。

---

## 2. `team` 工具（团队管理 — 7 action：list/query/hire/deploy/bench/edit/reset）

```typescript
team(action, ...args)
```

| action | 入参 | 谁可调 | 说明 |
|---|---|---|---|
| `hire` | `RoleSpec`（fresh：`name/intro/skillConfig?/model?`）或 `{ deriveFrom, overrides? }`（derive：`overrides = { name?, intro?, skillConfig?, model? }` 去 dead `tools`） | leader / user | 新建/派生 member（自动 deployed），持久化到 member store（`{memberId}.json`，按 squadId 分片），建 workspace。**`deriveFrom`/`roleId`（deploy/bench/edit）接受 member id 或 member.name**（与 `query.ref` 同语义，tool 层 `resolveMemberId` 解析；HTTP `handleHire` deriveFrom 暂 id-only，遗留债）。**[v0.0.169] `workStyle` 不在 hire 入参**：workStyle 仅用户可编辑（HTTP hire/PATCH + 创建页/编辑面板），**不进 `team.hire`**——derive `overrides` 是裸 object schema 挡不住 LLM 塞入，故 `team-write-actions.ts runHire()` **服务端显式剔除** `overrides.workStyle`（`data_model §1.2c`）|
| `deploy` | `roleId` | leader / user | **上岗**（从 bench 拉回活跃；重启心跳）—— 替代旧 enable |
| `bench` | `roleId, reason` | leader / user | **下岗**（暂时停心跳/暂离队，**leader 调用须告知用户**）—— 替代旧 disable；**长期 bench 即等价于离队**（U5：不引入 fire，bench 兜底所有"剔除"语义） |
| `edit` | `roleId, patch: { name?, skillConfig?, model?, intro? }` | leader / user | 编辑 Member 配置。patch 字段对齐 `data_model §1.2` 实际可编辑字段——**去 dead `tools?`（v0.0.48）/`heartbeat?`（v0.0.116）**，加 `intro?`/`name?`；caller 传 dead 字段 accept-and-ignore + warn（`patchMemberService` 单源）。**[v0.0.113]** `skills` 白名单 → `skillConfig` overlay 快照。**[v0.0.142] `workStyle` 不在 patch 白名单**：仅用户可编辑，`team-write-actions.ts runEdit()` **服务端显式剔除** `workStyle`，兜底 LLM 绕过「仅用户可编辑」裁决（`data_model §1.2c`）|
| `list` | —（`filter?: { state?, type? }` 入参 spec-only 未落地——impl `team-tool.ts runList` 直接 `listMembers` 全量无 filter） | **全员**（含 member——看花名册 Q1） | 列全量成员（roleId/name/type/state/lastUpdatedAt），保留管理全视角（含 benched 可恢复） |
| `query` | `{ ref }` | **全员**（含 member） | 单成员详情（含 `skillConfig` overlay 快照 `{mode,overrides}`/tools/model/state/sessionId）。身份正文由 squad_role fragment 承载（member.systemPrompt 已删）；`skills` 白名单字段已推翻为 `skillConfig` overlay |

| `reset` | `roleId` | leader / user | **重置 mate 会话上下文**（单体操作，无批量）：清 transcript+summary+runs+usage（复用 `store.clearSession` → `clearSessionStoreOp`，同聊天页「清理上下文」按钮链路）+ presence（`currentWork=null`，read-modify-write 剥信封对齐 `presence-tool.ts` 模式）+ todo（`todoStore.removeAll(sid)`，缺省 skip）。**running 保护**：`state∈{running,interrupting}` → 拒绝 `errorResult`（不 abort，让 leader 知道「等跑完再 reset」）。**不动** memory（group 级 `.rocky/memory/`）/ agent md（定义层）。代码路径：`team-write-actions.ts runReset()` |
- **member 也可调 `team`，但仅 `list` / `query` 两个只读 action**——看花名册（Q1 见全队，对应 agent_member §6）；管理动作（hire/deploy/bench/edit/reset）拒。
- **send_message 保底语义**：leader/mate 的 a2a 能力依赖 `send_message`。`TOOL_POLICY['studio-leader'|'studio-mate'].bound` 恒含 `send_message`（由 `resolveTools(role)` 单方法 resolve，`session_config_studio.md §3.1`），不再依赖旧 `member.tools` 字段或 ad-hoc 保底注入。

**member state 状态机**（U5 确认：仅 bench，无 fire / archived 终态）：
```
(none) ──hire──▶ deployed ⇌ bench/deploy ──▶ benched
```
- `deployed`（在岗，含心跳）/ `benched`（坐板凳，无心跳，但 reactive 仍响应）。
- `hire` 一步到位 = 创建 + 立即 deployed（无单独 hired 态，简化状态机）。
- `bench` 调用须给 reason → **leader 在自己 session 的 final text 告知 user**（"X 被 bench，原因…"）（v0.0.128 用户裁决）；tool/HTTP 层 bench 只写 member state，**不发 send_message**——user 不在 a2a 拓扑，通知走 caller session 的回复语境（a2a_protocol §4.1）。
- **没有 fire**（U5：永久剔除 ≈ 长期 bench；session 留盘可读）。要彻底"看不见" → 各消费点过滤 benched 成员即可（数据层 `listMembers` 不动——认知/协作层 team_roster/squad_agents_status/mention + UI 默认在岗视图均 deployed-only；**team tool `list` 例外保留全量**让 leader 管理全视角 + 可 `team deploy` 恢复）。

**写 action 实现单源**（v0.0.128）：`hire / deploy / bench / edit` 4 个 member 写 action 走 `team-write-actions.ts` → `services/member-mutations.ts`（deploy/bench/patch 共享 service）+ `createMemberService`（hire）调底层 store，与 HTTP handler 同源（三路不重写，D6 决策）。代码路径：`team-tool.ts.run() → team-write-actions.ts.runHire/runDeploy/runBench/runEdit → services/member-mutations.ts → stores/squad-store.MemberStore.putMember`。`reset`（v0.0.282）也落 `team-write-actions.ts runReset()`，但不走 member-mutations——reset 操作的是 session 上下文（transcript/presence/todo）不是 member 配置，复用 `store.clearSession` + `memberStore.putMember`（presence 清）+ `todoStore.removeAll` 直接调底层 store。

---

## 3. `agent` 工具（multi-agent 派生/管理 — 复用 multi_agent 层，member only）

> 权威定义在 multi_agent 层（`specs/tech/agent/tools/[P1]agent_tools.md` 1.0）。本表是 squad 层对 `agent` 工具的**复用 + 权限收窄**（member only），不重复定义 spawn/query/abort 的契约——契约引 `[P1]subagent_derivation.md §4/§7`。

```typescript
agent(action, ...args)
```

| action | 入参 | 谁可调 | 说明 |
|---|---|---|---|
| `spawn` | `SpawnAgentInput`（multi_agent §4：templateRef/systemPrompt/tools/task/mode/maxIter） | **member only**（leader 不给） | 派生 sub-agent + 首任务 + sync/async（原 `spawn_agent`） |
| `query` | `{ ref? }` 或 `{ filter: {status?, templateType?, limit?} }` | **member only**（仅查自己派的） | **list + query 合并**：带 ref → 单 child 详情（含 usage/lastUpdatedAt）；不带 → 列表（按 lastUpdatedAt 倒序，limit 默认 20） |
| `abort` | `{ ref }` | **member only**（仅中断自己派的） | 主动中断自己派的 child（原 `abort_agent`） |

**leader 不给 `agent` 工具**：sub-agent 是 **member 私产**（multi_agent 拓扑编码——sub-agent 只回 parent，结构上不可达其他 agent）。leader 没必要插手 member 私产。leader 想了解 member 工作进度 → 用 `send_message` 问、或看 reports / panorama。

**为何 list+query 合并为 `query`**：
- `query(ref)` = 单详情；`query(filter)` = 列表——一个动作两种语义。
- LLM 不需区分两个动作；filter 决定结果是单/多。
- 省 1 action slot，描述更短。

---

## 4. `presence` 工具（[v0.0.116] 成员当前工作标记 — leader/mate）

```typescript
presence(action, ...args)
```

| action | 入参 | 谁可调 | store 写 | output |
|---|---|---|---|---|
| `set` | `text: string` | leader / mate | 自己 member（caller memberId）的 `currentWork = { text, updatedAt: now }`（覆盖上一条） | `{ ok: true }` |
| `clear` | `()` | leader / mate | 自己 member 的 `currentWork = null`（取消标记） | `{ ok: true }` |

- **定位**：成员用自由文本标记「当前正在做的事」——每人一条，`set` 即覆盖，`clear` 取消。**独立小工具**（不塞进 team 工具）。
- **数据**：写 `member.currentWork`（`data_model.md §1.2b`）。caller 只能写**自己** session 对应的 member（`SessionConfig.memberId`）；不带 memberId 参数（防越权改他人）。
- **权限**：leader + mate 可用（加进 `TOOL_POLICY['studio-leader'|'studio-mate'].bound`）。**SquadChat 不需要**（哑路由，无 member record）；subagent 不给。
- **用途下游**：running 成员的 currentWork 进 leader「团队当前状态」reminder（`squad_reminder_providers.md §4.6`）。
- **不记 `lastWriteMessageId`**：currentWork 不驱动 reminder 变化检测（team-status provider 每轮直接产出）。
- **prompt 维护提醒**：leader/mate system prompt 加一句「被唤醒/接任务后先 `presence(set)` 标记，工作结束/无事时 `presence(clear)`」（`prompt_sections.md §3.1`）。
- **schema**：`action` required（enum `set|clear`）；`text` 仅 `set` 时读（handler 运行时校验非空，缺 → `presence_text_required`）。
- **代码**：`app/server/src/agent/tools/presence-tool.ts`；registry `defaultTools` 含 `presence`；`tool-policy.ts` leader/mate bound 含 `presence`。

---

## 5. 与现有 spec 的映射调整

| 现 spec 散件 | 替换为 |
|---|---|
| `squad_definition.md` design §9.2 `hire/fire/edit + disable member` | `team(hire/deploy/bench/edit/list/query)`——hire 自动 deploy，bench 替 disable，**无 fire（U5：长期 bench = 离队）** |
| multi_agent `subagent_derivation.md §4/§7` 中 `spawn_agent` / `list_children` / `query_agent` / `abort_agent` | `agent(spawn/query/abort)`——4 件并 1，list+query 合并 |
| `agent_leader.md §3` tools 表 | 折叠为 `team` + `presence` + send_message + panorama（无 agent.spawn，leader 不派 sub-agent） |
| `agent_member.md §3` tools 表 | 折叠 team（只读）+ todo + presence + send_message + agent（spawn/query/abort 自己派的）+ panorama + 业务工具 |

---

## 6. action 命名取舍说明

| 替换前 | 替换后 | 理由 |
|---|---|---|
| `enable` | **`deploy`** | "上岗/出战"，真实团队动词；与 `autonomyEnabled` 不冲突 |
| `disable` | **`bench`** | "坐板凳/暂离"，sports/军事隐喻，比 disable 人性化 |
| `list_children` + `query_agent` | **`agent.query`**（合并） | 带 ref=单详情·不带 ref=列表 |

---

## 7. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| 工具收敛设计 + action 表 + member 状态机 + 命名 | 本文 ✅ |
| member SchemaDef + 存储布局 + hire/deploy/bench/edit service 单源 | `[P1]data_model.md §1.2/§5` |
| `lastWriteMessageId` 驱动 reminder 变化检测（member 写入→reminder 刷新） | `[P1]squad_reminder_providers.md §5` |
| agent 工具 spawn/query/abort 契约 | `../multi_agent/[P1]subagent_derivation.md §4/§7` + `../agent/tools/[P1]agent_tools.md` |
| todo 工具（轻量任务清单，session 级，非 squad 收敛） | `specs/api/overall/20-todo.md` |
| panorama 工具（业务全景 DSL 看板） | `[P1]panorama_tools.md` |
| 工具 schema 细节 + LLM tool definition 字串 | `agent_tools.md` |
| 权限校验逻辑 | tool_execution_engine（校验 caller type → action 是否允许） |
| 数据存储布局（成员目录） | `squad_workspace.md` + `[P1]data_model.md §3` |

---

---

> 变更历史见 [\`log.md\`](log.md)（本 KB 位置轴）+ [\`specs/tech/version_logs/vX.Y/change_log.md\`](../version_logs/)（跨版本发布说明）。
