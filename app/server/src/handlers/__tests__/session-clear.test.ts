/**
 * session-clear handler UT — POST /session/:id/clear（v0.0.16 T4）
 * 参考: specs/api/overall/04-agent-session.md §8（POST /session/:id/clear 契约）
 *       specs/tech/agent/session/[P0]session_clear.md §5（并发处理 caller 职责）
 *
 * 覆盖：
 *   - 200 + { ok: true, session }（同步原子；state=idle + 内容清空）
 *   - 并发编排：running → manager.abort（mock）→ clear；summaryTask=running → markSummaryFailed + clearReplay
 *   - force 语义：force=true 跳过 abort；force=false（默认）走 abort
 *   - 404 session 不存在
 *   - 405 非 POST + Allow: POST
 *
 * 测试策略：
 *   - 直接调 handleSessionClear（不走 router），注入真实 SessionStore（fs + tmpdir）+ mock
 *     agentManager（abort / clearReplay），断言 HTTP 响应 + abort 是否被调 + clearReplay 是否被调。
 *   - 不走 router 全路径：bootstrap reconcileOnStartup 会清扫 running/interrupting 预设状态，
 *     干扰并发编排测试；直接调 handler 避开 reconcile，预设状态稳定。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../agent/session-store';
import { SessionTaskLock } from '../../agent/session-task-lock';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { handleSessionClear } from '../session-clear';
import type { SessionHandlerDeps } from '../session';
import type { AgentManagerImpl } from '../../agent/agent-manager';
import type { AbortResult } from '../../agent/agent-interface';

let tmpRoot: string;
let store: SessionStore;
// v0.0.55：taskLock 替代 store.stateMachine.markSummary*（subsumes summaryTask CAS）
let taskLock: SessionTaskLock;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-session-clear-handler-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  taskLock = new SessionTaskLock();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 创建 session（默认 state=idle, summaryTask=idle） */
async function newSession(): Promise<string> {
  const sid = ulid();
  await store.createSession({ id: sid, title: 'test' });
  return sid;
}

/** mock AgentManager —— abort / clearReplay 记录调用 */
function makeMockAgentManager(opts: { accepted?: boolean } = {}): AgentManagerImpl & {
  abortCalls: { sid: string; runId: string; runKind: string }[];
  clearReplayCalls: { sid: string; runKind: string }[];
} {
  const abortCalls: { sid: string; runId: string; runKind: string }[] = [];
  const clearReplayCalls: { sid: string; runKind: string }[] = [];
  const accepted = opts.accepted ?? true;
  const fake = {
    abort: vi.fn(async (sid: string, runId: string, runKind: string): Promise<AbortResult> => {
      abortCalls.push({ sid, runId, runKind });
      // 模拟 abort 4 步完成：state → interrupted + currentRunId=null
      // （真实 abortRun 会 markInterrupted；mock 简化为不动 session，让 clearSession 强制重置）
      if (accepted) {
        try {
          // 模拟 markInterrupted（仅当当前 state=interrupting；这里 mock 简化不做）
        } catch {
          // 忽略
        }
      }
      return accepted ? { accepted: true } : { accepted: false, reason: 'no_active_controller' };
    }),
    clearReplay: vi.fn((sid: string, runKind: string): void => {
      clearReplayCalls.push({ sid, runKind });
    }),
  };
  return Object.assign(fake as unknown as AgentManagerImpl, { abortCalls, clearReplayCalls });
}

/** 构造 deps：mock agentManager + 真实 store + 空 appConfig/pluginManager/devConfig/contextEngine + taskLock */
function makeDeps(mockAgentManager: AgentManagerImpl): SessionHandlerDeps {
  return {
    store,
    agentManager: mockAgentManager,
    appConfig: {} as never,
    pluginManager: {} as never,
    contextEngine: {} as never,
    // v0.0.55：注入 taskLock（subsumes summaryTask CAS，clear handler 调 markFailed）
    taskLock,
    dataDir: tmpRoot,
  };
}

/** 解析 Response body 为 JSON */
async function body(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

// ============================================================
// 200 + { ok: true, session } — idle 直接 clear（最简路径）
// ============================================================

describe('POST /session/:id/clear — 200 idle 路径', () => {
  it('state=idle + summaryTask=idle → 200 {ok:true,session} + session.state=idle + 内容清空', async () => {
    const sid = await newSession();
    // 写一些内容（验证 clear 后清空）
    await store.appendMessages(sid, [{
      id: ulid(), sessionId: sid, role: 'user', content: [{ type: 'text', text: 'hello' }],
    }]);
    const am = makeMockAgentManager();
    const deps = makeDeps(am);

    const res = await handleSessionClear(
      new Request(`http://x/session/${sid}/clear`, { method: 'POST' }),
      'POST',
      sid,
      deps,
    );
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.ok).toBe(true);
    expect(b.session.id).toBe(sid);
    expect(b.session.state).toBe('idle');
    expect(b.session.running).toBe(false);
    expect(b.session.currentRunId).toBeNull();
    // 内容清空
    const msgs = await store.getMessages(sid);
    expect(msgs.items).toEqual([]);
    // idle 路径不调 abort
    expect(am.abortCalls).toHaveLength(0);
  });

  it('body 空 → force 默认 false（idle 时无差异，但走 force 分支判定）', async () => {
    const sid = await newSession();
    const am = makeMockAgentManager();
    const deps = makeDeps(am);

    const res = await handleSessionClear(
      new Request(`http://x/session/${sid}/clear`, {
        method: 'POST',
        body: '{}',
      }),
      'POST',
      sid,
      deps,
    );
    expect(res.status).toBe(200);
  });
});

// ============================================================
// 并发编排：running → abort → clear
// ============================================================

describe('POST /session/:id/clear — running → abort → clear（spec §5.1）', () => {
  it('state=running → 调 manager.abort(sid, currentRunId, "current")', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    const am = makeMockAgentManager();
    const deps = makeDeps(am);

    const res = await handleSessionClear(
      new Request(`http://x/session/${sid}/clear`, { method: 'POST' }),
      'POST',
      sid,
      deps,
    );
    expect(res.status).toBe(200);
    // abort 被调（runKind=current + runId=预设 runId）
    expect(am.abortCalls).toHaveLength(1);
    expect(am.abortCalls[0]!.sid).toBe(sid);
    expect(am.abortCalls[0]!.runId).toBe(runId);
    expect(am.abortCalls[0]!.runKind).toBe('main');
    // clear 后 state=idle（force 重置）
    const after = await store.getSession(sid);
    expect(after?.state).toBe('idle');
  });

  it('state=interrupting → 调 manager.abort（currentRunId=null 时 runId 空串）', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    await store.stateMachine.markInterrupting(sid, runId);
    // interrupting 时 currentRunId=null
    const before = await store.getSession(sid);
    expect(before?.state).toBe('interrupting');
    expect(before?.currentRunId).toBeNull();

    const am = makeMockAgentManager();
    const deps = makeDeps(am);

    const res = await handleSessionClear(
      new Request(`http://x/session/${sid}/clear`, { method: 'POST' }),
      'POST',
      sid,
      deps,
    );
    expect(res.status).toBe(200);
    // abort 被调（runId=currentRunId ?? '' = ''）
    expect(am.abortCalls).toHaveLength(1);
    expect(am.abortCalls[0]!.runId).toBe('');
  });

  it('force=true → 跳过 abort（state=running 不调 abort，直接 clear）', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    const am = makeMockAgentManager();
    const deps = makeDeps(am);

    const res = await handleSessionClear(
      new Request(`http://x/session/${sid}/clear`, {
        method: 'POST',
        body: JSON.stringify({ force: true }),
      }),
      'POST',
      sid,
      deps,
    );
    expect(res.status).toBe(200);
    // force=true → abort 不被调
    expect(am.abortCalls).toHaveLength(0);
    // 仍清空 + state=idle
    const after = await store.getSession(sid);
    expect(after?.state).toBe('idle');
  });
});

// ============================================================
// 并发编排：lock=running → markFailed + clearReplay（v0.0.55 subsumes summaryTask CAS）
// ============================================================

describe('POST /session/:id/clear — lock=running → markFailed + clearReplay（§5.2；v0.0.55）', () => {
  it('lock=running → markFailed("cleared") + agentManager.clearReplay(sid, "summary")', async () => {
    const sid = await newSession();
    // v0.0.55：lock CAS（subsumes 旧 markSummaryRunning）
    taskLock.acquire(sid, 'compact', 'compact:1');
    const am = makeMockAgentManager();
    const deps = makeDeps(am);

    const res = await handleSessionClear(
      new Request(`http://x/session/${sid}/clear`, { method: 'POST' }),
      'POST',
      sid,
      deps,
    );
    expect(res.status).toBe(200);
    // v0.0.55：markFailed 后 lock=failed（内存 only，clearSession 不再 reset 此字段）
    expect(taskLock.getState(sid, 'compact').status).toBe('failed');
    expect(taskLock.getState(sid, 'compact').error).toBe('cleared');
    // clearReplay(summary) 被调
    expect(am.clearReplayCalls).toContainEqual({ sid, runKind: 'summary' });
  });

  it('lock=idle → 不调 clearReplay(summary)', async () => {
    const sid = await newSession();
    const am = makeMockAgentManager();
    const deps = makeDeps(am);

    await handleSessionClear(
      new Request(`http://x/session/${sid}/clear`, { method: 'POST' }),
      'POST',
      sid,
      deps,
    );
    expect(am.clearReplayCalls).toHaveLength(0);
  });
});

// ============================================================
// 404 / 405
// ============================================================

describe('POST /session/:id/clear — 404 / 405', () => {
  it('404 session 不存在', async () => {
    const am = makeMockAgentManager();
    const res = await handleSessionClear(
      new Request(`http://x/session/${ulid()}/clear`, { method: 'POST' }),
      'POST',
      ulid(),
      makeDeps(am),
    );
    expect(res.status).toBe(404);
    const b = await body(res);
    expect(b.error).toMatch(/not found/);
  });

  it('405 非 POST（GET）+ Allow: POST', async () => {
    const sid = await newSession();
    const am = makeMockAgentManager();
    const res = await handleSessionClear(
      new Request(`http://x/session/${sid}/clear`, { method: 'GET' }),
      'GET',
      sid,
      makeDeps(am),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});
