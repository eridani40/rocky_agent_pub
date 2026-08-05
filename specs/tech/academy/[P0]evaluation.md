---
type: spec
title: Evaluation — 数据集 + 评估器体系 + fan-out 直调实现
priority: P0
status: active
updated: 2026-07-29
since: v0.0.210
---

# Academy Evaluation — 数据集 + 评估器体系

> 定位：academy 域评估能力的数据模型 + fan-out 直调实现。基于调研结论：subagent 并发上限/不可再派生 → **评估 fan-out 必须走直调 LLM + pLimit**，不起 session。
> 数据集/评估器都挂**教室**（不挂学生、不挂任务），多任务/多学生共享。

## 1. 数据集（Dataset）

### 1.1 结构（[P0]data_model.md §5 已定 schema）

```typescript
interface DatasetEntity {
  id: string;
  classroomId: string;
  name: string;
  description?: string;
  items: DatasetItem[];
}
interface DatasetItem {
  id: string;                       // case id（dataset 内唯一；用作 sample/grade key）
  question: string;                 // 问题正文
  gradingCriteria?: string;         // 每 case 独立评估标准（可选；默认走 grader.promptTemplate）
  expectedAnswer?: string;          // 期望答案（'em' grader 必填；llm-judge 可选作 reference）
}
```

### 1.2 操作（head 用 manage-classroom 工具）

- `add_dataset { classroomId, name, description?, items[] }` → 建新 dataset。
- `update_dataset { datasetId, name?, description?, items? }` → 改字段（items 全量替换；不做增量 diff，避免复杂）。
- `delete_dataset { datasetId }` → 软删（dataset record 加 archived 字段；不真删，保数据完整性）。
- `list_datasets { classroomId }` → 教室下所有 dataset。

> items 全量替换（非增量）= 简单直接；用户偏好原则（user-prefers-simple-direct-refactor-no-defensive-checks memory）。

### 1.3 消费链

训练任务 `start` 时指定 `datasetId` → task.datasetId 落盘 → assessVersion（evaluate/revise 共享核心）内部 `academyStore.getDataset(task.datasetId)` → items 作为 sample/grade 输入。

## 2. 评估器（Grader）

### 2.1 类型体系（闭合枚举）

```typescript
type GraderType = 'llm-judge' | 'em';   // 首版只这两种
```

| 类型 | 实现 | 用途 |
|---|---|---|
| `llm-judge` | 直调 LlmCaller + promptTemplate 插值 + 解析 `{score, reasoning}` | 主观题/开放题（写作、客服质检） |
| `em` | 纯函数精确匹配（==、caseInsensitive、trim） | 客观题（分类、抽取） |

> 未来按需扩：`regex`（正则匹配）/ `contains`（包含）/ `rubric`（多维 rubric 评分）。首版只两种保简单。

### 2.2 结构（[P0]data_model.md §5 已定 schema）

```typescript
interface GraderEntity {
  id: string;
  classroomId: string;
  name: string;
  type: GraderType;
  // type='llm-judge' 字段：
  promptTemplate?: string;          // 含 {question}/{student_output}/{criteria} 占位符
  providerId?: string;              // 可选指定 judge 模型；缺省 = 学生所用模型
  modelId?: string;
  threshold?: number;               // 默认 0.5；>= = positive，< = negative
  // type='em' 字段：
  matchRule?: { caseInsensitive?: boolean; trim?: boolean };
}
```

### 2.3 操作（head 用 manage-classroom 工具）

- `add_grader { classroomId, name, type, promptTemplate?, ... }`
- `update_grader { graderId, ... }`
- `delete_grader { graderId }` → 软删。
- `list_graders { classroomId }`。

### 2.4 promptTemplate 约定

```
你是一位严格的评分员。请对学生的回答评分。

【题目】
{question}

【学生回答】
{student_output}

【评分标准】
{criteria}

请输出 JSON：{"score": 0.0-1.0, "reasoning": "评分理由（必填）"}
```

- 占位符：`{question}` / `{student_output}` / `{criteria}`（由 grade 实现插值）。
- 输出格式：JSON（解析失败由 coach 容错重试 — 不是引擎责任）。
- reasoning 必填（design.md §5.2 评估三要素）。

## 3. 评估结果（GradeResult）

```typescript
interface GradeResult {
  caseId: string;
  score: number;                    // 0.0-1.0（用户视角分数）
  level: 'positive' | 'negative' | 'neutral';  // 分级（反思用）
  reasoning: string;                // 必填（反思用）
}
```

### 3.1 level 阈值（基于 grader.threshold，默认 0.5）

| 条件 | level |
|---|---|
| score >= threshold | 'positive' |
| score < threshold 且 score >= threshold - 0.3 | 'neutral' |
| score < threshold - 0.3 | 'negative' |

> threshold - 0.3 是经验值（demo 体现）；可后续按需调。

## 4. fan-out 直调实现（关键工程约束）

### 4.1 为何不走 subagent（调研结论）

- subagent 并发上限 per-parent=4 / global=8（`agent-manager-children.ts:25-27` LIMIT_PER_PARENT_SUB=4 / LIMIT_GLOBAL_SUB=8）。
- subagent 不可再派生（bound 无 agent 工具）。
- deps 注入限制（student_sample/student_grade 仅 trainer 注入）。
- 评估 N>4 case 时被 subagent 路径拒；且每 case 一个 subagent 太贵（session 创建开销 + transcript 落盘）。

**结论**：评估/学生答题**必须走直调 LLM** + pLimit 并发。

### 4.2 实现路径（`app/server/src/academy/training-engine/sample.ts` + `grade.ts`）

```typescript
// 现有可复用底座（调研 §2 已确认）：
//   LlmClient.stream（裸调）/ LlmCaller.invoke（带 retry 编排）
//   pLimit 范式（refs/easy-skill-trainer + academy-engine 已有样板）

import pLimit from 'p-limit';

export async function sampleBatch(deps, task, cases): Promise<SampleResult[]> {
  const limit = pLimit(deps.pLimitConcurrency ?? 5);  // 默认并发 5
  return Promise.all(cases.map(c => limit(() => sampleOne(deps, task, c))));
}

export async function gradeBatch(deps, task, samples, grader): Promise<GradeResult[]> {
  const limit = pLimit(deps.pLimitConcurrency ?? 5);
  return Promise.all(samples.map(s => limit(() => gradeOne(deps, task, s, grader))));
}
```

### 4.3 错误处理（RateLimitedError）

- LlmCaller.invoke 遇 429/529/503 → 抛 RateLimitedError。
- assessVersion（evaluate/revise 共享核心）内部：单个 case fail 不阻塞其他 case；失败的 case 在 gradeResults 里标 `{ score: -1, level: 'neutral', reasoning: 'rate_limited' }`。
- 整批全 fail → assessVersion 抛错；coach 可重试（工具层返 `rate_limited` 错误码）。

### 4.4 模型解析

- sample 用 student 的 `version.json.model`（学生用什么模型，sample 就用什么）。
- grade 用 grader.providerId/modelId（缺省 = 学生所用模型；可让 judge 用更强模型如 gpt-4 评 minimax 输出）。

## 5. 评估流程在 evaluate/revise 中的位置

详见 `[P0]training_engine.md §3/§3.1`：evaluate（纯查询）与 revise（推进一轮）都调 `assessVersion` 共享核心（sampleBatch + gradeBatch + pLimit(5)）。
```
指定 version workspace
  ↓
sample batch（直调 LLM；pLimit(5)）
  ↓ 学生输出落 result.samples
grade batch（直调 LLM 或 em；pLimit(5)）
  ↓ 评估结果落 result.grades，avgScore 计算
（evaluate 返 {versionId, samples, grades, avgScore}；revise 继续走 acceptGate 决策 + 落 turn record）
```

## 6. 学习式无评估（simple 模式 + learning 优化式）

- mode='simple' + optimizeStyle='learning'：不走评估，coach 自由心证（调 web_search + learn-skill + write candidate workspace）→ propose。
- 引擎不强制 sample/grade；task.datasetId/graderId 可空。

## 7. 边界

| 管 | 不管 |
|---|---|
| 数据集 + 评估器 schema + 操作（add/update/delete） | 本文 ✅（schema 在 data_model.md） |
| fan-out 直调实现（sample/grade batch） | 本文 §4 ✅（实现在 training_engine.md §5） |
| 评估结果三要素（score/level/reasoning） | 本文 §3 ✅ |
| 评估器类型体系闭合枚举 | 本文 §2.1 ✅ |
| LlmCaller.invoke 实现 | `../agent/llm_caller/` |
| pLimit 范式 | 现有底座（调研 §2） |
| manage-classroom 工具契约（add_dataset 等 action） | `[P0]train_student_tool.md §1` 框架 + coder 实现时细化 |
