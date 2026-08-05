# v0.0.250 — Tech Change Log（派生自成员补齐个人 AGENTS.md 复制 + 清理 inheritMemory dead field）

> 跨版本发布说明（版本轴）。本目录级变更见各 KB `log.md`（位置轴）：`specs/tech/squad/log.md` + `specs/tech/academy/log.md`。
> 权威输入：`specs/tech/version_logs/v0.0.250/change_plan.md` + `states/v0.0.250/context.md`。

## 概览

v0.0.250 是 squad member 派生机制的补齐 + dead field 清理——两件套高内聚：

1. **derive（派生自成员）补齐个人 AGENTS.md 复制**：v0.0.232 引入 AGENTS.md 两级读取（团队 + 个人差异）+ v0.0.233 derive_academy 落点重映射后，**derive mode 只继承 record 字段、不复制父成员个人差异 AGENTS.md**——本版本在 hire 事务 `step 7.5` 补齐复制（`copyPersonalAgentsMd` in `member-academy-bridge.ts`）。
2. **清理 inheritMemory dead field**：`inheritMemory` 字段声明「派生时复制父角色长期记忆」**从未落地**——memory 已 v0.0.232 转团队盘 `.rocky/memory/` 全队共享，无复制语义。全栈清理（server schema/service/handler/agent tool + 5 UT + 前端 UI 级联 + 多份 spec）。

**破坏性变更**：`MemberSchema.inheritMemory` 字段删除 → 旧 client JSON body 传该字段被 schema 忽略（field 不再 required/declared；CrudStore fs engine 不 reject unknown key）。**无 400、无 migration**（field 本就 optional + dead）。前端 Derive 区 inheritMemory toggle 消失（dead UI 拆除）——用户可见 UI 变化，但**无功能退化**（toggle 本就不工作，hint「继承父角色长期记忆」是虚假承诺）。

## §1 架构决策（冻结于 change_plan）

1. **derive 复制 AGENTS.md 实现位置 = 抽公共 helper `copyPersonalAgentsMd()` 放 `member-academy-bridge.ts`**——co-location 零新依赖（bridge 已 import `copyFile / mkdir / existsSync / join`），与 `seedMemberWorkspaceFromVersion` 内的 AGENTS.md 块同一关注点但 **source 形态不同**（derive source = 父成员个人文件；derive_academy source = version workspace 根 AGENTS.md），允许局部小重复（不重构 derive_academy）。
2. **复制时机 = `createMemberService` step 7.5（derive 分支专属）**：紧跟 `step 7 derive_academy seed` 之后、`step 8 return` 之前。条件 `if (input.mode === 'derive' && input.deriveFrom && eff.parentMemberId)`。
3. **父成员个人 AGENTS.md 路径推导 = `{squadRoot}/.rocky/agents/{parent.name}-{parent.id}.md`**（与 `prompt-handler.ts` + `member-academy-bridge.ts` + `squad-store.ts` 四处权威一致；**无独立 helper**，按 `{memberName}-{memberId}.md` 字面拼接）。子路径 = `…/{eff.name}-{memberId}.md`（按子 memberId 重命名）。
4. **parent 信息透传 = `resolveEffective` derive 分支 return 加 `parentName` + `parentMemberId`**（parent 已加载，零额外 IO；避免 createMemberService 二次 getMember）。
5. **失败补偿口径 = 静默 no-op**（与 `seedMemberWorkspaceFromVersion` AGENTS.md 块同口径——`catch {}` 内置空，不入 written、不 throw）。父无 → no-op；复制失败 → no-op。**MUST NOT 触发 hire 事务回滚**（member 建成功为主；个人差异文件缺失非阻塞，子成员继续用团队级 AGENTS.md 兜底）。
6. **inheritMemory 全影响面 grep 闭合**（server schema/service/handler/agent tool + 5 UT + 前端 UI 级联 + spec；详见 §3）。
7. **deriveFrom 保留**（一次性溯源字段，**MUST NOT 删**——所有改动只针对 inheritMemory）。

## §2 derive 补齐个人 AGENTS.md 复制（squad KB + academy KB 边界）

### 2.1 实现位置 + 路径

`app/server/src/services/member-academy-bridge.ts:copyPersonalAgentsMd()` —— 复制父成员个人差异 AGENTS.md → 子成员名下。源 = `{squadRoot}/.rocky/agents/{parentName}-{parentMemberId}.md`；目标 = `…/{childName}-{childMemberId}.md`。父不存在（`existsSync=false`）/复制失败 → 静默 no-op。

### 2.2 step 7.5 调用点

`app/server/src/services/member-service.ts:createMemberService()` step 7.5 —— `if (input.mode === 'derive' && input.deriveFrom && eff.parentMemberId)` → `await copyPersonalAgentsMd({squadRoot: workspaceDir, parentName: eff.parentName!, parentMemberId: eff.parentMemberId!, childName: eff.name, childMemberId: memberId})`。**derive_academy 分支（step7）不动**（已含 AGENTS.md seed）。

### 2.3 与 derive_academy 的差异（不变量）

- **derive**：source = 父成员**个人差异** AGENTS.md（`.rocky/agents/{父name}-{父id}.md`）；只复制 AGENTS.md，**不碰 skills/memory**（团队级，已共享）。
- **derive_academy**：source = 学生 version workspace 根 AGENTS.md + `.rocky/skills` + `.rocky/memory`；按 resolution 裁决 seed 到团队盘（v0.0.233 预检+裁决机制）。
- 两者独立、不重构、源路径形态不同。

## §3 inheritMemory 全影响面清理（grep 闭合）

### 3.1 server（Group B）

- `app/server/src/agent/schema_defs/squad/member.ts` MemberSchema.fields.inheritMemory 删
- `app/server/src/services/member-service.ts` CreateMemberInput.inheritMemory + resolveEffective return + step5 putMember spread 删
- `app/server/src/handlers/member-hire-handler.ts` HireBody derive 分支 + handleHire input 组装 删
- `app/server/src/agent/tools/team-write-actions.ts` TEAM_INPUT_SCHEMA.properties.inheritMemory + runHire() consume + 函数 docstring 删
- `app/server/src/agent/tools/team-tool.ts` TEAM_TOOL description 字符串 删 inheritMemory 提及

### 3.2 UT（Group B + C）

4 个 server UT（member-service.test.ts / squad-member-model-validation.test.ts / team-write-actions.test.ts / squad-tool-schema.test.ts，含 schema fields 数组 count 断言 -1）+ 1 个 web UT（section-member-create.test.tsx）同步删 inheritMemory fixtures/断言。

### 3.3 前端 UI 级联（Group C — architect 推荐「不遗留死代码」）

- `squad-types.ts` HireBody/derive body type 删 inheritMemory
- `member-create-hire-body.ts` buildHireBody() + DeriveHireInput type 删
- `section-member-create.tsx` Derive 区 toggle 删（state + ToggleSwitch `data-action-key="studio.member.toggle-inherit-memory"` + onSubmit 传参 + 文件头注释）
- `i18n locales/{zh-CN,en}/studio.json` 删 `memberCreate.inheritMemoryLabel/Hint` 2 key 双删
- 用户可见 UI 变化但**无功能退化**（toggle 本就不工作）

### 3.4 spec 同步（Group D — doc-modifier stage 5）

详见 §4 文件清单。

## §4 文件变更清单（spec）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `specs/tech/squad/[P1]data_model.md` | 修改（coder 阶段 + doc-modifier 瘦身） | §1.2 Member schema 删 inheritMemory 字段（并删墓志铭注释）+ §5 step 列表加 step7.5 描述 |
| `specs/tech/squad/[P1]squad_definition.md` | 修改（coder + doc-modifier） | §3 删 inheritMemory + §4 derive bullet 加「复制父成员个人 AGENTS.md」 |
| `specs/tech/squad/[P1]squad_tools.md` | 修改（doc-modifier） | §2 hire derive 入参 `{ deriveFrom, inheritMemory, overrides? }` → `{ deriveFrom, overrides? }` |
| `specs/tech/squad/design.md` | 修改（doc-modifier） | SD1 + RoleSpec + §5 派生段三处删 inheritMemory，改述「复制个人 AGENTS.md（父无 → no-op）；memory 不复制」 |
| `specs/tech/academy/[P1]squad_derive.md` | 修改（doc-modifier） | §2.1 CreateMemberInput 删 inheritMemory + §6 边界表 derive mode 描述改述 |
| `specs/api/overall/11a-squad-endpoints.md` | 修改（doc-modifier） | v1.10 §1.3 Member + §2.1 HireMemberBody derive 分支 + step 删 inheritMemory + 加 step7.5 描述 |
| `specs/api/overall/11-squad.md` | 修改（doc-modifier） | 路径 2 验证点改述「derive 复制父成员个人 AGENTS.md（非记忆）」 |
| `specs/prd/overall/08-squad-studio.md` | 修改（doc-modifier） | v2.2 §8.2 B 行 + §8.3 路径 2 + §8.7 v0.0.169 承接行删 inheritMemory |
| `specs/ui/overall/06-studio.md` | 修改（doc-modifier） | §9 Derive 描述删 inheritMemory toggle |
| `specs/ui/components/studio-page/member-create.md` | 修改（doc-modifier） | Derive 区描述 + derive 专属字段 删 inheritMemory |
| 各 KB `index.md`/`log.md` frontmatter | 修改（doc-modifier） | squad KB + academy KB updated 2026-08-04，squad KB log.md 加 v0.0.250 条目 |

## §5 代码↔spec 一致性核实结论（CLAUDE.md 原则 12）

- **derive 复制 AGENTS.md 新行为**：spec（`data_model §5 step7.5` + `squad_definition §4`）描述与代码（`member-academy-bridge.ts:copyPersonalAgentsMd` line 282-298 + `member-service.ts` step7.5 line 279-285）完全一致——① 仅 derive 分支调用（条件 `mode==='derive' && deriveFrom && parentMemberId`，derive_academy 走 step7 不调）；② 父无 → `existsSync(src)` false → return（no-op）；③ 复制失败 → `catch {}` 空体 → no-op，**不触发事务反向补偿/回滚**；④ 路径 `{squadRoot}/.rocky/agents/{parentName}-{parentMemberId}.md → {childName}-{childMemberId}.md` 字面拼接（line 292 + 296）；⑤ parent 信息经 `resolveEffective` return 透传（零二次 getMember）。
- **inheritMemory 删除闭合**：`grep -rn inheritMemory specs/`（排除 `version_logs/`、`archive/`）仅剩 2 处——均为 overall 文件 header/路径段的**版本标注删除注释**（`[v0.0.250] ... inheritMemory ... 已删`），遵循 overall 文件既有惯例（类比 `[v0.0.158] summaryModelDefault ... 整删` 注释，[v0.0.48] tools 字段移除注释），**无功能性引用残留**（schema/interface/step description/路径/错误码均归零）。
- **app-guide**：`specs/ui/overall/00-app-guide.md` 无 inheritMemory / member-create toggle 提及（Group C dead UI 未渗透到导航手册），跳过。
