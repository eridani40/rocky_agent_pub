---
type: index
title: Academy 子系统总起
priority: P0
updated: 2026-08-04
since: v0.0.210
---

# Academy 子系统总起（顶层导航）

> **核心模型（v0.0.221 两轴解耦）**：生产轴（task，coach 绝对主权，三态机 `pending/running/paused+pausedReason`，maxTurns 硬上限）⊥ 归档轴（`adopt(versionId)`，任意 process 版、可重复、**不改 task 状态**）。head 退教室层（实体级访问、管学生/资产/任务监督、靠 send_message 协作）；coach 拿 task 全权（含 adopt/pause/resume/fork 切基线）。两工具拆分：`manage-task`（coach 专属，13 action）+ `manage-classroom`（head 专属，20 action）。versionLabel = `{major}.{taskSeq}.{round}`。

## ① 是什么

academy = **培养专家 agent 的产品板块**：围绕一个目标，通过「教室 + 班主任 + 教练 + 训练引擎」，把一个全空的初始学生版本，经多轮训练迭代，逐步打磨成可用的专家版本，最终可发起会话、可派生到团队。

核心是 **双引擎架构**：
- **agent 引擎**（现成复用）：head/coach/student 都是正经 session，可对话，跑在现有 session + agent loop + inbox + a2a 上。
- **训练引擎**（ academy 域核心）：训练任务的结构化状态机——任务/轮次/过程版本树/评估记录。权威、可靠、可断点续跑。
- **咬合**：agent 引擎用 `manage-task`（coach）+ `manage-classroom`（head）工具操纵训练引擎；训练引擎状态变化自动推 inbox 事件给 coach（+ head）。

> 拼写约定：本版用 **`academy-`** 前缀（biz/role/kind 全用此拼写），与旧 v0.0.183 `academy-` 完全隔离；旧 academy 已于 v0.0.208 整体删除。

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| 训练任务状态机 + 评估 fan-out + 过程版本树 + 3 个新 session-kind profile | 通用 agent loop / context engine / tool execution engine（→ `../agent/`） |
| `manage-task` + `manage-classroom` 两工具契约 | subagent 派生机制（→ `../multi_agent/`） |
| academy 域 schema/store/handler/route | session-workspace 通用机制（→ `../agent/session/`） |
| 教室资产（数据集/评估器/skill）演进 | skill 加载四层扫描（→ `../agent/skills/`） |
| squad derive 通道（从学生版本派生 member） | member/squad 核心 schema（→ `../squad/`） |

## ③ 与系统的关系

```
 specs/prd/overall/12-academy.md（产品权威）
        │
        ▼
 specs/tech/academy/（本目录）
   ├── index.md                         ← 本文件（总起 + 跨 KB 不变量）
   ├── [P0]academy_overview.md          ← 双引擎架构 + 关键决策 + 开放点决议
   ├── [P0]data_model.md                ← classroom/student/version/task/dataset/grader schema + 目录规范
   ├── [P0]session_kind_extension.md    ← academy-head_teacher/coach/student 三新 kind + profile/scope 矩阵
   ├── [P0]training_engine.md           ← 训练引擎状态机（task record + evaluate/revise/forkCandidate 原子 action + 纯函数 gate + 断点续跑）
   ├── [P0]train_student_tool.md        ← manage-task 工具 action 契约（coach 专属，evaluate/revise/fork/adopt/pause/resume/...）
   ├── [P0]evaluation.md                ← 数据集 + 评估器体系 + fan-out 直调实现
   ├── [P0]academy_skills.md            ← learn-skill / train-skill / judge-skill 3 个优化 skill 形态
   ├── [P1]squad_derive.md              ← squad 员工从学生版本派生（deriveFrom 扩展 + 内容复制）
   └── [P1]derive_preview_conflict.md   ← [v0.0.233] derive_academy 预检 + 同名裁决机制（squad_derive 机制补遗）

 specs/api/overall/18-academy.md       ← HTTP 端点契约
 specs/ui/overall/12-academy.md        ← UI 板块视觉/布局契约
 specs/ui/components/academy-page/     ← UI 组件契约（testid / 视觉基线）
```

## ④ 核心设计原则（跨 KB 不变量）

1. **状态机推进权归程序，不归 agent** —— 训练 task `status` 流转（pending/running/awaiting_confirm/done/rejected/aborted）由训练引擎维护；agent 自觉靠不住（async 结果送达是语义合同非机制，agent 会忘回报）。骨架是死的，血肉是活的。
2. **双引擎咬合 = coach 主权（生产轴）+ head 实体级（监督轴）+ adopt 旁路（归档轴）** —— 两正交轴模型：
   - **生产轴**（task）：coach 绝对主权（`manage-task` 工具 13 action：evaluate/revise/fork/sample/grade/adopt/pause/resume/status/turn_result/history/read_dataset/read_grader）；task 三态机 `pending → running ↔ paused + pausedReason(maxturns/completed/stopped/earlystop)`；maxTurns 硬上限（到顶不可 resume 越过，须 head `update_task` 调大再续训）；resumeOnStartup migration 把旧 enum 值（done/aborted/rejected/awaiting_confirm）映射到 paused+reason。
   - **归档轴**（adopt）：`manage-task.adopt(versionId)` 旁路定稿——任意 process 版本可归档为新 formal（x.0 递增），**不改 task 状态**，**可重复调**（同一 task 一生可产多个 formal）；解耦原 propose→accept/reject 链（已删除）。
   - **head 退教室层**：仅 `manage-classroom` 工具（20 action：原 dataset/grader/skill + 学生 CRUD 7 + 任务监督 4 `start_task/list_tasks/get_task/update_task`）；不进 task 内场（要看 task 细节 → `send_message` 给该 task 的 coach，靠 `academy_task_status` mapper 注入的 `coachSessionId` 定位）。
   - **head ∩ coach = task 客观事实**（元数据/状态/版本集/轮次历史）：head 监督级只读（list_tasks/get_task 不下钻 per-case reasoning），coach 持有执行权。
   - **单一 start 入口**：`manage-classroom.start_task`（原 manage-student.start_training 改名 + train-student.start 移除）；两入口（HTTP / 工具）同 `createTrainingTaskAndCoach` 核心。
   - **directive advisory 语义**：head update_task 写入的 directive 是 coach 的主要参考，非硬命令（coach 有自主决策权）。
   - **引擎状态变化**用 `deliverTo` 推 message 到 coach inbox；coach 自主调原子 action 驱动训练（不自动 loop）。
3. **coach = 任务牵引的智能容错层** —— coach **靠任务书 + system prompt（academy_coach_role mapper）牵引**：必须**通过 `manage-task` 原子 action（evaluate/revise/fork/adopt）完成训练**（不能绕过）；coach 直接 edit candidate workspace 的 AGENTS.md/skills；数据格式错/case 为空/评估 JSON 解析失败等脏活 coach 自解（多耗 token 换可靠性），引擎保持干净只暴露清晰原子能力。
4. **每 case 独立 LLM 打分 + 直调 fan-out** —— 评估/学生答题**不起 session**（太贵、撞 subagent 并发上限 4/8 + 不可再派生），走 `LlmCaller.invoke` + pLimit(5) 程序化并发；每 case 独立调用。
5. **一个版本 = 一个目录** —— 学生版本（正式/过程）= 一个 workspace 目录；五元组（model/AGENTS.md/memory/skills/tools）全在目录里；启动版本 agent = 用该目录 + `academy-student` kind 建会话（同构 squad member）。
6. **采纳不删除原 base / 可重复归档** —— `adopt(versionId)` = 把任意 process 版**复制为全新正式版**（按 seq 找下一个空正式版号分配，如 1.0 → 2.0）并**标记「已采纳」**（写 `adoptedFromProcessVersionId` 溯源 + 同步 `student.currentFormalVersionId` 指针）；原 base / process 不动；**同一 task 可多次 adopt**（产 major 递增 formal 序列 2.0/3.0/4.0…）；每次 adopt 不改 task 状态（旁路）。
7. **两类要求分流** —— 训练内 directive 透传进任务（head→核心→任务书→coach 消费）；训练外要求（数据集/评估器迭代）head 提前用工具备好，不进训练任务。**点击开始训练就必须能 work** = 评估器/数据集是任务输入前提。
8. **academy session 与 playground/studio 平级** —— BizType 加 `academy`；academy session 不进 playground/studio 列表（`?biz=academy` 独立过滤）；nav-rail 第 3 业务入口。
9. **过程版本号 3 段** —— 过程版本 label = `{base顶层major}.{taskSeq}.{round}`（如基于 0.0 的任务1轮1 = `0.1.1`），取 `base.versionLabel.split('.')[0]` 作 major，不拼完整 label（避免 multi-turn base 是 process 版时段数爆炸）；正式版号规则不变（x.0）。
10. **版本 skill = 目录 + 文件，读写走 academy 专属端点** —— 五元组的 skills 项不是「一份 markdown」，而是 `.rocky/skills/` 下的目录树（`../agent/skills/[P0]skill_definition.md §1/§2`）；读侧形态 = `SkillSummary`（目录 + 文件树 + per-file hash），单文件内容按需读、仅 formal 版本可写。通道是 academy 自己的版本端点而**不是** `/skill/*` 域——后者 scope 会回落 app/builtin、要求外泄 workspaceDir 绝对路径、且无 formal/process 权限语义；复用只发生在**原语层**（`buildFileTree` / `parseSkillDir` / `skills/file-io.ts`）。写 skill 内容**绝不经** AGENTS.md + version.json 的全量重写路径。→ `[P0]data_model.md §3.1/§6.1` + `specs/api/overall/18-academy.md §1.8/§1.11`
11. **版本对比按全路径两级配对** —— 两版本 diff = skill 目录 × 目录内文件；文件以**完整相对路径**为配对键（同基名不同路径 = 两个文件），「是否修改」只看 per-file hash 而非 size（同长度改动会漏判）；内容不可比对的文件（二进制 / 读失败）只给结论不做行级比对。→ `specs/ui/components/academy-page/component-skill-diff-list.md`
12. **群体级默认模型必须选具体模型、无应用层默认（v0.0.230）** —— 教室级默认模型（`classroom.defaultModel`）是教室会话/建学生播种/建任务 coach 的 model 缺省**唯一来源**：无上一级继承、无 app 默认兜底（app 默认是 playground 个体级逻辑，误用为群体级档是错的，用户确认；academy 对齐 studio 两档链）。教室 head picker 无「跟随应用默认」选项（对齐 squad manageTab）；创建教室即必填默认模型；教室未配 → 会话无「使用默认模型」置顶项 + 运行时/创建链明确 400 `MODEL_NOT_CONFIGURED` 报错引导去教室 head 配置。→ `[P0]academy_overview.md §2.1` + `../agent/providers_and_models/[P0]model_resolve.md §3`
13. **derive_academy seed 补偿只删 written（v0.0.233）** —— 预检+裁决下，`seedMemberWorkspaceFromVersion` 返回的 `written` 只记本次实际写入的顶层目标项（含 AGENTS.md 个人差异文件路径 + 复制的 skills/memory 顶层项）；**skip 项不入 written** → 失败补偿 `rmSync(written, {recursive, force})` 永不误删 squad 团队盘原有同名项；**written 永不含团队根 `.rocky/skills`/`.rocky/memory`/`.rocky/agents` 目录本身**。同名默认 skip（保留 squad 原有）是产品语义基线（用户必须显式 action='overwrite' 才覆盖）。→ `[P1]derive_preview_conflict.md §3-§4`

## ⑤ 与产品对齐

- 产品权威：`specs/prd/overall/12-academy.md`（PRD，引用本目录概念）
- 视觉契约：`reqs/[done] v0.0.210.new_academy/demo/`（11 页 demo + `_tokens.css`）
- 设计决策：`reqs/[done] v0.0.210.new_academy/design.md`（用户多轮拍板的全量决策清单）

> 各 spec 自有 `log.md`（位置轴）；跨版本发布说明见 `../version_logs/vX.Y/change_log.md`。
