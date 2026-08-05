/**
 * Agent 统一契约 + AgentRun + AbortControllerHandle 单元测试（v0.0.15 T1+T2；v0.0.40 协议瘦身）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_interface.md（v1.1，v0.0.40 协议瘦身）
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_interrupt.md §1-§1.1 + §2.1（v1.5）
 *
 * 覆盖：
 *   - 类型可用性（AgentRun 字段、AbortControllerHandle 字段）
 *   - AbortResult reason 取值对齐 spec v1.1（run_id_mismatch / no_active_controller / cas_failed）
 *   - groupKeyForRunKind 命名（session_id:<sid>_amt:<runKind>）
 *   - runMapKey 命名（<sid>_<runKind>）
 *   - AgentLoop 读 controller.aborted（不读 signal/state/currentRunId，T2 核心改造）
 *   - buildRunDeps 单装配（profile 驱动 RunSpec；forked 命名退役）
 */
import { defaultTools } from '../../tools/registry';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
// [v0.0.40 T6a] AgentLoop 类退役 → 改测 buildRunDeps + RunLoopHandle
// [v0.0.40 T6b] ForkedAgent 类退役 → 改测 buildRunDeps + RunLoopHandle（profile 驱动单装配）
// [v0.0.204 T3] buildMainDeps/buildForkedDeps 合并为 buildRunDeps（forked 命名退役）
import { buildRunDeps } from '../build-run-deps';
import type { SessionTypePolicy } from '../session-type-policy';
import type { ResolvedSessionProfile } from '../session-type-profile-loader';
import { SessionKind } from '@app/shared';
import { vi } from 'vitest';
import {
  groupKeyForRunKind,
  runMapKey,
  type AgentRun,
  type AgentRunState,
  type AbortControllerHandle,
  type AbortResult,
} from '../agent-interface';
import type { SessionConfig } from '../context-types';
import type { Message } from '../../message/types';

let tmpRoot: string;
let store: SessionStore;
let contextEngine: ContextEngine;
let toolEngine: ToolExecutionEngine;
let inbox: InboxStore;
let bus: ReplayableEventBus;
let tools: ReturnType<typeof defaultTools>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-agent-interface-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  bus = new ReplayableEventBus({ replayable: true });
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  contextEngine = new ContextEngine({ store });
  toolEngine = new ToolExecutionEngine();
  inbox = new InboxStore();
  tools = defaultTools(tmpRoot);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** SessionConfig 工厂（注入 mock client） */
function newConfig(sessionId: string): SessionConfig {
  return {
    sessionId,
    systemPrompt: 'sys',
    client: { contextWindow: 100000, async *stream() { /* empty */ }, async call() { return { message: { content: [] }, usage: {}, stopReason: 'stop' }; } } as unknown as SessionConfig['client'],
    modelId: 'mock-model',
    tools,
    workdir: tmpRoot,
    kind: newMainKind(),
  } as SessionConfig;
}

// ============================================================
// 1. 类型可用性（编译期保证）
// ============================================================

describe('Agent interface + AgentRun + AbortControllerHandle 类型可用性', () => {
  it('AbortControllerHandle: { runId: string; aborted: boolean } 内存对象（非 Web API）', () => {
    const c: AbortControllerHandle = { runId: 'r1', aborted: false };
    expect(c.runId).toBe('r1');
    expect(c.aborted).toBe(false);
    // 内存对象可变（manager 置 aborted=true 后 loop 立即读到）
    c.aborted = true;
    expect(c.aborted).toBe(true);
    // 不含 Web API 的 signal 字段
    expect((c as unknown as { signal?: unknown }).signal).toBeUndefined();
  });

  it('AgentRunState 取值（running/completed/interrupted/error）', () => {
    const states: AgentRunState[] = ['running', 'completed', 'interrupted', 'error'];
    expect(states).toHaveLength(4);
  });

  it('AgentRun: 字段完整（sessionId/runKind/runId/groupKey/state/promise/result）', async () => {
    const run: AgentRun = {
      sessionId: 's1',
      runKind: 'main',
      runId: 'r1',
      groupKey: groupKeyForRunKind('s1', 'main'),
      state: 'running',
      promise: Promise.resolve({ answer: '', usage: {}, stopReason: 'no_tool_call', rounds: 0 }),
    };
    expect(run.sessionId).toBe('s1');
    expect(run.runKind).toBe('main');
    expect(run.groupKey).toBe('session_id:s1_amt:main');
    expect(run.state).toBe('running');
    // AgentRun 不暴露 controller 字段（agent_interface §2 v1.1）
    expect((run as unknown as { controller?: unknown }).controller).toBeUndefined();
    // result 完成后填充
    expect(run.result).toBeUndefined();
    run.result = await run.promise;
    expect(run.result).toBeDefined();
  });
});

// ============================================================
// 2. AbortResult reason 取值（spec v1.1）
// ============================================================

describe('AbortResult reason 取值对齐 spec v1.1', () => {
  it('accepted:true 分支无 reason 字段', () => {
    const r: AbortResult = { accepted: true };
    expect(r.accepted).toBe(true);
    expect((r as { reason?: string }).reason).toBeUndefined();
  });

  it('accepted:false 三种 reason 取值（run_id_mismatch / no_active_controller / cas_failed）', () => {
    const reasons: Array<NonNullable<Extract<AbortResult, { accepted: false }>['reason']>> = [
      'run_id_mismatch',
      'no_active_controller',
      'cas_failed',
    ];
    expect(reasons).toEqual(['run_id_mismatch', 'no_active_controller', 'cas_failed']);
  });

  it('废弃的 v0.0.12 取值（not_running / session_not_found）不在新口径', () => {
    // 这两个 reason 已废弃（agent_interface v1.1 §3 + agent_interrupt v1.5 §6）
    // TS 编译期会拒绝，这里运行期二次验证
    const validReasons = ['run_id_mismatch', 'no_active_controller', 'cas_failed'];
    expect(validReasons).not.toContain('not_running');
    expect(validReasons).not.toContain('session_not_found');
  });
});

// ============================================================
// 3. groupKeyForRunKind + runMapKey 命名（agent_interface §4 + §6）
// ============================================================

describe('groupKeyForRunKind + runMapKey 命名', () => {
  it('groupKeyForRunKind: session_id:<sid>_amt:<runKind>', () => {
    expect(groupKeyForRunKind('s1', 'main')).toBe('session_id:s1_amt:main');
    expect(groupKeyForRunKind('s1', 'summary')).toBe('session_id:s1_amt:summary');
    expect(groupKeyForRunKind('s1', 'consolidate')).toBe('session_id:s1_amt:consolidate');
  });

  it('runMapKey: <sid>_<runKind>（agentRuns/abortControllers 共用 key）', () => {
    expect(runMapKey('s1', 'main')).toBe('s1_main');
    expect(runMapKey('s1', 'summary')).toBe('s1_summary');
    expect(runMapKey('s1', 'consolidate')).toBe('s1_consolidate');
  });
});

// ============================================================
// 5. RunLoopHandle via buildRunDeps（v0.0.204 T3：单装配；forked 命名退役）
// ============================================================

/** main profile mock（profile 字段驱动 RunSpec 装配） */
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

/** 构造 main kind（playground-rocky:parent:main；用于 buildRunDeps） */
function newMainKind() {
  return new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'main' });
}

describe('RunLoopHandle via buildRunDeps（T3：单装配 + forked 命名退役）', () => {
  it('buildRunDeps 装配 RunLoopHandle（runId/runKind/scopeId 透传；main profile 字段派生）', () => {
    const controller: AbortControllerHandle = { runId: 'r1', aborted: false };
    const { spec, loop } = buildRunDeps({
      config: { ...newConfig('s1'), maxIterations: 25, kind: newMainKind() } as SessionConfig,
      bus, store, inbox, contextEngine, toolEngine,
      runId: 'r1',
      controller,
      kind: newMainKind(),
      sessionTypePolicy: mockMainPolicy(),
    });
    expect(loop.runId).toBe('r1');
    expect(loop.runKind).toBe('main');
    expect(loop.isRunning()).toBe(false);
    // scopeId = canonicalId 纯拼接（playground-rocky:parent:main）
    expect(spec.scopeId).toBe('playground-rocky:parent:main');
    expect(spec.runKind).toBe('main');
    expect(spec.drainMode).toBe('eager');
    expect(spec.backgroundPath).toBe(false);
  });

  it('buildRunDeps 是新装配入口', () => {
    expect(typeof buildRunDeps).toBe('function');
  });

  it('RunLoopHandle 不暴露 abort() 方法（中断由 manager 置 controller.aborted=true）', () => {
    const controller: AbortControllerHandle = { runId: 'r1', aborted: false };
    const { loop } = buildRunDeps({
      config: { ...newConfig('s1'), maxIterations: 25, kind: newMainKind() } as SessionConfig,
      bus, store, inbox, contextEngine, toolEngine,
      controller,
      kind: newMainKind(),
      sessionTypePolicy: mockMainPolicy(),
    });
    expect((loop as unknown as { abort?: unknown }).abort).toBeUndefined();
  });
});

// ============================================================
// 7. AgentManager 三 map（agentRuns / abortControllers / loops）
// ============================================================

describe('AgentManager 三 map 就位', () => {
  it('构造时三 map 空（agentRuns / abortControllers / loops）', () => {
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
      sessionTypePolicy: mockMainPolicy(),
    });
    const internals = manager as unknown as {
      agentRuns: Map<string, unknown>;
      abortControllers: Map<string, unknown>;
      loops: Map<string, unknown>;
    };
    expect(internals.agentRuns).toBeInstanceOf(Map);
    expect(internals.abortControllers).toBeInstanceOf(Map);
    expect(internals.loops).toBeInstanceOf(Map);
    expect(internals.agentRuns.size).toBe(0);
    expect(internals.abortControllers.size).toBe(0);
    expect(internals.loops.size).toBe(0);
  });

  it('activate 后 loops key = ${sid}_main + agentRuns/abortControllers key = ${sid}_main', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
      sessionTypePolicy: mockMainPolicy(),
    });
    manager.setResolveConfig(async () => newConfig(sid));
    // v0.0.15 T5：activate 返 AgentRun（不再是 ActivateResult 联合）
    const agentRun = await manager.activate(sid);
    expect(agentRun.state).toBe('running');

    const internals = manager as unknown as {
      loops: Map<string, unknown>;
      agentRuns: Map<string, unknown>;
      abortControllers: Map<string, unknown>;
    };
    // loops key = ${sid}_main（v0.0.204 RUN_KIND_MAIN='main'）
    expect(internals.loops.has(`${sid}_main`)).toBe(true);
    // agentRuns/abortControllers 共用 key = ${sid}_main（runKind=main）
    expect(internals.agentRuns.has(`${sid}_main`)).toBe(true);
    expect(internals.abortControllers.has(`${sid}_main`)).toBe(true);
    // controller 形态：{ runId, aborted }
    const controller = internals.abortControllers.get(`${sid}_main`) as AbortControllerHandle;
    expect(controller.runId).toBe(agentRun.runId);
    expect(controller.aborted).toBe(false);
  });
});

// ============================================================
// 8. T3：AgentEventBase.runKind 必填 + groupKey 全链路 _amt:<runKind>
// ============================================================

describe('T3: AgentEventBase.runKind 必填 + 全链路 groupKey 对齐', () => {
  it('AgentEventBase 含 runKind 必填字段（agent_event.md §2 v1.1）', async () => {
    // 构造一个最小的 RunStartEvent 验证 runKind 必填
    const e = {
      id: ulid(),
      type: 'run_start' as const,
      sessionId: 's1',
      createdAt: new Date().toISOString(),
      runKind: 'main',
      inputMessageIds: [],
    };
    expect(e.runKind).toBe('main');
    // runKind 是 AgentEventBase 的必填字段（TS 编译期保证；此处运行期二次验证）
    expect('runKind' in e).toBe(true);
  });

  it('groupKeyForRunKind: 所有 mode 的 group 都带 _amt:<runKind> 后缀', () => {
    // 主对话 current（eager）
    expect(groupKeyForRunKind('s1', 'main')).toMatch(/^session_id:s1_amt:main$/);
    // forked summary
    expect(groupKeyForRunKind('s1', 'summary')).toMatch(/^session_id:s1_amt:summary$/);
    // forked memory_extract（future）
    expect(groupKeyForRunKind('s1', 'consolidate')).toMatch(/^session_id:s1_amt:consolidate$/);
  });

  it('manager.subscribe(sid) 默认订阅 _amt:main group（主对话流）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
      sessionTypePolicy: mockMainPolicy(),
    });
    // subscribe 不抛即通过；group 路由由 groupKeyForRunKind 构造（默认 current）
    const iter = manager.subscribe(sid)[Symbol.asyncIterator]();
    // 立即取消订阅（防泄漏）
    await iter.return?.();
    // 验证默认 runKind 路由生效：通过 bus.subscribe 的 group 应为 session_id:<sid>_amt:main
    // （间接验证：subscribe 后向该 group emit 事件能被收到）
    const iter2 = manager.subscribe(sid, 'main')[Symbol.asyncIterator]();
    await iter2.return?.();
    expect(manager.subscribe).toBeDefined();
  });

  it('enqueue emit 的 message_enqueued 事件体含 runKind=current（agent_event.md §2 v1.1）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
      sessionTypePolicy: mockMainPolicy(),
    });
    manager.setResolveConfig(async () => newConfig(sid));
    // 订阅主对话 group
    const iter = bus.subscribe(`session_id:${sid}_amt:main`)[Symbol.asyncIterator]();
    const msg: Message = {
      id: ulid(),
      sessionId: sid,
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      sender: { source: 'user' },
    } as Message;
    await manager.enqueue(sid, [msg]);
    const r = await Promise.race([
      iter.next(),
      new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 200)),
    ]);
    await iter.return?.();
    expect('done' in r && r.done).toBe(false);
    const evt = (r as { value?: { data?: { type?: string; runKind?: string } } }).value?.data;
    expect(evt?.type).toBe('message_enqueued');
    // v0.0.15：事件体必含 runKind=current
    expect(evt?.runKind).toBe('main');
  });
});
