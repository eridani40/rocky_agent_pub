# train-multiturn-flow — academy 多轮训练全链路（v0.0.221 三态机 + paused 终态）

**模块**：academy
**断言面**：HTTP（建任务 candidateVersionId 就位 + poll 任务级状态推进到 paused + GET turn record 持久化验真调 sample/grade）
**版本**：v0.0.221（task 三态机 pending/running/paused+pausedReason；去 propose→awaiting_confirm 链）

## 覆盖核心逻辑

本 case 覆盖 academy 训练引擎 coach 主导多轮推进主链路（v0.0.221 design 双引擎 + 两轴模型 + PRD 路径）：

1. **CRUD 事务链**（setup）：建教室（同建 head session）→ 建学生（同建 0.0 初始 formal 版本）→ 建数据集 → 建 em 评估器。
   - 4 个 POST 201 事务各自的双向关联（classroom↔head session、student↔initial version）作前置断言。
2. **训练任务发起 + candidate 就位**（POST /academy/classroom/:cid/student/:sid/training-task）：
   - mode=multi + optimizeStyle=training + maxTurns=2 → coach 用 manage-task（原 train-student 改名）evaluate/revise 驱动
   - createTrainingTaskAndCoach：建任务即 fork 初始 candidate（`task.candidateVersionId` 建任务时就位）+
     投递任务书（deliverTo = enqueue + activate）激活 coach 自主跑
   - 响应 `{ task, coachSessionId }`：task.status=pending / candidateVersionId 就位 / coachSessionId 双向关联
3. **coach 自主 evaluate→revise 循环**（核心不变，v0.0.221 仅改终态判定）：
   - coach 被任务书激活后自主调 engine.reviseCandidate：sample+grade 当前 candidate → acceptGate（首次候选
     reviseBaselineAvg 返 undefined → 直接采纳 decision=improve 不比）→ improve 晋升 temporaryBaseline +
     fork 新 candidate → 落 turn record → engine deliverTo 推 revise 结果回 coach inbox 牵引下一轮
   - **[v0.0.221 变更]** engine 在 currentTurn>=maxTurns 时不再 proposeTask（已删），改为 putTask
     status='paused' + pausedReason='maxturns'；或早停时 pausedReason='earlystop'
4. **任务级状态推进 + turn record 持久化**（pending → running → **paused + pausedReason**）：
   - poll GET /training-task/:tid 直到 **status=paused**（替原 awaiting_confirm；三态机终态）
   - GET 验落盘：turns 列表含 round==1 + sampleResults/avgScore 存在（真调 minimax sample + em 纯函数 grade）+
     candidateVersionId/temporaryBaselineVersionId 持久化 + **pausedReason exists**（三态机区分为何而停）

## setup 结构

4 个 POST 建 classroom / student / dataset / grader（em 评估器纯函数 grade）。无 DELETE classroom 端点 →
残留数据无害（classroom name 含 case 标识，不冲突其它 case）。teardown 兜底 pause task（已终态则 409/404 幂等）。

## 真调 LLM 调用次数

| 阶段 | LLM 调用 | 说明 |
|---|---|---|
| coach 自主跑（读任务书 + 决策 evaluate/revise） | ≥2（coach LLM） | coach agent_loop 自主驱动，每轮决策 1+ 次 |
| revise sample（每轮 1 dataset item） | 1-2（AcademyLlmPort.invoke） | coach 跑几轮 revise 就几次 sample；em grade 纯函数 0 次 |
| **合计** | **≥3** | coach LLM + sample；429 → skipped（框架自动） |

## 设计决策与边界

- **poll 观察而非 HTTP /revise 手动推进**：coach 在建任务时即被任务书激活自主跑，HTTP /revise 是
  debug 逃生口（spec §2.3「前端调试/手动推进用」），与自主 coach 竞 per-task lock（task_busy）。AT 测真实
  产品流（poll 任务级状态推进），更稳、更对齐 design（coach 驱动权，引擎=工具服务+状态记录器）。
- **em grader（非 llm-judge）**：grade 为纯函数（matchRule caseInsensitive+trim，0/1 二值），排除 llm-judge 的
  prompt 模板插值 + 额外 LLM 调用 → 降低 429 概率 + 减少变因。
- **maxTurns=2**：engine 在 currentTurn>=maxTurns 自动 pause（pausedReason=maxturns），覆盖多轮能力；
  coach 自主决定每轮 edit/revise 节奏。
- **coach 自主激活假设**：createTrainingTaskAndCoach step⑤ deliverTo(coach, buildTaskBookMessage) = enqueue +
  activate 激活 coach agent_loop。poll timeout 即此假设未成立（executor 报告，改 POST /session/{coach_sid}/run
  显式驱动）。
- **poll 窗 180s**：coach run ~44s（transcript 实证完整闭环），多 case 连续真调 minimax 累计更慢——单 poll
  60s 窗恰逢/累计超时误判钉死（v0.0.215 round1 fail 根因，orchestrator 实证非功能 bug）。框架 poll.timeout
  上限 180（v0.0.203 用户裁决专为 trainer 真 LLM 多 turn 链路放宽），本 case 拉满 180s；case timeout 240 兜底
  （poll 满足即走，上限仅截真挂死）。
- **pausedReason 不断具体值**：闭合 4 值（maxturns/completed/stopped/earlystop），具体哪个由 coach LLM 行为决定
  （到达 maxTurns / 早停），非状态机硬保证 → 只断 exists。
- **round 2 不硬断言**：coach 可能在 round 1 后早停（pausedReason=earlystop，合法行为）；只断 round 1
  （至少 1 轮 revise 发生）+ maxTurns=2 config 验证多轮能力。reaching paused 本身即证明多轮链路通。
- **不依赖 training.* SSE**：spec §6 已对齐 design（engine 状态变化走 deliverTo 推 a2a Message 到 coach inbox，
  非 SSE 事件）；turn 完成判据 = GET 持久化轮询（status + turns 列表），全程零 SSE wait。
- **count-based 不变量不在此 case 范围**（精确 turn 数 / formal 版本数）：AT DSL body 数组谓词只 any/all（无 count），
  UT AcademyStore + training_engine 覆盖。
- **teardown 用 /pause（替原 /stop）**：v0.0.221 /stop 路由删；已 paused 则 409 幂等（invalid_task_state）。

## v0.0.221 vs v0.0.213 差异

| 维度 | v0.0.213 | v0.0.221 |
|---|---|---|
| task 终态 | awaiting_confirm（propose 后） | paused + pausedReason（maxturns/earlystop） |
| propose 链 | engine 自动 proposeTask（maxTurns 触达） | 删 proposeTask；改 putTask status=paused + pausedReason |
| coach 工具 | train-student（evaluate/revise/propose/accept/...） | manage-task（改名；去 propose/accept，加 adopt/pause/resume） |
| teardown 路由 | POST /stop | POST /pause（/stop 已删） |
| TurnResult 字段 | proposed: boolean | paused: boolean（重命名；本 case 不断 TurnResult 直接断 task 状态） |

## spec↔change_plan 冲突点（doc-sync 待办）

- `specs/api/overall/18-academy.md` §2.2 task DTO 未列 `pausedReason` 字段（反规范化字段待补）；
  §2.4-§2.6 accept/reject/stop 路由仍存在（spec 落后代码）。doc-modifier 阶段 5 同步 spec 对齐到代码。

## 引用

- `specs/tech/version_logs/v0.0.221/change_plan.md` A 节（lifecycle 去 propose + pause/resume/adopt +
  revise.ts 去 propose 自动触发 + TurnResult.proposed→paused）+ E 节（/pause /resume /adopt /update-task 路由）
- `specs/tech/academy/[P0]training_engine.md` §1（三态机 pending/running/paused+pausedReason）+
  §3（reviseCandidate maxTurns → paused 不再 propose）+ §7（a2a 投递场景）
- `specs/tech/academy/[P0]train_student_tool.md` §1（manage-task action 矩阵；原 train-student 改名）
- `specs/tech/academy/[P0]session_kind_extension.md` §5.0 — createTrainingTaskAndCoach 5 步 + 任务书投递
- `specs/tech/academy/[P0]data_model.md` §4 — TrainingTaskSchema.status enum 3 值 + pausedReason 字段
- `specs/api/overall/18-academy.md` §1.1/§1.5/§2.1/§2.2/§3.1/§3.6/§6 — API 契约（§2.4-§2.6 spec 落后待同步）
- `states/v0.0.221/verify/test-plan.md` §4 AT 白名单 — 本 case 定义
