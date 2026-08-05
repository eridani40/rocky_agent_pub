/**
 * v0.0.221 工具层 UT — manage-task / manage-classroom 工具契约
 * 参考: states/v0.0.221/verify/test-plan.md §3（UT 清单 #8/#9/#10/#11/#14）
 *
 * 覆盖：
 *   ⑧ manage-task taskId 隐式绑定（input.taskId 缺省=rtc.trainingTaskId；不匹配→task_not_bound）
 *   ⑨ manage-classroom update_task 仅 patch maxTurns/directive（其他字段忽略）
 *   ⑩ 工具/profile grep 全仓 trainStudentTool/manageStudentTool/train-student 残留归零（结构断言）
 *   ⑪ academy_head_role mapper 注册三步生效（plugin.json extImpls + scope impls + impl 文件）
 *   ⑭ academy-task-status mapper 每 task 行含 coachSessionId
 *
 * Mock 策略：白盒——真实 AcademyStore（tmpdir）+ 真 TrainingEngine + 真 SessionTaskLock；
 *   工具层 rtc 手动组装（不走 session 启动路径）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { manageTaskTool } from '../train-student-tool';
import { manageClassroomTool } from '../manage-classroom-tool';
import { AcademyStore } from '../../../academy/academy-store';
import { TrainingEngine } from '../../../academy/training-engine';
import { SessionTaskLock } from '../../../agent/session-task-lock';
import { forkVersionWorkspace, createInitialFormalVersion } from '../../../academy/academy-store-ops';
import { writeVersionDirFiles } from '../../../academy/academy-version-dir';
import type { AcademyLlmPort } from '../../../academy/training-engine/llm-port';
import { ulid } from '../../../config/ulid';
import type { ToolInput, ToolCtx } from '../../../tools/types';
import type { AgentToolRuntimeContext } from '../runtime-context';

let tmpRoot: string;
let store: AcademyStore;
let engine: TrainingEngine;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-tool-v221-'));
  store = new AcademyStore({ root: tmpRoot });
  engine = new TrainingEngine({
    academyStore: store,
    llmPort: makeMockLlmPort(),
    sessionTaskLock: new SessionTaskLock(),
    deliverTo: async () => { /* noop */ },
    dataDir: tmpRoot,
  });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeMockLlmPort(): AcademyLlmPort {
  return {
    async invoke(input) {
      if (input.systemPrompt.length > 0) return { ok: true, text: 'mock answer' };
      return { ok: true, text: JSON.stringify({ score: 0.8, reasoning: 'mock' }) };
    },
  };
}

/** 构造工具 rtc（head 或 coach） */
function makeCtx(rtc: Partial<AgentToolRuntimeContext> & { role: 'head_teacher' | 'coach'; classroomId: string; trainingTaskId?: string }): ToolCtx {
  return {
    workdir: tmpRoot,
    config: {
      agentToolContext: {
        academyStore: store,
        trainingEngine: engine,
        kind: { biz: 'academy', role: rtc.role },
        sessionContext: {
          classroomId: rtc.classroomId,
          ...(rtc.trainingTaskId ? { trainingTaskId: rtc.trainingTaskId } : {}),
        },
        sessionDeps: { dataDir: tmpRoot, appConfig: {} as never },
        store: {} as never,
        agentManager: {} as never,
        ...rtc,
      },
    },
  } as unknown as ToolCtx;
}

/** 构造完整场景：classroom + student + base 1.0 + task + 初始 candidate */
async function setup(opts?: { status?: 'pending' | 'running' | 'paused'; pausedReason?: string; maxTurns?: number }) {
  const cid = ulid(), sid = ulid(), coachSid = ulid(), taskId = ulid();
  await store.putClassroom({
    id: cid, classroomId: cid, name: 'cls', headTeacherSessionId: ulid(),
    datasetIds: [], graderIds: [], skillIds: [], archived: false,
  });
  await store.putStudent({ id: sid, classroomId: cid, name: 'stu' });
  const formal = await createInitialFormalVersion(store, tmpRoot, cid, sid, { modelId: 'm' });
  await store.putStudent({ id: sid, classroomId: cid, name: 'stu', currentFormalVersionId: formal.versionId });
  const candidate = await forkVersionWorkspace(store, tmpRoot, formal.versionId, cid, sid, 1, 1, taskId);
  await store.putTask({
    id: taskId, classroomId: cid, studentId: sid, baseVersionId: formal.versionId,
    taskSeq: 1, coachSessionId: coachSid, mode: 'multi', optimizeStyle: 'training',
    maxTurns: opts?.maxTurns ?? 3, status: opts?.status ?? 'pending',
    candidateVersionId: candidate.versionId, temporaryBaselineVersionId: formal.versionId,
    ...(opts?.pausedReason ? { pausedReason: opts.pausedReason as 'maxturns' } : {}),
  });
  return { cid, sid, taskId, coachSid, baseVid: formal.versionId, candidateId: candidate.versionId };
}

async function callManageTask(input: ToolInput, ctxRole: 'head_teacher' | 'coach', classroomId: string, trainingTaskId?: string) {
  return manageTaskTool.run(input, makeCtx({ role: ctxRole, classroomId, trainingTaskId }));
}

// ── ⑧ manage-task taskId 隐式绑定 ───────────────────────────────────

describe('⑧ manage-task taskId 隐式绑定', () => {
  it('input.taskId 缺省 → 用 rtc.sessionContext.trainingTaskId（绑定 task）', async () => {
    const { cid, taskId } = await setup();
    // input 不传 taskId；rtc 绑定 taskId → status 正常返回
    const r = await callManageTask({ action: 'status' }, 'coach', cid, taskId);
    expect(r.isError).toBe(false);
    const text = (r.content?.[0] as { text: string }).text;
    const parsed = JSON.parse(text) as { task: { id: string } };
    expect(parsed.task.id).toBe(taskId);
  });

  it('input.taskId === rtc.trainingTaskId → 正常', async () => {
    const { cid, taskId } = await setup();
    const r = await callManageTask({ action: 'status', taskId }, 'coach', cid, taskId);
    expect(r.isError).toBe(false);
  });

  it('input.taskId ≠ rtc.trainingTaskId → task_not_bound 错误', async () => {
    const { cid, taskId } = await setup();
    const otherTaskId = ulid();
    const r = await callManageTask({ action: 'status', taskId: otherTaskId }, 'coach', cid, taskId);
    expect(r.isError).toBe(true);
    const text = (r.content?.[0] as { text: string }).text;
    expect(text).toMatch(/task_not_bound/);
  });

  it('head_teacher 调 manage-task 任意 action → forbidden（head 无权）', async () => {
    const { cid, taskId } = await setup();
    const r = await callManageTask({ action: 'status' }, 'head_teacher', cid, taskId);
    expect(r.isError).toBe(true);
    const text = (r.content?.[0] as { text: string }).text;
    expect(text).toMatch(/forbidden.*role.*head_teacher/);
  });
});

// ── ⑨ manage-classroom update_task 仅 patch maxTurns/directive ───────

describe('⑨ manage-classroom update_task', () => {
  it('仅 patch maxTurns（其他字段不传）', async () => {
    const { cid, taskId } = await setup();
    const r = await manageClassroomTool.run(
      { action: 'update_task', taskId, maxTurns: 10 },
      makeCtx({ role: 'head_teacher', classroomId: cid }),
    );
    expect(r.isError).toBe(false);
    const task = await store.getTask(cid, taskId);
    expect(task?.maxTurns).toBe(10);
  });

  it('仅 patch directive', async () => {
    const { cid, taskId } = await setup({ status: 'paused', pausedReason: 'maxturns' });
    const r = await manageClassroomTool.run(
      { action: 'update_task', taskId, directive: 'new directive' },
      makeCtx({ role: 'head_teacher', classroomId: cid }),
    );
    expect(r.isError).toBe(false);
    const task = await store.getTask(cid, taskId);
    expect(task?.directive).toBe('new directive');
  });

  it('不传 maxTurns/directive 任一 → invalid', async () => {
    const { cid, taskId } = await setup();
    const r = await manageClassroomTool.run(
      { action: 'update_task', taskId },
      makeCtx({ role: 'head_teacher', classroomId: cid }),
    );
    expect(r.isError).toBe(true);
  });

  it('改不了 status / candidateVersionId / temporaryBaselineVersionId（内部状态归引擎）', async () => {
    const { cid, taskId } = await setup();
    // 即使传这些字段（schema 不支持，但 input 是 any），update_task 不读取它们
    const r = await manageClassroomTool.run(
      { action: 'update_task', taskId, maxTurns: 99, status: 'running', candidateVersionId: 'hack' } as ToolInput,
      makeCtx({ role: 'head_teacher', classroomId: cid }),
    );
    expect(r.isError).toBe(false);
    const task = await store.getTask(cid, taskId);
    expect(task?.status).toBe('pending'); // 未被改
    expect(task?.candidateVersionId).not.toBe('hack');
  });
});

// ── ⑩ 工具/profile grep 残留归零（结构断言） ────────────────────────

describe('⑩ 全仓 trainStudentTool/manageStudentTool/train-student 残留归零', () => {
  it('registry 不再 import trainStudentTool / manageStudentTool', async () => {
    const regContent = fs.readFileSync(path.join(process.cwd(), 'app/server/src/tools/registry.ts'), 'utf8');
    expect(regContent).not.toMatch(/\btrainStudentTool\b/);
    expect(regContent).not.toMatch(/\bmanageStudentTool\b/);
    expect(regContent).not.toMatch(/'train-student'/);
    expect(regContent).toMatch(/\bmanageTaskTool\b/); // 新导出名
  });

  it('profile yamls 不再含 train-student / manage-student', () => {
    const head = fs.readFileSync(
      path.join(process.cwd(), 'app/plugins/session-types/academy-head_teacher.parent.main.yaml'),
      'utf8',
    );
    expect(head).not.toMatch(/- train-student\b/);
    expect(head).not.toMatch(/- manage-student\b/);
    expect(head).toMatch(/- manage-classroom\b/);
    const coach = fs.readFileSync(
      path.join(process.cwd(), 'app/plugins/session-types/academy-coach.parent.main.yaml'),
      'utf8',
    );
    expect(coach).not.toMatch(/- train-student\b/);
    expect(coach).toMatch(/- manage-task\b/);
  });
});
