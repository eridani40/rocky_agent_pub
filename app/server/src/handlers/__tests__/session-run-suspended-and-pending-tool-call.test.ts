/**
 * [v0.0.101 T4 O9 + F] session-run await suspended + GET /pending-tool-call + POST /messages tool_reply UT
 * 参考: specs/tech/version_logs/v0.0.101/change_plan.md 模块 F（API 契约）+ 开放点 O9
 *       specs/api/version_logs/v0.0.101.change_log.md
 *
 * 覆盖：
 *   - POST /session/:id/run await 终态含 suspended（O9）：tool_pending→suspended 算 run 终态返
 *   - GET /session/:id/pending-tool-call：peek 队首只读 / 空队列 200 + null / 404 / 405
 *   - POST /session/:id/messages tool_reply 分支：构造 sender.source='tool_reply' → deliverTo
 *
 * 测试策略：
 *   - mock AgentManager.deliverTo 返 controllable AgentRun（loop 退出 + markSuspended 让 store=suspended）
 *   - store 用真实 SessionStore（fs + tmpdir）；pendingToolCalls 用 store.setPendingToolCalls 落盘
 *
 * 文件系统隔离：tmpdir + afterEach rmSync。
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
import { handleSessionPendingToolCall } from '../session-pending-tool-call';
import { handleSessionMessages } from '../session-messages';
import type { SessionHandlerDeps } from '../session';
import type { AgentManagerImpl } from '../../agent/agent-manager';
import type { AgentRun } from '../../agent/agent-interface';
import type { PendingToolCall } from '../../tools/types';

let tmpRoot: string;
let store: SessionStore;
let appConfig: AppConfigService;
let savedNodeEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-t4-suspended-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  appConfig = new AppConfigService({ root: tmpRoot });
  appConfig.set('providers', 'p1', {
    id: 'p1', name: 'mock', enabled: true,
    models: [{ modelId: 'm1', contextWindow: 100000 }],
  });
  savedNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function newSession(): Promise<string> {
  const sid = ulid();
  await store.createSession({ id: sid, providerId: 'p1', modelId: 'm1' });
  return sid;
}

function mkPending(toolCallId = 'tc-1'): PendingToolCall {
  return {
    sessionId: '', runId: '', toolCallId,
    toolName: 'ask-question',
    handleType: 'direct_result', subState: 'need_feedback',
    data: { questions: [] },
    resultMessageId: 'm-tool', resultBlockIndex: 0,
    status: 'pending',
  };
}

/**
 * mock AgentManager：deliverTo 模拟 markSuspended 路径（loop 退出 + state=suspended）。
 * 写一个 stopReason='tool_pending' 的 RunRecord + markSuspended 让 store.state=suspended。
 * 返回 AgentRun & { enqueueId }（对齐 managerDeliverTo 返回签名）。
 */
function makeFakeAgentManagerSuspended(): AgentManagerImpl & {
  deliverToCalls: { sessionId: string; message: unknown }[];
} {
  const deliverToCalls: { sessionId: string; message: unknown }[] = [];
  const fake = {
    deliverTo: vi.fn(async (sessionId: string, message: unknown): Promise<AgentRun & { enqueueId: string }> => {
      deliverToCalls.push({ sessionId, message });
      const runId = ulid();
      await store.stateMachine.markRunning(sessionId, runId);
      await store.createRun({ id: runId, sessionId, status: 'running' });
      const pending = mkPending();
      await store.setPendingToolCalls(sessionId, [pending]);
      await store.updateRun(sessionId, runId, {
        status: 'completed', stopReason: 'tool_pending', endedAt: new Date().toISOString(),
      });
      await store.stateMachine.markSuspended(sessionId, runId);
      return {
        sessionId, runKind: 'main', runId,
        groupKey: `session_id:${sessionId}_amt:main`,
        state: 'completed',
        promise: Promise.resolve({
          answer: '', usage: {} as never, stopReason: 'tool_pending', rounds: 1,
        }),
        result: { answer: '', usage: {} as never, stopReason: 'tool_pending', rounds: 1 },
        enqueueId: 'eq-1',
      } as AgentRun & { enqueueId: string };
    }),
    enqueue: vi.fn(),
    cancel: vi.fn(),
    activate: vi.fn(),
    abort: vi.fn(),
    resolveConfigBySid: vi.fn(),
  };
  (fake as { deliverToCalls?: unknown }).deliverToCalls = deliverToCalls;
  return fake as unknown as AgentManagerImpl & { deliverToCalls: typeof deliverToCalls };
}

/** mock AgentManager 普通 deliverTo（user query 路径，markIdle 终态） */
function makeFakeAgentManagerIdle(): AgentManagerImpl & {
  deliverToCalls: { sessionId: string; message: unknown }[];
} {
  const deliverToCalls: { sessionId: string; message: unknown }[] = [];
  const fake = {
    deliverTo: vi.fn(async (sessionId: string, message: unknown): Promise<AgentRun & { enqueueId: string }> => {
      deliverToCalls.push({ sessionId, message });
      const runId = ulid();
      await store.stateMachine.markRunning(sessionId, runId);
      await store.createRun({ id: runId, sessionId, status: 'running' });
      await store.updateRun(sessionId, runId, {
        status: 'completed', stopReason: 'no_tool_call', endedAt: new Date().toISOString(),
      });
      await store.stateMachine.markIdle(sessionId, runId);
      return {
        sessionId, runKind: 'main', runId,
        groupKey: `session_id:${sessionId}_amt:main`,
        state: 'completed',
        promise: Promise.resolve({
          answer: '', usage: {} as never, stopReason: 'no_tool_call', rounds: 1,
        }),
        result: { answer: '', usage: {} as never, stopReason: 'no_tool_call', rounds: 1 },
        enqueueId: 'eq-1',
      } as AgentRun & { enqueueId: string };
    }),
    enqueue: vi.fn(),
    cancel: vi.fn(),
    activate: vi.fn(),
    abort: vi.fn(),
    resolveConfigBySid: vi.fn(),
  };
  (fake as { deliverToCalls?: unknown }).deliverToCalls = deliverToCalls;
  return fake as unknown as AgentManagerImpl & { deliverToCalls: typeof deliverToCalls };
}

function makeDeps(fakeAM: AgentManagerImpl): SessionHandlerDeps {
  return {
    store, agentManager: fakeAM, appConfig,
    pluginManager: { listExtensionImpls: () => [] } as never,
    contextEngine: {} as never,
    dataDir: tmpRoot,
  };
}

async function callRun(sid: string, body: unknown, deps: SessionHandlerDeps) {
  const res = await handleSessionRun(
    new Request(`http://x/session/${sid}/run`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }), 'POST', sid, deps,
  );
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function callMessages(sid: string, body: unknown, deps: SessionHandlerDeps) {
  const res = await handleSessionMessages(
    new Request(`http://x/session/${sid}/messages`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }), 'POST', sid, deps,
  );
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function callPending(sid: string, deps: SessionHandlerDeps, method = 'GET') {
  const res = await handleSessionPendingToolCall(
    new Request(`http://x/session/${sid}/pending-tool-call`, { method }),
    method, sid, deps,
  );
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('[v0.0.101 T4 O9] POST /session/:id/run await 终态含 suspended', () => {
  it('loop 退出 stopReason=tool_pending + markSuspended → /run 返 state=suspended（不挂死）', async () => {
    const sid = await newSession();
    const fakeAM = makeFakeAgentManagerSuspended();
    const deps = makeDeps(fakeAM);

    const { status, body } = await callRun(sid, { content: 'trigger ask-question' }, deps);

    expect(status).toBe(200);
    expect(body.state).toBe('suspended');
    expect(body.stopReason).toBe('tool_pending');
    // messages 是本次 run 期间产生的（mock 没写，空数组）
    expect(Array.isArray(body.messages)).toBe(true);
  });
});

describe('[v0.0.101 T4 F] GET /session/:id/pending-tool-call', () => {
  it('有 pending：返队首 PendingToolCall（深拷贝快照）', async () => {
    const sid = await newSession();
    const pending = mkPending('tc-peek');
    await store.setPendingToolCalls(sid, [pending]);
    const deps = makeDeps(makeFakeAgentManagerIdle());

    const { status, body } = await callPending(sid, deps);

    expect(status).toBe(200);
    expect(body.pending).toMatchObject({
      toolCallId: 'tc-peek',
      toolName: 'ask-question',
      handleType: 'direct_result',
      status: 'pending',
    });
  });

  it('空队列：返 200 + pending=null（非 404）', async () => {
    const sid = await newSession();
    const deps = makeDeps(makeFakeAgentManagerIdle());

    const { status, body } = await callPending(sid, deps);

    expect(status).toBe(200);
    expect(body.pending).toBeNull();
  });

  it('session 不存在 → 404', async () => {
    const deps = makeDeps(makeFakeAgentManagerIdle());
    const { status, body } = await callPending('not-exist', deps);
    expect(status).toBe(404);
    expect(body.error).toBeTruthy();
  });

  it('非 GET → 405 + Allow: GET', async () => {
    const sid = await newSession();
    const deps = makeDeps(makeFakeAgentManagerIdle());
    const { status } = await callPending(sid, deps, 'POST');
    expect(status).toBe(405);
  });
});

describe('[v0.0.101 T4 F] POST /session/:id/messages tool_reply 分支', () => {
  it('body 含 toolReply + 队首匹配 → 构造 sender.source=tool_reply → deliverTo（202）', async () => {
    const sid = await newSession();
    // 先落盘一个 pending（让 handler peek 命中）
    const pending = mkPending('tc-submit');
    await store.setPendingToolCalls(sid, [pending]);
    const fakeAM = makeFakeAgentManagerIdle();
    const deps = makeDeps(fakeAM);

    const { status, body } = await callMessages(sid, {
      content: '', // tool_reply 分支不强制 content 非空
      toolReply: {
        toolCallId: 'tc-submit',
        handleType: 'direct_result',
        payload: { selections: { q1: ['A'] } },
      },
    }, deps);

    expect(status).toBe(202);
    expect(body.runId).toBeTruthy();
    expect(body.enqueueId).toBeTruthy();
    // deliverTo 被调一次，且 message.sender.source='tool_reply'
    const fake = fakeAM as unknown as { deliverToCalls: { message: { sender: { source: string; tool_reply: { toolCallId: string } } } }[] };
    expect(fake.deliverToCalls).toHaveLength(1);
    const msg = fake.deliverToCalls[0]!.message;
    expect(msg.sender.source).toBe('tool_reply');
    expect(msg.sender.tool_reply.toolCallId).toBe('tc-submit');
  });

  it('toolReply 但队首不匹配 → 409（INV-4 队首串行）', async () => {
    const sid = await newSession();
    // pending 队首是 tc-OTHER，但 body 发 tc-1
    await store.setPendingToolCalls(sid, [mkPending('tc-OTHER')]);
    const deps = makeDeps(makeFakeAgentManagerIdle());

    const { status, body } = await callMessages(sid, {
      content: '',
      toolReply: { toolCallId: 'tc-1', handleType: 'direct_result', payload: {} },
    }, deps);

    expect(status).toBe(409);
    expect(body.error).toMatch(/mismatch|no pending/);
  });

  it('toolReply 但队列空 → 409', async () => {
    const sid = await newSession();
    const deps = makeDeps(makeFakeAgentManagerIdle());

    const { status } = await callMessages(sid, {
      content: '',
      toolReply: { toolCallId: 'tc-1', handleType: 'direct_result', payload: {} },
    }, deps);

    expect(status).toBe(409);
  });

  it('toolReply.handleType 非法 → 400', async () => {
    const sid = await newSession();
    await store.setPendingToolCalls(sid, [mkPending('tc-1')]);
    const deps = makeDeps(makeFakeAgentManagerIdle());

    const { status } = await callMessages(sid, {
      content: '',
      toolReply: { toolCallId: 'tc-1', handleType: 'invalid' as never, payload: {} },
    }, deps);

    expect(status).toBe(400);
  });

  it('无 toolReply → 走原 user query 路径不变（content 必填非空）', async () => {
    const sid = await newSession();
    const fakeAM = makeFakeAgentManagerIdle();
    const deps = makeDeps(fakeAM);

    const { status } = await callMessages(sid, { content: 'hi' }, deps);

    expect(status).toBe(202);
    const fake = fakeAM as unknown as { deliverToCalls: { message: { sender: { source: string } } }[] };
    expect(fake.deliverToCalls).toHaveLength(1);
    expect(fake.deliverToCalls[0]!.message.sender.source).toBe('user');
  });
});
