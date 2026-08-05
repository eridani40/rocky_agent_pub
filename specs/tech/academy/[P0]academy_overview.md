---
type: spec
title: Academy Overview — 双引擎架构 + 关键决策 + 开放点决议
priority: P0
status: active
updated: 2026-07-31
since: v0.0.210
---

# Academy Overview — 双引擎架构

> 定位：academy 板块的**顶层架构契约**。本文件回答「academy 是什么、怎么跑、关键决策为何这样定」；具体子系统细节见同目录其他 spec。
> 输入：`reqs/[working] v0.0.210.new_academy/design.md`（用户多轮拍板的决策全集）+ `reqs/[working] v0.0.221.coach_enhance/design.md`（两轴解耦重构）。

## 1. 双引擎架构（核心决策）

```
┌─────────────────────────────┐         ┌──────────────────────────────────┐
│  agent 引擎（复用现成）       │         │  训练引擎（academy 域核心）         │
│  head/coach/student session  │ manage- │  - 任务/轮次/过程版本树/评估记录    │
│  跑 session+loop+inbox+a2a   │ task /  │  - 状态机推进（pending/running/    │
│                              │ manage- │    paused+pausedReason）           │
│  ↑                           │ class-  │  - adopt 旁路归档（不改 task 状态） │
│  └── inbox 事件自动推 ───────┘ room    │  - 评估 fan-out（直调 LLM+pLimit） │
└─────────────────────────────┘ event   │  - 纯函数 gate（improve/regress）   │
                                        └──────────────────────────────────┘
```

- **agent 引擎管智能**：head/coach/student 都是正经 session，可对话，复用现有 session/agent loop/inbox/a2a/SSE。
- **训练引擎管状态**：训练任务的 status 流转、每步输入输出、过程版本树、评估记录。权威、可靠、可断点续跑。
- **咬合 = 工具操纵 + 事件回推**：coach 用 `manage-task` 工具操纵引擎推进 + 旁路归档；head 用 `manage-classroom` 工具监督 + 资产管理；引擎状态变化用 `deliverTo` 自动推 message 到 coach inbox（与 a2a 投递同路径，复用现成机制）。

## 2. 角色（3 新 session-kind）

| 角色 | kind | 职责 | 工具集 |
|---|---|---|---|
| **班主任 head teacher** | `academy-head_teacher:parent:main` | 每班一个，创建教室自动带；正经 session 可对话；**退教室层**（管学生/资产/任务监督，不进 task 内场；要看 task 细节 → `send_message` 给该 task 的 coach） | 全集（含 `manage-classroom` 20 action：教室资产 + 学生 CRUD + 任务监督 `start_task/list_tasks/get_task/update_task`） |
| **教练 coach** | `academy-coach:parent:main` | 每训练任务对应一个 coach = 正经 session，可对话；**task 生产轴绝对主权 + 容错层**；通过 `manage-task` 完成 evaluate/revise/fork/adopt/pause/resume | 含 `manage-task`（13 action）+ read/web_search + send_message + skill/memory（无教室资产管理） |
| **学生 student** | `academy-student:parent:main` | 归属教室，**学生 = 一棵版本树的容器**；**每个版本是一个 agent**（用版本目录 + kind 启动会话）；学生 session 异步工作，产出落文件或 answer | 学习工具子集（read/glob/grep/bash/skill/memory/web_search/web_fetch） |

### 2.1 session 关系
- **head ↔ coach 可相互通信**（a2a inbox，send_message 拓扑）。
- **student 异步工作**：不实时对话；评估时由训练引擎**直调 LLM**（`AcademyLlmPort.invoke` + pLimit(5)）模拟学生答题，**不起 session**。
- **任务创建分工**：训练任务由 **head 创建**（`manage-classroom.start_task` → 引擎建任务 + 自动起 coach session 绑定接管）；coach 不自建任务。
- **教室级默认模型**（`classroom.defaultModel`，复合 `{providerId?, modelId}`）：建学生播种 0.0 初始版本的 model fallback 链中间档（`body.model` 显式 > **`classroom.defaultModel`** → 未配则报错引导；**v0.0.230 去 app 默认兜底——群体级无应用层默认概念**）；同时是 head/coach 会话 InputModelPicker 顶部「默认模型」项数据源（与 squad.modelDefault 同构）。创建教室即必填默认模型（对齐 squad wizard），存量未配教室 head 显「选择 model」占位 + 运行时明确报错引导。

### 2.2 subagent 角色
- 优化/评估 subagent = 由 coach 用 `agent.spawn` 派生（explorer/knowledge_learning_trainer 模板复用现有机制），**只读观察**对象；coach 用 send_message 与之沟通。
- 评估 fan-out **不**走 subagent（硬约束：subagent 并发上限 per-parent=4 / global=8 且不可再派生），走训练引擎内**直调 LLM** pLimit。

## 3. 版本模型（§2.1 不变量实现）

- **初始版本 = `0.0`**：内容全空，也是**正式版本**。
- 其他**正式版本**：`1.0` / `2.0` / `3.0` …（用户可编辑，编辑后版本号不变）。
- **过程版本** = `{base顶层major}.{任务序号}.{轮次}`（三段化，如 base='0.0' 的任务1轮1 = `0.1.1`；base='1.0' 的任务2轮3 = `1.2.3`）。取 `base.versionLabel.split('.')[0]` 作 major（不拼完整 label，避免 multi-turn base 是 process 版时段数爆炸）。
- 一个训练任务（coach）在 base 下占固定「任务序号」，其内部第 N 轮 candidate = 过程版本 `{major}.{任务号}.{N}`。
- **目录规范**（`<DATA_DIR>/academy/<classroomId>/students/<studentId>/`）：
  - `versions/{0.0,1.0,…}/`（正式版目录）
  - `versions/.work/{base完整label}.{taskSeq}/{round}/`（过程版工作区，**路径用 base 完整 label 保唯一**；versionLabel 字段用 3 段 major.taskSeq.round）
- **采纳旁路（adopt）**：`manage-task.adopt(versionId)` = 把任意 process 版**复制为全新正式版**（按 seq 找下一个空正式版号分配，如 1.0→2.0→3.0…）并标「已采纳」+ 同步 `student.currentFormalVersionId`；**原 base / process 不动**；**不改 task 状态**（旁路）；**可重复调**（同一 task 产多个 formal）。

## 4. 训练两模式（能力模型 = 出发点）

| | **简单模式** | **多轮模式** |
|---|---|---|
| 本质 | **单轮**，优化 skill 直接改 | **带评估**，类似 skillopt 的迭代优化 |
| 前置 | **无**（零依赖兜底） | **需评估能力**（数据集 + 评估器） |
| 优化方式 | 学习式 | 学习式 或 训练式 |
| 流程 | skill 优化 → 新版本 → adopt 归档 | 多轮[生成→评估→决策] → adopt 归档 |
| 评估 | 无 | 每轮评估判进化/退化 |
| 终态 | coach 自主 `adopt(versionId)` 旁路归档为新 formal（可重复） | maxTurns 到顶 / 早停 → paused+reason；coach 选定满意版本 → `adopt(versionId)` 旁路归档 |

- 教室没数据集+评估器 → 只能简单模式；有 → 解锁多轮模式（简单仍可用）。
- 简单/多轮都走双引擎，架构统一。
- 优化方式两种（各做成一个 skill）：**a 学习式**（上网收集专家方法→提炼）；**b 训练式**（用训练集模拟学生生成→提取→评估→反思）。

## 5. 评估（Evaluation）

- **数据集** = 训练集 + 评估集；元素 = 问题 case（可带每 case 独立评估标准）。**挂教室**。
- **评估器** = 对一道题的打分方法；llm-as-judge **每 case 独立调 LLM**（不可一个 agent 给多 case 打分）；也可程序性（精确匹配等）。**挂教室**。
- **评估结果三要素**：分级（正/反/中性 → 反思）+ 分数（用户视角 → 判进化退化）+ 理由（→ 反思，**必填**）。

## 6. 两类要求的分流（用户补充的关键边界）

| 类型 | 例子 | 流向 |
|---|---|---|
| **训练内要求** | "这次去学《旧猫咪》这本书"、"重点优化开头" | **透传**进训练链路：head → coach → 训练任务（任务加 `directive` 训练目标字段）→ 优化 skill 消费 |
| **训练外要求** | "评估器怎么迭代"、"数据集补 case" | **head 提前备好**，不进训练任务。head 用工具自己解决（迭代评估器/补数据集/装 skill），属教室资产演进 |

- 点击开始训练就必须能 work——评估器/数据集是任务输入前提，必须先备好。
- head 工具集独有「管理教室资产」能力（增改数据集/迭代评估器/装 skill），coach/student 没有。
- 训练中可注入指导：训练引擎接收「指导消息」，下轮反思时纳入上下文（head/用户注入引导，不打断程序推进）。

## 7. 开放点决议（design.md 附录 8 问）

| # | 开放点 | 架构决议 |
|---|---|---|
| 1 | 训练引擎状态机详设 | task record 持久化（status + currentTurn + temporaryBaselineVersionId + candidateVersionId）+ coach 主导修订（引擎暴露 evaluate/revise/forkCandidate/adopt/pause/resume 原子 action，coach 按任务书自主驱动；原 runTurn 自动 loop 已废弃；v0.0.221 去 propose→accept/reject 链，改 adopt 旁路）；并发用 per-task lock（SessionTaskLock 复用）；断点续跑 = 启动时扫 status=running 的 task 推 resume 消息 + 旧值 migration（done/aborted/rejected/awaiting_confirm → paused+pausedReason）。详见 `[P0]training_engine.md`。 |
| 2 | manage-task / manage-classroom 工具契约 + profile/scope 矩阵 | v0.0.221 两工具拆分：`manage-task`（coach 专属，13 action：evaluate/revise/fork/sample/grade/adopt/pause/resume/status/turn_result/history/read_dataset/read_grader）+ `manage-classroom`（head 专属，20 action：教室资产 9 + 学生 CRUD 7 + 任务监督 4）；3 kind × main/summary/consolidate = 9 profile + 9 scope yaml。详见 `[P0]train_student_tool.md` + `[P0]session_kind_extension.md`。 |
| 3 | 版本级 tools 白名单字段 | `version.json` 加 `tools?: string[]` 字段（ academy-student 专用）；启动 session 时 `subAgentConfig.tools` 装配链传 instanceOverride → resolveToolSet 取 ∩ bound。详见 `[P0]data_model.md §3` + `[P0]session_kind_extension.md §4`。 |
| 4 | store 与目录规范 | academy 域独立 store（academy-store.ts），落 `<DATA_DIR>/academy/<classroomId>/`；6 entity（classroom/student/student_version/training_task/training_turn/dataset/grader）；详见 `[P0]data_model.md`。 |
| 5 | 优化 skill 形态 | 3 个 academy skill：learn-skill（学习式）/ train-skill（训练式）/ judge-skill（评估器编写参考）；落 builtin `app/plugins/builtins/skills/academy-{name}/SKILL.md`（builtin 扫描根，dev/打包一致可见，coach 可 `skill academy-train-skill` 加载）；progressive disclosure L0/L1/L2 同构。详见 `[P0]academy_skills.md`。 |
| 6 | 评估器类型体系 + 数据集结构化 | grader entity 闭合枚举 `type: 'llm-judge' \| 'em'`（首版只这两种，未来按需扩）；dataset entity 持 items[]，每 item `{ id, question, gradingCriteria?, expectedAnswer? }`；评估器可选 tools 字段（未来扩展）。详见 `[P0]evaluation.md`。 |
| 7 | squad derive 后端实现 | `CreateMemberInput` 加 `mode: 'derive_academy'` + `academySource: {classroomId, studentId, versionId}`（+ `resolution?` 同名裁决）；hire member 事务 step7 调 `seedMemberWorkspaceFromVersion()`：把学生版本工作区 AGENTS.md → `.rocky/agents/{name}-{memberId}.md`（个人差异）、`.rocky/skills` / `.rocky/memory` → 团队盘（全队共享），按 `resolution` per-item conditional copy（同名默认 skip）。派生前预检走独立 endpoint `previewDeriveAcademySeed`。详见 `[P1]squad_derive.md` + `[P1]derive_preview_conflict.md`。 |
| 8 | academy 域观察 UI + 「任意 session 只读」 | 现有 `readOnly = derivation==='subagent'` 局限 → 扩为 query param `?readOnly=1` 或 session-store 加 `observerMode` 字段；academy 域新加 academy-page 板块（classroom-list / detail / student-detail / training-observe / result）；subagent 观察入口仅在 working 状态可点。详见 `specs/ui/components/academy-page/`。 |

## 8. 关键路径

### 8.1 创建教室
`POST /academy/classroom {name}` → 后端事务：建 classroom record + 建 head session（`academy-head_teacher:parent:main`, workspaceDir=`<DATA_DIR>/academy/<classroomId>/head-workspace/`）+ classroom.headTeacherSessionId = sessionId → 返回 `{ classroom, headSessionId }`。

### 8.2 发起训练（两入口统一核心）

**两入口**都调同一后端核心 `createTrainingTaskAndCoach(deps, input)`：
- **产品 UI 入口**：`POST /academy/classroom/:cid/student/:sid/training-task`（HTTP handler `academy-training-task-create.ts`）→ 核心建 task record（directive 入库）+ 建 coach session + 投递任务书 initial user message 触发 coach 自主训练。
- **head 聊天入口**：`manage-classroom.start_task`（head 工具）→ 转调核心建真实 coach（消除原 start 只占位 coachSessionId 不建真实 coach 的偏离）。

**核心三步**（`academy-training-core.ts`）：①校验 + 分配 taskSeq + gen tid ②fork 初始 candidate（round=1 自 base）→ candidateVersionId + workspaceDir ③resolveAcademySessionModel → createSession(coach, workspaceDir=candidate ws, trainingTaskId=tid) ④putTask(coachSessionId, candidateVersionId, temporaryBaselineVersionId=baseVersionId) ⑤读 base resolveVersionContent + 组装任务书 deliverTo(coach)。coach session workspaceDir = 初始 candidate ws（修 cwd 错位，coach 默认 cwd = 候选目录）。

**directive 来源由入口决定**：产品 UI = 用户表单；head 聊天 = head 提炼用户意图。head 只产 directive 字符串，不构建整条任务书（硬骨架永远逻辑注入）。

**任务书内容**（逻辑确定性拼装硬骨架 + directive 透传）：任务框架（学生名+base label+mode+optimizeStyle+maxTurns）+ 学生上下文（base AGENTS.md 全文 + version.json.model）+ candidate workspace 绝对路径（coach 要改的目标）+ dataset/grader 配置名（multi）+ directive + 工作流指引（读 train-skill → evaluate base → 反思 → edit candidate → revise → 循环 → adopt 旁路归档）+ manage-task action 说明。

### 8.3 训练闭环（coach 主导修订）

任务书投递后，**coach 自主驱动**（引擎不自动 loop）：
1. coach 读任务书 + 读 `academy-train-skill`（builtin 层加载）
2. `evaluate(baseVersionId)` —— 探查基线表现（sample+grade，返 reasoning）
3. 反思 weakness（读 gradeResults 的 reasoning）
4. edit candidate AGENTS.md（coach 直接改 task.candidateVersionId 的 workspace 目录）
5. `revise()` —— 引擎 sample+grade 当前 candidate → acceptGate 对比 baseline：improve 则晋升 candidate 为临时基线 + fork 下轮新 candidate；regress/equal 保留候选
6. 循环 4-5 直到满意（或调 `fork` 切基线重来；maxTurns 到顶 / 早停 → task 自动 paused+pausedReason）
7. **`adopt(versionId)`** —— 任意时刻可调，把选定的 process 版旁路归档为新 formal（x.0 递增；不改 task 状态；可重复调产多个 formal）

**simple 模式**（mode='simple'，无 dataset）：跳过 evaluate/acceptGate，coach 直接 edit candidate → revise 走「首次候选直接采纳」分支（baselineAvg=undefined → decision='improve'）→ 到顶后 adopt 归档。

**acceptGate baseline 语义**：baselineAvg = `reviseBaselineAvg(task, turns)`——task.temporaryBaselineVersionId===baseVersionId 时返 undefined（首次候选直接采纳不比）；否则返当前 baseline 被采纳时的历史 avgScore。修原 getBaselineScore 首次返 0 致恒 improve 的假迭代 bug。

### 8.4 派生到团队（squad derive）
squad 创 member 处 → 选 `derive from academy` → 二级 select（classroom → student → version）→ `POST /squad/:squadId/member { mode:'derive_academy', deriveFrom:{classroomId,studentId,versionId}, name, intro }` → hire 事务：建 mate session + 建 member record + **从版本目录复制 AGENTS.md/skills/memory 到 member workspace**（新加 seedMemberWorkspaceFromVersion）。

## 9. 边界

| 管 | 不管 |
|---|---|
| 双引擎架构 + 关键决策 + 开放点决议 | 本文件 ✅ |
| schema/store/目录规范 | `[P0]data_model.md` |
| 3 新 kind + profile/scope 矩阵 | `[P0]session_kind_extension.md` |
| 训练引擎状态机 | `[P0]training_engine.md` |
| train-student / manage-classroom 工具契约 | `[P0]train_student_tool.md`（manage-task）+ `[P0]session_kind_extension.md §7`（manage-classroom）|
| 数据集/评估器体系 | `[P0]evaluation.md` |
| 3 个 academy skill 形态 | `[P0]academy_skills.md` |
| squad derive 扩展 | `[P1]squad_derive.md` |
| HTTP API 端点 | `../../../specs/api/overall/18-academy.md` |
| UI 组件契约 | `../../../specs/ui/components/academy-page/` |
