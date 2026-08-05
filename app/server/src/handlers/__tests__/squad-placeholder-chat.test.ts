/**
 * 单测（白盒）—— studio chat 入口（v0.0.33.2 拆 403 后）+ bizType 隔离（GET /session 过滤）
 * 参考: specs/api/overall/11-squad.md §4.1（bizType 过滤）
 *       specs/tech/version_logs/v0.0.33.2/change_log.md §2.A（拆 studio 403 + 保留 subagent 403）
 *       specs/tech/squad/[P1]session_config_studio.md §6（bizType 隔离三处保留）
 *
 * 覆盖：
 *   - [v0.0.33.2] POST /messages 对 studio session（squad/leader/mate）→ 不再 403，调 deliverTo（接 AgentLoop）
 *   - POST /messages 对 subagent session → 仍 403 subagent_readonly（只读不变量保留）
 *   - POST /messages 对 playground session → 正常走（mock AgentManager.deliverTo 被调）
 *   - GET /session?bizType=playground → 不含 studio session（缺省同）
 *   - GET /session?biz=studio → 含 studio session
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleSessionMessages } from '../session-messages';
import { handleSessionCollection, type SessionHandlerDeps } from '../session';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { AppConfigService } from '../../config/app-config-service';
import { bootstrapBuiltinPlugins } from '../../bootstrap';
import { ulid } from '../../config/ulid';

let tmpRoot: string;
let store: SessionStore;
let deps: SessionHandlerDeps;
let deliverToMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'placeholder-chat-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fsEngine)
    .mount('transcript', fsEngine)
    .mount('summary', fsEngine)
    .mount('runs', fsEngine);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  const appConfig = new AppConfigService({ root: tmpRoot });
  const devConfig = new AppConfigService({ root: tmpRoot });
  // 写一个 mock provider（POST /messages 校验 provider 用）
  appConfig.set('providers', 'prov-mock', {
    id: 'prov-mock', name: 'mock', enabled: true,
    models: [{ modelId: 'm1', name: 'm1' }],
  } as never);
  const bs = await bootstrapBuiltinPlugins(fs.mkdtempSync(path.join(os.tmpdir(), 'ph-bs-')));

  // fake AgentManager：deliverTo 用 vi.fn 拦截（验证占位 chat 是否调到）
  deliverToMock = vi.fn(async () => ({
    sessionId: 'fake', runKind: 'main', runId: 'run-1', groupKey: 'g',
    state: 'running',
    promise: Promise.resolve({}),
    result: undefined,
  }));
  deps = {
    store,
    agentManager: { deliverTo: deliverToMock, enqueue: vi.fn(async () => ['e']) } as never,
    appConfig,
    pluginManager: bs.pluginManager,
    contextEngine: bs.contextEngine,
    dataDir: tmpRoot,
  };
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function postReq(sid: string, content: string): Request {
  return new Request(`http://test/session/${sid}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

function getReq(query = ''): Request {
  return new Request(`http://test/session${query}`, { method: 'GET' });
}

/** 读响应 JSON（r.json() 返 unknown，helper 返 any 便于断言） */
async function jsonBody(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

describe('v0.0.33.2 拆 403 后 studio chat 入口（POST /messages 接 AgentLoop）', () => {
  it('leader session（bizType=studio）POST /messages → 202 + 调 deliverTo（不再 403）', async () => {
    // 建 studio session（type=leader bizType=studio，squadId/memberId 用合法 ULID）
    const sid = ulid();
    await store.createSession({
      id: sid, role: 'leader', biz: 'studio', squadId: ulid(), memberId: ulid(),
      workspaceDir: path.join(tmpRoot, 'ws', sid),
    });
    const r = await handleSessionMessages(postReq(sid, 'hi'), 'POST', sid, deps);
    expect(r.status).toBe(202);
    // 关键：进 AgentManager（deliverTo 被调）——拆 403 后 studio session 接 AgentLoop
    expect(deliverToMock).toHaveBeenCalled();
  });

  it('mate session（bizType=studio）POST /messages → 202 + 调 deliverTo（不再 403）', async () => {
    const sid = ulid();
    await store.createSession({
      id: sid, role: 'mate', biz: 'studio', squadId: ulid(), memberId: ulid(),
      workspaceDir: path.join(tmpRoot, 'ws', sid),
    });
    const r = await handleSessionMessages(postReq(sid, 'hi'), 'POST', sid, deps);
    expect(r.status).toBe(202);
    expect(deliverToMock).toHaveBeenCalled();
  });

  it('squadChat session（type=squad bizType=studio）POST /messages → 202 + 调 deliverTo（不再 403）', async () => {
    const sid = ulid();
    await store.createSession({
      id: sid, role: 'squad', biz: 'studio', squadId: ulid(),
      workspaceDir: path.join(tmpRoot, 'ws', sid),
    });
    const r = await handleSessionMessages(postReq(sid, 'hi'), 'POST', sid, deps);
    expect(r.status).toBe(202);
    expect(deliverToMock).toHaveBeenCalled();
  });

  it('subagent session POST /messages → 仍 403 subagent_readonly（只读不变量保留）', async () => {
    // subagent 只读语义（api §4.2）：拆 studio 403 不动 subagent 403——保证 subagent 消息流始终来自 parent（a2a）
    const sid = ulid();
    await store.createSession({
      id: sid, derivation: 'subagent', biz: 'studio', role: 'leader', squadId: ulid(),
      parentSessionId: ulid(),
      workspaceDir: path.join(tmpRoot, 'ws', sid),
    });
    const r = await handleSessionMessages(postReq(sid, 'hi'), 'POST', sid, deps);
    expect(r.status).toBe(403);
    expect((await jsonBody(r)).error).toBe('subagent_readonly');
    expect(deliverToMock).not.toHaveBeenCalled();
  });

  it('playground session（无 bizType）POST /messages → 正常走（调 deliverTo）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid, workspaceDir: path.join(tmpRoot, 'ws', sid) });
    const r = await handleSessionMessages(postReq(sid, 'hi'), 'POST', sid, deps);
    expect(r.status).toBe(202);
    expect(deliverToMock).toHaveBeenCalled();
  });
});

describe('T6 bizType 隔离（GET /session 过滤）', () => {
  it('缺省 → 仅返 playground（不含 studio session）', async () => {
    // 建 playground session + studio session
    const pgSid = ulid();
    const stSid = ulid();
    await store.createSession({ id: pgSid, workspaceDir: path.join(tmpRoot, 'ws', pgSid) });
    await store.createSession({
      id: stSid, role: 'leader', biz: 'studio', squadId: ulid(), memberId: ulid(),
      workspaceDir: path.join(tmpRoot, 'ws', stSid),
    });

    const r = await handleSessionCollection(getReq(), 'GET', deps);
    const body = await jsonBody(r);
    const ids = body.items.map((s: { id: string }) => s.id);
    expect(ids).toContain(pgSid);
    expect(ids).not.toContain(stSid); // studio 被过滤
  });

  it('?bizType=playground → 同缺省（不含 studio）', async () => {
    const pgSid = ulid();
    const stSid = ulid();
    await store.createSession({ id: pgSid, workspaceDir: path.join(tmpRoot, 'ws', pgSid) });
    await store.createSession({
      id: stSid, biz: 'studio', role: 'squad', squadId: ulid(),
      workspaceDir: path.join(tmpRoot, 'ws', stSid),
    });
    const r = await handleSessionCollection(getReq('?bizType=playground'), 'GET', deps);
    const ids = (await jsonBody(r)).items.map((s: { id: string }) => s.id);
    expect(ids).toContain(pgSid);
    expect(ids).not.toContain(stSid);
  });

  it('?biz=studio → 仅返 studio session', async () => {
    const pgSid = ulid();
    const stSid = ulid();
    await store.createSession({ id: pgSid, workspaceDir: path.join(tmpRoot, 'ws', pgSid) });
    await store.createSession({
      id: stSid, biz: 'studio', role: 'squad', squadId: ulid(),
      workspaceDir: path.join(tmpRoot, 'ws', stSid),
    });
    const r = await handleSessionCollection(getReq('?bizType=studio'), 'GET', deps);
    const ids = (await jsonBody(r)).items.map((s: { id: string }) => s.id);
    expect(ids).toContain(stSid);
    expect(ids).not.toContain(pgSid); // playground 被过滤
  });

  it('无 bizType 字段的历史 session 视为 playground', async () => {
    const oldSid = ulid();
    await store.createSession({ id: oldSid, workspaceDir: path.join(tmpRoot, 'ws', oldSid) });
    // 缺省 = playground，历史 session 应出现
    const r = await handleSessionCollection(getReq(), 'GET', deps);
    const ids = (await jsonBody(r)).items.map((s: { id: string }) => s.id);
    expect(ids).toContain(oldSid);
  });
});
