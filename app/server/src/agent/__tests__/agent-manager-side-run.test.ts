/**
 * AgentManager.sideRun + activate 返 AgentRun 单元测试（v0.0.15 T5）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md §2 v5.1（sideRun + activate 返 AgentRun）
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_forked.md §3-§10
 *
 * 覆盖（task 验收）：
 *   - sideRun 同 (sid, runKind) 拒并发（throw already_running_in_this_mode）
 *   - sideRun 返 AgentRun（runKind/groupKey/runId/promise 字段齐全）
 *   - activate 返 AgentRun（state='running'）
 *   - activate running 时二次返同一对象引用（agentRuns map 同 key）
 *   - abort forked mode（runKind='summary'）：不走 4 步收尾（无 half-data 持久化）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../session-store';
import { ContextEngine } from '../context-engine';
import { ToolExecutionEngine } from '../../tools/engine';
import { InboxStore } from '../inbox';
import { ReplayableEventBus } from '../event-bus';
import { AgentManagerImpl } from '../agent-manager';
import { ulid } from '../../config/ulid';
import type { SessionTypePolicy } from '../session-type-policy';
import type { ResolvedSessionProfile } from '../session-type-profile-loader';
import { SessionKind } from '@app/shared';
import type { SessionConfig, ContextSnapshot } from '../context-types';
import type { Message } from '../../message/types';
import type { LlmClient } from '../../llm/client';
import type { CanonicalRequest, StreamEvent } from '../../llm/protocol';

/** summary profile mock（v0.0.204 T3：sideRun 内部 buildRunDeps 旁路 run 路径需 policy） */
function mockSummaryPolicy(): SessionTypePolicy {
  const profile: ResolvedSessionProfile = {
    id: 'playground-rocky:parent:summary',
    enabled: true,
    toolBound: [],
    toolDefinitionsSource: 'host-snapshot',
    runShape: { drainMode: 'none', backgroundPath: true, maxIterDefault: 1, touchesStateMachine: false, persistsRun: false, usagePartition: 'summary' },
    lifecycleHooks: { abortFinalize: 'none', cascadeChildren: false },
    eventChannel: { emitDefault: true },
    modelHints: { readsSquadDefault: false },
    skillSource: 'none',
    eosStop: [],
    autoNaming: false,
    preloadContext: 'none',
  };
  return {
    profile: vi.fn(() => profile),
    resolveToolSet: vi.fn(() => ({ tools: [], toolDefinitions: [], allowedTools: [] })),
  };
}

const parentKind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'main' });

/** main profile mock（activate 主对话路径用：persistsRun=true / touchesStateMachine=true / drainMode='eager'） */
function mockMainPolicy(): SessionTypePolicy {
  const profile: ResolvedSessionProfile = {
    id: 'playground-rocky:parent:main',
    enabled: true,
    toolBound: [],
    toolDefinitionsSource: 'own',
    runShape: { drainMode: 'eager', backgroundPath: false, maxIterDefault: 25, touchesStateMachine: true, persistsRun: true, usagePartition: 'current' },
    lifecycleHooks: { abortFinalize: 'four-step', cascadeChildren: true },
    eventChannel: { emitDefault: true },
    modelHints: { readsSquadDefault: false },
    skillSource: 'global-enabled',
    eosStop: [],
    autoNaming: false,
    preloadContext: 'none',
  };
  return {
    profile: vi.fn(() => profile),
    resolveToolSet: vi.fn(() => ({ tools: [], toolDefinitions: [], allowedTools: [] })),
  };
}

let tmpRoot: string;
let store: SessionStore;
let contextEngine: ContextEngine;
let toolEngine: ToolExecutionEngine;
let inbox: InboxStore;
let bus: ReplayableEventBus;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-forked-run-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  contextEngine = new ContextEngine({ store });
  toolEngine = new ToolExecutionEngine();
  inbox = new InboxStore();
  bus = new ReplayableEventBus({ replayable: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** mock LlmClient.stream：产一条 text_delta + finish（assistant message 纯文本） */
function mockStreamClient(answer: string): LlmClient {
  const streamFn = vi.fn((req: CanonicalRequest): AsyncIterable<StreamEvent> => {
    void req;
    return (async function* () {
      yield { type: 'message_start', messageId: 'm1', role: 'assistant' } as unknown as StreamEvent;
      yield { type: 'text_delta', messageId: 'm1', text: answer } as unknown as StreamEvent;
      yield { type: 'usage', usage: {} } as unknown as StreamEvent;
      yield { type: 'finish', stopReason: 'stop' } as unknown as StreamEvent;
    })();
  });
  return { stream: streamFn, call: vi.fn(), contextWindow: 100000 } as unknown as LlmClient;
}

function newConfig(sid: string, client: LlmClient): SessionConfig {
  return {
    sessionId: sid,
    systemPrompt: '',
    client,
    modelId: 'mock-model',
    kind: parentKind,
  } as SessionConfig;
}

function newSnapshot(sid: string): ContextSnapshot {
  return {
    system: { id: 'sys', sessionId: sid, role: 'system', content: [] },
    messages: [],
    inputCharCount: 0,
    contextWindowUsage: {
      systemTokens: 0, messageTokens: 0, toolTokens: 0, totalTokens: 0,
      maxOutputTokens: 20000, tokenLimit: 100000,
      remainingTokens: 100000 - 0 - 20000,
    },
    summary: null,
    tools: [],
  };
}

describe('AgentManager.sideRun — T5 新增', () => {
  it('返 AgentRun（runKind/groupKey/runId/promise 齐全）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine, sessionTypePolicy: mockSummaryPolicy(), });
    const userMessage: Message = {
      id: ulid(),
      sessionId: sid,
      role: 'user',
      content: [{ type: 'text', text: 'summary' }],
    };
    const run = await manager.sideRun({
      sessionId: sid,
      config: newConfig(sid, mockStreamClient('answer')),
      runKind: 'summary',
      snapshot: newSnapshot(sid),
      userMessage,
    });
    expect(run.sessionId).toBe(sid);
    expect(run.runKind).toBe('summary');
    expect(run.runId).toBeTruthy();
    expect(run.groupKey).toBe(`session_id:${sid}_amt:summary`);
    expect(run.state).toBe('running');
    const result = await run.promise;
    expect(result.answer).toBe('answer');
  });

  it('同 (sid, runKind) 拒并发 → throw already_running_in_this_mode', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine, sessionTypePolicy: mockSummaryPolicy(), });
    // 第一次 sideRun：用 hang stream 让 loop 不立即结束
    const hangClient: LlmClient = {
      stream: (): AsyncIterable<StreamEvent> => {
        return (async function* () {
          yield { type: 'message_start', messageId: 'm1', role: 'assistant' } as unknown as StreamEvent;
          // 不 finish，hang 住让 controller 不 cleanup
          await new Promise(() => {}); // 永远 pending
        })();
      },
      call: vi.fn(),
      contextWindow: 100000,
    } as unknown as LlmClient;
    const userMessage: Message = {
      id: ulid(),
      sessionId: sid,
      role: 'user',
      content: [{ type: 'text', text: 's' }],
    };
    const run1 = await manager.sideRun({
      sessionId: sid,
      config: newConfig(sid, hangClient),
      runKind: 'summary',
      snapshot: newSnapshot(sid),
      userMessage,    });
    // 第一次 still running（agentRuns map 有条目）
    expect(run1.state).toBe('running');

    // 第二次同 (s1, summary) → throw
    await expect(
      manager.sideRun({
        sessionId: sid,
        config: newConfig(sid, mockStreamClient('x')),
        runKind: 'summary',
        snapshot: newSnapshot(sid),
        userMessage,      }),
    ).rejects.toThrow(/already_running_in_this_mode/);
  });

  it('abort forked mode（runKind=summary）→ accepted:true，不走 4 步收尾', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine, sessionTypePolicy: mockSummaryPolicy(), });
    // hang stream：间歇 yield 让 chunk 循环能检查 controller.aborted（不用 await Promise 永挂）
    let controllerRef: { aborted: boolean } | null = null;
    const hangClient: LlmClient = {
      stream: (_req: CanonicalRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> => {
        return (async function* () {
          yield { type: 'message_start', messageId: 'm1', role: 'assistant' } as unknown as StreamEvent;
          // 周期性 yield 让 consumer.consume + controller.aborted 检查生效
          // 用更长循环（5000 × 20ms = 100s 远超测试超时；abort 后立即退出）
          for (let i = 0; i < 5000; i++) {
            if (signal?.aborted || controllerRef?.aborted) return;
            yield { type: 'text_delta', messageId: 'm1', text: '.' } as unknown as StreamEvent;
            await new Promise((r) => setTimeout(r, 20));
          }
        })();
      },
      call: vi.fn(),
      contextWindow: 100000,
    } as unknown as LlmClient;
    // 拿到 controller 引用（sideRun 后从 manager internals 取）
    const userMessage: Message = {
      id: ulid(),
      sessionId: sid,
      role: 'user',
      content: [{ type: 'text', text: 's' }],
    };
    const run = await manager.sideRun({
      sessionId: sid,
      config: newConfig(sid, hangClient),
      runKind: 'summary',
      snapshot: newSnapshot(sid),
      userMessage,    });
    controllerRef = (manager as unknown as {
      abortControllers: Map<string, { runId: string; aborted: boolean }>;
    }).abortControllers.get(`${sid}_summary`)!;

    // abort forked：runKind='summary'（不走 4 步收尾，直接 controller.aborted=true）
    const result = await manager.abort(sid, run.runId, 'summary');
    expect(result.accepted).toBe(true);
    // 等 chunk 循环下一轮检查 controller.aborted（20ms 间隔 yield，等 100ms 足够）
    await new Promise((r) => setTimeout(r, 100));

    // 主对话状态机未被碰（forked 不写 store，不转状态）
    const sess = await store.getSession(sid);
    expect(sess?.state).toBe('idle'); // 未被 markInterrupting

    // await promise → 应该是 interrupted（hang 中的 loop 见 aborted=true 后退出）
    const r = await run.promise;
    expect(r.stopReason).toBe('interrupted');
  });
});

describe('AgentManager.activate — T5 返 AgentRun', () => {
  it('activate 返 AgentRun（state=running）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine, sessionTypePolicy: mockMainPolicy(),
    });
    const config = newConfig(sid, mockStreamClient('hi'));
    manager.setResolveConfig(async () => config);
    const run = await manager.activate(sid);
    expect(run.state).toBe('running');
    expect(run.runKind).toBe('main');
    expect(run.runId).toBeTruthy();
    expect(run.groupKey).toBe(`session_id:${sid}_amt:main`);
  });

  it('running 时二次 activate 返现有 AgentRun（同一对象引用）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine, sessionTypePolicy: mockMainPolicy(),
    });
    // hang stream：loop 持续运行不立即退出
    const hangClient: LlmClient = {
      stream: (): AsyncIterable<StreamEvent> => {
        return (async function* () {
          for (let i = 0; i < 1000; i++) {
            yield { type: 'text_delta', text: '.' } as unknown as StreamEvent;
          }
          yield { type: 'finish', stopReason: 'stop' } as unknown as StreamEvent;
        })();
      },
      call: vi.fn(),
      contextWindow: 100000,
    } as unknown as LlmClient;
    const config = newConfig(sid, hangClient);
    manager.setResolveConfig(async () => config);
    await manager.enqueue(sid, [{ id: ulid(), sessionId: sid, role: 'user', content: [{ type: 'text', text: 'q' }] }]);
    const run1 = await manager.activate(sid);
    const run2 = await manager.activate(sid);
    // 同一对象引用（agentRuns map 同 key 返同一 AgentRun，agent_manager §2 v5.1）
    expect(run2).toBe(run1);
    expect(run2.runId).toBe(run1.runId);
  });
});

// ============================================================
// [v0.0.80.t1 task-3] sideRun：deep clone opts.snapshot + triggerMessage 透传
// 参考: specs/tech/version_logs/v0.0.80.t1/change_plan.md §2.4/§2.6
// ============================================================

describe('[v0.0.80.t1 task-3] AgentManager.sideRun deep clone + triggerMessage', () => {
  it('opts.snapshot 不被 mutate（sideRun 入口 deep clone；双保险防篡改）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine, sessionTypePolicy: mockSummaryPolicy(), });
    const snapshot = newSnapshot(sid);
    // 在 snapshot 上标记一个可辨识字段，便于后续判断是否被 clone
    const originalMessagesLength = snapshot.messages.length;
    const userMessage: Message = {
      id: ulid(),
      sessionId: sid,
      role: 'user',
      content: [{ type: 'text', text: 'summary' }],
    };
    // 启动 forked run（stream 立即返回 answer）
    const run = await manager.sideRun({
      sessionId: sid,
      config: newConfig(sid, mockStreamClient('answer')),
      runKind: 'summary',
      snapshot,
      userMessage,
    });
    await run.promise;
    // caller snapshot.messages 没被 mutate
    expect(snapshot.messages.length).toBe(originalMessagesLength);
  });

  it('triggerMessage 透传 → 进入 RunSpec.wirePeekTriggerMessages（peekedMessages 取到 id）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine, sessionTypePolicy: mockSummaryPolicy(), });
    // 用一个能捕获 run_start inputMessageIds 的 spy（订阅 bus）
    const triggerMessage: Message = {
      id: 'msg-trigger-test',
      sessionId: sid,
      role: 'user',
      content: [],
    };
    const userMessage: Message = {
      id: ulid(),
      sessionId: sid,
      role: 'user',
      content: [{ type: 'text', text: 'summary' }],
    };
    const run = await manager.sideRun({
      sessionId: sid,
      config: newConfig(sid, mockStreamClient('answer')),
      runKind: 'summary',
      snapshot: newSnapshot(sid),
      userMessage,
      triggerMessage,
    });
    // 订阅 bus 收 run_start 事件
    const events: Array<{ type: string; inputMessageIds?: string[] }> = [];
    const consumePromise = (async () => {
      for await (const e of manager.subscribe(sid, 'summary')) {
        events.push(e as never);
        if (e.type === 'run_end') break;
      }
    })();
    await run.promise;
    await consumePromise;
    // run_start.inputMessageIds 含 triggerMessage.id（透传链通：sideRun opts.triggerMessage
    //   → buildForkedDopts.wirePeekTriggerMessages → runReActLoop peekedMessages → emitRunStart）
    const runStart = events.find((e) => e.type === 'run_start');
    expect(runStart).toBeTruthy();
    expect(runStart!.inputMessageIds).toContain('msg-trigger-test');
  });
});
