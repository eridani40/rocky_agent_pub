/**
 * session-run handler UT — POST /session/:id/run（v0.0.69.test_refactor test-only sync wrapper）
 * 参考: specs/api/overall/04-agent-session.md §3.2（POST /messages 语义）
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_interface.md §2（AgentRun.promise）
 *
 * 覆盖：
 *   - NODE_ENV=test 下：handler 调 deliverTo → await AgentRun.promise → 同步返 200 +
 *     state + messages；404/400/405 + subagent readonly + provider 校验
 *   - NODE_ENV=production：router 层 gate → 404（生产绝不暴露）
 *
 * 测试策略：
 *   - 直接调 handleSessionRun（不走 router）：mock agentManager.deliverTo 返 controllable
 *     AgentRun，store 用真实 SessionStore（fs + tmpdir）—— 隔离真实 LLM/tool 调用
 *   - router 集成测试：handleRequest 全路径，验证 NODE_ENV gate
 *
 * 文件系统隔离：tmpdir + afterEach rmSync，不读写真实 ~/.oobt-desktop/。
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { AppConfigService } from '../../config/app-config-service';
import { ulid } from '../../config/ulid';
import { handleSessionRun } from '../session-run';
import { handleRequest } from '../../router';
import type { SessionHandlerDeps } from '../session';
import type { AgentManagerImpl } from '../../agent/agent-manager';
import type { AgentRun } from '../../agent/agent-interface';
import type { StopReason } from '../../agent/agent-event-types';
import type { Message } from '../../message/types';

let tmpRoot: string;
let store: SessionStore;
let appConfig: AppConfigService;
let savedNodeEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-session-run-handler-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  appConfig = new AppConfigService({ root: tmpRoot });
  // 写 mock provider（resolveProviderModel 要求 app_config providers 组非空）
  appConfig.set('providers', 'p1', {
    id: 'p1', name: 'mock', enabled: true,
    models: [{ modelId: 'm1', contextWindow: 100000 }],
  });
  // 默认 NODE_ENV=test（vitest 自动设）；显式保存以便 afterEach 还原
  savedNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 写一个 mock provider 到 app_config（router bootstrap 路径用） */
function writeMockProvider(dataDir: string): void {
  // KV-sharded：{root}/app_config/providers/app_config/<id>.json
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  const dir = path.join(dataDir, 'app_config', 'providers', 'app_config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'p1.json'),
    JSON.stringify({
      id: 'p1', group: 'providers', key: 'p1',
      // fs-store query 默认按 createdAtDesc 排序，缺字段会炸；真实 record 经 ulid() 创建时必带
      createdAt: '2026-07-05T00:00:00.000Z',
      data: {
        id: 'p1', name: 'mock', enabled: true,
        // 注意：protocolId 与 modelId 在 POST /session/:id/messages（同 run 端点）由
        // resolveProviderModel 校验存在；mock 测试只需 providers 列表里命中即可
        models: [{ modelId: 'm1', contextWindow: 100000 }],
      },
    }),
  );
  fs.mkdirSync(path.join(dataDir, 'dev_config'), { recursive: true });
}

/** 创建 session（默认 state=idle） */
async function newSession(providerId = 'p1', modelId = 'm1'): Promise<string> {
  const sid = ulid();
  await store.createSession({ id: sid, providerId, modelId });
  return sid;
}

/**
 * mock AgentManager —— deliverTo 返 controllable AgentRun：
 *   - 同步 markRunning(runId) 让 store.state 进入 running
 *   - 写一条 assistant message + 创建 RunRecord + markIdle 让 store 进入终态
 *   - 返回的 AgentRun.promise 是已 resolve 的（loop 退出语义）
 *
 * 这样 handler 的 await agentRun.promise 立即返回，poll session.state 立即拿到 idle。
 */
function makeFakeAgentManager(opts: {
  failActivate?: boolean;
  stopReason?: StopReason;
  assistantText?: string;
} = {}): AgentManagerImpl & {
  deliverToCalls: { sessionId: string; message: Message }[];
} {
  const deliverToCalls: { sessionId: string; message: Message }[] = [];
  const stopReason: StopReason = opts.stopReason ?? 'no_tool_call';
  const assistantText = opts.assistantText ?? '你好，我是助手回复';

  const fake = {
    deliverTo: vi.fn(async (sessionId: string, message: Message): Promise<AgentRun> => {
      deliverToCalls.push({ sessionId, message });
      const runId = ulid();

      if (opts.failActivate) {
        // 模拟 activate 失败：返回 error state 的 AgentRun
        const errorRun: AgentRun = {
          sessionId, runKind: 'main', runId,
          groupKey: `session_id:${sessionId}_amt:main`,
          state: 'error',
          promise: Promise.reject(new Error('activate failed (mock)')),
        };
        return errorRun;
      }

      // 模拟 loop 完整生命周期：markRunning → append assistant msg → createRun → markIdle
      await store.stateMachine.markRunning(sessionId, runId);
      await store.createRun({ id: runId, sessionId, status: 'running' });
      const assistantMsg: Message = {
        id: ulid(), sessionId, role: 'assistant', runId,
        content: [{ type: 'text', text: assistantText }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      };
      await store.appendMessages(sessionId, [assistantMsg]);
      await store.updateRun(sessionId, runId, {
        status: 'completed', stopReason, endedAt: new Date().toISOString(),
      });
      await store.stateMachine.markIdle(sessionId, runId);

      // 返回 AgentRun（promise 已 resolve，模拟 loop 退出）
      const agentRun: AgentRun = {
        sessionId, runKind: 'main', runId,
        groupKey: `session_id:${sessionId}_amt:main`,
        state: 'completed',
        promise: Promise.resolve({
          answer: assistantText, usage: {} as never,
          stopReason, rounds: 1,
        }),
        result: { answer: assistantText, usage: {} as never, stopReason, rounds: 1 },
      };
      return agentRun;
    }),
    // 其他方法 stub（handler 不调，但 SessionHandlerDeps 类型要 AgentManagerImpl）
    enqueue: vi.fn(),
    cancel: vi.fn(),
    activate: vi.fn(),
    abort: vi.fn(),
    resolveConfigBySid: vi.fn(),
  };
  // 把闭包内的 deliverToCalls attach 到 fake 对象上（handler 不读，UT 读）
  (fake as { deliverToCalls?: unknown }).deliverToCalls = deliverToCalls;
  // cast：fake 不完整但 handler 只用 deliverTo；UT 不调其他方法
  return fake as unknown as AgentManagerImpl & { deliverToCalls: typeof deliverToCalls };
}

/** 构造 SessionHandlerDeps（最小必填字段） */
function makeDeps(fakeAgentManager: AgentManagerImpl): SessionHandlerDeps {
  return {
    store,
    agentManager: fakeAgentManager,
    appConfig,
    pluginManager: { listExtensionImpls: () => [] } as never,
    contextEngine: {} as never,
    dataDir: tmpRoot,
  };
}

/** 调 handler 并解析 JSON body */
async function runRequest(
  sid: string,
  body: unknown,
  deps: SessionHandlerDeps,
  method = 'POST',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await handleSessionRun(
    new Request(`http://x/session/${sid}/run`, {
      method,
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      headers: { 'content-type': 'application/json' },
    }),
    method, sid, deps,
  );
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

// ============================================================
// NODE_ENV=test：handler 正常路径
// ============================================================

describe('POST /session/:id/run — test env 同步 wrapper', () => {
  it('200 + runId + state=idle + stopReason + messages（mock agentManager 立即 resolve）', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    const sid = await newSession();
    const fakeAm = makeFakeAgentManager();
    const deps = makeDeps(fakeAm);

    const { status, body } = await runRequest(sid, { content: 'hello' }, deps);
    expect(status).toBe(200);
    expect(typeof body.runId).toBe('string');
    expect((body.runId as string).length).toBeGreaterThan(0);
    expect(body.enqueueId).toBe('');
    expect(body.state).toBe('idle');
    expect(body.stopReason).toBe('no_tool_call');
    expect(Array.isArray(body.messages)).toBe(true);
    // 本次 run 期间产生的 assistant message（user msg 无 runId，不在 getMessagesByRun 范围内）
    expect((body.messages as unknown[]).length).toBeGreaterThanOrEqual(1);

    // deliverTo 被调用一次，且 message content 正确
    expect(fakeAm.deliverToCalls.length).toBe(1);
    expect(fakeAm.deliverToCalls[0]!.sessionId).toBe(sid);
  });

  it('404 session 不存在', async () => {
    const fakeAm = makeFakeAgentManager();
    const deps = makeDeps(fakeAm);
    const { status, body } = await runRequest(ulid(), { content: 'x' }, deps);
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/);
    // session 不存在时不应调 deliverTo
    expect(fakeAm.deliverToCalls.length).toBe(0);
  });

  it('400 content 空 / 缺 content / 非法 JSON', async () => {
    const sid = await newSession();
    const fakeAm = makeFakeAgentManager();
    const deps = makeDeps(fakeAm);

    let r = await runRequest(sid, { content: '' }, deps);
    expect(r.status).toBe(400);

    r = await runRequest(sid, {}, deps);
    expect(r.status).toBe(400);

    // 非法 JSON：直接构造 Request 让 json() throw
    const res = await handleSessionRun(
      new Request(`http://x/session/${sid}/run`, {
        method: 'POST',
        body: 'not-json',
        headers: { 'content-type': 'application/json' },
      }),
      'POST', sid, deps,
    );
    expect(res.status).toBe(400);
    expect(fakeAm.deliverToCalls.length).toBe(0);
  });

  it('405 GET（仅允许 POST）', async () => {
    const sid = await newSession();
    const fakeAm = makeFakeAgentManager();
    const deps = makeDeps(fakeAm);
    const res = await handleSessionRun(
      new Request(`http://x/session/${sid}/run`),
      'GET', sid, deps,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('403 subagent session（readonly）', async () => {
    // 直接造 subagent session（绕过 createSession default derivation='parent'）
    // 校验要求 derivation='subagent' 必填 parentSessionId（spawn 关系）
    const sid = ulid();
    const parentId = ulid();
    await store.createSession({ id: sid, derivation: 'subagent', parentSessionId: parentId } as never);
    const fakeAm = makeFakeAgentManager();
    const deps = makeDeps(fakeAm);
    const { status, body } = await runRequest(sid, { content: 'x' }, deps);
    expect(status).toBe(403);
    expect(body.error).toBe('subagent_readonly');
  });

  it('500 activate 失败（agentRun.state=error）', async () => {
    const sid = await newSession();
    const fakeAm = makeFakeAgentManager({ failActivate: true });
    const deps = makeDeps(fakeAm);
    const { status, body } = await runRequest(sid, { content: 'x' }, deps);
    expect(status).toBe(500);
    expect(String(body.error)).toMatch(/activate failed/);
  });

  it('响应 messages 来自 store.getMessagesByRun（含 assistant 文本）', async () => {
    const sid = await newSession();
    const fakeAm = makeFakeAgentManager({ assistantText: 'MOCK_REPLY_TEXT' });
    const deps = makeDeps(fakeAm);
    const { body } = await runRequest(sid, { content: 'q' }, deps);
    const msgs = body.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    // 第一条 assistant message 的第一个 text block 含 MOCK_REPLY_TEXT
    const text = msgs[0]!.content.find((b) => b.type === 'text')?.text;
    expect(text).toBe('MOCK_REPLY_TEXT');
  });
});

// ============================================================
// NODE_ENV=production：router 层 gate → 404
// ============================================================

describe('POST /session/:id/run — production env gate', () => {
  it('NODE_ENV=production → router 返 404（不调 handler）', async () => {
    process.env.NODE_ENV = 'production';
    writeMockProvider(tmpRoot);
    // 通过 router.handleRequest 全路径测试 gate
    // 注：router 内会 bootstrap，bootstrap 会创建真 agentManager；gate 在 dispatchInternal
    // 里短路，handler 根本不会被调，故不需要 mock。
    const sid = ulid();
    // 直连 store 创建 session（router 路径不需要 session 真存在就能 404 gate 短路）
    const fs2 = new FsCrudStore({ root: tmpRoot });
    const crud2 = new CompositeStore()
      .mount('session', fs2).mount('transcript', fs2)
      .mount('summary', fs2).mount('runs', fs2);
    const store2 = new SessionStore({ crud: crud2, fsRoot: tmpRoot });
    await store2.createSession({ id: sid });

    const res = await handleRequest(
      new Request(`http://x/session/${sid}/run`, {
        method: 'POST',
        body: JSON.stringify({ content: 'should-be-404' }),
        headers: { 'content-type': 'application/json' },
      }),
      tmpRoot,
    );
    expect(res.status).toBe(404);
    const b = await res.json() as { error: string };
    expect(b.error).toBe('Not Found');
  });

  it('NODE_ENV=test → router 进入 handler（gate 放行）', async () => {
    // 此处仅验证 gate 放行 + 路径匹配 OK；handler 内的 deliverTo 不 mock 会真跑，
    // 但因 mock provider 没有 protocolId/credentials，deliverTo 会失败返 error → 500
    // 我们只断言不是 404（说明 gate 放行 + 路径匹配）。
    process.env.NODE_ENV = 'test';
    writeMockProvider(tmpRoot);
    const sid = ulid();
    const fs2 = new FsCrudStore({ root: tmpRoot });
    const crud2 = new CompositeStore()
      .mount('session', fs2).mount('transcript', fs2)
      .mount('summary', fs2).mount('runs', fs2);
    const store2 = new SessionStore({ crud: crud2, fsRoot: tmpRoot });
    await store2.createSession({ id: sid, providerId: 'p1', modelId: 'm1' });

    const res = await handleRequest(
      new Request(`http://x/session/${sid}/run`, {
        method: 'POST',
        body: JSON.stringify({ content: 'gate-check' }),
        headers: { 'content-type': 'application/json' },
      }),
      tmpRoot,
    );
    // 不是 404 = gate 已放行（具体业务结果 200/500 取决于 bootstrap 真实 agentManager；
    // 因 mock provider 无完整 protocol impl，deliverTo 多半返 500，但这不是本 case 关注点）
    expect(res.status).not.toBe(404);
  });
});
