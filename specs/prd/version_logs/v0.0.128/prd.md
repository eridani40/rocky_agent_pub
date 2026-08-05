# v0.0.128 — team 工具 member 写 action 接入（hire/deploy/bench/edit）

> 引入版本：v0.0.128 · 类型：agent 工具面补齐（无 UI / 无 HTTP / 无 schema 变更）· 测试范围：UT（tool 层 + 权限 + schema）+ AT（4 action 黑盒真调 + 权限负向 + state 机）；ET n/a（无 UI）
>
> **概念权威源（MANDATORY 对齐）**——本 PRD 引用的 action/入参/权限/字段 100% 来自下列已有 spec，本版本是「工具层补齐到 spec 声明」，非发明新概念：
> - `specs/tech/squad/[P1]squad_tools.md` §0（通用约定：`inputSchema.properties`=LLM 参数契约 / caller 上下文 / 写 action 记 `lastWriteMessageId`）+ §2（team 8-action 全表，line 49–104）+ §2.2（v2 只读落地，写 action 留 v3）
> - `specs/tech/squad/[P1]data_model.md` §1.2（Member entity：state / skillConfig / model / intro / benchReason / benchedAt）+ §5（createMemberService hire 流程）
> - `specs/tech/squad/index.md ④#17`（四面对齐 invariant：某 action 有意不给 agent 须显式声明豁免+理由，如「team 写 member 留 v3」）
>
> **复用契约**：tool 层调用 `app/server/src/handlers/member.ts` 的 `handleHire / handleDeploy / handleBench / handlePatchMember` 同源逻辑（HTTP/UI/tool 三路不重写）；本版本不动 HTTP 端点、不动 UI、不动状态机、不动 schema。

## 目录

| 章节 | 说明 |
|------|------|
| §1 背景 | gap 是什么、为何「v3 reserved」、豁免出处 |
| §2 目标 + 非目标 | 4 action 补齐 / leader 对话内自主管理；明确不动项 |
| §3 功能契约（4 action） | 引用 §2 全表，只补 PRD 视角产品语义（bench 通知、leader 不可 bench、deploy 幂等） |
| §4 关键用户路径（MANDATORY） | 6 条路径 + UC 表（= 测试最低覆盖） |
| §5 测试覆盖映射 | UT / AT / ET n/a |
| §6 概念对齐声明 + spec drift + 架构期开放点 | 对齐自查 + 已知 drift + 3 个开放点 |

---

## 1. 背景

### 1.1 gap

`team` 工具现状（`app/server/src/agent/tools/team-tool.ts`）：`TEAM_ACTIONS = ['list','query','get_charter','update_charter']`——只读 3 + 写 1（charter）。`hire / deploy / bench / edit` 4 个 member 写 action **未入枚举**，tool `run()` 命中即返 `invalid action ... hire/deploy/bench/edit reserved`。

底层三路全就绪：
- **data_model**（`[P1]data_model.md §1.2/§5`）：Member entity + createMemberService 已定义全部字段与 hire 事务。
- **HTTP handler**（`app/server/src/handlers/member.ts`）：`handleHire`（POST /squad/:id/member）、`handleDeploy`（POST .../deploy，幂等）、`handleBench`（POST .../bench，reason 必填 + leader 返 403 `leader_not_benchable`）、`handlePatchMember`（PATCH .../member/:mid，read-modify-write）全部存在并已在生产路径使用。
- **UI**（成员面板）：hire/bench/deploy/edit 入口已实现。

**唯一缺口 = tool 层入口**：LLM 在 leader 对话中无法经 `team` 工具管理 member——只能走 HTTP/UI（user 手动）。本版本补齐这 4 个 action = 文档里的「v3 rollout」。

### 1.2 为何之前是「v3 reserved」（豁免出处）

`squad_tools.md §2.2` 明确：v0.0.33.2 只让 LLM 调只读 action，写 action 「留 v0.0.33.3」；v0.0.33.3 实际只落了 `update_charter` + task/goal/requirement 三工具全 action，**member 写 action（hire/deploy/bench/edit）再次延后**——理由是「管理动作无确认链路前不提前交给 LLM」。

`index.md ④#17` 四面对齐 invariant 下，这构成**显式豁免**（「team 写 member 留 v3」+ 理由），不违反「禁静默漏覆盖」。本次 v0.0.128 = 兑现该豁免、把 4 action 接入 tool 层。

---

## 2. 目标 + 非目标

### 2.1 目标

- leader（或 user）在与 leader 的对话中，可直接通过 `team` 工具 hire 新成员、bench/deploy 成员、edit 成员配置——无需离开对话去 UI 操作。
- 4 action 的入参/权限/约束**对齐 `squad_tools.md §2` 全表**，与 HTTP handler 同源（不重写业务逻辑）。
- 权限收口：4 action 全部 **leader/user only**（mate/subagent/squad 调 → `forbidden`），对齐 `update_charter`。

### 2.2 非目标（明确不做）

| 项 | 不做原因 |
|---|---|
| UI 变更 | 成员面板已有 hire/bench/deploy/edit 入口（v0.0.113 重构 skills 板块已落） |
| HTTP 端点变更 | 4 个端点已存在并生产可用（`11a §2`） |
| 状态机扩展 | deployed⇌benched 两态不动（U5：无 fire，长期 bench = 离队） |
| `fire` action | U5 决议永久剔除 ≈ 长期 bench，不引入 |
| charter 相关 | `update_charter` / `get_charter` 已实现，本版不动 |
| bench 自动通知 user | spec §2 声明「自动 send_message 通知 user」但 HTTP handler 未实现——**留架构期决策**（见 §6.3） |

---

## 3. 功能契约（4 action — 引用 `squad_tools.md §2` 全表，不重写）

> 下表只列 PRD 视角需强调的产品语义；**入参/权限/约束的权威定义在 `squad_tools.md §2` 表 + §0 通用约定**，本 PRD 不复制。实现按 data_model §1.2 实际字段（**非** spec §2 line60 的 `tools?/heartbeat?`——二者已 dead，见 §6.2）。

### 3.1 `hire` [v0.0.128]

- **入参**：`RoleSpec`（fresh）或 `{ deriveFrom, inheritMemory, overrides? }`（derive）——权威见 §2 表 + data_model §5。
- **行为**：建 mate member + mate session + workspace，**自动 `state=deployed`**（无单独 hired 态）；fresh 模式 `intro` 业务必填（空 → `intro required`）。
- **写盘**：记 `lastWriteMessageId`（§0；caller 不直传，从执行上下文取）。
- **产品语义**：leader 对话中说「招一个负责 X 的成员」→ LLM 调 `team(hire, ...)` → 新 member 进花名册 + 立即上岗。

### 3.2 `deploy` [v0.0.128]

- **入参**：`roleId`（member id）。
- **行为**：benched → deployed（清 `benchReason/benchedAt`）；**幂等**：已 deployed → no-op 成功（对齐 HTTP `handleDeploy` line 274-276）。
- **产品语义**：leader 把之前 bench 的成员拉回活跃。

### 3.3 `bench` [v0.0.128]

- **入参**：`roleId, reason`（reason 必填，空 → `reason required`）。
- **行为**：deployed → benched + `benchReason` + `benchedAt=now`；**leader 不可 bench**（HTTP `handleBench` line 307-309 返 403 `leader_not_benchable`，tool 层同口径拒）。
- **产品语义（spec §2 line 75）**：bench 是「坐板凳/暂离」，**长期 bench = 离队等价**（U5，无 fire）。spec 声明「leader 调用 bench 须告知用户」+「系统自动 send_message 通知 user」——后者 HTTP 未实现，**见 §6.3 开放点**。

### 3.4 `edit` [v0.0.128]

- **入参**：`roleId, patch: { skillConfig?, model?, intro? }`（**按 data_model §1.2 实际字段**，非 spec §2 line60 的 `tools?/heartbeat?`——二者已 dead）。
- **行为**：read-modify-write `memberStore.putMember`（复用 `handlePatchMember`）；`intro` 若提供则 `trim()` 后非空（空 → `intro required`，与创建同口径）；partial patch（只改给出字段）。
- **产品语义**：leader 对话中调整成员的 skill overlay / model / 一句话介绍。

### 3.5 权限模型（全部 leader/user only — 对齐 `update_charter`）

| caller selfType | hire/deploy/bench/edit | list/query/get_charter | update_charter |
|---|---|---|---|
| leader / user（standalone=undefined 当 user） | ✅ 本版新增 | ✅ 既有 | ✅ 既有 |
| mate | ❌ `forbidden` | ✅ 既有（只读三件） | ❌ 既有 |
| subagent | ❌ `forbidden` | ❌（subagent 无 team 工具） | ❌ |
| squad（SquadChat 路由器） | ❌（无 team 工具） | ❌ | ❌ |

权限校验在 tool `run()` 入口统一做（复用现有 `update_charter` 的 mate/subagent 拒绝模式，team-tool.ts line 107-111），4 个新 action 走同一分支。

---

## 4. 关键用户路径（MANDATORY — 测试最低覆盖）

> 每条路径至少一个 AT case（ET n/a，无 UI）。路径 = AT designer 设计 case 的依据。

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| **UC-1** | leader 对话「招个负责前端的成员」→ LLM 调 `team(hire, RoleSpec)` → 自动 deployed | 新 member 进花名册（`team(list)` 可见、state=deployed），有 mate session + workspace |
| **UC-2** | leader 对话「让 X 休息，原因 Y」→ LLM 调 `team(bench, X, "Y")` | member.state=benched + benchReason="Y" + benchedAt 设值；`team(list)`/`query` 回显 benched |
| **UC-3** | leader 对话「让 X 回来」→ LLM 调 `team(deploy, X)` | member.state=deployed + 清 benchReason/benchedAt；再次 deploy 同 member → 幂等 no-op |
| **UC-4** | leader 对话「把 X 的 model 改成 Z / intro 改成 W」→ LLM 调 `team(edit, X, {model:"Z"})` / `{intro:"W"}` | 对应字段更新 + 其他字段不动；`team(query,{ref:X})` 回显新值 |
| **UC-5（负向）** | mate / subagent session 调 `team(hire\|deploy\|bench\|edit, ...)` | 全部返 `forbidden (caller selfType=mate\|subagent, leader/user only)` |
| **UC-6（边界）** | leader 调 `team(bench, <leader 自己的 roleId>, "any")` | 返 `leader_not_benchable`（对齐 HTTP 403；leader 永远 deployed，data_model §1.2 line 145） |

**关键用户路径清单（确认覆盖）**：UC-1 hire、UC-2 bench、UC-3 deploy（含幂等）、UC-4 edit（含 partial patch）、UC-5 权限负向、UC-6 leader 不可 bench 边界。6 条全覆盖 4 action × {正常 + 权限 + 状态机边界}。

---

## 5. 测试覆盖映射

| 层 | 范围 | 覆盖点 |
|---|---|---|
| **UT**（coder 白盒） | tool 层 `team-tool.ts` | TEAM_ACTIONS 扩 4 action 后的分派 / `inputSchema.properties` 与 handler 实读字段一致（§0 LLM 参数契约 invariant，`__tests__/squad-tool-schema.test.ts` 静态扫源码断言）/ 权限分支（leader ✅、mate/subagent/squad 拒）/ 错误码文案 |
| **AT**（黑盒真调，新增 case） | 4 action + 权限负向 + state 机 | UC-1 hire（fresh + derive 两条）/ UC-2 bench + 回显 / UC-3 deploy 幂等 / UC-4 edit partial patch（skillConfig/model/intro 各一）/ UC-5 权限负向（mate+subagent 两 caller × 4 action 矩阵，至少抽样）/ UC-6 leader_not_benchable |
| **ET** | **n/a** | 无 UI 变更，纯 tool 层接入；UI 已有 hire/bench/deploy/edit 入口（v0.0.113）由历史 ET 覆盖。本版本不新增 ET case（用户按 ui-only-ut-skip-at-et 口径可考虑豁免 ET，但 AT 不可省） |

**版本白名单**（test-plan 阶段确定）：本版本新增的 team hire/deploy/bench/edit AT case + 受影响既有 team list/query AT case（验证 benched member 在 list/query 正确回显 state）。

---

## 6. 概念对齐声明 + spec drift + 架构期开放点

### 6.1 概念对齐声明（MANDATORY 自查）

本 PRD 引用的 action 名 / 入参 / 权限 / 字段 / 状态机 **100% 对齐**已有 spec：

| 概念 | PRD 引用 | spec 权威源 | 对齐 |
|---|---|---|---|
| 4 action 入参 + 权限 | §3 | `squad_tools.md §2` 表（line 55-64） | ✅ 一致 |
| `hire` 自动 deployed + 无 fire | §3.1 + §2.2 非目标 | `squad_tools.md §2` state 机（line 69-76） | ✅ 一致 |
| `deploy` 幂等 | §3.2 | HTTP `handleDeploy` line 274-276 + `11a §2.3` | ✅ 一致 |
| leader 不可 bench | §3.3 + UC-6 | `data_model.md §1.2` line 145 + HTTP `handleBench` line 307-309 | ✅ 一致 |
| `edit` patch 字段 | §3.4 | `data_model.md §1.2` 实际字段（**非** spec §2 line60，见 §6.2 drift） | ✅ 对齐 data_model（权威） |
| 权限 leader/user only | §3.5 | `squad_tools.md §2` 表「谁可调」列 + `update_charter` 既有实现 | ✅ 一致 |
| `inputSchema.properties`=LLM 参数契约 | §3（隐含） | `squad_tools.md §0` 第 7 条 | ✅ 架构期落地 |
| 写 action 记 `lastWriteMessageId` | §3.1 | `squad_tools.md §0` 第 2/6 条 | ✅ 架构期落地 |

**无新概念引入**——本版本是「代码补齐到 spec 声明」，不触发「新概念先落 ui/tech spec」流程。

### 6.2 已知 spec drift（PRD 标注，留 doc-modifier 修）

**`squad_tools.md §2` line 60 的 `edit` patch 字段仍写 `{ skillConfig?, tools?, model?, heartbeat? }`**，但：
- `tools`：v0.0.48 已 dead（工具集改 static-by-type 查 `TOOL_POLICY`，`data_model.md §1.2` line 109-115）。
- `heartbeat`：v0.0.116 已 dead（迁 squad 级 `squad.heartbeatConfig`，`data_model.md §1.2` line 129-133）。

**本 PRD + 架构按实际 data_model 走**：`edit` patch = `{ skillConfig?, model?, intro? }`。doc-modifier 阶段 5 统一修 `squad_tools.md §2` line 60 对齐到 data_model（删 `tools?/heartbeat?`，加 `intro?`）。

### 6.3 架构期开放点（PRD 不预判，交 architect 决策）

1. **bench 自动通知 user（spec §2 line 75 声明 vs HTTP 未实现）**：spec 说「bench 调用须给 reason → 系统自动 send_message 通知 user」。现状 HTTP `handleBench` 只写 state、不 send_message。三选项：
   - (a) tool 层补 send_message 通知（HTTP 不动，符合「无 HTTP 变更」前提）—— **PRD 倾向**；
   - (b) 抽共享 helper，HTTP + tool 都补（违反「无 HTTP 变更」）；
   - (c) 本版跳过通知、spec drift 标注豁免。
   architect 裁决后落 change_plan。
2. **tool 层复用 handler 逻辑的方式**：直接调 `handleHire/handleDeploy/handleBench/handlePatchMember`（需要 Request 对象构造），还是抽共享 service 函数让 HTTP/tool 两入口共用？后者更干净但可能触发「HTTP handler 重构」（轻微）。architect 决定。
3. **`hire` derive 模式的 `overrides` 字段集**：data_model §5 `createMemberService` 的 `overrides` = `Partial<{ intro; tools; skillConfig; model }>`——其中 `tools` 已 dead。tool schema 的 `overrides` 是否也去掉 `tools`？建议去掉（对齐 dead 字段处理），architect 确认。

### 6.4 回四面对齐 invariant（`index.md ④#17`）

本版本交付后，Member 实体的四面覆盖完整：
- store schema ✅（data_model §1.2，早已就绪）
- HTTP API ✅（11a §2，早已就绪）
- UI ✅（成员面板，v0.0.113 重构后已就绪）
- **agent tools ✅（本版本补齐 — 兑现「team 写 member 留 v3」豁免）**

豁免消除：`squad_tools.md §2.2` 的「hire/deploy/bench/edit 留后续」声明 + `index.md ④#17` 的对应豁免条目，由 doc-modifier 阶段 5 同步更新（标 v0.0.128 已落）。
