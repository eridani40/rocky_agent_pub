# v0.0.48 PRD Change Log — Tool 系统统一（policy 驱动 resolve + forked 白名单 formal 化 + 去 leader/mate tool 可配置）

> version: 1.0 · 2026-07-02
> 一句话定位：把当前散在 `scope-allowed-tools.ts` 硬编码常量 + `session-config.ts` config 层 + `engine.ts` 双路径拒绝的 tool 装配，**收敛为单一 JSON tool policy + `resolveTools` 方法**；forked 白名单收口为 `enableToolWhitelist`+`toolWhitelist` 一对 agent option + 注入 forked reminder；去掉 leader/mate tool 可配置（改 static-by-type + 删 UI/config 链路）。两个 bug（playground squad 工具泄漏 / mate schema-exec 不对齐）被 policy 驱动的 resolve 自然解决。
> 概念权威源：`specs/research/v0.0.48-tool-system.md`（§9 gap + §10 最终方案 + §10.6 forked 三态语义 = 设计定稿，本 PRD 据此产品化）；`specs/tech/agent/tools/index.md` + `[P1]agent_tools.md` + `specs/tech/agent/agent_interface_and_loop/` + `specs/tech/multi_agent/[P1]subagent_derivation.md` + `specs/tech/squad/[P1]squad_tools.md` / `[P1]session_config_studio.md` / `[P1]agent_member.md` / `[P1]agent_leader.md` + `specs/tech/config/[P0]ext_impl_scope.md`。
> 设计稿：**无**（仅 `reqs/v0.0.48.tool_list/req.md`）→ 视觉保真度门禁**跳过**（E2E 仅做单图功能检查，无 `vision_check.py compare`）。

---

## 1. 背景与目标

### 1.1 背景

当前 tool 系统（`specs/research/v0.0.48-tool-system.md` §1-§9 摸底）有三个用户可感知痛点 + 一个内部混乱：

1. **playground squad 工具泄漏**（用户痛点）：`filterToolDefinitionsBySessionType(undefined)=FULL`（`scope-allowed-tools.ts:123`），playground-rocky 的 LLM 能看到 `team`/`goal`/`requirement`/`task`/`send_message`（无 squad 语境下纯噪音），导致用户感觉「工具都没有办法执行，纯纯多余和 bug」。
2. **mate schema/exec 不对齐**：LLM 见 `agent`/`web` 但 exec 层不让调（schema 层与 exec 层裁剪规则不同源）。
3. **leader/mate tool 可配置纯多余**：UI `component-hire-modal.tsx` MultiCheck 用粗类目（`['file','web','bash','send_message']`）与实际 tool 名不对齐，端到端不 work；用户明确「先去掉」。
4. **forked 白名单 / 拒绝逻辑分散**：`engine.ts:146` 中文 `isError` 无错误码 + `engine.ts:89` `unknown_tool` 两条路径；forked 的 `allowedTools` 是 ad-hoc 字段非开关，没有 formal 入口；forked agent 缺 system reminder（已被显式禁用，但用户要求补回，且不能污染 cache）。

### 1.2 目标

1. **policy 驱动**：把 5 角色的工具上限（bound）落成**单一 JSON tool policy**（静态代码资源，非用户可配），`resolveTools(sessionType, config)` 读 policy resolve。
2. **forked 与 subagent 共用机制**：forked（compact/summary 内存 run）走新 option `enableToolWhitelist`+`toolWhitelist`；subagent 走 `mainAllowedTools ∩ subagent bound`（`capByParent` 时再 ∩ 父 bound）——同一对 option，统一行为。
3. **forked reminder**：注入「你是 forked agent，专注本 message；prompt/tools 来自 main；实际可运行 tool 列表=xxx」——位置在 **cache 前缀之后**（不污染 cache）。
4. **白名单外统一拒绝**：收口 `engine.ts:146`+`engine.ts:89` 为一条带稳定 code 的 `ToolResultBlock(isError=true)` 路径。
5. **去 leader/mate tool 可配置**：改 static-by-type（leader=15/mate=15）；删 `Member.tools` config 链路 + UI（hire-modal/member-panel/squad-types `TOOL_OPTIONS`）。

---

## 2. Scope

### 2.1 IN-SCOPE（4 件 + 2 bug）

| 编号 | 项 | 摘要 |
|---|---|---|
| **S1** | JSON tool policy（静态代码资源） | 5 角色 bound：playground-rocky=12 / studio-squad=1 / studio-leader=15 / studio-mate=15 / subagent=11（`capByParent=true`）。替代现 `scope-allowed-tools.ts` 硬编码常量。bound 矩阵见 `research §10.2/§10.3`。 |
| **S2** | `resolveTools` 收敛 | 顶层角色 → 直接取 bound；subagent → `mainAllowedTools ∩ subagent bound`（studio-subagent 再 ∩ 父 bound，`capByParent`）；forked → 用 `enableToolWhitelist`+`toolWhitelist`。session manager / resolve 读 policy resolve。 |
| **S3** | forked 白名单 formal 化 + reminder | 新增 agent option `enableToolWhitelist:boolean`+`toolWhitelist:string[]`，三态语义（research §10.6）。forked 注入 system reminder（cache 前缀之后）。forked 与 subagent 共用这对 option。白名单外统一拒绝错误（带稳定 code）。 |
| **S4** | 去 leader/mate tool 可配置 | 改 static-by-type（查 policy.roles[leader/mate].bound）；删 `Member.tools` config 链路（member-service / squad-service / session-config / handlers/member / UI hire-modal + member-panel + squad-types `TOOL_OPTIONS`）。 |
| **B1** | Bug 修复（被 S1/S2 自然解决） | playground squad 工具泄漏：playground-rocky 仅见 12 个 playground 工具，4 个 squad 工具不可见不执行。 |
| **B2** | Bug 修复（被 S1/S2 自然解决） | mate schema/exec 不对齐：mate schema 与 exec 同源（均查 policy.roles[mate].bound），LLM 见即可执行。 |

### 2.2 OUT-OF-SCOPE（Non-goals，明确排除）

- **leader/mate 重新支持 tool 可配置**（本版去掉，deferred；需要时再做）
- **subagent 改固定列表**（保持 `template.tools` 作 default 白名单，main 可 `input.tools` 覆盖，结果 ∩ bound）
- **leader/mate 加/减具体工具**（按 research §10.3 定稿 bound；后续按需）
- **`reqs/v0.0.49.forked_agent/**`** — 另一版本，**绝不触碰**
- 视觉保真度比对（无设计稿，门禁跳过）

---

## 3. 功能需求

### 3.1 JSON tool policy + `resolveTools` [v0.0.48]

**描述**：把 5 角色 tool 上限（bound）落成静态 JSON tool policy（代码资源），`resolveTools(sessionType, config)` 读 policy 统一 resolve，替代现 `scope-allowed-tools.ts` 硬编码常量 + `filterToolDefinitionsBySessionType`/`deriveAllowedTools` 双层分散。

**优先级**：P0

**用户故事**：作为 playground 用户，我希望 agent 看到的工具都是「在我这个场景下能真用的」，不被 squad-only 工具（team/goal/requirement/task）干扰；作为 studio leader/mate，我希望工具集按角色自动到位，不用也无法手动调。

**期望行为（用户可见）**：

- **playground-rocky**：LLM 仅见 12 个工具（read/write/edit/glob/grep/bash/skill/web_search/web_fetch/browser/agent/send_message）；调用 `team`/`goal`/`requirement`/`task` 不会被 schema 暴露也不会被执行。
- **studio-squad（SquadChat 路由器）**：LLM 仅见 1 个工具（`send_message`）；不碰文件/squad 工作项工具。
- **studio-leader**：LLM 见 15 个工具（全 16 − `agent`）；不可派生子 agent。
- **studio-mate**：LLM 见 15 个工具（全 16 − `goal`）；可派生 subagent，不规划 objective。
- **subagent（含 playground-subagent 与 studio-subagent）**：LLM 见的工具 = main 动态传入的 allowedTools ∩ subagent bound（11 个上限）；studio-subagent 再 ∩ 派生它的 member/leader 的 bound（不超父）。
- **三层一致**：config 层（`buildSessionConfigFromDeps`）/ schema 层（`filterToolDefinitionsBySessionType`，LLM 可见）/ exec 层（`deriveAllowedTools`，engine 执行白名单）三处都查同一份 policy，无对齐缝。

**关键机制（待 architect 落 tech spec）**：

- **JSON tool policy**：静态代码资源（位置由 architect 定），5 角色 + bound + `capByParent` 字段；非用户可配。policy 内容 = research §10.4。
- **`resolveTools` 单方法**：输入 `(sessionType, config, parentBound?)`，输出该 session 的 `Tool[]`/`ToolDefinition[]`/`allowedTools:string[]` 三件（一次算出，三处消费）。
- **main → subagent 传 `mainAllowedTools`**：spawn 时 `agent(action=spawn, input.tools)` 优先；缺省回退 `template.tools`（template 仅作 default 白名单）；结果 ∩ bound。语义对齐 research §10.5 决定点 2。
- **`capByParent`**：`policy.roles["subagent"].capByParent=true`；若 parent 是 studio member/leader → 再 ∩ `policy.roles[parentRole].bound`。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.1.1 | playground-rocky 发消息 → LLM 请求 tool 列表 | 仅 12 个 playground 工具可见；`team`/`goal`/`requirement`/`task` 不在 tools 数组 |
| UC-3.1.2 | playground-rocky 强行调 `team(list)` | exec 层拒绝（统一错误码，见 §3.3） |
| UC-3.1.3 | studio-squad 发消息 → 看 LLM tools 数组 | 仅 `send_message` |
| UC-3.1.4 | studio-leader 发消息 → 看 LLM tools 数组 | 15 个（无 `agent`） |
| UC-3.1.5 | studio-mate 发消息 → 看 LLM tools 数组 | 15 个（无 `goal`），含 `agent` |
| UC-3.1.6 | playground-rocky spawn subagent(input.tools=[read,web_search,browser]) → child run | child 见 [read, web_search, browser]（∩ subagent bound 11，均在内） |
| UC-3.1.7 | playground-rocky spawn subagent(input.tools=[read,agent]) → child run | child 见 [read]（`agent` 不在 subagent bound，被 ∩ 剥离） |
| UC-3.1.8 | studio-mate spawn subagent(input.tools=[read,browser,goal]) → child run | child 见 [read, browser]（goal 不在 subagent bound；browser ∩ mate bound 内 ✓） |

---

### 3.2 forked 白名单 formal 化 + reminder [v0.0.48]

**描述**：forked（compact/summary 内存 run，复用 main cache 前缀）的白名单从 ad-hoc `allowedTools` 字段升级为 formal agent option `enableToolWhitelist`+`toolWhitelist`；并注入 forked system reminder（位置在 cache 前缀之后，不污染 cache）。

**优先级**：P0

**用户故事**：作为用户，我希望多轮对话超阈值时 forked compact run 能专注出 summary 不调任何工具（避免 compact 中途写文件），且 reminder 让 LLM 知道自己是 forked、能调啥工具。

**期望行为（用户可见）**：

- **compaction forked run**：context 超阈值触发 forked compact run → forked agent **零工具**（`enableToolWhitelist=true, toolWhitelist=[]`）→ LLM 产出 summary 直接输出到 answer，不调任何 tool。
- **forked reminder**：forked agent 启动时 system reminder 注入，文案：「你是 forked agent，专注完成本 message 任务；出于上下文复用的原因，你拿到的 system prompt 和 tools 等都来自 main agent；你实际可以运行的 tool 列表 = [xxx]」。注入位置在 **cache 前缀之后**（main 的 system prompt + tools 复用 cache，reminder 不进 cache）。
- **白名单外拒绝**：forked agent 若 LLM 试图调 tool（如 compaction 误调 `write`）→ 统一拒绝错误（见 §3.3），LLM 看到后回退到无工具 summary。
- **三态语义**（research §10.6）：
  - `enableToolWhitelist=true`  + `toolWhitelist=[...]` → 仅列出的工具可执行
  - `enableToolWhitelist=true`  + `toolWhitelist=[]` → **零工具**（compaction 场景）
  - `enableToolWhitelist=false` → 不强制，bound 内全可执行
- **subagent 共用**：subagent 的「实际可执行工具」也走这对 option（main 通过 `input.tools` 算出 ∩ bound 后，写为 `enableToolWhitelist=true, toolWhitelist=<交集>`）；forked 与 subagent **不再分两套机制**。

**关键机制（待 architect 落 tech spec）**：

- **新 RunOptions 字段**：`enableToolWhitelist?: boolean` + `toolWhitelist?: string[]`（位置由 architect 定，候选 `RunSpec` 或 `RunOptions`）。
- **reminder 注入点**：cache 前缀之后（`forked-scope-bootstrap.ts:80` 当前显式禁用 `system_reminder_injector` 的逻辑要改——禁的是「污染 cache 的注入」，本版的 reminder 是 cache 之后单独注入）。
- **复用 main `toolDefinitions`**：forked 仍保 `toolDefinitions` 复用（保 cache），但 toolEngine 按白名单全拒（compaction 场景）。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.2.1 | playground 多轮对话 → context 超 shouldCompact 阈值 → 自动触发 | forked compact run 启动；reminder 注入；summary 输出到 answer；无 tool 调用 |
| UC-3.2.2 | forked compact run 期间 LLM 试图调 `write` | 返回统一拒绝错误（code 稳定，见 §3.3）；LLM 回退到无工具 summary |
| UC-3.2.3 | 手动触发压缩 → forked run | 同 UC-3.2.1（用户感知：summary 出现在 answer，对话可继续） |
| UC-3.2.4 | forked agent reminder 文本中提到「实际可运行 tool 列表」 | 列表 = `toolWhitelist` 内容（compaction 场景为空） |

---

### 3.3 白名单外统一拒绝错误 [v0.0.48]

**描述**：把 `engine.ts:146`（Layer C 白名单外，中文 isError 无码）+ `engine.ts:89`（未注册工具，`unknown_tool`）两条路径，收口成一条带稳定 code 的 `ToolResultBlock(isError=true)`。

**优先级**：P0

**用户故事**：作为 LLM，我希望白名单外/未注册的工具调用都返回同一种错误，便于我识别「这工具不能调」并回退，不被两种文案混淆。

**期望行为（用户可见 = LLM 可见）**：

- 任何不在 `allowedTools` / `toolWhitelist` 内的 tool 调用 → 返回 `isError=true` 的 ToolResultBlock，文案含**稳定 code**（候选 `tool_not_allowed`，具体命名 architect 定）+ tool 名 + 简短原因（如「不在当前 sessionType 的工具列表」）。
- 未注册工具（name 不在 `config.tools`）走同一 code（不再用 `unknown_tool` 单独路径）。
- 文案为英文 code + tool 名（中文短语可保留但 code 必须稳定可机读）。

**关键机制（待 architect 落 tech spec）**：合并 `engine.ts:89,146-158` 两条分支为一条；稳定 code 命名 + 文案模板 + errorInfo 字段（如有）由 architect 定。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.3.1 | LLM 调 `team(list)` 在 playground-rocky | ToolResultBlock(isError=true) 含稳定 code `tool_not_allowed` |
| UC-3.3.2 | LLM 调未注册工具名 `nonexistent_tool` | 同 UC-3.3.1（同一 code，非 `unknown_tool`） |
| UC-3.3.3 | LLM 在 forked compact run 调 `write` | 同 UC-3.3.1（白名单=[]） |

---

### 3.4 去 leader/mate tool 可配置（static + 删 UI）[v0.0.48]

**描述**：leader/mate 工具集从「`Member.tools` config 驱动」改为「static-by-type」（直接查 `policy.roles[leader|mate].bound`）；删除 UI 与 config 链路。

**优先级**：P0

**用户故事**：作为 studio 用户，我在 hire member / 编辑 member 时**不再看到「工具管理」UI**（因为现在按角色静态确定）；leader/mate 工具自动到位。

**期望行为（用户可见）**：

- **hire-modal**：表单移除「工具」MultiCheck 区块；hire 后 mate 的工具集自动 = `policy.roles.mate.bound`（15 个）。
- **member 面板**：移除「工具管理」section；用户编辑 member 时不再有 tools 字段。
- **leader 不可编辑 tools**：leader 工具集 = `policy.roles.leader.bound`（15 个），从定义就是 static。
- **API 契约**：PATCH /squad/:id/member/:mid 不再接受 `tools` 字段（请求带 tools 字段会被忽略或返 400，由 architect 定；行为对齐 architect 后 API doc 同步）；hireBody 不含 tools。
- **存量数据**：现有 `Member.tools` 字段值不再被读取（保留 entity 字段定义由 architect 决定是否物理删除；本版本行为上是 dead code）。

**关键机制（待 architect 落 tech spec）**：删 `member-service.ts:106,126` / `squad-service.ts:202` tools 处理；`session-config.ts:216-225` 改查 `policy.roles[member.role].bound`；`handlers/member.ts:60,141-156` 去 tools 字段；UI `component-hire-modal.tsx`+`section-member-panel.tsx`+`squad-types.ts:179 TOOL_OPTIONS` 删除。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.4.1 | studio → 进入 hire member 弹窗 | 表单无「工具」字段（系统提示/角色/技能 等其他字段不变） |
| UC-3.4.2 | hire 一个 mate → 进入 member 面板 | 面板无「工具管理」section；该 mate LLM 见 15 个工具 |
| UC-3.4.3 | PATCH /squad/:id/member/:mid 带 `{tools:[...]}` | tools 被忽略（或返 400，由 architect 定）；member 工具集不变 |
| UC-3.4.4 | 旧 squad（Member.tools 含历史值）→ activate member session | 工具集 = `policy.roles.mate.bound`（不读 Member.tools 旧值） |

---

## 4. 关键用户路径（MANDATORY — 测试最低覆盖）

每条路径 ≥ 1 个 AT/ET case。设计稿无 → 视觉保真 compare 跳过。

| ID | 路径 | 涉及功能 | 测试类型 |
|---|---|---|---|
| **P1** | playground 用户发消息 → agent 仅见/仅能用 12 个 playground 工具（4 个 squad 工具不可见、不执行） | S1 + S2 + B1 | AT（curl 看工具列表 + 强行调拒绝）+ ET（playground 发消息看 LLM tools） |
| **P2** | 多轮对话 → context 超阈值 → forked compact run（`enableToolWhitelist=true, toolWhitelist=[]`）→ 注入 forked reminder → summary 输出到 answer；若 LLM 试图调 tool → 白名单外统一拒绝错误 | S2 + S3 + §3.3 | AT（造超长 context 触发 compact + 断言 reminder/零工具/拒绝 code） |
| **P3** | studio 创建 squad / hire mate → leader/mate 工具按角色静态确定；成员面板与 hire-modal 不再有「工具管理」UI | S4 | ET（hire-modal/member-panel DOM 无 tools 区块）+ AT（leader/mate LLM tools 数量=15/15） |
| **P4** | playground rocky 派生 subagent → subagent 工具 = `mainAllowedTools ∩ subagent bound`；studio mate 派生 studio-subagent → 再 ∩ mate bound（不超父） | S1 + S2 | AT（spawn 时传 input.tools，curl GET child session 的 LLM tools 数组断言交集） |

---

## 5. 验收口径

- **功能**：S1-S4 全实现；P1-P4 关键路径 case 全 pass；B1/B2 bug 不复现。
- **API 测试**：通过率 ≥ 90%（无 5xx / schema 不合规 / 契约 hard fail）。
- **E2E 测试**：通过率 ≥ 70%（dom 断言无 hard_fail；vision 单图功能判定照常）。
- **视觉保真度**：**跳过**（无设计稿）。
- **三层一致**：UT 断言 config/schema/exec 三层查同一份 policy（防止 B1/B2 复发）。
- **回归**：v0.0.33.* / v0.0.37 已落地的 squad 工具行为（leader 12 文件+skill+5 工作项；mate 文件+skill+工作项+agent）不退化——只是从 config 驱动改为 policy 驱动，工具集合本身不变。

---

## 6. 待 architect 落 tech spec 的概念清单（PRD 不发明，仅枚举）

下列概念 PRD 只描述行为，**具体字段/位置/命名由 architect 落 tech spec**：

1. **JSON tool policy**（静态代码资源）—— 5 角色 + bound + `capByParent`；位置（候选：`scope-allowed-tools.ts` 重构 / 新文件）；schema（JSON 还是 TS 常量）。
2. **`resolveTools(sessionType, config, parentBound?)` 单方法签名**——输入/输出/调用点（替代 `filterToolDefinitionsBySessionType` + `deriveAllowedTools` 双入口）。
3. **`enableToolWhitelist` + `toolWhitelist`**—— RunOptions / RunSpec / SessionConfig 字段位置 + 默认值（`enableToolWhitelist=false`）。
4. **forked reminder 注入点**—— cache 前缀之后的具体注入接口（候选：现有 `system_reminder_injector` 改造 + 新增 forked-only injector）；与 `forked-scope-bootstrap.ts:80` 当前禁用的关系。
5. **统一拒绝错误**—— code 命名（候选 `tool_not_allowed`）+ 文案模板 + 是否进 errorInfo。
6. **`Member.tools` 字段处理**—— entity 物理删除 vs 保留为 dead code；API PATCH/hireBody 字段拒绝策略（忽略 vs 400）。
7. **subagent `input.tools` 优先级**—— `agent(action=spawn, input.tools)` 优先 + `template.tools` 缺省回退的 resolve 顺序（与现有 subAgentConfig 的关系）。

> 以上由架构阶段统一落 `specs/tech/agent/tools/`（policy + resolveTools）+ `specs/tech/agent/agent_interface_and_loop/`（forked reminder + RunOptions 字段）+ `specs/tech/squad/`（Member.tools 处理）。

---

## 7. 与现有 overall PRD 的关系

- `specs/prd/overall/08-squad-studio.md` §8.2 D（edit member 含 tools）+ §8.3 路径 4（edit member）→ 本版**修订**：hire/edit member 不再有 tools 字段。已在 overall 文件就地追加 `[v0.0.48 modified]` 标注。
- 其他 overall 文档（03-llm-chat / 04-config-center-ui 等）不受本版影响。
