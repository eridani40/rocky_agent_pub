/**
 * Academy classroom handler 单测 — POST/GET/PATCH classroom 事务 + 自动建 head session + 补偿回滚
 * 参考: specs/api/overall/18-academy.md §1.1-1.7（教室端点契约）
 *       specs/tech/version_logs/v0.0.210/change_plan.md K 节（行 175）
 *
 * 覆盖：
 *   - POST /academy/classroom → 201 + classroom record + 自动建 head session（双向关联 INV-1）
 *   - GET /academy/classroom → 列表
 *   - GET /academy/classroom/:cid → 详情（含 students/tasks/datasets/graders 概览）
 *   - PATCH /academy/classroom/:cid → name/logo 改动
 *   - POST /academy/classroom/:cid/student → 自动建 0.0 初始版本（formal）
 *   - 补偿回滚：session 建失败时 workspace 目录被清理
 *
 * Mock 策略：真实 AcademyStore（FsCrudStore tmpdir）+ 真实 SessionStore（FsCrudStore）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleClassroomRoute } from '../academy-classroom';
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-classroom-handler-'));
  academyStore = new AcademyStore({ root: tmpRoot });
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fsEngine)
    .mount('transcript', fsEngine)
    .mount('summary', fsEngine)
    .mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  // app 模型配置 fixture：一个 enabled provider + 默认 chat 模型（resolveModel 数据源）
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
  deps = {
    academyStore,
    trainingEngine: {} as any, // classroom handler 不消费 trainingEngine
    agentManager: {} as any,   // classroom handler 不消费 agentManager
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

/** 构造 Request */
function mkReq(method: string, body?: unknown): Request {
  return new Request('http://test/academy/classroom', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('AcademyClassroomHandler — POST /academy/classroom', () => {
  it('建教室 → 201 + classroom record + 自动建 head session（INV-1 双向关联）', async () => {
    const r = await handleClassroomRoute(mkReq('POST', { name: ' maths ', logo: '🎓', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }), 'POST', '/academy/classroom', deps);
    expect(r.status).toBe(201);
    const body = await jsonBody(r);
    expect(body.classroom.id).toBeTruthy();
    expect(body.classroom.name).toBe(' maths ');
    expect(body.classroom.logo).toBe('🎓');
    expect(body.classroom.headTeacherSessionId).toBeTruthy();
    expect(body.headSessionId).toBe(body.classroom.headTeacherSessionId);

    // 校验 head session 落库（biz='academy'/role='head_teacher'）
    const headSession = await sessionStore.getSession(body.headSessionId);
    expect(headSession).toBeTruthy();
    expect(headSession!.biz).toBe('academy');
    expect(headSession!.role).toBe('head_teacher');
    expect(headSession!.derivation).toBe('parent');
    // workspaceDir 指向 <DATA_DIR>/academy/<cid>/head-workspace/
    expect(headSession!.workspaceDir).toBe(
      path.join(tmpRoot, 'academy', body.classroom.id, 'head-workspace'),
    );
    // workspace 目录实际创建
    expect(fs.existsSync(headSession!.workspaceDir)).toBe(true);
  });

  it('缺 name → 400 invalid_input', async () => {
    const r = await handleClassroomRoute(mkReq('POST', { logo: '🎓' }), 'POST', '/academy/classroom', deps);
    expect(r.status).toBe(400);
    const body = await jsonBody(r);
    expect(body.error).toBe('invalid_input');
  });

  it('非法 JSON → 400 invalid json body', async () => {
    const r = await handleClassroomRoute(
      new Request('http://x/academy/classroom', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
      'POST', '/academy/classroom', deps,
    );
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error).toBe('invalid json body');
  });

  it('带 defaultModel → 201 + classroom.defaultModel 落盘（复合 {providerId, modelId}）', async () => {
    const r = await handleClassroomRoute(
      mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-other' } }),
      'POST', '/academy/classroom', deps,
    );
    expect(r.status).toBe(201);
    const body = await jsonBody(r);
    expect(body.classroom.defaultModel).toEqual({ providerId: 'prov-test', modelId: 'test-other' });
    // 持久化校验
    const got = await academyStore.getClassroom(body.classroom.id);
    expect(got?.defaultModel).toEqual({ providerId: 'prov-test', modelId: 'test-other' });
  });

  it('带 defaultModel 保留字 modelId → 400 model_not_configured（创建即必填具体模型，v0.0.230 无 app 兜底）', async () => {
    const r = await handleClassroomRoute(
      mkReq('POST', { name: 'cls', defaultModel: { modelId: 'default' } }),
      'POST', '/academy/classroom', deps,
    );
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error).toBe('model_not_configured');
  });

  it('head session 持久化 model：body.defaultModel 具体非保留字 → 用该 model 精确反查 providerId', async () => {
    // body.defaultModel 指向 test-other（区别于 app 默认 test-chat），head session 应用 test-other
    const r = await handleClassroomRoute(
      mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-other' } }),
      'POST', '/academy/classroom', deps,
    );
    expect(r.status).toBe(201);
    const body = await jsonBody(r);
    const headSession = await sessionStore.getSession(body.headSessionId);
    expect(headSession!.providerId).toBe('prov-test');
    expect(headSession!.modelId).toBe('test-other');
  });

  it('head session 持久化 model：缺省 defaultModel → 400 model_not_configured（v0.0.230 去 app 默认兜底）', async () => {
    // 不传 defaultModel → head session model 无档可解（academy 无 app 默认）→ 400
    const r = await handleClassroomRoute(
      mkReq('POST', { name: 'cls' }),
      'POST', '/academy/classroom', deps,
    );
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error).toBe('model_not_configured');
  });

  it('head session 持久化 model：body.defaultModel 保留字 → 400 model_not_configured（不短路无兜底）', async () => {
    const r = await handleClassroomRoute(
      mkReq('POST', { name: 'cls', defaultModel: { modelId: 'default' } }),
      'POST', '/academy/classroom', deps,
    );
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error).toBe('model_not_configured');
  });

  it('head session model 无法解析（缺省 defaultModel + provider 不可用）→ 400 model_not_configured', async () => {
    // 缺省 defaultModel（无 classroom 档）→ 链跑空即 400（v0.0.230 无 app 兜底）；再清 provider 兜底防御
    appConfig.set('default_models', 'default', {});
    appConfig.set('providers', 'prov-test', { id: 'prov-test', enabled: false, models: [] });
    const r = await handleClassroomRoute(
      mkReq('POST', { name: 'cls' }),
      'POST', '/academy/classroom', deps,
    );
    expect(r.status).toBe(400);
    const body = await jsonBody(r);
    expect(body.error).toBe('model_not_configured');
    expect(body.detail).toContain('班主任');
  });
});

describe('AcademyClassroomHandler — GET /academy/classroom', () => {
  it('空教室 → 200 + items: []', async () => {
    const r = await handleClassroomRoute(mkReq('GET'), 'GET', '/academy/classroom', deps);
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.items).toEqual([]);
  });

  it('已建教室 → 列表含 classroom（按 ULID 倒序）', async () => {
    // 建 2 个教室（v0.0.230 起创建必填 defaultModel）
    await handleClassroomRoute(mkReq('POST', { name: 'a', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }), 'POST', '/academy/classroom', deps);
    await handleClassroomRoute(mkReq('POST', { name: 'b', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }), 'POST', '/academy/classroom', deps);
    const r = await handleClassroomRoute(mkReq('GET'), 'GET', '/academy/classroom', deps);
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.items.length).toBe(2);
    // 后建的 b 排前（ULID 倒序）
    expect(body.items[0].name).toBe('b');
    expect(body.items[1].name).toBe('a');
  });
});

describe('AcademyClassroomHandler — GET /academy/classroom/:cid', () => {
  it('教室存在 → 200 + 含 students/tasks/datasets/graders 概览数组', async () => {
    const created = await handleClassroomRoute(mkReq('POST', { name: 'c1', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }), 'POST', '/academy/classroom', deps);
    const cid = (await jsonBody(created)).classroom.id;
    const r = await handleClassroomRoute(mkReq('GET'), 'GET', `/academy/classroom/${cid}`, deps);
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.classroom.id).toBe(cid);
    expect(Array.isArray(body.students)).toBe(true);
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(Array.isArray(body.datasets)).toBe(true);
    expect(Array.isArray(body.graders)).toBe(true);
  });

  it('教室不存在 → 404 classroom_not_found', async () => {
    const r = await handleClassroomRoute(mkReq('GET'), 'GET', `/academy/classroom/${ulid()}`, deps);
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error).toBe('classroom_not_found');
  });

  it('[v0.0.219] tasks 反规范化 baseVersionLabel（getVersion label，spec §2.2）', async () => {
    const created = await handleClassroomRoute(mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }), 'POST', '/academy/classroom', deps);
    const cid = (await jsonBody(created)).classroom.id;
    // 建学生（自动建 0.0 formal 版本）
    const studentResp = await handleClassroomRoute(
      mkReq('POST', { name: 'Alice' }), 'POST', `/academy/classroom/${cid}/student`, deps,
    );
    const sBody = await jsonBody(studentResp);
    const sid = sBody.student.id;
    const initialVersionId = sBody.initialVersion.id;
    // 直接 seed 一个 task（base = 0.0 版本，label='0.0'）
    await academyStore.putTask({
      id: ulid(),
      classroomId: cid,
      studentId: sid,
      baseVersionId: initialVersionId,
      taskSeq: 1,
      coachSessionId: ulid(),
      mode: 'simple',
      optimizeStyle: 'learning',
      status: 'running',
    });

    const r = await handleClassroomRoute(mkReq('GET'), 'GET', `/academy/classroom/${cid}`, deps);
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].baseVersionLabel).toBe('0.0');
  });

  it('[v0.0.219] task.baseVersionId 指向的版本读不到 → baseVersionLabel undefined（graceful）', async () => {
    const created = await handleClassroomRoute(mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }), 'POST', '/academy/classroom', deps);
    const cid = (await jsonBody(created)).classroom.id;
    const studentResp = await handleClassroomRoute(
      mkReq('POST', { name: 'Alice' }), 'POST', `/academy/classroom/${cid}/student`, deps,
    );
    const sBody = await jsonBody(studentResp);
    const sid = sBody.student.id;
    // seed task 指向一个不存在的 versionId
    await academyStore.putTask({
      id: ulid(),
      classroomId: cid,
      studentId: sid,
      baseVersionId: ulid(), // 不存在的 version
      taskSeq: 1,
      coachSessionId: ulid(),
      mode: 'simple',
      optimizeStyle: 'learning',
      status: 'running',
    });

    const r = await handleClassroomRoute(mkReq('GET'), 'GET', `/academy/classroom/${cid}`, deps);
    const body = await jsonBody(r);
    expect(body.tasks[0].baseVersionLabel).toBeUndefined();
  });
});

describe('AcademyClassroomHandler — PATCH /academy/classroom/:cid', () => {
  it('改 name + logo → 200 + 字段更新', async () => {
    const created = await handleClassroomRoute(mkReq('POST', { name: 'old', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }), 'POST', '/academy/classroom', deps);
    const cid = (await jsonBody(created)).classroom.id;
    const r = await handleClassroomRoute(
      new Request(`http://x/academy/classroom/${cid}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'new', logo: '🚀' }),
      }),
      'PATCH', `/academy/classroom/${cid}`, deps,
    );
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.name).toBe('new');
    expect(body.logo).toBe('🚀');
    // classroom record 持久化校验
    const got = await academyStore.getClassroom(cid);
    expect(got?.name).toBe('new');
    expect(got?.logo).toBe('🚀');
  });

  it('教室不存在 → 404 classroom_not_found', async () => {
    const r = await handleClassroomRoute(
      new Request(`http://x/academy/classroom/${ulid()}`, {
        method: 'PATCH', body: JSON.stringify({ name: 'x' }),
      }),
      'PATCH', `/academy/classroom/${ulid()}`, deps,
    );
    expect(r.status).toBe(404);
  });

  it('PATCH defaultModel=对象 → 落盘新默认模型（复合）', async () => {
    const created = await handleClassroomRoute(mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }), 'POST', '/academy/classroom', deps);
    const cid = (await jsonBody(created)).classroom.id;
    const r = await handleClassroomRoute(
      new Request(`http://x/academy/classroom/${cid}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultModel: { providerId: 'prov-test', modelId: 'test-other' } }),
      }),
      'PATCH', `/academy/classroom/${cid}`, deps,
    );
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.defaultModel).toEqual({ providerId: 'prov-test', modelId: 'test-other' });
    // 持久化校验
    const got = await academyStore.getClassroom(cid);
    expect(got?.defaultModel).toEqual({ providerId: 'prov-test', modelId: 'test-other' });
  });

  it('PATCH defaultModel=null → 显式清除（已存默认被移除）', async () => {
    // 先建带 defaultModel 的教室
    const created = await handleClassroomRoute(
      mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-other' } }),
      'POST', '/academy/classroom', deps,
    );
    const cid = (await jsonBody(created)).classroom.id;
    expect((await academyStore.getClassroom(cid))?.defaultModel).toBeTruthy();
    // 清除
    const r = await handleClassroomRoute(
      new Request(`http://x/academy/classroom/${cid}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultModel: null }),
      }),
      'PATCH', `/academy/classroom/${cid}`, deps,
    );
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.defaultModel).toBeUndefined();
    // 持久化校验（store 层 defaultModel 已被移除）
    const got = await academyStore.getClassroom(cid);
    expect(got?.defaultModel).toBeUndefined();
  });

  it('PATCH 不传 defaultModel → 保留现状（不改动）', async () => {
    const created = await handleClassroomRoute(
      mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-other' } }),
      'POST', '/academy/classroom', deps,
    );
    const cid = (await jsonBody(created)).classroom.id;
    // PATCH 只改 name，不动 defaultModel
    const r = await handleClassroomRoute(
      new Request(`http://x/academy/classroom/${cid}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'new-name' }),
      }),
      'PATCH', `/academy/classroom/${cid}`, deps,
    );
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.name).toBe('new-name');
    expect(body.defaultModel).toEqual({ providerId: 'prov-test', modelId: 'test-other' });
  });
});

describe('AcademyClassroomHandler — POST /academy/classroom/:cid/student', () => {
  it('建学生 → 201 + student record + 自动建 0.0 初始版本（formal）', async () => {
    const created = await handleClassroomRoute(mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }), 'POST', '/academy/classroom', deps);
    const cid = (await jsonBody(created)).classroom.id;
    const r = await handleClassroomRoute(
      new Request(`http://x/academy/classroom/${cid}/student`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Alice', logo: '👩‍🎓' }),
      }),
      'POST', `/academy/classroom/${cid}/student`, deps,
    );
    expect(r.status).toBe(201);
    const body = await jsonBody(r);
    expect(body.student.id).toBeTruthy();
    expect(body.student.name).toBe('Alice');
    expect(body.student.classroomId).toBe(cid);
    // 0.0 初始版本
    expect(body.initialVersion.versionLabel).toBe('0.0');
    expect(body.initialVersion.type).toBe('formal');
    expect(body.initialVersion.workspaceDir).toBeTruthy();
    // currentFormalVersionId 已回写
    expect(body.student.currentFormalVersionId).toBe(body.initialVersion.id);
    // workspaceDir 实际创建 + version.json 已写入
    expect(fs.existsSync(body.initialVersion.workspaceDir)).toBe(true);
    const versionJsonPath = path.join(body.initialVersion.workspaceDir, 'version.json');
    expect(fs.existsSync(versionJsonPath)).toBe(true);
  });

  it('缺省 model → version.json 播种教室默认（classroom.defaultModel 档，非 app 默认）', async () => {
    const created = await handleClassroomRoute(mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }), 'POST', '/academy/classroom', deps);
    const cid = (await jsonBody(created)).classroom.id;
    const r = await handleClassroomRoute(
      mkReq('POST', { name: 'Bob' }), 'POST', `/academy/classroom/${cid}/student`, deps,
    );
    expect(r.status).toBe(201);
    const body = await jsonBody(r);
    const versionJsonPath = path.join(body.initialVersion.workspaceDir, 'version.json');
    const vjson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
    // 初始播种 = resolveModel 解析的教室默认（prov-test/test-chat），不是 {modelId:'default'}
    expect(vjson.model).toEqual({ providerId: 'prov-test', modelId: 'test-chat' });
  });

  it('显式 body.model（具体 modelId）→ version.json 用给的模型 + 反查 providerId', async () => {
    const created = await handleClassroomRoute(mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }), 'POST', '/academy/classroom', deps);
    const cid = (await jsonBody(created)).classroom.id;
    const r = await handleClassroomRoute(
      mkReq('POST', { name: 'C', model: { modelId: 'test-other' } }),
      'POST', `/academy/classroom/${cid}/student`, deps,
    );
    expect(r.status).toBe(201);
    const body = await jsonBody(r);
    const vjson = JSON.parse(fs.readFileSync(
      path.join(body.initialVersion.workspaceDir, 'version.json'), 'utf8',
    ));
    expect(vjson.model).toEqual({ providerId: 'prov-test', modelId: 'test-other' });
  });

  it('body.model 保留字 default → 忽略，走教室默认 fallback', async () => {
    const created = await handleClassroomRoute(mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }), 'POST', '/academy/classroom', deps);
    const cid = (await jsonBody(created)).classroom.id;
    const r = await handleClassroomRoute(
      mkReq('POST', { name: 'D', model: { modelId: 'default' } }),
      'POST', `/academy/classroom/${cid}/student`, deps,
    );
    expect(r.status).toBe(201);
    const body = await jsonBody(r);
    const vjson = JSON.parse(fs.readFileSync(
      path.join(body.initialVersion.workspaceDir, 'version.json'), 'utf8',
    ));
    expect(vjson.model).toEqual({ providerId: 'prov-test', modelId: 'test-chat' });
  });

  it('教室配 defaultModel + body.model 缺省 → version.json 用教室默认（fallback 链中间档）', async () => {
    // 教室配 defaultModel 指向 test-other（区别于 app 默认 test-chat）
    const created = await handleClassroomRoute(
      mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-other' } }),
      'POST', '/academy/classroom', deps,
    );
    const cid = (await jsonBody(created)).classroom.id;
    // 建学生不传 body.model → 应 fallback 教室 defaultModel（test-other），不是 app 默认（test-chat）
    const r = await handleClassroomRoute(
      mkReq('POST', { name: 'Eve' }),
      'POST', `/academy/classroom/${cid}/student`, deps,
    );
    expect(r.status).toBe(201);
    const body = await jsonBody(r);
    const vjson = JSON.parse(fs.readFileSync(
      path.join(body.initialVersion.workspaceDir, 'version.json'), 'utf8',
    ));
    expect(vjson.model).toEqual({ providerId: 'prov-test', modelId: 'test-other' });
  });

  it('body.model 显式 → 覆盖教室 defaultModel（fallback 链最高优先级）', async () => {
    // 教室配 defaultModel = test-other，body.model 显式给 test-chat → 用 test-chat
    const created = await handleClassroomRoute(
      mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-other' } }),
      'POST', '/academy/classroom', deps,
    );
    const cid = (await jsonBody(created)).classroom.id;
    const r = await handleClassroomRoute(
      mkReq('POST', { name: 'F', model: { modelId: 'test-chat' } }),
      'POST', `/academy/classroom/${cid}/student`, deps,
    );
    expect(r.status).toBe(201);
    const body = await jsonBody(r);
    const vjson = JSON.parse(fs.readFileSync(
      path.join(body.initialVersion.workspaceDir, 'version.json'), 'utf8',
    ));
    expect(vjson.model).toEqual({ providerId: 'prov-test', modelId: 'test-chat' });
  });

  it('body.model 保留字 + 教室 defaultModel → fallback 教室默认（保留字不短路中间档）', async () => {
    const created = await handleClassroomRoute(
      mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-other' } }),
      'POST', '/academy/classroom', deps,
    );
    const cid = (await jsonBody(created)).classroom.id;
    // body.model='default' 保留字 → 跳过这一档 → fallback 教室 defaultModel（而非 app 默认）
    const r = await handleClassroomRoute(
      mkReq('POST', { name: 'G', model: { modelId: 'default' } }),
      'POST', `/academy/classroom/${cid}/student`, deps,
    );
    expect(r.status).toBe(201);
    const body = await jsonBody(r);
    const vjson = JSON.parse(fs.readFileSync(
      path.join(body.initialVersion.workspaceDir, 'version.json'), 'utf8',
    ));
    expect(vjson.model).toEqual({ providerId: 'prov-test', modelId: 'test-other' });
  });

  it('教室 defaultModel 保留字 → 建教室 400 model_not_configured（v0.0.230 无 app 默认兜底）', async () => {
    // 教室 defaultModel = 'default'（保留字等同未配）→ head session resolve 跑空 → 400
    const created = await handleClassroomRoute(
      mkReq('POST', { name: 'cls', defaultModel: { modelId: 'default' } }),
      'POST', '/academy/classroom', deps,
    );
    expect(created.status).toBe(400);
    expect((await jsonBody(created)).error).toBe('model_not_configured');
  });

  it('无可用 provider（教室默认不可解析）→ 400 model_not_configured', async () => {
    // 先建带 defaultModel 的教室（此时 provider 启用，创建成功）
    const created = await handleClassroomRoute(
      mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }),
      'POST', '/academy/classroom', deps,
    );
    expect(created.status).toBe(201);
    const cid = (await jsonBody(created)).classroom.id;
    // 再禁用 provider（学生播种 fallback 链跑空：教室默认不可用 + 无 app 兜底）
    appConfig.set('providers', 'prov-test', { id: 'prov-test', enabled: false, models: [] });
    const r = await handleClassroomRoute(
      mkReq('POST', { name: 'E' }), 'POST', `/academy/classroom/${cid}/student`, deps,
    );
    expect(r.status).toBe(400);
    const body = await jsonBody(r);
    expect(body.error).toBe('model_not_configured');
    expect(body.detail).toContain('默认模型');
  });

  it('教室不存在 → 404 classroom_not_found', async () => {
    const r = await handleClassroomRoute(mkReq('POST', { name: 'x' }), 'POST', `/academy/classroom/${ulid()}/student`, deps);
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error).toBe('classroom_not_found');
  });

  it('缺 name → 400 invalid_input', async () => {
    const created = await handleClassroomRoute(mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }), 'POST', '/academy/classroom', deps);
    const cid = (await jsonBody(created)).classroom.id;
    const r = await handleClassroomRoute(mkReq('POST', {}), 'POST', `/academy/classroom/${cid}/student`, deps);
    expect(r.status).toBe(400);
  });
});

describe('AcademyClassroomHandler — GET /academy/classroom/:cid/student', () => {
  it('教室不存在 → 404 classroom_not_found', async () => {
    const r = await handleClassroomRoute(mkReq('GET'), 'GET', `/academy/classroom/${ulid()}/student`, deps);
    expect(r.status).toBe(404);
  });

  it('已建学生 → 列表', async () => {
    const created = await handleClassroomRoute(mkReq('POST', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }), 'POST', '/academy/classroom', deps);
    const cid = (await jsonBody(created)).classroom.id;
    // 建一个学生
    await handleClassroomRoute(mkReq('POST', { name: 'a' }), 'POST', `/academy/classroom/${cid}/student`, deps);
    const r = await handleClassroomRoute(mkReq('GET'), 'GET', `/academy/classroom/${cid}/student`, deps);
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.items.length).toBe(1);
    expect(body.items[0].name).toBe('a');
  });
});

describe('AcademyClassroomHandler — 路由 404 / 405', () => {
  it('路径不匹配 → 404', async () => {
    const r = await handleClassroomRoute(mkReq('GET'), 'GET', '/academy/other', deps);
    expect(r.status).toBe(404);
  });

  it('method 不允许 → 405 + Allow 头', async () => {
    const r = await handleClassroomRoute(mkReq('DELETE'), 'DELETE', '/academy/classroom', deps);
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET,POST');
  });
});
