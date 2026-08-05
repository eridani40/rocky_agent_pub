/**
 * buildAcademyContext 单测（白盒）—— SessionConfig.academyContext 装配（mapper 数据源）
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §4.1（5 academy mapper）
 *       app/plugins/builtins/rocky_context/prompt/academy-shared.ts（AcademyContextLike 鸭子类型）
 *
 * 覆盖：
 *   - head_teacher：classroom + students/datasets/graders/tasks 全量裁剪
 *   - coach：classroom + task + turns（不含教室资产列表）
 *   - student：仅 classroom
 *   - 非 academy kind / 无 classroomId → undefined（不注入）
 *   - 实体不存在 → 字段级 undefined，不 throw（mapper graceful degrade）
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { SessionKind } from '@app/shared';
import { AcademyStore } from '../../academy/academy-store';
import { buildAcademyContext, isAcademySessionKind } from '../../academy/academy-context';
import { ulid } from '../../config/ulid';

let tmpRoot: string;
let academyStore: AcademyStore;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-context-'));
  academyStore = new AcademyStore({ root: tmpRoot });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 建教室 + 学生 + 数据集 + 评估器 + 任务 + 一轮 turn，返回各 id */
async function seedAcademy() {
  const classroomId = ulid();
  await academyStore.putClassroom({
    id: classroomId, classroomId, name: '物理班', headTeacherSessionId: ulid(),
  });
  const studentId = ulid();
  await academyStore.putStudent({ id: studentId, classroomId, name: '小红' });
  const datasetId = ulid();
  await academyStore.putDataset({
    id: datasetId, classroomId, name: '力学题库',
    items: [{ id: 'c1', question: '牛顿第二定律？' }],
  });
  const graderId = ulid();
  await academyStore.putGrader({ id: graderId, classroomId, name: '精确匹配', type: 'em' });
  const taskId = ulid();
  await academyStore.putTask({
    id: taskId, classroomId, studentId, baseVersionId: ulid(), taskSeq: 1,
    coachSessionId: ulid(), mode: 'multi', optimizeStyle: 'training',
    status: 'running', directive: '提升力学题正确率', currentTurn: 1, maxTurns: 5,
  });
  await academyStore.appendTurn({
    id: ulid(), taskId, classroomId, studentId, round: 1,
    candidateVersionId: ulid(), status: 'decided', decision: 'improve', avgScore: 0.85,
  });
  return { classroomId, studentId, datasetId, graderId, taskId };
}

function kindOf(role: 'head_teacher' | 'coach' | 'student' | 'rocky', biz: 'academy' | 'playground' = 'academy') {
  return new SessionKind({ biz, role, derivation: 'parent' });
}

describe('isAcademySessionKind', () => {
  it('academy 三 role / biz=academy 判定', () => {
    expect(isAcademySessionKind(kindOf('head_teacher'))).toBe(true);
    expect(isAcademySessionKind(kindOf('coach'))).toBe(true);
    expect(isAcademySessionKind(kindOf('student'))).toBe(true);
    expect(isAcademySessionKind(kindOf('rocky', 'playground'))).toBe(false);
  });
});

describe('buildAcademyContext — 按 role 裁剪', () => {
  it('head_teacher：classroom + students/datasets/graders/tasks', async () => {
    const { classroomId, datasetId, graderId, taskId } = await seedAcademy();
    const ctx = await buildAcademyContext({
      academyStore, kind: kindOf('head_teacher'), sessionContext: { classroomId },
    });
    expect(ctx).toBeTruthy();
    expect(ctx!.classroom?.name).toBe('物理班');
    expect(ctx!.students?.length).toBe(1);
    expect(ctx!.students?.[0]?.name).toBe('小红');
    expect(ctx!.datasets?.map((d) => d.id)).toEqual([datasetId]);
    expect(ctx!.graders?.map((g) => g.id)).toEqual([graderId]);
    expect(ctx!.tasks?.map((t) => t.id)).toEqual([taskId]);
    // head 不注入单个 task/turns（那是 coach 的裁剪）
    expect(ctx!.task).toBeUndefined();
    expect(ctx!.turns).toBeUndefined();
  });

  it('coach：classroom + task + turns（directive/迭代状态数据源）', async () => {
    const { classroomId, taskId } = await seedAcademy();
    const ctx = await buildAcademyContext({
      academyStore, kind: kindOf('coach'),
      sessionContext: { classroomId, trainingTaskId: taskId },
    });
    expect(ctx).toBeTruthy();
    expect(ctx!.classroom?.name).toBe('物理班');
    expect(ctx!.task?.id).toBe(taskId);
    expect(ctx!.task?.directive).toBe('提升力学题正确率');
    expect(ctx!.task?.currentTurn).toBe(1);
    expect(ctx!.turns?.length).toBe(1);
    expect(ctx!.turns?.[0]?.decision).toBe('improve');
    expect(ctx!.turns?.[0]?.avgScore).toBe(0.85);
    // coach 不注入教室资产/学生/任务看板列表
    expect(ctx!.datasets).toBeUndefined();
    expect(ctx!.graders).toBeUndefined();
    expect(ctx!.students).toBeUndefined();
    expect(ctx!.tasks).toBeUndefined();
  });

  it('student：仅 classroom（其余 mapper 不读）', async () => {
    const { classroomId, studentId } = await seedAcademy();
    const ctx = await buildAcademyContext({
      academyStore, kind: kindOf('student'),
      sessionContext: { classroomId, studentId, versionId: ulid() },
    });
    expect(ctx).toBeTruthy();
    expect(ctx!.classroom?.name).toBe('物理班');
    expect(ctx!.task).toBeUndefined();
    expect(ctx!.turns).toBeUndefined();
    expect(ctx!.datasets).toBeUndefined();
    expect(ctx!.students).toBeUndefined();
  });
});

describe('buildAcademyContext — 不注入 / 容错', () => {
  it('非 academy kind → undefined', async () => {
    const ctx = await buildAcademyContext({
      academyStore, kind: kindOf('rocky', 'playground'), sessionContext: { classroomId: ulid() },
    });
    expect(ctx).toBeUndefined();
  });

  it('academy kind 但无 classroomId → undefined', async () => {
    const ctx = await buildAcademyContext({
      academyStore, kind: kindOf('head_teacher'), sessionContext: {},
    });
    expect(ctx).toBeUndefined();
  });

  it('实体不存在 → 字段级 undefined，不 throw（mapper 自然返空）', async () => {
    const ctx = await buildAcademyContext({
      academyStore, kind: kindOf('head_teacher'), sessionContext: { classroomId: ulid() },
    });
    // 空教室：list 查询返回空数组（[] 而非 undefined），classroom 不存在 → undefined
    expect(ctx).toBeTruthy();
    expect(ctx!.classroom).toBeUndefined();
    expect(ctx!.students).toEqual([]);
    expect(ctx!.datasets).toEqual([]);
  });

  it('coach 无 trainingTaskId → 仅 classroom，不 throw', async () => {
    const { classroomId } = await seedAcademy();
    const ctx = await buildAcademyContext({
      academyStore, kind: kindOf('coach'), sessionContext: { classroomId },
    });
    expect(ctx!.classroom?.name).toBe('物理班');
    expect(ctx!.task).toBeUndefined();
    expect(ctx!.turns).toBeUndefined();
  });

  it('coach task 有 candidateVersionId → 解析 candidateWorkspaceDir 绝对路径（v0.0.213）', async () => {
    const { classroomId, studentId, taskId } = await seedAcademy();
    // 建一个过程版本当 candidate（fork 自 base 的 round1 副本）
    const candidateVersionId = ulid();
    const candidateWs = path.join(tmpRoot, 'academy', classroomId, 'students', studentId,
      'versions', '.work', '0.1', '1', 'ws');
    fs.mkdirSync(candidateWs, { recursive: true });
    await academyStore.putVersion({
      id: candidateVersionId, classroomId, studentId,
      versionLabel: '0.1.1', type: 'process',
      workspaceDir: candidateWs, status: 'active', taskSeq: 1, roundNumber: 1,
      createdFromTaskId: taskId,
    });
    // task 落 candidateVersionId
    const task = await academyStore.getTask(classroomId, taskId);
    expect(task).toBeTruthy();
    const { createdAt: _c, updatedAt: _u, version: _v, ...taskRest } = task!;
    await academyStore.putTask({ ...taskRest, candidateVersionId });

    const ctx = await buildAcademyContext({
      academyStore, kind: kindOf('coach'),
      sessionContext: { classroomId, trainingTaskId: taskId },
    });
    expect(ctx).toBeTruthy();
    expect(ctx!.task?.candidateVersionId).toBe(candidateVersionId);
    // buildAcademyContext 从 candidateVersionId 解析 workspaceDir 填入（iteration_state mapper 注入用）
    expect(ctx!.candidateWorkspaceDir).toBe(candidateWs);
  });

  it('coach task.candidateVersionId 指向不存在版本 → candidateWorkspaceDir undefined（graceful）', async () => {
    const { classroomId, taskId } = await seedAcademy();
    const task = await academyStore.getTask(classroomId, taskId);
    const { createdAt: _c, updatedAt: _u, version: _v, ...taskRest } = task!;
    await academyStore.putTask({ ...taskRest, candidateVersionId: ulid() /* 不存在的 versionId */ });
    const ctx = await buildAcademyContext({
      academyStore, kind: kindOf('coach'),
      sessionContext: { classroomId, trainingTaskId: taskId },
    });
    expect(ctx).toBeTruthy();
    expect(ctx!.candidateWorkspaceDir).toBeUndefined();
  });
});
