# v0.0.279 变更计划书 — squad 团队默认推理强度（effortDefault）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（如 context_engine / llm / agent-loop / ui-chat） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 变更清单

<!-- 每行一个函数/符号；相关方法的行放在一起（同模块/同文件相邻） -->

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad-schema | app/server/src/agent/schema_defs/squad/squad.ts | SquadSchema.fields.effortDefault | 新增 | 加 `effortDefault: { type: 'string', required: false }`（存 `'default'\|'low'\|'high'\|'max'`，对齐 modelDefault 模式放其下方） | MUST required:false（存量 squad 无字段=default 兼容）；MUST NOT 建队必填（POST 不带） | PRD D2；specs/api/overall/11a-squad-endpoints.md §1.3/§1.4 | +4 |
| squad-api | app/server/src/handlers/squad.ts | PatchSquadBody.effortDefault | 新增 | interface 加 `effortDefault?: 'default'\|'low'\|'high'\|'max'`（undefined=不修改） | MUST undefined 语义=不修改（对齐 modelDefaultProviderId L107 模式） | PRD D2；11a §1.4 | +1 |
| squad-api | app/server/src/handlers/squad.ts | isValidEffortDefault() | 新增 | 校验 helper：`v === 'default' \|\| v === 'low' \|\| v === 'high' \|\| v === 'max'` | MUST 非法值 400（字段级，先于 404，对齐 timezone/heartbeatConfig 校验位置） | PRD D2；11a §1.4 | +5 |
| squad-api | app/server/src/handlers/squad.ts | handlePatchSquad() | 修改 | 加字段级校验（`body.effortDefault !== undefined && !isValidEffortDefault(...)` → 400）+ 落盘 `if (body.effortDefault !== undefined) patch.effortDefault = body.effortDefault` | MUST !== undefined 才 patch；MUST 显式 'default' 也落盘（不清空，与 enableGroupChat 模式对称） | PRD D2；11a §1.4 | +3 |
| squad-api | app/server/src/handlers/squad.ts | toDetail() | 修改 | SquadDetail 回显 `effortDefault: (s.effortDefault as 'default'\|'low'\|'high'\|'max' \| undefined) ?? 'default'` | MUST 存量无字段兜底 'default'（对齐 enableGroupChat ?? true 模式 L258） | PRD D2；11a §1.3 | +1 |
| session-config | app/server/src/handlers/session-config.ts | resolveEffort() | 新增 | 纯函数覆盖链：`sessionEffort ∈ {low,high,max}` → 用之；否则 `squadEffortDefault ∈ {low,high,max}` → 用之；否则 `undefined`（厂商默认）；返回 `'low'\|'high'\|'max' \| undefined` | MUST NOT 读 app_config / member 级 effort；MUST 成员 'default' 与 undefined 同语义（读团队） | PRD D1；llm_protocol_interface §3.8 | +8 |
| session-config | app/server/src/handlers/session-config.ts | buildSessionConfigFromDeps() | 修改 | 与 resolveModel 同区（L210-222 附近）算 `const resolvedEffort = resolveEffort(sessionPersist.effort, isStudio && studioContext?.squad !== undefined ? studioContext.squad.effortDefault : undefined)`；L323-324 注入点改 `...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {})` | MUST encode 层零改动（config.effort 已是 low/high/max/undefined）；MUST 每次 run 现拉无 cache（团队改设置下一次 run 立即生效）；MUST NOT 改 resolveModel 调用 | PRD D1/D3；llm_protocol_interface §3.8 | +3/-2 |
| ui-studio | app/web/src/components/studio-page/squad-types.ts | SquadDetail.effortDefault | 新增 | `effortDefault: 'default'\|'low'\|'high'\|'max'`（后端回显 ?? 'default' → 恒有值，UI 下拉初始态可直用） | MUST 与后端回显语义一致（非 optional） | 11a §1.3 | +2 |
| ui-studio | app/web/src/components/studio-page/squad-types.ts | PatchSquadBody.effortDefault | 新增 | `effortDefault?: 'default'\|'low'\|'high'\|'max'`（undefined=不修改） | MUST undefined=不修改（与后端 PATCH 语义一致） | 11a §1.4 | +1 |
| ui-studio | app/web/src/components/studio-page/component-manage-tab.tsx | ManageTab() | 修改 | ModelPicker 块（L79-88）下方加 effortDefault 下拉：state `useState<EffortLevel>(detail.effortDefault)`（detail 恒有值）；dirty 加 `effortDefault !== detail.effortDefault`；save patch 带 `effortDefault` | MUST 复用 `EffortLevel`/`EFFORT_LEVELS`（component-input-effort-picker.tsx L26/L29 导出）；MUST NOT 改成员级 picker 行为/文件；MUST NOT 引入新 i18n namespace（用 studio:manageTab） | PRD D4；specs/ui/overall/06-studio.md §3.2 | +18 |
| ui-studio | app/web/src/i18n/locales/en/studio.json + zh-CN/studio.json | manageTab.effortDefaultLabel + 4 档文案 | 新增 | manageTab 下加 `effortDefaultLabel`（如 "Default reasoning effort"）+ `effortOptions` 4 档（default/low/high/max） | MUST en/zh 双语言齐（对齐 manageTab 现有 keys L128-133） | PRD D4 | +5 |
| test | app/server/src/handlers/__tests__/session-config-studio.test.ts | describe('resolveEffort 覆盖链') | 新增 | 4 分支 UT：①成员显式 low/high/max → 用之 ②成员 default + 团队 low/high/max → 团队 ③成员 default + 团队 default/undefined → undefined ④非 studio（无 squad）→ 只 session 一层 | MUST 断言真实 resolveEffort 行为（不复制逻辑）；断言 config.effort 注入结果 | PRD D1 | +30 |
| test | app/server/src/handlers/__tests__/squad-handler.test.ts | PATCH effortDefault cases | 新增 | ①合法值落盘 + 回显 ②非法值（如 'ultra'）→ 400 ③显式 'default' 落盘（不清空）④存量无字段 GET 回显 'default' | MUST 走真实 PATCH/GET 路径断言 | PRD D2 | +25 |
| test | app/web/src/components/studio-page/__tests__/component-manage-tab.test.tsx | ManageTab effortDefault cases | 新增 | ①下拉渲染 4 档 + 初始值=detail.effortDefault ②选档后 save patch 含 effortDefault ③dirty 判定（改档可 save / 改回 detail 值不可 save） | MUST 断言渲染 + 交互（新增测试文件，现有 manage-tab 无测试） | PRD D4 | +40 |

## 影响面评估

- **跨模块**：squad-schema（存储）→ squad-api（PATCH/回显）→ session-config（resolve 注入）→ ui-studio（ManageTab 下拉 + i18n）+ 3 测试文件。依赖顺序：schema → handler；前端依赖 API 契约（可并行开发）。
- **无破坏性变更**：全部新 optional 字段；存量 squad record 无 effortDefault → 读取 ?? 'default'（兼容）。
- **零改动声明**（D3 边界，reviewer 查偏离标尺）：
  - `encodeAnthropicMessages`（llm_protocol）**零改动**——resolve 完 config.effort 已是 low/high/max/undefined，encode guard 原样生效
  - `model-resolver.ts` **零改动**——effort 不参与 model resolve 链
  - `component-input-effort-picker.tsx`（成员级 picker）**零改动**——仅复用其 EffortLevel/EFFORT_LEVELS 导出
  - `createSquadService` / CreateSquadBody **零改动**——POST 建队不带 effortDefault，新 squad 无字段=default
  - playground/academy/standalone 分支**零改动**——无 squad 只 session 一层
  - subagent **零改动**——继承父 resolve 结果，不重复 resolve
- **风险点**：`studioContext.squad` 类型为 SquadRecord（InferRecord），effortDefault 派生为 `string | undefined`——resolveEffort 内需窄化（schema 语义 + PATCH 校验保证合法值，cast 到联合可接受）；前端 EffortLevel 从 chat-page 组件 import 到 studio-page（跨组件目录 import 类型，已有 export 无循环依赖）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
