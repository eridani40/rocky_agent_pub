# v0.0.215 变更计划书 — head 学生可见性修复（1 mapper + 1 tool）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 背景（一行）

根因=实现偏离 spec：`AcademyContextShape.students`（academy-context.ts:40）build 时已填充但无 mapper 消费；head 无学生 CRUD/版本读取工具。裁决：新 `academy-classroom-students` mapper + head 专属 `manage-student` 工具（9 action）；train-student 保留不动。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-context | app/plugins/builtins/rocky_context/prompt/academy-shared.ts | `AcademyContextLike` | 修改 | students 元素加 `versionIds?: string[]`（版本数来源）；tasks 元素加 `studentId?: string`（在跑任务交叉键）；顶层加 `formalVersionLabels?: Record<string,string>`（versionId→versionLabel） | MUST 只增字段不改既有元素形状（鸭子类型向后兼容） | specs/tech/academy/[P0]session_kind_extension.md §4.1/§5.2 | +6 |
| academy-context | app/server/src/academy/academy-context.ts | `buildAcademyContext()` | 修改 | head 分支：students 拉出后按各自 currentFormalVersionId 逐个 `safe(getVersion)` 解析 versionLabel，组装 formalVersionLabels map 注入返回值 | MUST 用 safe() 容错（单生失败跳过，不阻塞 prompt 组装）；MUST NOT 改 coach/student 分支 | session_kind_extension §5.2（每轮现拉最新 + 容错契约） | +14/-1 |
| academy-mapper | app/plugins/builtins/rocky_context/prompt/academy-classroom-students.ts | `AcademyClassroomStudentsMapper`（default export class） | 新增 | system_prompt_mapper：消费 academyContext.students+tasks+formalVersionLabels，渲染「## 学生名单」（每人：名字/id/当前正式版 label+versionId/版本数/在跑任务 #seq status 轮次）；在跑任务=tasks 中 studentId 匹配且 status ∈ pending/running/awaiting_confirm；空名单渲染「无学生 + create_student 指针」；tier=context，priority=855（assets=860 之后、task_status=850 之前） | MUST 非 academy / 缺 classroomId / students undefined → 返 []（graceful 降级）；MUST NOT throw；结构仿 academy-classroom-assets.ts | session_kind_extension §4.1 + §5（head 拉 students 契约） | +85 |
| academy-mapper | app/plugins/builtins/rocky_context/prompt/academy-classroom-role.ts | `AcademyClassroomRoleMapper.map()` | 修改 | head_teacher 分支身份正文扩为多行：职责（manage-student 管学生+发起训练；train-student accept/reject/stop 审核）+ 训练产出=学生版本五元组（AGENTS.md 系统提示/model 模型/memory 记忆/skills 技能/tools 工具白名单）+ 分工（head 发起+查询+审核，coach 管任务内逐轮推进，不代做） | MUST 三缺（role/classroomId/classroom）仍返 []；MUST NOT 改 coach/student 分支输出（保持单行） | 用户裁决 v0.0.215；session_kind_extension §4.1 | +18/-2 |
| academy-mapper | app/plugins/builtins/rocky_context/plugin.json | extImpls 列表 | 修改 | academy_classroom_assets 条目后插入 academy_classroom_students 条目（point=system_prompt_mapper，impl=./prompt/academy-classroom-students.ts，中文 description） | MUST implId 拼写与 scope yaml 引用逐字一致 | session_kind_extension §4.1「实际注册路径」 | +6 |
| academy-mapper | app/plugins/scopes/academy-head_teacher.parent.main.yaml | groups[0] system_prompt_mapper impls | 修改 | `- academy_classroom_assets` 后插 `- academy_classroom_students`；文件头注释「academy 3 mapper」改 4 | MUST 仅 head scope 注册（coach/student scope 不加） | session_kind_extension §4.1 | +2 |
| academy-core | app/server/src/academy/academy-student-core.ts | `createStudentWithInitialVersion()` | 新增 | 两入口统一核心（HTTP handleCreateStudent + manage-student.create_student 共享，仿 createTrainingTaskAndCoach 模式）：classroom 存在校验 → resolveAcademySessionModel 播种（body.model→classroom.defaultModel→app 默认）→ putStudent → createInitialFormalVersion（0.0 空版）→ 回写 currentFormalVersionId+versionIds → 返 {student, initialVersion} | MUST 从 handleCreateStudent 平移逻辑不改编排；错误抛 StudentCoreError(code)；MUST NOT 依赖 HTTP Request/Response | session_kind_extension §5.0（两入口统一核心模式）；academy-classroom.ts handleCreateStudent 现状 | +75 |
| academy-core | app/server/src/academy/academy-student-core.ts | `StudentCoreDeps` / `CreateStudentCoreInput` / `StudentCoreError` | 新增 | 依赖形 `{academyStore, appConfig, dataDir}`（rtc/AcademyHandlerDeps 双向满足）；入参 `{classroomId, name, logo?, model?}`；coded error（classroom_not_found / model_not_configured / invalid_input） | MUST 与 TrainingCoreDeps 同风格 | academy-training-core.ts §TrainingCoreDeps 模式 | +30 |
| academy-core | app/server/src/handlers/academy-classroom.ts | `handleCreateStudent()` | 修改 | 改为薄壳：解析 body → 调 createStudentWithInitialVersion → StudentCoreError 按 code 映射 HTTP（classroom_not_found=404 / model_not_configured=400 / invalid_input=400）→ 201 {student, initialVersion} | MUST 响应码与响应体形状与现状完全一致（AT 回归不破）；MUST NOT 留旧内联实现（彻底替换，不留僵尸） | delete-old-code-fully-when-replacing 原则；academy-student-core 行 | -45/+18 |
| manage-student-tool | app/server/src/agent/tools/manage-student-tool.ts | `manageStudentTool`（Tool 单例 export） | 新增 | head 专属工具 definition（name/description/intro/inputSchema：action 9 值 enum + studentId/studentName/name/logo/model/versionId/taskId/baseVersionId/mode/optimizeStyle/directive/datasetId/graderId/maxTurns）+ run()：action 校验 → readRuntimeContext → role==='head_teacher' 门 → academyStore/classroomId 注入校验 → dispatch try/catch | MUST role 兜底校验（toolBound 之外的防御，同 manage-classroom）；MUST NOT 给 coach/student 可见（profile.toolBound 裁剪） | session_kind_extension §3.1/§7；仿 manage-classroom-tool.ts | +130 |
| manage-student-tool | app/server/src/agent/tools/manage-student-actions.ts | `runListStudents()` / `runGetStudent()` | 新增 | list_students：listStudentsByClassroom + 可选 name 过滤（先精确 ci 后子串）+ 逐生 enrich（formalVersionId→label、versionIds.length、在跑任务交叉）；get_student：按 studentId 或 studentName 取单生 + 版本摘要 | MUST 名字匹配二段（exact→contains）；匹配不到返空数组不报错 | 用户裁决（list_students 按名字匹配） | +70 |
| manage-student-tool | app/server/src/agent/tools/manage-student-actions.ts | `runCreateStudent()` / `runUpdateStudent()` | 新增 | create_student：name 必填 + 可选 logo/model → createStudentWithInitialVersion 核心 → StudentCoreError 转 errorResult（保 code）；update_student：studentId 必填，getStudent 存在性校验 → strip 信封 → patch name/logo → putStudent | MUST 复用统一核心（MUST NOT 在工具内重写建 0.0 版逻辑）；update 只允许 name/logo | academy-student-core；manage-classroom-tool updateDataset 模式 | +55 |
| manage-student-tool | app/server/src/agent/tools/manage-student-actions.ts | `runDeleteStudent()` | 新增 | studentId 必填 → 存在性校验 → 守卫：该生有 status ∈ pending/running/awaiting_confirm 任务 → 拒绝（提示先 stop）→ 级联硬删：getCrud().deleteAsync 全部 version records + student record + fs.rm(studentRoot(dataDir, cid, sid), recursive) | MUST 有在跑任务必拒绝；MUST description 明示「删学生及全部版本，不可恢复」；MUST NOT 软删（list 侧不过滤 _deleted） | academy-paths.ts studentRoot；CompositeStore.deleteAsync | +45 |
| manage-student-tool | app/server/src/agent/tools/manage-student-actions.ts | `runListVersions()` / `runGetVersion()` | 新增 | list_versions：studentId → listVersions（label/type/status/taskSeq/round）；get_version：versionId → getVersion + resolveVersionContent(workspaceDir) 返五元组：agentsMd 全文 / model=versionJson.model / tools=versionJson.tools / skillNames / memoryFiles（fs.readdir content.memoryDir，catch→[]） | MUST 五元组字段齐（AGENTS.md/model/memory/skills/tools）；缺 version.json → model/tools 返 null 不报错 | academy-version-dir.ts resolveVersionContent §ResolvedVersionContent | +60 |
| manage-student-tool | app/server/src/agent/tools/manage-student-actions.ts | `runStartTraining()` | 新增 | start_training：薄壳调 createTrainingTaskAndCoach（与 train-student.start 同核心）；studentId 或 studentName 解析（歧义返候选列表 errorResult）；baseVersionId 缺省=student.currentFormalVersionId；mode/optimizeStyle 默认与 runStart 一致（multi/training）；复用 train-student-actions 的 buildCoreDeps + coreErrorToResult | MUST 走统一核心（MUST NOT 复制建任务逻辑）；MUST 复用 buildCoreDeps/coreErrorToResult（不另写双份） | session_kind_extension §5.0；train-student-actions.ts runStart | +50 |
| manage-student-tool | app/server/src/agent/tools/manage-student-actions.ts | `runTrainingStatus()` | 新增 | training_status：taskId 给 → task+turns（同 train-student.status 语义）；否则 listTasksByClassroom（可选 studentId/studentName 过滤）按 createdAt 倒序返摘要 [{taskId,taskSeq,studentId,status,currentTurn,maxTurns,directive,acceptedVersionId?}]（head 查「结果」：done→acceptedVersionId 可再 get_version） | MUST 不依赖 trainingEngine（纯 store 读） | 用户裁决（head 不知道结果）；train-student-tool dispatch status 语义 | +40 |
| manage-student-tool | app/server/src/agent/tools/train-student-actions.ts | `buildCoreDeps()` / `coreErrorToResult()` | 修改 | 两私有 helper 加 export（manage-student.start_training 复用同一 TrainingCoreDeps 构造 + TrainingCoreError 映射，防双份漂移） | MUST 只加 export 关键字，不改实现 | train-student-actions.ts:51,62 现状 | +2/-2 |
| manage-student-tool | app/server/src/tools/registry.ts | `defaultTools()` | 修改 | import manageStudentTool（from ../agent/tools/manage-student-tool）+ 注册进默认集（manageClassroomTool 之后）；注释补 v0.0.215 | MUST 可见性由 profile.toolBound 收束（与 manage-classroom 同模式）；MUST NOT 加 toolBound 到 coach/student profile | specs/tech/academy/[P0]train_student_tool.md §6 | +3 |
| manage-student-tool | app/plugins/session-types/academy-head_teacher.parent.main.yaml | toolBound | 修改 | `- manage-classroom` 后加 `- manage-student`（学生管理 + 训练发起） | MUST 仅 head profile；coach/student toolBound 不动 | session_kind_extension §3.1 | +1 |
| spec | specs/tech/academy/[P0]session_kind_extension.md | §3.1 / §4.1 / §5.2 / §7 | 修改 | §3.1 head toolBound 加 manage-student；§4.1 mapper 表加 academy_classroom_students 行（head scope）+ AcademyContextLike 补 formalVersionLabels 说明；§5.2 head 裁剪补「解析正式版 label」；§7 加 manage-student 工具契约段（9 action schema + 权限 + start_training 统一核心 + delete 级联语义） | MUST 契约与本表一致；frontmatter updated 刷新 | 本变更计划书 | +65 |
| spec | specs/tech/academy/[P0]train_student_tool.md | §4 权限矩阵备注 | 修改 | 矩阵下补分工备注：manage-student 是 head 学生 CRUD/版本读取/发起训练/训练查询主入口；train-student 保留 coach 任务内推进 + head 审核（accept/reject/stop/evaluate/status 不动）；两 start 入口同核心 | MUST 不改权限矩阵本身（train-student 保留不动） | 用户裁决 v0.0.215 | +8 |
| test | app/server/src/agent/tools/__tests__/manage-student-tool.test.ts | 全文件 | 新增 | UT：9 action 闭合（invalid action 报错）+ role 门（coach/student forbidden）+ list_students 名字匹配（exact/contains/无匹配）+ create_student 走核心（0.0 版回写）+ update/delete（在跑任务拒绝）+ get_version 五元组字段齐 + start_training 调核心（默认 base=currentFormalVersionId）+ training_status 两形 | MUST mock 层级同 train-student-tool.test.ts（内存 store + fake rtc）；MUST NOT 真调 LLM | train-student-tool.test.ts 现有模式 | +280 |
| test | app/plugins/builtins/rocky_context/prompt/__tests__/academy-mappers.test.ts | 学生名单 + role 用例 | 修改 | +students mapper：名单注入（label/版本数/在跑任务交叉）/空名单/无 academyContext 返 []；+role mapper：head 职责正文含五元组语义、coach/student 输出不变 | MUST 用既有 PromptCtx fixture 模式 | academy-mappers.test.ts 现状 | +90 |

## 影响面评估

- **跨模块**：academy-context（数据装配）→ academy-mapper（prompt 注入）→ academy-core（学生建链统一核心）→ manage-student-tool（9 action）→ 装配层（plugin.json/scope/profile/registry）→ spec。**纯后端 + plugin**，无前端变更、无 API 契约变更（handleCreateStudent 重构保持响应形状）。
- **无破坏性变更**：train-student 不动；manage-classroom 不动；coach/student profile/scope 不动。duck 类型只增字段。
- **依赖顺序**：duck 类型 + buildAcademyContext（底层数据）先于 mapper（消费）；academy-student-core 先于 manage-student-actions.create_student；train-student-actions export 先于 start_training。
- **风险点**：① handleCreateStudent 重构回归 —— 由现有 academy AT（POST student 路径）+ 响应形状约束兜底；② start_training 与 train-student.start 双入口一致性 —— 共享 createTrainingTaskAndCoach + buildCoreDeps 消除；③ plugin.json implId 与 scope yaml 拼写不一致 —— 约束列钉死逐字一致。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
