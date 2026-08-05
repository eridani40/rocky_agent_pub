# v0.0.142 — Tech Change Log（member `workStyle` 工作方式字段：编辑面板可管理 + 仅注入个人 session prompt）

> 跨版本发布说明（版本轴）。本目录级变更见 `specs/tech/squad/log.md`（位置轴，2026-07-14 块）。
> 权威变更契约见同目录 `change_plan.md`（14 符号行 / 11 改动文件 + 3 UT）。

## 概览

member 加 optional `workStyle` 字段——成员编辑面板可管理的「工作方式」自由多行文本（偏好 / 原则 / 习惯）。它是 `intro` 的孪生 optional 字段（数据模型 / API / 前端三层照 intro 落地），但有两点实质差异：

1. **注入面唯一** = `squad_role` mapper 的 leader/mate 分支（个人 session），**不进 team_roster 全队花名册**——`studioContext.member` 恒指当前 session 自己的 member，天然满足「仅个人 session 注入」。
2. **可空 + 允许清空 + 无非空校验**（区别 intro 的空→400）：PATCH 空串 = 清空回写空串。
3. **仅用户可编辑**：不进 agent `team` 工具 schema——`team.edit` 服务端显式剔除 workStyle（防 LLM 经工具改写用户专属字段）。

## §1 数据模型（squad tech）

### 1.1 MemberSchema 加 `workStyle`

`app/server/src/agent/schema_defs/squad/member.ts`：`fields` 加 `workStyle: { type: 'string', required: false }`。`MemberRecord`/`MemberEntity`（`InferRecord`/`Stored`）自动派生 `workStyle?: string`。**MUST `required:false`**（容忍历史 record，PATCH read-modify-write 不炸）；**MUST NOT 加非空业务校验**（区别 intro 的 fresh 必填）；**MUST NOT 进 team 工具 schema**。→ `specs/tech/squad/[P1]data_model.md §1.2` + 新增 `§1.2c`。

### 1.2 §1.2c 语义段（新增）

data_model 新增 `§1.2c workStyle 工作方式`：注入面唯一（squad_role leader/mate）/ 可空清空语义 / 仅用户可编辑（四面对齐 #17 显式豁免——覆盖 store/HTTP/UI 三面，故意不覆盖 agent 工具面）/ hire 不涉及。`index.md ④#17` exemption 登记该豁免。

## §2 API / service（squad tech + api KB）

- **`handlers/member.ts`**：`PatchMemberBody` 加 `workStyle?: string`；`handlePatchMember` 构 `PatchMemberInput` 时 `if (body.workStyle !== undefined) patch.workStyle = body.workStyle;`——**无 intro 那种 trim 后空→400**（允许清空回写空串）。
- **`services/member-mutations.ts`**：`PatchMemberInput` 加 `workStyle?: string`；`patchMemberService` merge 段 `if (patch.workStyle !== undefined) merged.workStyle = patch.workStyle.trim();`（trim 归一，空串保留=清空，不 throw）。read-modify-write `putMember`（stripEnvelope spread 自动保留未改字段）。
- **API 契约** `specs/api/overall/11a-squad-endpoints.md`：§1.3 `Member` + §2.2 `PatchMemberBody` 加 `workStyle?`（可空/空串=清空/无 400；hire §2.1 不含；仅用户可编辑）。version 1.4→1.5。

## §3 prompt 注入（squad tech + rocky_context plugin）

- **`app/plugins/builtins/rocky_context/prompt/squad_role.ts`**：
  - 新增 `readMemberWorkStyle(ctx)` duck-typed helper（镜像 `readSquadName`）——读 `ctx.config.studioContext.member.workStyle`，`typeof==='string' ? trim() : ''`，缺省/非字符串/空串返 `''`。
  - `SquadRoleMapper.map()`：`content` const→let；build 完 content 后，**仅 `sessionType==='leader'||'mate'`** 分支 `const ws = readMemberWorkStyle(ctx); if (ws) content = \`${content}\n\n## 我的工作方式\n\n${ws}\`;`——空则不追加（无悬空标题，非 `{{}}` 模板占位）；`squad`/`subagent`/`standalone` 不追加。仍属同一 `squad_role` fragment（id/tier/priority 不变）。**MUST NOT 读 members[]/team_roster**。
- **`leader.md`/`mate.md` content fragment 不改**（追加段在 mapper 代码内 build，非 content 文件）。
- **类型链自动流转，以下文件不改**（架构裁决）：`bootstrap.ts`（传全 member entity）/ `context-types.ts`（`StudioContext.member: MemberRecord`）/ `session-config.ts` / `squad-api.ts`。→ `specs/tech/squad/[P1]prompt_sections.md §3.1` + `[P1]session_config_studio.md §4`。

## §4 前端（web/studio-page + i18n）

- **`squad-types.ts`**：`Member` + `PatchMemberBody` 加 `workStyle?: string`。
- **`section-member-panel.tsx`**：profile Card 内 intro input **下方**多行 `<textarea data-testid="member-workstyle-input" className={TEXTAREA}>`（label/placeholder 走 i18n）；state `workStyle` 照 intro 的 state/dirty/patch 模式，但 **dirty 与 `member.workStyle ?? ''` 比、save 不 trim 判空**（允许提交空串清空）。intro 保持单行 input 不改。文件仍 ≤300 行。
- **i18n** `zh-CN/en/studio.json`：`memberPanel.workStyleLabel` + `.workStylePlaceholder` 各 2 key（同结构同 key，走 `t()`）。
- → `specs/ui/components/studio-page/member-panel.md`（profile Card + testid + 状态）。

## §5 已采纳偏离（coder 发现的安全 gap 修正，orchestrator 采纳）

**`app/server/src/agent/tools/team-write-actions.ts runEdit()` 显式剔除 `workStyle`**（非 change_plan 14 符号行之一，也不在「不改文件」清单）。

- **背景**：`runEdit()` 原对 `input.patch` 做 `rawPatch as PatchMemberInput` 整体裸类型转换（无字段级 allowlist，仅 `hasValid` 校验「至少一个已知字段非空」，其余字段原样透传）。`PatchMemberInput` 加 `workStyle?` 后，若 LLM 在 `team.edit` 的 `patch` 里塞 `workStyle`（`TEAM_INPUT_SCHEMA.patch` 是裸 `type:'object'` 无 `additionalProperties:false`，schema 层挡不住），会原样透传给 `patchMemberService` 落库——**违反用户核心裁决「workStyle 仅用户可编辑，不进 agent 管理工具」**。
- **修正**：`runEdit()` `const { workStyle: _dropped, ...patchWithoutWorkStyle } = p;` 显式剔除后再 cast。其余 tools/heartbeat 透传 + service 单源 warn 的既有模式不变，`team-write-actions.test.ts` 既有断言未破坏。
- **新增 UT 1 条**（`team-write-actions.test.ts`，非 change_plan 3 UT 之列）：验证 `workStyle` 被剔除不透传。
- **spec 同步**：`[P1]squad_tools.md §2` team.edit 行补 workStyle 剔除说明；`data_model §1.2c` + `index.md ④#17` 记为四面对齐显式豁免。

## §6 UT（3 change_plan 文件 + 1 偏离补充）

- `squad-role-mapper.test.ts`：leader/mate + `studioContext:{member:{workStyle:'X'}}` → content 含 'X' + '## 我的工作方式'；空串/缺省 → 不含；squad session 带 member.workStyle（防御）→ 不追加。
- `member-mutations.test.ts`：patch workStyle 落库（trim 后）/ workStyle='' 清空落库空串（不 throw）/ 改 intro 时 workStyle 保留 / workStyle 缺省无该字段。
- `member.test.ts`：PATCH workStyle 经 `handleMemberRoute` → 200 落库 / workStyle='' → 200 清空（非 400）。
- `team-write-actions.test.ts`（偏离补充）：workStyle 被 `runEdit()` 剔除不透传。

验证口径（用户裁决 = 无 AT/ET）：`bun run test` 全量绿（597 文件/6980 测试）+ `bun run typecheck` 绿。

## §7 spec 同步清单

| KB / 目录 | 文件 | 变更 |
|---|---|---|
| squad tech | `[P1]data_model.md` | §1.2 Member 加 workStyle + 新增 §1.2c 语义/豁免；frontmatter updated |
| squad tech | `[P1]prompt_sections.md` | §3.1 squad_role 补 workStyle 追加段（leader/mate、空不注入、不进 team_roster） |
| squad tech | `[P1]session_config_studio.md` | §4 studioContext.member 完整 MemberRecord → workStyle 自动流转（bootstrap 不改） |
| squad tech | `[P1]squad_tools.md` | §2 team.edit 行补 workStyle 服务端剔除（仅用户可编辑豁免） |
| squad tech | `index.md` / `log.md` | ④#17 exemption 登记 workStyle 豁免；log 记 v0.0.142 块 |
| api | `11a-squad-endpoints.md` | §1.3 Member + §2.2 PatchMemberBody 加 workStyle；version 1.5 |
| ui | `studio-page/member-panel.md` | profile Card 加 workStyle textarea + testid `member-workstyle-input` + 状态说明 |
