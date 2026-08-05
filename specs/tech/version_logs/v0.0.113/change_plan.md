# v0.0.113 变更计划书 — UI 优化四件套（skill 页滚动 / 成员 skills overlay 重构 / 记忆板块删除 / 模型 hover 展示）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 覆盖 PRD `specs/prd/version_logs/v0.0.113/change_log.md` 的 ①②③④ 全部改动点，钉死开放技术点 O-1~O-6。

## 关键实测结论（ground truth，落行前已核对代码/存盘数据）

1. **④ resolve 链真相（O-4）**：`services/model-resolver.ts` 是权威且正确——studio 分支 `buildFallbackChain` **完全不读 `app_config.default_models`**，与 `[P0]model_resolve.md §3/§4` 一致。studio member session chat 链 = `bodyOverride → sessionModelId → member.model(leader/mate) → squad.modelDefault → throw`。
2. **squad.modelDefault 真相**：schema `required: true` 非空，**存盘为纯 modelId**（实测 `~/.rocky_agent_dev/squad/*.json` = `"MiniMax-M3"`，无 `providerId/` 前缀）。`POST/PATCH /squad` 用 `checkModel` 校验为某 enabled provider 的 enabled modelId。**不存在「运行时 squad.modelDefault 为空继承全局」的态**——「继承全局」= 建队时 UI seed 全局默认到该字段（一次性），运行期恒为具体值。故「对话能 resolve 到默认」为真（resolve 命中 squad.modelDefault）。member.model 实测 `""`（inherit）。
3. **④「未配置」根因（O-5）**：纯前端格式错配。studio picker 父级传 `defaultModel={parseModelRef(squad.modelDefault)}`；`parseModelRef` 要求 `providerId/modelId`（含 `/`），而 squad.modelDefault 是纯 modelId（无 `/`）→ 返回 `null` → `hasDefault=false` → 显「未配置」。**修法：前端 picker 对纯 modelId 反查 provider（同 playground 内部 `findProviderIdByModelId`），无需后端改动，不影响 AT。**
4. **② member.skills 现状**：schema `skills: json`（string[] 白名单）；`session-config.ts` D4 `catalog.entries.filter(e => e.enabled && member.skills.includes(e.name))`。建队 seed 真实 builtin skill（leader=`['okf-skill','teamwork-leader']` / mate=`['okf-skill','teamwork-mate']`）；但前端 `SKILL_OPTIONS=['planning','testing','research','coding']` 是死占位——用户经 member 面板 MultiCheck 保存即把 member.skills 覆盖为占位子集 → D4 交集恒空 → 该成员失去全部 skill。
5. **catalog 三层**：`SkillEntry.scope = 'builtin' | 'app' | 'workspace'`（`skills/resolver.ts` v0.0.33.3 加 builtin 层）。overlay 设计据此分层。
6. **spec↔code 不一致（本版本修正）**：(a) `session-config.ts:133-134` 注释 `skills=catalog ∩ member.skills（D4）` + `modelId 回退链 ... ?? app_config 默认（D5）` 均 stale（D4 本版本废弃；D5 早在 v0.0.89 被 resolveModel 取代、studio 不读 app_config）。(b) `[P1]session_config_studio.md §3` skills 行（D4 黑白名单）+ modelId 行（D5 含 app_config）同 stale。两处对齐到代码实际。

## 打包护栏自评（MANDATORY，逐条）

| 类 | 触发？ | 理由 |
|----|--------|------|
| 1 依赖归属 | **否** | 本版本无新增第三方 npm 依赖（overlay resolve 复用既有 SkillResolver/AppConfigService；前端反查复用现有 providers hook）。 |
| 2 plugin 进 asar | **否** | 无新增 builtin plugin / ext impl；skill overlay 是 `handlers/session-config.ts` 内纯逻辑改，不涉 plugin 编译/资源拷贝。 |
| 3 runtime-config env 键 | **否** | 无新增必需运行时 env 键。 |
| 4 路径/环境展开 | **否** | 无新增「读文件系统的后端启动入口」；skill 目录路径复用既有 `builtinSkillRoot()`/`appSkillRoot(dataDir)`（已展开）。 |

**结论**：本版本纯逻辑改（后端 skill overlay resolve）+ 前端，**不触发任一打包护栏类**。dev 的 AT/ET 足以覆盖；无需 packaged 版专项验证。

---

## 变更清单（行 = 一个函数/符号）

<!-- 按 ①②③④ 分组；同模块/同文件相邻 -->

### ① Skill 管理页可滚动（bug 修，纯前端 CSS）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| skill-ui | app/web/src/components/skill-page/page-skill.tsx | `PageSkill`（render 根 `<main>` + body 区） | 修改 | 修 flex/overflow：让内容超视口时纵向可滚到底（body flex 子加 `min-h-0` 或重构为单一 scroll 容器）。根因=`<main>` 同为 `flex-1 overflow-y-auto flex flex-col` 且 body `flex-1` 无 `min-height:0`，flex 撑高吃掉滚动。具体 CSS 由 coder 定位 | MUST 保 header `border-b border-border` + body `max-width:880px` 左对齐 + 现有视觉基线；MUST NOT 引入 sticky header；MUST NOT 改数据/testid | `specs/ui/components/skill-page/page-skill.md §视觉基线`；PRD §2.1 | +3/-2 |

### ② 成员 skills overlay 重构 — 后端（O-1 数据模型 + O-2 resolve）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad-schema | app/server/src/agent/schema_defs/squad/member.ts | `MemberSchema.fields.skillConfig` | 修改 | **删** `skills: {type:'json'}`（string[] 白名单），**加** `skillConfig: {type:'json', required:true}`，形态 `{ mode:'inherit'\|'custom', overrides: Record<string,boolean> }`。`MemberRecord`（InferRecord）自动派生新形态，无需单独改类型 | MUST 不兼容旧数据、直接推翻（用户拍板，无迁移）；MUST 注释写清 mode/overrides 语义；MUST NOT 保留 `skills` 字段 | PRD §2.2 + `2-member-skills-mechanism.md §3`；O-1；`[P1]data_model.md §1.2` | +10/-2 |
| squad-service(member) | app/server/src/services/member-service.ts | `MATE_DEFAULT_SKILLS` | 删除 | 删死常量（overlay 下新成员默认 inherit，不再 seed 角色 skill 白名单） | MUST 一并删所有引用 | `2-member-skills-mechanism.md §7.3`；R6 | -3 |
| squad-service(member) | app/server/src/services/member-service.ts | `resolveEffective`（fresh/derive eff 构造，line 81）+ `CreateMemberInput` | 修改 | `CreateMemberInput.skills?: string[]` → `skillConfig?: MemberSkillConfig`；`resolveEffective` 返回结构 `skills` → `skillConfig`；fresh/derive seed 由 `skills: input.skills ?? MATE_DEFAULT_SKILLS` 改为 `skillConfig: input.skillConfig ?? { mode:'inherit', overrides:{} }`（默认 off/继承；derive 不复制父 skills） | MUST 默认 `mode:'inherit', overrides:{}`（PRD 默认新成员=off）；MUST NOT 再 seed 角色 builtin 白名单；MUST 同步改 `createMemberService`（line 142）落 skillConfig | `2-member-skills-mechanism.md §2.1/R6`；`[P1]data_model.md §5` | +9/-9 |
| squad-service | app/server/src/services/squad-service.ts | `createSquadService`（leader member seed，~line 216） | 修改 | leader 成员 seed 从 `skills:['okf-skill','teamwork-leader']` 改为 `skillConfig:{ mode:'inherit', overrides:{} }` | MUST leader 默认 inherit；overlay 下 leader 仍继承全局 enabled 的 builtin（含 teamwork-leader） | `2-member-skills-mechanism.md §2.1`；本文实测#4 | +2/-2 |
| member-handler | app/server/src/handlers/member.ts | `HireBody` / `PatchMemberBody`（类型） | 修改 | 两处 `skills?: string[]` → `skillConfig?: MemberSkillConfig`（形态同 schema）；hire fresh/derive.overrides 同改 | MUST 与 schema/前端 skillConfig 形态一致 | `specs/api/overall/11a-squad-endpoints.md §2.1/§2.2` | +4/-4 |
| member-handler | app/server/src/handlers/member.ts | `handleHire` | 修改 | 组装 `CreateMemberInput` 时 `skills` → `skillConfig`（fresh body.skillConfig / derive overrides.skillConfig）；无 skillConfig → service 走默认 inherit | MUST 缺省不报错（走默认 inherit）；MUST NOT 校验 skillConfig 命中 catalog（overlay 容忍未知 name） | `11a §2.1` | +4/-4 |
| member-handler | app/server/src/handlers/member.ts | `handlePatchMember` | 修改 | `body.skills` → `body.skillConfig`：非 undefined 时 `patch.skillConfig = body.skillConfig`（整体替换快照，含 mode 切换 + overrides） | MUST 整体替换（off 存 → overrides 应为 `{}`，前端保证；后端不合并旧快照）；MUST NOT 保留旧 `skills` 分支 | `11a §2.2`；`2-member-skills-mechanism.md R6` | +2/-2 |
| session-config | app/server/src/handlers/session-config.ts | `buildSessionConfigFromDeps`（studio skills overlay 块，现 line 202-213） | 修改 | **O-2 核心**：删 D4 交集，改 overlay resolve。studio 分支 skills = `catalog.entries.filter(e => keep(e))`，`keep`：① `e.scope==='workspace'` → `true`（R2 恒生效）；② builtin/app 层：`mode==='custom'` → `overrides[e.name] !== undefined ? overrides[e.name] : e.enabled`（R3 未记录跟全局）；`mode==='inherit'` → `e.enabled`。非 studio 分支不变（`filter(e => e.enabled)`） | MUST 读 `studioContext.member.skillConfig`（不再 `.skills`）；MUST workspace 层无条件保留（R2）；MUST NOT 绕过 SkillResolver.resolve 已产 catalog 另扫盘；MUST 同步删/改 line 133-134 stale 注释（D4→overlay、D5→resolveModel 真相） | `2-member-skills-mechanism.md §3 R1-R6`；O-2；`[P1]session_config_studio.md §3`；本文实测#1/#6 | +16/-8 |

### ② 成员 skills overlay 重构 — 前端（O-3 筛选器 + O-6 面板）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| studio-types | app/web/src/components/studio-page/squad-types.ts | `Member` / `PatchMemberBody` / `HireBody` / `MemberSkillConfig`（新类型） | 修改 | 加 `interface MemberSkillConfig { mode:'inherit'\|'custom'; overrides: Record<string,boolean> }`；`Member.skills:string[]` → `skillConfig:MemberSkillConfig`；`PatchMemberBody.skills?` → `skillConfig?`；`HireBody` fresh/derive `skills?` → `skillConfig?` | MUST 与后端 schema 形态一致 | `specs/ui/components/studio-page/member-panel.md`；`11a §1.3/§2` | +6/-4 |
| studio-types | app/web/src/components/studio-page/squad-types.ts | `SKILL_OPTIONS` | 删除 | 删死占位常量（planning/testing/research/coding） | MUST 删全部引用（hire-modal + member-panel） | PRD §2.2 约束 | -1 |
| member-skill-filter | app/web/src/components/studio-page/component-member-skill-filter.tsx | `ComponentMemberSkillFilter`（组件） | 新增 | **O-3 简化版 skill 筛选器**：`listSkills()` 拉全局 catalog → 排除 `scope==='workspace'`（恒生效不展示）→ 每行 name+desc(省略)+`ToggleSwitch`；顶部搜索框按 name 过滤；每行显示态 = `overrides[name]!==undefined ? overrides[name] : entry.enabled`（叠加，R4）；toggle 上抛父级更新 overrides。**只做 enable/disable + 搜索**，无详情/drop-zone/删除/编辑 | MUST 复用 `framework/primitives/toggle-switch`；MUST 展示叠加后当前态（R4）；MUST NOT 含 preview/install/delete；testid 见 member-panel.md（`member-skill-filter*`）；单文件 ≤300 行 | O-3；`2-member-skills-mechanism.md §4`；`component-skill-item.tsx`（参考简化） | +120 |
| member-panel | app/web/src/components/studio-page/section-member-panel.tsx | `MemberPanel` | 修改 | **②③ 合并改**：(②) skills section 重构——标题「技能与模型」→「skills」；删 model 模块（`ModelPicker`+`member-model-input`）；`MultiCheck`(SKILL_OPTIONS) 换为 `member-skills-mode-switch`（inherit/custom）+ off 收起/on 展开 `ComponentMemberSkillFilter`；section testid `member-section-tools`→`member-section-skills`。编辑态 `skills:string[]` → `skillConfig`；`dirty`/`save`/`base` 改比 skillConfig；save：custom 时 overrides=补齐全量筛选器当前态（R5）、inherit 时 overrides=`{}`（R6）。(③) 删 `member-section-memory` Card + `MemberPanelMemory` 挂载 + memory testid。切换 off↔on 不得位移其他 section | MUST switch 切换用高度动画/预留、禁 `display:none` 致相邻位移（R4 布局稳定）；MUST save 走 PATCH `{skillConfig}`；MUST NOT 动 profile/tasks/heartbeat section；MUST 删 `member-model-input`/`member-skills-editor`/`member-section-memory`/`member-memory-*` testid | O-6；PRD §2.2/§2.3；`2-member-skills-mechanism.md §3/§4`；`member-panel.md` | +70/-55 |
| member-memory | app/web/src/components/studio-page/component-member-panel-memory.tsx | `MemberPanelMemory`（整文件） | 删除 | **③** 删记忆子组件（member 面板唯一使用者已在 MemberPanel 移除；会话界面记忆入口不动） | MUST 确认无其他引用后删（实测仅 section-member-panel 用）；MUST NOT 动后端 session_memory | PRD §2.3；本文实测（MemberPanelMemory 仅 member 面板用） | -文件 |
| hire-modal | app/web/src/components/studio-page/component-hire-modal.tsx | `HireModal`（fresh skills 块） | 修改 | 删 `SKILL_OPTIONS` + `MultiCheck`(`hire-fresh-skills`) skills 选择；hire 不再传 skills（新成员默认 inherit，后端 seed）。移除 `skills` state | MUST 新成员建后默认 `skillConfig:{mode:'inherit'}`（后端 seed）；MUST NOT 传旧 skills 白名单 | PRD §2.2；`2-member-skills-mechanism.md §2.1` | +2/-8 |

### ④ studio 模型 hover 展示实际生效默认（O-5，纯前端）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| model-picker | app/web/src/components/chat-page/component-input-model-picker.tsx | `InputModelPicker` | 修改 | 加 prop `defaultModelId?: string`（原始 ModelRef=纯 modelId，studio 传 squad.modelDefault）。当 `defaultModelId` 非 undefined：对其调 `findProviderIdByModelId(providers, defaultModelId)` 反查 → `{providerId, modelId}` 作 effectiveDefault；保留字/空/反查不中 → null（真未配显「未配置」）。self-fetch effect 守卫加 `\|\| defaultModelId !== undefined`（studio 不走 playground 自拉）。优先级：`defaultModelId` > `defaultModel` > 内部自拉 | MUST 反查用现有 `findProviderIdByModelId`（勿引 parseModelRef，纯 modelId 无 `/`）；MUST 反查不中 → null → 「未配置」（PRD 真无可用才显）；MUST NOT 改后端/API | O-5；`specs/ui/components/chat-page/component-input-model-picker.md`；本文实测#3 | +14/-2 |
| member-chat | app/web/src/components/studio-page/section-member-chat.tsx | `MemberChatPageLoaded`（InputModelPicker 挂载，line 256-258） | 修改 | `defaultModel={squadDefaultSel}` → `defaultModelId={squadModelDefault}`（原始纯 modelId 字符串）；删 `squadDefaultSel = parseModelRef(squadModelDefault)` 派生（line 120） | MUST 传原始 `squadModelDefault` 字符串（非 parseModelRef 结果）；MUST 不动 `model` prop（member.model 态） | O-5；本文实测#3 | +1/-2 |
| squad-chat | app/web/src/components/studio-page/section-squad-chat.tsx | `SquadChatPageLoaded`（InputModelPicker 挂载，line 232-234） | 修改 | `defaultModel={parseModelRef(squadModelDefault)}` → `defaultModelId={squadModelDefault}` | MUST 传原始 `squadModelDefault` 字符串 | O-5；本文实测#3 | +1/-1 |

---

## 影响面评估

- **跨模块**：后端 squad 子系统（member schema/service/handler + session-config studio resolve）；前端 studio-page（member-panel + 新 filter + hire-modal + 2 chat section）+ chat-page（model-picker）+ skill-page（滚动）。①③④ 纯前端；② 前后端。
- **破坏性变更**：② member schema `skills`→`skillConfig`（用户拍板不兼容旧数据，直接推翻；旧 member.json 的 `skills` 字段读不到 `skillConfig` → 走 schema 默认/前端兜底 inherit）。**API 契约变更**：`GET /squad/:id`（Member.skills→skillConfig）、`POST /squad/:id/member`（HireBody）、`PATCH /squad/:id/member/:mid`（PatchMemberBody）→ **影响 AT**（member/squad API case 需更新断言）。④ **无 API 变更、不影响 AT**（纯前端反查）。
- **依赖顺序**：后端 schema（member.ts skillConfig）先于 service/handler/session-config；前端 squad-types（MemberSkillConfig）先于 member-panel/filter/hire-modal；model-picker prop 先于 2 chat section。
- **风险点**：(1) overlay resolve 的 builtin 层归属——本版本决策 **builtin 与 app 层同受 overlay 治理**（off=全局 enabled 全给、含 teamwork-leader/mate）；角色区分改由 `squad_role` system-prompt mapper + tool-policy 保证，**不再靠 member skill 白名单**（是有意行为变更，见 tech spec）。(2) R5 保存补齐——custom 存盘时 overrides 需快照全量筛选器当前态（前端职责）。(3) ① 滚动 CSS 需 ET 覆盖「底部卡片可见可点」。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
