/**
 * academy-student-skill handler 单测 — 版本 skill 单文件读/写端点（api 18-academy §1.11）
 * 参考: specs/api/overall/18-academy.md §1.11.1/§1.11.2/§1.11.3 + §7.1（分发顺序）
 *
 * 覆盖：
 *   - 路由分发顺序：/version/:vid/skill/:name/file 排在 /version/:vid 之前（不落兜底 404）
 *   - GET：正常文本 / 缺 path 400 / 越界 400 / 非法 skillName 400 / 文件 404 / skill 404 / 三层 404
 *   - PATCH：formal 覆写成功 + **AGENTS.md 与 version.json 未被改动**（数据丢失防回归护栏）
 *   - PATCH：process 409 process_version_readonly / 拒新建 404 / 拒 binary 400 / 越界 400
 *
 * Mock 策略：真实 AcademyStore + SessionStore（FsCrudStore tmpdir），真实文件系统。
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
let deps: AcademyHandlerDeps;
/** 测试夹具：formal 0.0 版本 + 其 workspaceDir 内一个 demo skill */
let cid: string;
let sid: string;
let vid: string;
let wsDir: string;

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-student-skill-'));
  academyStore = new AcademyStore({ root: tmpRoot });
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fsEngine)
    .mount('transcript', fsEngine)
    .mount('summary', fsEngine)
    .mount('runs', fsEngine);
  const sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  const appConfig = new AppConfigService({ root: tmpRoot });
  appConfig.set('providers', 'prov-test', {
    id: 'prov-test', name: 'T', enabled: true, kind: 'mock',
    credential: {}, models: [{ modelId: 'test-chat', enabled: true }],
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

  // 建教室 + 学生（自动建 formal 0.0 版本）；v0.0.230 起创建教室必填默认模型
  const clsResp = await handleClassroomRoute(
    mkReq('POST', '/academy/classroom', { name: 'cls', defaultModel: { providerId: 'prov-test', modelId: 'test-chat' } }), 'POST', '/academy/classroom', deps,
  );
  cid = (await jsonBody(clsResp)).classroom.id;
  const stuResp = await handleClassroomRoute(
    mkReq('POST', `/academy/classroom/${cid}/student`, { name: 'Alice' }),
    'POST', `/academy/classroom/${cid}/student`, deps,
  );
  const stuBody = await jsonBody(stuResp);
  sid = stuBody.student.id;
  vid = stuBody.initialVersion.id;
  wsDir = stuBody.initialVersion.workspaceDir;
  seedDemoSkill(wsDir);
  // AGENTS.md 夹具（数据丢失防回归断言的对照物）
  fs.writeFileSync(path.join(wsDir, 'AGENTS.md'), '# ORIGINAL PROMPT', 'utf8');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 在版本 workspace 里造 demo skill（SKILL.md + 附属 py + binary png） */
function seedDemoSkill(ws: string): void {
  const dir = path.join(ws, '.rocky/skills/demo');
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\nname: demo\ndescription: 演示\n---\n\nBODY_V1\n', 'utf8',
  );
  fs.writeFileSync(path.join(dir, 'references/guide.py'), 'print(1)', 'utf8');
  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
}

async function jsonBody(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

function mkReq(method: string, url: string, body?: unknown): Request {
  return new Request(`http://test${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** 打 skill file 端点（经 handleStudentRoute 二次分发，与生产链路一致） */
function skillFileUrl(name = 'demo', query = ''): string {
  return `/academy/classroom/${cid}/student/${sid}/version/${vid}/skill/${name}/file${query}`;
}
async function callSkillFile(method: string, url: string, body?: unknown): Promise<Response> {
  return handleStudentRoute(mkReq(method, url, body), method, url.split('?')[0]!, deps);
}

describe('handleStudentRoute 分发顺序（§7.1 — 新 pattern 必须先于 /version/:vid）', () => {
  it('GET .../version/:vid/skill/:name/file 命中新 handler，不落兜底 404', async () => {
    const r = await callSkillFile('GET', skillFileUrl('demo', '?path=SKILL.md'));
    expect(r.status).toBe(200);
    expect((await jsonBody(r)).path).toBe('SKILL.md');
  });

  it('既有 GET .../version/:vid 未被新 pattern 抢跑（skills 为 SkillSummary）', async () => {
    const p = `/academy/classroom/${cid}/student/${sid}/version/${vid}`;
    const r = await handleStudentRoute(mkReq('GET', p), 'GET', p, deps);
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.content.skills.length).toBe(1);
    expect(body.content.skills[0].name).toBe('demo');
    expect(body.content.skills[0].fileCount).toBe(3);
    expect(body.content.skills[0].files.find((f: any) => f.path === 'SKILL.md').hash)
      .toMatch(/^[0-9a-f]{12}$/);
  });

  it('method 不允许 → 405 + allow: GET,PATCH', async () => {
    const r = await callSkillFile('DELETE', skillFileUrl('demo', '?path=SKILL.md'));
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET,PATCH');
  });
});

describe('GET .../skill/:name/file（§1.11.1）', () => {
  it('文本文件 → 200 + content/truncated/binary', async () => {
    const r = await callSkillFile('GET', skillFileUrl('demo', '?path=references/guide.py'));
    expect(r.status).toBe(200);
    expect(await jsonBody(r)).toEqual({
      path: 'references/guide.py', content: 'print(1)', truncated: false, binary: false,
    });
  });

  it('binary 文件 → 200 + binary=true + content 空', async () => {
    const r = await callSkillFile('GET', skillFileUrl('demo', '?path=logo.png'));
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b.binary).toBe(true);
    expect(b.content).toBe('');
  });

  it('缺 path → 400 invalid path', async () => {
    const r = await callSkillFile('GET', skillFileUrl('demo'));
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error).toBe('invalid path');
  });

  it('path 越界 → 400 invalid path', async () => {
    const r = await callSkillFile('GET', skillFileUrl('demo', '?path=../../../AGENTS.md'));
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error).toBe('invalid path');
  });

  it('非法 skillName（大写/穿越）→ 400 invalid path', async () => {
    const r = await callSkillFile('GET', skillFileUrl('Demo', '?path=SKILL.md'));
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error).toBe('invalid path');
  });

  it('文件不存在 → 404 Not Found', async () => {
    const r = await callSkillFile('GET', skillFileUrl('demo', '?path=nope.md'));
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error).toBe('Not Found');
  });

  it('skill 目录不存在 → 404 skill_not_found', async () => {
    const r = await callSkillFile('GET', skillFileUrl('other-skill', '?path=SKILL.md'));
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error).toBe('skill_not_found');
  });

  it('version 不存在 → 404 version_not_found（三层校验复用 resolveVersion）', async () => {
    const url = `/academy/classroom/${cid}/student/${sid}/version/${ulid()}/skill/demo/file?path=SKILL.md`;
    const r = await callSkillFile('GET', url);
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error).toBe('version_not_found');
  });
});

describe('PATCH .../skill/:name/file（§1.11.2 — formal only + 最小写面）', () => {
  it('formal 覆写成功 → 200 + 内容落盘，且 AGENTS.md / version.json 未被改动', async () => {
    const agentsBefore = fs.readFileSync(path.join(wsDir, 'AGENTS.md'), 'utf8');
    const versionJsonBefore = fs.readFileSync(path.join(wsDir, 'version.json'), 'utf8');

    const r = await callSkillFile('PATCH', skillFileUrl('demo'), {
      path: 'SKILL.md',
      content: '---\nname: demo\ndescription: 演示\n---\n\nBODY_V2\n',
    });
    expect(r.status).toBe(200);
    expect(await jsonBody(r)).toEqual({ ok: true, path: 'SKILL.md' });
    expect(fs.readFileSync(path.join(wsDir, '.rocky/skills/demo/SKILL.md'), 'utf8'))
      .toContain('BODY_V2');

    // 数据丢失防回归：skill 写路径绝不经 writeVersionDirFiles（AGENTS.md/version.json 全量重写）
    expect(fs.readFileSync(path.join(wsDir, 'AGENTS.md'), 'utf8')).toBe(agentsBefore);
    expect(fs.readFileSync(path.join(wsDir, 'version.json'), 'utf8')).toBe(versionJsonBefore);
  });

  it('process 版本 → 409 process_version_readonly 且文件未变', async () => {
    // 造 process 版本（独立 workspace + 同名 skill）
    const procWs = path.join(tmpRoot, 'proc-ws');
    fs.mkdirSync(procWs, { recursive: true });
    seedDemoSkill(procWs);
    const procVersion = await academyStore.putVersion({
      id: ulid(), studentId: sid, classroomId: cid, versionLabel: '0.0.1',
      type: 'process', parentFormalVersionId: vid, taskSeq: 1, roundNumber: 1,
      workspaceDir: procWs, status: 'active',
    });
    const url = `/academy/classroom/${cid}/student/${sid}/version/${procVersion.id}/skill/demo/file`;
    const r = await callSkillFile('PATCH', url, { path: 'SKILL.md', content: 'HACKED' });
    expect(r.status).toBe(409);
    expect((await jsonBody(r)).error).toBe('process_version_readonly');
    expect(fs.readFileSync(path.join(procWs, '.rocky/skills/demo/SKILL.md'), 'utf8'))
      .toContain('BODY_V1');
  });

  it('目标不存在 → 404 Not Found（不隐式创建）', async () => {
    const r = await callSkillFile('PATCH', skillFileUrl('demo'), { path: 'new.md', content: 'x' });
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error).toBe('Not Found');
    expect(fs.existsSync(path.join(wsDir, '.rocky/skills/demo/new.md'))).toBe(false);
  });

  it('binary 目标 → 400 binary_not_writable 且字节未变', async () => {
    const png = path.join(wsDir, '.rocky/skills/demo/logo.png');
    const before = fs.readFileSync(png);
    const r = await callSkillFile('PATCH', skillFileUrl('demo'), { path: 'logo.png', content: 'x' });
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error).toBe('binary_not_writable');
    expect(fs.readFileSync(png)).toEqual(before);
  });

  it('path 越界 → 400 invalid path 且 AGENTS.md 未被写', async () => {
    const r = await callSkillFile('PATCH', skillFileUrl('demo'), {
      path: '../../../AGENTS.md', content: 'HACKED',
    });
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error).toBe('invalid path');
    expect(fs.readFileSync(path.join(wsDir, 'AGENTS.md'), 'utf8')).toBe('# ORIGINAL PROMPT');
  });

  it('缺 path / content 非字符串 → 400', async () => {
    const noPath = await callSkillFile('PATCH', skillFileUrl('demo'), { content: 'x' });
    expect(noPath.status).toBe(400);
    expect((await jsonBody(noPath)).error).toBe('invalid path');
    const badContent = await callSkillFile('PATCH', skillFileUrl('demo'), { path: 'SKILL.md' });
    expect(badContent.status).toBe(400);
    expect((await jsonBody(badContent)).error).toBe('invalid_input');
  });

  it('skill 目录不存在 → 404 skill_not_found', async () => {
    const r = await callSkillFile('PATCH', skillFileUrl('other-skill'), { path: 'SKILL.md', content: 'x' });
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error).toBe('skill_not_found');
  });
});
