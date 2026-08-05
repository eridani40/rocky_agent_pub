# v0.0.250 变更计划书 — 派生自成员补齐个人 AGENTS.md 复制 + 清理 inheritMemory dead field

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（squad_member / squad_schema / squad_api / squad_tool / squad_ut / squad_spec / ui-*） |
| 文件路径 | 完整相对路径（worktree 根相对） |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | spec 位置 + 项目原则编号 |
| 预计影响行 | +N / -M |

---

## 架构决策（冻结，coder 必须遵守）

1. **derive 复制 AGENTS.md 实现位置 = 抽公共 helper `copyPersonalAgentsMd()` 放 `member-academy-bridge.ts`**。
   - 理由：(a) `member-service.ts` 当前正好 300 行（上限），inline 复制 + 新 imports 必超；(b) `member-academy-bridge.ts` 已 import 了 `copyFile / mkdir / existsSync / join`（line 23-25），co-location 零新依赖；(c) helper 与 `seedMemberWorkspaceFromVersion` 内的 AGENTS.md 块（line 210-222）同一关注点（个人差异 AGENTS.md 落点），但 **source 形态不同**（derive source = 父成员个人文件；derive_academy source = version workspace 根 AGENTS.md）——本版本**不重构 derive_academy**（用户锁定"不动"），只新增 helper，允许局部小重复。
   - 文件行数兜底：`member-academy-bridge.ts` 现 298 行 + helper ~13 行 = ~311 超；**coder 必须确保两文件 ≤300**——首选精简 bridge 头部 22 行 docstring（保留核心、删冗余_VERIFIED），其次抽到新小文件 `member-personal-agents-md.ts`。
2. **复制时机 = createMemberService `step 7.5`（derive 分支专属）**：紧跟 `step 7 derive_academy seed` 之后、`step 8 return` 之前。`if (input.mode === 'derive' && input.deriveFrom && eff.parentMemberId)`。
3. **父成员个人 AGENTS.md 路径推导 = `{squadRoot}/.rocky/agents/{parent.name}-{parent.id}.md`**（与 `prompt-handler.ts:30` + `member-academy-bridge.ts:214` + `squad-store.ts:125/139` 四处权威一致；**无独立 helper**，按 `{memberName}-{memberId}.md` 字面拼接）。子路径 = `…/{eff.name}-{memberId}.md`（按子 memberId 重命名）。
4. **parent 信息透传 = `resolveEffective` derive 分支 return 加 `parentName` + `parentMemberId`**（parent 已在 line 158 加载，零额外 IO；避免 createMemberService 二次 getMember）。
5. **失败补偿口径 = 静默 no-op**（与 `seedMemberWorkspaceFromVersion` AGENTS.md 块 line 219-221 同口径——`catch {}` 内置空，不入 written、不 throw）。父无 → no-op；复制失败 → no-op。**MUST NOT 触发 hire 事务回滚**（member 建成功为主；个人差异文件缺失非阻塞，子成员继续用团队级 AGENTS.md 兜底）。
6. **inheritMemory 全影响面（grep 已闭合，5 类清理 + 1 类 spec 同步）**：
   - server schema（MemberSchema field）
   - server service（CreateMemberInput + resolveEffective return + step5 putMember spread）
   - server handler（HireBody derive 分支 + handleHire input 组装）
   - server agent tool（TEAM_INPUT_SCHEMA field + runHire consume + team-tool description 字符串）
   - UT fixtures（4 个 server UT 文件 + 1 个 web UT 文件，含 schema fields 数组 count 断言）
   - 前端 UI 级联（squad-types + buildHireBody + section-member-create + i18n zh/en + 2 个 ui spec）— **Group C 开放点见下**
   - spec 同步（data_model §1.2/§5 + squad_definition §3/§4 由 coder 随代码改；11a/11-squad/squad_tools/design.md/PRD overall 由 doc-modifier stage 5）
7. **deriveFrom 保留**（一次性溯源字段，**MUST NOT 删**——所有改动只针对 inheritMemory）。

### 开放点（需用户架构确认时拍板）

**Group C（前端级联）是否纳入**：
- **背景**：`inheritMemory` 在前端有完整 toggle UI（`section-member-create.tsx` line 58 state + line 233-240 ToggleSwitch + `data-action-key="studio.member.toggle-inherit-memory"` + zh/en i18n label/hint「继承父角色长期记忆」）。req.md 说「无 UI 变更」，但 server 删字段后这个 toggle 成死 UI（提交一个 server 不再消费的字段；hint 文案「继承父角色长期记忆」是**虚假承诺**——该记忆复制功能从未实现，memory 已在 v0.0.232 转团队盘共享）。
- **architect 推荐 = 纳入清理**（原则 #2「不遗留死代码」：保留即继续误导用户）。
- **若用户要保留**：Group C 跳过，server schema 改 accept-and-ignore（旧 client 传 inheritMemory → warn+不落库、不 400）；toggle 继续工作但提交即被丢弃（仍为死 UI，本架构不推荐）。

---

## 变更清单

### Group A — derive 补齐个人 AGENTS.md 复制

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad_member | app/server/src/services/member-academy-bridge.ts | copyPersonalAgentsMd() | 新增 | export async fn：复制父成员个人差异 AGENTS.md → 子成员名下。签名 `({squadRoot, parentName, parentMemberId, childName, childMemberId}) => Promise<void>`。源 = `{squadRoot}/.rocky/agents/{parentName}-{parentMemberId}.md`；目标 = `…/{childName}-{childMemberId}.md`。父不存在（existsSync=false）/复制失败 → 静默 no-op | MUST 复用既有 fs imports（line 23-25）；MUST NOT throw（catch 空体同 derive_academy AGENTS.md 块口径）；MUST mkdir recursive 目标 `.rocky/agents/` 目录 | member-academy-bridge.ts:210-222（derive_academy 对照块）；specs/tech/squad/[P1]squad_definition.md §4 | +13 |
| squad_member | app/server/src/services/member-service.ts | resolveEffective() | 修改 | derive 分支 return 加 `parentName: parent.name` + `parentMemberId: parent.id`（parent 已 line 158 加载）；同步删 return 的 `inheritMemory` 字段（line 179）+ return type `inheritMemory?: boolean`（line 117） | MUST NOT 二次 getMember（复用 line 158 parent）；TS return type 同步扩 parentName/parentMemberId、缩 inheritMemory | specs/tech/squad/[P1]data_model.md §5 | +2/-2 |
| squad_member | app/server/src/services/member-service.ts | createMemberService() | 修改 | 加 `step 7.5 derive 分支`：`if (input.mode === 'derive' && input.deriveFrom && eff.parentMemberId)` → `await copyPersonalAgentsMd({squadRoot: workspaceDir, parentName: eff.parentName!, parentMemberId: eff.parentMemberId!, childName: eff.name, childMemberId: memberId})`。derive_academy 分支（step7）不动 | MUST 只 derive 分支生效（derive_academy 走 step7 seedMemberWorkspaceFromVersion 已含 AGENTS.md）；MUST NOT 在 step7.5 throw 或触发事务反向补偿（静默 no-op）；文件 ≤300 行（精简头部 docstring 或抽 helper 到新文件兜底） | specs/tech/squad/[P1]data_model.md §5 step7.5；architect 决策#2/#5 | +8 |
| squad_spec | specs/tech/squad/[P1]data_model.md | §5（hire 流程注释段） | 修改 | step7 derive_academy seed 后加 step7.5 注释段：`derive（非 academy）分支：复制父成员个人 AGENTS.md（{parentName}-{parentId}.md → {childName}-{childId}.md），父无 → no-op`；step3 描述删 `/inheritMemory` 提及；step4 描述删 `inheritMemory=true 时复制记忆` 虚假行；input 类型注释删 `inheritMemory?: boolean` | MUST 标 [v0.0.250]；MUST NOT 删 deriveFrom 提及；落点对齐代码实现 | specs/tech/squad/[P1]data_model.md §5 | +5/-4 |
| squad_spec | specs/tech/squad/[P1]squad_definition.md | §3 + §4（member 派生） | 修改 | §3 删 `inheritMemory?: boolean`（line 83）+ §3 line 97 提及；§4 derive bullet 加「复制父成员个人 AGENTS.md → `.rocky/agents/{子name}-{子id}.md`（父无 no-op，子继续用团队级 AGENTS.md）」；§4 inheritMemory 子段（line 109-113）整删 | MUST 标 [v0.0.250]；MUST NOT 删 deriveFrom（保留）；落点对齐代码 | specs/tech/squad/[P1]squad_definition.md §3/§4 | +2/-8 |

### Group B — 清理 inheritMemory dead field（server schema/service/api/tool + UT）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad_schema | app/server/src/agent/schema_defs/squad/member.ts | MemberSchema.fields.inheritMemory | 删除 | 删 field 定义 + 上方注释（line 117-118） | MUST NOT 删 deriveFrom field（line 116 保留）；MemberRecord 派生类型自动收紧 | specs/tech/squad/[P1]data_model.md §1.2 | -2 |
| squad_member | app/server/src/services/member-service.ts | CreateMemberInput.inheritMemory | 删除 | 删 type field（line 73） | 同步 Group A 的 resolveEffective return 删（同文件） | specs/tech/squad/[P1]data_model.md §5 | -1 |
| squad_member | app/server/src/services/member-service.ts | createMemberService() step5 putMember | 删除 | 删 spread `...(eff.inheritMemory !== undefined ? { inheritMemory: eff.inheritMemory } : {})`（line 252） | MUST NOT 改其他 spread（intro/workStyle/deriveFrom/skillConfig/tools） | specs/tech/squad/[P1]data_model.md §5 step5 | -1 |
| squad_api | app/server/src/handlers/member-hire-handler.ts | HireBody derive 分支 type | 修改 | 删 type 联合成员的 `inheritMemory: boolean`（line 37） | MUST 保 deriveFrom/overrides；TS 联合类型窄化无 issue（field optional removal） | specs/api/overall/11a-squad-endpoints.md §2.1 | -1 |
| squad_api | app/server/src/handlers/member-hire-handler.ts | handleHire() derive input 组装 | 修改 | 删 `inheritMemory: body.inheritMemory === true`（line 107） | MUST 保 deriveFrom/overrides 透传 | specs/api/overall/11a-squad-endpoints.md §2.1 | -1 |
| squad_tool | app/server/src/agent/tools/team-write-actions.ts | TEAM_INPUT_SCHEMA.properties.inheritMemory | 删除 | 删 schema property（line 53） | MUST 保 deriveFrom/overrides schema | specs/tech/squad/[P1]squad_tools.md §0 | -1 |
| squad_tool | app/server/src/agent/tools/team-write-actions.ts | runHire() derive 分支 consume | 修改 | 删 `...(typeof input.inheritMemory === 'boolean' ? { inheritMemory: input.inheritMemory } : {})`（line 121）；删 函数 docstring 里 `deriveFrom/inheritMemory/overrides` 的 inheritMemory 提及（line 89） | MUST 保 deriveSourceId 解析 + overrides dropWorkStyle 剔除逻辑不变 | specs/tech/squad/[P1]squad_tools.md §2 | -2 |
| squad_tool | app/server/src/agent/tools/team-tool.ts | TEAM_TOOL description 字符串 | 修改 | 删 description 里 `(mode fresh: ...; or derive: deriveFrom/inheritMemory/overrides)` 的 `inheritMemory`（line 41） | MUST 保 deriveFrom/overrides 提及 | specs/tech/squad/[P1]squad_tools.md §0 | -1 |
| squad_ut | app/server/src/services/__tests__/member-service.test.ts | derive 测试 fixtures + 断言 | 修改 | 删 13 处 `inheritMemory: ...` 输入 + 2 处 `expect(derived.member.inheritMemory)` 断言 + 注释/标题 inheritMemory 提及（line 8,206,222,237,239,248,259,268,311,319,325,336）；it/describe 标题改 | MUST 保 deriveFrom 断言；UT 全绿 | 原则：UT 跟 schema 同步 | -15 |
| squad_ut | app/server/src/handlers/__tests__/squad-member-model-validation.test.ts | derive fixture | 修改 | 删 `inheritMemory: false`（line 187） | UT 全绿 | 同上 | -1 |
| squad_ut | app/server/src/agent/tools/__tests__/team-write-actions.test.ts | hire derive 测试 + schema fields 数组 | 修改 | 删 6 处 `inheritMemory: ...`（line 187,189,197,199,208）；schema fields 数组（line 160）删 `'inheritMemory'` 成员 | MUST 保 deriveFrom/overrides 断言；UT 全绿 | 同上 | -6 |
| squad_ut | app/server/src/agent/tools/__tests__/squad-tool-schema.test.ts | schema fields 数组 | 修改 | 删 `'inheritMemory'` 数组成员（line 41）+ 注释（line 34）；若有 fields count 断言同步 -1 | UT 全绿 | 同上 | -2 |
| squad_spec | specs/tech/squad/[P1]data_model.md | §1.2 inheritMemory 字段 | 删除 | 删 §1.2 schema block 的 `inheritMemory?: boolean` 行（line 136）+ 其上注释 | MUST 标 [v0.0.250]；MUST 保 deriveFrom 字段（line 135） | specs/tech/squad/[P1]data_model.md §1.2 | -2 |

### Group C — inheritMemory 前端级联清理（开放点 — 见架构决策"开放点"，需用户拍板）

> 若用户选"保留 toggle"：本 Group 整组跳过；server 不动（Group B 仍执行），前端继续提交 inheritMemory 但 server accept-and-ignore（需在 Group B 加 server-side warn）。architect **不推荐**此分支（留死 UI）。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-types | app/web/src/components/studio-page/squad-types.ts | HireBody/derive body type | 修改 | 删 `inheritMemory?: boolean`（line 90）+ `inheritMemory: boolean`（line 184） | MUST 同步 buildHireBody 删 | — | -2 |
| ui-logic | app/web/src/components/studio-page/member-create-hire-body.ts | buildHireBody() + DeriveHireInput type | 修改 | 删 input type field（line 21）+ destructure（line 24）+ body emit `inheritMemory`（line 53） | MUST 保 deriveFrom/overrides | — | -3 |
| ui-comp | app/web/src/components/studio-page/section-member-create.tsx | Derive 区 toggle | 修改 | 删 `useState(false)` state（line 58）+ `<ToggleSwitch actionKey="studio.member.toggle-inherit-memory" ... />` 块（line 232-240）+ onSubmit 传参 `inheritMemory`（line 87）+ 文件头注释 inheritMemory 提及（line 9） | MUST 保 deriveFrom 父选择卡（`studio.member.select-parent`）+ overrides 覆盖区；删后 Derive 区只剩父选择 + overrides | specs/ui/components/studio-page/member-create.md | -12 |
| ui-i18n | app/web/src/i18n/locales/zh-CN/studio.json | memberCreate.inheritMemoryLabel/Hint | 删除 | 删 2 key（line 78-79） | MUST 同步 en（双删，i18n-key-add-checklist memory） | memory: i18n-key-add-checklist | -2 |
| ui-i18n | app/web/src/i18n/locales/en/studio.json | memberCreate.inheritMemoryLabel/Hint | 删除 | 删 2 key（line 78-79） | — | 同上 | -2 |
| ui-ut | app/web/src/components/studio-page/__tests__/section-member-create.test.tsx | derive mode 测试 | 修改 | 删 6 处 `inheritMemory` 断言/输入（line 5,118,131,138,150,158）；it 标题改 | MUST 保 derive 父选择 + overrides 断言；UT 全绿 | — | -6 |
| ui-spec | specs/ui/components/studio-page/member-create.md | Derive 区描述 | 修改 | 删「+ inheritMemory toggle」提及（line 11,21） | doc-modifier stage 5 同步（或 coder 随手） | — | -2 |
| ui-spec | specs/ui/overall/06-studio.md | Derive 描述 | 修改 | 删「+ inheritMemory toggle」（line 220） | doc-modifier stage 5 同步 | — | -1 |

### Group D — doc-modifier stage 5 同步（非本架构阶段产出，列全供 stage 5 接力）

> 本组 spec 文档**不阻塞编码/codereview**（非 change_plan 硬契约），由 doc-modifier 在所有 task verified 后统一同步。架构阶段不写。coder 改 `data_model §1.2/§5` + `squad_definition §3/§4`（Group A/B 已列）即可。

- `specs/api/overall/11a-squad-endpoints.md`（line 130 HireMemberBody / 221 derive 联合 / 255 step3 / 256 step4 / 298 不可改字段）
- `specs/api/overall/11-squad.md`（line 162 路径2 描述「inheritMemory=true 时复制记忆」）
- `specs/tech/squad/[P1]squad_tools.md`（line 46 hire input `{ deriveFrom, inheritMemory, overrides? }`）
- `specs/tech/squad/design.md`（line 33 SD1 行 / 68 schema / 122 派生段）
- `specs/prd/overall/08-squad-studio.md`（line 48 路径B / 68 路径2 / 155 v0.0.169 行）
- 各 KB `index.md`/`log.md` frontmatter（data_model / squad_definition / squad_tools / api 11a 的 updated/since）

---

## 影响面评估

- **跨模块**：squad schema / service / handler / agent tool / UT（4 server + 1 web）/ 前端 UI+i18n / 多份 spec。所有改动围绕同一目标（derive 派生正确性 + dead field 清理），高内聚。
- **破坏性变更**：
  - `MemberSchema.inheritMemory` field 删除 → 旧 client JSON body 传该字段被 schema 忽略（field 不再 required/declared；CrudStore fs engine 不 reject unknown key）。**无 400、无 migration**（field 本就 optional + dead）。
  - 前端 toggle 消失（Group C 若纳入）= 用户可见 UI 变化，但**无功能退化**（toggle 本就不工作）。
- **依赖顺序**（单 coder 一把梭，按文件依赖）：schema 字段删 → service（resolveEffective + step5 + step7.5）→ handler → tool → server UT → 前端 type/logic/comp/i18n/UT → spec → derive 新增 helper 联调。Group A 与 Group B 同文件（member-service.ts），同 task 内顺序无冲突。
- **风险点**：
  1. member-service.ts 现 300 行撞上限 + member-academy-bridge.ts 298 行——加 helper 必超；**coder 必须兜底 ≤300**（精简 docstring 或抽新小文件）。
  2. UT fixtures 删字段需同步 count 断言（`team-write-actions.test.ts:160` schema fields 数组、`squad-tool-schema.test.ts:41` 同款）。
  3. i18n key 删除 zh-CN + en **双删**（memory: i18n-key-add-checklist）。
  4. derive 复制若父成员改过名（parent.name 与历史 AGENTS.md 文件名不匹配）→ existsSync false → no-op；可接受（派生一次性快照，非动态联动）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
