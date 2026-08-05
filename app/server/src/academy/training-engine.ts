/**
 * training-engine — Academy TrainingEngine 主入口（原子 action 编排 + 委派生命周期）
 * 参考: specs/tech/academy/[P0]training_engine.md §2（接口）+ §3（revise 流程）+ §3.1/§3.2
 *
 * v0.0.221 模型重构（design.md §3 + §5）：
 *   - 删除 propose/accept/reject/stop 方法（propose→accept/reject 链解耦）
 *   - 新增 pauseTask/resumeTask/adoptVersion（生产轴 ↔ 归档轴两正交动作）
 *
 * 设计：
 *   - evaluate = 纯查询（sample+grade 指定 version，不改状态）
 *   - revise = 推进一轮（sample+grade candidate + acceptGate + improve 晋升+fork 新 candidate）
 *   - forkCandidate = 显式废弃重来（fork 新 candidate；切基线时同步 temporaryBaseline）
 *   - adoptVersion = 旁路归档（任意 process 版 → 新 formal；不改 task 状态，可重复）
 *   - per-task lock（SessionTaskLock type='training-turn'）防同 task 并发推进
 *   - sample/grade 直调 LlmPort（pLimit 5 并发）；纯函数 gate 决策（gate.ts）
 *   - 细节拆 training-engine/* 子模块（assess/evaluate/revise/fork/gate/sample/grade/messages/lifecycle/helpers/llm-port/p-limit）
 */
import type { AcademyStore, TrainingTaskEntity, TrainingTurnEntity } from './academy-store';
import type { SessionTaskLock } from '../agent/session-task-lock';
import type { AcademyLlmPort } from './training-engine/llm-port';
import { evaluateVersion, type EvaluateResult } from './training-engine/evaluate';
import { reviseCandidate } from './training-engine/revise';
import { forkCandidate, type ForkCandidateResult } from './training-engine/fork';
import {
  pauseTask,
  resumeTask,
  adoptVersion,
  resumeOnStartup,
} from './training-engine/lifecycle';
import type { Message } from '../message/types';

/** TrainingEngine 依赖（构造注入；bootstrap E 节装配） */
export interface TrainingEngineDeps {
  academyStore: AcademyStore;
  /** LLM 窄端口（生产实现由 bootstrap 把 LlmCaller.invoke 适配为本端口） */
  llmPort: AcademyLlmPort;
  /** per-task lock（防同 task 并发推进） */
  sessionTaskLock: SessionTaskLock;
  /** deliverTo 投递端口（推事件给 coach/head inbox） */
  deliverTo: (sessionId: string, message: Message) => Promise<unknown>;
  /** dataDir 绝对路径（resolveDataDir 展开后，packaged 护栏 BUG-004） */
  dataDir: string;
  /** fan-out 并发上限（默认 5） */
  pLimitConcurrency?: number;
}

/** reviseCandidate 出参 */
export interface TurnResult {
  task: TrainingTaskEntity;
  /** 本轮 turn record（已落盘，含信封） */
  turn: TrainingTurnEntity;
  /** 是否触发 paused（早停 / maxTurns 到顶）；v0.0.221 原 proposed 字段重命名 */
  paused: boolean;
}

/** 重导出原子 action 出参类型（manage-task 工具层消费） */
export type { EvaluateResult, ForkCandidateResult };

/**
 * TrainingEngine — academy 训练引擎主类（v0.0.221 两轴模型）。
 *
 * 单文件 ≤300 行：原子 action 编排委派 + 生命周期委派；细节在 training-engine/* 子文件。
 */
export class TrainingEngine {
  constructor(private readonly deps: TrainingEngineDeps) {}

  /**
   * evaluateVersion — 纯查询：sample+grade 指定 versionId（缺省 task.candidateVersionId）。
   * 不改 task/turn 状态、不落 turn record。coach/head 用它探查版本表现。
   */
  evaluateVersion(taskId: string, classroomId: string, versionId?: string): Promise<EvaluateResult> {
    return evaluateVersion(this.deps, taskId, classroomId, versionId);
  }

  /**
   * reviseCandidate — 推进一轮：sample+grade 当前 candidate → acceptGate 对比 baseline →
   * improve 晋升 temporaryBaseline + fork 下轮新 candidate；落 turn record。
   * 到顶/早停 → task 转 paused+pausedReason（design.md §5/§7.5）。
   */
  reviseCandidate(taskId: string, classroomId: string): Promise<TurnResult> {
    return reviseCandidate(this.deps, taskId, classroomId);
  }

  /**
   * forkCandidate — 显式 fork 新 candidate（废弃当前候选重来）；更新 task.candidateVersionId。
   * 显式传 baseVersionId ≠ temporaryBaseline 时同步切换基线（design.md §2.1b）。
   */
  forkCandidate(
    taskId: string,
    classroomId: string,
    baseVersionId?: string,
  ): Promise<ForkCandidateResult> {
    return forkCandidate(this.deps, taskId, classroomId, baseVersionId);
  }

  // ── 生命周期方法（委派 lifecycle.ts；v0.0.221 三态机 + adopt 旁路）──

  /** pause：running/pending → paused(+pausedReason)；可逆（maxturns 例外） */
  pauseTask(
    taskId: string,
    classroomId: string,
    reason?: 'stopped' | 'earlystop' | 'maxturns' | 'completed',
  ): Promise<TrainingTaskEntity> {
    return pauseTask(this.deps, taskId, classroomId, reason);
  }

  /** resume：paused → running；maxTurns 硬门（reason=maxturns 不可 resume） */
  resumeTask(taskId: string, classroomId: string): Promise<TrainingTaskEntity> {
    return resumeTask(this.deps, taskId, classroomId);
  }

  /** adoptVersion：旁路归档（任意 process 版 → 新 formal；不改 task 状态，可重复） */
  adoptVersion(
    taskId: string,
    classroomId: string,
    processVersionId: string,
  ): Promise<{ newFormalVersionId: string; newLabel: string; newWorkspaceDir: string }> {
    return adoptVersion(this.deps, taskId, classroomId, processVersionId);
  }

  resumeOnStartup(): Promise<void> {
    return resumeOnStartup(this.deps);
  }
}
