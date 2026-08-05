/**
 * session handlers 单测 — CRUD + messages 分页 + POST messages → 202 + summary
 * 参考: specs/api/version_logs/v0.0.8/change_log.md §2 §3 §3.2（D2 summary）
 *       specs/api/version_logs/v0.0.12/change_log.md §3.2（移除 409 改 enqueue 排队）
 *       AT: chat/session_crud_tc1 / session_messages_pagination_tc1 / session_send_error_tc1 / session_compact_tc1
 *
 * 策略：
 *   - 真实 SessionStore（tmpdir + CompositeStore mount 4 schema）
 *   - 真实 AppConfigService/AppConfigService（PUT providers 配 mock provider）
 *   - 真实 PluginManager（bootstrapBuiltinPlugins 出，含 anthropic impl）
 *   - fake AgentManager（vi.fn 拦 enqueue/activate，避免跑真 loop）
 *
 * 校验点：
 *   - POST /session → 201 + Session（title 默认"新会话"）；非法 providerId → 400
 *   - GET /session → 200 + {items}；GET /session/:id → 200/404；DELETE → 204/404
 *   - GET /session/:id/messages → 分页（limit/beforeId/hasMore）
 *   - POST /session/:id/messages → 202 + {runId}；content 空 → 400；404；
 *     [v0.0.12] already_running → 202 + 当前 runId（enqueue 排队，移除 409）
 *   - GET /session/:id/summary → 200 + {summary:null}（无 summary 时）
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { CompositeStore } from '../persistence/composite';
import { FsCrudStore } from '../persistence/fs-store';
import { SessionStore } from '../agent/session-store';
import { AppConfigService } from '../config/app-config-service';
import { ulid } from '../config/ulid';
import { bootstrapBuiltinPlugins } from '../bootstrap';
import {
  handleSessionCollection,
  handleSessionItem,
  handleSessionSummary,
  type SessionHandlerDeps,
} from '../handlers/session';
import { handleSessionMessages } from '../handlers/session-messages';
// v0.0.15 T5：ActivateResult 已废弃（activate 改返 AgentRun）；fake AgentManager 直接构造 AgentRun-like 对象
import type { MessageInput } from '../message/types';

let tmpRoot: string;
let store: SessionStore;
let appConfig: AppConfigService;
let devConfig: AppConfigService;
let deps: SessionHandlerDeps;

/**
 * fake AgentManager：enqueue/activate 用 vi.fn 拦截。
 * v0.0.15 T5：activate 改返 AgentRun（不再是 ActivateResult 联合）。
 * fakeRun 直接构造一个最小 AgentRun-like 对象（含 state + runId + promise 字段足够 handler 读取）。
 */
function makeFakeAgentManager(fakeRun: { state: string; runId: string }) {
  // [v0.0.31] user POST 收敛 deliverTo（返 AgentRun）；activate/deliverTo 共用同一 fake AgentRun 对象
  const fakeAgentRun = {
    sessionId: 'fake',
    runKind: 'main',
    runId: fakeRun.runId,
    groupKey: 'session_id:fake_amt:main',
    state: fakeRun.state,
    // state='error' 时 handler void promise.catch；其他 state 不 await promise，可占位
    promise: Promise.resolve({ answer: '', usage: {}, stopReason: 'no_tool_call', rounds: 0 }),
    result: undefined,
  };
  return {
    enqueue: vi.fn(async () => ['enq-1']),
    activate: vi.fn(async () => fakeAgentRun),
    deliverTo: vi.fn(async () => fakeAgentRun),
    subscribe: vi.fn(),
    activeLoopCount: vi.fn(() => 0),
  };
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-session-h-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  appConfig = new AppConfigService({ root: tmpRoot });
  devConfig = new AppConfigService({ root: tmpRoot });
  // bootstrap 用独立子目录，避免与测试 store 共用同一 fs root（FsCrudStore 缓存冲突）
  const bs = await bootstrapBuiltinPlugins(mkdtempSync(join(tmpdir(), 'rocky-session-bs-')));
  deps = {
    store,
    agentManager: makeFakeAgentManager({
      // v0.0.15 T5：state='running'（旧 'activated'）
      state: 'running',
      runId: 'run-fresh',
    }) as never,
    appConfig,
    pluginManager: bs.pluginManager,
    // v0.0.16：手动 compact 端点需 contextEngine（bs 持完整装配实例）
    contextEngine: bs.contextEngine,
    dataDir: tmpRoot,
  };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 写一个 mock provider（llm-client-factory ROCKY_TEST_MOCK_LLM 时生效） */
function seedProvider() {
  appConfig.set('providers', 'prov-mock', {
    id: 'prov-mock',
    name: 'anthropic_compatible',
    label: 'Mock',
    baseUrl: 'https://api.anthropic.com',
    credentials: { key: 'sk-test' },
    enabled: true,
    models: [
      {
        modelId: 'claude-mock-1',
        protocolId: 'anthropic_messages',
        contextWindow: 200000,
        maxOutputTokens: 4096,
        label: 'Mock 1',
        enabled: true,
      },
    ],
  });
}

function req(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://127.0.0.1:3700${path}`, init);
}

async function jsonBody(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

// ============================================================
// Session CRUD
// ============================================================

describe('session handlers — CRUD', () => {
  it('POST /session → 201 + Session，title 默认"新会话"', async () => {
    const r = await handleSessionCollection(req('POST', '/session', {}), 'POST', deps);
    expect(r.status).toBe(201);
    const body = await jsonBody(r);
    expect(body.title).toBe('新会话');
    expect(body.status).toBe('active');
    expect(typeof body.id).toBe('string');
  });

  it('POST /session 自定义 title 生效', async () => {
    const r = await handleSessionCollection(
      req('POST', '/session', { title: '我的会话' }),
      'POST',
      deps,
    );
    expect(r.status).toBe(201);
    expect((await jsonBody(r)).title).toBe('我的会话');
  });

  it('POST /session 非法 providerId → 400', async () => {
    const r = await handleSessionCollection(
      req('POST', '/session', { providerId: 'nope' }),
      'POST',
      deps,
    );
    expect(r.status).toBe(400);
  });

  it('POST /session 合法 providerId → 201', async () => {
    seedProvider();
    const r = await handleSessionCollection(
      req('POST', '/session', { providerId: 'prov-mock', modelId: 'claude-mock-1' }),
      'POST',
      deps,
    );
    expect(r.status).toBe(201);
  });

  it('GET /session → 200 + {items}（按 updatedAt desc）', async () => {
    await handleSessionCollection(req('POST', '/session', { title: 'a' }), 'POST', deps);
    await handleSessionCollection(req('POST', '/session', { title: 'b' }), 'POST', deps);
    const r = await handleSessionCollection(req('GET', '/session'), 'GET', deps);
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.items).toHaveLength(2);
  });

  it('GET /session/:id → 200/404', async () => {
    const created = await jsonBody(
      await handleSessionCollection(req('POST', '/session'), 'POST', deps),
    );
    const ok = await handleSessionItem(req('GET', `/session/${created.id}`), 'GET', created.id, deps);
    expect(ok.status).toBe(200);

    const notFound = await handleSessionItem(req('GET', '/session/nope'), 'GET', 'nope', deps);
    expect(notFound.status).toBe(404);
  });

  it('DELETE /session/:id → 204（级联），404 不存在', async () => {
    const created = await jsonBody(
      await handleSessionCollection(req('POST', '/session'), 'POST', deps),
    );
    const ok = await handleSessionItem(req('DELETE', `/session/${created.id}`), 'DELETE', created.id, deps);
    expect(ok.status).toBe(204);

    // 再 GET → 404
    const after = await handleSessionItem(req('GET', `/session/${created.id}`), 'GET', created.id, deps);
    expect(after.status).toBe(404);

    const notFound = await handleSessionItem(req('DELETE', '/session/nope'), 'DELETE', 'nope', deps);
    expect(notFound.status).toBe(404);
  });

  it('POST 非法 JSON → 400', async () => {
    const r = await handleSessionCollection(
      new Request('http://127.0.0.1:3700/session', {
        method: 'POST',
        body: 'not-json',
      }),
      'POST',
      deps,
    );
    expect(r.status).toBe(400);
  });
});

// ============================================================
// v0.0.9 PUT /session/:id —— 手动选 model 持久化
// ============================================================

describe('session handlers — PUT /session/:id（v0.0.9）', () => {
  beforeEach(() => {
    seedProvider();
  });

  it('PUT 存 providerId/modelId → 200 + Session 含字段', async () => {
    const created = await jsonBody(
      await handleSessionCollection(req('POST', '/session'), 'POST', deps),
    );
    const r = await handleSessionItem(
      req('PUT', `/session/${created.id}`, {
        providerId: 'prov-mock',
        modelId: 'claude-mock-1',
      }),
      'PUT',
      created.id,
      deps,
    );
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.providerId).toBe('prov-mock');
    expect(body.modelId).toBe('claude-mock-1');

    // GET 验证持久
    const got = await handleSessionItem(req('GET', `/session/${created.id}`), 'GET', created.id, deps);
    const gotBody = await jsonBody(got);
    expect(gotBody.providerId).toBe('prov-mock');
    expect(gotBody.modelId).toBe('claude-mock-1');
  });

  it('PUT 只改 title → 200，model 字段不受影响', async () => {
    const created = await jsonBody(
      await handleSessionCollection(req('POST', '/session'), 'POST', deps),
    );
    // 先 PUT model
    await handleSessionItem(
      req('PUT', `/session/${created.id}`, { providerId: 'prov-mock', modelId: 'claude-mock-1' }),
      'PUT',
      created.id,
      deps,
    );
    // 再 PUT title（不带 model）
    const r = await handleSessionItem(
      req('PUT', `/session/${created.id}`, { title: '新标题' }),
      'PUT',
      created.id,
      deps,
    );
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.title).toBe('新标题');
    // model 字段保留
    expect(body.providerId).toBe('prov-mock');
    expect(body.modelId).toBe('claude-mock-1');
  });

  it('PUT 非法 providerId → 400', async () => {
    const created = await jsonBody(
      await handleSessionCollection(req('POST', '/session'), 'POST', deps),
    );
    const r = await handleSessionItem(
      req('PUT', `/session/${created.id}`, { providerId: 'nope', modelId: 'x' }),
      'PUT',
      created.id,
      deps,
    );
    expect(r.status).toBe(400);
  });

  it('PUT 非法 modelId（provider 命中但无此 model）→ 400', async () => {
    const created = await jsonBody(
      await handleSessionCollection(req('POST', '/session'), 'POST', deps),
    );
    const r = await handleSessionItem(
      req('PUT', `/session/${created.id}`, {
        providerId: 'prov-mock',
        modelId: 'nope-model',
      }),
      'PUT',
      created.id,
      deps,
    );
    expect(r.status).toBe(400);
  });

  it('PUT 不存在 session → 404', async () => {
    const r = await handleSessionItem(
      req('PUT', '/session/nope', { title: 'x' }),
      'PUT',
      'nope',
      deps,
    );
    expect(r.status).toBe(404);
  });

  it('PUT 非法 JSON → 400', async () => {
    const created = await jsonBody(
      await handleSessionCollection(req('POST', '/session'), 'POST', deps),
    );
    const r = await handleSessionItem(
      new Request(`http://127.0.0.1:3700/session/${created.id}`, {
        method: 'PUT',
        body: 'not-json',
      }),
      'PUT',
      created.id,
      deps,
    );
    expect(r.status).toBe(400);
  });
});

// ============================================================
// Messages 分页
// ============================================================

describe('session handlers — messages 分页', () => {
  it('GET /session/:id/messages 404 session 不存在', async () => {
    const r = await handleSessionMessages(req('GET', '/session/nope/messages'), 'GET', 'nope', deps);
    expect(r.status).toBe(404);
  });

  it('GET /session/:id/messages 默认 limit=50；hasMore 正确', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    // 写 60 条
    for (let i = 0; i < 60; i++) {
      const m: MessageInput = {
        id: ulid(),
        sessionId: sid,
        role: 'user',
        content: [{ type: 'text', text: `m${i}` }],
      };
      await store.appendMessages(sid, [m]);
    }
    const r = await handleSessionMessages(req('GET', `/session/${sid}/messages`), 'GET', sid, deps);
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.items).toHaveLength(50);
    expect(body.hasMore).toBe(true);
    // 升序：items[0] 是第 10 条
    expect(body.items[0].content[0].text).toBe('m10');
  });

  it('GET /session/:id/messages?limit=10&beforeId=... 续载前 10 条', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const id = ulid();
      ids.push(id);
      await store.appendMessages(sid, [
        { id, sessionId: sid, role: 'user', content: [{ type: 'text', text: `m${i}` }] },
      ]);
    }
    // 取 ids[15] 之前 limit=10：window = ids[0..14]（15 条）→ 取末尾 10 条 = ids[5..14]
    const beforeId = ids[15]!;
    const r = await handleSessionMessages(
      req('GET', `/session/${sid}/messages?limit=10&beforeId=${beforeId}`),
      'GET',
      sid,
      deps,
    );
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.items).toHaveLength(10);
    expect(body.hasMore).toBe(true);
  });

  it('GET /session/:id/messages?limit=0 → 400（必须 [1,200]）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const r = await handleSessionMessages(
      req('GET', `/session/${sid}/messages?limit=0`),
      'GET',
      sid,
      deps,
    );
    expect(r.status).toBe(400);
  });

  it('GET /session/:id/messages?limit=201 → 400', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const r = await handleSessionMessages(
      req('GET', `/session/${sid}/messages?limit=201`),
      'GET',
      sid,
      deps,
    );
    expect(r.status).toBe(400);
  });

  it('GET /session/:id/messages 附所属 run 的 stopReason/runError（join runs；无 runId / run 未结束不附）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    // run1 正常结束；run2 error 结束（带 RunErrorInfo）；run3 进行中（无 stopReason）
    const run1 = ulid();
    const run2 = ulid();
    const run3 = ulid();
    await store.createRun({ id: run1, sessionId: sid });
    await store.updateRun(sid, run1, { status: 'completed', stopReason: 'no_tool_call' });
    await store.createRun({ id: run2, sessionId: sid });
    await store.updateRun(sid, run2, {
      status: 'failed',
      stopReason: 'error',
      error: {
        errorCategory: 'PROVIDER_OVERLOADED' as never,
        displayReason: '服务过载',
        errorDetail: 'raw 529',
      },
    });
    await store.createRun({ id: run3, sessionId: sid });
    await store.appendMessages(sid, [
      { id: ulid(), sessionId: sid, role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { id: ulid(), sessionId: sid, role: 'assistant', content: [{ type: 'text', text: 'a1' }], runId: run1 },
      { id: ulid(), sessionId: sid, role: 'assistant', content: [{ type: 'text', text: 'a2' }], runId: run2 },
      { id: ulid(), sessionId: sid, role: 'assistant', content: [{ type: 'text', text: 'a3' }], runId: run3 },
    ]);
    const r = await handleSessionMessages(req('GET', `/session/${sid}/messages`), 'GET', sid, deps);
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.items).toHaveLength(4);
    // user 消息（无 runId）不附
    expect(body.items[0].stopReason).toBeUndefined();
    // run1：stopReason 附上，无 error 不附 runError
    expect(body.items[1].stopReason).toBe('no_tool_call');
    expect(body.items[1].runError).toBeUndefined();
    // run2：error 类附 stopReason + runError（RunErrorInfo 原样）
    expect(body.items[2].stopReason).toBe('error');
    expect(body.items[2].runError).toEqual({
      errorCategory: 'PROVIDER_OVERLOADED',
      displayReason: '服务过载',
      errorDetail: 'raw 529',
    });
    // run3 进行中（无 stopReason）不附
    expect(body.items[3].stopReason).toBeUndefined();
  });
});

// ============================================================
// POST messages → 202 / 400 / 404（v0.0.12：already_running 也返 202 enqueue 排队）
// ============================================================

describe('session handlers — POST messages', () => {
  beforeEach(() => {
    process.env.ROCKY_TEST_MOCK_LLM = '1';
  });
  afterEach(() => {
    delete process.env.ROCKY_TEST_MOCK_LLM;
  });

  it('POST /session/:id/messages → 202 + {runId}（请求体省略 provider 用 app_config 默认）', async () => {
    seedProvider();
    const sid = ulid();
    await store.createSession({ id: sid });
    const r = await handleSessionMessages(
      req('POST', `/session/${sid}/messages`, { content: '你好' }),
      'POST',
      sid,
      deps,
    );
    expect(r.status).toBe(202);
    const body = await jsonBody(r);
    expect(body.runId).toBe('run-fresh');
    // [v0.0.31] user POST 收敛 deliverTo（不再裸 enqueue+activate）
    expect(deps.agentManager.deliverTo).toHaveBeenCalledTimes(1);
  });

  it('POST content 空 → 400', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const r = await handleSessionMessages(
      req('POST', `/session/${sid}/messages`, { content: '' }),
      'POST',
      sid,
      deps,
    );
    expect(r.status).toBe(400);
  });

  it('POST session 不存在 → 404', async () => {
    const r = await handleSessionMessages(
      req('POST', `/session/nope/messages`, { content: 'hi' }),
      'POST',
      'nope',
      deps,
    );
    expect(r.status).toBe(404);
  });

  // v0.0.158：body override（providerId/modelId）整删——前端不再传，后端收到静默忽略（不 400、不解析、不落 session）。
  //   旧断言「不命中 → 400」已不适用；新行为 = 忽略 body.providerId，走正常路径（session 无持久 model +
  //   deliverTo 被 mock → 202）。resolve 真实行为由 model-resolver.test.ts + AT 覆盖。
  it('POST providerId 不命中 → 202（v0.0.158 body override 已删，收到静默忽略不 400）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const r = await handleSessionMessages(
      req('POST', `/session/${sid}/messages`, {
        content: 'hi',
        providerId: 'nope',
      }),
      'POST',
      sid,
      deps,
    );
    expect(r.status).toBe(202);
  });

  it('POST activate 返 already_running → 202 + 当前 runId（v0.0.12 enqueue 排队，design §3.2）', async () => {
    seedProvider();
    const sid = ulid();
    await store.createSession({ id: sid });
    // 替 deps.agentManager 为返现有 AgentRun（state='running'，模拟 running 中再发消息场景）
    deps.agentManager = makeFakeAgentManager({
      state: 'running',
      runId: 'run-running',
    }) as never;
    const r = await handleSessionMessages(
      req('POST', `/session/${sid}/messages`, { content: 'hi' }),
      'POST',
      sid,
      deps,
    );
    // v0.0.12：移除 409 改 enqueue 排队 → 返 202 + 当前 running runId
    expect(r.status).toBe(202);
    const body = await jsonBody(r);
    expect(body.runId).toBe('run-running');
  });

  // v0.0.9：请求体不带 provider/model 时，用 session 持久值解析（路径 E）
  it('POST 不带 providerId/modelId + session 持久有 modelId → 202（用 session 持久 model）', async () => {
    seedProvider();
    const sid = ulid();
    await store.createSession({ id: sid, providerId: 'prov-mock', modelId: 'claude-mock-1' });
    const r = await handleSessionMessages(
      req('POST', `/session/${sid}/messages`, { content: 'hi' }),
      'POST',
      sid,
      deps,
    );
    expect(r.status).toBe(202);
    // [v0.0.31] user POST 收敛 deliverTo
    expect(deps.agentManager.deliverTo).toHaveBeenCalledTimes(1);
  });

  // v0.0.9：请求体优先于 session 持久（请求体 providerId 覆盖 session）
  it('POST 带请求体 providerId 覆盖 session 持久（请求体 > session）', async () => {
    seedProvider();
    const sid = ulid();
    await store.createSession({ id: sid, providerId: 'session-only', modelId: 'x' });
    const r = await handleSessionMessages(
      req('POST', `/session/${sid}/messages`, {
        content: 'hi',
        providerId: 'prov-mock',
        modelId: 'claude-mock-1',
      }),
      'POST',
      sid,
      deps,
    );
    expect(r.status).toBe(202);
  });

  // [v0.0.89 工作块 ③] session.providerId 不再被 handler 校验（resolver 只读 modelId，
  //   跨 provider 反查；providerId 字段 vestigial，仅做调试/历史 back-compat）。
  //   旧测试「session 持久 providerId 失效 → 400」已废（resolver 不读 session.providerId）。
  //   新行为：handler 不校验 session.providerId；body.providerId 仍校验命中（back-compat）。
  //   session.modelId='x' 不命中任何 provider 的 model → 走 default_models.chat fallback
  //   （本测试未配 default_models，但 deliverTo 被 mock，resolve 在 mock 内不触发 → 202）。
  it('POST 无请求体 + session 持久 providerId 失效 → 不再 400（resolver 不读 providerId）', async () => {
    seedProvider();
    const sid = ulid();
    await store.createSession({ id: sid, providerId: 'session-deleted', modelId: 'x' });
    const r = await handleSessionMessages(
      req('POST', `/session/${sid}/messages`, { content: 'hi' }),
      'POST',
      sid,
      deps,
    );
    // [v0.0.89] 新行为：handler 不校验 session.providerId；deliverTo mock 不触发 resolve → 202
    //   resolve 真实行为由 model-resolver.test.ts 单元测试 + AT api/session/model_default_resolve 验证
    expect(r.status).toBe(202);
  });
});

// ============================================================
// GET summary
// ============================================================

describe('session handlers — GET summary', () => {
  it('GET /session/:id/summary → 200 + {summary:null}（无 summary）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const r = await handleSessionSummary(req('GET', `/session/${sid}/summary`), 'GET', sid, deps);
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.summary).toBeNull();
  });

  it('GET /session/:id/summary 有 summary → 200 + 字段', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.setSummary(sid, { content: '压缩内容', summaryUpTo: 'msg-x' });
    const r = await handleSessionSummary(req('GET', `/session/${sid}/summary`), 'GET', sid, deps);
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.summary.content).toBe('压缩内容');
    expect(body.summary.summaryUpTo).toBe('msg-x');
  });

  it('GET /session/:id/summary session 不存在 → 404', async () => {
    const r = await handleSessionSummary(req('GET', '/session/nope/summary'), 'GET', 'nope', deps);
    expect(r.status).toBe(404);
  });
});
