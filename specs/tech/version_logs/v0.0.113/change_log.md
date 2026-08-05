# v0.0.113 tech change_log — UI 优化四件套 + 内置技能只读性 UI（T5，扩范围）

> 类型：UI 优化 + 成员配置语义重构（① bug 修 / ② 交互重构含新数据概念 / ③ 板块删除 / ④ 展示修正 / ⑤ 内置技能只读性 UI + i18n 转正，用户扩范围批准）。
> 权威变更契约见同目录 `change_plan.md`（method 级，18 行 ①②③④；⑤ 为 change_plan 冻结后扩范围，见下 ⑤ 摘要）。PRD：`specs/prd/version_logs/v0.0.113/`。

## 影响子系统 KB

| KB | 改什么 |
|----|--------|
| `specs/tech/squad/` | ② member.skillConfig overlay（`index.md` 原则#14 + `data_model.md §1.2` + `session_config_studio.md §3/§3.2` + `log.md`）；④ modelId resolve 真相修正（session_config_studio §3 stale D5 对齐） |
| `specs/tech/agent/providers_and_models/` | ④ `log.md` 重申 model_resolve 正确 + 前端格式错配定位（KB 契约无改） |
| `specs/tech/agent/skills/` | ② 无契约改（catalog 三层不变）；overlay resolve 落在 squad KB 的 studio 分支 |
| `specs/ui/components/studio-page/member-panel.md` | ②③ section 重构 + testid 变更（skills switch + 筛选器；删 model / 记忆） |
| `specs/ui/components/chat-page/component-input-model-picker.md` | ④ `defaultModelId` prop + studio 纯 modelId 反查 |
| `specs/api/overall/11a-squad-endpoints.md` | ② Member.skills→skillConfig；HireBody/PatchMemberBody skills→skillConfig |
| `specs/api/overall/06-skill.md` | ⑤ §3.2 GET /skill 列表 `SkillEntry.scope` 双层→三层 builtin\|app\|workspace（doc-fix，对齐后端 `SkillScope`；builtin 只读性基础） |
| `specs/ui/components/skill-page/component-skill-item.md` | ⑤ builtin scope 只读性 UI（进化/删除 disabled+hover title + i18n key `item.builtinNoEvolve/builtinNoDelete`） |

## 四点摘要

### ① Skill 管理页可滚动（bug，纯前端 CSS）
`page-skill.tsx` 根 `<main>` + body `flex-1` 无 `min-height:0` → flex 撑高吃掉滚动。修 flex/overflow（coder 定位），保 header border-b + body max-width 880px。无数据/契约改。

### ② 成员 skills overlay 重构（前后端 + API 契约变更）
- **数据模型（O-1）**：`member.skills: string[]`（白名单）→ `member.skillConfig: { mode:'inherit'|'custom', overrides: Record<string,boolean> }`。schema `member.ts` 改；不兼容旧数据（用户拍板，无迁移）。新成员默认 inherit。
- **resolve（O-2）**：`session-config.ts` D4 交集 → overlay：workspace 恒生效（R2）；builtin/app inherit→全局 enabled、custom→全局叠加 overrides（R1/R3）。
- **筛选器（O-3）**：新组件 `component-member-skill-filter`（enable/disable 列表 + 搜索），testid 契约落 member-panel.md，组件自身 spec 交 coder 编码前置。
- **决策**：builtin 与 app 同治 overlay；角色区分改由 squad_role mapper + tool-policy 保证（不再靠 skill 白名单）——有意行为变更。

### ③ 成员编辑记忆板块删除（纯前端）
删 `section-member-panel.tsx` 的 `member-section-memory` Card + `component-member-panel-memory.tsx` 组件 + memory testid。后端 session_memory 不动，会话界面记忆入口不动。

### ④ studio 模型 hover 展示实际生效默认（纯前端，无 API 变更）
- **真相（O-4）**：resolveModel 正确（studio 不读 app_config）；squad.modelDefault 存盘纯 modelId、required 非空、建队 seed 全局默认 → chat resolve 恒命中。
- **bug 根因（O-5）**：前端 `parseModelRef(squad.modelDefault)` 要求 `providerId/modelId`（含 `/`），纯 modelId 无 `/` → 返 null → 显「未配置」。
- **修法**：picker 加 `defaultModelId?: string`（studio 传原始 squad.modelDefault），对纯 modelId 反查 provider（复用 `findProviderIdByModelId`）。真无可用（反查不中）才显「未配置」。无后端/AT 变更。

### ⑤ 内置技能只读性 UI + i18n 转正（T5，扩范围，纯前端 + api-doc）
补 `SkillEntry.scope` 三层类型（`api-client.ts:513` = `'builtin'|'app'|'workspace'`，对齐后端 `SkillScope`）时暴露全局 skill 页对 builtin 无条件显示进化/删除按钮的 UX 瑕疵（点了必被后端拒）。后端三态**早已存在、本版本不改**：进化 governance 对 builtin 返 **400**（`skills/governance.ts` scope 仅 app\|workspace）；DELETE 对 builtin 返 **403**（`handlers/skill.ts:217`）；PATCH enable **接受 builtin**（可启停）。UI 按此语义明示只读：`component-skill-item` builtin scope 时进化 toggle + 删除按钮 `disabled` 灰化 + hover title（`item.builtinNoEvolve`/`item.builtinNoDelete`，skill ns zh/en 双 locale + `t()` 渲染），enable 保持可用。契约变更仅 `06-skill.md §3.2` scope doc-fix（双→三层，见上表）；无端点/schema 改。

## 影响面订正（change_plan under-count，事后记录）

`change_plan.md` ② 段只列 5 个后端 owning 文件（member.ts schema / member-service.ts / squad-service.ts / member.ts handler / session-config.ts）。实际 `member.skills`→`skillConfig` schema 字段推翻还扩散到：

- **`app/server/src/agent/tools/team-tool.ts`**（`runQuery` 详情序列化）：team.query 返回的 member 详情把 `m.skills` 改为 `m.skillConfig`（否则读已删字段 → undefined，team.query 详情漏 skill 信息）。change_plan 未列——schema 字段是被跨模块消费的，删字段须 grep 全部读取点。
- **测试 fixture**（UT/AT 构造 member 记录处）：凡手工造 `Member`/`HireBody`/`PatchMemberBody` 的测试夹具，`skills:[...]` → `skillConfig:{mode,overrides}`。

教训：schema 删字段的影响面 = 所有读该字段的消费点（`grep member.skills` / `\.skills`），不止 owning 服务链；architect 落 change_plan 时应 grep 字段消费点扩展影响列。`change_plan.md` 是冻结合同不改，扩散记此处。

## spec↔code 一致性修正（本版本对齐）

1. `session-config.ts:133-134` 注释「skills=catalog ∩ member.skills（D4）」+「modelId ... ?? app_config 默认（D5）」→ 均 stale。coder 随 session-config 改动对齐（D4→overlay；D5→resolveModel 真相）。
2. `[P1]session_config_studio.md §3` skills 行（D4）+ modelId 行（D5 含 app_config）→ 已修正为 overlay + resolveModel 真相（architect 本版本落）。

## 打包护栏自评
四类（依赖归属 / plugin 进 asar / runtime-config env / 路径展开）**均不触发**——纯逻辑改 + 前端，无新依赖/plugin/env 键/文件系统启动入口。见 `change_plan.md` 护栏自评表。
