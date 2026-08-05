# v0.0.113 API change_log — Member skillConfig overlay

> 类型：契约变更（②）。④ 无 API 变更（纯前端）。

## 变更端点（`specs/api/overall/11a-squad-endpoints.md`）

### Member.skills → skillConfig（②，破坏性）

`Member` 响应 + `HireMemberBody` + `PatchMemberBody` 的 `skills: string[]` **推翻重写**为：

```typescript
type MemberSkillConfig = { mode: "inherit" | "custom"; overrides: Record<string, boolean> };
```

| 端点 | 变更 |
|------|------|
| `GET /squad/:id`（SquadDetail.members[]） | `Member.skills: string[]` → `Member.skillConfig: MemberSkillConfig`（旧 record 无 skillConfig → 视为默认 inherit） |
| `POST /squad/:id/member`（HireMemberBody） | fresh `skills?: string[]` → `skillConfig?`；derive `overrides.skills?` → `overrides.skillConfig?`。缺省 = `{mode:'inherit',overrides:{}}`（后端 seed） |
| `PATCH /squad/:id/member/:mid`（PatchMemberBody） | `skills?: string[]` → `skillConfig?`。整体替换快照（后端不合并旧值）；off 存 → overrides={} (R6)；custom 存 → 前端补齐全量快照 (R5) |
| `POST /squad`（leader 建队 seed） | leader 成员 seed 默认 `skillConfig:{mode:'inherit',overrides:{}}`（不再 seed skill 白名单） |

**校验**：skillConfig 不做 catalog 命中校验（overlay 容忍未知/后续新增 skill name）。

**AT 影响**：member/squad API case 断言 `skills` 数组的需改为断言 `skillConfig` 对象。相关 case 需 designer 更新（member hire/patch、squad detail）。

### ④ 无 API 变更

studio 模型 hover 显「未配置」修复为纯前端反查（picker 加 `defaultModelId` prop，对 `squad.modelDefault` 纯 modelId 反查 provider）。`GET /squad` 已回传 `modelDefault`（现有字段），无新增字段、无契约变更、**不影响 AT**。

## 不兼容说明

不兼容旧数据（用户拍板，无迁移）。旧 member.json 的 `skills` 字段读不到 `skillConfig`——运行期 overlay resolve 读 `member.skillConfig`，缺失则前端/schema 默认 inherit（等价旧「全局 enabled 全给」的合理近似）。

## doc-modifier 阶段 5 同步（spec↔code 对齐）

- **`11a §2.2` prose 残留清理**：`PatchMemberBody` 历史注解（req6/v0.0.48 两处「可变字段收敛为 `... skills ...`」）的 `skills` → `skillConfig`（权威 interface 早已 skillConfig，仅 prose stale）。
- **`11a §2.2` `model?` 语义澄清**：PatchMemberBody 保留 `model?`——「删 model」= 删成员面板 model 编辑 UI，**非**删数据字段/接口；member.model 数据仍经 PATCH 落盘（改由对话界面 `InputModelPicker` 编辑，`onChange→patchMember`）。handler 实测仍应用 `patch.model`（`handlers/member.ts:239`）。
- **`06-skill.md §3.2`（GET /skill 列表响应）修正**：原写「双层合并」+ 示例仅 app/workspace → 对齐代码实际 **三层**（`SkillScope='builtin'|'app'|'workspace'`，`skills/types.ts:18`；GET /skill handler 传 `builtinSkillRoot()` 返 builtin 项）。这是 v0.0.113 成员 skills overlay catalog 分层的基础（builtin/app 受 overlay 治理，workspace 恒生效）。install scope 仍双层（不能装 builtin）。

## 前端 SkillEntry.scope 三层对齐（T5 已落，doc-modifier 阶段 5 复核确认）

- **前端 `app/web/src/lib/api-client.ts:513` `SkillEntry.scope` = `'builtin' | 'app' | 'workspace'`**——三层，与后端 `SkillScope`（`skills/types.ts:18`）+ GET /skill 实返 builtin 项一致。T5（内置技能只读性 UI）随手补齐；`patchSkillEnabled`（api-client.ts:604）`scope?: 'builtin' | 'app' | 'workspace'` 亦三层（builtin 可 enable 切换）。governance（api-client.ts:633）scope 仍 `'app' | 'workspace'`——builtin 不可改进化（后端 400），双层正确。code↔spec 一致，无遗留。
