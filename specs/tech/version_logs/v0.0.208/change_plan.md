# v0.0.208 变更计划书 — 删除 academy 板块（功能/配置/数据 + specs/插件/测试 + 3 环境数据）

> **method 级删除合同**。架构期冻结：coder 按本表删除，code-reviewer 按本表查偏离。coder 对实现细节有最终决策权；偏离本表须向 orchestrator 汇报。事后偏差写进 `change_log.md`。
>
> 本表是**删除**合同：「变更内容」= 该处删什么 / 引用怎么清（不是新增描述）。落每行前已 grep/读代码核对引用符号真实存在（含 enum 闭合性、store API 真名）。

## 删除总策略

academy = nav-rail 业务区第 3 项（Playground/Studio/Academy），跨 v0.0.183/184/187/203 建成。删 = ① 摘 23 个注册点 ② 删 academy 专属目录/文件 ③ 清共享文件里的 academy 钩子 ④ 删 specs/插件/测试 ⑤ 外科清 3 环境 academy 数据。**共享基建（scope 激活/session-type registry/mention 接口/nav-rail/view-store）只摘 academy 注册，不动抽象本身**。

## 执行顺序（用户裁决：数据先行 → 再删代码）

> **用户裁决（2026-07-28）：先删 3 环境数据，再删代码。** 技术上也更稳——数据清理在 academy enum 仍在 biz 枚举内时执行，`listSessions({biz:'academy'})` + `deleteSession` 走完整 schema 校验链路（无 legacy biz 数据校验失败隐患）；数据清干净后删代码零数据交互风险。

### Phase 0 — 数据清理先行（Section H，coder 写脚本 → 3 环境 dry-run → 用户确认 → 实跑）
0. **写 `scripts/cleanup-academy-data.ts`**（Section H）：复用 SessionStore.deleteSession 级联 + `rm -rf {dataDir}/academy/` + 删 app_config `sub_agent_templates/knowledge_learning_trainer` record；dry-run 必选、idempotent、接 DATA_DIR 参数
1. **3 环境 dry-run**（dev/test/prod）：输出 academy session 数 + academy 文件数 + 配置项 → **用户确认** → 实跑（此时 academy enum 仍在，校验链完整）→ 二次 dry-run 应返 0

### Phase 1 — 删代码（每步 `bun run typecheck` 卡点，绿后再下一步；卡点 = 后端 enum 闭合性 + import 断链）
2. **前端注册摘除**（Section B）：nav-rail/view-store/app-shell/chat-slice/i18n 摘完 → typecheck 前端通过 → 可删 academy-page/ + lib/academy-*
3. **后端注册摘除**（Section C）：schema enum 值（biz/role）+ 字段 + tools/registry + bootstrap + mention + SSE topic + handlers/session biz + migration index + model-resolver + router 全摘 → typecheck 后端通过（关键：`'academy'` `'coach'` `'student'` `'trainer'` enum 值删后所有引用必须已清）
4. **academy 专属目录/文件整删**（Section D）：前端 academy-page/ + 后端 5 子目录 + handlers/stores/routes/migration 全删 → typecheck 全绿
5. **共享文件清钩子**（Section E）：agent-manager/session-store/session-store-types/spawn-action/agent-tool/template-store/group-dir/session-config/mention/types 等 → 注释清理 + 字段/方法删除 → typecheck 全绿
6. **插件 + builtin + 测试**（Section F）：YAML ×9×2 + academy-context.ts + academy-scopes.test.ts + AT/ET case 删 → `bun run build:plugins` 重生成 dist（academy dist 自动消失）

### Phase 2 — 验证 + 文档
7. **全量 `bun run test`** 验回归（UT 全绿，无 stale 引用）
8. **AT 冒烟回归**（playground/studio 主链路，确认共享基建摘 academy 注册后未误伤）
9. **specs / research 删除**（Section G，doc-modifier 阶段 5）：UI components 29 + PRD overall 2 + version_logs（academy 版本整删 / 混合版本 187·203 删段）+ API + tech/academy KB + research 5（含 181 easy-skill-trainer，用户裁决一并删）+ app-guide 摘 academy 板块入口

## 列定义（8 列，行 = 一个函数/符号/文件）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统（ui-nav-rail / ui-view-store / persistence / academy-* / mention / scope / migration / specs / cleanup）|
| 文件路径 | 完整相对路径（academy 专属目录可一行汇总）|
| 函数/符号 | 函数/类/enum 值/字段/import（共享文件下钻到具体符号；academy 专属目录可整目录汇总）|
| 类型 | 删除 / 修改 |
| 变更内容 | 该处删什么 / 引用怎么清 |
| 约束 | MUST / MUST NOT（钉死边界）|
| 参考 | 该处删改对齐的 spec / 原则编号 |
| 影响行 | -N（删除） / +M/-N（修改） |

## B. 前端注册摘除（编译绿前提）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-nav-rail | app/web/src/components/framework/nav-rail/nav-rail.tsx | `BUSINESS_ITEMS` academy 项（line 34） | 删除 | 删 `{ view:'academy', testid:'nav-academy', labelKey:'nav.academy', icon:<GraduationCapIcon/> }`；删 `GraduationCapIcon` 组件定义（line ~152）+ import | MUST 同步删 icon 组件 + import；不得留死代码 | states/v0.0.208/context.md 注册点表 | -3/-15 |
| ui-view-store | app/web/src/store/view-store.ts | `ViewId` union `'academy'`（line 24） | 删除 | 从 `ViewId` union 删 `\| 'academy'` | MUST enum 闭合——删后所有 `case 'academy'`/`view === 'academy'` 引用先清 | context.md 注册点表 | -1 |
| ui-app-shell | app/web/src/components/framework/app-shell/app-shell.tsx | `currentView` academy route（line 43,109） | 删除 | 删 `<>{currentView === 'academy' && <AcademyPage/>}</>` 分支 + AcademyPage import | MUST 删 import；view 枚举只剩 playground/studio/settings 等 | context.md | -3 |
| ui-chat-slice | app/web/src/store/chat-slice.ts | `applySessionMetaEvent` biz 守卫（line 133） | 修改 | 删 `\|\| incoming.biz === 'academy'` 条件（studio 留） | MUST NOT 改 studio 分支；保留 playground 列表干净 | context.md 共享钩子表 | -1 |
| ui-i18n | app/web/src/i18n/index.ts | academy ns 注册（line 32,46,65,79） | 修改 | 删 `academy` namespace 4 处 import/注册 | MUST 4 处都清；删后无 `t('academy:*')` 调用残留 | context.md | -4 |
| ui-i18n | app/web/src/i18n/locales/{zh-CN,en}/academy.json | 整文件 ×2 | 删除 | 删两个 academy.json（各 ~273 行） | MUST zh/en 都删 | context.md academy 专属目录表 | -546 |

## C. 后端注册摘除（编译绿前提 — enum 闭合卡点）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| persistence-schema | app/server/src/agent/schema_defs/session.ts | `SessionSchema.fields.biz.enumValues` | 修改 | 删 `'academy'`（剩 `['playground','studio']`）| MUST enum 闭合——删前所有 `biz === 'academy'`/`BizType` 'academy' 引用先清 | session.ts:109 | -1 |
| persistence-schema | app/server/src/agent/schema_defs/session.ts | `SessionSchema.fields.role.enumValues` | 修改 | 删 `'coach','student','trainer'`（剩 `['rocky','leader','mate','squad']`）| MUST enum 闭合；删前 role 相关引用先清 | session.ts:122 | -3 |
| persistence-schema | app/server/src/agent/schema_defs/session.ts | `SessionSchema.fields.{classroomId,coachId,studentId,terminated,terminatedReason,terminatedAt}` | 删除 | 删 6 个字段（line 175-251）| MUST 6 字段都删；session-store-types 同步删；terminated 是 academy subagent 终态机制（academy 专属，不留）| session.ts:170-251；context.md | -30 |
| tools-registry | app/server/src/tools/registry.ts | academy 8 工具 import（line 63-74）+ 注册（line 115-120） | 删除 | 删 `studentTool`/`studentVersionTool`/`studentTrainTool`/`datasetTool`/`graderTool`/`trainConfigTool`/`studentSampleTool`/`studentGradeTool` import + registry 注册语句 | MUST 8 工具都清；profile toolBound 引用同步清（profile yaml 删于 Section F）| context.md | -20 |
| bootstrap | app/server/src/bootstrap.ts | academy stores 装配（line 52-54,198-206,295-303,328-333,429-431）| 删除 | 删 `ClassroomStore`/`StudentStore` import + BootstrapResult 字段 + `studentStoreForMention`/`classroomStore` 实例化 + `setAcademyStudentBus(academyStudentBus)` + result 透传 | MUST BootstrapResult interface 同步删字段；bootstrapMentionRegistry 调用去 studentStore 参数 | context.md | -25 |
| bootstrap-bus | app/server/src/bootstrap-bus-phase.ts | `academyStudentBus` + ACADEMY_STUDENT_TOPIC（line 24,49,113-123,139）| 删除 | 删 `ACADEMY_STUDENT_TOPIC` import + `academyStudentBus: ReplayableEventBusType` 字段 + `wrapBusWithLog` 块 + `hub.registerTopic` + return 透传 | MUST hub 不再注册 academy_student topic | context.md | -12 |
| bootstrap-agent | app/server/src/bootstrap-agent-phase.ts | academy subagent deps + trainer 模板（line 50-51,273-318,324） | 删除 | 删 `buildAcademySubagentToolDeps` import + `trainerTaskId` 读取（subAgentConfig.academy?.taskId）+ `upsertKnowledgeLearningTrainerTemplate` 调用 | MUST trainer 整套装配删；trainer 模板 const 删于 Section E | context.md | -55 |
| mention | app/server/src/mention/index.ts | `StudentProvider` export（line 19-20） | 删除 | 删 `export { StudentProvider } from './providers/student-provider'` + 注释 | MUST 删 export；provider 文件整删于 Section D | context.md | -2 |
| mention-bootstrap | app/server/src/mention/bootstrap-mention.ts | `bootstrapMentionRegistry` academy 参数（line 22,28,37,70-75） | 修改 | 删 `StudentProvider` import + `StudentStore` import + `studentStore` 参数（第 5 参）+ `if(studentStore){registry.register(new StudentProvider(...))}` 块 | MUST 签名减参；调用方 bootstrap.ts 同步改 | context.md | -15 |
| mention-types | app/server/src/mention/types.ts | `SearchCtx.{classroomId,coachId,studentId}` 字段（line 62,64,66） | 删除 | 删 3 个 academy 字段（SearchCtx interface） | MUST 所有读取 searchCtx.classroomId 等先清（student-provider 文件整删）| context.md | -5 |
| handlers-sse | app/server/src/handlers/sse.ts | `ALLOWED_TOPICS` 'academy_student'（line 19） | 修改 | 从 `ALLOWED_TOPICS` Set 删 `'academy_student'` | MUST topic 闭合——hub 不再注册；academy-event-types 删 | context.md | -1 |
| handlers-session | app/server/src/handlers/session.ts | biz 过滤 academy 分支（line 71-80） | 修改 | 删 `else if (bizParam === 'academy') bizFilter = 'academy'` + 注释；只剩 playground/studio 分支 | MUST 保留 playground/studio；comment 中 academy 提及一并清 | context.md | -4 |
| migration | app/server/src/migration/handlers/index.ts | academy 两 migration 注册（line 19-20,44-45） | 删除 | 删 `academyVersionDirsMigration`/`academyTrainerTemplateRefreshMigration` import + 注册表两条 | MUST migration handler 文件整删于 Section D | context.md | -4 |
| model-resolver | app/server/src/services/model-resolver.ts | sessionType 'academy' 分支（line 57-60,85-87,173-181） | 修改 | 从 `sessionType` union 删 `'academy'`（line 60,85）；删 `input.sessionType === 'academy'` 分支（line 181）；保留 playground 分支 | MUST union 闭合；调用方 session-config.ts 同步删 academy sessionType 派生（Section E）| context.md | -6 |
| router | app/server/src/router.ts | `dispatchAcademyRoutes`（line 29,130-132） | 删除 | 删 import + 子路径分发调用 | MUST academy-routes.ts 整删于 Section D | context.md | -4 |

## D. academy 专属目录/文件整删（C 摘完后）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-academy | app/web/src/components/academy-page/ | 整目录（38 源 + 6 测试） | 删除 | rm -rf 整目录（页面/section/component/modal/widget/hook 全删） | MUST 前端注册（Section B）先摘完才能整删 | context.md 专属目录表 | -44 文件 |
| ui-academy | app/web/src/lib/academy-api.ts academy-events.ts（+ __tests__） | 整文件 | 删除 | 删 HTTP/SSE 客户端 + 测试 | MUST 无残留 import | context.md | -3 文件 |
| academy-engine | app/server/src/academy-engine/ | 整目录（11 源 + 6 测试） | 删除 | rm -rf（训练引擎：candidate-generators/derive-iter-method/edit-apply/engine-dispatcher/eval-pipeline/iteration-engine/iteration-loop/sample-service/snapshot-files/student-sample-service/index）| MUST buildAcademySubagentToolDeps 调用（bootstrap-agent-phase）先清 | context.md | -17 文件 |
| academy-tools | app/server/src/agent/tools/academy/ | 整目录（11 源 + 2 测试） | 删除 | rm -rf（8 工具 impl + runtime-context + student-train-actions/helpers）| MUST tools/registry.ts 注册（Section C）先清 | context.md | -13 文件 |
| academy-schema | app/server/src/agent/schema_defs/academy/ | 整目录（8 源 + 2 测试） | 删除 | rm -rf（classroom/dataset/grader/student/student-version/train-config/training-task schema）| MUST 无外部 import | context.md | -10 文件 |
| academy-handlers | app/server/src/handlers/academy*.ts | 整文件 ×10 源 + 6 测试 | 删除 | 删 academy.ts/academy-engine-wire.ts/academy-iteration-routes.ts/academy-resource-routes.ts/academy-resource-serializers.ts/academy-routes.ts/academy-services.ts/academy-student-write.ts/academy-version-task-serializers.ts/academy-version-task.ts + 测试 | MUST router.ts dispatchAcademyRoutes import 先清 | context.md | -16 文件 |
| academy-stores | app/server/src/stores/academy-*.ts | 整文件 ×6 源 + 5 测试 | 删除 | 删 academy-resource-store/academy-store/academy-student-events/academy-v184-migration/academy-version-dir/academy-version-task-store + 测试 | MUST bootstrap.ts 实例化（Section C）先清；setAcademyStudentBus 调用清 | context.md | -11 文件 |
| academy-routes | app/server/src/routes/academy-routes.ts（+ __tests__） | 整文件 | 删除 | 删 `dispatchAcademyRoutes` impl + 测试 | MUST router.ts 调用先清 | context.md | -2 文件 |
| academy-migration | app/server/src/migration/handlers/academy-*.ts（+ __tests__） | 整文件 | 删除 | 删 academy-version-dirs.ts + academy-trainer-template-refresh.ts + 测试 | MUST migration/handlers/index.ts 注册（Section C）先清 | context.md | -4 文件 |
| academy-events | app/server/src/agent/academy-event-types.ts | 整文件 | 删除 | 删 `ACADEMY_STUDENT_TOPIC` 等常量 | MUST bootstrap-bus-phase.ts import 先清 | context.md | -1 文件 |
| session-terminate | app/server/src/agent/session-terminate-op.ts | 整文件 | 删除 | 删 `terminateSessionOp`（academy subagent 一 task 一 subagent 终态机制，academy 专属）| MUST SessionStore.terminateSession 方法（Section E）先清 | context.md §terminated 裁决 | -1 文件 |

## E. 共享文件清钩子（删 academy 钩子，保文件本身）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-manager | app/server/src/agent/agent-manager.ts | `deliverTo` terminated 校验（line 363） | 删除 | 删「session.terminated 硬墙」检查 + throw 逻辑（academy subagent 终态停用机制——academy 专属不留）| MUST 删 terminated 字段（Section C）后置；SessionTerminatedError 同步删 | context.md 共享钩子表 | -8 |
| agent-manager-children | app/server/src/agent/agent-manager-children.ts | `SessionTerminatedError` class（line 45-46） + 防绕过注释（line 154） | 删除 | 删 class 定义 + import + 所有 throw/引用 | MUST 无残留引用；terminated 机制整删 | context.md | -15 |
| session-store | app/server/src/agent/session-store.ts | `terminateSession` 方法（line 342-351）+ `terminateSessionOp` import（line 44）| 删除 | 删 method + import + 注释 | MUST 文件 session-terminate-op.ts 整删于 Section D | context.md | -12 |
| session-store-types | app/server/src/agent/session-store-types.ts | `Session.{classroomId,coachId,studentId,terminated,terminatedReason,terminatedAt,academy}` 字段 + subAgentConfig.academy | 删除 | 删 line 156-161（subAgentConfig.academy）/ 183-195（classroomId/coachId/studentId 注释段）/ 226-231（terminated 段）/ 398-413（CreateSessionInput 对应字段）| MUST schema_defs/session.ts 同步删；context-types.ts 同步删 | context.md | -40 |
| session-store-core-impl | app/server/src/agent/session-store-core-impl.ts | academy 字段读写（line 100） | 修改 | 删 classroomId/coachId/studentId optional 字段处理 + 注释 | MUST 与 schema 字段删除同步 | context.md | -5 |
| system-prompt-builder | app/server/src/agent/system-prompt-builder.ts | academy 注释（line 37,55,91） | 修改 | 清 academy_context 注释/示例；mapper 接口（允许 async）保留——通用抽象 | MUST NOT 删 mapper 接口；仅清 academy 字样 | context.md | -3 |
| context-engine | app/server/src/agent/context-engine.ts | academy 注释（line 353,381） | 修改 | 清 academy_context mapper key 示例；mapper key 接口保留 | MUST NOT 删 mapper 抽象；仅清 academy 字样 | context.md | -2 |
| context-types | app/server/src/agent/context-types.ts | `SessionContext.{classroomId,coachId,studentId}` 字段（line 178-190） | 删除 | 删 3 字段 + role enum 注释中 coach/student/trainer 字样 | MUST 读取 sessionContext.classroomId 等先清（runtime-context/types/session-config）| context.md | -10 |
| session-type-profile-loader | app/server/src/agent/session-type-profile-loader.ts | academy 注释 + trainer profile 字段（line 12,65,67） | 修改 | 清 academy-coach 文件名示例注释；`userReachable/ephemeral` profile 字段保留 if 通用（trainer-only 字段 → grep 确认；trainer 删则 profile 字段无消费者，可一并清）| MUST grep 确认 profile 字段是否被非 academy 引用（如 studio subagent） | context.md | -3 |
| session-type-profile-validator | app/server/src/agent/session-type-profile-validator.ts | academy 注释（line 79） | 修改 | 清 academy-trainer.parent.main 示例；启动期校验逻辑保留 | MUST 仅清字样 | context.md | -1 |
| spawn-action | app/server/src/agent/spawn-action.ts | trainer 派生分支（line 54-126） | 删除 | 删 trainer（derivation='parent'）特殊处理分支 + academy 字段注入逻辑 | MUST spawn-action 通用机制（subagent 派生）保留；仅删 trainer/academy 分支 | context.md | -70 |
| agent-tool | app/server/src/agent/tools/agent-tool.ts | `academyBinding` 字段 + 处理（line 286-352） | 删除 | 删 `childConfig.academyBinding` 类型字段 + binding 读取/写 child record（classroomId/studentId/taskId 注入）+ subAgentConfig.academy 写入 + 注释 | MUST createChildSessionImpl 通用路径保留 | context.md | -70 |
| runtime-context | app/server/src/agent/tools/runtime-context.ts | academy 注释（line 24,146,151） | 修改 | 清 academy 工具 caller 校验注释；SessionContext 字段引用随 context-types 同步删 | MUST 仅清字样 + 删字段 | context.md | -3 |
| tools-types | app/server/src/agent/tools/types.ts | `SubAgentTemplate.academy` 字段（line 72-76） | 删除 | 删 academy binding 可选字段；role/derivation 字段是否保留取决于 explorer 模板是否需要（explorer 不填 → 可删）| MUST grep 确认 role/derivation 是否仅 trainer 用；是则一并删 | context.md | -8 |
| template-store | app/server/src/agent/tools/template-store.ts | `KNOWLEDGE_LEARNING_TRAINER_TEMPLATE` + `upsertKnowledgeLearningTrainerTemplate`（line 41-109,187-203） | 删除 | 删 const + function（academy 学生训练 trainer 预配——academy 专属）；保留 `EXPLORER_TEMPLATE`/`upsertExplorerTemplate`/`loadTemplateFromDevConfig`/`normalizeTemplate`/`makeLoadTemplate`/`listTemplates`/`SUB_AGENT_TEMPLATES_GROUP` | MUST NOT 删通用 template-store 抽象（explorer 等留）；仅删 academy trainer const | template-store.ts:41-109,187-203 | -85 |
| group-dir | app/server/src/agent/group-dir.ts | `classroomGroupWsRoot` + academy 路径（line 8,32,34） | 删除 | 删 classroom group ws 派生函数（academy 专属）；squad group ws 函数保留 | MUST grep 确认 classroomGroupWsRoot 仅 academy 用 | context.md | -8 |
| session-config | app/server/src/handlers/session-config.ts | academy sessionType 派生 + classroomId（line 183-199,238,244,342） | 修改 | 删 `kind.biz === 'academy' ? 'academy'` 分支；删 `classroomId: sessionContext?.classroomId`；保留 playground/studio 分支 + SessionContext 注释（删 academy 字样）| MUST model-resolver sessionType union 同步；context-types.classroomId 删 | context.md | -8 |
| session-debug | app/server/src/handlers/session-debug.ts | academy 注释（line 113） | 修改 | 清 academy-coach scope 示例 | MUST 仅清字样 | context.md | -1 |
| skills-resolver | app/server/src/skills/resolver.ts | academy 注释（line 23,54） | 修改 | 清 academy/classrooms 路径示例；groupDir 机制保留（studio 用） | MUST 仅清字样 | context.md | -2 |
| skills-types | app/server/src/skills/types.ts | academy 注释（line 16,20） | 修改 | 清 academy classroom 路径示例 | MUST 仅清字样 | context.md | -2 |
| ui-chat-composer | app/web/src/components/app-dev-config-page/extensions/chat-composer-extension.tsx | academy 分支（line 179,188） | 删除 | 删 academy chat-composer 扩展分支 | MUST 通用扩展机制保留 | context.md | -10 |
| ui-topbar | app/web/src/components/framework/header/component-chat-topbar-back-btn.tsx | academy 返回分支（line 8） | 删除 | 删 academy view 返回按钮分支 | MUST 通用返回逻辑保留 | context.md | -3 |
| ui-mention-pill | app/web/src/components/framework/primitive-mention-pill.tsx | academy 分支（line 116） | 删除 | 删 academy mention pill 分支 | MUST 通用 mention pill 保留 | context.md | -5 |
| mention-search | app/server/src/mention/search-service.ts | academy 注释（line 116） | 修改 | 清 academy 字段从 session record 解析注释 | MUST 仅清字样 | context.md | -1 |

## F. 插件 + builtin + 测试

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| plugins-scopes | app/plugins/scopes/academy-*.yaml ×9 | 整文件 | 删除 | 删 academy-coach.parent.{main,summary,consolidate}/academy-coach.subagent.{...}/academy-trainer.parent.{...} | MUST 9 文件都删 | context.md | -9 |
| plugins-session-types | app/plugins/session-types/academy-*.yaml ×9 | 整文件 | 删除 | 同上 9 个 profile yaml | MUST 9 文件都删 | context.md | -9 |
| plugins-builtin | app/plugins/builtins/rocky_context/prompt/academy-context.ts（+ __tests__） | 整文件 | 删除 | 删 academy_context mapper（academy 专属）；其他 mapper 保留 | MUST build-plugins 重新生成 dist 后 academy-context.cjs 自动消失（无需手删 dist，见裁决）| context.md | -2 |
| plugins-test | app/plugins/__tests__/academy-scopes.test.ts | 整文件 | 删除 | 删 academy scopes 测试 | MUST 无依赖 | context.md | -1 |
| dist-artifacts | app/plugins/dist/**, app/server/src/dist/** | — | 不手删 | dist/ 是 build-plugins 构建产物，源删后跑 `bun run build:plugins`（或对应 script）自动重新生成；当前 worktree 无 dist/（已确认），无需手删 | MUST 源码删后跑一次 build:plugins 验证 academy 不出现 | context.md findings；H 节 | 0 |
| tests-at | tests/api/academy/{coach-chat,learning-single}/ | 整目录 ×2 case | 删除 | 删 AT case（case.yaml + test_case.md + last_run/） | MUST AT case 库收缩；不在版本白名单（academy 已删）| context.md | -2 case |
| tests-et | tests/e2e/academy-review/ | 整目录 | 删除 | 删 ET case（case.md + 产物） | MUST ET case 库收缩 | context.md | -1 case |

## G. specs / research 删除（doc-modifier 阶段执行；此处冻结清单）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| specs-ui | specs/ui/components/academy-page/ | 整目录（29 组件 spec） | 删除 | rm -rf | MUST 29 文件都删；specs/ui/overall/* 中 academy 入口同步删（doc-modifier）| context.md | -29 |
| specs-ui-overall | specs/ui/overall/00-app-guide.md（+其他 overall 含 academy 入口） | academy 段 | 修改 | 删 nav-rail Academy 入口 + academy 操作路径章节 | MUST 让「照手册能从 nav-rail 点到任意功能」重新成立 | CLAUDE.md doc-modifier 章节 | -N |
| specs-prd | specs/prd/overall/{12-academy,14-academy-training}.md | 整文件 | 删除 | 删 2 PRD overall | MUST 文件整删 | context.md | -2 |
| specs-prd-logs | specs/prd/version_logs/v0.0.183.academy/, v0.0.184.student_training/, v0.0.187.md, v0.0.203.md | academy 段或整文件 | 删除/修改 | v0.0.183/184 整删（academy 专属版本）；v0.0.187/203 删 academy 相关段落（保留其他改动段）| MUST 区分纯 academy 版本 vs 含 academy 段的混合版本 | context.md | -N |
| specs-api | specs/api/overall/13-academy.md | 整文件 | 删除 | 删 API 契约 | MUST 文件整删 | context.md | -1 |
| specs-api-logs | specs/api/version_logs/v0.0.183.academy/, v0.0.184.student_training/ | 整目录 | 删除 | 删 2 API version_logs | MUST 文件整删 | context.md | -2 |
| specs-tech | specs/tech/academy/ | 整目录（12 KB 文件）| 删除 | rm -rf OKF KB（index.md/log.md/frontmatter + 10 [P0]/[P1] spec）| MUST 12 文件都删 | context.md | -12 |
| specs-tech-logs | specs/tech/version_logs/v0.0.183.academy/, v0.0.184.student_training/（含 academy 的 v0.0.187/203 段）| academy 段或整文件 | 删除/修改 | 同 PRD：纯 academy 版本整删；混合版本删 academy 段；**本 v0.0.208 change_plan 保留** | MUST 保留本 change_plan 作历史档案 | context.md | -N |
| specs-research | specs/research/v0.0.181-easy-skill-trainer.md, v0.0.181-skillopt.md, v0.0.183-ui-pattern-map.md, v0.0.184-skill-training-mechanics.md, v0.0.187-training-engine-concepts.md | 整文件 ×5 | 删除 | 删 5 research（含 181 easy-skill-trainer——见裁决：建议删，orchestrator 确认）| ⚠ 181-easy-skill-trainer 是外部 refs 仓研究，见影响面评估；orchestrator 拍板 | context.md；H 裁决 | -5 |

## H. 数据清理脚本（新增 + 跑 3 环境）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| cleanup-script | scripts/cleanup-academy-data.ts | `main(dataDir: string)` + `cleanupAcademySessions(store)` + `cleanupAcademyDataDir(dataDir)` + `cleanupAcademyConfig(appConfig)` | 新增 | 一次性 cleanup 脚本：(1) 起 minimal SessionStore（仅 dataDir + CrudStore，不起 HTTP）；(2) `listSessions({biz:'academy'})` → 逐个 `deleteSession(sid)` 走级联（fs sessions/{sid}/ + sqlite record + messages/runs/summaries）；(3) `rm -rf {dataDir}/academy/`（classrooms/student-versions/datasets/graders/train-configs 等）；(4) 删 app_config 中 `sub_agent_templates/knowledge_learning_trainer` record（如存在）；(5) 日志输出删除汇总（sid 列表 + academy 文件数 + 配置项）；idempotent | MUST 复用 SessionStore.deleteSession 级联（不手撸 sqlite，避免漏 cascade）；MUST 接受 DATA_DIR 命令行参数；MUST idempotent（二次跑无 academy 数据时返 0 删除）；MUST NOT 触碰 playground/studio/skills 数据；MUST 先 dry-run 模式打印将删清单，确认后再实际删 | resolveDataDir `app/server/src/config.ts:50`；SessionStore.deleteSession `session-store.ts:180`（fs cascade `sessions/{sid}/`）；listSessions biz 过滤 `session-store.ts:160`；crud.sqlite 路径 `{dataDir}/crud.sqlite`（context.md findings 已确认）；app_config `sub_agent_templates` group `template-store.ts:22` | +120 |
| cleanup-run | scripts/run-cleanup-academy.sh（可选 wrapper）或直接 3 次 `bun run` | `bash` 一次性 | 新增 | 跑 3 环境：`bun run scripts/cleanup-academy-data.ts ~/.rocky_agent_dev` / `_test` / `_prod`（dry-run 先，确认后实际跑）| MUST 用户先确认 dry-run 输出再实跑；MUST NOT 自动批跑 3 环境不经确认 | context.md 数据落点 | +20 |

## 影响面评估

### 6 个裁决点（architect 已落结论）

1. **删除顺序**：B 前端注册 → C 后端注册（enum 闭合卡点）→ D 专属整删 → E 共享清钩子 → F 插件/测试 → G specs → H 数据清理。每步 typecheck。

2. **`terminated` session 字段**（schema_defs/session.ts:242-251 + session-store-types.ts:226）：**academy 专属 → 整删**。证据：schema 注释 `[v0.0.184] session 终止标记（academy subagent 一 task 一 subagent 终态彻底停用机制）`；`terminateSessionOp` 文件头注释「academy subagent 一 task 一 subagent 一次性停用机制」；agent-manager.ts:363 + agent-manager-children.ts:45 SessionTerminatedError + session-store.ts:342 terminateSession 全链都是 academy subagent 终态。academy 删 → terminated 整套机制无消费者 → 删（含 session-terminate-op.ts 整文件 + SessionStore.terminateSession 方法 + terminated/terminatedReason/terminatedAt 三字段）。

3. **dist/ 产物**：**不手删，靠重新 build-plugins**。证据：本 worktree `app/plugins/dist/` 与 `app/server/src/dist/` 均不存在（gitignored 构建产物）。源 yaml / academy-context.ts 删后，跑 `bun run build:plugins`（即 `scripts/build-plugins.ts`）重新生成 → academy dist 自然消失。coder 验证步骤：构建后 `find app/plugins/dist -name '*academy*'` 应空。

4. **knowledge_learning_trainer 模板**（template-store.ts:41-109,187-203）：**academy 专属 → 删 const + upsert 函数**。证据：模板头注释「academy 学生训练 trainer」、tools 全是 academy 工具（student/student_version/student_train/student_sample/student_grade 等）、role='trainer'+derivation='parent'（trainer 独立身份，academy-only）。**保留** EXPLORER_TEMPLATE + 通用 template-store 抽象（normalizeTemplate/loadTemplateFromDevConfig/listTemplates/makeLoadTemplate 等通用函数）。tools/types.ts 的 `SubAgentTemplate.role/derivation` 字段是否保留：grep 确认 explorer 模板不填这两字段 → trainer 删后无消费者 → **role/derivation 字段一并删**（简化模板类型，不留死字段）。

5. **数据清理脚本设计**：见 H 节。**核心：复用 SessionStore.deleteSession 级联**（fs sessions/{sid}/ + sqlite message/run/summary 全级联 + session record），不手撸 sqlite。脚本接受 DATA_DIR 参数 → 起 minimal SessionStore（仅 CrudStore，不起 HTTP/bus） → `listSessions({biz:'academy'})` 逐个 `deleteSession(sid)` → `rm -rf {dataDir}/academy/` → 清 app_config `sub_agent_templates/knowledge_learning_trainer` record。**dry-run 模式必选**：先打印将删清单（academy session 数 + academy 文件数），用户确认后实跑。3 环境分别跑（dev/test/prod）。

6. **v0.0.181 easy-skill-trainer research**：**建议删，orchestrator 拍板**。证据：研究 refs/easy-skill-trainer 外部仓（Electron + Hono + React monorepo 对标 SkillOpt 论文），done-for-purpose = 为 academy「skill 培训 native 管线 vs agent 驱动」决策提供事实基础。**建议删理由**：(a) 用户裁决「设计不完善重新来」→ 未来重做应重新调研（fresh eyes，避免旧设计锚定偏差）；(b) `refs/easy-skill-trainer/` 外部仓仍在，未来需要时可重做研究；(c) 留半旧研究会让未来 architect 误以为「上版已研究过可复用」而跳过调研。**留的理由**（若 orchestrator 判）：纯外部仓研究有独立参考价值。**默认按删处理，标 ⚠ 待 orchestrator 确认**。

### 跨模块影响

- **破坏性变更**：session schema enum（biz/role）值删除 → 所有 `'academy'`/`'coach'`/`'student'`/`'trainer'` 字面量引用须先清；SubAgentTemplate role/derivation 字段删除 → tools/types.ts 类型变窄。
- **数据迁移**：3 环境 academy 数据清理是**一次性 runtime migration**（启动期 migration handler 注册（migration/handlers/index.ts）不走此路径——它是启动期版本号 marker 机制，不删用户数据。**运行时启动路径绝不做破坏性状态迁移**——memory `runtime-no-ext-policy-write`）。本脚本只在用户显式调用时跑，不进启动链。
- **风险点**：(a) enum 闭合性——删前必须 grep 所有 `biz === 'academy'` `role: 'coach'` 等字面量；(b) SessionStore.deleteSession 级联正确性（脚本依赖其 fs+sqlite cascade 不漏）；(c) cleanup 脚本 dry-run 不可跳过（防误删 playground/studio）。
- **打包护栏**：academy 删除不改 plugin 加载机制（build-plugins 仍走，只是 academy builtin 不再生成）；不改 runtime-config 白名单；不改路径展开。无 packaged 专属崩溃风险（dev 删 = packaged 删）。**无需跑 packaged 验证**（纯删除，无新代码路径）。

### 验证收尾

- typecheck 绿（多次卡点）
- `grep -ri 'academy' app/ specs/ tests/` 仅剩：本 change_plan + v0.0.208 task-board/context + dist（构建后应空）+ 已标注的归档（reqs/archive 含旧 academy 版本 req 不动）
- `bun run test` 全量绿（UT 覆盖 academy 删除后无 stale 引用）
- 跑 build:plugins 后 `find app/plugins/dist -name '*academy*'` 应空
- cleanup 脚本 dry-run 3 环境输出 academy session 数 + 文件数；用户确认后实跑；二次 dry-run 应返 0

## 反馈回路

- 实现/codereview 严重违反本表（删表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- spec↔code 偏差（spec 落后实际 API）→ coder 按代码实际调整 + 汇报，doc-modifier 阶段 5 统一修 spec
