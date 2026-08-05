# v0.0.230 变更计划书 — model picker 显示与默认模型逻辑统一

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名 |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT |
| 参考 | 依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 背景与决策（PRD 用户确认 + architect 读码核实）

**核心原则（用户澄清）**：每个 session 的 model picker 有两层——「使用默认模型」置顶项 + 全量枚举；「默认模型」来源按场景：playground→`default_models.chat`、academy classroom→`classroom.defaultModel`、studio→`squad.modelDefault`。**群体级默认模型必须选具体模型，无上一级继承、无应用层默认概念**（app 默认是 playground 个体级逻辑，误用到群体级是错）。

- **块1（显示不一致）**：`component-key-model-picker.tsx:97` trigger 显纯 `currentItem.modelId`（无 provider 前缀）；`ModelPicker`/`InputModelPicker` 用 `formatModelDisplay`（`provider / model`）。修法 = triggerValue 拼 `${providerLabel} / ${modelLabel}`（currentItem 已含两字段，与 `formatModelDisplay`（lib/providers.ts:176）口径一致）。
- **块2（逻辑错误）**：教室 head defaultModelSlot 用 ModelPicker + `inheritLabel`「跟随应用默认」——群体级继承选项错误。修法 = 去 inheritLabel/onInherit（对齐 squad manageTab 无继承形态）。
- **块2（运行时收窄，用户确认）**：academy 运行时链现三档 `session → classroom.defaultModel → app_config.default_models.chat`（model-resolver.ts:233-236），第三档即「个体级默认误用群体级」。收窄为 `session → classroom.defaultModel → throw MODEL_NOT_CONFIGURED`（对齐 squad 两档）。创建教室无 defaultModel → head session 解析必 400 `model_not_configured`，天然实现「创建即必填」（用户确认）；存量未配教室 head 显「选择 model」占位 + 运行时明确报错引导，不强制回填。
- **前置符号核对**（architect 已 grep/读码确认存在）：`formatModelDisplay`（lib/providers.ts:176）、`ModelPicker` props（value/onChange/inheritLabel/onInherit/actionKey，chat/ModelPicker.tsx:29-45）、`classroom.defaultModel`（复合 `{providerId?, modelId}`，schema_defs/classroom.ts:62）、`ModelNotConfiguredError.code='MODEL_NOT_CONFIGURED'` + `detail.sessionType` 含 `'academy'`（model-resolver.ts:90-101）、`buildFallbackChain` academy 分支（model-resolver.ts:225-237）。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-web | app/web/src/components/common/component-key-model-picker.tsx | `KeyModelPicker.triggerValue`（:91-105，`modelLabel` 在 :97） | 修改 | `modelLabel: currentItem.modelId` 改 `${currentItem.providerLabel} / ${currentItem.modelLabel}`（trigger 显 provider 前缀）；降级路径（currentItem=null，providers 未加载/被删）不变——`providerId:''` + `modelLabel: value`（无 IconBox） | MUST 拼法 = `${providerLabel} / ${modelLabel}`（providerLabel=p.label\|\|p.id、modelLabel=m.label\|\|m.modelId，与 lib/providers.ts `formatModelDisplay` 返回一致）；MUST NOT 改 `onChange` 落盘值（仍纯 modelId，`default_models.chat` 契约不变）；MUST NOT 动 panel/x 清除/搜索/选择语义；布局稳定（ModelPickerTrigger 已有 `whitespace-nowrap overflow-hidden text-ellipsis` truncate） | PRD §2.1；specs/ui/components/common/component-key-model-picker.md §视觉基线；component-model-picker-trigger.md value.modelLabel 注释 | +1 / -1 |
| ui-web | app/web/src/components/common/__tests__/component-key-model-picker.test.tsx | `已配（value 非空）显 modelId` 用例（:56-60） | 修改 | 重标注为「降级路径（providers 未加载/被删 → 纯 modelId）」+ 更新注释；新增用例：`listProviders` mock 一个 enabled provider 且 value 命中其 model → 断言 trigger button name 含 `${providerLabel} / ${modelLabel}` | MUST 断言走 getByRole button name（trigger 文本 = value.modelLabel）；MUST 保既有断言在降级路径下仍绿（beforeEach mock [] → currentItem=null） | PRD §2.1 P-A；本表第 1 行 | +16 / -1 |
| ui-spec | specs/ui/components/common/component-key-model-picker.md | §视觉基线「已配 → mono modelId」 | 修改 | 改「已配 → IconBox + mono `${providerLabel} / ${modelLabel}`」；降级行「无 IconBox 仍显 modelId」保留 | MUST 对齐 ModelPickerTrigger value.modelLabel 注释口径（`${providerLabel} / ${modelLabel}`） | PRD §4 已知差异；coder 编码前置产出（先 spec 后实现） | +1 / -1 |
| ui-academy | app/web/src/components/academy-page/section-classroom-detail.tsx | `SectionClassroomDetail`（defaultModelSlot :158-165 + `handleDefaultModelInherit` :127-132） | 修改 | ModelPicker 去 `inheritLabel={t('classroom.defaultModelInherit')}` + `onInherit={handleDefaultModelInherit}`（下拉不再有「跟随应用默认」项）；删 `handleDefaultModelInherit` 函数 | MUST 对齐 studio squad manageTab 形态（ModelPicker 无 inherit 选项，component-manage-tab.tsx:87-91）；MUST 保留 `defaultModelSel` 组装 + `handleDefaultModelChange`（PATCH classroom.defaultModel 语义不变）；未配 → ModelPicker 显既有 placeholder「选择 model」 | PRD §2.2 UC-230-4/5；specs/ui/components/academy-page/section-classroom-detail.md（本版补 slot 契约） | +0 / -11 |
| ui-academy | app/web/src/components/academy-page/section-classroom-list.tsx | `SectionClassroomList`（create 表单 :68-83 + `submitCreate` :35-47） | 修改 | 创建表单（name input 下方）加「默认模型」必选 ModelPicker（value/onChange 本地 state）；`submitCreate` 校验 defaultModelSel 非 null 否则不调 `onCreateClassroom`（错误提示「请选择默认模型」）；`onCreateClassroom` prop 签名 `(name: string)` → `(name: string, defaultModel: ModelSelection)` | MUST 必填校验拦截在表单层（未选模型不调父级回调）；MUST 复用 chat/ModelPicker.tsx（无 inherit）；MUST NOT 新建 modal/改 220px sidebar 布局宽度 | PRD §2.2 UC-230-8；squad wizard modelDefault required 语义 | +26 / -3 |
| ui-academy | app/web/src/components/academy-page/page-academy.tsx | `PageAcademy.handleCreateClassroom`（:87-91） | 修改 | 签名 `(name)` → `(name, defaultModel)`；body 改 `createClassroom({ name, defaultModel })`（defaultModel=ModelSelection 复合 `{providerId, modelId}`） | MUST 透传复合 `{providerId, modelId}`（lib/academy-api.ts:createClassroom 已收 body.defaultModel :66）；MUST NOT 改端点契约/事务逻辑 | PRD §2.2；lib/academy-api.ts:66-70 | +2 / -1 |
| i18n | app/web/src/i18n/locales/zh-CN/academy.json + en/academy.json | `classroom.defaultModelInherit`（:67） | 删除 | 删「跟随应用默认」/「Follow app default」key（去继承后死 key） | MUST 两语言文件同步删（无残留死 key） | 本表第 4 行 | -1 ×2 |
| ui-spec | specs/ui/components/academy-page/section-classroom-detail.md | §状态/交互（head 默认模型 slot） | 修改 | 补 head defaultModel slot 契约：无继承选项、必须选具体模型（ModelPicker 无 inheritLabel）、未配显「选择 model」占位（对齐 manageTab）；slot 渲染位在 component-classroom-head 不变 | MUST NOT 推翻既有结构 | PRD §4 已知差异；coder 编码前置产出 | +6 / -0 |
| server-model-resolver | app/server/src/services/model-resolver.ts | `buildFallbackChain`（academy 分支 :225-237） | 修改 | 删 academy 第三档 `readPlaygroundDefault` push（:233-236）→ 链收窄为 `session → classroom.defaultModel → throw`（跑空由 `resolveModel` 抛 `ModelNotConfiguredError`） | MUST NOT 让 academy 下探 `app_config.default_models.chat`（无应用层默认概念，用户确认）；MUST NOT 影响 playground/studio 链；MUST 保留 session 档（session 显式具体模型优先） | PRD §2.2/§6；specs/tech/agent/providers_and_models/[P0]model_resolve.md §3（本版同步收窄） | +0 / -4 |
| server-model-resolver | app/server/src/services/model-resolver.ts | `resolveModel`（throw site :267） | 修改 | 抛 `ModelNotConfiguredError` 按 sessionType 给引导文案：academy → 「教室未配置默认模型，请先在教室设置中选择一个具体模型」；playground/studio 保持默认「请配置模型后再发起会话」 | MUST 仅改 message 参数（`code='MODEL_NOT_CONFIGURED'` / `detail.sessionType` / HTTP 400 不变）；MUST NOT 改 ModelNotConfiguredError 类结构 | PRD §2.2 UC-230-6；model_resolve.md §6 | +2 / -1 |
| server-academy | app/server/src/handlers/academy-classroom.ts | `handleCreateClassroom`（error detail :152-154） | 修改 | 400 `model_not_configured` detail 文案去「在应用设置配置默认模型」路径，改「请为教室选择默认模型（创建时必选，在表单中选具体 provider/model）」 | MUST 不改错误码/HTTP 状态/创建事务逻辑；MUST 与 buildFallbackChain 收窄语义一致（教室无 app 默认兜底） | PRD §2.2；本表第 9 行 | +1 / -1 |
| server-academy | app/server/src/academy/academy-session-model.ts | `resolveAcademySessionModel`（docstring :13-17/:41-47） | 修改 | 注释同步：fallback 链去「c) app_config.default_models.chat（app 默认兜底）」第三档（纯注释；函数只薄委托 resolveModel，逻辑不变） | MUST NOT 改签名/逻辑 | 本表第 9 行；model_resolve.md §3 | +1 / -3 |
| tests | app/web/src/components/academy-page/__tests__/section-classroom-detail.test.tsx | 新增测试文件 | 新增 | jsdom 渲染 `SectionClassroomDetail`（`vi.mock` SectionChatSession 等重依赖，注入 classroom.defaultModel=undefined），断言默认模型 picker 无「跟随应用默认」项、trigger 显「选择 model」占位；配 defaultModel 时 trigger 显 `provider / model` | MUST 走 role/text 断言（jsdom 无布局）；MUST NOT Read 截图；重依赖 mock 面由 coder 定位（最小 stub） | PRD P-B（无 inherit 渲染断言） | +42 / -0 |
| tests | app/web/src/components/academy-page/__tests__/section-classroom-list.test.tsx | 新增测试文件 | 新增 | jsdom 渲染 `SectionClassroomList`：填 name 未选模型 → submit 不调 `onCreateClassroom`（断言必填错误提示出现）；选模型后 → 调 `onCreateClassroom(name, sel)` | MUST 断言 prop 回调不/被调用；MUST 复用 ModelPicker 真实渲染（providers 用 lib/providers.ts `__setProvidersCacheForTest` 注入桩） | PRD P-B（创建必填校验断言） | +46 / -0 |

## 影响面评估

- **范围**：`app/web/` 4 个产品文件（component-key-model-picker / section-classroom-detail / section-classroom-list / page-academy）+ 2 个测试文件（改 1 新 2）+ 2 个 i18n 文件；`app/server/` 2 个服务文件（model-resolver / academy-session-model 注释）+ 1 个 handler（academy-classroom 文案）；2 个组件 spec 增量。
- **破坏性**：无。块1 是触发展示文本变化（布局 truncate 已有）；块2 head 去继承选项（下拉项减少）；创建必填是新增校验（后端已天然 400 兜底）；resolver 收窄只影响「教室未配 defaultModel 时的缺省解析」——此前落到 app 默认（错误语义），此后明确报错引导（正确语义）。playground/studio 链完全不动。
- **数据契约不变量**：`default_models.chat`（纯 modelId）、`classroom.defaultModel`（复合 `{providerId?, modelId}`）、`/config/app` 与 `/academy/classroom` 端点 schema 全不变。
- **依赖顺序**：无跨层依赖；server（第 9-12 行）与 web（第 1-8、13-14 行）可并行（独立文件集）。
- **风险点**：① 块2 创建必填后，`createClassroom({ name })` 旧调用（若测试/其他入口）会 400——需 grep 确认无其他调用点；② `section-classroom-detail` 渲染测试较重，mock 面要控制（重依赖 SectionChatSession 必须 stub）；③ academy 收窄后建学生（`createStudentWithInitialVersion`）与建任务（`createTrainingTaskAndCoach`）在教室未配 defaultModel 时同样 throw `model_not_configured`——行为符合「群体级必须选具体模型」，属于预期收紧，验证时留意。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
