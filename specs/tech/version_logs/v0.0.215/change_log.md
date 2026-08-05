# v0.0.215 跨版本发布说明 — head 学生可见性修复（1 mapper + 1 tool）

> 跨子系统发布说明（tech 各 KB 的 `log.md` 是位置轴，本文件是版本轴汇总）。契约见同目录 `change_plan.md`（23 行 method 级 8 列）。
> 本版**跳过 PRD**：纯技术偏离修复（实现偏离 spec §5：`AcademyContext.students` 已填充但无 mapper 消费 + head 无学生 CRUD/版本读取工具），无用户可感知新概念。

## 交付物

### 后端（academy + plugin）

- **新 mapper** `app/plugins/builtins/rocky_context/prompt/academy-classroom-students.ts`（85 行）—— `AcademyClassroomStudentsMapper` 消费 `academyContext.students + tasks + formalVersionLabels`，渲染「## 学生名单」段进 head prompt（每人：名字/id/当前正式版 label+versionId/版本数/在跑任务 #seq status 轮次；空名单给 `create_student` 指针）。tier=context，priority=855（assets=860 后、task_status=850 前）。
- **新建学生统一核心** `app/server/src/academy/academy-student-core.ts`（122 行）—— `createStudentWithInitialVersion(deps, input)` 4 步编排（classroom 存在校验 → resolveAcademySessionModel 播种 → putStudent + createInitialFormalVersion → 回写 currentFormalVersionId+versionIds → getVersion 重读返响应形状）。抛 `StudentCoreError(code)`，HTTP 按 `STUDENT_CORE_HTTP_STATUS` 映射，工具层按 code 拼 errorResult。仿 `createTrainingTaskAndCoach` 两入口模式（HTTP `handleCreateStudent` + 工具 `create_student`）。
- **新工具** `manage-student`（head 专属，9 action）：
  - `app/server/src/agent/tools/manage-student-tool.ts`（130 行）—— schema + role='head_teacher' 兜底门 + dispatch。
  - `app/server/src/agent/tools/manage-student-actions.ts`（247 行）—— 学生 CRUD + 版本读取 7 action（list/get/create/update/delete student + list_versions/get_version 五元组）。
  - `app/server/src/agent/tools/manage-student-training-actions.ts`（112 行）—— 训练 2 action（start_training 薄壳调 `createTrainingTaskAndCoach` + training_status 看板）。
- **context 扩展** `app/server/src/academy/academy-context.ts` —— head 分支新增逐生 `safe(getVersion)` 解析 formalVersionLabel，组装 `formalVersionLabels: Record<versionId, label>` 注入返回值（单生失败跳过不阻塞）。
- **duck 类型扩** `app/plugins/builtins/rocky_context/prompt/academy-shared.ts` —— `AcademyContextLike.students` 元素加 `versionIds?: string[]`；`tasks` 元素加 `studentId?: string`；顶层加 `formalVersionLabels?: Record<string,string>`。
- **role mapper 扩** `academy-classroom-role.ts` —— head 分支身份正文从单行改多行：职责（manage-student 管学生+发起训练；train-student 审核）+ 训练产出 = 五元组语义 + 分工（head 发起+审核，coach 任务内推进）。coach/student 分支不动。
- **装配接线**：`plugin.json` extImpls 加 `academy_classroom_students` 条目（+6 行文本定点替换，禁 python json.dump 全文重排）；`scopes/academy-head_teacher.parent.main.yaml` mapper chain 在 `academy_classroom_assets` 后插 `academy_classroom_students`；`session-types/academy-head_teacher.parent.main.yaml` toolBound 在 `manage-classroom` 后加 `manage-student`；`tools/registry.ts` defaultTools import + 注册 manageStudentTool（manageClassroomTool 后）。
- **coach/student toolBound 扩基础文件工具**（用户裁决 v0.0.215）：
  - `academy-coach.parent.main.yaml` 加 `write`（candidate 版本 AGENTS.md/skill/memory 修订刚需；coach transcript 实证 write 被 `tool_not_allowed` 拦截只能绕 bash 写盘）。
  - `academy-student.parent.main.yaml` 加 `write + edit`（学生演练工作需写改文件；原注释「学生不改 workspace」为旧假设，用户推翻——默认给基础读写，除非特意收窄；`version.json.tools` 仍可 instanceOverride 收窄）。
- **train-student-actions.ts**：私有 helper `buildCoreDeps` / `coreErrorToResult` 加 `export` 关键字（manage-student.start_training 复用同一 TrainingCoreDeps 构造 + TrainingCoreError 映射，防双份漂移）。只加 export，不改实现。

### 测试基建（端口跨会话隔离 — v0.0.215 增补任务）

- `tests/lib/port_alloc.sh`（重写，220 行）—— 版本编码基址函数 `_port_suffix` / `_port_at_*_base` / `_port_et_*_base` + 全局注册表 `_port_registry_*` + `_port_kill_tree`（pid+descendants，cmdline marker 验证）。
- `tests/api/env_start.sh` + `env_shutdown.sh` —— 端口改 `_port_at_*_base`（AT API=42xxx / WEB=44xxx 段）；清残留改 `_port_kill_tree`（marker=`index.ts`），删 `lsof|xargs kill` 裸杀。
- `tests/e2e/env.sh` —— 端口改 `_port_et_*_base`（ET API=43xxx / WEB=45xxx / CDP=46xxx 段）+ `_kill_port_orphans` cmdline 验证。

### spec

- `session_kind_extension.md`：§3.1 head toolBound 加 manage-student；§3.2 coach toolBound 加 write + 说明；§3.3 student toolBound 加 write+edit + 说明（去掉「学生不改 workspace」旧注释）；§4.1 mapper 表加 `academy_classroom_students` 行 + AcademyContextLike 字段扩说明；§5.0b 新增 `createStudentWithInitialVersion` 核心段；§5.2 head 分支补 formalVersionLabels 解析；§7.1 加 manage-student 工具契约表 + 分工备注 + BUG-001 已知偏离注。
- `train_student_tool.md`：§4 权限矩阵下补分工备注（manage-student 是 head 学生 CRUD/版本/发起训练主入口；train-student 保留 coach 任务内推进 + head 审核）；§2.7 propose 约束注「设计意图 vs 现状」（`buildProposedMessage` 已支持两态但 `proposeTask` 仅投 coach，head 靠轮询）。
- `api/overall/18-academy.md`：§6 propose→head 投递行从「待后续版本补」改为现状说明（消息构造已就绪 + proposeTask 当前只投 coach + head 轮询兜底）。
- `ui/overall/00-app-guide.md`：§3.3 academy 段补「head 聊天内学生管理」子项（manage-student 工具 9 action + 非按钮 + 后端核心同 HTTP）。
- `tech/testing/`：`at-framework.md §4.3` 新增端口跨会话隔离（版本编码千段 + 全局注册表 + 只杀自己 pid）；`et-framework.md §4.3/§4.4` 对齐；`index.md` 概念表 + ④原则加端口隔离条；`log.md` v0.0.215 条目。

## 实现偏离（已对齐到代码实际，已报 orchestrator 裁决采纳）

1. **actions 拆两文件**：change_plan 行 36-41 规划全部 9 action 在 `manage-student-actions.ts` 单文件（预估 ~350 行超 300 行硬上限）→ coder 拆为 `manage-student-actions.ts`（学生 CRUD+版本 7 action，247 行）+ `manage-student-training-actions.ts`（start_training/training_status 2 action，112 行），仿 train-student tool/actions 拆分模式。spec §7.1 未点名文件名（只列 action 表），无需改。记本偏差入此 log。
2. **suffix 来源取 worktree 目录名（非 package.json fallback）**：用户原文未指定来源；coder 偏离——`tests/lib/port_alloc.sh _port_suffix()` 从 worktree 目录名 `v0.0.NNN-...` 抽 NNN（package.json 此刻仍 0.0.214 滞后，close-out 才 bump；worktree 名才是会话版本真相）。与 `tests/api/lib/run_all.sh:74` 已有先例一致。实测 v0.0.215 → 42215/43215 如期。
3. **端口布局千段隔离（非「43xxx 内偏移」）**：用户原文提「AT 42xxx / ET 43xxx」未细化 web/cdp；coder 偏离——suffix 可达 999，43xxx 段只够 API 容纳，WEB/CDP 内偏移会与 AT WEB 44000+suffix 边缘重叠（v0.0.999 ET CDP=46999 vs AT WEB=44999 邻段不撞，但若都挤 43xxx 会撞）。改用独立千段（AT API 42xxx / ET API 43xxx / AT WEB 44xxx / ET WEB 45xxx / ET CDP 46xxx）杜绝跨版本跨 kind 重叠。容错 `+0~+19`。

## 已知偏离（pre-existing known-issue，不阻塞合并）

- **BUG-001**：academy accept 后读侧/UI 指针滞后——`get_student`/`list_students` 的 `currentFormalVersionLabel` 在 accept 发布新正式版后仍显示旧 label（`student.currentFormalVersionId` 指针未被 `acceptTask` 同步更新）；同时 UI「训练任务」tab 列表聚合缺失（head 通过聊天发起的 task 未进 UI 看板）。两瑕疵均 pre-existing（accept 流程 + UI 聚合层，非 v0.0.215 引入），不影响 head 主链路 4 观察点（认识学生/发起训练/讲清五元组/采纳）——ET verdict=small blocking=0。详 `states/v0.0.215/bugs/BUG-001-academy-accept-read-side-pointer-lag-[open].md`。
- **propose→head deliverTo 未接通**：`buildProposedMessage`（`training-engine/messages.ts`）已支持 `recipientRole: 'head' | 'coach'` 两态构造，但 `proposeTask`（`training-engine/lifecycle.ts:29-32`）当前只对 `task.coachSessionId` 投递 coach 消息；head 这一支未投递。head 靠轮询发现 awaiting_confirm（`train-student.status` / `manage-student.training_status` 看板）。pre-existing（非 v0.0.215 引入）。后续版本在 `proposeTask` 加第二投即可启用 push 通道。

## 回归

`bun run typecheck` 0 error；`bun run test` 全绿（772 文件 9043 tests，新增/扩展 UT 33 tests：manage-student 14 + academy-mappers 19 含新增 5）。AT 版本白名单 3/3 pass（head-manage-student + train-accept + train-multiturn-flow，真调 minimax，wall 296s）；ET playground-academy-head-train verdict=small blocking=0（4 核心观察点全 PASS：head 认学生/发起训练/讲清五元组/采纳为 v1.0；2 处 small 瑕疵均 pre-existing → BUG-001）。本版本**新增 1 条 AT case**（head-manage-student：head 决策链全链路 + 防假能用 5 条认输话术硬断言），符合「新板块 LLM 不确定性场景入选」标准（academy 板块冒烟 + head 决策链跨层）。
