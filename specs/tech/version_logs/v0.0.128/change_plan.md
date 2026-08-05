# v0.0.128 变更计划书 — team 工具 member 写 action 接入（hire/deploy/bench/edit）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 上游权威源

- PRD `specs/prd/version_logs/v0.0.128/prd.md`（已用户确认 commit 55d5b437）
- 契约 `specs/tech/squad/[P1]squad_tools.md` §0（通用约定）+ §2（team 8-action 表）+ §2.2（v3 reservation）
- 数据 `specs/tech/squad/[P1]data_model.md` §1.2（Member）+ §5（createMemberService）

## 核心事实（架构核对结论，落行前已 grep/读代码验证）

- `TEAM_ACTIONS = ['list','query','get_charter','update_charter']`（team-tool.ts:31）—— 扩 4 个新 action。
- `runUpdateCharter`（team-tool.ts:200-241）是既有写 action 模板：剥信封字段 → put + `lastWriteMessageId: rtc.currentMessageId` → 返 textResult。**4 个新写 action 照抄此模式**。
- `AgentToolRuntimeContext`（runtime-context.ts:67-142）已具备本版本所需全部句柄：
  - `rtc.store: SessionStore`（line 137）—— `createMemberService` 的 `sessionStore` 入参用它。
  - `rtc.squadStore` / `rtc.memberStore`（line 111/116）—— hire/deploy/bench/edit 都用它。
  - `rtc.sessionDeps.dataDir`（session-deps.ts:77，bootstrap.ts:671 已注入）—— `createMemberService` 的 `dataDir` 入参用它，**无需扩展 rtc 字段**。
  - `rtc.sessionDeps.appConfig`（session-deps.ts:63）—— `patchMemberService` model 校验 + `createMemberService` 显式 model 校验用它。
- `createMemberService(deps, input)`（services/member-service.ts:153）已存在 = hire 的「service 函数」，handler `handleHire`（handlers/member.ts:118-195）即 thin wrapper。**hire 直接复用此 service**，无需新代码。
- `handleDeploy`（member.ts:263-283）/ `handleBench`（member.ts:286-321）/ `handlePatchMember`（member.ts:198-260）三个 handler 是 thin wrapper：read member → 业务校验（leader_not_benchable / intro required / name 唯一 / model 合法）→ read-modify-write `memberStore.putMember`。**业务校验逻辑必须单源**（PRD §6.1「三路不重写」+ squad_tools §0 line 35 四面对齐 invariant）。
- MemberStore 方法已存在（squad-store.ts:102-118）：`putMember(rec) / getMember(squadId, mid) / listMembers(squadId) / deleteMember(squadId, mid)`。
- `MemberSkillConfig`（schema_defs/squad/member.ts:26-29）= `{ mode: 'inherit'|'custom'; overrides: Record<string, boolean> }`。
- 测试入口 `app/server/src/agent/tools/__tests__/squad-tool-schema.test.ts:98-108`（team schema 静态扫源码），扩 4 action 后须加新 flat 顶层 property 断言。
- HTTP API `specs/api/overall/11a-squad-endpoints.md §2.1-§2.4`：4 端点已存在且本版本不动契约。
- team-tool.ts 当前 261 行；inputSchema 扩 hire 8 字段 + 4 dispatch case + 权限分支，将顶破 300 行硬限 → **必须拆分**。

## 决策一览（每条在下表落行）

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| D1 | 4 action 权限 | 全部 leader/user only；mate/subagent/squad → `forbidden`；照 `update_charter` 既有模式（team-tool.ts:107-111） | PRD §3.5 已决裁决 |
| D2 | bench 通知 | tool 只写 state，不发 send_message；leader 在自己 session final text 告知 user | 用户已拍板（PRD §6.3 开放点 a→c，对齐 update_charter §2.1） |
| D3 | edit patch 字段 | `{ skillConfig?, model?, intro? }`（按 data_model §1.2 实际；非 spec §2 line60 的 `tools?/heartbeat?`——已 dead） | PRD §3.4 已决裁决 |
| D4 | hire derive overrides | `{ name?, intro?, skillConfig?, model? }`（去 `tools`——dead） | PRD §6.3 开放点 3 确认 |
| D5 | hire 复用方式 | tool 直调 `createMemberService(deps, input)`，deps 从 rtc 拼（store/squadStore/memberStore/dataDir/appConfig） | 已是 service 函数，零重构；handleHire 同模式 |
| **D6** | **deploy/bench/edit 复用方式（开放点 2 裁决）** | **B：抽 `services/member-mutations.ts`，HTTP handler + tool 双入口共用**；handler 改 thin wrapper | ① PRD §6.1「三路不重写」是 invariant 非 nice-to-have；② `squad_tools §0 line 35` 四面对齐 invariant 的字面落地；③ v0.0.68 教训——duplication 必漂移；④ HTTP 契约不动（仅内部业务逻辑搬家）；⑤ handler 改动机械、AT 兜底行为不变 |
| D7 | 文件拆分 | team-tool.ts 超 300 行硬限 → 拆 `team-write-actions.ts`（schema + 5 写 action 含 update_charter 迁入）；team-tool.ts 留 definition + dispatch + 只读 action | 单文件 ≤300 行硬限 + 现有注释「写 action v3 再扩」已预警 |
| D8 | lastWriteMessageId | 4 个写 action 都记（剥信封 + `rtc.currentMessageId`）；caller 不传 | squad_tools §0 line 30 通用约定 |

## 变更清单（行 = 一个函数/符号）

### 模块 A：service 层抽共享业务逻辑（D6）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| member-service | app/server/src/services/member-mutations.ts | `MemberMutationDeps` (interface) | 新增 | `{ memberStore: MemberStore; appConfig?: AppConfigService }`——deploy/bench/edit 共用最小依赖集（无需 sessionStore/dataDir/squadStore） | MUST 仅含 deploy/bench/edit 真实依赖，不重复 SquadServiceDeps 全集 | data_model §5；D6 | +5 |
| member-service | app/server/src/services/member-mutations.ts | `PatchMemberInput` (type) | 新增 | `{ name?: string; intro?: string; skillConfig?: MemberSkillConfig; model?: string }`——edit tool 入参 / HTTP PatchMemberBody 同源；**去 dead `tools`/`heartbeat`** | MUST NOT 含 `tools`/`heartbeat`（dead 字段）；保持与 HTTP PatchMemberBody 业务字段同集 | data_model §1.2；D3；squad_tools §2 line60 修正 | +6 |
| member-service | app/server/src/services/member-mutations.ts | `deployMemberService(deps, squadId, memberId)` | 新增 | 部署 member：getMember → 已 deployed 直接返（幂等）；benched → 剥信封 + putMember `{ ...rest, state: 'deployed' }`（清 benchReason/benchedAt）；返 `MemberEntity`；member 不存在 throw `MemberNotFoundError` | MUST 幂等（已 deployed no-op 成功）；MUST NOT 进信封字段；签名返 MemberEntity 让 HTTP/tool 各自包响应 | handlers/member.ts:263-283（HTTP 路径行为）；11a §2.3；D6 | +18 |
| member-service | app/server/src/services/member-mutations.ts | `benchMemberService(deps, squadId, memberId, reason)` | 新增 | 下岗 member：getMember；member 不存在 throw；`existing.role === 'leader'` throw `LeaderNotBenchableError`；剥信封 + putMember `{ ...rest, state: 'benched', benchReason: reason, benchedAt: new Date().toISOString() }`；返 MemberEntity | MUST 校验 reason 非空（tool/handler 入口已校验，service 兜底 throw）；MUST throw `LeaderNotBenchableError`（HTTP 转 403 / tool 转 errorResult 同文案 `leader_not_benchable`）；MUST NOT 发 send_message（D2） | handlers/member.ts:286-321；11a §2.4；data_model §1.2 line145；PRD §3.3 | +20 |
| member-service | app/server/src/services/member-mutations.ts | `patchMemberService(deps, squadId, memberId, patch)` | 新增 | 编辑 member：getMember；不存在 throw。name 改名校验 squad 内唯一（listMembers + 排除自己，重复 throw `MemberNameConflictError`）；model 显式传 → `validateModelId(appConfig, model)` 失败 throw；intro 提供但 trim 后空 throw `'intro required'`。剥信封 + read-modify-write merge patch（intro trim 后写）+ putMember；返 MemberEntity | MUST 校验顺序与现 handler 一致（name→model→intro）；MUST NOT 写 dead `tools`/`heartbeat`（accept-and-ignore + warn）；MUST 复用 `MemberNameConflictError`（已 export from member-service.ts:37） | handlers/member.ts:198-260；11a §2.2；data_model §1.2a；D3 | +32 |
| member-service | app/server/src/services/member-mutations.ts | `MemberNotFoundError` (class) | 新增 | member 不存在时 throw；HTTP/tool 各自 wrap（HTTP→404 `{error:'member not found'}` / tool→errorResult 同文案）。extends Error | 与 `MemberNameConflictError`/`DeriveSourceNotFoundError` 同模式 | member-service.ts:37-50 | +6 |
| member-service | app/server/src/services/member-mutations.ts | `LeaderNotBenchableError` (class) | 新增 | bench leader 时 throw；HTTP/tool 各自 wrap（HTTP→403 `{error:'leader_not_benchable'}` / tool→errorResult 同文案） | 文案对齐 11a §2.4 | handlers/member.ts:307-309 | +6 |

### 模块 B：HTTP handler 改 thin wrapper（D6 内部重构，契约不动）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad-http | app/server/src/handlers/member.ts | `handleDeploy` | 修改 | 删 inline 业务逻辑（getMember+幂等+putMember），改：try `deployMemberService({memberStore, appConfig: deps.appConfig}, squadId, memberId)` → catch `MemberNotFoundError`→404 / e→500；返 `json(200, { member })` | MUST 保持 HTTP 契约（11a §2.3：200 wrap shape 不变）；MUST NOT 改 method/path/status | 11a §2.3；D6 | +6/-15 |
| squad-http | app/server/src/handlers/member.ts | `handleBench` | 修改 | 删 inline（getMember+leader 校验+putMember），改：先 `reason required` 入参校验保留；try `benchMemberService(...)` → catch `MemberNotFoundError`→404 / `LeaderNotBenchableError`→403 / e→500；返 `json(200, { member })` | MUST 403 文案字面量 `leader_not_benchable`（AT 兜底）；MUST NOT 改 reason required 入参校验顺序（service 不重复校验 reason） | 11a §2.4；D2 | +8/-20 |
| squad-http | app/server/src/handlers/member.ts | `handlePatchMember` | 修改 | 删 inline（getMember+name 唯一+model 校验+intro trim+信封剥离+merge），改：构 `PatchMemberInput` from body（drop `tools`/`heartbeat` 字段并 warn 保留），try `patchMemberService({memberStore, appConfig: deps.appConfig}, squadId, memberId, patch)` → catch `MemberNotFoundError`→404 / `MemberNameConflictError`→400 / `LeaderNotBenchableError`（理论不达，PATCH 不涉 leader 校验）→500 / validateModelId 失败→400 / `'intro required'`→400；返 `json(200, { member })` | MUST 保留 `tools`/`heartbeat` accept-and-ignore + warn 注释（11a §2.2 向后兼容契约）；MUST NOT 改 wrap shape；PatchMemberBody 仍声明 tools/heartbeat（11a 契约） | 11a §2.2；D6 | +12/-45 |

### 模块 C：tool 层（核心改动）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-tool | app/server/src/agent/tools/team-tool.ts | `TEAM_ACTIONS` | 修改 | 由 `['list','query','get_charter','update_charter']` 扩为 8 元素（+ `'hire','deploy','bench','edit'`） | MUST 与 spec §2 全表一致；MUST NOT 删既有 | squad_tools §2；team-tool.ts:31 | +1/-1 |
| agent-tool | app/server/src/agent/tools/team-tool.ts | `teamTool.definition.description` | 修改 | 删「hire/deploy/bench/edit reserved for later」；加 4 action 一句话描述（leader/user only 标注） | MUST 与 inputSchema enum 一致；MUST NOT 改名 `team` | PRD §3；D1 | +4/-2 |
| agent-tool | app/server/src/agent/tools/team-tool.ts | `teamTool.definition.inputSchema` | 修改 | `properties.action.enum` 扩为 8 元素；新增 flat 顶层 properties（详见下「inputSchema sketch」节）：`mode`/`name`/`intro`/`skillConfig`/`model`/`deriveFrom`/`inheritMemory`/`overrides`/`roleId`；**`patch`/`reason` 已声明（update_charter）复用**——不重复声明 | MUST `properties` ⊇ handler 实读 flat 顶层字段（squad-tool-schema.test.ts 静态扫）；MUST NOT 嵌套子字段 flat 化（krs[].title 模式） | squad_tools §0 line31；PRD §3 | +50/-2 |
| agent-tool | app/server/src/agent/tools/team-tool.ts | `teamTool.run` (权限分支) | 修改 | `update_charter` 权限分支扩为含 `hire|deploy|bench|edit`（leader/user only；mate/subagent → forbidden 文案对齐 update_charter 模板） | MUST 文案字面量对齐（`team.${action}: forbidden (caller selfType=${t}, leader/user only)`）；MUST NOT 改只读 3 action 既有 leader/mate 允许逻辑 | team-tool.ts:107-117；D1 | +6/-3 |
| agent-tool | app/server/src/agent/tools/team-tool.ts | `teamTool.run` (dispatch) | 修改 | dispatch 加 4 case：`hire→runHire`/`deploy→runDeploy`/`bench→runBench`/`edit→runEdit`（从 `./team-write-actions` import）；`update_charter` 改 import 自 `./team-write-actions`（迁出后） | MUST catch 单一入口包装错误（现 try/catch 已在 line 126-133）；MUST NOT 复制 handler 实现 | team-tool.ts:126-134 | +6/-2 |
| agent-tool | app/server/src/agent/tools/team-write-actions.ts | module（新文件） | 新增 | 收纳 schema 构造 + 5 个写 action 实现 + helpers；导出 `TEAM_INPUT_SCHEMA` 常量 + `runHire/runDeploy/runBench/runEdit/runUpdateCharter` + `validateCharterPatch`（从 team-tool.ts 迁入）+ `Charter4`（迁入）；team-tool.ts 仅留 definition（`inputSchema: TEAM_INPUT_SCHEMA`）+ dispatch + 只读 action（runList/runQuery/runGetCharter） | MUST 单文件 ≤300 行（预估 ~250）；MUST NOT 把只读 action 也搬进来（保留 team-tool.ts 单一职责 = dispatch+只读） | CLAUDE.md 文件大小硬限；team-tool.ts:15 现注释 | +250 |
| agent-tool | app/server/src/agent/tools/team-write-actions.ts | `TEAM_INPUT_SCHEMA` (const) | 新增 | team 工具的完整 inputSchema 对象（type/required/properties/action.enum/各 action flat 顶层 properties）；被 team-tool.ts `definition.inputSchema` 引用 | MUST 与 squad-tool-schema.test.ts 断言一致（properties ⊇ handler 实读） | squad_tools §0 line31；下「inputSchema sketch」节 | +60 |
| agent-tool | app/server/src/agent/tools/team-write-actions.ts | `runHire(input, rtc)` | 新增 | hire 写 action。1) 构 `CreateMemberInput` from input（fresh/derive 二态）；2) 拼 `SquadServiceDeps = { sessionStore: rtc.store, squadStore: rtc.squadStore!, memberStore: rtc.memberStore!, dataDir: rtc.sessionDeps.dataDir, appConfig: rtc.sessionDeps.appConfig }`；3) `createMemberService(deps, input)` → 返 `{ member, sessionId }`；4) 返 textResult `{ memberId, sessionId, name, state: 'deployed' }`；catch `MemberNameConflictError`→'member_name_conflict' / `DeriveSourceNotFoundError`→'deriveFrom member not found' / `'intro required'`/`'name required'`/`'deriveFrom required'`→原文案 / e→`hire member failed: ${msg}` | MUST 直调 createMemberService（D5，禁止 inline）；MUST 复用 rtc.store/sessionDeps（无新 rtc 字段）；MUST 写 `lastWriteMessageId`（createMemberService 已写 member record，本 action 无需额外 put） | member-service.ts:153；D5；D8 | +35 |
| agent-tool | app/server/src/agent/tools/team-write-actions.ts | `runDeploy(input, rtc)` | 新增 | deploy 写 action。`deployMemberService({memberStore: rtc.memberStore!, appConfig: rtc.sessionDeps.appConfig}, rtc.selfSquadId!, roleId)` → textResult `{ memberId, state: 'deployed' }`；catch `MemberNotFoundError`→'member not found' | MUST 复用 service（D6）；MUST NOT inline；roleId 字符串校验非空 | member-mutations.ts.deployMemberService；PRD §3.2 | +12 |
| agent-tool | app/server/src/agent/tools/team-write-actions.ts | `runBench(input, rtc)` | 新增 | bench 写 action。reason/roleId 非空校验（空→'reason required'/'roleId required'）→ `benchMemberService(...)` → textResult `{ memberId, state: 'benched', benchReason }`；catch `MemberNotFoundError`→'member not found' / `LeaderNotBenchableError`→'leader_not_benchable' | MUST 文案字面量与 HTTP 一致；MUST NOT 发 send_message（D2）；reason 校验在 tool 入口（service 兜底但 tool 给清晰错误码） | member-mutations.ts.benchMemberService；PRD §3.3；D2 | +18 |
| agent-tool | app/server/src/agent/tools/team-write-actions.ts | `runEdit(input, rtc)` | 新增 | edit 写 action。1) 校验 `patch` 是 object 且 ≥1 字段（空→'patch invalid (need >=1 of skillConfig/model/intro/name)'）；2) drop `tools`/`heartbeat`（若传，warn）；3) `patchMemberService({memberStore, appConfig}, squadId, roleId, patch)` → textResult `{ member }`（含 member 详情）；catch `MemberNotFoundError`→'member not found' / `MemberNameConflictError`→'member_name_conflict' / validateModelId err→原文案 / `'intro required'`→原文案 | MUST NOT 写 `lastWriteMessageId` 单独 put（service 走 memberStore.putMember，可选择性增强 service 记 lastWriteMessageId——见「开放项」） | member-mutations.ts.patchMemberService；D3；PRD §3.4 | +25 |
| agent-tool | app/server/src/agent/tools/team-write-actions.ts | `runUpdateCharter(input, rtc)` | 修改（迁入） | 从 team-tool.ts:200-241 原样迁入新文件；行为不变 | MUST 行为/输出字面不变（update_charter 既有 AT 不能挂）；仅文件位置变 | team-tool.ts:200-241 | +42/-0(迁) |
| agent-tool | app/server/src/agent/tools/team-write-actions.ts | `validateCharterPatch` (helper) | 修改（迁入） | 从 team-tool.ts:247-260 原样迁入 | MUST NOT 改实现 | team-tool.ts:247-260 | +14/-0(迁) |
| agent-tool | app/server/src/agent/tools/team-write-actions.ts | `Charter4` (type) | 修改（迁入） | 从 team-tool.ts:244 原样迁入 | MUST NOT 改 | team-tool.ts:244 | +1/-0(迁) |

### 模块 D：测试

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| test | app/server/src/agent/tools/__tests__/squad-tool-schema.test.ts | team schema 断言 | 修改 | expected 列表加 `mode/name/intro/skillConfig/model/deriveFrom/inheritMemory/overrides/roleId`（共 +9 flat 顶层字段，对应 hire 8 + deploy/bench/edit 共用 roleId）；从 team-tool.ts handler 源码注释补 hire/deploy/bench/edit 实读字段 | MUST 每个新增 flat 顶层字段都进 expected（防 schema-handler 漂移）；MUST NOT 期望嵌套子字段（如 `overrides.intro`） | squad-tool-schema.test.ts:98-108；§0 line31 | +12/-1 |
| test | app/server/src/agent/tools/__tests__/team-write-actions.test.ts | module | 新增 | UT 覆盖：① 权限分支（leader ✅、mate/subagent/squad→forbidden × 4 action 矩阵）；② dispatch（4 新 action 进对应 handler）；③ inputSchema enum（8 元素）；④ runHire fresh/derive 入参构造正确（mock createMemberService）；⑤ runBench reason/roleId 空校验；⑥ runEdit patch 空校验 + dead 字段 warn；⑦ runDeploy catch MemberNotFoundError 文案。fake rtc + mock stores，禁真盘 | MUST 不写真盘（用 mock memberStore）；MUST 覆盖 UC-5 权限矩阵 + UC-6 leader_not_benchable 文案 | PRD §5 UT 范围；tests-respect-product-architecture | +180 |
| test | app/server/src/services/__tests__/member-mutations.test.ts | module | 新增 | UT 覆盖 member-mutations：① deployMemberService 幂等（已 deployed no-op）；② benchMemberService leader throw `LeaderNotBenchableError`、reason 校验；③ patchMemberService name 唯一、model validateModelId、intro trim、字段 merge 正确；④ MemberNotFoundError 各路径。可用 tmpdir + 真 MemberStore（thin service） | MUST 覆盖 UC-6 + name conflict + intro required 边界；service 层是业务逻辑核心必须有独立 UT（bottom-up-layer-verify） | PRD §5；memory bottom-up-layer-verify | +150 |

### 模块 E：清理（team-tool.ts 瘦身）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-tool | app/server/src/agent/tools/team-tool.ts | `runUpdateCharter` | 删除（迁出） | 删除本地实现，改 import from `./team-write-actions` | MUST dispatch 调用不变（行为零差异） | D7 | -42 |
| agent-tool | app/server/src/agent/tools/team-tool.ts | `validateCharterPatch` / `Charter4` | 删除（迁出） | 同上 | MUST | D7 | -15 |

## inputSchema sketch（每 action flat 顶层 properties = LLM 参数契约）

> 权威：`squad_tools §0 line31`（`inputSchema.properties` flat 顶层 = LLM 参数契约 / handler 读啥声明啥）。
> 共享字段：`patch`（update_charter 已声明，edit 复用——嵌套 shape 内部不同但 flat 顶层同名 OK）/ `reason`（update_charter 已声明，bench 复用——同语义「变更理由」）。

**新增 flat 顶层 properties（共 9 个）：**

| property | type | 用于 action | 说明 |
|---|---|---|---|
| `mode` | string enum `'fresh'\|'derive'` | hire | 判别 fresh/derive 二态 |
| `name` | string | hire (fresh) | fresh 模式 member.name（squad 内唯一） |
| `intro` | string | hire (fresh) | fresh 一句话介绍（必填，trim 非空） |
| `skillConfig` | object `{ mode: 'inherit'\|'custom', overrides: Record<string,boolean> }` | hire (fresh/derive overrides 内) | fresh 顶层；derive 在 overrides.skillConfig（嵌套） |
| `model` | string | hire (fresh/derive overrides 内) | 显式 modelId；缺省 inherit squad.modelDefault |
| `deriveFrom` | string | hire (derive) | 父 member id 或 name（与 query.ref 同语义） |
| `inheritMemory` | boolean | hire (derive) | 是否复制父长期记忆 |
| `overrides` | object | hire (derive) | 嵌套 `{ name?, intro?, skillConfig?, model? }`（**去 `tools`——dead，D4**） |
| `roleId` | string | deploy / bench / edit | member id (ULID) 或 member.name（与 query.ref 同语义，squad 内唯一） |

**保留既有（无变化）：** `action` (required enum 扩 8)、`query`（query action）、`patch`（update_charter + edit 共用 flat 顶层，内层 shape 不同）、`reason`（update_charter + bench 共用）、`triggeredByMessageId`（update_charter）。

**`action.enum`**：`['list','query','get_charter','update_charter','hire','deploy','bench','edit']`。

**注意**：LLM 对 hire 的 fresh vs derive 由 `mode` 字段判别，fresh 字段（name/intro/skillConfig/model）与 derive 字段（deriveFrom/inheritMemory/overrides）在 schema 层都 optional（handler 按模式运行时校验）；这与 task.create 的 title/source 模式一致（§0 line31 末段「具体必填由 handler 按 action 运行时校验」）。

## 影响面评估

**跨模块**：service（新建 member-mutations.ts）→ handlers（重构 thin wrapper）→ agent-tool（拆 team-write-actions.ts）→ 测试（schema 静态扫 + 新 UT 两个）。

**破坏性变更**：无外部契约变更（HTTP 11a §2 全不动；inputSchema 扩字段是纯加法，老 client 行为不变；TEAM_ACTIONS 扩 enum 是纯加法）。

**依赖顺序（底层先）**：
1. member-mutations.ts（service 层，无依赖）
2. handlers/member.ts 重构（依赖 1）
3. team-write-actions.ts（依赖 1）
4. team-tool.ts dispatch + schema（依赖 3）
5. squad-tool-schema.test.ts（依赖 4）
6. 新 UT 两个（依赖 1+3）

**风险点**：
- **R1（中）**：handler 重构改 thin wrapper 可能在 catch 分支漏掉某个错误码映射 → 用 HTTP 既有 AT（11a §2 路径）回归 + 新 service UT 兜底。
- **R2（低）**：team-tool.ts → team-write-actions.ts 拆分过程中 runUpdateCharter 行为零差异靠既有 update_charter AT 兜底（test_plan 须包含）。
- **R3（低）**：`createMemberService` 入参 `squadId` 字段：tool 从 `rtc.selfSquadId` 取（非 caller 传），与 HTTP 从 URL path 取不同——一致性靠 AT 验。
- **R4（低）**：edit action 写 member 时不记 `lastWriteMessageId`（patchMemberService 走 memberStore.putMember，service 接口未收 messageId）——**开放项**：是否在 service 加可选 `lastWriteMessageId?` 入参让 tool 传 `rtc.currentMessageId`？建议加（D8 invariant），doc-sync 在 change_log 标注此偏离。
- **R5（低）**：deploy/bench 也不记 `lastWriteMessageId`（同 R4）——deploy/bench 改 state 也是 store 写。建议同 R4 方案。
- **R6（不适用）**：packaged 护栏——本版本无新依赖、无 plugin 资源、无 runtime-config 键、无路径展开，4 类 packaged 陷阱均不触发。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 发现 service 接口签名（如 lastWriteMessageId 缺失 R4/R5）需扩 → 向 orchestrator 汇报偏离 → 记 doc-sync 待办，doc-modifier 阶段 5 同步 spec（data_model §5 createMemberService + 新 member-mutations 接口对齐）

## 给 doc-modifier 阶段 5 的 doc-sync 清单

> architect 落表前 grep/读代码已确认的 spec drift，doc-modifier 阶段 5 统一修。

| # | 文件 | 章节/行 | drift | 修正 |
|---|---|---|---|---|
| 1 | specs/tech/squad/[P1]squad_tools.md | §2 表 line60（edit patch 字段） | 写 `{ skillConfig?, tools?, model?, heartbeat? }`——但 `tools` v0.0.48 dead / `heartbeat` v0.0.116 dead / 缺 `intro?` | 改为 `{ name?, skillConfig?, model?, intro? }`（对齐 data_model §1.2 + handlers/member.ts PatchMemberBody 实际） |
| 2 | specs/tech/squad/[P1]squad_tools.md | §2 line75（bench 通知） | 写「系统自动 send_message 通知 user（X 被 bench，原因…）」但 HTTP handleBench 从未实现 | 改为「leader/user 调用 bench 须在 caller session final text 告知 user（与 update_charter §2.1 同口径），系统不发 send_message」+ 标 v0.0.128 决议 |
| 3 | specs/tech/squad/[P1]squad_tools.md | §2.2（v2 只读落地说明） | 写「hire/deploy/bench/edit/update_charter 留 v0.0.33.3」但 v0.0.33.3 只落 update_charter | 改标「hire/deploy/bench/edit 留 v0.0.128 已落（team tool member 写 action 接入）」 |
| 4 | specs/tech/squad/[P1]squad_tools.md | §2 表 line57（hire 入参） | RoleSpec/derive 模式 overrides 含 `tools` 暗示 | 显式注 overrides `{ name?, intro?, skillConfig?, model? }` 去 tools（对齐 D4 + data_model §5） |
| 5 | specs/tech/squad/[P1]data_model.md | §7 line385（待定 #3 hire derive overrides 字段集） | 标 TBD | 标 v0.0.128 已决（同 #4 字段集） |
| 6 | specs/tech/squad/[P1]data_model.md | §7 line386（待定 #4 bench 通知 user UI 形态） | 标 TBD（toast/系统消息卡/主 chat 系统消息） | 标 v0.0.128 已决：不发系统消息，caller session final text 告知（同 update_charter §2.1） |
| 7 | specs/tech/squad/[P1]data_model.md | §5（createMemberService） | 接口未含 lastWriteMessageId；v0.0.128 若 R4 决议加，需同步 | doc-modifier 按 coder 实际是否扩 service 接口决定（待 coder 偏离汇报） |
| 8 | specs/tech/squad/index.md | ④#17（line 77） | 「team 写 member 留 v3」豁免条目 | 标「v0.0.128 已落（hire/deploy/bench/edit 接入 team tool），豁免消除」 |
| 9 | specs/tech/squad/index.md | ④ 核心设计原则 | 无 team 写 action 落地记录 | 加 #18（建议）：「team 写 member action 经 service 层单源（member-mutations.ts + createMemberService），HTTP handler 与 agent tool 共享同一业务校验，禁 inline 复制（三路同源 invariant）」 |
| 10 | specs/tech/squad/log.md | 位置轴 | 缺 v0.0.128 entry | 追加：「v0.0.128 — team tool hire/deploy/bench/edit 接入；抽 member-mutations.ts 共享 service；handlers/member.ts 改 thin wrapper」 |
| 11 | specs/api/overall/11a-squad-endpoints.md | §2.1-§2.4 | **HTTP 契约不变，无需修改**——确认即可 | 注「v0.0.128 仅 tool 层接入 + 内部 service 抽取，HTTP 端点/payload/status 全保留」 |
| 12 | specs/prd/overall/* | （若有 team 工具章节） | 标「hire/deploy/bench/edit reserved」 | 同步标 v0.0.128 已落（doc-modifier grep 确认） |

---

## 事后补注（doc-modifier 阶段 5 核实代码后追加，不改原行意）

### 模块 A 影响行补（T1 drift）

`schema_defs/squad/member.ts` +6 行：Member entity SchemaDef 加 `lastWriteMessageId` 字段（`{ type: 'ulid', required: false }`）——change_plan 模块 A 未列此文件（T1 service 层抽共享逻辑时，member-mutations service 接 `lastWriteMessageId?` 入参 → 需 entity schema 声明字段才能 putMember 写入）。T1 drift 已发生并已同步到 spec（`data_model.md §1.2` + `squad_store_projection.md §2.2`）。

### 模块 C 实现补注（coder 实际偏离 + bug fix）

- **runHire deriveFrom 解析（bug fix）**：change_plan 模块 C runHire 原声明「deriveFrom 直传 createMemberService」。实际：inputSchema 承诺 deriveFrom「id 或 name（与 query.ref 同语义）」但 `createMemberService` 内部 `getMember` 是 id-only → 传 name 会 404（AT Round 1 暴露）。coder 复用 `resolveMemberId`（与 runDeploy/runBench/runEdit 的 roleId 同 helper）解析 name→id 后再传 service。
- **runEdit patch 透传（T3 实际）**：change_plan 模块 C runEdit 原声明「drop tools/heartbeat 若传 warn」。实际：runEdit 把 rawPatch 整体透传 `patchMemberService`，dead 字段的 strip+warn 由 service 单源处理（`member-mutations.ts` line 163-170），tool 层不做字段过滤——符合 D6 三路同源原则（dead 字段处理单源在 service）。
- **resolveMemberId helper（模块 C gap 补）**：change_plan 模块 C 未列 `resolveMemberId` 函数（deploy/bench/edit/runHire derive 共用，id-or-name → memberId 解析）。实际新增于 `team-write-actions.ts`，与 query.ref 同语义（id 精确优先，次 name 唯一匹配，无匹配 throw MemberNotFoundError）。

### 遗留债（独立遗留，非本版本范围）

1. **HTTP `handleHire` deriveFrom id-only**（`handlers/member.ts:182`）：tool 层 runHire 经 `resolveMemberId` 接受 id-or-name，但 HTTP `handleHire` 直接透传 `body.deriveFrom` 给 `createMemberService`（内部 `getMember` id-only）→ HTTP hire derive 传 name 会 404。与 tool 层 id-or-name 不一致。**独立遗留**（HTTP 端点行为变更非本版本范围；AT 未覆盖 HTTP derive-by-name 场景）。后续可统一：HTTP `handleHire` 也走 `resolveMemberId`。
2. **hire 不记 member.lastWriteMessageId**（D8 部分实现）：deploy/bench/edit 经 `member-mutations` service 接 `lastWriteMessageId?` 入参写入；hire 经 `createMemberService`（未接此入参）= 不记。D8 原定「4 action 都记」实际 3/4 落地。非阻塞（hire 建 member 是一次性创建，无后续 reminder 变化检测需求），后续如需统一可给 `createMemberService` 加 `lastWriteMessageId?` 入参。

