/**
 * Academy student handler 单测 — handleGetStudent tasks filter + handleGetVersionContent memory
 * 参考: specs/api/overall/18-academy.md §1.7（学生详情 response 加 tasks）/ §1.8（memory 真实条目）
 *       specs/tech/version_logs/v0.0.219/change_plan.md 修复区 2/C + 3
 *
 * 覆盖：
 *   - GET /academy/classroom/:cid/student/:sid response 含 tasks（filter studentId，spec §1.7）
 *   - GET .../version/:vid content.memory 不再恒 []（spec §1.8）
 *
 * Mock 策略：真实 AcademyStore（FsCrudStore tmpdir）+ 真实 SessionStore（FsCrudStore）。
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleClassroomRoute } from '../academy-classroom';
import { handleStudentRoute } from '../academy-student';
import { AcademyStore } from '../../academy/academy-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { AppConfigService } from '../../config/app-config-service';
import { ulid } from '../../config/ulid';
import type { AcademyHandlerDeps } from '../../routes/academy-routes';

let tmpRoot: string;
let academyStore: AcademyStore;
let sessionStore: SessionStore;
let appConfig: AppConfigService;
let deps: AcademyHandlerDeps;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-student-handler-'));
  academyStore = new AcademyStore({ root: tmpRoot });
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
  deps = {
    academyStore,
    trainingEngine: {} as any,
    agentManager: {} as any,
    sessionStore,
    appConfig,
    dataDir: tmpRoot,
  };
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function jsonBody(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

/** 建教室 + 建学生，返 { cid, sid, initialVersionId } */
async function setupClassroomAndStudent(): Promise<{ cid: string; sid: string; initialVersionId: string }> {
  const classroomResp = await handleClassroomRoute(
    new Request('http://test/academy/classroom', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // v0.0.230：创建教室必填默认模型（无 app 默认兜底）
      body: JSON.stringify({ name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }),
    }),
    'POST', '/academy/classroom', deps,
  );
  expect(classroomResp.status).toBe(201);
  const cid = (await jsonBody(classroomResp)).classroom.id;
  const studentResp = await handleClassroomRoute(
    new Request(`http://test/academy/classroom/${cid}/student`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    }),
    'POST', `/academy/classroom/${cid}/student`, deps,
  );
  expect(studentResp.status).toBe(201);
  const sBody = await jsonBody(studentResp);
  return { cid, sid: sBody.student.id, initialVersionId: sBody.initialVersion.id };
}

/** 直接待办 task record（最小必填字段） */
async function seedTask(opts: {
  cid: string;
  sid: string;
  baseVersionId: string;
  taskSeq: number;
  status?: string;
}): Promise<string> {
  const tid = ulid();
  await academyStore.putTask({
    id: tid,
    classroomId: opts.cid,
    studentId: opts.sid,
    baseVersionId: opts.baseVersionId,
    taskSeq: opts.taskSeq,
    coachSessionId: ulid(),
    mode: 'simple',
    optimizeStyle: 'learning',
    status: (opts.status as any) ?? 'running',
  });
  return tid;
}

describe('handleGetStudent — response.tasks filter（v0.0.219 §1.7）', () => {
  it('response 含 tasks = 该学生任务（filter studentId）+ baseVersionLabel 反规范化', async () => {
    const { cid, sid, initialVersionId } = await setupClassroomAndStudent();
    // 给该学生建 2 个 task
    await seedTask({ cid, sid, baseVersionId: initialVersionId, taskSeq: 1 });
    // v0.0.221：status enum 收窄 6→3（pending/running/paused），用 paused 替代 done
    await seedTask({ cid, sid, baseVersionId: initialVersionId, taskSeq: 2, status: 'paused' });

    const r = await handleStudentRoute(
      new Request(`http://test/academy/classroom/${cid}/student/${sid}`),
      'GET', `/academy/classroom/${cid}/student/${sid}`, deps,
    );
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.student.id).toBe(sid);
    expect(Array.isArray(body.versions)).toBe(true);
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks).toHaveLength(2);
    // 全是该 student 的任务
    for (const t of body.tasks) expect(t.studentId).toBe(sid);
    // BUG-001: baseVersionLabel 必须反规范化（initial version label = '0.0'），
    // 否则前端任务卡降级显「v?.1」
    for (const t of body.tasks) expect(t.baseVersionLabel).toBe('0.0');
  });

  it('仅返该学生任务（同教室其它学生任务不混入）', async () => {
    const { cid, sid, initialVersionId } = await setupClassroomAndStudent();
    // 建第二个学生
    const s2 = await handleClassroomRoute(
      new Request(`http://test/academy/classroom/${cid}/student`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bob' }),
      }),
      'POST', `/academy/classroom/${cid}/student`, deps,
    );
    const sid2 = (await jsonBody(s2)).student.id;
    // 各建 1 个 task
    await seedTask({ cid, sid, baseVersionId: initialVersionId, taskSeq: 1 });
    await seedTask({ cid, sid: sid2, baseVersionId: initialVersionId, taskSeq: 1 });

    const r = await handleStudentRoute(
      new Request(`http://test/academy/classroom/${cid}/student/${sid}`),
      'GET', `/academy/classroom/${cid}/student/${sid}`, deps,
    );
    const body = await jsonBody(r);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].studentId).toBe(sid);
  });

  it('无任务 → tasks = []（字段仍存在）', async () => {
    const { cid, sid } = await setupClassroomAndStudent();
    const r = await handleStudentRoute(
      new Request(`http://test/academy/classroom/${cid}/student/${sid}`),
      'GET', `/academy/classroom/${cid}/student/${sid}`, deps,
    );
    const body = await jsonBody(r);
    expect(body.tasks).toEqual([]);
  });

  it('baseVersionId 读不到 → baseVersionLabel 降级 undefined（不抛错）', async () => {
    const { cid, sid } = await setupClassroomAndStudent();
    // baseVersionId 用合法 ULID 形状但 store 中不存在该 version
    await seedTask({
      cid, sid,
      baseVersionId: ulid(),
      taskSeq: 1,
    });

    const r = await handleStudentRoute(
      new Request(`http://test/academy/classroom/${cid}/student/${sid}`),
      'GET', `/academy/classroom/${cid}/student/${sid}`, deps,
    );
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.tasks).toHaveLength(1);
    // 读不到 base version → baseVersionLabel undefined（前端降级分支，但不报 500）
    expect(body.tasks[0].baseVersionLabel).toBeUndefined();
  });
});

describe('handleGetVersionContent — content.memory 真实条目（v0.0.219 §1.8）', () => {
  it('版本工作区有 .rocky/memory/*.md → content.memory 非空', async () => {
    const { cid, sid, initialVersionId } = await setupClassroomAndStudent();
    // 直接往 0.0 workspace 补 memory md 文件
    const ver = await academyStore.getVersion(cid, initialVersionId);
    expect(ver?.workspaceDir).toBeTruthy();
    fs.mkdirSync(path.join(ver!.workspaceDir, '.rocky', 'memory'), { recursive: true });
    fs.writeFileSync(
      path.join(ver!.workspaceDir, '.rocky', 'memory', 'plan.md'),
      '# 计划\n学生记忆一',
      'utf8',
    );

    const r = await handleStudentRoute(
      new Request(`http://test/academy/classroom/${cid}/student/${sid}/version/${initialVersionId}`),
      'GET', `/academy/classroom/${cid}/student/${sid}/version/${initialVersionId}`, deps,
    );
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(Array.isArray(body.content.memory)).toBe(true);
    expect(body.content.memory).toHaveLength(1);
    expect(body.content.memory[0].name).toBe('plan.md');
    expect(body.content.memory[0].preview).toContain('学生记忆一');
  });

  it('0.0 空 workspace（无 memory md）→ content.memory = []（不再恒 [] 占位，而是真实读侧返空）', async () => {
    const { cid, sid, initialVersionId } = await setupClassroomAndStudent();
    const r = await handleStudentRoute(
      new Request(`http://test/academy/classroom/${cid}/student/${sid}/version/${initialVersionId}`),
      'GET', `/academy/classroom/${cid}/student/${sid}/version/${initialVersionId}`, deps,
    );
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.content.memory).toEqual([]);
  });
});
