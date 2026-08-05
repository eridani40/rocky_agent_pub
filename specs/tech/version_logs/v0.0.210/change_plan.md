# v0.0.210 变更计划书 — Academy 全新板块（双引擎 + 3 session-kind + 训练引擎 + UI）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 8 列：模块 / 文件路径 / 函数·符号 / 类型 / 变更内容 / 约束 / 参考 / 影响行。
> 行 = 一个函数/符号（新增 class/interface/type 也各占一行）。

## 总览

本版本是 academy 板块**全新建立**：双引擎架构（agent + 训练引擎）+ 3 新 session-kind（head_teacher/coach/student）+ 6 entity 数据模型 + train-student 单工具多 action + 3 academy skill + squad derive 扩展 + 完整 UI 板块。

工程量极大但高度模块化。变更按子系统组织（shared → server → web → 配置文件 → 内容）。

## 变更清单

### A. shared 类型层（身份枚举扩展）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| shared-types | app/shared/src/types/session-kind.ts | `BizType` | 修改 | 类型扩 `'academy'` 联合值 | MUST 同时扩 validateSessionKind（加 K4 academy 角色 ⇒ biz=academy）；MUST NOT 影响现有 playground/studio | specs/tech/academy/[P0]session_kind_extension.md §1 | +1 |
| shared-types | app/shared/src/types/session-kind.ts | `Role` | 修改 | 类型扩 `'head_teacher' \| 'coach' \| 'student'` 三值 | MUST 保持与 bloodline 规则兼容（subagent 仍可显式指定） | 同上 | +1 |
| shared-types | app/shared/src/types/session-kind.ts | `SessionContext` | 修改 | 加 `classroomId?/studentId?/versionId?/trainingTaskId?` 四字段 | MUST 仅 academy session 填；不破坏现有 squadId/memberId/parentSessionId | 同上 §1.2 | +4 |
| shared-types | app/shared/src/types/session-kind.ts | `validateSessionKind` | 修改 | 加 K4 规则（role ∈ {head_teacher,coach,student} ⇒ biz='academy'） | MUST 在 createSession + spawn 写入路径触发 | 同上 §1.1 | +5 |
| shared-types | app/shared/src/types/session-kind.ts | `validateSessionContext` | 修改 | 加 C4-C7（academy parent ⇒ classroomId 必填；coach ⇒ trainingTaskId；student ⇒ studentId+versionId） | MUST 与 SessionContext 扩字段一致 | 同上 §1.1 | +12 |

### B. server 持久化层（session schema 扩字段 + academy 域 6 entity）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| session-schema | app/server/src/agent/schema_defs/session.ts | `SessionSchema` | 修改 | 加 4 字段 `academyClassroomId/academyStudentId/academyVersionId/academyTrainingTaskId`（ulid, required: false） | MUST 复用 lazy 默认模式（兼容历史 session）； academy session 必填由 validateSessionContext 兜底（schema 层不强制） | specs/tech/academy/[P0]data_model.md §1 + session_kind_extension §1.2 | +24 |
| session-schema | app/server/src/agent/schema_defs/session.ts | `biz.enumValues` | 修改 | enum 加 `'academy'` | MUST 与 BizType 同步 | 同上 | +1 |
| session-schema | app/server/src/agent/schema_defs/session.ts | `role.enumValues` | 修改 | enum 加 `'head_teacher','coach','student'` | MUST 与 Role 同步 | 同上 | +3 |
| academy-schema | app/server/src/academy/schema_defs/classroom.ts | `ClassroomSchema` | 新增 | 教室 entity SchemaDef（id/name/logo/headTeacherSessionId/datasetIds/graderIds/skillIds/archived） | MUST engine='file'；落 `<DATA_DIR>/academy/<cid>/classroom.json` | specs/tech/academy/[P0]data_model.md §2 | +35 |
| academy-schema | app/server/src/academy/schema_defs/student.ts | `StudentSchema` | 新增 | 学生 entity（id/classroomId/name/logo/versionIds/currentFormalVersionId） | MUST 与 classroom 双向关联 | 同上 §3 | +25 |
| academy-schema | app/server/src/academy/schema_defs/student-version.ts | `StudentVersionSchema` | 新增 | 版本 entity（id/studentId/classroomId/versionLabel/type/parentFormalVersionId/taskSeq/roundNumber/createdFromTaskId/workspaceDir/status） | MUST formal/process 二分；workspaceDir 必填 | 同上 §3 | +40 |
| academy-schema | app/server/src/academy/schema_defs/training-task.ts | `TrainingTaskSchema` | 新增 | 训练任务 entity（id/classroomId/studentId/baseVersionId/taskSeq/coachSessionId/mode/optimizeStyle/maxTurns/status/directive/currentTurn/temporaryBaselineVersionId/datasetId/graderId/acceptedVersionId/earlyStopReason） | MUST status enum 闭合 6 值；multi 模式 datasetId/graderId 必填由 handler 校验 | 同上 §4 | +55 |
| academy-schema | app/server/src/academy/schema_defs/training-turn.ts | `TrainingTurnSchema` | 新增 | 单轮 entity（id/taskId/classroomId/studentId/round/candidateVersionId/status/sampleResults/gradeResults/decision/avgScore/reflection） | MUST status enum 闭合 6 值；round 1-based | 同上 §4 | +35 |
| academy-schema | app/server/src/academy/schema_defs/dataset.ts | `DatasetSchema` | 新增 | 数据集 entity（id/classroomId/name/description/items[{id,question,gradingCriteria?,expectedAnswer?}]） | MUST items json 透传；元素结构由 handler 校验 | 同上 §5 | +25 |
| academy-schema | app/server/src/academy/schema_defs/grader.ts | `GraderSchema` | 新增 | 评估器 entity（id/classroomId/name/type/promptTemplate?/providerId?/modelId?/threshold?/matchRule?） | MUST type enum 闭合 `'llm-judge','em'` | 同上 §5 | +35 |

### C. server 持久化层（academy store + 目录工具）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-store | app/server/src/academy/academy-paths.ts | `academyPaths.*` | 新增 | 路径单点：classroomRoot / studentRoot / versionDir(formal) / versionDir(process) / taskRoot / turnPath | MUST 唯一拼接权威源；MUST NOT 散拼字面 ~ | specs/tech/academy/[P0]data_model.md §6.1 | +60 |
| academy-store | app/server/src/academy/academy-version-dir.ts | `copyVersionDir` | 新增 | fork 原语（fs.cp recursive，dst 非空抛错） | MUST 原子语义；MUTEX dst 非空保护 | 同上 §6.1 + 调研 §2 | +25 |
| academy-store | app/server/src/academy/academy-version-dir.ts | `writeVersionDirFiles` | 新增 | 建版本目录 + AGENTS.md + version.json | MUST 写入 4 字段（versionLabel/model/tools 可选） | 同上 | +30 |
| academy-store | app/server/src/academy/academy-version-dir.ts | `resolveVersionContent` | 新增 | 读版本目录五元组单点（agentsMd/skills/memory/versionJson） | MUST 处理 0.0 空版本（graceful） | 同上 | +20 |
| academy-store | app/server/src/academy/academy-store.ts | `AcademyStore` | 新增 | academy 域统一 store facade：CRUD 6 entity + forkVersionWorkspace + adoptToFormal | MUST 单文件 ≤300 行（超则拆 academy-store-classroom/student/task/assets 4 文件） | specs/tech/academy/[P0]data_model.md §6 | +280 |

### D. server 训练引擎（核心）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| training-engine | app/server/src/academy/training-engine.ts | `TrainingEngine` class | 新增 | 训练引擎主入口：startTask/getTaskStatus/stopTask/acceptTask/rejectTask/runTurn/getTurnResult/sampleOneCase/sampleBatch/gradeOneCase/gradeBatch/forkVersion/proposeTask/resumeOnStartup | MUST 单文件 ≤300 行（拆 training-engine.ts 主壳 + sample.ts/grade.ts/gate.ts 子文件）；MUST 状态机推进权归程序不归 agent | specs/tech/academy/[P0]training_engine.md §2 | +280 |
| training-engine | app/server/src/academy/training-engine/sample.ts | `sampleBatch` `sampleOne` | 新增 | 批量 sample（pLimit(5)）+ 单 case 直调 LlmCaller；返回 [{caseId, studentOutput}] | MUST 用 version.json.model；MUST 429/529/503 抛 RateLimitedError | 同上 §5 + specs/tech/academy/[P0]evaluation.md §4 | +80 |
| training-engine | app/server/src/academy/training-engine/grade.ts | `gradeBatch` `gradeOne` | 新增 | 批量 grade + 单 case（em 纯函数 / llm-judge 直调）；返回 [{caseId, score, level, reasoning}] | MUST reasoning 必填；MUST type='em' 不调 LLM | 同上 + evaluation §2 | +120 |
| training-engine | app/server/src/academy/training-engine/gate.ts | `acceptGate` `checkEarlyStop` | 新增 | 纯函数 hill-climbing gate（candidateAvg vs baselineAvg）+ 早停检查（连续 3 轮无 improve） | MUST 纯函数（可单测）；MUST NOT 混进 LLM | 同上 §4 | +30 |
| training-engine | app/server/src/academy/training-engine/messages.ts | `buildTurnDoneMessage` `buildResumeMessage` `buildResumeNeedManualMessage` `buildProposedMessage` | 新增 | 构造 deliverTo 推送的 a2a 消息信封 | MUST sender.source='agent'；MUST ref='academy-training-engine'；needReply=true | 同上 §7 + multi_agent/[P1]a2a_protocol | +60 |
| session-task-lock | app/server/src/agent/session-task-lock.ts | `acquire` `release` | 修改 | lock type 加 `'training-turn'`（per-task lock 防并发推进） | MUST 复用现有 SessionTaskLock 机制（不新发明） | specs/tech/agent/session/[P0]session_task_lock.md | +5 |

### E. server 训练引擎（装配与启动）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bootstrap | app/server/src/bootstrap-store-phase.ts | bootstrapStores | 修改 | 装配 AcademyStore（注册 6 entity CrudStore schema） + AcademyPaths | MUST 在 SessionStore 之后（依赖 dataDir 已展开） | specs/tech/academy/[P0]data_model.md §6 | +15 |
| bootstrap | app/server/src/bootstrap.ts | bootstrap | 修改 | 装配 TrainingEngine（注入 AcademyStore + LlmCaller + AgentManager + SessionStore）；暴露 `app.trainingEngine` | MUST 在 AgentManager + LlmCaller 之后 | specs/tech/academy/[P0]training_engine.md §2 | +20 |
| bootstrap | app/server/src/bootstrap.ts | `trainingEngine.resumeOnStartup()` | 修改 | bootstrap 末尾调用（断点续跑：扫 status=running 的 task，推进或恢复） | MUST 在所有装配完成后；MUST NOT 阻塞启动太久（异步发起即可） | specs/tech/academy/[P0]training_engine.md §6 | +5 |

### F. server 工具层（train-student + manage-classroom）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| train-tool | app/server/src/agent/tools/train-student-tool.ts | `trainStudentTool` | 新增 | 单工具 13 action（start/status/stop/accept/reject/run_turn/turn_result/sample/grade/fork/propose/read_dataset/read_grader）；LLM-facing schema + handler 入口分发 + role 权限校验 | MUST action 闭合 13 值；MUST role≠head/coach 时 tool_not_allowed；MUST 单文件 ≤300 行 | specs/tech/academy/[P0]train_student_tool.md §1/§3/§4 | +280 |
| train-tool | app/server/src/agent/tools/train-student-tool.ts | `executeTrainStudentAction` | 新增 | 内部分发到 TrainingEngine 对应方法（按 action switch） | MUST 每个分支只调引擎单方法；MUST NOT 在工具层做状态机逻辑 | 同上 + training_engine.md | (含在上面) |
| manage-tool | app/server/src/agent/tools/manage-classroom-tool.ts | `manageClassroomTool` | 新增 | head 独有工具：add_dataset/update_dataset/delete_dataset/list_datasets/add_grader/update_grader/delete_grader/list_graders/install_skill | MUST 仅 head 可见（profile.toolBound 仅含）；MUST action 校验闭合 | specs/tech/academy/[P0]train_student_tool.md §7 + session_kind_extension §3.1 | +220 |
| tool-registry | app/server/src/tools/registry.ts | `defaultTools` | 修改 | 注册 trainStudentTool + manageClassroomTool 到默认集 | MUST 可见性由 profile.toolBound 收束（与 skill_manage 等同模式） | specs/tech/academy/[P0]session_kind_extension §3.1 | +4 |

### G. server HTTP 层（handlers + routes）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| handler | app/server/src/handlers/academy-classroom.ts | `handleClassroomCollection` `handleClassroomItem` | 新增 | POST/GET/PATCH /academy/classroom + POST/GET /academy/classroom/:cid/student | MUST 建教室事务原子（classroom + head session + workspace 三件套）；失败补偿回滚 | specs/api/overall/18-academy.md §1.1-1.7 | +180 |
| handler | app/server/src/handlers/academy-student.ts | `handleStudentItem` `handleVersionContent` `handleVersionUpdate` `handleVersionSession` | 新增 | GET/PATCH student/version + POST version/session（启动 student session） | MUST formal 版本可编辑；process 只读；MUST version.json.tools 走 subAgentConfig 装配 | specs/api/overall/18-academy.md §1.8-1.10 | +150 |
| handler | app/server/src/handlers/academy-training-task.ts | `handleTrainingTaskCreate` `handleTrainingTaskDetail` `handleRunTurn` `handleAccept` `handleReject` `handleStop` `handleInjectDirective` | 新增 | POST /training-task + GET /:tid + POST /:tid/run-turn/accept/reject/stop/inject-directive | MUST accept 事务原子（adopt 新 formal version + task.acceptedVersionId 落盘）；并发用 task lock | specs/api/overall/18-academy.md §2 | +220 |
| handler | app/server/src/handlers/academy-assets.ts | `handleDatasetCollection` `handleDatasetItem` `handleGraderCollection` `handleGraderItem` | 新增 | CRUD dataset + grader | MUST items 全量替换（不做增量 diff）；type 闭合 enum 校验 | specs/api/overall/18-academy.md §3 | +180 |
| handler | app/server/src/handlers/session.ts | `handleSessionCollection` | 修改 | biz 过滤扩 `'academy'`（`bizParam === 'academy'` → bizFilter='academy'） | MUST 缺省/非法值仍走 playground（现状不变） | specs/tech/academy/[P0]session_kind_extension §8 | +3 |
| route | app/server/src/routes/academy-routes.ts | `registerAcademyRoutes` | 新增 | 注册所有 /academy/* 路由到 router | MUST 注入 AcademyHandlerDeps（academyStore + trainingEngine + agentManager） | specs/api/overall/18-academy.md | +60 |
| route | app/server/src/router.ts | `registerRoutes` | 修改 | 调 registerAcademyRoutes | MUST 在 session/squad 路由之后 | 同上 | +3 |
| member-service | app/server/src/services/member-service.ts | `CreateMemberInput` | 修改 | mode 加 `'derive_academy'`；加 `academySource?: {classroomId,studentId,versionId}` | MUST mode='derive_academy' 时 academySource 必填；MUST NOT 影响现有 fresh/derive | specs/tech/academy/[P1]squad_derive §2.1 | +8 |
| member-service | app/server/src/services/member-service.ts | `resolveEffective` | 修改 | 加 derive_academy 分支（校验 academySource.versionId 是 formal + active） | MUST 失败 throw DeriveSourceNotFoundError（404） | 同上 §2.2 | +30 |
| member-service | app/server/src/services/member-service.ts | `createMemberService` | 修改 | step 7.5 加 `seedMemberWorkspaceFromVersion` 调用（mode='derive_academy' 时） | MUST 在 ensureMemberWorkspaceDir 之后；失败补偿回滚（删已复制文件） | 同上 §2.3 | +12 |
| member-bridge | app/server/src/services/member-academy-bridge.ts | `seedMemberWorkspaceFromVersion` `copyDirRecursive` | 新增 | 从版本目录复制 AGENTS.md + .rocky/skills/ + .rocky/memory/ 到 member workspace | MUST 不复制 version.json（mate session model 走 squad）；MUST source 无 AGENTS.md 静默跳过（学生 0.0 版本） | specs/tech/academy/[P1]squad_derive §2.4 | +60 |
| handler | app/server/src/handlers/member.ts | member create handler | 修改 | body.mode 接受 'derive_academy'；body.academySource 校验；error code 400 invalid_academy_source | MUST 错误响应与现有 fresh/derive 一致结构 | specs/api/overall/11a-squad-endpoints.md | +15 |

### H. 配置文件（profile + scope yaml 矩阵）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| profile-yaml | app/plugins/session-types/academy-head_teacher.parent.main.yaml | (yaml 文件) | 新增 | head profile（extends default, toolBound 含 train-student/manage-classroom/agent 等） | MUST toolBound 含 21 工具 + 2 academy；MUST autoNaming=false | specs/tech/academy/[P0]session_kind_extension §3.1 | +35 |
| profile-yaml | app/plugins/session-types/academy-head_teacher.parent.summary.yaml | (yaml) | 新增 | summary runKind（extends summary） | MUST 矩阵完整性（validator validateMainMatrix） | 同上 §3.4 | +3 |
| profile-yaml | app/plugins/session-types/academy-head_teacher.parent.consolidate.yaml | (yaml) | 新增 | consolidate runKind（extends consolidate） | 同上 | +3 |
| profile-yaml | app/plugins/session-types/academy-coach.parent.main.yaml | (yaml) | 新增 | coach profile（含 train-student 但不含 manage-classroom；不含 start/accept/reject action 权限由工具层校验） | MUST toolBound 含 train-student；MUST 不含 manage-classroom | 同上 §3.2 | +28 |
| profile-yaml | app/plugins/session-types/academy-coach.parent.summary.yaml | (yaml) | 新增 | 同 head 模式 | 同上 | +3 |
| profile-yaml | app/plugins/session-types/academy-coach.parent.consolidate.yaml | (yaml) | 新增 | 同上 | +3 |
| profile-yaml | app/plugins/session-types/academy-student.parent.main.yaml | (yaml) | 新增 | student profile（学习工具子集；无 write/edit/agent/train-student） | MUST toolBound 9 工具（read/glob/grep/bash/skill/memory/web_search/web_fetch/see_image） | 同上 §3.3 | +20 |
| profile-yaml | app/plugins/session-types/academy-student.parent.summary.yaml | (yaml) | 新增 | 同上 | +3 |
| profile-yaml | app/plugins/session-types/academy-student.parent.consolidate.yaml | (yaml) | 新增 | 同上 | +3 |
| scope-yaml | app/plugins/scopes/academy-head_teacher.parent.main.yaml | (yaml) | 新增 | head scope（含 academy 5 mapper：classroom_role/training_directive/iteration_state/classroom_assets/task_status） | MUST 与 profile 同 id 同名；MUST extends default | 同上 §4 | +25 |
| scope-yaml | app/plugins/scopes/academy-head_teacher.parent.summary.yaml | (yaml) | 新增 | extends summary | +3 |
| scope-yaml | app/plugins/scopes/academy-head_teacher.parent.consolidate.yaml | (yaml) | 新增 | extends consolidate | +3 |
| scope-yaml | app/plugins/scopes/academy-coach.parent.main.yaml | (yaml) | 新增 | coach scope（含 training_directive/iteration_state/subagent_tree） | +25 |
| scope-yaml | app/plugins/scopes/academy-coach.parent.summary.yaml | (yaml) | 新增 | +3 |
| scope-yaml | app/plugins/scopes/academy-coach.parent.consolidate.yaml | (yaml) | 新增 | +3 |
| scope-yaml | app/plugins/scopes/academy-student.parent.main.yaml | (yaml) | 新增 | student scope（极简：identity + tools） | +15 |
| scope-yaml | app/plugins/scopes/academy-student.parent.summary.yaml | (yaml) | 新增 | +3 |
| scope-yaml | app/plugins/scopes/academy-student.parent.consolidate.yaml | (yaml) | 新增 | +3 |
| mapper-impl | app/plugins/impls/system-prompt-mapper/academy-classroom-role.ts | `academyClassroomRoleMapper` | 新增 | 教室身份正文 mapper（"你是 X 教室的班主任/教练/学生"） | MUST 实现 PromptMapper 接口；MUST 从 sessionContext 读 classroomId → academyStore.getClassroom | specs/tech/academy/[P0]session_kind_extension §4.1 | +35 |
| mapper-impl | app/plugins/impls/system-prompt-mapper/academy-training-directive.ts | `academyTrainingDirectiveMapper` | 新增 | 透传 task.directive 进 coach prompt | MUST 从 sessionContext.trainingTaskId → academyStore.getTask | 同上 | +25 |
| mapper-impl | app/plugins/impls/system-prompt-mapper/academy-iteration-state.ts | `academyIterationStateMapper` | 新增 | 当前轮次 + 临时基线 + 历史摘要进 coach prompt | MUST 从 task + listTurns 派生 | 同上 | +40 |
| mapper-impl | app/plugins/impls/system-prompt-mapper/academy-classroom-assets.ts | `academyClassroomAssetsMapper` | 新增 | 教室数据集/评估器/skill 概览进 head prompt | MUST 从 classroom.datasetIds/graderIds 派生 | 同上 | +30 |
| mapper-impl | app/plugins/impls/system-prompt-mapper/academy-task-status.ts | `academyTaskStatusMapper` | 新增 | 教室下所有任务状态（任务级看板）进 head prompt | MUST listTasksByClassroom | 同上 | +35 |
| plugin-config | app/plugins/impls/groups.json | groups.'system-prompt'.points | 修改 | 加挂载 academy 5 mapper impl（在 academy-* scope 才激活） | MUST 不影响 default/playground/studio scope | 同上 §4 | +10 |
| build-plugins | scripts/build-plugins.ts | `copyResources` | 修改 | 拷贝 academy session-types/*.yaml + scopes/*.yaml + skills/academy-* 到 dist | MUST 持续可打包护栏 §2 BUG-003（dev 测不到 packaged 缺失） | specs/tech/academy/[P0]session_kind_extension §11 | +3 |

### I. academy skills（builtin 资源）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-skill | app/plugins/skills/academy-learn-skill/SKILL.md | (md 文件) | 新增 | 学习式优化方法论（拆 directive → web_search → 提炼 → 修订） | MUST frontmatter 含 name/description/allowed-tools；evolvable=false（防递归） | specs/tech/academy/[P0]academy_skills.md §3 | +80 |
| academy-skill | app/plugins/skills/academy-train-skill/SKILL.md | (md 文件) | 新增 | 训练式优化方法论（分类正负例 → 反思 → 修订 → 拒绝记忆） | MUST 同上；含拒绝记忆范式（borrow skillopt） | 同上 §4 | +80 |
| academy-skill | app/plugins/skills/academy-judge-skill/SKILL.md | (md 文件) | 新增 | 评估器编写参考（promptTemplate 结构 + 陷阱 + rubric 示例） | MUST head workspace 默认加载（builtin 层） | 同上 §5 | +60 |

### J. web 前端（板块接入 + 组件）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| view-store | app/web/src/store/view-store.ts | `ViewId` | 修改 | 加 `'academy'` 联合值 | MUST 默认值不变（playground 保持默认） | specs/tech/app/frontend/[P0]academy_component_architecture.md §2 | +1 |
| nav-rail | app/web/src/components/framework/nav-rail/nav-rail.tsx | nav-rail component | 修改 | 顶部业务区从 2 项扩为 3 项（+ Academy 🎓） | MUST 复用现有 nav-item 样式 | 同上 | +5 |
| app-shell | app/web/src/components/framework/app-shell/app-shell.tsx | MainView union | 修改 | 加 academy 分支 → 路由到 page-academy.tsx | MUST 不影响 playground/studio 分支 | 同上 | +3 |
| chat-slice | app/web/src/store/chat-slice.ts | `fetchAcadamySessions` action | 新增 | 拉 `?biz=academy` 或 `?classroomId=` session 列表 | MUST 复用现有 fetchSessions 模式 | specs/tech/academy/[P0]session_kind_extension §8 | +30 |
| chat-detail | app/web/src/components/chat-page/section-chat-detail.tsx | readOnly 判定 | 修改 | 扩为 `derivation==='subagent' ∨ ?readOnly=1 query ∨ observerMode 字段` | MUST design §8 「任意 session 只读」通用模式 | 同上 §2 | +10 |
| academy-page | app/web/src/components/academy-page/page-academy.tsx | `PageAcademy` | 新增 | 板块入口：路由分发到各 section + 订阅 session 列表 | MUST 单文件 ≤300 行 | specs/tech/app/frontend/[P0]academy_component_architecture.md §1 | +180 |
| academy-page | app/web/src/components/academy-page/section-classroom-list.tsx | `SectionClassroomList` | 新增 | 教室列表 + 资源概览 sidebar | MUST 复用现有 sidebar 模式 | 同上 | +180 |
| academy-page | app/web/src/components/academy-page/section-classroom-detail.tsx | `SectionClassroomDetail` | 新增 | 左 head 对话（BaseChatPage）+ 右学生/资源 | MUST 复用 BaseChatPage（不创新 chat 设计） | 同上 | +220 |
| academy-page | app/web/src/components/academy-page/section-student-detail.tsx | `SectionStudentDetail` | 新增 | 版本树 + 版本卡 | MUST formal 加粗、process 灰显 | 同上 | +180 |
| academy-page | app/web/src/components/academy-page/section-training-observe.tsx | `SectionTrainingObserve` | 新增 | coach 对话 + 训练视图（task 状态 + timeline + case 表 + 反思 + subagent 入口） | MUST 复用 BaseChatPage；右侧视图 ~520px 宽；subagent 入口仅 working 可点 | 同上 + design §8.4-8.5 | +280 |
| academy-page | app/web/src/components/academy-page/section-training-result.tsx | `SectionTrainingResult` | 新增 | 采纳 diff 页（三段 diff 可展开） | MUST skill 支持整体新增 or 文件级 diff | 同上 + design §8.9 | +220 |
| academy-page | app/web/src/components/academy-page/section-version-chat.tsx | `SectionVersionChat` | 新增 | 学生版本会话（复用 playground-rocky 设计） | MUST 去掉自定义右面板；memory 入口右上悬浮菜单 | 同上 + design §8.3 | +180 |
| academy-page | app/web/src/components/academy-page/component-classroom-card.tsx | (component) | 新增 | 教室卡片 | - | 同上 | +60 |
| academy-page | app/web/src/components/academy-page/component-student-card.tsx | (component) | 新增 | 学生卡片 | - | +60 |
| academy-page | app/web/src/components/academy-page/component-version-tree.tsx | (component) | 新增 | 版本树（平铺+based-on 文案） | MUST 复用 v0.0.203 平铺规范 | +100 |
| academy-page | app/web/src/components/academy-page/component-training-status-bar.tsx | (component) | 新增 | 任务状态条 | - | +60 |
| academy-page | app/web/src/components/academy-page/component-iteration-timeline.tsx | (component) | 新增 | 多轮迭代卡（倒序+折叠+三色 tag） | MUST 复用旧 widget-iteration-timeline 设计 | +120 |
| academy-page | app/web/src/components/academy-page/component-case-table.tsx | (component) | 新增 | case 评估结果表 | MUST 复用旧 drawer-eval-records 设计 | +80 |
| academy-page | app/web/src/components/academy-page/component-score-curve.tsx | (component) | 新增 | 评分走势折线图 | - | +60 |
| academy-page | app/web/src/components/academy-page/component-diff-viewer.tsx | (component) | 新增 | 三段 diff + 可展开关闭 | MUST 复用旧 widget-patch-diff 设计 | +150 |
| academy-page | app/web/src/components/academy-page/component-subagent-tree.tsx | (component) | 新增 | subagent 树（working 入口） | MUST 复用旧 component-subagent-tree 设计 | +100 |
| academy-page | app/web/src/components/academy-page/component-modal-md-editor.tsx | (component) | 新增 | 统一 md 弹层（view/edit 切换） | MUST 未来提取为 common 通用组件 | +150 |
| academy-page | app/web/src/components/academy-page/component-derive-academy-picker.tsx | (component) | 新增 | squad 派生时二级 select（classroom→student→version） | MUST 融入现有 member-create 流程 | +80 |
| academy-page | app/web/src/components/academy-page/primitive-academy-tab.tsx | (primitive) | 新增 | 通用 tab | - | +40 |
| academy-page | app/web/src/components/academy-page/primitive-status-badge.tsx | (primitive) | 新增 | 状态标签 | - | +40 |
| squad-create-modal | app/web/src/components/studio-page/component-new-squad-modal.tsx（或对应 member-create 入口） | member create form | 修改 | Fresh/Derive 选项加「From Classroom」radio card + 二级 select | MUST 不破坏现有 fresh/derive 流程 | specs/tech/academy/[P1]squad_derive §4 | +30 |
| i18n | app/web/src/locales/{zh,en}.json | (json) | 修改 | 加 academy.* 命名空间 key（中英文同步） | MUST i18n-key-add-checklist memory（缺 key 渲染【资源X不存在】） | 同上 | +60 |

### K. 单元测试覆盖

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| test | app/server/src/academy/__tests__/academy-store.test.ts | (test) | 新增 | academy store CRUD + forkVersionWorkspace + adoptToFormal | MUST 覆盖 6 entity + 不变量（formal/process 二分；adopt 复制不 rename） | specs/tech/academy/[P0]data_model.md §8 | +200 |
| test | app/server/src/academy/__tests__/gate.test.ts | (test) | 新增 | acceptGate 纯函数（improve/regress/equal 三分支） + checkEarlyStop（连续 3 轮无 improve） | MUST 纯函数单测（无 LLM mock） | specs/tech/academy/[P0]training_engine.md §4 | +60 |
| test | app/server/src/academy/__tests__/training-engine.test.ts | (test) | 新增 | runTurn 流程（mock LlmCaller）+ 状态机 + 早停 + maxTurns | MUST mock LlmCaller 返固定 sample/grade 结果 | 同上 | +250 |
| test | app/server/src/agent/tools/__tests__/train-student-tool.test.ts | (test) | 新增 | 工具 13 action 分发 + role 权限矩阵 | MUST 覆盖 head/coach/student 三 role × 13 action 权限表 | specs/tech/academy/[P0]train_student_tool.md §4 | +180 |
| test | app/server/src/services/__tests__/member-service-academy.test.ts | (test) | 新增 | createMemberService derive_academy 模式（含 seedMemberWorkspaceFromVersion） | MUST 验证 AGENTS.md/skills/memory 复制；MUST 验证 process 版本拒绝派生 | specs/tech/academy/[P1]squad_derive §5 | +120 |
| test | app/server/src/handlers/__tests__/academy-classroom.test.ts | (test) | 新增 | POST/GET/PATCH classroom 事务（含 head session 自动建 + 补偿回滚） | MUST 验证 classroom.headTeacherSessionId ↔ session 双向关联 | specs/api/overall/18-academy.md §1 | +150 |

## 影响面评估

### 跨模块影响

- **shared 类型 → server schema → handlers → web**：BizType/Role/SessionContext 扩字段自顶向下传播；改变 enum 闭合值需同步所有消费者。
- **profile/scope yaml 矩阵**：18 个新 yaml 文件 + 5 个 mapper impl；validator 启动期校验闭合（不闭合硬失败）。
- **build-plugins copyResources**：必须拷贝 academy 相关 yaml/skills 到 packaged dist；dev 测不到 packaged 缺失（持续可打包护栏）。
- **squad 域受影响最小**：只动 CreateMemberInput（加第 3 mode）+ createMemberService step 7.5 + handler；不动 squad 核心 schema。

### 破坏性变更

- `BizType` / `Role` 联合值扩：现有代码用 `switch(role)` 的位置编译期会报 non-exhaustive（TS 强制处理新值）；这是好事（强制开发者考虑 academy 分支）。
- `validateSessionKind` 加 K4：现有 playground/studio session 不受影响（K4 只对 academy 角色 trigger）。
- `defaultTools` 加 2 工具：现有 profile.toolBound 不含 train-student/manage-classroom → resolveToolSet 自动裁剪 → LLM 看不到 → 行为不变。

### 依赖顺序（底层先于上层）

1. shared 类型（A）
2. server schema（B）
3. server store/paths/version-dir 工具（C）
4. server training-engine 核心（D）
5. server 工具层 train-student/manage-classroom（F）— 依赖 D
6. server handlers + routes（G）— 依赖 B/C/D/F
7. server squad bridge（G 末段）— 依赖 C
8. server bootstrap 装配（E）— 依赖 C/D/F
9. profile/scope yaml + mapper impl + build-plugins（H）— 配置层
10. academy skills 内容（I）— 资源层
11. web 前端（J）— 依赖 G 契约 frozen
12. 单元测试（K）— 与对应模块并行

### 风险点

1. **academy session 与 playground/studio 列表过滤**：必须保证 `?biz=academy` 隔离，不污染 playground/studio UI（C4 校验 + handler biz 过滤）。
2. **任务状态机并发**：per-task lock 必须有效（防 coach 重入）；同时跑多任务时不同 task 不互锁。
3. **评估 fan-out 性能**：N case × 2 次 LLM 调用（sample + grade）；pLimit(5) 控制并发但单 task 仍可能跑数分钟；UI 进度反馈不能依赖完成（要中间态）。
4. **fork/adopt 原子性**：fs.cp recursive 中途失败 → 留半成品目录；要补偿删除（adoptToFormal 内部 try/catch）。
5. **packaged app 工作目录展开**：路径必须绝对化（academy-paths 单点 + resolveDataDir）；持续可打包护栏 §4 BUG-004。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- spec 落后引起的 API/enum/路径漂移 → coder 按代码实际调整 + 汇报偏离 → orchestrator 记 doc-sync 待办 → doc-modifier 阶段 5 统一修 spec
