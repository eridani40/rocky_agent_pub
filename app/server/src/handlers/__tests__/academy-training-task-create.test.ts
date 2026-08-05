/**
 * Academy training-task-create handler 单测 — POST /academy/classroom/:cid/student/:sid/training-task
 * 参考: specs/api/overall/18-academy.md §2.1（发起训练）
 *       specs/tech/version_logs/v0.0.210/change_plan.md G 节
 *
 * 重点覆盖（v0.0.210 coder-K 修复）：
 *   - coach session 持久化 model（INV：与 head/student 一致，缺 model 时 activate fail）
 *   - fallback 链：classroom.defaultModel（v0.0.230 收窄：无 app 默认兜底，缺省即 400）
 *   - ModelNotConfiguredError → 400 model_not_configured（actionable 提示）
 *
 * Mock 策略：真实 AcademyStore（FsCrudStore tmpdir）+ 真实 SessionStore（FsCrudStore）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleClassroomRoute } from '../academy-classroom';
import { handleTrainingTaskRoute } from '../academy-training-task';
import { AcademyStore } from '../../academy/academy-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { AppConfigService } from '../../config/app-config-service';
import type { AcademyHandlerDeps } from '../../routes/academy-routes';

let tmpRoot: string;
let academyStore: AcademyStore;
let sessionStore: SessionStore;
let appConfig: AppConfigService;
let deps: AcademyHandlerDeps;
/** deliverTo spy 收集（BUG-001：建任务后 kickoff 消息推 coach inbox） */
let deliverToCalls: Array<{ sessionId: string; message: any }>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-task-create-handler-'));
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
    models: [
      { modelId: 'test-chat', enabled: true },
      { modelId: 'test-other', enabled: true },
    ],
  });
  appConfig.set('default_models', 'default', { chat: 'test-chat' });
  deliverToCalls = [];
  deps = {
    academyStore,
    trainingEngine: {} as any, // create handler 不消费 trainingEngine
    agentManager: {
      deliverTo: async (sessionId: string, message: any) => {
        deliverToCalls.push({ sessionId, message });
        return { enqueueId: 'eq1' };
      },
    } as any,
    sessionStore,
    appConfig,
    dataDir: tmpRoot,
  };
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 读响应 JSON */
async function jsonBody(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

/** 构造 JSON Request */
function mkReq(method: string, url: string, body?: unknown): Request {
  return new Request(`http://test${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** 建教室 + 建学生，返 { cid, sid, initialVersionId } 给训练任务用 */
async function setupClassroomAndStudent(opts?: {
  classroomDefaultModel?: { providerId?: string; modelId: string };
}): Promise<{ cid: string; sid: string; initialVersionId: string }> {
  const createClassroomBody: any = { name: 'cls' };
  // v0.0.230：创建教室必填默认模型（无 app 默认兜底）；测试缺省给 test-chat 作教室默认
  createClassroomBody.defaultModel =
    opts?.classroomDefaultModel ?? { providerId: 'prov-test', modelId: 'test-chat' };
  const classroomResp = await handleClassroomRoute(
    mkReq('POST', '/academy/classroom', createClassroomBody),
    'POST', '/academy/classroom', deps,
  );
  expect(classroomResp.status).toBe(201);
  const cid = (await jsonBody(classroomResp)).classroom.id;

  const studentResp = await handleClassroomRoute(
    mkReq('POST', `/academy/classroom/${cid}/student`, { name: 'Alice' }),
    'POST', `/academy/classroom/${cid}/student`, deps,
  );
  expect(studentResp.status).toBe(201);
  const sBody = await jsonBody(studentResp);
  return { cid, sid: sBody.student.id, initialVersionId: sBody.initialVersion.id };
}

/** 简单模式训练任务 body（baseVersionId 必填） */
function taskBody(baseVersionId: string) {
  return {
    baseVersionId,
    mode: 'simple' as const,
    optimizeStyle: 'learning' as const,
    directive: 'improve tool use',
  };
}

describe('AcademyTrainingTaskCreate — coach session 持久化 model（v0.0.210 coder-K 修复）', () => {
  it('classroom 无 defaultModel → 建教室 400 model_not_configured（v0.0.230 无 app 默认兜底）', async () => {
    // academy 链收窄后创建教室即必填默认模型：不传 → head session resolve 跑空 → 400
    const clsResp = await handleClassroomRoute(
      mkReq('POST', '/academy/classroom', { name: 'cls' }),
      'POST', '/academy/classroom', deps,
    );
    expect(clsResp.status).toBe(400);
    expect((await jsonBody(clsResp)).error).toBe('model_not_configured');
  });

  it('[v0.0.219] 建任务 response.task 反规范化 baseVersionLabel（= base 版本 label，spec §2.1）', async () => {
    const { cid, sid, initialVersionId } = await setupClassroomAndStudent();
    // base = 0.0 初始版本（label='0.0'）
    const r = await handleTrainingTaskRoute(
      mkReq('POST', `/academy/classroom/${cid}/student/${sid}/training-task`, taskBody(initialVersionId)),
      'POST', `/academy/classroom/${cid}/student/${sid}/training-task`, deps,
    );
    expect(r.status).toBe(201);
    const body = await jsonBody(r);
    expect(body.task.baseVersionLabel).toBe('0.0');
    expect(body.task.baseVersionId).toBe(initialVersionId);
  });

  it('classroom.defaultModel 具体非保留字 → coach session 用教室默认', async () => {
    // 教室 defaultModel 指向 test-other（区别于 app 默认 test-chat）
    const { cid, sid, initialVersionId } = await setupClassroomAndStudent({
      classroomDefaultModel: { providerId: 'prov-test', modelId: 'test-other' },
    });
    const r = await handleTrainingTaskRoute(
      mkReq('POST', `/academy/classroom/${cid}/student/${sid}/training-task`, taskBody(initialVersionId)),
      'POST', `/academy/classroom/${cid}/student/${sid}/training-task`, deps,
    );
    expect(r.status).toBe(201);
    const body = await jsonBody(r);
    const coach = await sessionStore.getSession(body.coachSessionId);
    expect(coach!.providerId).toBe('prov-test');
    expect(coach!.modelId).toBe('test-other');
  });

  it('classroom.defaultModel 保留字 → 建教室 400 model_not_configured（v0.0.230 无 app 默认兜底）', async () => {
    // 保留字 modelId 等同未配 → head session resolve 跑空 → 创建即 400（不再 strip 落盘兜底 app 默认）
    const clsResp = await handleClassroomRoute(
      mkReq('POST', '/academy/classroom', { name: 'cls', defaultModel: { modelId: 'default' } }),
      'POST', '/academy/classroom', deps,
    );
    expect(clsResp.status).toBe(400);
    expect((await jsonBody(clsResp)).error).toBe('model_not_configured');
  });

  it('coach session model 无法解析（教室默认不可解析 + provider 禁用）→ 400 model_not_configured', async () => {
    // 先建教室建学生（此时 provider 仍启用），再禁用 providers 后建任务 → 教室默认不可用 + 无 app 兜底
    const { cid, sid, initialVersionId } = await setupClassroomAndStudent();
    appConfig.set('default_models', 'default', {});
    appConfig.set('providers', 'prov-test', { id: 'prov-test', enabled: false, models: [] });

    const r = await handleTrainingTaskRoute(
      mkReq('POST', `/academy/classroom/${cid}/student/${sid}/training-task`, taskBody(initialVersionId)),
      'POST', `/academy/classroom/${cid}/student/${sid}/training-task`, deps,
    );
    expect(r.status).toBe(400);
    const body = await jsonBody(r);
    expect(body.error).toBe('model_not_configured');
    expect(body.detail).toContain('教练');
  });
});

describe('AcademyTrainingTaskCreate — kickoff 消息投递（BUG-001 修复）', () => {
  it('建任务成功 → deliverTo(coachSessionId) 被调，消息含 taskId', async () => {
    const { cid, sid, initialVersionId } = await setupClassroomAndStudent();
    const r = await handleTrainingTaskRoute(
      mkReq('POST', `/academy/classroom/${cid}/student/${sid}/training-task`, taskBody(initialVersionId)),
      'POST', `/academy/classroom/${cid}/student/${sid}/training-task`, deps,
    );
    expect(r.status).toBe(201);
    const body = await jsonBody(r);

    // deliverTo 是 fire-and-forget（微任务）—— 等一拍再断言
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deliverToCalls).toHaveLength(1);
    expect(deliverToCalls[0]!.sessionId).toBe(body.coachSessionId);
    const text = (deliverToCalls[0]!.message.content[0] as { text: string }).text;
    expect(text).toContain(body.task.id); // coach 必须从 kickoff 拿到 manage-task 必填的 taskId
    expect(text).toContain('improve tool use'); // directive 透传
    // v0.0.221：去 propose，改为 adopt 定稿
    expect(text).toContain('adopt');
    expect(text).not.toContain('propose');
  });

  it('deliverTo 抛错不影响 201（fire-and-forget 兜底）', async () => {
    (deps.agentManager as any).deliverTo = async () => { throw new Error('coach activate 失败'); };
    const { cid, sid, initialVersionId } = await setupClassroomAndStudent();
    const r = await handleTrainingTaskRoute(
      mkReq('POST', `/academy/classroom/${cid}/student/${sid}/training-task`, taskBody(initialVersionId)),
      'POST', `/academy/classroom/${cid}/student/${sid}/training-task`, deps,
    );
    expect(r.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 0)); // 让 catch 消化，防 unhandled rejection
  });
});
