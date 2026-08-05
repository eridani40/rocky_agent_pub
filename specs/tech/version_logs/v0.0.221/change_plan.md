# v0.0.221 变更计划书 — coach 主权 + 两轴模型（生产⊥归档）+ 两工具拆分

> **method 级 review 合同**。架构期冻结：planner/coder 按本表切，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 设计权威：`reqs/[working] v0.0.221.coach_enhance/design.md`；PRD：`specs/prd/version_logs/v0.0.221.md`；本版在途发现：`states/v0.0.221/context.md` findings（含 versionLabel BUG 根因 + 破坏性 enum 收窄决议）。
>
> **架构总览**（两轴）：生产轴（task，coach 绝对主权，三态机 pending/running/paused+reason，maxTurns 硬上限）⊥ 归档轴（adopt(versionId)，任意 process 版，可重复，不改 task 状态）。head 退教室层（实体级，仅 manage-classroom），coach 文件级全权（manage-task）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径（worktree 内） |
| 函数/符号 | 函数名/类型/class（行粒度 = 符号） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT（钉死边界） |
| 参考 | spec 路径+章节 / 原则编号 |
| 影响行 | +N / -M（估） |

---

## A. 训练引擎：状态机三态 + adopt 旁路 + 去 propose（核心）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| training_engine | app/server/src/academy/schema_defs/training-task.ts | TrainingTaskSchema.fields.status | 修改 | enumValues 收窄 6→3：`['pending','running','paused']`；去掉 awaiting_confirm/done/rejected/aborted | MUST 闭合枚举；旧值由 resumeOnStartup migration 重命名（见下 row）；MUST NOT 留兼容分支 | design §5; PRD §2.1; data_model §4 | +1/-1 |
| training_engine | app/server/src/academy/schema_defs/training-task.ts | TrainingTaskSchema.fields.pausedReason | 新增 | 字段：`{type:'enum', required:false, enumValues:['maxturns','completed','stopped','earlystop']}`；task 停在 paused 时区分为何而停 | reason 闭合 4 值；running/pending 时必为 undefined | design §5; training_engine §1 | +6 |
| training_engine | app/server/src/academy/training-engine/lifecycle.ts | proposeTask | 删除 | 去除（采纳解耦 + 自动 propose 链拆；revise 不再调它） | MUST 同时删 messages.ts buildProposedMessage 的调用 | design §2.2; training_engine §1 | -20 |
| training_engine | app/server/src/academy/training-engine/lifecycle.ts | acceptTask | 删除 | 去除（采纳解耦：无 propose→accept 链；替换为 engine.adoptVersion 见下 row） | MUST 同时删 HTTP /accept 路由（见 E 节） | design §2.2/§3.3; training_engine §3.3 | -35 |
| training_engine | app/server/src/academy/training-engine/lifecycle.ts | rejectTask | 删除 | 去除（无 propose→reject 链） | MUST 同时删 HTTP /reject 路由 | design §3.3 | -15 |
| training_engine | app/server/src/academy/training-engine/lifecycle.ts | stopTask | 删除 | 去除（head stop 取消；coach 用 pause 可逆停） | MUST 同时删 HTTP /stop 路由 | design §3.1/§3.3 | -12 |
| training_engine | app/server/src/academy/training-engine/lifecycle.ts | pauseTask | 新增 | 签名 `(deps, taskId, classroomId, reason?: 'stopped'\|'earlystop'): Promise<TrainingTaskEntity>`；putTask status='paused' + pausedReason=reason ?? 'stopped'；deliverTo coach `buildPausedMessage` | MUST 校验 status ∈ {running, pending}（已 paused 抛 invalid_task_state）；pausedReason 必填非 undefined（缺省 'stopped'）；**不改 candidate/baseline 指针**（pause 仅状态标记） | design §3.2/§5; training_engine §1 | +28 |
| training_engine | app/server/src/academy/training-engine/lifecycle.ts | resumeTask | 新增 | 签名 `(deps, taskId, classroomId): Promise<TrainingTaskEntity>`；校验 status==='paused' 且 pausedReason !== 'maxturns'（硬上限不可越过，抛 `task_at_maxturns` 提示 update_task）；putTask status='running' + pausedReason=undefined；deliverTo coach `buildResumeFromPausedMessage`（提醒继续 edit+revise） | MUST maxTurns 硬门（reason=maxturns 时永久终态，须 update_task 调大 maxTurns 才能再 resume）；**MUST NOT 自动 fork 新 candidate**（coach 自己调 revise/fork 起 round N+1） | design §5/§7.5; PRD §2.1; training_engine §1 | +32 |
| training_engine | app/server/src/academy/training-engine/lifecycle.ts | adoptVersion | 新增 | 签名 `(deps, taskId, classroomId, processVersionId): Promise<{newFormalVersionId, newLabel, newWorkspaceDir}>`；**调 adoptToFormal(processVersionId) 不改 task 状态**（旁路）；deliverTo coach `buildAdoptedMessage`（告知新 formal 已落 + 源 process id）；允许多次调（同一 task 产多个 formal） | MUST NOT 校验 task.status（旁路与状态机无关）；MUST NOT 改 task.acceptedVersionId（那是旧 acceptTask 字段，已废弃——不写）；adoptToFormal 自身校验 processVersion.type==='process' | design §2.2; PRD §2.2; training_engine §1 (adopt 旁路) | +25 |
| training_engine | app/server/src/academy/training-engine/lifecycle.ts | resumeOnStartup | 修改 | 扩为「扫所有 tasks」：① status='running' 保持原断点续跑逻辑（推 buildResumeMessage）；② status ∈ {done, aborted, rejected, awaiting_confirm}（旧值）→ migration putTask 重写为 status='paused' + pausedReason 映射（done→completed / aborted→stopped / rejected→stopped / awaiting_confirm→stopped）+ 推 buildResumeFromPausedMessage；③ status='paused' 跳过（已是稳态） | migration MUST 幂等（二次扫 status='paused' 跳过）；MUST NOT 删除旧 record（只重写 status 字段）； academy 还在 demo 阶段，pre-existing 数据破坏用户已接受（context.md findings） | design §5; context.md [architect 07-30] | +18/-3 |
| training_engine | app/server/src/academy/training-engine.ts | TrainingEngine (class methods) | 修改 | 删 proposeTask/acceptTask/rejectTask/stopTask 方法；加 pauseTask/resumeTask/adoptVersion 方法（各委派 lifecycle.ts 同名函数） | 接口签名对齐 lifecycle；保留 evaluateVersion/reviseCandidate/forkCandidate/resumeOnStartup 不动 | training_engine §2 | +12/-12 |
| training_engine | app/server/src/academy/training-engine/revise.ts | reviseInternal (early-stop/maxTurns 分支) | 修改 | 删 `proposeTask` import + 删两处自动 propose 调用；改为 putTask status='paused' + pausedReason='earlystop'（连续 3 轮无提升）/ 'maxturns'（currentTurn>=maxTurns）；deliverTo coach buildReviseResultMessage（保留，但措辞调整：去「已 propose」改「已 paused，可 update_task 调大 maxTurns 再 resume」）—— coder 定位具体文案 | MUST NOT 再调 lifecycle.proposeTask；maxTurns 到顶 MUST status='paused'+reason='maxturns'（非终态，可 update_task 调大续训） | design §5/§7.5; training_engine §3 (step 6) | +12/-10 |
| training_engine | app/server/src/academy/training-engine/revise.ts | TurnResult.proposed 字段 | 修改 | 重命名语义为 `paused: boolean`（到顶/早停时 true；否则 false）；handler / 工具层同步改字段名 | 字段重命名，禁双名共存 | training_engine §2 (TurnResult) | +6/-6 |
| training_engine | app/server/src/academy/training-engine/messages.ts | buildProposedMessage | 删除 | 去除（无 propose 链） | - | design §2.2 | -16 |
| training_engine | app/server/src/academy/training-engine/messages.ts | buildPausedMessage | 新增 | coach 收到 pause 完成的通知（task id + pausedReason + 提示 resume 可续） | sender=system/kind=academy-training-engine（makeAcademyMessage 复用） | training_engine §7 | +10 |
| training_engine | app/server/src/academy/training-engine/messages.ts | buildResumeFromPausedMessage | 新增 | resume 后通知 coach 继续（task id + 当前 candidate versionId + 临时基线 + 提示 edit→revise）；区分于 buildResumeMessage（那是 status=running 断点续跑） | 同上信封模式 | training_engine §7 | +12 |
| training_engine | app/server/src/academy/training-engine/messages.ts | buildAdoptedMessage | 新增 | adopt 完成通知 coach（task id + 新 formal versionId + label + 源 process versionId + 提示「task 仍在产，可继续迭代」） | 同上信封模式；MUST 强调 task 状态未变（旁路） | design §2.2; training_engine §7 | +10 |
| training_engine | app/server/src/academy/training-engine/fork.ts | forkCandidate | 修改 | 当显式传 `baseVersionId !== task.temporaryBaselineVersionId` 时（切历史版作基线），putTask 同时更新 `temporaryBaselineVersionId = baseVersionId`（不只是 candidateVersionId）；**不带 baseVersionId 参数时不动 temporaryBaseline（保持原「废弃重来」语义）** | MUST：切基线 = 临时基线指针同步替换（否则 reviseBaselineAvg 还比旧基线，acceptGate 失真）；MUST NOT 切基线时改 task.status | design §2.1b/§3.2 fork; training_engine §3.2; data_model §6 | +8/-2 |

---

## B. Store ops：versionLabel BUG 修复 + adopt 解耦 + student 指针同步

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| data_model | app/server/src/academy/academy-version-dir.ts | patchVersionJsonLabel | 新增 | 签名 `(wsDir: string, newLabel: string): Promise<void>`；读 `<wsDir>/version.json` → 改 versionLabel 字段 → 写回（保留 model/tools/skills 不动）；缺 version.json → 创建最小 `{versionLabel, model:{}}`（容错） | MUST NOT 用 writeVersionDirFiles（那会重写 AGENTS.md，丢 skill/memory）；只 patch version.json 单字段 | data_model §3.1; context.md [architect 07-30] BUG#1 | +18 |
| data_model | app/server/src/academy/academy-store-ops.ts | forkVersionWorkspace | 修改 | `copyVersionDir` 之后追加 `patchVersionJsonLabel(dstDir, ${baseMajor}.${taskSeq}.${round})`（修 workspace 内 version.json versionLabel 不一致的 BUG） | MUST 在 copyVersionDir 成功后调；record.versionLabel 与 workspace version.json versionLabel 字段必须一致 | data_model §6 forkVersionWorkspace; context.md BUG#1 | +3 |
| data_model | app/server/src/academy/academy-store-ops.ts | adoptToFormal | 修改 | ① `copyVersionDir` 之后追加 `patchVersionJsonLabel(newWorkspaceDir, newLabel)`（修 formal 版 version.json versionLabel BUG）；② **末尾追加** `store.putStudent({...stripEnvelope(student), currentFormalVersionId: newFormalVersionId})`（同步 student 指针，修 BUG-001）；③ **去除 process-only 强校验**？保留（data_model §6 INV 不变——adoptVersion 入参仍要 process 类型）；④ 允许同一 process 多次 adopt（不抛错；第二次会另产新 formal versionId） | MUST 同步 student.currentFormalVersionId（BUG-001 修复）；MUST NOT 删除 / 改写已有 formal version（每次 adopt 产新 ULID）；多次 adopt 允许产 major 递增 formal（2.0/3.0/4.0） | data_model §6 adoptToFormal; design §8 BUG#1/#3; PRD §2.5 BUG#1/#3 | +10/-2 |
| data_model | app/server/src/academy/academy-store-ops.ts | createInitialFormalVersion | 修改 | 走 writeVersionDirFiles 已写 '0.0' 正确——**仅注释加一条说明**「本函数是 versionLabel 写正确的基线（fork/adopt 需补 patchVersionJsonLabel，本函数不需因走 writeVersionDirFiles）」 | 无逻辑改动（注释 only） | data_model §6 createInitialFormalVersion | +2 |

---

## C. 工具层：三工具→两工具（manage-student 并入 manage-classroom；train-student→manage-task）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy_tool | app/server/src/agent/tools/train-student-tool.ts | manageTaskTool (原 trainStudentTool 重命名) | 修改 | 工具名 `train-student` → `manage-task`；description 改为「coach 专属 task 推进工具」；action enum 收敛 13 值（去 start/stop/accept/reject/propose，加 adopt/pause/resume/history）；ROLE_PERMISSIONS 删 head_teacher 分支（head 不再调本工具），coach 分支扩 adopt/pause/resume；**taskId 隐式校验**：input.taskId 缺省 = rtc.sessionContext.trainingTaskId，传则必须 === rtc.sessionContext.trainingTaskId（不匹配 → errorResult `task_not_bound`） | MUST：head_teacher 在 ROLE_PERMISSIONS 中无任何 action（工具层 + profile.toolBound 双收束）；coach profile.toolBound 必含 manage-task（见 D 节）；MUST NOT 保留 train-student 旧名（registry 同步改名） | design §3.2; train_student_tool §1/§4; context.md [architect 07-30] | +60/-50 |
| academy_tool | app/server/src/agent/tools/train-student-actions.ts | runStart | 删除 | 去除（start 移到 manage-classroom.start_task）；buildCoreDeps/coreErrorToResult 保留（manage-classroom 复用） | - | design §3.1; session_kind_extension §7 | -40 |
| academy_tool | app/server/src/agent/tools/train-student-actions.ts | runAdopt | 新增 | 签名 `(input, rtc, classroomId)`；取 versionId（必填，缺 → errorResult）；调 `engine.adoptVersion(taskId, classroomId, versionId)`；返 `{newFormalVersionId, newLabel, newWorkspaceDir}` JSON | MUST versionId 必填（adopt 指定具体 process 版本）；MUST NOT 校验 versionId 归属（adoptVersion 内部 adoptToFormal 校验 type） | design §3.2 adopt; lifecycle §A | +18 |
| academy_tool | app/server/src/agent/tools/train-student-actions.ts | runPause | 新增 | 签名 `(input, rtc, classroomId)`；取 reason 可选（缺省 undefined → lifecycle 默认 'stopped'）；调 `engine.pauseTask(taskId, classroomId, reason)`；返 ack | - | design §3.2 pause | +12 |
| academy_tool | app/server/src/agent/tools/train-student-actions.ts | runResume | 新增 | 签名 `(input, rtc, classroomId)`；调 `engine.resumeTask(taskId, classroomId)`；返 ack；catch `task_at_maxturns` 错 → errorResult 提示「maxTurns 到顶，先调 manage-classroom update_task 调大」 | MUST 错误信息明确指引 update_task 路径 | design §3.2 resume/§7.5 | +14 |
| academy_tool | app/server/src/agent/tools/manage-classroom-tool.ts | MANAGE_ACTIONS (action enum) | 修改 | 扩为 20 action：原 9（dataset/grader/skill）+ 学生 CRUD 7（list_students/get_student/create_student/update_student/delete_student/list_versions/get_version）+ 任务监督 4（start_task/list_tasks/get_task/update_task）；去 install_skill 占位（保留，不变） | action enum 闭合 20 值 | design §3.1; session_kind_extension §7 | +25/-2 |
| academy_tool | app/server/src/agent/tools/manage-classroom-tool.ts | dispatchManage (switch 扩) | 修改 | 接入学生 CRUD 7 + 任务监督 4 分支；具体实现委派 manage-student-actions.ts / manage-student-training-actions.ts（保留为 helper 模块被 import） | MUST 单文件 ≤300（超则拆 manage-classroom-tool 到主壳 + 三 helper 文件 assets/students/tasks-actions.ts，coder 决定是否拆）；MUST 保留现有 dataset/grader/skill 实现 | design §3.1; context.md [architect 07-30] 拆分策略 | +30/-2 |
| academy_tool | app/server/src/agent/tools/manage-student-training-actions.ts | runStartTraining | 修改 | 重命名导出为 `runStartTask`（语义对齐 start_task）；逻辑不变（薄壳调 createTrainingTaskAndCoach）；默认 baseVersionId=student.currentFormalVersionId 不变 | 函数名跟随 action 名（start_training→start_task） | design §3.1 start_task; session_kind_extension §7.1 | +3/-3 |
| academy_tool | app/server/src/agent/tools/manage-student-training-actions.ts | runTrainingStatus | 修改 | 重命名为 `runListTasks`（无 taskId 时返教室看板）；有 taskId 时仍返单 task 详情（但单 task 详情现由 get_task 承担，故本函数只处理看板模式）；删除 taskId 参数分支（移到 get_task） | list_tasks 只做看板；get_task 单独 action | design §3.1 list_tasks/get_task | +5/-10 |
| academy_tool | app/server/src/agent/tools/manage-student-training-actions.ts | runGetTask | 新增 | 签名 `(input, rtc, classroomId)`；取 taskId 必填；调 store.getTask + listTurns；返 `{task, turns}`（监督级）；task DTO 反规范化 baseVersionLabel（复用 attachBaseVersionLabel） | MUST 不下钻 per-case reasoning（head 监督级，per-case 是 coach 专属） | design §3.1 get_task; api §2.2 | +18 |
| academy_tool | app/server/src/agent/tools/manage-student-training-actions.ts | runUpdateTask | 新增 | 签名 `(input, rtc, classroomId)`；取 taskId 必填 + 可选 maxTurns(number) + 可选 directive(string)；仅此两字段 patch（其他字段拒）；调 store.getTask → strip envelope → merge patch → putTask；返 ack | MUST 仅 patch maxTurns/directive 两字段（其他字段忽略不报错）；MUST NOT 改 task.status / candidateVersionId / temporaryBaselineVersionId（内部状态） | design §3.1 update_task/§7.5; PRD §2.1 | +20 |
| academy_tool | app/server/src/agent/tools/manage-student-tool.ts | manageStudentTool | 删除 | 整文件删除（工具壳并入 manage-classroom-tool） | MUST 同步从 registry defaultTools 删除 import + 注册 | design §3.3 (三工具→两); context.md [architect 07-30] | -130 |
| academy_tool | app/server/src/agent/tools/manage-student-actions.ts | (文件保留) | 修改 | 保留为 helper 模块（被 manage-classroom-tool import）；内部 7 action 函数不变（list/get/create/update/delete/list_versions/get_version）；ACTIVE_TASK_STATUSES 集合扩为含 `paused`（delete_student 守卫：paused 也算活跃，防误删） | MUST ACTIVE_TASK_STATUSES 改为 `new Set(['pending','running','paused'])`（去 awaiting_confirm/done，加 paused） | design §3.1; session_kind_extension §7.1 | +1/-1 |
| academy_tool | app/server/src/tools/registry.ts (or defaultTools 所在文件) | defaultTools | 修改 | 删 manageStudentTool 注册；trainStudentTool 注册改名为 manageTaskTool（import + 引用同步） | MUST 旧名完全清干净（grep 无残留 trainStudentTool/manageStudentTool export） | train_student_tool §6 | +2/-2 |

---

## D. profile / scope / mapper / academy-context：信息供给完善

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| mapper | app/plugins/builtins/rocky_context/prompt/academy-iteration-state.ts | AcademyIterationStateMapper.map | 修改 | 扩 prompt 内容：①base：versionId + versionLabel + **workspaceDir 绝对路径**（只读参考）；②版本谱系（本 task 全部 process 版）：`[{round,versionId,label,decision,avgScore,workspaceDir}]`；③已采纳 formal（本 task 归档的）：`[{versionId,label,adoptedFromProcessLabel}]`；④生命周期：status + **resumable 标志** + **maxTurns 软提示** + **roundsUsed**；⑤保留 candidate + temporaryBaseline 不动 | MUST 输出绝对路径（coach edit 目标）；MUST resumable = (status==='paused' && pausedReason!=='maxturns')；MUST NOT 把 per-case reasoning 全文塞（深细节走 turn_result 工具） | design §4.2; PRD §2.5 ②; session_kind_extension §4.1 | +45/-5 |
| mapper | app/plugins/builtins/rocky_context/prompt/academy-task-status.ts | AcademyTaskStatusMapper.map | 修改 | 每 task 行补 **coachSessionId**（t.coachSessionId） + produced formal count（查 listVersions filter adoptedFromProcessVersionId 非空 且 createdFromTaskId === t.id）+ last decision（turns 末位 decision） | MUST 每行显 coachSessionId（head send_message 目标）；produced formal count 用 store 查询不污染 prompt | design §4.3; PRD §2.5 ③ | +15/-3 |
| mapper | app/plugins/builtins/rocky_context/prompt/academy-coach-role.ts | buildCoachRoleContent | 修改 | 重写：①身份强调「绝对主权 + 自主决策」（去「最终 propose 给 head」表述）；②advisory 语义（directive 是主要参考非硬命令）；③工作流去 propose 步骤，改为「循环 edit+revise，任何时刻可 adopt(versionId) 定稿」；④action 说明：去 propose，加 adopt/pause/resume（说明 manage-task 工具的新 action 名）；⑤版本谱系提示「iteration_state 给了全部 process 版本，可任选 adopt」 | MUST 去掉所有 propose 提及；MUST 说明 manage-task 是新工具名（不是 train-student） | design §4.2/§4.5; PRD §2.5; train_student_tool §1 (renamed) | +35/-30 |
| mapper | app/plugins/builtins/rocky_context/prompt/academy-head-role.ts | AcademyHeadRoleMapper (default export) | 新增 | 新 mapper 类（仿 academy-coach-role.ts 结构）：extends ContextImplBase implements SystemPromptMapper；map 读 role==='head_teacher' 否则返 []；内容 = head 角色职责（管学生/资产/任务监督）+ **「task 内部要效果 → send_message 给该 task 的 coach（别自己伸手）」指引** + update_task 用途（调大 maxTurns 续训） | MUST 仅 head scope 激活；priority=975（classroom_role=980 之后，classroom_assets=860 之前——coder 定位 exact tier）；MUST 与 academy_classroom_role 不重复（role 是身份正文，head_role 是行为指引） | design §4.3; PRD §2.5 ③; session_kind_extension §4.1 | +60 |
| mapper | app/plugins/builtins/rocky_context/prompt/academy-shared.ts | AcademyContextLike | 修改 | 扩字段：①`task` 加 `pausedReason?: string`；②加 `baseVersion?: { id, label, workspaceDir }`（coach 用，base ws 路径数据源）；③加 `versionLineage?: Array<{round, versionId, label, decision?, avgScore?, workspaceDir, type, status?}>`（coach 用，全 process 版谱系）；④加 `adoptedFormalVersions?: Array<{versionId, label, adoptedFromProcessVersionId, adoptedFromProcessLabel?}>`（coach 用，已归档 formal）；⑤`tasks[]` 加 `coachSessionId?: string`（已有，确保 type 闭合） | MUST 字段全部 optional（任一缺失 mapper graceful 返空）；type 闭合（Record/Array 形状明确） | design §4.1b/§4.2; academy-context.ts 对齐 | +20 |
| mapper_ctx | app/server/src/academy/academy-context.ts | buildAcademyContext (coach 分支) | 修改 | coach 分支扩：①拉 baseVersion = store.getVersion(classroomId, task.baseVersionId)；②拉 listVersions(studentId) → filter `createdFromTaskId === taskId`（本 task 全部 process 版，按 round asc 排序） + filter `type==='formal' && adoptedFromProcessVersionId 非空 && createdFromTaskId === taskId`（已采纳 formal，加 adoptedFromProcessLabel 解析）；③全部塞 AcademyContextShape 新字段；④head 分支无需改（task.coachSessionId schema 自带） | MUST 容错（任一 getVersion 失败 → undefined 不阻塞）；versionLineage 只含本 task 的 process 版（createdFromTaskId filter 是硬条件）；MUST NOT 拉别 task 的版本（隔离） | design §4.2; academy-context.ts 现 coach 分支; session_kind_extension §5.2 | +25/-2 |
| mapper_ctx | app/server/src/academy/academy-context.ts | AcademyContextShape (interface) | 修改 | 扩字段对齐 AcademyContextLike：baseVersion / versionLineage / adoptedFormalVersions | 字段全部 optional | design §4.2; academy-shared.ts 对齐 | +6 |
| scope_profile | app/plugins/builtins/rocky_context/plugin.json | extImpls[] | 修改 | 加 `{implId: 'academy_head_role', point: 'system_prompt_mapper', impl: './prompt/academy-head-role.ts', description: '...'}` | MUST impl 路径与文件名一致 | session_kind_extension §4.1 | +6 |
| scope_yaml | app/plugins/scopes/academy-head_teacher.parent.main.yaml | system_prompt_mapper.impls | 修改 | 加 `academy_head_role`（在 academy_classroom_role 之后、academy_classroom_assets 之前——coder 定位 exact order） | MUST 仅 head scope 激活；coach scope 不列 | design §4.3; session_kind_extension §4 | +1 |
| profile_yaml | app/plugins/session-types/academy-head_teacher.parent.main.yaml | toolBound | 修改 | 去 `train-student` + `manage-student`；保留 `manage-classroom`（已扩 20 action 含学生 CRUD + 任务监督） | MUST：head 不再绑 manage-task（coach 专属）；MUST NOT 同时保留 train-student 旧名（避免 LLM 看到幽灵工具） | design §3.1; session_kind_extension §3.1 | -2 |
| profile_yaml | app/plugins/session-types/academy-coach.parent.main.yaml | toolBound | 修改 | `train-student` → `manage-task`（重命名 only） | MUST 同步改名（旧名完全清除） | design §3.2; session_kind_extension §3.2 | +1/-1 |
| profile_yaml | app/plugins/session-types/academy-coach.subagent.main.yaml | toolBound | 修改 | 检查是否含 train-student——不含则无改动；含则改 manage-task（防御同步） | subagent profile MUST NOT 含 manage-task（防 subagent 绕 coach 操纵引擎） | train_student_tool §5 subagent 注 | +0/-0 或 +1/-1 |

---

## E. API handlers + routes：accept/reject/stop 去，adopt/resume/pause/update-task 加

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| api_handler | app/server/src/handlers/academy-training-task.ts | handleTrainingTaskRoute (action regex) | 修改 | actionMatch regex 改：去 `accept\|reject\|stop`，加 `adopt\|pause\|resume\|update-task`；dispatch switch 同步 | MUST 保留 revise/inject-directive 路由不变；新 action 走 POST | api §2; design §3.1/§3.2 | +6/-3 |
| api_handler | app/server/src/handlers/academy-training-task.ts | handleAccept / handleReject / handleStop | 删除 | 三个 handler 删除 | - | design §3.3 | -60 |
| api_handler | app/server/src/handlers/academy-training-task.ts | handleAdopt | 新增 | POST `/academy/training-task/:tid/adopt` body `{versionId}`；调 `engine.adoptVersion(tid, cid, versionId)`；返 `{newFormalVersionId, newLabel, newWorkspaceDir}` | MUST versionId 必填（body 校验） | api §2.X adopt; design §2.2 | +18 |
| api_handler | app/server/src/handlers/academy-training-task.ts | handlePause | 新增 | POST `/academy/training-task/:tid/pause` body `{reason?}`；调 `engine.pauseTask(tid, cid, reason)`；返 ack | - | api §2.X pause | +14 |
| api_handler | app/server/src/handlers/academy-training-task.ts | handleResume | 新增 | POST `/academy/training-task/:tid/resume` body `{}`；调 `engine.resumeTask(tid, cid)`；返 ack；catch `task_at_maxturns` → 409 + 提示 update-task | MUST maxTurns 到顶 → 409（非 500）；errorResponse 含指引文案 | api §2.X resume; design §7.5 | +14 |
| api_handler | app/server/src/handlers/academy-training-task.ts | handleUpdateTask | 新增 | POST `/academy/training-task/:tid/update-task` body `{maxTurns?, directive?}`；校验至少一字段；store.getTask + merge patch + putTask；返 ack | MUST 仅 maxTurns/directive（其他字段 400 invalid_input） | api §2.X update-task; design §3.1 | +20 |
| api_shared | app/server/src/handlers/academy-training-task-shared.ts | mapEngineError | 修改 | 加分支：`/task_at_maxturns/` → 409 `{error: 'task_at_maxturns', detail: '...需先 update-task 调大 maxTurns'}`；`/不允许 (pause\|resume\|adopt)/` → 409 invalid_task_state（扩现有 regex） | errorResponse 自解释（指引下一步动作） | api §7; design §7.5 | +6 |
| api_route | app/server/src/routes/__tests__/academy-routes-dispatch.test.ts | dispatch UT cases | 修改 | 删 accept/reject/stop 三个 case；加 adopt/pause/resume/update-task 四个 case（路径 pattern 锁定） | MUST dispatch UT 全绿（32→33 case） | api §7.1 | +4/-3 |
| api_doc | specs/api/overall/18-academy.md | §2.3-§2.7 + §7 | 修改 | 删 §2.4 accept/§2.5 reject/§2.6 stop/§2.7 inject-directive（保留 inject-directive）；加 §2.X adopt/pause/resume/update-task；§7 错误码表去 nothing_to_adopt，加 task_at_maxturns；task DTO §2.2 反规范化字段补 `coachSessionId` + `pausedReason` | MUST 与代码同步（doc-modifier 阶段 5 复核）；change_plan 落后 → coder 按代码 + 汇报偏离 | api 18-academy §2/§7 | +50/-30 |

---

## F. Tech KB 更新（coder 编码前置 — 4 核心 KB + 总纲）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tech_kb | specs/tech/academy/[P0]training_engine.md | §1 状态机 + §2 接口 + §3.3 守卫 | 修改 | §1 状态机图重画为三态（pending→running↔paused+reason）+ adopt 旁路标注；§2 TrainingEngine 接口去 proposeTask/acceptTask/rejectTask/stopTask，加 pauseTask/resumeTask/adoptVersion；§3.3 acceptTask 前置守卫段去除（accept 删）；§6 resumeOnStartup 加 migration 旧值映射；§7 去 propose 投递场景，加 adopt/pause/resume 投递场景 | MUST：图、接口、守卫三处对齐代码 change；MUST NOT 保留 propose 字样 | design §5; A 节 lifecycle 改动 | +60/-40 |
| tech_kb | specs/tech/academy/[P0]train_student_tool.md | 文件标题 + §1-§4 重写 | 修改 | 标题 `train-student` → `manage-task`；§1 action 表去 start/status/stop/accept/reject/propose/turn_result（保留 status/turn_result/read_*/evaluate/revise/sample/grade/fork），加 adopt/pause/resume/history；§4 权限矩阵：head_teacher 行删除（无权），coach 行扩全 13 action；§5 profile.toolBound 表 head 删 manage-task/coach 改 manage-task | MUST 文件 title frontmatter 同步改；与 C 节工具层改动严格一致 | design §3.2; C 节 | +80/-70 |
| tech_kb | specs/tech/academy/[P0]session_kind_extension.md | §3.1/§3.2 profile toolBound + §4.1 mapper 表 + §7 工具合并 | 修改 | §3.1 head toolBound 去 train-student/manage-student（只留 manage-classroom 扩 20 action）；§3.2 coach toolBound 改 train-student→manage-task；§4.1 mapper 表加 `academy_head_role`（NEW）；§4.5 改动清单对齐（iteration_state 扩字段/head_role 新增/task_status 补 coachSessionId）；§7 三工具→两工具（manage-student 并入 manage-classroom，train-student→manage-task） | MUST 与 D 节 profile/scope/mapper 改动严格一致 | design §3; D 节 | +50/-30 |
| tech_kb | specs/tech/academy/[P0]data_model.md | §4 TrainingTaskSchema + §6 forkVersionWorkspace/adoptToFormal + §8 INV | 修改 | §4 status enum 重画（3 值 + pausedReason 字段）；§6 forkVersionWorkspace 加 patchVersionJsonLabel 注释；§6 adoptToFormal 加 patchVersionJsonLabel + student.currentFormalVersionId 同步；§8 INV 调整：INV 改为「adopt 可重复，每次产新 formal；adopt 不改 task 状态」 | MUST 与 A/B 节改动严格一致；versionLabel BUG 修复点标注 | design §2.3/§8 BUG; B 节 | +40/-15 |
| tech_kb | specs/tech/academy/[P0]academy_overview.md | §2 角色边界 + §8 关键路径 | 修改 | §2 角色表 head_teacher 行「工具集」改为 manage-classroom only；coach 行改 manage-task only；§8 关键路径：去「propose→accept/reject」尾段，改为「循环 edit+revise → 任何时刻 adopt(versionId) 旁路定稿；maxTurns 到顶 update_task 调大续训」 | 时间紧可标 TODO 交 doc-modifier（非编码前置）；但建议 architect 期落 | design §1.3/§8; PRD §3.2 | +30/-20 |
| tech_kb | specs/tech/academy/index.md | §④ 不变量 2 | 修改 | 不变量 2「双引擎咬合」重画：原「两 start 入口（train-student.start + manage-student.start_training）」→「单一 start 入口（manage-classroom.start_task）+ coach 用 manage-task 推进 + adopt 旁路定稿」；说明 head 退教室层 + coach task 主权 | 与 §2 角色边界对齐；可交 doc-modifier | design §1.3; PRD §4 | +6/-4 |

---

## 影响面评估

**跨模块**：training_engine（A 节 14 行）+ data_model/store ops（B 节 4 行）+ tool 层（C 节 14 行）+ mapper/scope/profile（D 节 12 行）+ API handlers（E 节 9 行）+ tech KB（F 节 6 行）= 59 个符号级行。

**破坏性变更**：
1. `TrainingTaskSchema.status` enum 收窄 6→3（旧数据需 migration，resumeOnStartup 处理）。
2. `train-student` 工具改名 `manage-task`（LLM-facing schema 变更，coach session 重建后自动新 schema）。
3. `manage-student` 工具删除（actions 并入 manage-classroom）。
4. HTTP 路由 `/accept` `/reject` `/stop` 删除（前端如有调用需同步改 — 见下「前端依赖」）。
5. `TurnResult.proposed` 字段重命名为 `paused`。

**依赖顺序**（coder 实施顺序）：
1. **底层先**：A 节 schema（TrainingTaskSchema）→ B 节 store ops（fork/adopt BUG 修复 + patchVersionJsonLabel helper）→ A 节 lifecycle（pause/resume/adopt + migration）→ A 节 revise.ts（去 propose 自动触发）。
2. **中层**：C 节工具层（train-student→manage-task + manage-classroom 扩 + manage-student 删）→ D 节 mapper（iteration_state 扩 + head_role 新增 + coach_role 重写 + task_status 补）+ academy-context 扩。
3. **上层**：E 节 API handlers（路由增删 + mapEngineError 扩）→ F 节 tech KB（与代码并行落，coder 编码前置读）。

**前端依赖**（academy-page UI）：UC-221-F（版本号正确显示）+ adopt 入口 + 任务可续训态。本 change_plan 未覆盖前端，**单独切前端 task**（见 task.json）。

**风险点**：
- **旧 task 数据 enum 失效**：resumeOnStartup migration 是关键（必须幂等 + 在 server bootstrap 异步跑）；pre-existing demo 数据用户已接受破坏（context.md findings）。
- **coach session 在线时 schema 变更**：升级瞬间已有的 coach session 可能看到旧 prompt（含 train-student 字样）+ 新工具定义（manage-task）——下轮 resolveConfig 自动刷新 prompt 解决；无强一致性要求。
- **mapper 扩充 prompt 膨胀**：iteration_state 加版本谱系 + 已采纳 formal 列表，prompt 变长——design §4.1 信息供给分层原则（常驻注入最小化 + 深细节按需查询）须遵守；版本谱系只摘 summary（round/label/decision/avgScore），不带 per-case reasoning。

**持续可打包护栏自检**（CLAUDE.md）：本版**无新依赖/新 session-kind/新 plugin 资源**（沿用 v0.0.210 三 kind），纯既有代码路径调整 + mapper yaml/impl 调整。不触发护栏。

## 反馈回路

- coder 实现时若发现 spec 与代码实际不符（API/方法/enum 漂移），按代码实际调整 + 向 orchestrator 汇报偏离 → orchestrator 记 doc-sync 待办 → doc-modifier 阶段 5 统一修 spec 对齐。
- 同一 task 退回 2 次仍违反本表 → 升级退 architect 重新设计。
- 影响 v0.0.221 验收的核心约束：task 三态机闭合 + adopt 旁路不改状态 + maxTurns 硬门 + versionLabel 写正确 + coach 拿到完整路径不再 ls。
