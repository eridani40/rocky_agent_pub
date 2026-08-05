---
type: spec
title: manage-task 工具 — coach 专属 task 推进工具（1 工具 13 action）
priority: P0
status: active
updated: 2026-07-30
since: v0.0.221
---

# manage-task 工具契约（coach 专属，单工具多 action）

> 定位：academy 双引擎的**咬合点** — coach agent 通过本工具操纵训练引擎（task 生产轴）+ 旁路归档（adopt）。仿现有 `agent` 工具（spawn/query/abort 单工具多 action）模式。
> 范围：仅契约（input/output schema + action 语义 + 工具层权限）；实现细节由 coder 按 `[P0]training_engine.md` 落地。
>
> **[v0.0.221] 两轴解耦 + 工具改名**：原名 `train-student` → `manage-task`；去 start/status?（status 改 head 监督级 → manage-classroom.get_task）/stop/accept/reject/propose（采纳解耦，无 propose 链）；加 `adopt`（旁路归档）+ `pause`/`resume`（生命周期）+ `history`（轮次历史）。**coach 专属**（head profile.toolBound 不含）。详见 `reqs/[working] v0.0.221.coach_enhance/design.md` §3.2。

## 1. 概述：一个工具，多 action（13 action）

| 工具 | action | 入参 | 返回 | 调用方 |
|---|---|---|---|---|
| `manage-task` | `evaluate` | `{ taskId?, versionId? }`（taskId 隐式=rtc.trainingTaskId；versionId 缺省=task.candidateVersionId） | `{ versionId, samples, grades, avgScore }` | coach |
| `manage-task` | `revise` | `{ taskId? }` | `TurnResult`（含 candidateVersionId+workspaceDir+decision+reasoning+`paused` 标志） | coach |
| `manage-task` | `fork` | `{ taskId?, baseVersionId? }` | `{ versionId, workspaceDir }`（更新 task.candidateVersionId；切基线时同步 temporaryBaselineVersionId） | coach |
| `manage-task` | `sample` | `{ taskId?, caseId }` 或 `{ taskId?, caseIds[] }` | sample result(s) | coach（容错单步） |
| `manage-task` | `grade` | `{ taskId?, caseId, studentOutput }` 或批量 | grade result(s) | coach（容错单步） |
| `manage-task` | `adopt` | `{ taskId?, versionId }` | `{ newFormalVersionId, newLabel, newWorkspaceDir }` | coach |
| `manage-task` | `pause` | `{ taskId?, reason? }`（reason ∈ {stopped,completed,earlystop}，缺省 stopped） | ack | coach |
| `manage-task` | `resume` | `{ taskId? }` | ack（若 pausedReason=maxturns → errorResult `task_at_maxturns` 指引 update_task） | coach |
| `manage-task` | `status` | `{ taskId? }` | `TaskStatusView`（本 task 状态 + 当前 turn + 历史 summary） | coach |
| `manage-task` | `turn_result` | `{ taskId?, round? }` | `TurnResult` | coach |
| `manage-task` | `history` | `{ taskId? }` | `TurnSummary[]`（全部轮次 summary） | coach |
| `manage-task` | `read_dataset` | `{ datasetId }` 或 `{ taskId? }` | `DatasetEntity` | coach |
| `manage-task` | `read_grader` | `{ graderId }` 或 `{ taskId? }` | `GraderEntity` | coach |

> **少占 LLM tool slot**：1 工具 = 1 tool definition。
> **action 矩阵**：去 start/stop/accept/reject/propose（采纳解耦）；加 adopt/pause/resume/history；保留 evaluate/revise/fork/sample/grade/status/turn_result/read_*/read_*。
> **taskId 隐式绑定**（design.md §7.4）：coach session ↔ task 1:1（C6 校验），`taskId` 入参缺省 = `rtc.sessionContext.trainingTaskId`；显式传 taskId 必须 === rtc 的（不匹配 → `task_not_bound` errorResult）。LLM-facing schema 仍列 taskId（便于 LLM 从 prompt 读到时显式传），但工具层兜底校验归属。

## 2. action 详细 schema

### 2.1 evaluate / revise（coach 主导修订核心 action）

```typescript
// evaluate（纯查询）：sample+grade 指定 version，返 reasoning；不改 task/turn 状态
interface EvaluateInput { taskId?: string; versionId?: string; }  // versionId 缺省 = task.candidateVersionId
interface EvaluateResult {
  versionId: string;
  samples: Array<{ caseId: string; studentOutput: string }>;
  grades: Array<{ caseId: string; score: number; level: string; reasoning: string }>;
  avgScore: number;
}

// revise（推进一轮）：sample+grade 当前 candidate → acceptGate → improve 晋升+fork 新 candidate；
//                       到顶/早停 → status='paused' + pausedReason（不再 propose）
interface TurnResult {
  task: TrainingTaskEntity;
  turn: TrainingTurnEntity;
  /** v0.0.221：是否触发 paused（maxTurns 到顶 / 早停）—— 原字段名 proposed 已重命名 */
  paused: boolean;
  /** paused=true 时附 pausedReason（maxturns/earlystop）便于 coach 决策（update_task 调大 or resume） */
  pausedReason?: 'maxturns' | 'earlystop';
}
```

**约束**：
- 仅 status='running' 或 'pending' 的 task 可 revise；pending 首次 revise 时 currentTurn=0、temporaryBaselineVersionId=baseVersionId。
- acceptGate baseline 取 `reviseBaselineAvg`（首次候选直接采纳不比）——详见 `training_engine.md §4`。
- improve 时引擎自动 fork 下一轮新 candidate（更新 task.candidateVersionId）+ 临时基线替换为原 candidate。
- maxTurns 到顶 → status='paused' + pausedReason='maxturns'（终态，不可 resume 越过；须 update_task 调大）；早停 → pausedReason='earlystop'（可 resume）。
- per-task lock（SessionTaskLock type='training-turn'）；并发 revise/evaluate → `task_busy`。

### 2.2 fork（切基线 / 废弃重来）

```typescript
interface ForkInput { taskId?: string; baseVersionId?: string; }  // baseVersionId 缺省 = task.temporaryBaselineVersionId
interface ForkResult { versionId: string; workspaceDir: string; }  // 更新 task.candidateVersionId 指向新 fork 版本
```

> coach 显式调 fork：
> - **不带 baseVersionId**（废弃重来）：从当前 temporaryBaseline fork 新 candidate，candidateVersionId 更新；temporaryBaseline 不动。
> - **带 baseVersionId**（切历史版作基线，design §2.1b）：从指定历史版本 fork 新 candidate，candidateVersionId + temporaryBaselineVersionId **同时更新**为该历史版本 id（下轮 acceptGate 对比新基线）。
>
> round 由引擎按「本任务历史 process 版本最大 roundNumber + 1」算出（保目录唯一，INV-6 旧候选不删）。

### 2.3 adopt（采纳旁路 = 任意 process 版定稿为新 formal，design §2.2）

```typescript
interface AdoptInput { taskId?: string; versionId: string; }  // versionId 必填（指定哪个 process 版归档）
interface AdoptResult {
  newFormalVersionId: string;
  newLabel: string;                // 新 formal 版号（x.0 递增：2.0/3.0/...）
  newWorkspaceDir: string;
}
```

**约束**：
- `versionId` 必填，必须是本 task 产生的 process 类型版本（adoptToFormal 内部 process-only 校验，type !== 'process' 抛错）。
- **不改 task 状态**（旁路；task 仍在产，可继续 round 迭代）。
- **可多次调**：同一 task 一生可产多个 formal 版本（采纳 1.1.2 → formal 2.0，继续迭代，再采纳 1.1.5 → formal 3.0）。
- 原 process 版 status='adopted'（保留可回看）；新 formal record 写 `adoptedFromProcessVersionId` 溯源（v0.0.219 字段沿用）。
- **同步 student.currentFormalVersionId 指针**（BUG-001 修复，见 data_model §6 adoptToFormal）。
- versionLabel 写侧修复（patchVersionJsonLabel，见 data_model §6）。

### 2.4 pause / resume（生命周期，design §3.2）

```typescript
interface PauseInput { taskId?: string; reason?: 'stopped' | 'completed' | 'earlystop'; }
// 返回 ack；task → status='paused' + pausedReason（缺省 'stopped'）

interface ResumeInput { taskId?: string; }
// 返回 ack；task → status='running' + pausedReason=undefined
// 若 task.status !== 'paused' 或 pausedReason === 'maxturns' → errorResult：
//   - status 非 paused：invalid_task_state
//   - pausedReason=maxturns：task_at_maxturns（提示「maxTurns 到顶，先调 manage-classroom.update_task 调大」）
```

**约束**：
- pause：status ∈ {running, pending} 才可调（已 paused → invalid_task_state）。
- resume：status === 'paused' 且 pausedReason !== 'maxturns' 才可调（maxturns 是硬终态）。
- resume **不自动 fork 新 candidate**（coach 自己调 revise/fork 起 round N+1；引擎只负责状态翻转）。

### 2.5 sample / grade（容错单步，保留 — coach 数据格式错/case 为空等脏活自解）

```typescript
interface SampleInput { taskId?: string; caseId: string; }
interface SampleResult { caseId: string; studentOutput: string; }
// 批量：{ taskId?, caseIds[] }
// grade：{ taskId?, caseId, studentOutput } | { taskId?, cases: Array<{caseId, studentOutput}> }
// grade result：{ caseId, score: number, level: 'positive'|'negative'|'neutral', reasoning: string }
```

### 2.6 status / turn_result / history（只读查询）

```typescript
interface TaskStatusView {
  task: TrainingTaskEntity;          // 完整 record（含 pausedReason）
  currentTurnResult?: TurnResult;    // 最近一轮结果
  baselineScore?: number;            // 临时基线 avgScore（首次 = base 评估分）
  history: TurnSummary[];            // 历史轮次摘要（round / decision / avgScore）
}
// turn_result：返指定 round（缺省 = 最新）的完整 TurnResult
// history：返全部轮次 summary（round / decision / avgScore / status）
```

### 2.7 read_dataset / read_grader（资产读取，反思用）

```typescript
interface ReadDatasetInput { datasetId?: string; taskId?: string; }  // 二选一（taskId → task.datasetId）
interface ReadGraderInput { graderId?: string; taskId?: string; }
// 返回完整 entity（含 items / promptTemplate 等）
```

> 用途：coach 在反思/调试时读资产配置；不暴露 write（写资产由 head 用 manage-classroom 工具）。

## 3. LLM-facing schema（action enum + input union）

```typescript
// app/server/src/agent/tools/train-student-tool.ts（文件名保留，导出改名 manageTaskTool）
export const manageTaskTool: Tool = {
  definition: {
    name: 'manage-task',
    description: 'Coach-only task advancement tool: atomic evaluation ops (evaluate/revise/sample/grade), ' +
      'fork to switch baseline, adopt any process version as new formal (bypass, repeatable), ' +
      'pause/resume lifecycle, read task history (status/turn_result/history) and classroom assets (read_dataset/read_grader). ' +
      'Coach-only (head_teacher uses manage-classroom for supervision). taskId implicit from coach session.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['evaluate', 'revise', 'fork', 'sample', 'grade',
                 'adopt', 'pause', 'resume',
                 'status', 'turn_result', 'history',
                 'read_dataset', 'read_grader'],
        },
        taskId: { type: 'string', description: 'optional (implicit from coach session; explicit must match)' },
        versionId: { type: 'string', description: 'evaluate/adopt: target version id' },
        baseVersionId: { type: 'string', description: 'fork: switch baseline to specified version' },
        reason: { type: 'string', enum: ['stopped', 'completed', 'earlystop'], description: 'pause reason (default stopped)' },
        round: { type: 'number', description: 'turn_result: specific round (default latest)' },
        caseId: { type: 'string' },
        caseIds: { type: 'array', items: { type: 'string' } },
        cases: { type: 'array', items: { type: 'object' } },
        studentOutput: { type: 'string' },
        datasetId: { type: 'string' },
        graderId: { type: 'string' },
      },
      required: ['action'],
    },
  },
  handle: async (input, ctx) => engine.executeManageTaskAction(input, ctx),
};
```

## 4. action 权限矩阵（工具层 action 级门控 — coach 专属）

| action | head_teacher | coach | student |
|---|:---:|:---:|:---:|
| evaluate / revise / fork / sample / grade | ❌ | ✅ | ❌ |
| adopt / pause / resume | ❌ | ✅ | ❌ |
| status / turn_result / history | ❌ | ✅ | ❌ |
| read_dataset / read_grader | ❌（head 用 manage-classroom.read_*） | ✅ | ❌ |

**实现**：工具 handler 入口校验 `ctx.sessionConfig.kind.role === 'coach'`，非 coach → 返 `tool_not_allowed`；同时校验 taskId 归属（隐式 = rtc.sessionContext.trainingTaskId，显式传必须匹配，否则 `task_not_bound`）。

> **[v0.0.221] head 不再有 manage-task 权限**：head 退教室层（管学生/资产/任务监督），不进 task 内场（design §1.3）；head 要看 task 内部细节 → `send_message` 给该 task 的 coach。head 的任务监督 action（start_task/list_tasks/get_task/update_task）在 manage-classroom 工具（见 session_kind_extension §7）。

> **分工备注**：`manage-classroom`（head 专属，20 action）= 教室资产 + 学生 CRUD + 版本读取 + 任务监督（start/list/get/update_task）；`manage-task`（coach 专属，13 action）= task 生产推进 + 旁路归档 + 生命周期。两工具完全隔离，无 action 重复（read_dataset/read_grader 两边都有，但语义不同：coach 只读反思 / head 监督级）。

## 5. 工具可见性（profile.toolBound）

| profile.toolBound | 含 manage-task？ |
|---|:---:|
| academy-head_teacher.parent.main | ❌（head 用 manage-classroom 监督级） |
| academy-coach.parent.main | ✅ |
| academy-student.parent.main | ❌ |
| playground/studio 各 main | ❌（与 academy 隔离） |
| 所有 subagent 类型 | ❌（防止 subagent 绕 coach 操纵引擎） |

> **subagent 工具可见性**：academy-coach.subagent.main 的 toolBound 同 studio-mate.subagent.main（探索 + send_message）；不含 manage-task（防止 subagent 绕过 coach 操纵引擎）。

## 6. 注册到 defaultTools

```typescript
// app/server/src/tools/registry.ts
import { manageTaskTool } from '../agent/tools/train-student-tool';
import { manageClassroomTool } from '../agent/tools/manage-classroom-tool';

export function defaultTools(_workdir?: string): Tool[] {
  return [
    // ... 现有工具
    manageTaskTool,           // [v0.0.221] 原 trainStudentTool 改名（coach 专属）
    manageClassroomTool,      // [v0.0.210] head 教室资产管理 + 学生 CRUD + 任务监督（v0.0.221 扩）
  ];
}
```

> 注册到默认集后，可见性由 profile.toolBound 收束（head 不含 manage-task / coach 不含 manage-classroom）。
> **[v0.0.221] 已删除**：`manageStudentTool`（9 action 全部并入 manageClassroomTool）。

## 7. 错误码

| 错误场景 | 错误码 | 说明 |
|---|---|---|
| action 不在 enum | `invalid_action` | engine.validateInput |
| 角色 action 不允许（非 coach 调本工具） | `tool_not_allowed` | handler 入口 role 校验 |
| taskId 归属不匹配（显式传 !== rtc 的） | `task_not_bound` | 隐式绑定校验 |
| task 不存在 | `task_not_found` | 404 |
| task 状态不允许该 action（如 paused 时 revise） | `invalid_task_state` | 409 |
| resume 时 pausedReason=maxturns（硬终态） | `task_at_maxturns` | 提示「先 update_task 调大 maxTurns」 |
| per-task lock 冲突 | `task_busy` | 同时只能一个 revise/evaluate 推进 |
| LLM 429/529/503（sample/grade） | `rate_limited` | 抛 RateLimitedError；coach 可重试或降级 |
| adopt 时 versionId 非 process 类型 | `invalid_version_type` | adoptToFormal 内部校验 |

## 8. 边界

| 管 | 不管 |
|---|---|
| 1 工具 13 action 契约 + LLM schema + 权限矩阵（coach 专属）+ 可见性 | 本文 ✅ |
| revise / acceptGate 状态机实现 | `[P0]training_engine.md` |
| adopt 旁路实现（adoptToFormal 调用） | `[P0]training_engine.md §A` + `[P0]data_model.md §6` |
| sample/grade fan-out 直调 | `[P0]training_engine.md §5` + `[P0]evaluation.md` |
| schema/store（task/turn record） | `[P0]data_model.md §4` |
| head 的任务监督（start_task/list_tasks/get_task/update_task） | `[P0]session_kind_extension.md §7`（manage-classroom 工具） |
| tool execution engine 调度 | `../agent/tools/[P0]tool_execution_engine.md` |
