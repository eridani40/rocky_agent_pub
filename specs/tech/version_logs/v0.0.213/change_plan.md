# v0.0.213 变更计划书 — coach 训练闭环 + 任务牵引 + 两入口统一

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 8 列：模块 / 文件路径 / 函数·符号 / 类型 / 变更内容 / 约束 / 参考 / 影响行。行 = 一个函数/符号。
>
> 权威输入：`reqs/[working] v0.0.213.coach/diagnosis.md`（架构决策已用户拍板）。本表落地决策 1-5 的全部改动点。

## 总览

修复 academy coach 训练闭环断裂：candidate 是 base 空副本从未被修订（假迭代）+ coach 无任务牵引 + 加载不到 train-skill + cwd 错位 + 两入口未统一 + 版本号 4 段 bug。

核心重构：
1. **训练闭环改 coach 主导**：引擎废弃 run_turn 自动一气呵成，改为暴露 `evaluate`/`revise`/`fork` 原子 action；coach 按任务书自主驱动；acceptGate 基线语义修正（首次候选直接采纳不比）。
2. **任务牵引**：coach 创建时投递富任务书 initial user message（硬骨架 + directive 透传）；system prompt 补稳定教练职责/工作流 mapper。
3. **两入口统一**：抽 `createTrainingTaskAndCoach` 核心函数，HTTP handler + head 工具 start 都调它（消除 train-student-actions.ts:81-103 占位偏离）。
4. **train-skill 可见**：academy skills 从 `app/plugins/skills/` 移到 `app/plugins/builtins/skills/`（builtin 扫描根，dev/打包一致可见）。
5. **版本号 3 段化**：`{base顶层major}.{taskSeq}.{round}`，修 forkVersionWorkspace label 拼接 bug。

工程量中等，高度模块化。改动按子系统组织（schema → store → 引擎 → 消息 → 核心入口 → 工具 → mapper → skills）。

## 变更清单

### A. 数据模型（task 加 candidateVersionId）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-schema | app/server/src/academy/schema_defs/training-task.ts | `TrainingTaskSchema.fields.candidateVersionId` | 新增 | task 加 `candidateVersionId`（ulid, required: false）= 当前 coach 在改的候选过程版本 id（round 推进时由引擎更新） | MUST 与 temporaryBaselineVersionId 区分：candidate=coach 正在编辑的待评版本，baseline=当前最优已采纳版本；MUST NOT 让两者初始相同语义混淆（初始时 candidate=fork 自 base 的 round1 副本，baseline=baseVersionId） | diagnosis §1.2/§1.6；data_model §4 | +2 |

### B. store ops（版本号 3 段化）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-store-ops | app/server/src/academy/academy-store-ops.ts | `forkVersionWorkspace` | 修改 | process 版本 label 改 3 段：`${baseMajor}.${taskSeq}.${round}`，其中 `baseMajor = baseVersion.versionLabel.split('.')[0] ?? '0'`（不拼完整 base label） | MUST 恒 3 段（基于 0.0 → 0.{taskSeq}.{round}）；MUST NOT 拼完整 base.versionLabel（4段 bug 根因）；dst 目录路径仍用 base.versionLabel 全段（路径唯一性，不变） | diagnosis §1.7/§2.5；data_model §6.1 | +3/-1 |

### C. 训练引擎（废弃 runTurn 自动循环 → evaluate/revise/forkCandidate 原子化）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| training-engine | app/server/src/academy/training-engine.ts | `runTurn` | 删除 | 废弃 runTurn + runTurnInternal 自动一气呵成（fork→sample→grade→decide→promote）—— coach 主导模型下无自动 loop | MUST NOT 留死代码/僵尸入口；删后 train-student enum 同步去 run_turn（见 F） | diagnosis §2.决策1；training_engine §3 | -120 |
| training-engine | app/server/src/academy/training-engine.ts | `runTurnInternal` | 删除 | 同上（runTurn 内部主逻辑） | MUST 同 runTurn 一起删 | 同上 | -45（含 runTurn） |
| training-engine | app/server/src/academy/training-engine.ts | `sampleAndGrade` | 删除 | 私有 sample+grade 编排（runTurn 专用，evaluate/revise 各自重组） | MUST NOT 保留——evaluate/revise 复用 sampleBatch/gradeBatch 子模块而非此私有方法 | 同上 | -55 |
| training-engine | app/server/src/academy/training-engine.ts | `getBaselineScore` | 删除 | 旧基线分查询（首次返 0 致恒 improve） | MUST 由 reviseBaselineAvg（gate.ts，C 新增）替代，语义重定义 | diagnosis §1.2/§2.决策1 | -12 |
| training-engine | app/server/src/academy/training-engine.ts | `promoteCandidate` | 删除 | 私有候选晋升（runTurn 专用，revise 内联） | MUST NOT 保留 | 同上 | -8 |
| training-engine | app/server/src/academy/training-engine.ts | `evaluateVersion` | 新增 | 原子 action：对指定 versionId 做 sample+grade（直调 LlmPort pLimit），返 `{ versionId, samples, grades, avgScore }`；纯查询不改 task/turn 状态、不落 turn record | MUST 无副作用（coach 用它探查 base/candidate 表现）；MUST 复用 sampleBatch + gradeBatch 子模块；MUST 复用 per-task lock 防与 revise 并发 | diagnosis §2.决策1；training_engine §5；train_student_tool §2 | +45 |
| training-engine | app/server/src/academy/training-engine.ts | `reviseCandidate` | 新增 | 原子 action：sample+grade 当前 `task.candidateVersionId`（coach 已编辑）→ acceptGate 对比 baseline → improve 则晋升（temporaryBaselineVersionId=candidate）并 fork 下一轮新 candidate（candidateVersionId 更新）→ 落 turn record（round/candidateVersionId/sampleResults/gradeResults/avgScore/decision/status）→ 早停/maxTurns 触发 propose → deliverTo coach revise 结果（含 reasoning） | MUST acceptGate baseline 取 reviseBaselineAvg（gate.ts）；MUST 首次候选（无 baseline 历史）直接采纳不比（decision='improve'）；MUST NOT 绕过 forkVersionWorkspace 直接改 candidate 目录；MUST per-task lock；return Promise&lt;TurnResult&gt; | diagnosis §2.决策1；training_engine §3/§4 | +95 |
| training-engine | app/server/src/academy/training-engine.ts | `forkCandidate` | 新增 | 原子 action：fork 新 candidate workspace（自 temporaryBaselineVersionId 或入参 baseVersionId）→ 更新 task.candidateVersionId；coach 显式「废弃当前候选重头来」用 | MUST 用 forkVersionWorkspace（INV-5 原子）；MUST 新 candidate 是唯一 process 版本（唯一 round 避免目录撞）；MUST NOT 删旧 candidate（INV-6 保留可回看） | diagnosis §2.决策1；data_model §6/§8 | +30 |
| training-engine | app/server/src/academy/training-engine.ts | `proposeTask`/`acceptTask`/`rejectTask`/`stopTask`/`resumeOnStartup` | 修改 | 保留委派 lifecycle.ts（无语义变更）；resumeOnStartup 改推 buildResumeMessage（不变）但去掉 awaiting_revision 相关措辞（若有） | MUST NOT 改 lifecycle 状态机语义 | training_engine §6 | +0 |
| training-engine | app/server/src/academy/training-engine/gate.ts | `acceptGate` | 修改 | 纯函数不变（hill-climbing candidateAvg vs baselineAvg）；补充注释说明 baseline 来源由 reviseBaselineAvg 解析 | MUST 保持纯函数可单测 | training_engine §4 | +3 |
| training-engine | app/server/src/academy/training-engine/gate.ts | `reviseBaselineAvg` | 新增 | 纯函数：从 task + 历史 turns 解析 baseline avgScore——若 task.temporaryBaselineVersionId === task.baseVersionId（从未采纳过过程版）→ 返 undefined（表「无历史，首次候选直接采纳」）；否则返最近一次 candidateVersionId===temporaryBaselineVersionId 且 decision='improve' 的 turn.avgScore | MUST 纯函数；MUST 返 undefined 时 revise 走「首次采纳」分支不比 | diagnosis §2.决策1；training_engine §4 | +18 |

### D. 消息（任务书富化 + revise 结果回推）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| training-engine | app/server/src/academy/training-engine/messages.ts | `buildTaskStartedMessage` | 修改 | 重命名/重写为 `buildTaskBookMessage(payload, coachSessionId)`：富任务书——任务框架（学生名+base label+mode+optimizeStyle+maxTurns）+ 学生上下文（base AGENTS.md 全文 + version.json.model）+ candidate workspace 绝对路径（coach 要改的目标）+ dataset/grader 配置名（multi）+ directive 透传 + 工作流指引（读 train-skill → evaluate base → 反思 → edit candidate → revise → 循环 → propose）+ train-student action 说明（evaluate/revise/fork/propose 入参产出） | MUST 含 task.id（coach 调各 action 的 taskId）；MUST 含 candidate workspaceDir 绝对路径；MUST sender.source='system'/kind='academy-training-engine'/metadata.needReply=true（沿用 makeAcademyMessage）；MUST NOT 把 directive 写死（透传 payload） | diagnosis §2.决策2；training_engine §7 | +60/-20 |
| training-engine | app/server/src/academy/training-engine/messages.ts | `TaskBookPayload` | 新增 | interface：task + classroom + student + baseVersion{id,label,agentsMd,model} + candidateVersion{id,workspaceDir} + dataset?/grader? + directive? | MUST 形状供 buildTaskBookMessage 消费；MUST agentsMd 字段含 base 全文（coach 对照修订） | 同上 | +12 |
| training-engine | app/server/src/academy/training-engine/messages.ts | `buildTurnDoneMessage` | 修改 | 重写为 `buildReviseResultMessage(task, turn, coachSessionId)`：revise 后回推——本轮 candidateVersionId + avgScore + decision（improve 已晋升+fork 新 candidate / regress 保留候选）+ 新 candidate workspaceDir（improve 时）+ 各 case reasoning 摘要（coach 反思依据）+ 下一步建议（继续 edit+revise 或 propose） | MUST 含 reasoning 摘要（coach 反思必需）；MUST improve 时给新 candidate workspaceDir | diagnosis §2.决策1；training_engine §7 | +35/-15 |
| training-engine | app/server/src/academy/training-engine/messages.ts | `buildProposedMessage`/`buildResumeMessage`/`buildResumeNeedManualMessage`/`makeAcademyMessage` | 修改 | 微调措辞（去 awaiting_revision；resume 引导改 evaluate/revise 而非 run_turn）；makeAcademyMessage 信封不变 | MUST NOT 改 sender 信封 | training_engine §7 | +5/-5 |

### E. 核心入口（两入口统一：抽 createTrainingTaskAndCoach）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-core | app/server/src/academy/academy-training-core.ts | `CreateTrainingTaskInput` | 新增 | interface：classroomId + studentId + baseVersionId + mode + optimizeStyle + directive? + datasetId? + graderId? + maxTurns? | MUST 字段闭合（两入口共享）；directive 唯一差异由入口填 | diagnosis §2.决策3 | +12 |
| academy-core | app/server/src/academy/academy-training-core.ts | `TrainingCoreDeps` | 新增 | interface：academyStore + sessionStore + agentManager + appConfig + dataDir（+ sessionTaskLock?可选） | MUST 形状可由 AcademyHandlerDeps 与 AgentToolRuntimeContext.sessionDeps 双向满足；MUST dataDir 已 resolveDataDir 展开（packaged 护栏 BUG-004） | diagnosis §2.决策3；session_kind_extension §8 | +10 |
| academy-core | app/server/src/academy/academy-training-core.ts | `createTrainingTaskAndCoach` | 新增 | 核心三步：①校验（classroom/student/base formal/multi 必填 dataset+grader/同 student 无 running task）+分配 taskSeq+gen tid ②fork 初始 candidate（round=1 自 base）→ candidateVersionId+workspaceDir ③resolveAcademySessionModel（classroom.defaultModel→app 默认）→ createSession(coach, workspaceDir=candidateWs, academyTrainingTaskId=tid, classroomId) ④putTask(coachSessionId, candidateVersionId, temporaryBaselineVersionId=baseVersionId, status='pending') ⑤读 base resolveVersionContent + 组装 TaskBookPayload → deliverTo(coach, buildTaskBookMessage) fire-and-forget。返 { task, coachSessionId, candidateVersionId, candidateWorkspaceDir } | MUST createSession 先于 putTask（C5 coach 必填 trainingTaskId——tid 先 gen）；MUST coach workspaceDir=初始 candidate workspaceDir（修 cwd 错位，coach 默认 cwd=候选）；MUST 5 步顺序：gen tid→fork candidate→createSession→putTask→deliverTo；MUST NOT 重复 taskSeq 分配逻辑（统一在本函数）；MUST deliverTo 失败不阻塞返 201 | diagnosis §2.决策2/决策3；training_engine §2/§7；session_kind_extension §1.1 C5 | +120 |
| academy-handler | app/server/src/handlers/academy-training-task-create.ts | `handleCreateTask` | 修改 | 重构为薄壳：解析 body + 调 `createTrainingTaskAndCoach`（deps 从 AcademyHandlerDeps 构造）；删除内联的 coach model 解析/createSession/putTask/kickoff 逻辑（已移入核心）；保留 HTTP 错误码映射（model_not_configured→400/task_already_running→409/invalid_base_version→400/missing_evaluation_config→400） | MUST 核心抛错映射到原 HTTP 错误码不变（API 契约向后兼容）；MUST NOT 内联建 coach session（走核心） | diagnosis §1.8/§2.决策3；API 18-academy §2.1 | -85/+30 |
| train-student-tool | app/server/src/agent/tools/train-student-actions.ts | `runStart` | 修改 | 重写为薄壳：入参校验（studentId/baseVersionId/mode/optimizeStyle 合法）→ 从 rtc 构造 TrainingCoreDeps（agentManager/store/sessionDeps.{appConfig,dataDir}/academyStore）→ 调 `createTrainingTaskAndCoach` → textResult({ taskId, coachSessionId, candidateVersionId, candidateWorkspaceDir }) | MUST NOT 占位 coachSessionId（消除 §1.8 偏离）；MUST 真建 coach（核心调 createSession）；MUST directive 来自 input（head 入口提炼用户意图） | diagnosis §1.8/§2.决策3；train_student_tool §2.1 | -55/+25 |
| academy-handler | app/server/src/handlers/academy-training-task.ts | `handleRunTurn` | 修改 | 重命名为 `handleRevise`：调 `deps.trainingEngine.reviseCandidate(tid, classroomId)` 替代 `engine.runTurn`（runTurn 已删）；返 TurnResult；HTTP 端点路径 `/run-turn` → `/revise` | MUST NOT 保留 handleRunTurn 调已删的 runTurn（typecheck fail）；MUST 端点名与 API spec §2.3 一致 | API 18-academy §2.3；training_engine §3 | +8/-8 |
| academy-routes | app/server/src/routes/academy-routes.ts | route pattern + dispatch | 修改 | `academy-training-task.ts` actionMatch 正则 `run-turn` → `revise`；dispatch case `'revise'` → handleRevise；注释更新 | MUST 路由分发与 handleRevise 一致；MUST NOT 留 run-turn 死路由 | API 18-academy §2.3 | +3/-3 |

### F. train-student 工具（action 矩阵：run_turn → evaluate/revise）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| train-student-tool | app/server/src/agent/tools/train-student-tool.ts | `TRAIN_ACTIONS` | 修改 | enum 去 `'run_turn'`，加 `'evaluate'`、`'revise'`（fork 保留） | MUST 闭合枚举与 dispatch 一致；MUST NOT 保留 run_turn（死入口） | diagnosis §2.决策1；train_student_tool §1 | +1/-1 |
| train-student-tool | app/server/src/agent/tools/train-student-tool.ts | `ROLE_PERMISSIONS` | 修改 | coach 集：去 `run_turn`，加 `evaluate`、`revise`（fork 保留）；head_teacher 集：加 `evaluate`（head 也可探查版本表现，不改状态）；其余不变 | MUST evaluate 对 head+coach 开放（纯查询无副作用）；revise 仅 coach（推进状态）；MUST student 仍空集 | train_student_tool §4 | +3/-1 |
| train-student-tool | app/server/src/agent/tools/train-student-tool.ts | `ENGINE_REQUIRED` | 修改 | 去 `run_turn`，加 `evaluate`、`revise`（需 engine.deps.llmPort）；fork 不需 engine（走 store-ops，保留现状） | MUST 与 ROLE_PERMISSIONS 一致 | train_student_tool §4 | +1/-1 |
| train-student-tool | app/server/src/agent/tools/train-student-tool.ts | `dispatch` | 修改 | 去 `case 'run_turn'`；加 `case 'evaluate'`→runEvaluate、`case 'revise'`→runRevise；fork/propose/accept/reject/stop 不变 | MUST action 闭合（无 fallthrough 到默认）；MUST evaluate/revise 返 textResult 含 workspaceDir 供 coach 定位 | diagnosis §2.决策1；train_student_tool §2 | +6/-4 |
| train-student-tool | app/server/src/agent/tools/train-student-tool.ts | `trainStudentTool.definition.inputSchema.properties` | 修改 | 去 run_turn 相关注述；evaluate 加 `versionId?`（探查指定版本；缺省=task.candidateVersionId）；schema description 同步 | MUST evalute/revise/fork 的 LLM-facing schema 清晰 | train_student_tool §3 | +5/-3 |
| train-student-actions | app/server/src/agent/tools/train-student-actions.ts | `runEvaluate` | 新增 | action=evaluate：取 taskId + 可选 versionId（缺省 task.candidateVersionId）→ 调 engine.evaluateVersion → textResult({ versionId, samples, grades, avgScore }) | MUST 纯查询不副作用；MUST 复用 readLlmPort/engine | diagnosis §2.决策1；train_student_tool §2.5 | +25 |
| train-student-actions | app/server/src/agent/tools/train-student-actions.ts | `runRevise` | 新增 | action=revise：取 taskId → 调 engine.reviseCandidate → textResult({ task, turn, proposed })（含 candidateVersionId+workspaceDir+avgScore+decision+reasoning 摘要） | MUST 返 workspaceDir（coach 定位新候选）；MUST 错误映射（task_busy/maxTurns） | diagnosis §2.决策1；train_student_tool §2.4 | +20 |
| train-student-actions | app/server/src/agent/tools/train-student-actions.ts | `runFork` | 修改 | 既有 runFork 改为调 engine.forkCandidate（替代直调 forkVersionWorkspace，统一通过 engine 暴露 + 更新 task.candidateVersionId）；返回 { versionId, workspaceDir } | MUST fork 后 task.candidateVersionId 更新（通过 engine.forkCandidate 落盘） | diagnosis §2.决策1 | +5/-5 |
| train-student-actions | app/server/src/agent/tools/train-student-actions.ts | `runSample`/`runGrade` | 修改 | 保留（coach 容错单步调），但语义注：coach 通常用 evaluate 替代；sample/grade 直调子模块不变 | MUST NOT 删（容错场景仍需）；MUST 注释指向 evaluate 为推荐路径 | train_student_tool §2.5 | +3 |

### G. coach 职责 mapper + iteration_state 注入 candidate ws

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| coach-mapper | app/plugins/builtins/rocky_context/prompt/academy-coach-role.ts | `AcademyCoachRoleMapper` | 新增 | system_prompt_mapper impl：注入稳定教练身份 + 训练工作流方法论（evaluate→反思→edit candidate→revise→循环→propose）+ train-student action 说明（evaluate/revise/fork/propose）+ academy-train-skill/learn-skill 可加载指针（call `skill` tool）。每轮注入（稳定正文，与任务书分工：system 给角色能力，task book 给具体任务） | MUST 稳定正文不随 task 变（身份+方法论+工具说明）；MUST 仅 coach scope 激活（kind.role==='coach'）；MUST graceful degrade（缺 academyContext 返空）；extends ContextImplBase implements SystemPromptMapper | diagnosis §2.决策2/决策4；session_kind_extension §4.1 | +60 |
| coach-mapper | app/plugins/builtins/rocky_context/prompt/academy-iteration-state.ts | `AcademyIterationStateMapper.map` | 修改 | 注入字段加：当前 candidate workspaceDir 绝对路径（从 academyContext.task.candidateVersionId → academyStore.getVersion → workspaceDir，或 academyContext 直接带 candidateWorkspaceDir）+ candidate versionId；其余（taskId/status/currentTurn/maxTurns/temporaryBaselineVersionId/历史轮次）不变 | MUST 注入 candidate workspaceDir 绝对路径（coach edit 定位）；MUST graceful degrade（无 candidate 返空） | diagnosis §1.6/§2.决策4；session_kind_extension §4.1 | +12 |
| coach-mapper | app/plugins/builtins/rocky_context/prompt/academy-shared.ts | `AcademyContextLike.task` | 修改 | 类型加 `candidateVersionId?: string` 字段（与 schema 新增字段对齐） | MUST 与 TrainingTaskSchema.candidateVersionId 一致 | data_model §4 | +1 |
| academy-context | app/server/src/academy/academy-context.ts | `AcademyContextShape.task` | 修改 | coach 分支：task 已从 store 现拉（含 candidateVersionId 新字段，store 读侧自带）；无需改装配逻辑（字段随 task entity 投影） | MUST NOT 改 buildAcademyContext 三 role 裁剪骨架 | session_kind_extension §5.2 | +1 |
| coach-scope | app/plugins/scopes/academy-coach.parent.main.yaml | `groups[system-prompt].points[system_prompt_mapper].impls` | 修改 | impls 列表加 `academy_coach_role`（在 academy_classroom_role 之后、academy_training_directive 之前） | MUST 仅 coach scope 激活（head/student scope 不加）；MUST impl 名与 plugin.json extImpls 注册一致 | session_kind_extension §4.1 | +1 |
| coach-plugin | app/plugins/builtins/rocky_context/plugin.json | `extImpls` | 修改 | 注册 `academy_coach_role` impl（指向 academy-coach-role.ts default export） | MUST extImpls id 与 scope impls 引用一致；MUST NOT 重复注册 | session_kind_extension §4.1 | +1 |

### H. academy skills 可见性（移到 builtins/skills/）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-skills | app/plugins/builtins/skills/academy-train-skill/SKILL.md | （文件移动） | 新增 | 从 app/plugins/skills/academy-train-skill/ 整目录移到 app/plugins/builtins/skills/academy-train-skill/（builtin 扫描根 builtinSkillRoot 覆盖） | MUST 内容不变（仅路径变）；MUST 目录名一致；MUST 与现有 builtins/skills（panorama-designer/teamwork-*/okf-skill 等）名称隔离（academy- 前缀无冲突） | diagnosis §1.5/§2.决策4；academy_skills §6 | 移动 |
| academy-skills | app/plugins/builtins/skills/academy-learn-skill/SKILL.md | （文件移动） | 新增 | 同上，learn-skill 迁入 builtins/skills/ | MUST 同上 | 同上 | 移动 |
| academy-skills | app/plugins/builtins/skills/academy-judge-skill/SKILL.md | （文件移动） | 新增 | 同上，judge-skill 迁入 builtins/skills/（head 编辑评估器时加载，builtin 层全局可见） | MUST 同上 | 同上 | 移动 |
| academy-skills | app/plugins/skills/ | （目录删除） | 删除 | 移走 3 个 academy-* 目录后删除空 app/plugins/skills/ | MUST 确认 3 子目录都已移走再删父；MUST NOT 留空目录 | diagnosis §1.5 | -1 目录 |
| build-plugins | scripts/build-plugins.ts | `copyResources` | 修改 | 删除 academySkillsSrc workaround（行 123-128：`PLUGINS_SRC/skills` → `DIST_BUILTINS/skills` 的特殊 cpSync）—— skills 现已落 builtins/skills/，由原 skillsSrc（行 119-121）统一覆盖 | MUST NOT 双重拷贝；MUST 确认原 skillsSrc=BUILTINS_SRC/skills 覆盖 academy-* 子目录 | diagnosis §1.5；packaged 护栏 BUG-003 | -6 |

### I. spec 重写（P1 — 同步对齐代码实际，doc-modifier 阶段统一改；本表列改动锚点）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-spec | specs/tech/academy/[P0]training_engine.md | §2/§3/§4/§7 | 修改 | §2 接口去 runTurn/startTask、加 evaluateVersion/reviseCandidate/forkCandidate；§3 runTurn 重写为 evaluate/revise 两段语义；§4 acceptGate 加 reviseBaselineAvg（首次直接采纳）；§7 事件消息加任务书投递 + revise 结果回推；删 awaiting_revision 措辞 | MUST 与代码实际一致（spec 落后是常态，doc-modifier 阶段 5 统一对齐） | diagnosis §3；architect 原则 12 | +重写 |
| academy-spec | specs/tech/academy/[P0]train_student_tool.md | §1/§2/§4 | 修改 | action 矩阵改 evaluate/revise（替 run_turn）；§2.1 start 实现分工删「占位偏离」改「两入口统一核心」；各 action 返 workspaceDir；§4 权限矩阵 evaluate 加 head+coach | MUST 同上 | diagnosis §3 | +重写 |
| academy-spec | specs/tech/academy/[P0]session_kind_extension.md | §4.1/§5 | 修改 | §4.1 mapper 表加 academy_coach_role + iteration_state 注入 candidate workspaceDir；§5 装配链补「createTrainingTaskAndCoach 三步 + 任务书投递」 | MUST 同上 | diagnosis §3 | +重写 |
| academy-spec | specs/tech/academy/[P0]academy_skills.md | §6/§7 | 修改 | builtin 注册路径改 app/plugins/builtins/skills/（去 app/plugins/skills/）；可见性说明改「builtin 层 coach/head 全局可见」 | MUST 同上 | diagnosis §3 | +重写 |
| academy-spec | specs/tech/academy/[P0]data_model.md | §3/§4/§6.1 | 修改 | §3 过程版本号规则 3 段化（{base顶层major}.{taskSeq}.{round}，示例 0.1.1）；§4 task schema 加 candidateVersionId 字段；§6.1 candidate/coach workspace 路径说明（coach workspaceDir=初始 candidate ws） | MUST 同上 | diagnosis §3 | +重写 |
| academy-spec | specs/tech/academy/[P0]academy_overview.md | §8.2/§8.3 | 修改 | 训练发起流程改「两入口统一核心 + 任务书牵引 + coach 自主 evaluate/revise」；§8.3 多轮训练式改 coach 驱动 revise 循环（去 run_turn 自动） | MUST 同上 | diagnosis §3 | +重写 |
| academy-api | specs/api/overall/18-academy.md | §2.3 | 修改 | HTTP 端点 `/academy/training-task/:tid/run-turn` 改 `/revise`（调 engine.reviseCandidate） | MUST 端点名与 handler/route 一致 | API 18-academy §2.3 | +重写 |
| academy-spec | specs/tech/academy/index.md | ④核心设计原则 | 修改 | 原则 2「双引擎咬合」补充：coach 任务牵引主导修订（引擎=工具服务+状态记录器）；原则 3 coach 补「任务书驱动」；新增版本号 3 段原则 | MUST 同上 | diagnosis §3 | +重写 |
| academy-spec | specs/tech/academy/log.md | （追加） | 修改 | 追加 v0.0.213 条目：coach 训练闭环 + 任务牵引 + 两入口统一 + 版本号 3 段 | MUST OKF log.md 格式 | OKF skill | +1 条 |

## 影响面评估

**跨模块**：schema（A）→ store ops（B）→ 训练引擎（C，核心重构）→ 消息（D）→ 核心入口（E）→ 工具（F）→ mapper/scope（G）→ skills 移动（H）。spec 重写（I）由 doc-modifier 阶段 5 统一做。

**依赖顺序**：A（schema 字段）→ B（label 修）→ C（引擎用 A 字段 + B label）→ D（消息被 C/E 用）→ E（核心用 C 引擎 + D 消息）→ F（工具调 E 核心 + C 引擎）→ G（mapper 读 A 字段）→ H（独立，并行）。

**破坏性变更**：
- `train-student` 工具 action enum：去 `run_turn`，加 `evaluate`/`revise`（LLM-facing schema 变；旧 coach session 调 run_turn 会 invalid_action——可接受，旧 task 也无 candidateVersionId 字段）。
- `TrainingTaskSchema` 加 `candidateVersionId`（lazy 可选，向后兼容旧 task record）。
- academy skills 目录迁移（用户已安装的同名 skill 不受影响——builtin 层只读，用户 app 层独立）。
- 版本号 3 段化：旧 4 段 process 版本 label（如 0.0.1.1）仍能被 split('.')[0] 取 major（adoptToFormal 已用此），不破坏旧数据；新 fork 一律 3 段。

**风险点**：
1. `reviseCandidate` baseline 语义（首次直接采纳）需 UT 覆盖（首轮无历史 vs 后续有历史两分支）。
2. `createTrainingTaskAndCoach` 5 步事务性：fork candidate 与 createSession 与 putTask 任一失败需兜底（candidate 目录已建但 session 建失败 → 孤儿目录；可接受，process 版本不影响 formal）。
3. coach workspaceDir=初始 candidate ws，round2+ 候选换目录时 coach 须靠 iteration_state 注入的新 ws 绝对路径定位（system prompt 必须明示「用 prompt 中的 candidate workspace 路径编辑」）。
4. moving skills 目录需同步 build-plugins（已含），否则 packaged 丢 skill（护栏 BUG-003）。

**packaged 护栏**：本版本改 academy 域（非新依赖/非 runtime-config/非新 plugin asar 入口）—— BUG-001~004 主要风险在 build-plugins copyResources 改动（H 节，删 workaround 后确认 builtins/skills 覆盖 academy-*）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- spec↔code 偏离（C/F/E 实现时发现 spec 概念与代码不符）→ coder 按代码实际调整 + 汇报偏离 → orchestrator 记 doc-sync 待办 → doc-modifier 阶段 5 统一改 spec（I 节）

