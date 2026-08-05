# v0.0.142 变更计划书 — 成员「工作方式」（workStyle）字段

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 设计说明（关键决策，实现须遵守）

- **注入形态**：workStyle 作为**追加段**注入，不用 `{{}}` 模板占位（避免空值留悬空标题）。`SquadRoleMapper.map()` 的 leader/mate 分支构建完 content 后，若 workStyle 非空（trim 后），追加 `\n\n## 我的工作方式\n\n{workStyle}`；空则不追加、无任何占位。仍属同一 `squad_role` fragment（id/tier/priority 不变）。
- **注入范围**：**仅 leader + mate 两个 sessionType**（各自个人 session 的 `studioContext.member` = 自己）。squad 群聊 `studioContext.member===undefined`、subagent/standalone 早 return `[]` → 天然不注入。**MUST NOT 碰 team_roster / members[]**（全队花名册）。
- **可空 + 允许清空**：PATCH 提供空串 → 回写空串（清空），**无非空 400 校验**（区别于 intro）。schema `required:false`，empty string 是合法 string（schema-validation 只 typeof 检查），putMember 读改写 stripEnvelope 自动保留/覆盖。
- **类型自动流转（无需改的点，勿动）**：`MemberRecord`/`MemberEntity` = Infer/Stored<MemberSchema> → 加 schema 字段后自动含 workStyle；`StudioContext.member: MemberRecord`（context-types.ts:241）、`StudioSessionContext.member=StudioContext['member']`（session-config.ts:83）、bootstrap.ts:579 `getMember` 全链自动带 workStyle。前端 `patchMember`（squad-api.ts:106）`JSON.stringify(body)` 泛型透传 → 加 `PatchMemberBody.workStyle` 即流转。**这些文件不在本表 = 不改**。
- **hire 路径不涉及**：`createMemberService`/`resolveEffective`/`HireBody`/`HireMemberBody` 均不加 workStyle（默认空，仅编辑面板改）。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| data-model | app/server/src/agent/schema_defs/squad/member.ts | `MemberSchema.fields.workStyle` | 新增 | 加字段 `workStyle: { type: 'string', required: false }` + 注释（工作方式，仅个人 session 注入，仅用户可编辑）。MemberRecord/MemberEntity 自动派生 `workStyle?: string` | MUST `required:false`（容忍历史 record，PATCH 读改写不炸）；MUST NOT 加非空业务校验；MUST NOT 进 team 工具 schema | data_model.md §1.2；req 用户裁决 | +7 |
| api | app/server/src/handlers/member.ts | `PatchMemberBody`（interface） | 修改 | 加 `workStyle?: string`（注释：可空，空串=清空） | MUST 与 mutations `PatchMemberInput` 对齐 | 11a §2.2 | +1 |
| api | app/server/src/handlers/member.ts | `handlePatchMember()` | 修改 | 构 PatchMemberInput 时加 `if (body.workStyle !== undefined) patch.workStyle = body.workStyle;`（现 L232-236 附近） | MUST NOT 加 intro 那种 trim 后空→400（允许清空回写空串） | 11a §2.2；设计说明 | +1 |
| service | app/server/src/services/member-mutations.ts | `PatchMemberInput`（interface） | 修改 | 加 `workStyle?: string` | MUST 可空 | member-mutations.ts:31；11a §2.2 | +1 |
| service | app/server/src/services/member-mutations.ts | `patchMemberService()` | 修改 | merge 段（现 L172-179）加 `if (patch.workStyle !== undefined) merged.workStyle = patch.workStyle.trim();`（trim 归一，空串保留=清空）；read-modify-write 经 stripEnvelope spread 自动保留未改字段 | MUST NOT throw on empty（不加 intro 的 'intro required'）；MUST 走 read-modify-write putMember 不绕过 | member-mutations.ts §patchMemberService；data_model §1.2 | +1 |
| prompt-injection | app/plugins/builtins/rocky_context/prompt/squad_role.ts | `readMemberWorkStyle()` | 新增 | duck-typed helper：读 `ctx.config.studioContext.member.workStyle`，`typeof==='string' ? trim() : ''`（镜像 `readSquadName` L102-106） | MUST duck-typed（不 import 业务类型）；空/缺省返 '' | prompt_sections.md §3.1；squad_role.ts:102 先例 | +8 |
| prompt-injection | app/plugins/builtins/rocky_context/prompt/squad_role.ts | `SquadRoleMapper.map()` | 修改 | `content` const→let；build 后仅 leader/mate 分支：`const ws = readMemberWorkStyle(ctx); if (ws) content = \`${content}\n\n## 我的工作方式\n\n${ws}\`;` 再包 fragment | MUST 仅 sessionType==='leader'\|\|'mate'（squad/subagent/standalone 不追加）；MUST NOT 读 members[]/team_roster；空 workStyle MUST 不追加（无占位）；fragment id/tier/priority 不变 | prompt_sections.md §3.1；req 用户裁决；设计说明 | +6 |
| frontend-types | app/web/src/components/studio-page/squad-types.ts | `Member`（interface） | 修改 | 加 `workStyle?: string`（注释：工作方式，仅注入个人 session，旧 member 缺省） | MUST optional | squad-types.ts:80；11a §1.3 | +1 |
| frontend-types | app/web/src/components/studio-page/squad-types.ts | `PatchMemberBody`（interface） | 修改 | 加 `workStyle?: string`（注释：可空，空串=清空回写，无 400） | MUST optional；与后端 PatchMemberBody 对齐 | squad-types.ts:192；11a §2.2 | +1 |
| frontend-panel | app/web/src/components/studio-page/section-member-panel.tsx | import `TEXTAREA` | 修改 | 现有 `import { INPUT, FIELD_LABEL } from './studio-styles'` 加 `TEXTAREA`（studio-styles.ts:21 已存在，多行样式） | MUST 复用 TEXTAREA 常量，不硬编码 class | studio-styles.ts:21 | +0 |
| frontend-panel | app/web/src/components/studio-page/section-member-panel.tsx | `MemberPanel()` | 修改 | ①state `const [workStyle,setWorkStyle]=useState(member.workStyle ?? '')`；②`dirty` 加 `\|\| workStyle !== (base.workStyle ?? '')`；③`save()` patch 加 `if (workStyle !== (base.workStyle ?? '')) patch.workStyle = workStyle;`（不 trim，允许空串清空）；④`setBase({...base,name,intro,workStyle,...})`；⑤intro input 下加 `<textarea data-testid="member-workstyle-input" className={TEXTAREA}>`（label/placeholder 走 i18n），仍在 profile Card 内 | MUST intro 保持单行 input 不改；MUST 照 intro 的 state/dirty/patch 模式（但允许空串）；MUST 文件 ≤300 行（预估 ~213）；testid=`member-workstyle-input` | member-panel.md §testid；studio-styles.ts:21；req 用户裁决 | +13 |
| i18n | app/web/src/i18n/locales/zh-CN/studio.json | `memberPanel.workStyleLabel` / `.workStylePlaceholder` | 新增 | 2 key：label「工作方式（仅注入个人会话）」、placeholder「描述该成员的工作方式、偏好、原则…（可空）」（现 L105-106 introLabel 附近） | MUST 与 en 同结构同 key | i18n-key-add-checklist（memory） | +2 |
| i18n | app/web/src/i18n/locales/en/studio.json | `memberPanel.workStyleLabel` / `.workStylePlaceholder` | 新增 | 2 key：label「work style (injected into own session only)」、placeholder「Describe this member's work style, preferences, principles… (optional)」（现 L105-106 附近） | MUST 与 zh-CN 同结构同 key | i18n-key-add-checklist（memory） | +2 |
| ut | app/plugins/builtins/rocky_context/prompt/__tests__/squad-role-mapper.test.ts | 新增 case | 修改 | 加：①leader + `studioContext:{member:{workStyle:'X'}}` → content 含 'X' + '## 我的工作方式'；②mate 同；③leader workStyle 空串/缺省 → content **不含** '## 我的工作方式'；④squad session 带 member.workStyle（防御）→ 不追加。用现有 `mkCtx` 加 studioContext override | MUST 断言追加段存在/缺席 + 分支正确 | squad-role-mapper.test.ts:19（mkCtx） | +30 |
| ut | app/server/src/services/__tests__/member-mutations.test.ts | 新增 case（describe patchMemberService） | 修改 | 加：①patch workStyle 落库（trim 后）；②patch workStyle='' → 清空落库空串（**不** throw）；③改 intro 时 workStyle 保留不丢；④workStyle 缺省 → member 无该字段 | MUST 覆盖 set/clear/preserve；MUST NOT 期望空串抛错 | member-mutations.test.ts:186 | +25 |
| ut | app/server/src/handlers/__tests__/member.test.ts | 新增 case | 修改 | 加：PATCH workStyle 经 `handleMemberRoute` → 200 + member.workStyle 落库；PATCH workStyle='' → 200 清空（非 400） | MUST 走 handleMemberRoute 端到端 | member.test.ts:20（handleMemberRoute） | +20 |

## 影响面评估

- **跨模块**：backend schema/api/service（3 文件）+ rocky_context plugin（1 文件）+ frontend types/panel/i18n（4 文件）+ UT（3 文件）。共 **11 个改动文件 + 3 UT 文件**，**14 个符号行**。
- **无破坏性变更**：新增 optional 字段，历史 member record 无 workStyle 优雅降级（schema required:false + 前端 `?? ''` + mapper 空则不注入）。
- **依赖顺序**：schema（底层）→ handler/service（api）→ prompt mapper（消费）；frontend types → panel → i18n。UT 随各层。schema 先行（MemberRecord 派生驱动上层类型）。
- **不改文件（设计说明已列，勿动）**：bootstrap.ts、session-config.ts（StudioSessionContext）、context-types.ts（StudioContext）、squad-api.ts、member-service.ts、leader.md/mate.md、team_roster mapper。
- **风险点**：
  1. 注入范围误扩到 squad/team_roster → 破「仅个人 session」铁律（review 重点查 map() 分支条件）。
  2. patchMemberService 误加空串 400 → 无法清空（review 查无 throw）。
  3. section-member-panel.tsx 加字段后行数（预估 ~213，安全，但 review 复核 ≤300）。
- **打包护栏**：无新第三方依赖、无新 plugin/资源、无新运行时 env、无新文件系统入口 → 四类 packaged 专属崩溃均不涉及，无需 packaged 版验证。

## spec 同步待办（doc-modifier 阶段 5，本阶段不改 spec 正文）

- `specs/tech/squad/[P1]data_model.md` §1.2 — member schema 加 `workStyle`（optional string，语义 + 仅个人 session 注入 + 仅用户可编辑）。
- `specs/tech/squad/[P1]prompt_sections.md` §3.1 — squad_role 注入契约补 workStyle 追加段（leader/mate 分支，空则不注入，不进 team_roster）。
- `specs/tech/squad/[P1]session_config_studio.md` — studioContext.member 含 workStyle（自动派生，说明消费方）。
- `specs/api/overall/11a-squad-endpoints.md` §1.3 Member（加 workStyle 字段）+ §2.2 PatchMemberBody（加 workStyle，注明可空/可清空/无 400）。
- `specs/ui/components/studio-page/member-panel.md` — profile Card 加多行 workStyle textarea；testid 列表加 `member-workstyle-input`；intro 保持单行说明。
- per-KB `specs/tech/squad/log.md` + `specs/tech/version_logs/v0.0.142/change_log.md` 记本版本变更。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder。
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计。
