/**
 * AgentManager.run(spec, loop) 单元测试 — v0.0.40 T7 唯一 loop 启动入口
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md §1 §2 v0.0.40 单 loop 入口
 *
 * 覆盖（task 验收）：
 *   - current 路径：注册三 map（agentRuns/abortControllers/loops）+ 返 AgentRun（state=running）
 *   - forked 路径：注册 agentRuns/abortControllers（loops 不注册，forked 不参与 abort-finalize 轮询）
 *   - loop settle（resolve）→ 三 map cleanup（current 删 loops；forked 不动 loops）
 *   - current: loop.start()=Promise<void> resolve → agentRun.state=completed + promise resolve（空结果）
 *   - forked: loop.start()=Promise<RunResult> resolve → agentRun.result=RunResult + promise resolve（真实结果传播）
 *   - forked: loop.start() resolve stopReason='error' → promise reject（保留 compact markSummaryFailed 契约）
 *
 * 隔离：注入 mock LoopHandle（controllable start promise），不跑真 runReActLoop，专注注册/启动/cleanup 逻辑。
 * 文件系统隔离：mkdtempSync + afterEach rmSync（不读写 ~/.oobt-desktop/）。
 */
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
import type { RunSpec } from '../loop-ports';
import type { LoopHandle } from '../run-loop-handle';
import type { AgentRun, RunResult, AbortControllerHandle } from '../agent-interface';

let tmpRoot: string;
let store: SessionStore;
let contextEngine: ContextEngine;
let toolEngine: ToolExecutionEngine;
let inbox: InboxStore;
let bus: ReplayableEventBus;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-manager-run-'));
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

/** 构造可控的 mock LoopHandle：start() 返回一个 pending promise，测试按需 resolve/reject。 */
function makeMockLoop(runId: string): {
  loop: LoopHandle;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
} {
  let running = false;
  let resolveFn!: (v: unknown) => void;
  let rejectFn!: (e: unknown) => void;
  const startPromise = new Promise<unknown>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  // 精确模拟 MainLoopHandle/ForkedLoopHandle 的 async start() try/finally：settle 后 running=false，
  // 且 rejection 经 start() 返回值透传（不创建额外 rejecting intermediate 致 unhandled 假警）
  const loop: LoopHandle = {
    runId,
    isRunning: () => running,
    start: async (): Promise<unknown> => {
      running = true;
      try {
        return await startPromise;
      } finally {
        running = false;
      }
    },
  };
  return { loop, resolve: resolveFn, reject: rejectFn };
}

/** 构造最小 RunSpec（run 只读 sessionId/runKind/runId/controller；port 不调用故 mock 置空）。 */
function makeSpec(sid: string, runKind: string, runId: string): { spec: RunSpec; controller: AbortControllerHandle } {
  const controller: AbortControllerHandle = { runId, aborted: false };
  // run() 不调用 spec 的 port（loop 是 mock），故 port 字段全 noop / 强类型断言绕开
  const spec = {
    sessionId: sid, runId, runKind, scopeId: 'default',
    controller,
    message: undefined,
    toolDefinitions: [], allowedTools: [], maxIter: 1,
    context: {} as never, emit: () => {}, lifecycle: {} as never,
    finalize: {} as never, observability: {} as never,
  } as unknown as RunSpec;
  return { spec, controller };
}

/** 拿 manager 私有三 map（UT 检验用，绕 private）。 */
function mapsOf(m: AgentManagerImpl): {
  agentRuns: Map<string, AgentRun>;
  abortControllers: Map<string, AbortControllerHandle>;
  loops: Map<string, LoopHandle>;
} {
  return m as unknown as {
    agentRuns: Map<string, AgentRun>;
    abortControllers: Map<string, AbortControllerHandle>;
    loops: Map<string, LoopHandle>;
  };
}

const rk = (sid: string, runKind: string): string => `${sid}_${runKind}`;
const lk = (sid: string): string => `${sid}_main`;

describe('AgentManager.run(spec, loop) — T7 唯一 loop 启动入口', () => {
  it('current 路径：注册三 map（agentRuns/abortControllers/loops）+ 返 AgentRun', async () => {
    const sid = ulid();
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    });
    const runId = ulid();
    const { spec, controller } = makeSpec(sid, 'main', runId);
    const { loop } = makeMockLoop(runId);

    const agentRun = await manager.run(spec, loop);
    const maps = mapsOf(manager);

    // 三 map 全注册
    expect(maps.agentRuns.get(rk(sid, 'main'))).toBe(agentRun);
    expect(maps.abortControllers.get(rk(sid, 'main'))).toBe(controller);
    expect(maps.loops.get(lk(sid))).toBe(loop);
    // activeLoopCount 同步（loops.size）
    expect(manager.activeLoopCount()).toBe(1);
    // AgentRun 字段齐全
    expect(agentRun.sessionId).toBe(sid);
    expect(agentRun.runKind).toBe('main');
    expect(agentRun.runId).toBe(runId);
    expect(agentRun.groupKey).toBe(`session_id:${sid}_amt:main`);
    expect(agentRun.state).toBe('running');
  });

  it('forked 路径：注册 agentRuns/abortControllers，不注册 loops', async () => {
    const sid = ulid();
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    });
    const runId = ulid();
    const { spec, controller } = makeSpec(sid, 'summary', runId);
    const { loop } = makeMockLoop(runId);

    const agentRun = await manager.run(spec, loop);
    const maps = mapsOf(manager);

    expect(maps.agentRuns.get(rk(sid, 'summary'))).toBe(agentRun);
    expect(maps.abortControllers.get(rk(sid, 'summary'))).toBe(controller);
    // forked 不注册 loops（abort-finalize 不轮询 forked loop）
    expect(maps.loops.has(lk(sid))).toBe(false);
    expect(manager.activeLoopCount()).toBe(0);
    expect(agentRun.runKind).toBe('summary');
    expect(agentRun.state).toBe('running');
  });

  it('current: loop.start() resolve → 三 map cleanup + agentRun.state=completed', async () => {
    const sid = ulid();
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    });
    const runId = ulid();
    const { spec } = makeSpec(sid, 'main', runId);
    const { loop, resolve } = makeMockLoop(runId);

    const agentRun = await manager.run(spec, loop);
    const maps = mapsOf(manager);
    expect(maps.agentRuns.has(rk(sid, 'main'))).toBe(true);

    resolve(undefined); // loop.start() resolve（Promise<void>）
    await agentRun.promise; // 等 settle

    expect(agentRun.state).toBe('completed');
    // 三 map 全清
    expect(maps.agentRuns.has(rk(sid, 'main'))).toBe(false);
    expect(maps.abortControllers.has(rk(sid, 'main'))).toBe(false);
    expect(maps.loops.has(lk(sid))).toBe(false);
    expect(manager.activeLoopCount()).toBe(0);
  });

  it('current: loop.start() reject → 三 map cleanup + agentRun.state=error + promise reject', async () => {
    const sid = ulid();
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    });
    const runId = ulid();
    const { spec } = makeSpec(sid, 'main', runId);
    const { loop, reject } = makeMockLoop(runId);

    const agentRun = await manager.run(spec, loop);
    const maps = mapsOf(manager);

    reject(new Error('boom'));
    // 用 .catch((e)=>e) 同步挂 handler 拿 rejection（vitest expect().rejects 时序偶漏挂致 unhandled 假警）
    const err = await agentRun.promise.catch((e: unknown) => e);
    expect((err as Error).message).toBe('boom');

    expect(agentRun.state).toBe('error');
    expect(maps.agentRuns.has(rk(sid, 'main'))).toBe(false);
    expect(maps.abortControllers.has(rk(sid, 'main'))).toBe(false);
    expect(maps.loops.has(lk(sid))).toBe(false);
  });

  it('forked: loop.start() resolve(RunResult) → agentRuns/abortControllers cleanup + 真实结果传播', async () => {
    const sid = ulid();
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    });
    const runId = ulid();
    const { spec } = makeSpec(sid, 'summary', runId);
    const { loop, resolve } = makeMockLoop(runId);

    const agentRun = await manager.run(spec, loop);
    const maps = mapsOf(manager);

    const result: RunResult = { answer: 'compressed-summary', usage: { input: 10, output: 5 } as never, stopReason: 'no_tool_call', rounds: 1 };
    resolve(result);
    const got = await agentRun.promise;

    expect(got).toBe(result); // 真实结果传播（compact caller await 拿 answer）
    expect(agentRun.result).toBe(result);
    expect(agentRun.state).toBe('completed');
    // forked cleanup：agentRuns/abortControllers 清，loops 本就无
    expect(maps.agentRuns.has(rk(sid, 'summary'))).toBe(false);
    expect(maps.abortControllers.has(rk(sid, 'summary'))).toBe(false);
  });

  it('forked: loop.start() resolve stopReason=error → promise reject（保留 compact markSummaryFailed 契约）', async () => {
    const sid = ulid();
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    });
    const runId = ulid();
    const { spec } = makeSpec(sid, 'summary', runId);
    const { loop, resolve } = makeMockLoop(runId);

    const agentRun = await manager.run(spec, loop);
    const errorResult: RunResult = { answer: 'llm-error-detail', usage: {} as never, stopReason: 'error', rounds: 0 };
    resolve(errorResult);

    // runReActLoop 设 stopReason=error 不 rethrow，buildAgentRunShell 显式 reject（compact catch 触发 markSummaryFailed）
    // 用 .catch((e)=>e) 同步挂 handler 拿 rejection（vitest expect().rejects 时序偶漏挂致 unhandled 假警）
    const err = await agentRun.promise.catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/side run loop error/);
    expect(agentRun.state).toBe('error');
    expect(agentRun.result).toBe(errorResult);
  });
});
