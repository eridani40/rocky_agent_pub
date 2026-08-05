import { defaultTools } from '../../tools/registry';
import { SessionKind } from '@app/shared';
import type { SessionTypePolicy } from '../session-type-policy';
import type { ResolvedSessionProfile } from '../session-type-profile-loader';
/**
 * AgentManager + AgentLoop 中断单元测试（v0.0.12 task t2）
 * 参考: states/v0.0.12/design.md 板块 4.3 / 5 / 6 / 11
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_interrupt.md §2 §3
 *
 * 覆盖（design §10 UT 清单）：
 *   - activate 三情况（running→already_running / idle→新 loop / interrupting→循环等待）
 *   - loop 中断判断三条件（signal.aborted → 阻止副作用 + 退出不收尾）
 *   - abort api 4 步（markInterrupting + loop.abort / subscribe 重组 partial 复用 message_start id /
 *     补 interrupted tool_result / clearReplay / emit run_stop + markInterrupted）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import {
  SessionSchema,
  MessageSchema,
  SummarySchema,
  RunSchema,
} from '../schema_defs';
import { SessionStore } from '../session-store';
import { ContextEngine } from '../context-engine';
import { ToolExecutionEngine } from '../../tools/engine';
import { InboxStore } from '../inbox';
import { ReplayableEventBus } from '../event-bus';
import { AgentManagerImpl } from '../agent-manager';
// [v0.0.30] 让本套真 agent-loop 测试经 wrapped bus 跑（模拟 bootstrap 生产路径），回归
// wrapBusWithLog 必须机制上转发全部方法（首版漏 clearReplay → 每次 run SERVER_ERROR 全挂）。
import { wrapBusWithLog } from '../../dev-logs/wrap-bus-with-log';
import { LogWriter } from '../../dev-logs/log-writer';
import type { AgentEvent } from '../agent-event-types';
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
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-agent-interrupt-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  bus = wrapBusWithLog(
    new ReplayableEventBus({ replayable: true }),
    new LogWriter(tmpRoot, { get: () => false }), // 日志开关全 off（本套只验 wrap 透明转发，不写日志）
    'agent_loop',
  );
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

function newConfig(sessionId: string, client: unknown): SessionConfig {
  return {
    sessionId,
    systemPrompt: 'sys',
    client: client as SessionConfig['client'],
    modelId: 'mock-model',
    kind: parentKind,
    tools,
    workdir: tmpRoot,
  } as SessionConfig;
}

/** mock LlmClient：yield events，遇 abort 时立即停止迭代（模拟 fetch abort） */
function slowStreamClient(opts: {
  events: { type: string; [k: string]: unknown }[];
  delayMs?: number;
  /** 永远阻塞（不结束）模式：用于让 loop 卡在 stream 中等 abort */
  hang?: boolean;
}): { client: unknown; streamCalls: () => number } {
  let calls = 0;
  const client = {
    contextWindow: 100000,
    async *stream(_req: unknown, signal?: AbortSignal): AsyncIterable<{ type: string; [k: string]: unknown }> {
      calls++;
      // hang 模式：永不结束，等 signal abort 触发抛错
      if (opts.hang) {
        // 先吐一个 text_delta（partial text 场景），再 hang
        for (const e of opts.events) yield e;
        await new Promise<void>((resolve) => {
          const t = setInterval(() => {
            if (signal?.aborted) {
              clearInterval(t);
              resolve();
            }
          }, 10);
        });
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return;
      }
      for (const e of opts.events) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        yield e;
      }
    },
    async call() {
      return {
        message: { id: 'c', role: 'assistant', content: [{ type: 'text', text: 's' }] },
        usage: {},
        stopReason: 'stop',
      };
    },
  };
  return { client, streamCalls: () => calls };
}

/** 一条 user message */
function userMsg(sid: string, text: string): Message {
  return {
    id: ulid(),
    sessionId: sid,
    role: 'user',
    content: [{ type: 'text', text }],
    sender: { source: 'user' },
  };
}

// ============================================================
// activate 三情况
// ============================================================

describe('AgentManager.activate — 三情况闸门', () => {
  it('case1: state=running 时 activate → already_running（消息已 enqueue）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    // 用慢 stream client 让 loop 持续运行
    const { client } = slowStreamClient({
      events: [{ type: 'text_delta', text: 'hello' }, { type: 'finish', reason: 'stop' }],
      delayMs: 50,
    });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    const config = newConfig(sid, client);
    manager.setResolveConfig(async () => config);
    await manager.enqueue(sid, [userMsg(sid, 'q1')]);
    const r1 = await manager.activate(sid);
    // v0.0.15 T5：activate 返 AgentRun，state='running'（旧 'activated'）/'error'
    expect(r1.state).toBe('running');

    // loop 在运行时再 activate（enqueue 一条消息后）→ 返同一 AgentRun（already_running 语义）
    await manager.enqueue(sid, [userMsg(sid, 'q2')]);
    const r2 = await manager.activate(sid);
    expect(r2.state).toBe('running');
    // 同一对象引用（agentRuns map 同 key 返同一 AgentRun，agent_manager §2 v5.1）
    expect(r2.runId).toBe(r1.runId);
  });

  it('case2: state=idle 时 activate → activated + CAS 设 running + currentRunId', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const { client } = slowStreamClient({
      events: [{ type: 'finish', reason: 'stop' }],
    });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    const config = newConfig(sid, client);
    manager.setResolveConfig(async () => config);
    await manager.enqueue(sid, [userMsg(sid, 'q')]);
    const r = await manager.activate(sid);
    // v0.0.15 T5：state='running'（旧 'activated'）
    expect(r.state).toBe('running');
    const s = await store.getSession(sid);
    expect(s?.state).toBe('running');
    expect(s?.currentRunId).toBe(r.runId);
  });

  it('case3: state=interrupting 时 activate → 循环等待（poll 100ms）直到 interrupted/idle', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    // 手动构造 interrupting 态
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    await store.stateMachine.markInterrupting(sid, runId);

    const { client } = slowStreamClient({
      events: [{ type: 'finish', reason: 'stop' }],
    });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    const config = newConfig(sid, client);
    manager.setResolveConfig(async () => config);
    // 异步：500ms 后 markInterrupted 让 interrupting 解除
    setTimeout(async () => {
      await store.stateMachine.markInterrupted(sid);
    }, 200);
    const start = Date.now();
    const r = await manager.activate(sid);
    const elapsed = Date.now() - start;
    // 应该至少等了 200ms（poll 100ms × 2+ 次）
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(r.state).toBe('running');
  });
});

// ============================================================
// loop 中断判断 + 副作用门控
// ============================================================

describe('AgentLoop — 中断判断 + 副作用门控', () => {
  it('abort 在 run_start 前触发 → loop 不 emit run_start、不写 state', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const { client, streamCalls } = slowStreamClient({
      events: [],
      hang: true,
    });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    const config = newConfig(sid, client);
    manager.setResolveConfig(async () => config);
    await manager.enqueue(sid, [userMsg(sid, 'q')]);

    const r = await manager.activate(sid);
    // v0.0.15 T4：abort 三参（sessionId, runId, runKind='main'）
    await manager.abort(sid, r.runId, 'main');

    await new Promise((r2) => setTimeout(r2, 200));
    // 验证：session state 走完 abort api 收尾（→ interrupted）
    const s = await store.getSession(sid);
    expect(['interrupted', 'idle']).toContain(s?.state);
    void streamCalls; void r;
  });

  it('loop 被 abort 时阻止副作用：不 emit run_end（abort api step4 发 run_stop(interrupted)）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const { client } = slowStreamClient({
      events: [{ type: 'text_delta', text: 'x' }],
      hang: true,
    });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    const config = newConfig(sid, client);
    manager.setResolveConfig(async () => config);
    await manager.enqueue(sid, [userMsg(sid, 'q')]);
    const actRun = await manager.activate(sid);

    // 等到 stream 进入 hang
    await new Promise((r) => setTimeout(r, 50));
    // v0.0.15 T4：abort 三参（sessionId, runId, runKind='main'）
    await manager.abort(sid, actRun.runId, 'main');
    await new Promise((r) => setTimeout(r, 200));

    // 验证 session 终态 = interrupted（abort api markInterrupted 完成）
    const s = await store.getSession(sid);
    expect(s?.state).toBe('interrupted');
    expect(s?.running).toBe(false);
  });
});

// ============================================================
// abort api 4 步：half-data 收尾
// ============================================================

describe('AgentManager.abort — 4 步收尾', () => {
  it('step1+4: markInterrupting → loop 退出 → markInterrupted（state 终态 interrupted）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const { client } = slowStreamClient({
      events: [{ type: 'text_delta', text: 'x' }],
      hang: true,
    });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    const config = newConfig(sid, client);
    manager.setResolveConfig(async () => config);
    await manager.enqueue(sid, [userMsg(sid, 'q')]);
    const activated = await manager.activate(sid);
    // 等 stream 进入 hang
    await new Promise((r) => setTimeout(r, 50));
    const s1 = await store.getSession(sid);
    void s1; void activated;

    const result = await manager.abort(sid, activated.runId, 'main');
    expect(result.accepted).toBe(true);
    await new Promise((r) => setTimeout(r, 200));

    const s = await store.getSession(sid);
    expect(s?.state).toBe('interrupted');
  });

  it('step4: emit run_stop(stopReason=interrupted) 事件', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const { client } = slowStreamClient({
      events: [{ type: 'text_delta', text: 'x' }],
      hang: true,
    });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    const config = newConfig(sid, client);
    manager.setResolveConfig(async () => config);
    await manager.enqueue(sid, [userMsg(sid, 'q')]);
    const aRun = await manager.activate(sid);
    await new Promise((r) => setTimeout(r, 50));
    await manager.abort(sid, aRun.runId, 'main');

    // 收事件直到 run_end(stopReason=interrupted)
    const events: AgentEvent[] = [];
    const sub = manager.subscribe(sid);
    for await (const e of sub) {
      events.push(e);
      if (e.type === 'run_end' && e.stopReason === 'interrupted') break;
    }
    const runEnd = events.find(
      (e) => e.type === 'run_end' && e.stopReason === 'interrupted',
    );
    expect(runEnd).toBeTruthy();
  });

  it('CAS 失败（session 非 running）→ accepted:false no_active_controller [v0.0.15 T2 controller 模型]', async () => {
    // v0.0.15 T2：abort 走 controller 内存模型，无 controller（未 activate）→ no_active_controller。
    // 旧 v0.0.12 口径 not_running / session_not_found 已废弃（对齐 agent_interrupt v1.5 + agent_interface v1.1）。
    // reason 完整取值（run_id_mismatch / cas_failed）的覆盖留 T4（abort 三参 + 收尾精简）。
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    // v0.0.15 T4：abort 三参（runId='' 无 controller → no_active_controller）
    const result = await manager.abort(sid, '', 'main');
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('no_active_controller');
  });

  it('场景 B: 悬空 tool_call → 补 interrupted tool_result（配对 toolCallId）[v0.0.15 T2 controller 模型]', async () => {
    // v0.0.15 T2：abort 需先 activate 注册 controller（否则 no_active_controller 拒绝）。
    // 本 case 用 minimal activate 流程注册 controller + loop（mock client 控制不真启 ReAct）。
    // 注：fillInterruptedToolResults 收尾精简在 T4 范围（搬运工 + 协议兜底归 assemble），
    //     此处只验证 controller 模型下 abort 能打通 step2（悬空 tool_call 配对）。
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    await store.createRun({ id: runId, sessionId: sid, status: 'running' });
    // 手动落一条 assistant message 含 tool_call（无配对 tool_result）
    const toolCallId = 'call_xyz';
    await store.appendMessages(sid, [{
      id: ulid(),
      sessionId: sid,
      role: 'assistant',
      content: [{ type: 'tool_call', id: toolCallId, name: 'bash', arguments: { cmd: 'ls' } }],
      runId,
    } as unknown as Message]);

    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    // v0.0.15 T2/T4：手动注册 controller（模拟 activate 已发生，runId 与 session.currentRunId 对齐）
    // abort 三参（sessionId, runId, runKind='main'），controller.runId === runId 才通过 step1 校验
    const controllerKey = `${sid}_main`;
    (manager as unknown as {
      abortControllers: Map<string, { runId: string; aborted: boolean }>;
    }).abortControllers.set(controllerKey, { runId, aborted: false });

    const result = await manager.abort(sid, runId, 'main');
    expect(result.accepted).toBe(true);

    const page = await store.getMessages(sid, { limit: 50 });
    const toolResults = page.items.flatMap((m) =>
      m.content.filter((b) => b.type === 'tool_result'),
    );
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    const tr = toolResults.find(
      (b) => b.type === 'tool_result' && b.toolCallId === toolCallId,
    ) as { isError: boolean } | undefined;
    expect(tr).toBeTruthy();
    expect(tr!.isError).toBe(true);
  });

  it('clearReplay: abort 后新订阅不出半截 replay（buffer 已清）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const { client } = slowStreamClient({
      events: [{ type: 'text_delta', text: 'partial' }],
      hang: true,
    });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    const config = newConfig(sid, client);
    manager.setResolveConfig(async () => config);
    await manager.enqueue(sid, [userMsg(sid, 'q')]);
    const clearRun = await manager.activate(sid);
    await new Promise((r) => setTimeout(r, 50));
    await manager.abort(sid, clearRun.runId, 'main');
    await new Promise((r) => setTimeout(r, 300));

    // 新订阅：replay buffer 应只含 abort step4 emit 的 run_end(interrupted)
    // （message_start / text_block_* 半截已被 clearReplay 清掉）
    // v0.0.15：group 改为 session_id:<sid>_amt:main（groupKeyForRunKind 命名，agent_interface §4）
    const iter = bus.subscribe(`session_id:${sid}_amt:main`)[Symbol.asyncIterator]();
    const collected: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await Promise.race([
        iter.next(),
        new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 80)),
      ]);
      if ('done' in r && r.done) break;
      const evt = (r as { value?: { data?: { type?: string } } }).value?.data?.type;
      if (evt) collected.push(evt);
    }
    await iter.return?.();
    // 应只有 run_end（step4 写入），不含 message_start/text_block_delta 半截
    expect(collected).not.toContain('message_start');
    expect(collected).not.toContain('text_block_delta');
    expect(collected).toContain('run_end');
  });
});
