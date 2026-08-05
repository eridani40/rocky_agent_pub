/**
 * [v0.0.130.hang task-3 Wave B] ChildProcessRegistry × abort 集成 UT
 * 参考: specs/tech/version_logs/v0.0.130.hang/change_plan.md 模块 B-2
 *
 * 覆盖：
 *   1. AgentManager 两处 controller 创建（activate 主对话 + sideRun）都挂 ChildProcessRegistry 实例
 *   2. abort-finalize.abortRun 在 aborted=true 之后（主对话 + forked 两分支）
 *      fire-and-forget 调用 controller.childRegistry.killAll()
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
import { abortRun } from '../abort-finalize';
import { ChildProcessRegistry } from '../../tools/child-process-registry';
import { ulid } from '../../config/ulid';
import { SessionKind } from '@app/shared';
import type { SessionTypePolicy } from '../session-type-policy';
import type { ResolvedSessionProfile } from '../session-type-profile-loader';
import type { SessionConfig, ContextSnapshot } from '../context-types';
import type { AbortControllerHandle, AgentRun } from '../agent-interface';
import type { Message } from '../../message/types';
import type { LlmClient } from '../../llm/client';
import type { CanonicalRequest, StreamEvent } from '../../llm/protocol';

/** summary profile mock（v0.0.204 T3：sideRun 路径需 policy） */

/** main profile mock（buildRunDeps 始终调 policy.profile(kind) 单源驱动装配） */
function mockMainPolicy(): SessionTypePolicy {
  const profile: ResolvedSessionProfile = {
    id: 'playground-rocky:parent:main',
    enabled: true, toolBound: [], toolDefinitionsSource: 'own',
    runShape: { drainMode: 'eager', backgroundPath: false, maxIterDefault: 25, touchesStateMachine: true, persistsRun: true, usagePartition: 'current' },
    lifecycleHooks: { abortFinalize: 'four-step', cascadeChildren: true },
    eventChannel: { emitDefault: true },
    modelHints: { readsSquadDefault: false }, skillSource: 'global-enabled', eosStop: [],
    autoNaming: false, preloadContext: 'none',
  };
  return { profile: vi.fn(() => profile), resolveToolSet: vi.fn(() => ({ tools: [], toolDefinitions: [], allowedTools: [] })) };
}

const parentKind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'main' });

function mockSummaryPolicy(): SessionTypePolicy {
  const profile: ResolvedSessionProfile = {
    id: 'playground-rocky:parent:summary',
    enabled: true, toolBound: [], toolDefinitionsSource: 'host-snapshot',
    runShape: { drainMode: 'none', backgroundPath: true, maxIterDefault: 1, touchesStateMachine: false, persistsRun: false, usagePartition: 'summary' },
    lifecycleHooks: { abortFinalize: 'none', cascadeChildren: false },
    eventChannel: { emitDefault: true },
    modelHints: { readsSquadDefault: false }, skillSource: 'none', eosStop: [],
    autoNaming: false, preloadContext: 'none',
  };
  return { profile: vi.fn(() => profile), resolveToolSet: vi.fn(() => ({ tools: [], toolDefinitions: [], allowedTools: [] })) };
}



let tmpRoot: string;
let store: SessionStore;
let contextEngine: ContextEngine;
let toolEngine: ToolExecutionEngine;
let inbox: InboxStore;
let bus: ReplayableEventBus;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-childreg-abort-'));
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

/** hang stream：持续 yield 不 finish，让 loop/controller 保持存活供断言读取 */
function hangStreamClient(): LlmClient {
  return {
    stream: (_req: CanonicalRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> => {
      return (async function* () {
        yield { type: 'message_start', messageId: 'm1', role: 'assistant' } as unknown as StreamEvent;
        for (let i = 0; i < 5000; i++) {
          if (signal?.aborted) return;
          yield { type: 'text_delta', messageId: 'm1', text: '.' } as unknown as StreamEvent;
          await new Promise((r) => setTimeout(r, 20));
        }
      })();
    },
    call: vi.fn(),
    contextWindow: 100000,
  } as unknown as LlmClient;
}

function newConfig(sid: string, client: LlmClient): SessionConfig {
  return { sessionId: sid, systemPrompt: '', client, modelId: 'mock-model', kind: parentKind } as SessionConfig;
}

function newSnapshot(sid: string): ContextSnapshot {
  return {
    system: { id: 'sys', sessionId: sid, role: 'system', content: [] },
    messages: [], inputCharCount: 0,
    contextWindowUsage: {
      systemTokens: 0, messageTokens: 0, toolTokens: 0, totalTokens: 0,
      maxOutputTokens: 20000, tokenLimit: 100000, remainingTokens: 80000,
    },
    summary: null, tools: [],
  };
}

describe('[v0.0.130.hang task-3] AgentManager 两处 controller 创建挂 ChildProcessRegistry', () => {
  it('activate()（主对话）创建的 controller.childRegistry 是 ChildProcessRegistry 实例', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({ bus, store, inbox, contextEngine, toolEngine, sessionTypePolicy: mockMainPolicy(), });
    manager.setResolveConfig(async () => newConfig(sid, hangStreamClient()));
    await manager.enqueue(sid, [{ id: ulid(), sessionId: sid, role: 'user', content: [{ type: 'text', text: 'q' }] } as Message]);
    await manager.activate(sid);

    const controller = (manager as unknown as { abortControllers: Map<string, AbortControllerHandle> })
      .abortControllers.get(`${sid}_main`);
    expect(controller).toBeDefined();
    expect(controller!.childRegistry).toBeInstanceOf(ChildProcessRegistry);
  });

  it('sideRun() 创建的 controller.childRegistry 是 ChildProcessRegistry 实例（与主对话不同实例）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({ bus, store, inbox, contextEngine, toolEngine, sessionTypePolicy: mockSummaryPolicy(), });
    const userMessage: Message = { id: ulid(), sessionId: sid, role: 'user', content: [{ type: 'text', text: 's' }] };
    await manager.sideRun({
      sessionId: sid, config: newConfig(sid, hangStreamClient()), runKind: 'summary',
      snapshot: newSnapshot(sid), userMessage,    });

    const controller = (manager as unknown as { abortControllers: Map<string, AbortControllerHandle> })
      .abortControllers.get(`${sid}_summary`);
    expect(controller).toBeDefined();
    expect(controller!.childRegistry).toBeInstanceOf(ChildProcessRegistry);
  });
});

describe('[v0.0.130.hang task-3] abort-finalize.abortRun 在 aborted=true 后 fire-and-forget killAll', () => {
  it('forked 分支（runKind!=current）：aborted=true 后立即调 childRegistry.killAll()', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();
    const killAll = vi.fn().mockResolvedValue(undefined);
    const controller: AbortControllerHandle = {
      runId, aborted: false, childRegistry: { killAll } as unknown as ChildProcessRegistry,
    };
    const abortControllers = new Map<string, AbortControllerHandle>([[`${sid}_summary`, controller]]);
    const agentRuns = new Map<string, AgentRun>();
    const loops = new Map();

    const result = await abortRun({
      sessionId: sid, runId, runKind: 'summary',
      store, bus, agentRuns, abortControllers, loops,
    });

    expect(result.accepted).toBe(true);
    expect(controller.aborted).toBe(true);
    // fire-and-forget：abortRun 不 await killAll，但同步调用点已触发（微任务内即被 call）
    expect(killAll).toHaveBeenCalledTimes(1);
  });

  it('主对话分支（runKind=current）：aborted=true 后（4 步收尾内）调 childRegistry.killAll()', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    const killAll = vi.fn().mockResolvedValue(undefined);
    const controller: AbortControllerHandle = {
      runId, aborted: false, childRegistry: { killAll } as unknown as ChildProcessRegistry,
    };
    const abortControllers = new Map<string, AbortControllerHandle>([[`${sid}_main`, controller]]);
    const agentRuns = new Map<string, AgentRun>();
    const loops = new Map();

    const result = await abortRun({
      sessionId: sid, runId, runKind: 'main',
      store, bus, agentRuns, abortControllers, loops,
    });

    expect(result.accepted).toBe(true);
    expect(controller.aborted).toBe(true);
    expect(killAll).toHaveBeenCalledTimes(1);
    // 收尾完成：session 终态 interrupted
    const s = await store.getSession(sid);
    expect(s?.state).toBe('interrupted');
  });

  it('controller.childRegistry 未挂载（undefined）→ abortRun 不抛错（可选链兜底）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();
    const controller: AbortControllerHandle = { runId, aborted: false }; // 无 childRegistry
    const abortControllers = new Map<string, AbortControllerHandle>([[`${sid}_summary`, controller]]);
    const agentRuns = new Map<string, AgentRun>();
    const loops = new Map();

    const result = await abortRun({
      sessionId: sid, runId, runKind: 'summary',
      store, bus, agentRuns, abortControllers, loops,
    });
    expect(result.accepted).toBe(true);
  });
});

// ============================================================
// [v0.0.207 T2] authority transfer：abortRun 主对话分支调 loop.revokeSideEffects
// ============================================================

describe('[v0.0.207 T2] abortRun 主对话分支调 loop.revokeSideEffects（authority transfer）', () => {
  /** 造假 LoopHandle：含必需字段（runId/isRunning/start/revokeSideEffects） */
  function fakeLoop(runId: string, revokeFn: () => void) {
    return {
      runId,
      isRunning: () => false,
      start: async () => { /* noop */ },
      revokeSideEffects: revokeFn,
    };
  }

  it('主对话分支（runKind=main）：aborted=true 后调 loop.revokeSideEffects()', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    const killAll = vi.fn().mockResolvedValue(undefined);
    const controller: AbortControllerHandle = {
      runId, aborted: false, childRegistry: { killAll } as unknown as ChildProcessRegistry,
    };
    const abortControllers = new Map<string, AbortControllerHandle>([[`${sid}_main`, controller]]);
    const agentRuns = new Map<string, AgentRun>();
    const revokeSideEffects = vi.fn();
    const loops = new Map<string, ReturnType<typeof fakeLoop>>([
      [`${sid}_main`, fakeLoop(runId, revokeSideEffects)],
    ]);

    const result = await abortRun({
      sessionId: sid, runId, runKind: 'main',
      store, bus, agentRuns, abortControllers, loops,
    });

    expect(result.accepted).toBe(true);
    expect(controller.aborted).toBe(true);
    // 关键：revokeSideEffects 被调（authority transfer 入口）
    expect(revokeSideEffects).toHaveBeenCalledTimes(1);
    // killAll 也被调（v0.0.130.hang 机制保留）
    expect(killAll).toHaveBeenCalledTimes(1);
  });

  it('forked 分支（runKind=summary）：不调 loop.revokeSideEffects（forked 无 4 步收尾）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();
    const killAll = vi.fn().mockResolvedValue(undefined);
    const controller: AbortControllerHandle = {
      runId, aborted: false, childRegistry: { killAll } as unknown as ChildProcessRegistry,
    };
    const abortControllers = new Map<string, AbortControllerHandle>([[`${sid}_summary`, controller]]);
    const agentRuns = new Map<string, AgentRun>();
    const revokeSideEffects = vi.fn();
    // forked 通常不挂 loops map（forked run 短路返，不走 waitForLoopExit）；即便挂了也不应被调
    const loops = new Map<string, ReturnType<typeof fakeLoop>>([
      [`${sid}_summary`, fakeLoop(runId, revokeSideEffects)],
    ]);

    const result = await abortRun({
      sessionId: sid, runId, runKind: 'summary',
      store, bus, agentRuns, abortControllers, loops,
    });

    expect(result.accepted).toBe(true);
    expect(controller.aborted).toBe(true);
    // forked 分支不调 revoke（forked 无副作用吊销需求）
    expect(revokeSideEffects).not.toHaveBeenCalled();
  });

  it('主对话分支：loop.runId 与传入 runId 不匹配 → 不调 revokeSideEffects（运行 ID 校验）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    const killAll = vi.fn().mockResolvedValue(undefined);
    const controller: AbortControllerHandle = {
      runId, aborted: false, childRegistry: { killAll } as unknown as ChildProcessRegistry,
    };
    const abortControllers = new Map<string, AbortControllerHandle>([[`${sid}_main`, controller]]);
    const agentRuns = new Map<string, AgentRun>();
    const revokeSideEffects = vi.fn();
    // loops map 挂的是另一个 runId（旧 run 残留）
    const loops = new Map<string, ReturnType<typeof fakeLoop>>([
      [`${sid}_main`, fakeLoop('other-run-id', revokeSideEffects)],
    ]);

    await abortRun({
      sessionId: sid, runId, runKind: 'main',
      store, bus, agentRuns, abortControllers, loops,
    });

    // runId 不匹配 → 不调 revoke（避免误杀下一个 run）
    expect(revokeSideEffects).not.toHaveBeenCalled();
  });

  it('主对话分支：loops 为空（loop 已退出/未注册）→ abortRun 不抛错', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    const killAll = vi.fn().mockResolvedValue(undefined);
    const controller: AbortControllerHandle = {
      runId, aborted: false, childRegistry: { killAll } as unknown as ChildProcessRegistry,
    };
    const abortControllers = new Map<string, AbortControllerHandle>([[`${sid}_main`, controller]]);
    const agentRuns = new Map<string, AgentRun>();
    const loops = new Map(); // 空

    const result = await abortRun({
      sessionId: sid, runId, runKind: 'main',
      store, bus, agentRuns, abortControllers, loops,
    });
    expect(result.accepted).toBe(true);
  });
});
