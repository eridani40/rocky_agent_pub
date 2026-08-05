# v0.0.213 — Tech Change Log（coach 训练闭环 + 任务牵引 + 两入口统一 + 版本号 3 段）

> 跨版本发布说明（版本轴）。本目录级变更见 academy KB `log.md`（位置轴）：`specs/tech/academy/log.md`。
> 权威输入：`specs/tech/version_logs/v0.0.213/change_plan.md` + `reqs/[working] v0.0.213.coach/diagnosis.md`。

## 概览

v0.0.213 修复 academy coach 训练式闭环断裂：candidate 是 base 空副本从未被修订（假迭代）+ coach 无任务牵引 + 加载不到 train-skill + cwd 错位 + 两入口未统一 + 版本号 4 段 bug。

五件套：
1. **训练闭环改 coach 主导**：引擎废弃 `runTurn` 自动一气呵成，改为暴露 `evaluate`/`revise`/`forkCandidate`/`propose` 原子 action；coach 按任务书自主调度；`acceptGate` baseline 语义修正（`reviseBaselineAvg`：首次候选直接采纳不比）。
2. **任务牵引**：建 coach session 时由 `createTrainingTaskAndCoach` 投递富任务书 initial user message（学生上下文+candidate ws 路径+directive+工作流指引+train-student action 说明）；新增 `academy_coach_role` mapper 注入稳定教练职责+方法论+skill 指针；`academy_iteration_state` 注入 candidate workspaceDir 绝对路径（修 cwd 错位）。
3. **两入口统一**：抽 `createTrainingTaskAndCoach` 核心（建 task + fork 初始 candidate + 建真实 coach session[workspaceDir=candidate ws] + 投递任务书），HTTP handler 与 head 工具 start 都调它（消除原 start 占位 coachSessionId 偏离）。
4. **train-skill 可见**：3 个 academy skill 从 `app/plugins/skills/` 迁 `app/plugins/builtins/skills/`（builtin 扫描根，dev/打包一致可见），删 build-plugins `academySkillsSrc` workaround。
5. **版本号 3 段化**：`forkVersionWorkspace` label 改 `{base顶层major}.{taskSeq}.{round}`（修原 4 段 bug）。task schema 加 `candidateVersionId` 字段。

**破坏性变更**：
- `train-student` 工具 action enum：去 `run_turn`，加 `evaluate`/`revise`（LLM-facing schema 变；旧 coach session 调 run_turn 会 invalid_action——可接受，旧 task 也无 candidateVersionId 字段）。
- HTTP 端点 `/academy/training-task/:tid/run-turn` → `/revise`（调 `engine.reviseCandidate`）。
- `TrainingTaskSchema` 加 `candidateVersionId`（lazy 可选，向后兼容旧 task record）。
- academy skills 目录迁移（builtin 层只读，用户 app 层独立，不影响用户已安装同名 skill）。
- 版本号 3 段化：旧 4 段 process 版本 label 仍能被 `split('.')[0]` 取 major（adoptToFormal 已用此），不破坏旧数据；新 fork 一律 3 段。

## §1 训练引擎重构（academy KB — training_engine）

- 废弃方法：`runTurn`/`runTurnInternal`/`sampleAndGrade`/`getBaselineScore`/`promoteCandidate`（自动循环私有编排，coach 主导模型下无自动 loop）。
- 新增原子 action：`evaluateVersion`（纯查询 sample+grade）/ `reviseCandidate`（推进一轮 sample+grade→acceptGate→improve 晋升+fork 新 candidate→落 turn→早停/maxTurns→propose→deliverTo revise 结果）/ `forkCandidate`（显式废弃重来）。
- 抽 `assess.ts` 共享核心（evaluate/revise 共用 sample+grade+avgScore，不改状态）。
- `gate.ts` 新增纯函数 `reviseBaselineAvg`：`task.temporaryBaselineVersionId === baseVersionId` → 返 undefined（首次候选直接采纳 decision='improve' 不比）；否则返当前 baseline 被采纳时的历史 avgScore。修原 `getBaselineScore` 首次返 0 致恒 improve 的假迭代 bug。
- simple/learning 无 dataset：revise 跳 sample/grade，候选直接采纳（BUG-002）。
- 详见 `specs/tech/academy/[P0]training_engine.md` §2/§3/§3.1/§3.2/§4。

## §2 两入口统一核心（academy KB — session_kind_extension §5）

- 新增 `academy-training-core.ts`：`createTrainingTaskAndCoach(deps, input)` 5 步核心（gen tid → fork 初始 candidate[createdFromTaskId=tid] → createSession(coach, workspaceDir=candidate ws, trainingTaskId=tid) → putTask(coachSessionId, candidateVersionId, temporaryBaseline=base, status='pending') → 组装 TaskBookPayload deliverTo(coach, buildTaskBookMessage) fire-and-forget）。
- `TrainingCoreError(code)` + `TRAINING_CORE_HTTP_STATUS` 映射（HTTP handler 用，向后兼容 API §7 错误码契约）。
- `handleCreateTask`（HTTP）+ `runStart`（head 工具）都薄壳化调核心；coach workspaceDir = 初始 candidate ws（修原 cwd 错位）。
- 详见 `specs/tech/academy/[P0]session_kind_extension.md` §5.0 + `specs/api/overall/18-academy.md` §2.1。

## §3 消息（任务书富化 + revise 结果回推）

- `buildTaskStartedMessage` → 重写为 `buildTaskBookMessage(payload, coachSessionId)`：富任务书（任务框架 + 学生上下文含 base AGENTS.md 全文 + candidate ws 绝对路径 + dataset/grader + directive 透传 + 工作流指引 + train-student action 说明）。
- `buildTurnDoneMessage` → 重写为 `buildReviseResultMessage(task, turn, newCandidateWs, coachSessionId)`：本轮 candidateVersionId + avgScore + decision + 各 case reasoning 摘要 + 新 candidate workspaceDir（improve 时）+ 下一步建议。
- resume 引导改 evaluate/revise（去 run_turn 措辞）。

## §4 coach 任务牵引可见性（academy KB — session_kind_extension §4.1）

- 新增 `academy_coach_role` system_prompt_mapper：5 段稳定教练身份+引擎分工+6 步工作流（skill→evaluate→反思→edit candidate→revise→循环/propose）+train-student action 说明+candidate ws 路径 hint+skill 指针；仅 coach scope 激活，缺 academyContext graceful 返空。tier=stable priority=970。
- `academy_iteration_state`：注入当前 candidate versionId + workspaceDir 绝对路径（coach edit 定位，修 cwd 错位）；AcademyContextShape 顶层加 `candidateWorkspaceDir` 派生字段。
- scope yaml + plugin.json extImpls 注册 `academy_coach_role`（在 classroom_role 之后、training_directive 之前）。

## §5 academy skills 可见性（academy KB — academy_skills §6）

- 3 目录（academy-train/learn/judge-skill）从 `app/plugins/skills/` 迁 `app/plugins/builtins/skills/`（`builtinSkillRoot()` 扫描根，dev/打包一致可见）。
- `scripts/build-plugins.ts` 删 `academySkillsSrc` workaround（行 123-128），由原 `BUILTINS_SRC/skills` 统一覆盖 academy-* 子目录。
- packaged 护栏 BUG-003 验证：`bun run scripts/build-plugins.ts` 跑通，`dist/builtins/skills/academy-train-skill/SKILL.md` + `academy-coach-role.cjs` bundle 均产出。

## §6 版本号 3 段化 + schema（academy KB — data_model §3/§4/§6）

- `forkVersionWorkspace` process 版本 label 改 `${baseMajor}.${taskSeq}.${round}`（`baseMajor = base.versionLabel.split('.')[0] ?? '0'`，不拼完整 label）。dst 目录路径仍用 base 完整 label（路径唯一性）。
- `TrainingTaskSchema` 加 `candidateVersionId`（ulid, required: false）= 当前 coach 在编辑的候选过程版本 id；与 `temporaryBaselineVersionId` 区分（candidate=待评，baseline=已采纳）。
- `forkVersionWorkspace` 签名加 `root/classroomId/studentId/createdFromTaskId` 参数（round 推进靠 createdFromTaskId 过滤本任务历史版本）。

## §7 API 契约（api KB — 18-academy）

- `POST /academy/training-task/:tid/run-turn` → `/revise`（调 `engine.reviseCandidate`）。
- `POST .../training-task` Response 201 加 `candidateVersionId` + `candidateWorkspaceDir`（建任务即就位）。
- train-student action enum 去 `run_turn` 加 `evaluate`/`revise`；ROLE_PERMISSIONS：head+coach evaluate / coach revise / student 空集。
- 错误码契约不变（TrainingCoreError code → HTTP status 映射向后兼容）。

## 验证

UT 8915 passed/0 failed + AT 2/2 pass（train-multiturn-flow / train-accept，真实调 minimax）+ ET blocking=0（playground-academy-smoke 6 步全走通，验证 coach 收任务书后真自主工作）+ packaged skill 可见 ✓。门禁 §1-5/7/8 满足（§6 本 change_log 进行中，§7 无设计稿，§8 无遗留 fail/small）。
