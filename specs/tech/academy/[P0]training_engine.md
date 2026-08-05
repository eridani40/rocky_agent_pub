---
type: spec
title: Training Engine — 训练任务状态机 + 原子 action + 断点续跑
priority: P0
status: active
updated: 2026-07-30
since: v0.0.210
---

# Training Engine — 训练任务状态机（coach 主导修订 + 两轴解耦）

> 定位：academy 域核心 — 训练任务结构化状态机。负责 task/turn record 持久化、状态流转、评估 fan-out、纯函数 gate 决策、断点续跑、事件回推 coach inbox。
> 原则：状态机推进权归程序（不归 agent），可靠/可断点续跑/状态一致/评估并发可控。
>
> **[v0.0.221] 两轴解耦**：生产轴（task，coach 绝对主权，三态机 `pending/running/paused+pausedReason`，maxTurns 硬上限不可越过）⊥ 归档轴（`adopt(processVersionId)`，任意 process 版，可重复，**不改 task 状态**）。去 propose/accept/reject/stop（采纳解耦后无 propose 链）；加 pause/resume/adopt。design.md §1-§5 权威；本文件是契约落地。

## 0. 核心模型（两轴解耦 + coach 主导修订）

```
coach（task 绝对主权智能体）         引擎（工具服务 + 状态记录器 + 旁路归档）
  │
  │  读任务书（initial user message）
  │  读 academy-train-skill
  │
  │  ── evaluate(versionId?) ──→        sample+grade 指定版本（纯查询）
  │  ←──── { samples, grades, avgScore, reasoning }
  │  反思 weakness
  │
  │  edit candidate AGENTS.md           （coach 直接改 task.candidateVersionId 的 workspace）
  │
  │  ── revise() ──────────────────→     sample+grade 当前 candidate
  │                                       acceptGate(candidateAvg, baselineAvg)
  │                                       improve → 晋升 baseline + fork 下轮 candidate
  │                                       regress/equal → 保留候选
  │                                       落 turn record + 推 reasoning
  │                                       （到顶/早停 → status='paused'+reason，不再 propose）
  │  ←──── { turn, decision, paused, newCandidateWs, reasoning }
  │
  │  （循环 edit+revise 或 fork 切基线重来）
  │
  │  ── adopt(versionId) ────────→        复制任意 process 版 → 新 formal（x.0 递增）
  │                                       **不改 task.status**（旁路）；可多次调
  │  ←──── { newFormalVersionId, newLabel }
  │
  │  ── pause(reason?) / resume() ─→     task → paused / 回 running
```

- **引擎 = 工具服务 + 状态记录器 + 旁路归档器**：提供 evaluate/revise/fork/adopt/pause/resume 原子 action；sample/grade fan-out 仍引擎跑（§5 不变）。
- **coach = task 绝对主权智能体**：执行权独占 + 决策自主；user/head 是建议通道（directive 是 advisory）。
- **adopt 是旁路**：不在状态机推进路径上，任何时候可调，不动 task 状态；同一 task 可产多个 formal 版本。
- **candidate vs baseline**：`task.candidateVersionId` = coach 正在编辑的待评版本；`task.temporaryBaselineVersionId` = 当前最优已采纳版本（初始 = baseVersionId；切基线时同步替换）。revise improve 时 candidate 晋升为 baseline 并 fork 新 candidate。

## 1. 状态机总览（三态 + adopt 旁路 + maxTurns 硬门）

```
                ┌──────────────────────────┐
                │  pending（建任务未启动）   │
                └────────┬─────────────────┘
                         │ revise（coach 首轮）
                         ▼
        ┌──────────────────────────┐
        │  running（currentTurn++） │◄──────┐
        └────┬─────────────────────┘       │
             │                              │
             │ revise improve               │
             │ → 晋升 + fork 新 candidate    │
             │ → 继续 edit+revise           │
             │                              │
             │ coach pause(reason?)         │
             │ 早停（连续 3 轮无提升）       │
             │ maxTurns 到顶（硬上限）       │
             │                              │ coach resume（须非 maxturns）
             ▼                              │
   ┌─────────────────────────┐              │
   │  paused + pausedReason  │──────────────┘
   │  (maxturns/completed/   │
   │   stopped/earlystop)    │
   └─────────────────────────┘
        │ reason=maxturns（终态，不可 resume 越过；须 update_task 调大 maxTurns 再 resume）
        │ reason ∈ {completed, stopped, earlystop}（可 resume 续训起 round N+1）

   coach adopt(versionId) ──→ 产新 formal（task 状态不变，旁路；可多次调）
```

- **三态**：`pending`（建好未开跑）/ `running`（迭代中）/ `paused + pausedReason`（停了，区分为何而停）。
- **pausedReason 闭合 4 值**：
  - `maxturns` = maxTurns 到顶（**硬终态**，不可 resume 越过；须 head `update_task(maxTurns=N+x)` 调大才能 resume）
  - `earlystop` = 连续 3 轮无提升（早停；可 resume）
  - `completed` = coach 主动 `pause(reason='completed')` 表示本轮目标达成（可 resume 续训）
  - `stopped` = 用户/head 主动叫停（可 resume）
- **adopt 是旁路**：不在状态机路径上，任何时候可调，不动 task 状态。
- **maxTurns 硬上限（不可越过）**：到顶（reason=maxturns）即终态，resume 必抛 `task_at_maxturns`（提示先 update_task 调大）；maxTurns 默认设大（multi=5，simple=1）避免过早触顶。
- **去除** `awaiting_confirm` / `rejected` / `done` / `aborted`（采纳解耦后无 propose→accept/reject 链；done/aborted 合并到 paused+reason）；单个 process 版本仍可有 `status='rejected'`——那是 coach `fork` 丢弃的**版本级**状态，非 task 级。
- **resumeOnStartup migration**（破坏性 enum 收窄，context.md findings）：扫所有 tasks，把旧值映射到 paused+reason（done→completed / aborted→stopped / rejected→stopped / awaiting_confirm→stopped），幂等。

> **无 awaiting_revision / awaiting_confirm 态**：task 不持有「等待」状态；coach 自主推进，引擎只暴露原子 action。

## 2. TrainingEngine 接口（`app/server/src/academy/training-engine.ts`）

> **文件拆分**：单文件 ≤300 行硬限下，引擎拆为主壳 + 子模块：`training-engine.ts`（主壳，原子 action 编排 + 委派）+ `training-engine/{evaluate, revise, fork, lifecycle, assess, sample, grade, gate, messages, helpers, llm-port, p-limit}.ts`。`assess.ts` = evaluate/revise 共享的纯评估核心（sample+grade+avgScore，不改状态）。

```typescript
export interface TrainingEngineDeps {
  academyStore: AcademyStore;
  llmPort: AcademyLlmPort;           // 直调 LLM 窄端口（sample/grade；详见 §5）
  sessionTaskLock: SessionTaskLock;   // per-task lock（type='training-turn'）
  deliverTo: (sessionId, message) => Promise<unknown>;  // 推事件给 coach inbox
  dataDir: string;                    // 绝对路径（resolveDataDir 展开，packaged 护栏 BUG-004）
  pLimitConcurrency?: number;         // 默认 5
}

export class TrainingEngine {
  constructor(private readonly deps: TrainingEngineDeps) {}

  // ── 原子 action（coach 主导修订）──
  /** 纯查询：sample+grade 指定 versionId（缺省=task.candidateVersionId），返 reasoning；不改 task/turn 状态 */
  async evaluateVersion(taskId: string, classroomId: string, versionId?: string): Promise<EvaluateResult>;

  /** 推进一轮：sample+grade 当前 candidate → acceptGate 对比 baseline → improve 晋升+fork 新 candidate；落 turn record；到顶/早停 → status='paused' */
  async reviseCandidate(taskId: string, classroomId: string): Promise<TurnResult>;

  /** 切临时基线 + fork 新 candidate（废弃当前候选重来 / 切到任一历史版本作基线）；更新 task.candidateVersionId + 切基线时同步 temporaryBaselineVersionId */
  async forkCandidate(taskId: string, classroomId: string, baseVersionId?: string): Promise<{ versionId: string; workspaceDir: string; task: TrainingTaskEntity }>;

  // ── 生命周期（coach 调；head 不再有任何 task lifecycle 权限）──
  /** 暂停 task（可逆）：status='paused' + pausedReason（缺省 'stopped'） */
  async pauseTask(taskId: string, classroomId: string, reason?: 'stopped' | 'completed' | 'earlystop'): Promise<TrainingTaskEntity>;
  /** 续训：把 paused task 重回 running（须 pausedReason !== 'maxturns'，否则抛 task_at_maxturns） */
  async resumeTask(taskId: string, classroomId: string): Promise<TrainingTaskEntity>;
  /** 采纳旁路：任意 process 版 → 新 formal 版（x.0 递增）；不改 task 状态；可多次调 */
  async adoptVersion(taskId: string, classroomId: string, processVersionId: string): Promise<{ newFormalVersionId: string; newLabel: string; newWorkspaceDir: string }>;
  /** 断点续跑（bootstrap 钩子）：扫 running task 推 resume；扫旧 status 值 migration 到 paused+reason */
  async resumeOnStartup(): Promise<void>;
}
```

> **已删除的方法**（v0.0.221 采纳解耦）：`proposeTask` / `acceptTask` / `rejectTask` / `stopTask`。
> **不存在的方法**：`runTurn`/`runTurnInternal`/`sampleAndGrade`/`getBaselineScore`/`promoteCandidate` —— 自动循环的私有编排，coach 主导模型下无自动 loop。
> **`forkVersionWorkspace`/`sampleBatch`/`sampleOne`/`gradeBatch`/`gradeOne`/`acceptGate`/`checkEarlyStop`/`reviseBaselineAvg`**：仍为子模块函数（未在 engine class 暴露独立方法），evaluate/revise/forkCandidate 内部调。

## 3. reviseCandidate 详细流程（核心）

```typescript
async reviseCandidate(taskId: string, classroomId: string): Promise<TurnResult> {
  const task = await store.getTask(classroomId, taskId);
  // ── 1. 前置校验 ──
  if (task.status !== 'running' && task.status !== 'pending') {
    throw new Error(`task ${taskId} status ${task.status} 不允许 revise`);
  }
  if (task.status === 'pending') {
    task.status = 'running';
    task.currentTurn = 0;
    // temporaryBaselineVersionId 初始 = baseVersionId（建任务时设）
  }
  if (!task.candidateVersionId) throw new Error(`task ${taskId} 缺 candidateVersionId（coach 无候选可评）`);
  if ((task.currentTurn ?? 0) >= (task.maxTurns ?? 0)) {
    throw new Error(`task ${taskId} 已达 maxTurns ${task.maxTurns}`);
  }

  // ── 2. per-task lock（防并发 revise/evaluate）──
  const lockKey = `academy-task:${taskId}`;
  if (!this.deps.sessionTaskLock.acquire(lockKey, 'training-turn')) {
    throw new Error(`task ${taskId} 已有 in-flight 推进（lock 冲突）`);
  }
  try {
    const round = (task.currentTurn ?? 0) + 1;
    task.currentTurn = round;
    await store.putTask({ ...stripEnvelope(task), currentTurn: round });

    // ── 3. sample + grade 当前 candidate，或 simple/learning 无 dataset 直接采纳 ──
    let samples = [], grades = [], avgScore = 0;
    let decision: GateDecision;
    if (task.datasetId && task.graderId) {
      // assessVersion = evaluate/revise 共享的纯评估核心（assess.ts，复用 sampleBatch+gradeBatch+pLimit）
      const assessed = await assessVersion(deps, store, classroomId, task.candidateVersionId,
        task.datasetId, task.graderId);
      samples = assessed.samples; grades = assessed.grades; avgScore = assessed.avgScore;
      // acceptGate（baseline 语义修正，§4）
      const baselineAvg = reviseBaselineAvg(task, await store.listTurns(classroomId, taskId));
      //   返 undefined = 首次候选（baseline 从未采纳过过程版）→ 直接采纳不比
      decision = baselineAvg === undefined ? 'improve' : acceptGate({ candidateAvg: avgScore, baselineAvg });
    } else {
      // simple/learning 无 dataset → 候选直接采纳（对齐旧 simpleModeFlow；不进 assess）
      decision = 'improve';
    }

    // ── 4. 落 turn record ──
    const turn: TrainingTurnRecord = {
      id: ulid(), taskId, classroomId, studentId: task.studentId,
      round, candidateVersionId: task.candidateVersionId,
      sampleResults: samples, gradeResults: grades, avgScore,
      decision, status: decision === 'improve' ? 'adopted' : 'decided',
    };
    await store.appendTurn(turn);

    // ── 5. improve → 晋升 + fork 下一轮新 candidate ──
    let newCandidateWs: string | undefined;
    if (decision === 'improve') {
      const updated = await store.putTask({
        ...stripEnvelope(task),
        temporaryBaselineVersionId: task.candidateVersionId,
      });
      // fork 新 candidate（round+1）自新 baseline
      const forked = await forkVersionWorkspace(
        store, deps.dataDir, updated.candidateVersionId /* =new baseline */,
        classroomId, task.studentId, task.taskSeq, round + 1, task.id,
      );
      await store.putTask({ ...stripEnvelope(updated), candidateVersionId: forked.versionId });
      newCandidateWs = forked.workspaceDir;
    }
    // regress/equal → candidate 不变（coach 可继续 edit 同一候选或调 fork 重来）

    // ── 6. 早停 + maxTurns 检查 → paused（v0.0.221 不再 propose）──
    const recentTurns = await store.listTurns(classroomId, taskId);
    if (checkEarlyStop(recentTurns)) {
      // 早停：连续 3 轮无提升 → status='paused' + pausedReason='earlystop'（可 resume）
      const pausedTask = await store.putTask({
        ...stripEnvelope(task), status: 'paused', pausedReason: 'earlystop',
      });
      return { task: pausedTask, turn, paused: true };
    }
    if ((task.currentTurn ?? 0) >= (task.maxTurns ?? 0)) {
      // maxTurns 到顶（硬上限）→ status='paused' + pausedReason='maxturns'（终态，不可 resume 越过；须 update_task 调大）
      const pausedTask = await store.putTask({
        ...stripEnvelope(task), status: 'paused', pausedReason: 'maxturns',
      });
      return { task: pausedTask, turn, paused: true };
    }

    // ── 7. 推 revise 结果给 coach（含 reasoning + 新 candidate ws）──
    await deps.deliverTo(
      task.coachSessionId,
      buildReviseResultMessage(task, turn, newCandidateWs, task.coachSessionId),
    ).catch(() => { /* observability 自治 */ });
    return { task, turn, paused: false };
  } finally {
    deps.sessionTaskLock.release(lockKey, 'training-turn');
  }
}
```

### 3.1 evaluateVersion（纯查询）

```typescript
async evaluateVersion(taskId, classroomId, versionId?): Promise<EvaluateResult> {
  // versionId 缺省 = task.candidateVersionId；显式指定可探查 base 或任意版本。
  // 与 reviseCandidate 的 sample+grade 段同链路（复用 assessVersion），但不落 turn record、不改 task 状态。
  // coach 用它探查 base 或 candidate 的表现（如先 evaluate(base) 拿基线分，再 edit candidate → revise 对比）。
  // 无 dataset/grader 抛错（evaluate 需评估配置；simple/learning 走 revise 直接采纳）。
  // 返 { versionId, samples, grades, avgScore } 供 coach 反思。
}
```

> evaluate 对 head_teacher 也开放（head 可探查版本表现，不改状态）；revise 仅 coach（推进状态）。

### 3.2 forkCandidate（显式重来 / 切历史版作基线）

```typescript
async forkCandidate(taskId, classroomId, baseVersionId?): Promise<{ versionId; workspaceDir; task }> {
  // 从 baseVersionId（缺省 task.temporaryBaselineVersionId）fork 新 candidate workspace。
  // 更新 task.candidateVersionId = 新 fork 版本 id。
  // [v0.0.221] 切基线语义：当显式 baseVersionId !== task.temporaryBaselineVersionId 时
  //   （coach 指定切到任一历史版本作基线），putTask 同时更新 temporaryBaselineVersionId = baseVersionId；
  //   不带 baseVersionId 参数时只换 candidate（保持原「废弃重来」语义，不动 temporaryBaseline）。
  // 用途：① coach 觉得当前 candidate 改坏了，废弃重来（不带 baseVersionId）；
  //       ② coach 想从历史某版重新打磨（带 baseVersionId，切基线，下轮 acceptGate 对比新基线）。
  // INV：新 candidate 是唯一 process 版本（唯一 round 避免目录撞）；旧 candidate 不删（INV-6 保留可回看）。
}
```

### 3.3 acceptGate 纯函数 + reviseBaselineAvg（不变；acceptTask 守卫已随 accept 删除）

`acceptGate` 纯函数 + `reviseBaselineAvg` baseline 解析逻辑（§4）**完全不变**——仍是 revise 时判定 candidate 是否 improve 的核心。

> **[v0.0.221] acceptTask 前置守卫随 acceptTask 一并删除**：原「临时基线 === baseVersionId 或 type='formal' → 抛 nothing_to_adopt 409」是 acceptTask 守卫；acceptTask 已删（采纳解耦 → adopt 旁路，acceptGate 不再用于 accept）。新 `adoptVersion` 是旁路，不校验 baseline 是否提升，接受任意 process 版本（type='process' 即可，adoptToFormal 自身校验）。acceptGate 纯函数仅在 reviseCandidate 内用于 decision 判定。

## 4. acceptGate 纯函数 + reviseBaselineAvg（可单测）

```typescript
// app/server/src/academy/training-engine/gate.ts
export interface GateInput { candidateAvg: number; baselineAvg: number; }
export type GateDecision = 'improve' | 'regress' | 'equal';

/** 纯函数 hill-climbing gate（不变） */
export function acceptGate(input: GateInput): GateDecision {
  if (input.candidateAvg > input.baselineAvg) return 'improve';
  if (input.candidateAvg < input.baselineAvg) return 'regress';
  return 'equal';
}

/**
 * 解析 revise 的 baseline avgScore（修正原 getBaselineScore 首次返 0 致恒 improve 的 bug）。
 *
 * 语义：baseline = 当前临时基线版本被采纳时的历史 avgScore。
 *   - task.temporaryBaselineVersionId 缺失 / === task.baseVersionId → 从未采纳过过程版 → 返 undefined
 *     （首次候选 revise 直接采纳 decision='improve' 不比）
 *   - 否则 → 返最近一次 candidateVersionId === temporaryBaselineVersionId 且 decision='improve'
 *     且 avgScore !== undefined 的 turn.avgScore（即当前 baseline 被采纳时的分数）
 */
export function reviseBaselineAvg(
  task: BaselineTask,
  turns: BaselineTurn[],
): number | undefined {
  if (!task.temporaryBaselineVersionId) return undefined;
  if (task.temporaryBaselineVersionId === task.baseVersionId) return undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.candidateVersionId === task.temporaryBaselineVersionId
        && t.decision === 'improve' && t.avgScore !== undefined) {
      return t.avgScore;
    }
  }
  return undefined;
}

/** 早停：连续 3 轮 decision ∈ {regress, equal}（输入可乱序；内部按 round asc 排序后取最后 3 轮判定） */
export function checkEarlyStop(turns: TrainingTurnEntity[], minNoImproveRounds = 3): boolean {
  if (turns.length < minNoImproveRounds) return false;
  const sorted = [...turns].sort((a, b) => a.round - b.round);
  return sorted.slice(-minNoImproveRounds).every(t => t.decision !== 'improve');
}
```

## 5. 评估 fan-out（sample + grade 直调，不变）

sample/grade 直调 `llmPort`（窄端口）+ pLimit(5) 并发 + 每 case 独立调用。`assessVersion`（`assess.ts`）= evaluate/revise 共享的纯评估核心：组装 dataset items → `sampleBatch` → `gradeBatch`（join sample+case）→ 计算有效分 avgScore；不改 task/turn 状态。详见 `[P0]evaluation.md`。

> **version.json.model 必须含 providerId + modelId**——若学生 0.0 初始播种缺 providerId，sampleOne 抛 actionable 错误（不静默 fallback，保五元组契约）。

## 6. 断点续跑 + 旧 status migration（v0.0.221）

```typescript
async resumeOnStartup(): Promise<void> {
  // 启动时扫所有 tasks（遍历 classrooms 分片）：
  //   A) status='running' → 上一 turn 完整结束（decided/adopted）推 buildResumeMessage；
  //                       → 中断层（running/sampled/graded）兜底降级为 graded + 推 buildResumeNeedManualMessage
  //   B) status='paused' → 跳过（稳态；coach 可主动 resume）
  //   C) status ∈ {done, aborted, rejected, awaiting_confirm}（v0.0.220 及更早旧值）
  //      → migration putTask 重写为 status='paused' + pausedReason 映射：
  //         done → pausedReason='completed'
  //         aborted → pausedReason='stopped'
  //         rejected → pausedReason='stopped'
  //         awaiting_confirm → pausedReason='stopped'（原 propose 待审态，已无 propose 链）
  //      → 推 buildResumeFromPausedMessage 提醒 coach 评估是否续训
  //   migration MUST 幂等（二次扫 status='paused' 走 B 分支跳过）
}
```

> **[v0.0.221] enum 收窄是破坏性变更**：schema enumValues 去 done/aborted/rejected/awaiting_confirm。pre-existing 演示数据可能含旧值，resumeOnStartup migration 是关键（必须幂等 + 在 server bootstrap 异步跑 + 不删 record 只重写 status 字段）。academy 还在 demo 阶段，数据破坏用户已接受（context.md findings）。

> bootstrap 启动钩子调 `trainingEngine.resumeOnStartup()`（异步 fire-and-forget，不阻塞 bootstrap）。

## 7. 事件回推（a2a inbox 投递 — 训练引擎 → coach）

每次 task 状态变化后，引擎用 `deliverTo`（与 a2a 投递**完全同路径** = enqueue + activate）推 message 到 coach session 的 inbox。

> **sender 用 `source: 'system'`（`kind: 'academy-training-engine'`）**——不是 `source: 'agent'`。设计动机：训练引擎本身不是 session（无 inbox、无 sessionId）。与 scheduling handlers（heartbeat/cron）走 `source: 'system'` 同模式。`needReply` 信号走 `metadata.needReply: true`。

投递场景（[v0.0.221] 采纳解耦后）：
- **任务书投递**（不变）→ 由 `createTrainingTaskAndCoach` 核心（`academy-training-core.ts`）在建 coach session 后立即 deliverTo(coach, buildTaskBookMessage)——富任务书含学生上下文 + candidate ws 路径 + directive + 工作流指引 + manage-task action 说明。
- **revise 完成** → deliverTo(coach, buildReviseResultMessage)——含本轮 candidateVersionId + avgScore + decision + 各 case reasoning 摘要 + 新 candidate workspaceDir（improve 时）+ 下一步建议；**到顶/早停时 task 已 paused，文案提示「可 update_task 调大 maxTurns 再 resume」**（不再 propose）。
- **pause 完成** → deliverTo(coach, buildPausedMessage)——task paused + reason + 提示 resume 可续。
- **resume 完成** → deliverTo(coach, buildResumeFromPausedMessage)——task 回 running + 当前 candidate versionId + 临时基线 + 提示继续 edit→revise。
- **adopt 完成** → deliverTo(coach, buildAdoptedMessage)——新 formal versionId + label + 源 process versionId + 提示「task 仍在产，可继续迭代」（强调旁路语义）。
- **断点续跑唤醒** → deliverTo(coach, buildResumeMessage)（running 断点）/ buildResumeFromPausedMessage（旧值 migration 后）。

> **已删除的投递场景**：propose 完成（`buildProposedMessage`）——propose 链整条取消；accept/reject 完成通知——accept/reject 方法已删。

## 8. 并发控制（不变）

- **per-task lock**：同一 task 同时只允许一个 revise/evaluate 推进（SessionTaskLock type='training-turn'）。
- **fan-out 并发**：sample/grade 用 pLimit(5)（可配）；同一 task 内顺序。
- **跨 task 并发**：不同 task 可并行。

## 9. 边界

| 管 | 不管 |
|---|---|
| 训练任务状态机 + evaluate/revise/forkCandidate + gate + 断点续跑 + 事件回推 | 本文 ✅ |
| task/turn record schema + store | `[P0]data_model.md §4` |
| sample/grade 真实 LLM 调用机制 | `../agent/llm_caller/` |
| train-student 工具 action 契约 | `[P0]train_student_tool.md` |
| 任务书投递装配（createTrainingTaskAndCoach 核心） | `[P0]session_kind_extension.md §5` |
| deliverTo / a2a 投递 | `../multi_agent/[P1]subagent_derivation.md §4.1` |
