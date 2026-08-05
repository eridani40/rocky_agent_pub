/**
 * v0.0.221 关键不变量 UT — 5 个 acceptance 标准 + migration 幂等 + fork 切基线
 * 参考: states/v0.0.221/verify/test-plan.md §3（14 项 UT 清单）
 *       specs/tech/version_logs/v0.0.221/change_plan.md A/B 节
 *
 * 覆盖 test-plan §3 五个关键不变量（T1 acceptance）：
 *   ① fork/adopt 后 versionLabel 一致（BUG#1 修复）
 *   ② adopt 后 currentFormalVersionId 同步（BUG-001 修复）
 *   ③ resume maxturns 抛 task_at_maxturns（硬门）
 *   ④ adopt 不改 task.status（旁路）+ 可多次产 formal（2.0/3.0/4.0）
 *   ⑤ migration 幂等（旧 status → paused+reason；二次扫无变化）
 *
 * 另含：
 *   ⑥ fork(baseVersionId) 切基线：temporaryBaseline 同步替换；不带 baseVersionId 时不动
 *   ⑦ pause/resume 状态转移 + deliverTo 消息
 *
 * Mock 策略：真实 AcademyStore（FsCrudStore + os.tmpdir 隔离）+ 真 SessionTaskLock + spy deliverTo。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { AcademyStore } from '../academy-store';
import {
  forkVersionWorkspace,
  adoptToFormal,
  createInitialFormalVersion,
} from '../academy-store-ops';
import { resolveVersionContent } from '../academy-version-dir';
import { TrainingEngine } from '../training-engine';
import type { AcademyLlmPort } from '../training-engine/llm-port';
import { SessionTaskLock } from '../../agent/session-task-lock';
import { ulid } from '../../config/ulid';
import type { Message } from '../../message/types';
import { resumeOnStartup } from '../training-engine/lifecycle';

let tmpRoot: string;
let store: AcademyStore;
let engine: TrainingEngine;
let deliverToCalls: Message[];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-v221-'));
  store = new AcademyStore({ root: tmpRoot });
  deliverToCalls = [];
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造 mock LLM 端口：judge 返固定 score（用于 multi 模式 revise） */
function makeMockLlmPort(score = 0.8): AcademyLlmPort {
  return {
    async invoke(input) {
      if (input.systemPrompt.length > 0) {
        return { ok: true, text: 'mock answer' };
      }
      return { ok: true, text: JSON.stringify({ score, reasoning: 'mock' }) };
    },
  };
}

/**
 * 构造完整测试场景：classroom + student + base formal 1.0 + 初始 candidate（fork 自 base）+
 * dataset + grader + task（pending，candidateVersionId = 初始 candidate）。
 */
async function setupTaskAndEngine(opts?: {
  maxTurns?: number;
  withEvaluation?: boolean;
}): Promise<{
  classroomId: string;
  studentId: string;
  taskId: string;
  coachSessionId: string;
  baseVersionId: string;
  initialCandidateId: string;
}> {
  const classroomId = ulid();
  const studentId = ulid();
  const coachSessionId = ulid();
  const taskId = ulid();
  const withEval = opts?.withEvaluation ?? true;

  await store.putClassroom({
    id: classroomId, classroomId, name: 'cls',
    headTeacherSessionId: ulid(), datasetIds: [], graderIds: [], skillIds: [], archived: false,
  });
  await store.putStudent({ id: studentId, classroomId, name: 'stu' });

  // 建 base formal 1.0（带 AGENTS.md）
  const formalVid = ulid();
  const formalWs = path.join(tmpRoot, 'academy', classroomId, 'students', studentId, 'versions', '1.0', 'ws');
  fs.mkdirSync(formalWs, { recursive: true });
  // 直接写 version.json + AGENTS.md（避免 writeVersionDirFiles 重复 mkdir）
  const { writeVersionDirFiles } = await import('../academy-version-dir');
  await writeVersionDirFiles(formalWs, {
    versionLabel: '1.0',
    model: { modelId: 'mock', providerId: 'mock' },
    agentsMd: 'test agents',
  });
  await store.putVersion({
    id: formalVid, studentId, classroomId,
    versionLabel: '1.0', type: 'formal', workspaceDir: formalWs, status: 'active',
  });
  // 回写 currentFormalVersionId（模拟 createStudentWithInitialVersion 的副作用）
  await store.putStudent({ id: studentId, classroomId, name: 'stu', currentFormalVersionId: formalVid });

  // fork 初始 candidate（round=1，模拟 createTrainingTaskAndCoach）
  const initialCandidate = await forkVersionWorkspace(
    store, tmpRoot, formalVid, classroomId, studentId, 1, 1, taskId,
  );

  // dataset + grader（multi）
  let datasetId: string | undefined;
  let graderId: string | undefined;
  if (withEval) {
    datasetId = ulid();
    await store.putDataset({
      id: datasetId, classroomId, name: 'ds',
      items: [{ id: 'c1', question: 'Q1', expectedAnswer: 'mock answer', gradingCriteria: 'match' }],
    });
    graderId = ulid();
    await store.putGrader({
      id: graderId, classroomId, name: 'gr', type: 'em',
      matchRule: { trim: true }, threshold: 0.5,
    });
  }

  await store.putTask({
    id: taskId, classroomId, studentId, baseVersionId: formalVid, taskSeq: 1,
    coachSessionId, mode: withEval ? 'multi' : 'simple',
    optimizeStyle: withEval ? 'training' : 'learning',
    maxTurns: opts?.maxTurns ?? 3, status: 'pending',
    datasetId, graderId,
    candidateVersionId: initialCandidate.versionId,
    temporaryBaselineVersionId: formalVid,
  });

  engine = new TrainingEngine({
    academyStore: store,
    llmPort: makeMockLlmPort(),
    sessionTaskLock: new SessionTaskLock(),
    deliverTo: async (_sid, msg) => { deliverToCalls.push(msg); },
    dataDir: tmpRoot,
  });

  return {
    classroomId, studentId, taskId, coachSessionId,
    baseVersionId: formalVid, initialCandidateId: initialCandidate.versionId,
  };
}

/** 读 ws/version.json 的 versionLabel 字段 */
async function readWsVersionLabel(wsDir: string): Promise<string | undefined> {
  const content = await resolveVersionContent(wsDir);
  return content.versionJson?.versionLabel;
}

// ── ① fork/adopt 后 versionLabel 一致（BUG#1 修复）──────────────────────

describe('不变量 ①：fork/adopt 后 workspace version.json.versionLabel == record.versionLabel', () => {
  it('fork 后 candidate ws versionLabel == record.versionLabel（修 BUG#1：原恒 "0.0"）', async () => {
    const { classroomId, studentId, taskId } = await setupTaskAndEngine();
    // 初始 candidate = round1 fork 自 base 1.0 → label 应是 "1.1.1"（baseMajor=1, taskSeq=1, round=1）
    const versions = await store.listVersions(classroomId, studentId);
    const candidate = versions.find((v) => v.type === 'process' && v.createdFromTaskId === taskId);
    expect(candidate).toBeTruthy();
    expect(candidate!.versionLabel).toBe('1.1.1');
    // 关键断言：workspace version.json 的 versionLabel 与 record 一致（BUG#1 修复前 ws 是 "0.0"）
    expect(await readWsVersionLabel(candidate!.workspaceDir)).toBe('1.1.1');
  });

  it('adopt 后 formal ws versionLabel == record.versionLabel（修 BUG#1）', async () => {
    const { classroomId, taskId, initialCandidateId } = await setupTaskAndEngine({ maxTurns: 1 });
    // revise 到 maxTurns=1 → candidate 晋升 temporaryBaseline；adopt 它为新 formal
    await engine.reviseCandidate(taskId, classroomId);
    const adoptResult = await engine.adoptVersion(taskId, classroomId, initialCandidateId);
    expect(adoptResult.newLabel).toBe('2.0');
    // 关键断言：formal ws 的 versionLabel 是 "2.0"（BUG#1 修复前是 process 旧 label "1.1.1"）
    const formalVer = await store.getVersion(classroomId, adoptResult.newFormalVersionId);
    expect(await readWsVersionLabel(formalVer!.workspaceDir)).toBe('2.0');
  });
});

// ── ② adopt 后 currentFormalVersionId 同步（BUG-001 修复）───────────────

describe('不变量 ②：adopt 后 student.currentFormalVersionId 同步', () => {
  it('adopt 后 student.currentFormalVersionId 指向新 formal（修 BUG-001）', async () => {
    const { classroomId, studentId, taskId, baseVersionId, initialCandidateId } = await setupTaskAndEngine({ maxTurns: 1 });
    // adopt 前 currentFormalVersionId = base 1.0
    expect((await store.getStudent(classroomId, studentId))?.currentFormalVersionId).toBe(baseVersionId);
    await engine.reviseCandidate(taskId, classroomId);
    const adoptResult = await engine.adoptVersion(taskId, classroomId, initialCandidateId);
    // adopt 后 currentFormalVersionId 同步为新 formal 2.0（BUG-001 修复前不变）
    expect((await store.getStudent(classroomId, studentId))?.currentFormalVersionId).toBe(adoptResult.newFormalVersionId);
  });
});

// ── ③ resume maxturns 抛 task_at_maxturns（硬门）────────────────────────

describe('不变量 ③：resume maxturns 硬门 → 抛 task_at_maxturns', () => {
  it('pausedReason=maxturns 时 resume 抛 task_at_maxturns', async () => {
    const { taskId, classroomId } = await setupTaskAndEngine({ maxTurns: 1 });
    // revise 到顶 → paused+reason=maxturns
    await engine.reviseCandidate(taskId, classroomId);
    const task = await store.getTask(classroomId, taskId);
    expect(task?.status).toBe('paused');
    expect(task?.pausedReason).toBe('maxturns');
    // resume 应抛 task_at_maxturns（硬门不可越过）
    await expect(engine.resumeTask(taskId, classroomId)).rejects.toThrow(/task_at_maxturns/);
  });

  it('pausedReason=stopped 时 resume 正常（非硬门）', async () => {
    const { taskId, classroomId } = await setupTaskAndEngine();
    await engine.pauseTask(taskId, classroomId, 'stopped');
    await engine.resumeTask(taskId, classroomId);
    expect((await store.getTask(classroomId, taskId))?.status).toBe('running');
  });
});

// ── ④ adopt 不改 task.status（旁路）+ 可多次产 formal ────────────────────

describe('不变量 ④：adopt 旁路不改 task.status + 可多次产 formal', () => {
  it('adopt 不改 task.status（不论 task 是什么状态）', async () => {
    const { taskId, classroomId, initialCandidateId } = await setupTaskAndEngine({ maxTurns: 1 });
    await engine.reviseCandidate(taskId, classroomId);
    const beforeAdopt = await store.getTask(classroomId, taskId);
    expect(beforeAdopt?.status).toBe('paused'); // revise 到顶后是 paused+maxturns
    await engine.adoptVersion(taskId, classroomId, initialCandidateId);
    // adopt 后状态不变（旁路）
    const afterAdopt = await store.getTask(classroomId, taskId);
    expect(afterAdopt?.status).toBe(beforeAdopt?.status);
    expect(afterAdopt?.pausedReason).toBe(beforeAdopt?.pausedReason);
  });

  it('同 task 多次 adopt 产 major 递增 formal（2.0 / 3.0）', async () => {
    const { classroomId, taskId } = await setupTaskAndEngine({ maxTurns: 3 });
    // 第一次 revise → 产 candidate round1（晋升为 temporaryBaseline）
    const r1 = await engine.reviseCandidate(taskId, classroomId);
    // adopt round1 candidate 为 formal 2.0
    const adopt1 = await engine.adoptVersion(taskId, classroomId, r1.turn.candidateVersionId!);
    expect(adopt1.newLabel).toBe('2.0');
    // 第二次 revise → 产 candidate round2（improve → 晋升）
    const r2 = await engine.reviseCandidate(taskId, classroomId);
    // adopt round2 candidate 为 formal 3.0
    const adopt2 = await engine.adoptVersion(taskId, classroomId, r2.turn.candidateVersionId!);
    expect(adopt2.newLabel).toBe('3.0');
    // 两次 adopt 后 task 状态不变（仍是 running — maxTurns=3 未到顶）
    expect((await store.getTask(classroomId, taskId))?.status).toBe('running');
  });
});

// ── ⑤ migration 幂等 ───────────────────────────────────────────────────

/**
 * 直接写 legacy status 到 disk（绕过 schema 校验，模拟 pre-existing 数据：
 * schema 收窄前写入的记录在 disk 上是旧 status，读侧不校验所以能拿到旧值）。
 * 路径 = {root}/academy/{cid}/training_tasks/{taskId}.json。
 */
async function writeLegacyStatusToDisk(
  cid: string, taskId: string, legacyStatus: string,
): Promise<void> {
  const taskPath = path.join(tmpRoot, 'academy', cid, 'training_tasks', `${taskId}.json`);
  const raw = JSON.parse(await fs.promises.readFile(taskPath, 'utf8')) as Record<string, unknown>;
  raw.status = legacyStatus;
  await fs.promises.writeFile(taskPath, JSON.stringify(raw, null, 2), 'utf8');
}

describe('不变量 ⑤：resumeOnStartup migration 幂等（旧 status → paused+reason）', () => {
  it('旧 status（done）→ paused+pausedReason=completed；幂等（二次扫无变化）', async () => {
    const { classroomId, taskId } = await setupTaskAndEngine();
    deliverToCalls.length = 0;

    // 模拟 pre-existing 数据：直接写 disk 为旧 status='done'（绕 schema 校验）
    await writeLegacyStatusToDisk(classroomId, taskId, 'done');

    // 第一次 migration：done → paused+reason='completed'
    await resumeOnStartup({
      academyStore: store,
      llmPort: makeMockLlmPort(),
      sessionTaskLock: new SessionTaskLock(),
      deliverTo: async (_sid, msg) => { deliverToCalls.push(msg); },
      dataDir: tmpRoot,
    });
    const after1 = await store.getTask(classroomId, taskId);
    expect(after1?.status).toBe('paused');
    expect(after1?.pausedReason).toBe('completed');
    // record 未删（INV：migration 不删 record）
    expect(after1?.id).toBe(taskId);
    // 推送了消息（resumeFromPaused）
    expect(deliverToCalls.length).toBe(1);

    // 第二次 migration：status='paused' 跳过（幂等：不重复处理，无新 deliverTo）
    deliverToCalls.length = 0;
    await resumeOnStartup({
      academyStore: store,
      llmPort: makeMockLlmPort(),
      sessionTaskLock: new SessionTaskLock(),
      deliverTo: async (_sid, msg) => { deliverToCalls.push(msg); },
      dataDir: tmpRoot,
    });
    const after2 = await store.getTask(classroomId, taskId);
    expect(after2?.status).toBe('paused'); // 仍 paused（幂等）
    expect(after2?.pausedReason).toBe('completed');
    expect(deliverToCalls.length).toBe(0); // 无新推送
  });

  it('旧 status aborted → paused+stopped', async () => {
    const { classroomId, taskId } = await setupTaskAndEngine();
    await writeLegacyStatusToDisk(classroomId, taskId, 'aborted');

    await resumeOnStartup({
      academyStore: store,
      llmPort: makeMockLlmPort(),
      sessionTaskLock: new SessionTaskLock(),
      deliverTo: async () => { /* noop */ },
      dataDir: tmpRoot,
    });
    const after = await store.getTask(classroomId, taskId);
    expect(after?.status).toBe('paused');
    expect(after?.pausedReason).toBe('stopped');
  });

  it('旧 status awaiting_confirm/rejected → paused+stopped', async () => {
    const { classroomId, taskId } = await setupTaskAndEngine();
    await writeLegacyStatusToDisk(classroomId, taskId, 'awaiting_confirm');

    await resumeOnStartup({
      academyStore: store,
      llmPort: makeMockLlmPort(),
      sessionTaskLock: new SessionTaskLock(),
      deliverTo: async () => { /* noop */ },
      dataDir: tmpRoot,
    });
    const after = await store.getTask(classroomId, taskId);
    expect(after?.status).toBe('paused');
    expect(after?.pausedReason).toBe('stopped');
  });
});

// ── ⑥ fork(baseVersionId) 切基线 ──────────────────────────────────────

describe('不变量 ⑥：fork(baseVersionId) 切基线 → temporaryBaseline 同步替换', () => {
  it('不带 baseVersionId 时不动 temporaryBaseline（废弃重来语义）', async () => {
    const { taskId, classroomId, baseVersionId } = await setupTaskAndEngine();
    const before = await store.getTask(classroomId, taskId);
    const beforeBaseline = before!.temporaryBaselineVersionId;
    // fork() 不带 baseVersionId → 用当前 temporaryBaseline 重 fork；baseline 不变
    await engine.forkCandidate(taskId, classroomId);
    const after = await store.getTask(classroomId, taskId);
    expect(after?.temporaryBaselineVersionId).toBe(beforeBaseline); // 不变
    expect(after?.candidateVersionId).not.toBe(before?.candidateVersionId); // 新 candidate
  });

  it('显式 baseVersionId ≠ temporaryBaseline → 同步替换（切基线）', async () => {
    const { taskId, classroomId, baseVersionId, initialCandidateId } = await setupTaskAndEngine();
    // 先 revise 把 temporaryBaseline 从 base 切到 candidate（round1 improve）
    await engine.reviseCandidate(taskId, classroomId);
    const afterRevise = await store.getTask(classroomId, taskId);
    expect(afterRevise?.temporaryBaselineVersionId).toBe(initialCandidateId); // 已晋升
    // 显式 fork(baseVersionId=base) → temporaryBaseline 同步切回 base
    await engine.forkCandidate(taskId, classroomId, baseVersionId);
    const after = await store.getTask(classroomId, taskId);
    expect(after?.temporaryBaselineVersionId).toBe(baseVersionId); // 同步切回 base
  });
});
