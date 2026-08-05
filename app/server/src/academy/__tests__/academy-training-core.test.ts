/**
 * academy-training-core 单测 — 两入口统一核心 createTrainingTaskAndCoach
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §5（5 步装配契约）
 *       specs/tech/version_logs/v0.0.213/change_plan.md E 节
 *
 * 覆盖（5 步 + 关键装配契约）：
 *   - 5 步顺序：gen tid → fork 初始 candidate → createSession(coach, ws=candidateWs) → putTask → deliverTo 任务书
 *   - coach workspaceDir = 初始 candidate workspaceDir（修原 cwd 错位）
 *   - fork 初始 candidate 必填 createdFromTaskId=tid（forkCandidate round 推进依赖）
 *   - 同 student 无 running task 校验（task_already_running）
 *   - 错误码映射：classroom/student/version/invalid_base_version/missing_evaluation_config/dataset/grader/model_not_configured
 *   - deliverTo fire-and-forget（失败不阻塞）
 *
 * 真实 AcademyStore + SessionStore + AppConfigService（tmpdir 隔离）+ agentManager mock。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  createTrainingTaskAndCoach,
  TrainingCoreError,
  TRAINING_CORE_HTTP_STATUS,
  type TrainingCoreDeps,
} from '../academy-training-core';
import { AcademyStore } from '../academy-store';
import {
  createInitialFormalVersion,
} from '../academy-store-ops';
import { writeVersionDirFiles } from '../academy-version-dir';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { AppConfigService } from '../../config/app-config-service';
import { ulid } from '../../config/ulid';
import type { AgentManagerImpl } from '../../agent/agent-manager';
import type { Message } from '../../message/types';

let tmpRoot: string;
let store: AcademyStore;
let sessionStore: SessionStore;
let appConfig: AppConfigService;
let deps: TrainingCoreDeps;
let deliverToCalls: Message[];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-training-core-'));
  store = new AcademyStore({ root: tmpRoot });
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fsEngine)
    .mount('transcript', fsEngine)
    .mount('summary', fsEngine)
    .mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  appConfig = new AppConfigService({ root: tmpRoot });
  appConfig.set('providers', 'prov-test', {
    id: 'prov-test', name: 'T', enabled: true, kind: 'mock',
    credential: {},
    models: [{ modelId: 'test-chat', enabled: true }],
  });
  appConfig.set('default_models', 'default', { chat: 'test-chat' });
  deliverToCalls = [];
  deps = {
    academyStore: store,
    sessionStore,
    agentManager: {
      deliverTo: async (_sid: string, message: Message) => {
        deliverToCalls.push(message);
        return { enqueueId: 'eq1' } as never;
      },
    } as unknown as AgentManagerImpl,
    appConfig,
    dataDir: tmpRoot,
  };
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 建测试用 classroom + student + formal base + dataset + grader，返各自 id */
async function setupClassroomAndBase(): Promise<{
  classroomId: string;
  studentId: string;
  baseVersionId: string;
  datasetId: string;
  graderId: string;
}> {
  const classroomId = ulid();
  const studentId = ulid();
  await store.putClassroom({
    id: classroomId, classroomId, name: 'cls',
    headTeacherSessionId: ulid(), datasetIds: [], graderIds: [], skillIds: [], archived: false,
    // v0.0.230：academy 链收窄无 app 默认兜底，coach 解析需 classroom.defaultModel 档
    defaultModel: { providerId: 'prov-test', modelId: 'test-chat' },
  });
  await store.putStudent({ id: studentId, classroomId, name: 'stu' });
  await createInitialFormalVersion(store, tmpRoot, classroomId, studentId, { modelId: 'm', providerId: 'prov-test' });
  const baseVersionId = ulid();
  const baseWs = path.join(tmpRoot, 'academy', classroomId, 'students', studentId, 'versions', '1.0', 'ws');
  await writeVersionDirFiles(baseWs, {
    versionLabel: '1.0',
    model: { modelId: 'm', providerId: 'prov-test' },
    agentsMd: '# 学生 AGENTS\n基础 prompt',
  });
  await store.putVersion({
    id: baseVersionId, studentId, classroomId,
    versionLabel: '1.0', type: 'formal', workspaceDir: baseWs, status: 'active',
  });
  const datasetId = ulid();
  await store.putDataset({
    id: datasetId, classroomId, name: 'ds',
    items: [{ id: 'c1', question: 'Q1', expectedAnswer: 'A1' }],
  });
  const graderId = ulid();
  await store.putGrader({
    id: graderId, classroomId, name: 'gr', type: 'em', matchRule: { trim: true }, threshold: 0.5,
  });
  return { classroomId, studentId, baseVersionId, datasetId, graderId };
}

describe('createTrainingTaskAndCoach — 5 步装配（happy path）', () => {
  it('5 步：gen tid → fork candidate → createSession → putTask → deliverTo', async () => {
    const { classroomId, studentId, baseVersionId, datasetId, graderId } = await setupClassroomAndBase();

    const result = await createTrainingTaskAndCoach(deps, {
      classroomId, studentId, baseVersionId,
      mode: 'multi', optimizeStyle: 'training',
      directive: 'improve answers',
      datasetId, graderId, maxTurns: 3,
    });

    // 步骤 1+4：task 落盘
    expect(result.task.id).toBeTruthy();
    expect(result.task.status).toBe('pending');
    expect(result.task.mode).toBe('multi');
    expect(result.task.baseVersionId).toBe(baseVersionId);
    expect(result.task.temporaryBaselineVersionId).toBe(baseVersionId);
    expect(result.task.coachSessionId).toBe(result.coachSessionId);
    expect(result.task.taskSeq).toBe(1);

    // 步骤 2：初始 candidate 已 fork（candidateVersionId 落 task + version record）
    expect(result.candidateVersionId).toBeTruthy();
    expect(result.candidateWorkspaceDir).toBeTruthy();
    expect(result.task.candidateVersionId).toBe(result.candidateVersionId);
    const candidate = await store.getVersion(classroomId, result.candidateVersionId);
    expect(candidate).toBeTruthy();
    expect(candidate!.type).toBe('process');
    expect(fs.existsSync(result.candidateWorkspaceDir)).toBe(true);

    // 步骤 3：coach session 真建（trainingTaskId 绑定 tid；workspaceDir=candidateWs）
    const coach = await sessionStore.getSession(result.coachSessionId);
    expect(coach).toBeTruthy();
    expect(coach!.role).toBe('coach');
    expect(coach!.academyTrainingTaskId).toBe(result.task.id);
    expect(coach!.academyClassroomId).toBe(classroomId);
    expect(coach!.providerId).toBe('prov-test');
    expect(coach!.modelId).toBe('test-chat');

    // 关键装配契约：coach workspaceDir = 初始 candidate workspaceDir（修原 cwd 错位）
    expect(coach!.workspaceDir).toBe(result.candidateWorkspaceDir);

    // 步骤 5：deliverTo 任务书投递（fire-and-forget，等微任务一拍）
    await new Promise((r) => setTimeout(r, 0));
    expect(deliverToCalls).toHaveLength(1);
    const text = (deliverToCalls[0]!.content[0] as { text: string }).text;
    expect(text).toContain(result.task.id); // coach 调各 action 的 taskId
    expect(text).toContain(result.candidateWorkspaceDir); // candidate ws 路径
    expect(text).toContain('improve answers'); // directive 透传
  });
});

describe('createTrainingTaskAndCoach — 关键装配契约 createdFromTaskId', () => {
  it('fork 初始 candidate 必填 createdFromTaskId=tid（forkCandidate round 推进依赖）', async () => {
    const { classroomId, studentId, baseVersionId, datasetId, graderId } = await setupClassroomAndBase();
    const result = await createTrainingTaskAndCoach(deps, {
      classroomId, studentId, baseVersionId,
      mode: 'multi', optimizeStyle: 'training',
      datasetId, graderId,
    });
    const candidate = await store.getVersion(classroomId, result.candidateVersionId);
    expect(candidate!.createdFromTaskId).toBe(result.task.id);
    expect(candidate!.roundNumber).toBe(1);
    expect(candidate!.taskSeq).toBe(1);
  });
});

describe('createTrainingTaskAndCoach — 同 student 无 running task 校验', () => {
  it('同 student 已有 pending 任务 → task_already_running', async () => {
    const { classroomId, studentId, baseVersionId, datasetId, graderId } = await setupClassroomAndBase();
    await createTrainingTaskAndCoach(deps, {
      classroomId, studentId, baseVersionId,
      mode: 'multi', optimizeStyle: 'training',
      datasetId, graderId,
    });
    // 同 student 再建一个 → 拒
    await expect(createTrainingTaskAndCoach(deps, {
      classroomId, studentId, baseVersionId,
      mode: 'multi', optimizeStyle: 'training',
      datasetId, graderId,
    })).rejects.toThrow(TrainingCoreError);
    try {
      await createTrainingTaskAndCoach(deps, {
        classroomId, studentId, baseVersionId,
        mode: 'multi', optimizeStyle: 'training',
        datasetId, graderId,
      });
    } catch (e) {
      expect((e as TrainingCoreError).code).toBe('task_already_running');
      expect(TRAINING_CORE_HTTP_STATUS[(e as TrainingCoreError).code]).toBe(409);
    }
  });
});

describe('createTrainingTaskAndCoach — 错误码映射', () => {
  it('classroom 不存在 → classroom_not_found (404)', async () => {
    await expect(createTrainingTaskAndCoach(deps, {
      classroomId: 'bogus-cid', studentId: 'sid',
      baseVersionId: 'vid', mode: 'simple', optimizeStyle: 'learning',
    })).rejects.toMatchObject({ code: 'classroom_not_found' });
  });

  it('student 不存在 → student_not_found (404)', async () => {
    const { classroomId } = await setupClassroomAndBase();
    await expect(createTrainingTaskAndCoach(deps, {
      classroomId, studentId: 'bogus-sid',
      baseVersionId: 'vid', mode: 'simple', optimizeStyle: 'learning',
    })).rejects.toMatchObject({ code: 'student_not_found' });
  });

  it('baseVersion 不属于该 student → version_not_found (404)', async () => {
    const { classroomId, studentId } = await setupClassroomAndBase();
    await expect(createTrainingTaskAndCoach(deps, {
      classroomId, studentId,
      baseVersionId: 'bogus-vid', mode: 'simple', optimizeStyle: 'learning',
    })).rejects.toMatchObject({ code: 'version_not_found' });
  });

  it('baseVersion 非 formal（process）→ invalid_base_version (400)', async () => {
    const { classroomId, studentId, baseVersionId } = await setupClassroomAndBase();
    // 把 base type 改为 process（schema 允许，触发 invalid_base_version）
    const base = await store.getVersion(classroomId, baseVersionId);
    const { createdAt: _c, updatedAt: _u, version: _v, ...rec } = base!;
    await store.putVersion({ ...rec, type: 'process' });
    await expect(createTrainingTaskAndCoach(deps, {
      classroomId, studentId, baseVersionId,
      mode: 'simple', optimizeStyle: 'learning',
    })).rejects.toMatchObject({ code: 'invalid_base_version' });
  });

  it('multi 缺 datasetId → missing_evaluation_config (400)', async () => {
    const { classroomId, studentId, baseVersionId, graderId } = await setupClassroomAndBase();
    await expect(createTrainingTaskAndCoach(deps, {
      classroomId, studentId, baseVersionId,
      mode: 'multi', optimizeStyle: 'training',
      graderId, // datasetId 缺
    })).rejects.toMatchObject({ code: 'missing_evaluation_config' });
  });

  it('multi datasetId 不存在 → dataset_not_found (404)', async () => {
    const { classroomId, studentId, baseVersionId, graderId } = await setupClassroomAndBase();
    await expect(createTrainingTaskAndCoach(deps, {
      classroomId, studentId, baseVersionId,
      mode: 'multi', optimizeStyle: 'training',
      datasetId: 'bogus-dsid', graderId,
    })).rejects.toMatchObject({ code: 'dataset_not_found' });
  });

  it('multi graderId 不存在 → grader_not_found (404)', async () => {
    const { classroomId, studentId, baseVersionId, datasetId } = await setupClassroomAndBase();
    await expect(createTrainingTaskAndCoach(deps, {
      classroomId, studentId, baseVersionId,
      mode: 'multi', optimizeStyle: 'training',
      datasetId, graderId: 'bogus-grid',
    })).rejects.toMatchObject({ code: 'grader_not_found' });
  });

  it('model 无法解析（无 provider + 无默认）→ model_not_configured (400)', async () => {
    const { classroomId, studentId, baseVersionId } = await setupClassroomAndBase();
    appConfig.set('default_models', 'default', {});
    appConfig.set('providers', 'prov-test', { id: 'prov-test', enabled: false, models: [] });
    await expect(createTrainingTaskAndCoach(deps, {
      classroomId, studentId, baseVersionId,
      mode: 'simple', optimizeStyle: 'learning',
    })).rejects.toMatchObject({ code: 'model_not_configured' });
  });

  it('所有错误码 → TRAINING_CORE_HTTP_STATUS 都有映射（闭合校验）', () => {
    const codes: Array<keyof typeof TRAINING_CORE_HTTP_STATUS> = [
      'classroom_not_found', 'student_not_found', 'version_not_found',
      'invalid_base_version', 'missing_evaluation_config',
      'dataset_not_found', 'grader_not_found',
      'task_already_running', 'model_not_configured',
    ];
    for (const code of codes) {
      expect(TRAINING_CORE_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(TRAINING_CORE_HTTP_STATUS[code]).toBeLessThan(600);
    }
  });
});

describe('createTrainingTaskAndCoach — deliverTo fire-and-forget', () => {
  it('deliverTo 抛错不阻塞返结果（fire-and-forget 兜底）', async () => {
    const { classroomId, studentId, baseVersionId, datasetId, graderId } = await setupClassroomAndBase();
    (deps.agentManager as unknown as { deliverTo: () => Promise<never> }).deliverTo = async () => {
      throw new Error('coach activate 失败');
    };
    const result = await createTrainingTaskAndCoach(deps, {
      classroomId, studentId, baseVersionId,
      mode: 'multi', optimizeStyle: 'training',
      datasetId, graderId,
    });
    expect(result.task.id).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0)); // 让 catch 消化，防 unhandled rejection
  });
});

describe('createTrainingTaskAndCoach — simple/learning 模式', () => {
  it('simple/learning 无 dataset/grader：putTask 不带 datasetId/graderId', async () => {
    const { classroomId, studentId, baseVersionId } = await setupClassroomAndBase();
    const result = await createTrainingTaskAndCoach(deps, {
      classroomId, studentId, baseVersionId,
      mode: 'simple', optimizeStyle: 'learning',
    });
    expect(result.task.mode).toBe('simple');
    expect(result.task.datasetId).toBeUndefined();
    expect(result.task.graderId).toBeUndefined();
    expect(result.task.maxTurns).toBe(1); // simple 默认 1 轮
  });
});
