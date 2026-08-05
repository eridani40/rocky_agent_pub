# v0.0.189.dsl_board 变更计划书 — Panorama 业务全景（DSL 看板系统）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 设计权威：`reqs/[working] v0.0.189.dsl_board/req.md`（用户拍板锁定）
> PRD：`specs/prd/version_logs/v0.0.189.dsl_board/prd.md`
> 架构权威：`specs/tech/squad/[P1]panorama_*.md`（7 个 spec）+ `specs/api/overall/14-panorama-endpoints.md` + `specs/ui/components/studio-page/component-panorama-*.md`

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名/符号名（行粒度 = 符号） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | spec 位置 + 项目原则编号 |
| 影响行 | +N / -M |

---

## 模块 1: panorama/dsl — DSL parser + 类型定义

| 模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| panorama/dsl | app/server/src/squad/panorama/dsl/types.ts | PanoramaSchema | 新增 | DSL 解析后类型：meta/team/entities(map)/views(array) 完整 TypeScript interface | MUST entities 是 map（key=实体名）；views 是有序数组 | panorama_dsl.md §1 | +60 |
| panorama/dsl | app/server/src/squad/panorama/dsl/types.ts | EntityDef | 新增 | 实体定义类型：label/id_field/fields/states/display | MUST fields 是 map；states/display optional | panorama_dsl.md §4 | +25 |
| panorama/dsl | app/server/src/squad/panorama/dsl/types.ts | FieldDef | 新增 | 字段类型 union：string/number/boolean/enum/ref/datetime + 各类型约束键 | MUST 6 种类型闭集合；ref 必有 entity | panorama_dsl.md §4.2 | +30 |
| panorama/dsl | app/server/src/squad/panorama/dsl/types.ts | StatesDef | 新增 | 状态机类型：field/initial/transitions(map)/terminal(array) | MUST transitions 是 map（from→to[]）；terminal optional | panorama_dsl.md §4.3 | +15 |
| panorama/dsl | app/server/src/squad/panorama/dsl/types.ts | ViewDef | 新增 | 视图类型 union：kanban/table/bar_chart + component 专属字段 | MUST component ∈ {kanban,table,bar_chart} | panorama_dsl.md §5 | +30 |
| panorama/dsl | app/server/src/squad/panorama/dsl/parser.ts | parseDsl(text) | 新增 | YAML parse → PanoramaSchema（含 meta 默认值填充） | MUST 用 yaml 库 parse；meta/version 缺失填默认值 + 返 warning | panorama_dsl.md §1/§2; demo engine.js loadDsl | +20 |
| panorama/dsl | app/server/src/squad/panorama/dsl/template.ts | interpolate(tpl, record, dsl, entity) | 新增 | card 模板插值：`{field}` / `{ref.target}` / `{field\|fallback}` / `{{esc}}` | MUST 缺失字段编译期报错（语义层）；运行时 null→空串/fallback | panorama_dsl.md §5.5 | +35 |
| panorama/dsl | app/server/src/squad/panorama/dsl/template.ts | resolveRef(record, refField, dsl) | 新增 | ref 字段嵌套解析：取 ref 目标实例的 target 字段值 | MUST 一级嵌套（不支持 ref.target.deep）；目标已删→null | panorama_dsl.md §5.5 | +15 |

## 模块 2: panorama/validation — 四层校验引擎

| 模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| panorama/validation | app/server/src/squad/panorama/validation/types.ts | ValidationResult / ValidationError / ValidationWarning | 新增 | 校验返回结构 interface | MUST ok=false 时 errors 非空；ok=true 时 errors=[] | panorama_validation.md §1.2 | +25 |
| panorama/validation | app/server/src/squad/panorama/validation/validator.ts | validateDsl(dslText, context) | 新增 | 四层校验主入口：Layer1 短路 → 2-3 收集 → 4 数据安全 | MUST Layer1 fail 短路返回；Layer2-3 不短路收集全部 | panorama_validation.md §1.1 | +30 |
| panorama/validation | app/server/src/squad/panorama/validation/validator.ts | validateSyntax(text) | 新增 | Layer1：YAML parse + 根类型 map + 必需顶层键 | MUST fail→短路；meta/version 缺失不报错（填默认） | panorama_validation.md §2 | +20 |
| panorama/validation | app/server/src/squad/panorama/validation/validator.ts | validateSchema(schema) | 新增 | Layer2：字段类型/必填/enum 值集/护栏上限/entity 声明/view 配置/状态机 | MUST 不短路（收集全部错误）；护栏上限检查 | panorama_validation.md §3 | +80 |
| panorama/validation | app/server/src/squad/panorama/validation/validator.ts | validateSemantic(schema) | 新增 | Layer3：跨引用闭合（ref target/template field/group_by/columns/transitions/ref 无环） | MUST 不短路；编译期报错（非运行时静默） | panorama_validation.md §4 | +60 |
| panorama/validation | app/server/src/squad/panorama/validation/validator.ts | validateDataSafety(oldSchema, newSchema, store) | 新增 | Layer4：存量实例 vs 新 DSL 兼容性（删字段/收窄enum/改类型等破坏性判定） | MUST 仅 define(非dryRun) 且有存量数据时触发 | panorama_validation.md §5 | +50 |
| panorama/validation | app/server/src/squad/panorama/validation/instance-validator.ts | validateInstance(entityDef, record, store) | 新增 | 实例写校验（create/update）：类型/枚举/ref闭合/required/max/pattern/minmax/datetime/id唯一 | MUST 从 DSL 派生规则（不硬编码）；三路写入共用 | panorama_validation.md §6 | +60 |
| panorama/validation | app/server/src/squad/panorama/validation/instance-validator.ts | validateTransition(entityDef, from, to, record) | 新增 | 跃迁校验：transitions 表 + terminal 锁 + guard | MUST 非法返可读 reason；三路写入共用（拖拽/工具/API） | panorama_validation.md §7; demo validateTransition | +30 |

## 模块 3: panorama/migration — 迁移引擎

| 模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| panorama/migration | app/server/src/squad/panorama/migration/types.ts | MigrationPlan / MigrationOperation / MigrationHandler | 新增 | 迁移方案格式 interface | MUST operations 数组；handler.strategy 闭集合 | panorama_migration.md §3.1 | +25 |
| panorama/migration | app/server/src/squad/panorama/migration/engine.ts | classifyChanges(oldSchema, newSchema) | 新增 | 变更分类：增量 vs 破坏性 + change kind 清单 | MUST 增量=自动；破坏性=须 migration | panorama_migration.md §1 | +50 |
| panorama/migration | app/server/src/squad/panorama/migration/engine.ts | executeMigration(operations, store, schema) | 新增 | 执行迁移方案：逐 operation transform 存量数据 + 幂等检查 | MUST 幂等（跳过已完成 operation）；原子（失败全回滚） | panorama_migration.md §6 | +60 |
| panorama/migration | app/server/src/squad/panorama/migration/engine.ts | requiresApproval(changes) | 新增 | 判定重大 vs 次要：重大变更需 user approved | MUST 重大清单（删实体/删字段/收窄enum/改类型/改states.field） | panorama_migration.md §4 | +20 |
| panorama/migration | app/server/src/squad/panorama/migration/engine.ts | backupBeforeMigration(schema, store, seq) | 新增 | 破坏性变更前备份旧 DSL + 受影响实例到 .archive/pre-migration-{seq}/ | MUST 先备份再执行；回滚时从此目录恢复 | panorama_migration.md §6.3 | +25 |
| panorama/migration | app/server/src/squad/panorama/migration/engine.ts | auditMigration(changes, seq) | 新增 | 写 events.jsonl 审计 entry（board.defined + changes[] 明细） | MUST change kind 逐条记录；含 affected_instances 计数 | panorama_migration.md §5 | +20 |

## 模块 4: panorama/store — 泛化实体 store + DSL 注册表

| 模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| panorama/store | app/server/src/squad/panorama/store/entity-store.ts | PanoramaEntityStore | 新增 | 泛化 KV store（不建 SchemaDef）：list/get/put/delete by (entity,id) | MUST 不依赖 SchemaDef；复用 FsCrudStore 原子写 + 锁原语 | panorama_store.md §2; fs_crud_store_engine.md | +80 |
| panorama/store | app/server/src/squad/panorama/store/entity-store.ts | readBoard(dataDir, squadId) | 新增 | 读 board.yaml（DSL 主面）→ PanoramaSchema | MUST 原子读（yaml parse）；空 board 返 null | panorama_store.md §6 | +15 |
| panorama/store | app/server/src/squad/panorama/store/entity-store.ts | writeBoard(dataDir, squadId, yaml) | 新增 | 原子写 board.yaml（tmp→fsync→rename） | MUST 原子写（对齐 FsCrudStore §3.6） | panorama_store.md §6 | +15 |
| panorama/store | app/server/src/squad/panorama/store/entity-store.ts | appendEvent(dataDir, squadId, event) | 新增 | append events.jsonl（append-only 事件流） + SSE 触发 | MUST append-only（只追加不修改）；seq 单调递增 | panorama_store.md §7; demo store.js appendEvent | +25 |
| panorama/store | app/server/src/squad/panorama/store/entity-store.ts | readEvents(dataDir, squadId, since?, limit?) | 新增 | 读事件流（从 seq 之后读 N 条） | MUST since 不含；limit 默认 50 | panorama_store.md §7 | +15 |
| panorama/store | app/server/src/squad/panorama/store/entity-store.ts | generateId(dataDir, squadId, entity) | 新增 | 实例 ID 生成：{entity}-{seq}（per-entity 自增计数器） | MUST seq 存 .state/panorama-counters.json；对齐 board counters.json 惯例 | panorama_store.md §4 | +20 |

## 模块 5: panorama/tool — agent 工具（action-based）

| 模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| panorama/tool | app/server/src/squad/panorama/tool/panorama-tool.ts | PANORAMA_TOOL_DEFINITION | 新增 | 工具定义（name/description/inputSchema）；action=define/get_schema/create/update/transition/query/events | MUST inputSchema.properties = 全部 flat 顶层字段（LLM 参数契约 §0）；仅 action required | panorama_tools.md §0/§1; squad_tools.md §0 | +60 |
| panorama/tool | app/server/src/squad/panorama/tool/panorama-tool.ts | executePanorama(action, params, ctx) | 新增 | action 分发器：按 action 调对应 handler | MUST 权限校验（schema面=leader/user，数据面=全员）；写操作记 lastWriteMessageId | panorama_tools.md §2 | +40 |
| panorama/tool | app/server/src/squad/panorama/tool/panorama-tool.ts | actionDefine(dsl, dryRun, migration, approved, ctx) | 新增 | define handler：跑校验引擎 + migration（破坏性）+ 落盘 + 审计 | MUST dryRun 失败不落盘；重大变更须 approved；非 leader/user→forbidden | panorama_tools.md §2.1; panorama_migration.md | +50 |
| panorama/tool | app/server/src/squad/panorama/tool/panorama-tool.ts | actionCreate(entity, fields, ctx) | 新增 | create handler：校验实例 + put store + appendEvent | MUST 过 instance-validator；id 唯一；状态缺省 states.initial | panorama_tools.md §2.3 | +25 |
| panorama/tool | app/server/src/squad/panorama/tool/panorama-tool.ts | actionUpdate(entity, id, patch, ctx) | 新增 | update handler：校验 patch + put store + appendEvent | MUST 过 instance-validator（仅 patch 字段） | panorama_tools.md §2.4 | +20 |
| panorama/tool | app/server/src/squad/panorama/tool/panorama-tool.ts | actionTransition(entity, id, to, ctx) | 新增 | transition handler：过 transition 校验 + 更新实例 + appendEvent | MUST 过 validateTransition；非法返可读 reason | panorama_tools.md §2.5 | +25 |
| panorama/tool | app/server/src/squad/panorama/tool/panorama-tool.ts | actionQuery / actionEvents / actionGetSchema | 新增 | 读 handler：query/events/get_schema | MUST 全员可调；schema 未定义→数据面返 panorama_schema_not_defined | panorama_tools.md §2.2/§2.6/§2.7 | +40 |

## 模块 6: panorama/http — HTTP 路由 + SSE

| 模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| panorama/http | app/server/src/squad/panorama/http/routes.ts | registerPanoramaRoutes(router, deps) | 新增 | 注册 /squad/:squadId/panorama/* 路由（schema GET/PUT + validate + entities CRUD + transition + events） | MUST 路由前缀 /squad/:squadId/panorama/；对齐 11a 风格 | panorama_http.md §1; 14-panorama-endpoints.md | +100 |
| panorama/http | app/server/src/squad/panorama/http/sse.ts | emitPanoramaEvent(squadId, event, sseHub) | 新增 | SSE 推送：实体变更 → emit panorama_entity_update / schema_update 到 topic panorama:squad:{squadId}:entity | MUST 复用现有 sseHub（不另起通道）；group=default | panorama_http.md §4 | +25 |

## 模块 7: panorama/bootstrap — workspace 初始化 + 工具注册

| 模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad/bootstrap | app/server/src/services/squad-service.ts | createSquadService step7 | 修改 | 建目录骨架加 panorama/ 子目录（entities/ + events.jsonl 空文件 + .archive/） | MUST 不影响现有 board/ 目录；panorama/ 与 board/ 同级 | panorama_store.md §1; data_model.md §4 | +3 |
| squad/bootstrap | app/server/src/squad/panorama/index.ts | registerPanoramaTool(toolRegistry) | 新增 | 注册 panorama 工具到 squad tool registry | MUST 占 1 tool slot；对齐 squad_tools 收敛注册模式 | panorama_tools.md §0 | +15 |

## 模块 8: web/studio-page — 前端组件（4 新组件 + 2 改动）

| 模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web/studio | app/web/src/components/studio-page/page-studio.tsx | MainView type | 修改 | 加 `{kind:'panorama'; squadId}` 路由态分支 | MUST 与 board 路由态同级；渲 component-panorama-route | _overview.md §1; 06-studio.md §2.2a | +8 |
| web/studio | app/web/src/components/studio-page/component-panorama-route.tsx | PanoramaRoute | 新增 | 路由容器：GET schema → 分发 idle/view + SSE 订阅 + 返回键 | MUST schema===null→idle；schema 有→view；SSE 收 schema_update 重拉 | component-panorama-route.md | +80 |
| web/studio | app/web/src/components/studio-page/component-panorama-view.tsx | PanoramaView | 新增 | 工作态渲染器：tab + kanban/table/bar_chart 装配 + 拖拽 transition + 弹层 + 事件流 + SSE 乐观更新 | MUST 拖拽走 POST transition；非法→回弹+toast；SSE→乐观更新 | component-panorama-view.md; demo kanban/table/bar-chart.js | +200 |
| web/studio | app/web/src/components/studio-page/component-panorama-idle.tsx | PanoramaIdle | 新增 | 空态引导：@leader 预填链路（不提供配置入口） | MUST 按钮→切群聊+预填 @leader；无 DSL 编辑器 | component-panorama-idle.md | +40 |
| web/studio | app/web/src/components/studio-page/component-panorama-entity-modal.tsx | PanoramaEntityModal | 新增 | 泛化实体弹层：DSL 驱动动态字段集 + edit/create 共用 | MUST 字段集从 entity.fields 动态生成；清空语义（dirty才提交） | component-panorama-entity-modal.md; board-entity-modal 抽象 | +120 |
| web/studio | app/web/src/components/studio-page/component-team-entry-row.tsx | TeamEntryRow | 修改 | 加第三 link「业务全景」（seat-team-entry-panorama） | MUST 与看板/群聊 link 并列；onOpenPanorama prop；hue 待定 | component-team-entry-row.md; 06-studio.md §2.1 | +12 |

## 模块 9: skill — panorama-designer builtin skill

| 模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| skill | app/plugins/builtins/skills/panorama-designer/SKILL.md | (skill content) | 新增 | DSL 规范手册 + 建模模式 + 工作流 + 模板库索引 | MUST frontmatter name=panorama-designer；leader 默认继承（fallback enabled=true） | req.md §6; squad_tools §0 skill 挂载 | +80 |
| skill | app/plugins/builtins/skills/panorama-designer/templates/ci-cd.yaml | (template) | 新增 | CI/CD 种子模板（demo ci-cd.yaml 升格） | MUST 合法 DSL（过四层校验） | req.md §10; demo dsl/ci-cd.yaml | +60 |
| skill | app/plugins/builtins/skills/panorama-designer/templates/team-work.yaml | (template) | 新增 | 团队工作管理模板（goal/kr/req/task 抽象） | MUST 合法 DSL | req.md §10 | +60 |

## 模块 10: squad workspace — 目录骨架 + dissolve 清理

| 模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad/workspace | app/server/src/squad/squad-runtime.ts | dissolveSquad (rmSync) | 修改 | 硬删 squad 时 panorama/ 目录随之删（rmSync 整个 squads/{id}/） | MUST 不单独清 panorama/（整个办公室目录一并删） | data_model.md §1.1; panorama_store.md §1 | +0 |

---

> **planner 切 task 指引**：模块 1-4（dsl/validation/migration/store）是纯后端无 UI 依赖，可并行；模块 5-6（tool/http）依赖 1-4；模块 8（web）依赖 6（API 就绪）但 spec 已就绪可先搭骨架；模块 9（skill）独立；模块 7/10（bootstrap）是 wiring 改动，最后集成。
