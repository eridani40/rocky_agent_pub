/**
 * training-engine/messages — deliverTo 推送的消息信封构造
 * 参考: specs/tech/academy/[P0]training_engine.md §7（事件回推：任务书投递 + revise 结果回推）
 *       specs/tech/multi_agent/[P1]a2a_protocol（needReply + sender 信封）
 *
 * coach 主导修订：
 *   - buildTaskBookMessage：富任务书（任务框架 + 学生上下文 +
 *     candidate ws 路径 + dataset/grader + directive + 工作流指引 + action 说明）
 *   - buildReviseResultMessage：revise 结果回推（决策 + reasoning + 新 candidate ws）
 *   - resume 引导改 evaluate/revise（去 run_turn 措辞）
 *
 * 设计：
 *   - sender 用 `source: 'system'`（kind='academy-training-engine'）—— 训练引擎本身不是 session
 *     （无 inbox、无 sessionId），与 scheduling handlers（heartbeat/cron）同模式。
 *   - needReply 信号走 metadata.needReply=true（system sender 无 needReply 字段）。
 *   - 内容含 task 上下文（taskId / round / decision / candidate ws 路径）让接收方无歧义。
 */
import { ulid } from '../../config/ulid';
import type { Message } from '../../message/types';
import type { TrainingTaskEntity, TrainingTurnEntity } from '../academy-store';

/** version.json.model 子集（任务书 baseVersion.model 用） */
export interface TaskBookModel {
  providerId?: string;
  modelId: string;
}

/**
 * 任务书 payload（createTrainingTaskAndCoach 组装，buildTaskBookMessage 消费）。
 * 形状逻辑确定性拼装硬骨架 + directive 透传（MUST NOT 把 directive 写死）。
 */
export interface TaskBookPayload {
  /** 任务实体（含 id / taskSeq / mode / optimizeStyle / maxTurns / baseVersionId） */
  task: TrainingTaskEntity;
  /** 教室（含 name 作学生归属上下文） */
  classroom: { id: string; name: string };
  /** 学生（含 name 作任务对象） */
  student: { id: string; name: string };
  /** base 版本（学生当前正式版，coach 对照修订的源） */
  baseVersion: {
    id: string;
    label: string;
    /** base AGENTS.md 全文（coach 反思 + 修订对照） */
    agentsMd: string;
    model: TaskBookModel;
  };
  /** candidate 版本（coach 要改的目标，初始 = round1 fork 自 base） */
  candidateVersion: {
    id: string;
    /** candidate workspace 绝对路径（coach edit 目标；coach 按 prompt 绝对路径 edit） */
    workspaceDir: string;
  };
  /** dataset 配置名（multi 模式必填） */
  dataset?: { id: string; name: string };
  /** grader 配置名（multi 模式必填） */
  grader?: { id: string; name: string };
  /** directive（训练目标，head/用户产；透传不写死） */
  directive?: string;
}

/**
 * 构造任务书消息（建 coach session 后立即 deliverTo — coach 任务牵引入口）。
 * 富任务书：任务框架 + 学生上下文（base AGENTS.md 全文 + model）+ candidate ws 绝对路径 +
 * dataset/grader 配置名 + directive 透传 + 工作流指引 + manage-task action 说明。
 *
 * MUST 含 task.id（coach 调各 action 的 taskId）；MUST 含 candidate workspaceDir 绝对路径。
 */
export function buildTaskBookMessage(
  payload: TaskBookPayload,
  coachSessionId: string,
): Message {
  const { task, classroom, student, baseVersion, candidateVersion, dataset, grader, directive } = payload;
  const evalSection = dataset && grader
    ? `## 评估配置
- dataset：${dataset.name}（${dataset.id}）
- grader：${grader.name}（${grader.id}）
`
    : '';
  const directiveSection = directive
    ? `## 训练目标（directive）
${directive}
`
    : '';
  const text = `# 训练任务书 #${task.taskSeq}

## 任务框架
- 任务 ID：${task.id}（manage-task 各 action 的 taskId 参数）
- 学生：${student.name}（教室 ${classroom.name}）
- 基线版本：${baseVersion.label}（${baseVersion.id}）
- 模式：${task.mode} / ${task.optimizeStyle}（轮次上限 ${task.maxTurns ?? 1}）

## 学生上下文（base ${baseVersion.label}）
- base version.json.model：${baseVersion.model.providerId ?? '(未配)'}/${baseVersion.model.modelId}
- base AGENTS.md 全文：
---
${baseVersion.agentsMd || '（base 为空，0.0 初始版本）'}
---

## candidate 工作区（你要改的目标）
- candidate version id：${candidateVersion.id}
- candidate workspace 绝对路径：${candidateVersion.workspaceDir}
- 请直接 edit 该目录下的 AGENTS.md（用 prompt 中的绝对路径定位，不靠相对 cwd）

${evalSection}${directiveSection}## 工作流指引（训练式）
1. 读 academy-train-skill（call \`skill\` tool）了解训练方法论
2. evaluate(taskId, versionId='${baseVersion.id}') 探查 base 表现，反思 weakness
3. edit candidate AGENTS.md（路径见上）
4. revise(taskId) 推进一轮（sample+grade candidate + acceptGate 决策）
5. improve 则继续 edit+revise 循环；改坏可 fork(taskId) 重来
6. 达到目标或 maxTurns → adopt(taskId, versionId) 把任意 process 版定稿为新 formal（旁路归档，不杀 task）

## manage-task action 说明
- evaluate(taskId, versionId?)：纯查询 sample+grade 指定版本，返 { versionId, samples, grades, avgScore }
- revise(taskId)：推进一轮（improve 时候选晋升 + fork 新 candidate workspace）
- fork(taskId, baseVersionId?)：废弃当前 candidate 重 fork（可切历史版作基线）
- adopt(taskId, versionId)：把任意 process 版定稿为新 formal（可多次；不结束 task）
- pause(taskId, reason?)：可逆暂停（maxturns 除外，到顶须 update_task 调大）
- resume(taskId)：从 paused 恢复续训（须 currentTurn < maxTurns）`;
  return makeAcademyMessage(coachSessionId, text);
}

/**
 * 构造 revise 结果消息（推进一轮后推给 coach — coach 反思 + 下一步决策依据）。
 * 含本轮 candidateVersionId + avgScore + decision + 新 candidate workspaceDir（improve 时）+
 * 各 case reasoning 摘要 + 下一步建议。
 *
 * @param newCandidateWorkspaceDir improve 时 fork 出的新 candidate workspace 路径（regress/equal 时 undefined）
 */
export function buildReviseResultMessage(
  task: TrainingTaskEntity,
  turn: TrainingTurnEntity,
  newCandidateWorkspaceDir: string | undefined,
  coachSessionId: string,
): Message {
  const decision = turn.decision ?? 'unknown';
  const improved = turn.decision === 'improve';
  const grades = (turn.gradeResults ?? []) as Array<{ caseId: string; score: number; reasoning: string }>;
  const reasoningSummary = grades.length > 0
    ? grades.map((g) => `- case ${g.caseId}: score=${g.score.toFixed(2)} — ${g.reasoning}`).join('\n')
    : '（无评估数据 — simple/learning 模式跳过 sample/grade，候选直接采纳）';
  const nextStep = improved
    ? `候选已晋升为新临时基线，新 candidate workspace：${newCandidateWorkspaceDir ?? '(未 fork)'}。请继续 edit 新 candidate → revise 循环，或调 adopt(taskId, versionId) 定稿任意 process 版。`
    : `候选未达提升（${decision}），保留当前候选。可继续 edit 当前 candidate 再 revise，或 fork 重来，或 adopt(taskId, versionId) 定稿。`;
  const text = `训练任务 ${task.id} 第 ${turn.round} 轮 revise 完成。
决策：${decision}${improved ? '（临时基线已替换为候选）' : '（保留原临时基线）'}
本轮 candidate version：${turn.candidateVersionId}
本轮平均分：${turn.avgScore?.toFixed(3) ?? 'N/A'}
任务进度：${task.currentTurn}/${task.maxTurns}

各 case 评分摘要：
${reasoningSummary}

下一步建议：${nextStep}`;
  return makeAcademyMessage(coachSessionId, text);
}

/** 构造 pause 完成消息（推给 coach；提示 resume 可续，maxturns 例外） */
export function buildPausedMessage(
  task: TrainingTaskEntity,
  coachSessionId: string,
): Message {
  const reason = task.pausedReason ?? 'stopped';
  const maxturnsHint = reason === 'maxturns'
    ? '\n注意：maxTurns 已到顶（硬上限）。要继续训练，请让 head_teacher 通过 manage-classroom.update_task 调大 maxTurns 后再 resume。'
    : '';
  return makeAcademyMessage(
    coachSessionId,
    `训练任务 ${task.id} 已暂停（pausedReason=${reason}）。${maxturnsHint}

当前 candidate 版本：${task.candidateVersionId ?? '(未设)'}
任务进度：${task.currentTurn}/${task.maxTurns}

你可以随时 manage-task resume 续训（maxturns 例外，需先 update_task 调大），或 manage-task adopt(versionId) 定稿归档。`,
  );
}

/** 构造 resume（从 paused）消息：coach 继续 edit+revise 推进训练（区分 running 断点续跑的 buildResumeMessage） */
export function buildResumeFromPausedMessage(
  task: TrainingTaskEntity,
  coachSessionId: string,
): Message {
  return makeAcademyMessage(
    coachSessionId,
    `训练任务 ${task.id} 已从 paused 恢复为 running。

当前 candidate 版本：${task.candidateVersionId ?? '(未设)'}
临时基线：${task.temporaryBaselineVersionId ?? '(未设)'}
任务进度：${task.currentTurn}/${task.maxTurns}

请继续推进训练：edit candidate（AGENTS.md/skill）→ manage-task revise 推进一轮。`,
  );
}

/** 构造 adopt 完成消息（旁路归档）：告知新 formal 已落，源 process 保留，task 仍在产可继续迭代 */
export function buildAdoptedMessage(
  task: TrainingTaskEntity,
  coachSessionId: string,
  result: { newFormalVersionId: string; newLabel: string; newWorkspaceDir: string },
  sourceProcessVersionId: string,
): Message {
  return makeAcademyMessage(
    coachSessionId,
    `训练任务 ${task.id} 已采纳一个过程版本为新正式版（旁路归档）。

新正式版本：${result.newLabel}（${result.newFormalVersionId}）
源过程版本：${sourceProcessVersionId}
task 状态：${task.status}（未变 — adopt 是旁路动作，不影响生产轴）

你可以继续推进训练（edit+revise 产出更多过程版，可多次 adopt 定稿）。`,
  );
}

/** 构造断点续跑提示消息（启动时找到 status=running 的 task） */
export function buildResumeMessage(
  task: TrainingTaskEntity,
  lastTurn: TrainingTurnEntity | undefined,
  coachSessionId: string,
): Message {
  const roundText = lastTurn ? `（上一轮已完成，第 ${lastTurn.round} 轮决策：${lastTurn.decision ?? 'unknown'}）` : '（尚无轮次记录）';
  return makeAcademyMessage(
    coachSessionId,
    `服务重启恢复：训练任务 ${task.id} 当前状态 running ${roundText}
临时基线版本：${task.temporaryBaselineVersionId}
candidate 版本：${task.candidateVersionId ?? '(未设)'}
任务进度：${task.currentTurn}/${task.maxTurns}

请决定：继续推进（edit candidate → manage-task revise），或 manage-task adopt(versionId) 定稿归档。`,
  );
}

/** 构造需人工恢复消息（中途断的 turn — 兜底降级为 graded） */
export function buildResumeNeedManualMessage(
  task: TrainingTaskEntity,
  brokenTurn: TrainingTurnEntity,
  coachSessionId: string,
): Message {
  return makeAcademyMessage(
    coachSessionId,
    `服务重启恢复：训练任务 ${task.id} 第 ${brokenTurn.round} 轮中断（status=${brokenTurn.status}）。
引擎已兜底降级为 graded 状态，但可能需要人工检查数据一致性。
- turn id: ${brokenTurn.id}
- candidate version: ${brokenTurn.candidateVersionId}
- avgScore: ${brokenTurn.avgScore ?? 'N/A'}

请检查后决定：继续 edit candidate → manage-task revise，或 manage-task adopt(versionId) 定稿，或 manage-task pause 暂停。`,
  );
}

/** 通用 academy 引擎消息信封（sender=system, kind=academy-training-engine, metadata.needReply=true） */
function makeAcademyMessage(sessionId: string, text: string): Message {
  return {
    id: ulid(),
    sessionId,
    role: 'user',
    content: [{ type: 'text', text }],
    sender: {
      source: 'system',
      system: { kind: 'academy-training-engine' },
    },
    metadata: { needReply: true },
  };
}
