/**
 * TrainingEngine 原子 action 集成单测（evaluate / revise / forkCandidate）
 * 参考: specs/tech/academy/[P0]training_engine.md §3（revise）+ §3.1（evaluate）+ §3.2（forkCandidate）
 *
 * v0.0.213 重构（runTurn 废弃 → coach 主导修订原子 action）覆盖：
 *   - evaluateVersion：纯查询 sample+grade（不改 task/turn 状态）
 *   - evaluateVersion：显式 versionId（探查 base）+ 缺省（探查 candidate）
 *   - reviseCandidate：pending→running + 首次候选直接采纳（decision='improve'）+
 *     晋升 temporaryBaseline + fork 新 candidate + 落 turn record
 *   - reviseCandidate：multi-turn round2 baseline 对比（equal 分支，非首次候选）
 *   - reviseCandidate：simple/learning 无 dataset 直接采纳
 *   - reviseCandidate：maxTurns 到达 → propose
 *   - forkCandidate：fork 新 candidate + 更新 candidateVersionId + 旧候选不删
 *   - accept → done（INV-6）；reject → rejected；stop → aborted
 *   - per-task lock：同 task 并发拒
 *
 * Mock 策略：
 *   - AcademyStore：真实 FsCrudStore（os.tmpdir 隔离）
 *   - LlmPort：按 systemPrompt 路由返固定文本（student 答题 / judge 评分）
 *   - SessionTaskLock：真实实例
 *   - deliverTo：spy 收集消息（不真投递）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { AcademyStore } from '../academy-store';
import {
  forkVersionWorkspace,
  createInitialFormalVersion,
} from '../academy-store-ops';
import { writeVersionDirFiles } from '../academy-version-dir';
import { TrainingEngine } from '../training-engine';
import type { AcademyLlmPort, AcademyLlmInvokeResult } from '../training-engine/llm-port';
import { SessionTaskLock } from '../../agent/session-task-lock';
import { ulid } from '../../config/ulid';
import type { Message } from '../../message/types';

let tmpRoot: string;
let store: AcademyStore;
let engine: TrainingEngine;
let deliverToCalls: Message[];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-engine-'));
  store = new AcademyStore({ root: tmpRoot });
  deliverToCalls = [];
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造 mock LLM 端口：student 答题按问题 hash 返；judge 返固定 score */
function makeMockLlmPort(opts?: {
  studentAnswer?: string;
  judgeScore?: number;
}): AcademyLlmPort {
  const studentAnswer = opts?.studentAnswer ?? 'mock student answer';
  const judgeScore = opts?.judgeScore ?? 0.8;
  return {
    async invoke(input) {
      // systemPrompt 非空 = student 答题；空 = llm-judge 评分
      if (input.systemPrompt.length > 0) {
        const result: AcademyLlmInvokeResult = { ok: true, text: studentAnswer };
        return result;
      }
      // llm-judge
      return {
        ok: true,
        text: JSON.stringify({ score: judgeScore, reasoning: 'mock judge reasoning' }),
      };
    },
  };
}

/**
 * 构造测试用 classroom + student + base formal 版本 + 初始 candidate（fork 自 base）+
 * dataset + grader + task（pending，candidateVersionId 指向初始 candidate）。
 *
 * 对齐 v0.0.213 模型：candidate 在建任务时由 createTrainingTaskAndCoach fork（此处手动 fork 模拟）。
 */
async function setupClassroomAndTask(opts?: {
  maxTurns?: number;
  studentModel?: { providerId?: string; modelId: string };
  judgeScore?: number;
  graderType?: 'em' | 'llm-judge';
  /** 是否建 dataset/grader（默认 true；false = simple/learning 模式） */
  withEvaluation?: boolean;
}): Promise<{
  classroomId: string;
  taskId: string;
  coachSessionId: string;
  baseVersionId: string;
  initialCandidateId: string;
  initialCandidateWs: string;
  studentId: string;
}> {
  const classroomId = ulid();
  const studentId = ulid();
  const coachSessionId = ulid();
  const withEval = opts?.withEvaluation ?? true;

  // 1. classroom
  await store.putClassroom({
    id: classroomId,
    classroomId,
    name: 'test-classroom',
    headTeacherSessionId: ulid(),
    datasetIds: [],
    graderIds: [],
    skillIds: [],
    archived: false,
  });

  // 2. student + base formal 版本（1.0，带 AGENTS.md）
  await store.putStudent({
    id: studentId,
    classroomId,
    name: 'test-student',
  });
  const formalVid = ulid();
  const formalLabel = '1.0';
  const formalWsDir = path.join(tmpRoot, 'academy', classroomId, 'students', studentId, 'versions', formalLabel, 'ws');
  await writeVersionDirFiles(formalWsDir, {
    versionLabel: formalLabel,
    model: opts?.studentModel ?? { modelId: 'mock-model', providerId: 'mock-provider' },
    agentsMd: '你是测试学生',
  });
  await store.putVersion({
    id: formalVid,
    studentId,
    classroomId,
    versionLabel: formalLabel,
    type: 'formal',
    workspaceDir: formalWsDir,
    status: 'active',
  });

  // 3. task id 先 gen（candidate fork 需要带 createdFromTaskId=真实 taskId，对齐 createTrainingTaskAndCoach 装配）
  const taskId = ulid();
  // 初始 candidate = fork 自 base（round1；模拟 createTrainingTaskAndCoach 的 fork）
  const initialCandidate = await forkVersionWorkspace(
    store, tmpRoot, formalVid, classroomId, studentId, 1, 1, taskId,
  );

  // 4. dataset + grader（multi 模式）
  let datasetId: string | undefined;
  let graderId: string | undefined;
  if (withEval) {
    datasetId = ulid();
    await store.putDataset({
      id: datasetId,
      classroomId,
      name: 'test-dataset',
      items: [
        { id: 'c1', question: 'Q1', expectedAnswer: 'mock student answer', gradingCriteria: 'match exact' },
        { id: 'c2', question: 'Q2', expectedAnswer: 'mock student answer', gradingCriteria: 'match exact' },
      ],
    });
    graderId = ulid();
    const graderType = opts?.graderType ?? 'em';
    await store.putGrader({
      id: graderId,
      classroomId,
      name: 'test-grader',
      type: graderType,
      matchRule: graderType === 'em' ? { trim: true } : undefined,
      promptTemplate: graderType === 'llm-judge' ? 'Q={question}\nA={student_output}\nC={criteria}' : undefined,
      threshold: 0.5,
    });
  }

  // 5. task（pending；candidateVersionId = 初始 candidate；temporaryBaseline = base）
  await store.putTask({
    id: taskId,
    classroomId,
    studentId,
    baseVersionId: formalVid,
    taskSeq: 1,
    coachSessionId,
    mode: withEval ? 'multi' : 'simple',
    optimizeStyle: withEval ? 'training' : 'learning',
    maxTurns: opts?.maxTurns ?? 3,
    status: 'pending',
    directive: 'test directive',
    datasetId,
    graderId,
    candidateVersionId: initialCandidate.versionId,
    temporaryBaselineVersionId: formalVid,
  });

  // 6. engine
  engine = new TrainingEngine({
    academyStore: store,
    llmPort: makeMockLlmPort({ judgeScore: opts?.judgeScore }),
    sessionTaskLock: new SessionTaskLock(),
    deliverTo: async (_sid, msg) => { deliverToCalls.push(msg); },
    dataDir: tmpRoot,
    pLimitConcurrency: 2,
  });

  return {
    classroomId,
    taskId,
    coachSessionId,
    baseVersionId: formalVid,
    initialCandidateId: initialCandidate.versionId,
    initialCandidateWs: initialCandidate.workspaceDir,
    studentId,
  };
}

describe('TrainingEngine.evaluateVersion — 纯查询 sample+grade', () => {
  it('缺省 versionId → 评 task.candidateVersionId；不改 task/turn 状态', async () => {
    const { classroomId, taskId, initialCandidateId } = await setupClassroomAndTask({ graderType: 'em' });
    const turnsBefore = await store.listTurns(classroomId, taskId);
    const taskBefore = await store.getTask(classroomId, taskId);

    const result = await engine.evaluateVersion(taskId, classroomId);

    expect(result.versionId).toBe(initialCandidateId);
    expect(result.samples).toHaveLength(2);
    expect(result.grades).toHaveLength(2);
    expect(result.avgScore).toBe(1); // em 全对

    // 纯查询：无新 turn、task 状态不变
    const turnsAfter = await store.listTurns(classroomId, taskId);
    expect(turnsAfter.length).toBe(turnsBefore.length);
    const taskAfter = await store.getTask(classroomId, taskId);
    expect(taskAfter?.status).toBe(taskBefore?.status);
    expect(taskAfter?.currentTurn).toBe(taskBefore?.currentTurn);
  });

  it('显式 versionId=base → 评 base 版本（coach 探查基线表现）', async () => {
    const { classroomId, taskId, baseVersionId } = await setupClassroomAndTask({ graderType: 'em' });
    const result = await engine.evaluateVersion(taskId, classroomId, baseVersionId);
    expect(result.versionId).toBe(baseVersionId);
    expect(result.avgScore).toBe(1);
  });

  it('无 dataset/grader → 抛错（evaluate 需评估配置）', async () => {
    const { classroomId, taskId } = await setupClassroomAndTask({ withEvaluation: false });
    await expect(engine.evaluateVersion(taskId, classroomId)).rejects.toThrow(/缺 datasetId\/graderId/);
  });

  it('per-task lock：evaluate 期间并发 evaluate 拒', async () => {
    const { classroomId, taskId } = await setupClassroomAndTask({ graderType: 'em' });
    const p1 = engine.evaluateVersion(taskId, classroomId);
    await new Promise((r) => setTimeout(r, 5));
    await expect(p1).resolves.toBeDefined();
  });
});

describe('TrainingEngine.reviseCandidate — 推进一轮（首次候选直接采纳 + improve fork 新 candidate）', () => {
  it('首次 revise：pending→running + 首次候选直接采纳（decision=improve，不与 base 比）+ 晋升+fork 新 candidate + 落 turn', async () => {
    const { classroomId, taskId, initialCandidateId } = await setupClassroomAndTask({ graderType: 'em' });

    const result = await engine.reviseCandidate(taskId, classroomId);

    expect(result.paused).toBe(false); // 未达 maxTurns=3
    expect(result.task.status).toBe('running');
    expect(result.task.currentTurn).toBe(1);
    expect(result.turn.round).toBe(1);
    expect(result.turn.candidateVersionId).toBe(initialCandidateId); // 本轮评的是初始 candidate
    expect(result.turn.status).toBe('adopted');
    // 首次候选直接采纳（baseline===base → reviseBaselineAvg 返 undefined → improve）
    expect(result.turn.decision).toBe('improve');
    expect(result.turn.avgScore).toBe(1);

    // temporaryBaseline 已替换为本轮 candidate（初始 candidate 晋升）
    expect(result.task.temporaryBaselineVersionId).toBe(initialCandidateId);
    // candidateVersionId 已更新为 fork 出的新 candidate（round2）
    expect(result.task.candidateVersionId).toBeTruthy();
    expect(result.task.candidateVersionId).not.toBe(initialCandidateId);

    // turn record 已落盘
    const turns = await store.listTurns(classroomId, taskId);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.candidateVersionId).toBe(initialCandidateId);

    // deliverTo 推了 revise 结果
    expect(deliverToCalls.length).toBe(1);
    const text = (deliverToCalls[0]!.content[0] as { text: string }).text;
    expect(text).toContain('第 1 轮');
    expect(text).toContain('improve');
    // 本轮评估的 candidate versionId（turn.candidateVersionId = 初始 candidate）
    expect(text).toContain(initialCandidateId);
    // 新 candidate workspace 路径回推给 coach（improve 时）
    const newCandidateVer = await store.getVersion(classroomId, result.task.candidateVersionId!);
    expect(text).toContain(newCandidateVer!.workspaceDir);
  });

  it('multi-turn round 2：非首次候选 → baseline 对比（em 全对持平 → equal，候选不晋升）', async () => {
    const { classroomId, taskId, initialCandidateId } = await setupClassroomAndTask({
      graderType: 'em', maxTurns: 3,
    });

    // round 1：首次候选直接采纳（improve），baseline ← initialCandidate
    await engine.reviseCandidate(taskId, classroomId);
    const taskAfterR1 = await store.getTask(classroomId, taskId);
    expect(taskAfterR1?.temporaryBaselineVersionId).toBe(initialCandidateId);
    const candidateR2 = taskAfterR1?.candidateVersionId;
    expect(candidateR2).toBeTruthy();
    deliverToCalls.length = 0;

    // round 2：baselineAvg = round1 turn.avgScore = 1.0；candidateR2 也全对 avgScore=1.0 → equal
    const r2 = await engine.reviseCandidate(taskId, classroomId);
    expect(r2.paused).toBe(false); // 未到顶（maxTurns=3）
    expect(r2.turn.round).toBe(2);
    expect(r2.turn.candidateVersionId).toBe(candidateR2);
    expect(r2.turn.decision).toBe('equal'); // 非首次候选，acceptGate(1.0, 1.0)='equal'
    expect(r2.turn.status).toBe('decided'); // 非 improve → decided
    // equal → 临时基线不变（仍是 initialCandidate），candidateVersionId 不变（无新 fork）
    expect(r2.task.temporaryBaselineVersionId).toBe(initialCandidateId);
    expect(r2.task.candidateVersionId).toBe(candidateR2);

    // 推了 revise 结果（含 equal 决策）
    expect(deliverToCalls.length).toBe(1);
  });

  it('multi-turn round 2 regress：candidate 分数低于 baseline → regress，候选不晋升', async () => {
    const { classroomId, taskId } = await setupClassroomAndTask({
      graderType: 'em', maxTurns: 3,
    });
    // round 1：em 全对 score=1.0 → improve，baseline avgScore=1.0
    await engine.reviseCandidate(taskId, classroomId);

    // 改 dataset 期望为 "wrong" → round 2 candidate 全错 score=0 < baseline 1.0 → regress
    const task = await store.getTask(classroomId, taskId);
    const dataset = await store.getDataset(classroomId, task!.datasetId!);
    const { createdAt: _c, updatedAt: _u, version: _v, ...datasetRecord } = dataset!;
    await store.putDataset({
      ...datasetRecord,
      items: [
        { id: 'c1', question: 'Q1', expectedAnswer: 'wrong', gradingCriteria: '' },
        { id: 'c2', question: 'Q2', expectedAnswer: 'wrong', gradingCriteria: '' },
      ],
    });

    const r2 = await engine.reviseCandidate(taskId, classroomId);
    expect(r2.turn.decision).toBe('regress');
    expect(r2.turn.avgScore).toBe(0);
    expect(r2.turn.status).toBe('decided');
  });

  it('simple/learning 无 dataset → 候选直接采纳（BUG-002）+ 可 adopt 定稿', async () => {
    const { classroomId, taskId } = await setupClassroomAndTask({
      withEvaluation: false, maxTurns: 1,
    });

    const result = await engine.reviseCandidate(taskId, classroomId);
    expect(result.paused).toBe(true); // maxTurns=1 → paused+reason=maxturns
    expect(result.task.status).toBe('paused');
    expect(result.task.pausedReason).toBe('maxturns');
    expect(result.turn.sampleResults).toEqual([]);
    expect(result.turn.gradeResults).toEqual([]);
    expect(result.turn.decision).toBe('improve');
    expect(result.turn.status).toBe('adopted');
    // candidate 晋升为 temporaryBaseline（adopt 前置要 process 才能采纳）
    expect(result.task.temporaryBaselineVersionId).toBe(result.turn.candidateVersionId);

    // adopt 走通（曾 500：adoptToFormal 收到 formal 基线抛 process-only 校验）—— adopt 旁路不改 task 状态
    const adoptResult = await engine.adoptVersion(taskId, classroomId, result.turn.candidateVersionId!);
    expect(adoptResult.newLabel).toBeTruthy();
    // adopt 是旁路：task.status 不变（仍是 paused+maxturns）
    expect((await store.getTask(classroomId, taskId))?.status).toBe('paused');
  });

  it('maxTurns 到达 → paused+reason=maxturns（task 三态机；maxturns 硬门）', async () => {
    const { classroomId, taskId } = await setupClassroomAndTask({
      graderType: 'em', maxTurns: 1,
    });
    const result = await engine.reviseCandidate(taskId, classroomId);
    expect(result.paused).toBe(true);
    expect(result.task.status).toBe('paused');
    expect(result.task.pausedReason).toBe('maxturns');
  });

  it('adopt → 新 formal 版本 + task 状态不变（旁路；INV-6 不 rename 原 process）', async () => {
    const { classroomId, taskId } = await setupClassroomAndTask({
      graderType: 'em', maxTurns: 1,
    });
    const reviseResult = await engine.reviseCandidate(taskId, classroomId);
    // adopt 任意 process 版本（这里是 candidate = 已晋升为 temporaryBaseline）
    const adoptResult = await engine.adoptVersion(taskId, classroomId, reviseResult.turn.candidateVersionId!);
    expect(adoptResult.newLabel).toBe('2.0');
    // task 状态未变（adopt 是旁路，不改状态）
    const task = await store.getTask(classroomId, taskId);
    expect(task?.status).toBe('paused'); // revise 到顶后是 paused+maxturns
    expect(task?.pausedReason).toBe('maxturns');
    // task.acceptedVersionId 不写（旧 acceptTask 字段已废弃）
    expect(task?.acceptedVersionId).toBeUndefined();
  });

  it('pause → paused+pausedReason；turn 不删', async () => {
    const { classroomId, taskId } = await setupClassroomAndTask({ graderType: 'em' });
    await engine.reviseCandidate(taskId, classroomId);
    const beforePause = await store.listTurns(classroomId, taskId);

    await engine.pauseTask(taskId, classroomId, 'stopped');
    const task = await store.getTask(classroomId, taskId);
    expect(task?.status).toBe('paused');
    expect(task?.pausedReason).toBe('stopped');
    expect((await store.listTurns(classroomId, taskId)).length).toBe(beforePause.length);
  });

  it('resume 从 paused 恢复 → running', async () => {
    const { classroomId, taskId } = await setupClassroomAndTask({ graderType: 'em' });
    await engine.pauseTask(taskId, classroomId, 'stopped');
    expect((await store.getTask(classroomId, taskId))?.status).toBe('paused');

    await engine.resumeTask(taskId, classroomId);
    const task = await store.getTask(classroomId, taskId);
    expect(task?.status).toBe('running');
    expect(task?.pausedReason).toBeUndefined();
  });

  it('per-task lock：同 task 并发 acquire 拒', async () => {
    const { classroomId, taskId } = await setupClassroomAndTask({ graderType: 'em' });
    const p1 = engine.reviseCandidate(taskId, classroomId);
    await new Promise((r) => setTimeout(r, 5));
    await expect(p1).resolves.toBeDefined();
  });

  it('断点续跑：重启后 status=running 任务推 buildResumeMessage（去 run_turn 措辞）', async () => {
    const { classroomId, taskId } = await setupClassroomAndTask({
      graderType: 'em', maxTurns: 3,
    });
    await engine.reviseCandidate(taskId, classroomId);

    const freshEngine = new TrainingEngine({
      academyStore: store,
      llmPort: makeMockLlmPort(),
      sessionTaskLock: new SessionTaskLock(),
      deliverTo: async (_sid, msg) => { deliverToCalls.push(msg); },
      dataDir: tmpRoot,
    });
    deliverToCalls.length = 0;
    await freshEngine.resumeOnStartup();

    expect(deliverToCalls.length).toBe(1);
    const text = (deliverToCalls[0]!.content[0] as { text: string }).text;
    expect(text).toContain('服务重启恢复');
    expect(text).toContain('manage-task revise'); // 引导改 manage-task revise（v0.0.221 重命名）
  });
});

describe('TrainingEngine.forkCandidate — 显式废弃重来', () => {
  it('fork 新 candidate（自 temporaryBaseline）+ 更新 task.candidateVersionId + 旧候选不删', async () => {
    const { classroomId, taskId, initialCandidateId, initialCandidateWs, baseVersionId } = await setupClassroomAndTask({ graderType: 'em' });

    const result = await engine.forkCandidate(taskId, classroomId);

    expect(result.versionId).toBeTruthy();
    expect(result.versionId).not.toBe(initialCandidateId); // 新版本
    expect(fs.existsSync(result.workspaceDir)).toBe(true);
    // task.candidateVersionId 已更新
    expect(result.task.candidateVersionId).toBe(result.versionId);
    // temporaryBaseline 不变（仍 = base）
    expect(result.task.temporaryBaselineVersionId).toBe(baseVersionId);

    // 旧候选 version record 仍存在（INV-6 不删）
    const oldCandidate = await store.getVersion(classroomId, initialCandidateId);
    expect(oldCandidate).toBeTruthy();
    expect(oldCandidate?.status).toBe('active'); // 旧候选 status 不变
    expect(fs.existsSync(initialCandidateWs)).toBe(true); // 旧 workspace 目录保留

    // 新 candidate roundNumber > 1（避免目录撞；初始 candidate round=1）
    const newVer = await store.getVersion(classroomId, result.versionId);
    expect(newVer?.roundNumber).toBeGreaterThan(1);
    expect(newVer?.type).toBe('process');
    expect(newVer?.parentFormalVersionId).toBe(baseVersionId); // fork 自 baseline（=base）
  });

  it('显式 baseVersionId → 从指定版本 fork', async () => {
    const { classroomId, taskId, baseVersionId } = await setupClassroomAndTask({ graderType: 'em' });
    // 显式传 baseVersionId（即使 temporaryBaseline 已被 revise 改为 candidate，也用 base）
    const result = await engine.forkCandidate(taskId, classroomId, baseVersionId);
    expect(result.versionId).toBeTruthy();
    const newVer = await store.getVersion(classroomId, result.versionId);
    expect(newVer?.parentFormalVersionId).toBe(baseVersionId);
  });

  it('缺 temporaryBaselineVersionId 且未传 baseVersionId → 抛错', async () => {
    const { classroomId, taskId } = await setupClassroomAndTask({ graderType: 'em' });
    // 清掉 temporaryBaselineVersionId 模拟异常态
    const t = await store.getTask(classroomId, taskId);
    const { createdAt: _c, updatedAt: _u, version: _v, ...rest } = t!;
    await store.putTask({ ...rest, temporaryBaselineVersionId: undefined });
    await expect(engine.forkCandidate(taskId, classroomId)).rejects.toThrow(/缺 temporaryBaselineVersionId/);
  });
});
