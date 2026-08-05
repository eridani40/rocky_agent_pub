/**
 * 旁路 run loop 单元测试 — buildRunDeps（summary/consolidate）+ runReActLoop（v0.0.204 T3 重写）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md（§2 §4 旁路 run 列）
 *       specs/tech/agent/session/[P0]session_type_profile.md §3（profile 字段驱动装配）
 *
 * v0.0.204 T3：buildForkedDeps → buildRunDeps（profile 驱动单装配；forked 命名退役）。
 *
 * 覆盖（核心场景）：
 *   - system 注入（buffer 前缀）+ reminder + userMessage 三条 messages
 *   - toolDefinitions=snapshot.tools 复用（cache 契约）
 *   - 多轮 ReAct（maxIter>1）：tool_call → execute → 第二轮 no_tool_call
 *   - emit 默认开 / emit:false 静音
 *   - 中断（controller.aborted=true → stopReason=interrupted）
 *   - allowedTools 透传 toolEngine.execute 第三参
 */
import { describe, it, expect, vi } from 'vitest';
import { buildRunDeps } from '../build-run-deps';
import type { BuildRunDepsOpts } from '../build-run-deps';
import type { SessionTypePolicy } from '../session-type-policy';
import type { ResolvedSessionProfile } from '../session-type-profile-loader';
import { SessionKind } from '@app/shared';
import type { SessionConfig, ContextSnapshot } from '../context-types';
import type { Message, Usage } from '../../message/types';
import type { LlmClient } from '../../llm/client';
import type { CanonicalRequest, StreamEvent } from '../../llm/protocol';
import type { AgentEvent } from '../agent-event-types';
import type { ToolExecutionEngine } from '../../tools/engine';
import type { ToolResultBlock } from '../../message/types';
import type { ReplayableEventBus } from '../event-bus';
import type { ContextEngine } from '../context-engine';
import type { SessionStore } from '../session-store';
import type { AbortControllerHandle } from '../agent-interface';

/** mock 流式 LlmClient：每个 call 产出一个 assistant message（text 或 text+tool_use） */
function mockStreamClient(opts: {
  responses?: { text?: string; toolCalls?: { id: string; name: string; input: unknown }[] }[];
  answer?: string;
  usage?: Usage;
}): { client: LlmClient; calls: CanonicalRequest[] } {
  const calls: CanonicalRequest[] = [];
  const responses = opts.responses ?? [{ text: opts.answer ?? 'summary text' }];
  let callIdx = 0;
  const streamFn = vi.fn((req: CanonicalRequest): AsyncIterable<StreamEvent> => {
    calls.push(req);
    const resp = responses[Math.min(callIdx, responses.length - 1)]!;
    callIdx++;
    const events: StreamEvent[] = [];
    const messageId = `msg-${callIdx}`;
    events.push({ type: 'message_start', messageId, role: 'assistant' } as unknown as StreamEvent);
    if (resp.text) {
      events.push({ type: 'text_delta', messageId, text: resp.text } as unknown as StreamEvent);
    }
    if (resp.toolCalls) {
      for (const tc of resp.toolCalls) {
        events.push(
          { type: 'tool_call_delta', messageId, toolCallId: tc.id, name: tc.name, argumentsDelta: JSON.stringify(tc.input) } as unknown as StreamEvent,
        );
      }
    }
    events.push({ type: 'usage', usage: opts.usage ?? { total_tokens: 10 } } as unknown as StreamEvent);
    events.push({ type: 'finish', stopReason: resp.toolCalls ? 'tool_use' : 'stop' } as unknown as StreamEvent);
    return (async function* () {
      for (const e of events) yield e;
    })();
  });
  const fake = { stream: streamFn, call: vi.fn(), contextWindow: 100000 };
  return { client: fake as unknown as LlmClient, calls };
}

/** mock ToolExecutionEngine：返固定 tool_result，捕获 allowedTools 透传 */
function mockToolEngine(): {
  engine: ToolExecutionEngine;
  calls: { toolCalls: { id: string; name: string }[]; allowedTools?: string[] }[];
} {
  const calls: { toolCalls: { id: string; name: string }[]; allowedTools?: string[] }[] = [];
  const executeFn = vi.fn(
    async (
      _config: unknown,
      toolCalls: { id: string; name: string }[],
      allowedTools?: string[],
    ): Promise<{ results: ToolResultBlock[]; pending: never[] }> => {
      calls.push({
        toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name })),
        allowedTools,
      });
      return {
        results: toolCalls.map((c) => ({
          type: 'tool_result' as const,
          toolCallId: c.id,
          content: [{ type: 'text' as const, text: 'tool-result' }],
          isError: false,
        })),
        pending: [],
      };
    },
  );
  return { engine: { execute: executeFn } as unknown as ToolExecutionEngine, calls };
}

/** 内存 ReplayableEventBus（收 emit 事件） */
function mockBus(): { bus: ReplayableEventBus; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const bus = {
    emit(_group: string, e: { data: AgentEvent; timestamp: string }) {
      events.push(e.data);
    },
    subscribe: vi.fn(),
    clearReplay: vi.fn(),
    isReplayable: () => false,
  };
  return { bus: bus as unknown as ReplayableEventBus, events };
}

/** mock SessionStore（旁路 profile usagePartition='summary' → onUsage 早退零调用；仅 getMessages 被 assemble 用） */
function mockStore(): { store: SessionStore } {
  const store = {
    getMessages: async () => ({ items: [] as Message[] }),
  };
  return { store: store as unknown as SessionStore };
}

/** mock ContextEngine（旁路 run：骨架直调 ingest/assemble；in_memory store 模拟） */
function mockContextEngine(): { ce: ContextEngine } {
  const ingested: Message[] = [];
  const ce = {
    ingest: vi.fn(async (_cfg: unknown, msgs: Message[]) => { ingested.push(...msgs); }),
    assemble: vi.fn(async () => ({ ...SNAPSHOT_FOR_MOCK, messages: ingested.slice() })),
    getCleanSnapshot: vi.fn(async (snap: ContextSnapshot) => snap),
    getSideRunner: vi.fn(() => null),
    getConsolidateRunner: vi.fn(() => null),
    getPluginManager: vi.fn(() => null),
    getStateMachine: vi.fn(() => undefined),
    getTaskLock: vi.fn(() => undefined),
    clearScopeSession: vi.fn(async () => { ingested.length = 0; }),
  };
  return { ce: ce as unknown as ContextEngine };
}

/** 构造 SessionConfig */
function newConfig(client: LlmClient): SessionConfig {
  return {
    sessionId: 'test-session',
    systemPrompt: 'ignored-by-side-run',
    client,
    modelId: 'test-model',
  } as SessionConfig;
}

/** 构造 ContextSnapshot */
function newSnapshot(systemText: string, messages: Message[]): ContextSnapshot {
  return {
    system: { id: 'sys-1', sessionId: 'test-session', role: 'system', content: [{ type: 'text', text: systemText }] },
    messages,
    inputCharCount: 0,
    contextWindowUsage: {
      systemTokens: 0, messageTokens: 0, toolTokens: 0, totalTokens: 0,
      maxOutputTokens: 20000, tokenLimit: 100000, remainingTokens: 80000,
    },
    summary: null,
    tools: [],
  };
}

const SNAPSHOT_FOR_MOCK: ContextSnapshot = newSnapshot('sys', []);

/** summary profile mock（drainMode='none' / persistsRun=false / touchesStateMachine=false / maxIterDefault=1） */
function mockSummaryPolicy(maxIterDefault = 1, toolBound: string[] = []): SessionTypePolicy {
  const profile: ResolvedSessionProfile = {
    id: 'playground-rocky:parent:summary',
    enabled: true,
    toolBound,
    toolDefinitionsSource: 'host-snapshot',
    runShape: {
      drainMode: 'none', backgroundPath: true, maxIterDefault,
      touchesStateMachine: false, persistsRun: false, usagePartition: 'summary',
    },
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
    resolveToolSet: vi.fn(() => ({ tools: [], toolDefinitions: [], allowedTools: toolBound })),
  };
}

const summaryKind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'summary' });

/** 构造完整 BuildRunDepsOpts（summary run；含默认 controller/bus/toolEngine/store/contextEngine） */
function newDepsOpts(overrides: Partial<BuildRunDepsOpts> & { maxIter?: number; toolBound?: string[] } = {}): BuildRunDepsOpts {
  const mock = mockStreamClient({ answer: 'x' });
  const { engine } = mockToolEngine();
  const { bus } = mockBus();
  const { store } = mockStore();
  const { ce } = mockContextEngine();
  const controller: AbortControllerHandle = { runId: 'run-1', aborted: false };
  const { maxIter = 1, toolBound = [], ...rest } = overrides;
  return {
    config: newConfig(mock.client),
    bus,
    store,
    contextEngine: ce,
    toolEngine: engine,
    controller,
    runId: 'run-1',
    kind: summaryKind,
    sessionTypePolicy: mockSummaryPolicy(maxIter, toolBound),
    snapshot: newSnapshot('sys', []),
    userMessage: { id: 'task-1', sessionId: 'test-session', role: 'user', content: [{ type: 'text', text: 'summarize' }] },
    ...rest,
  };
}

/** 跑旁路 run loop（buildRunDeps + loop.start），返回 RunResult */
async function runSummary(opts: BuildRunDepsOpts): Promise<{ answer: string; stopReason: string; rounds: number }> {
  const { loop } = buildRunDeps(opts);
  const result = await loop.start() as { answer: string; stopReason: string; rounds: number };
  return result;
}

// ============================================================
// 旁路 run via buildRunDeps — 基本行为
// ============================================================

describe('旁路 run (buildRunDeps + runReActLoop) — 基本行为', () => {
  it('单次 maxIter=1 + 纯文本 → no_tool_call 退出；system 注入（buffer 前缀）', async () => {
    const { client, calls } = mockStreamClient({ answer: 'hi' });
    const opts = newDepsOpts({ config: newConfig(client) });
    const result = await runSummary(opts);
    expect(result.answer).toBe('hi');
    expect(result.stopReason).toBe('no_tool_call');
    expect(result.rounds).toBe(0);
    expect(calls).toHaveLength(1);
    // 首条 message 是 system（snapshot 注入：buffer 前缀 = snapshot.system）
    expect(calls[0]!.messages[0]!.role).toBe('system');
    // system + sideRunReminder(user) + userMessage(user) = 3 条
    expect(calls[0]!.messages.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    const reminderText = (calls[0]!.messages[1]!.content[0] as { text: string }).text;
    expect(reminderText).toContain('side run');
  });
});

describe('旁路 run — toolDefinitions 复用 snapshot.tools', () => {
  it('toolDefinitions=[] → CanonicalRequest 不含 tools 字段', async () => {
    const { client, calls } = mockStreamClient({ answer: 'x' });
    const opts = newDepsOpts({ config: newConfig(client) });
    await runSummary(opts);
    expect(calls[0]!.tools).toBeUndefined();
  });

  it('snapshot.tools 非空 → CanonicalRequest.tools 透传', async () => {
    const { client, calls } = mockStreamClient({ answer: 'x' });
    const fakeTool = { name: 'save_memory', description: 'd', inputSchema: {} };
    const opts = newDepsOpts({
      config: newConfig(client),
      snapshot: { ...newSnapshot('sys', []), tools: [fakeTool] },
    });
    await runSummary(opts);
    expect(calls[0]!.tools).toEqual([fakeTool]);
  });
});

describe('旁路 run — 多轮 ReAct（maxIter>1）', () => {
  it('LLM 产 tool_call → 执行 tool → 第二轮 LLM 返纯文本 → no_tool_call 退出', async () => {
    const { client, calls } = mockStreamClient({
      responses: [
        { toolCalls: [{ id: 'tc1', name: 'search', input: { q: 'x' } }] },
        { text: 'final answer' },
      ],
    });
    const { engine, calls: toolEngineCalls } = mockToolEngine();
    const opts = newDepsOpts({
      config: newConfig(client),
      toolEngine: engine,
      maxIter: 2,
      toolBound: ['search'],
      snapshot: { ...newSnapshot('sys', []), tools: [{ name: 'search', description: 'd', inputSchema: {} }] },
    });
    const result = await runSummary(opts);
    expect(result.answer).toBe('final answer');
    expect(result.rounds).toBe(1);
    expect(result.stopReason).toBe('no_tool_call');
    expect(calls).toHaveLength(2);
    expect(toolEngineCalls).toHaveLength(1);
    expect(toolEngineCalls[0]!.allowedTools).toEqual(['search']);
  });
});

describe('旁路 run — emit 开关（profile.eventChannel.emitDefault）', () => {
  it('emit:true（默认）→ bus 收到 run_start + message_start + message_end', async () => {
    const { client } = mockStreamClient({ answer: 'x' });
    const { bus, events } = mockBus();
    const opts = newDepsOpts({ config: newConfig(client), bus });
    await runSummary(opts);
    const types = events.map((e) => e.type);
    expect(types).toContain('run_start');
    expect(types).toContain('message_start');
    expect(types).toContain('message_end');
    const runStart = events.find((e) => e.type === 'run_start')!;
    expect(runStart.runKind).toBe('summary');
  });

  it('emit:false → bus 不收任何事件', async () => {
    const { client } = mockStreamClient({ answer: 'x' });
    const { bus, events } = mockBus();
    const opts = newDepsOpts({ config: newConfig(client), bus, emit: false });
    await runSummary(opts);
    expect(events).toHaveLength(0);
  });
});

describe('旁路 run — 中断（controller.aborted）', () => {
  it('run 前已 aborted → loop 立即退出，stopReason=interrupted', async () => {
    const { client, calls } = mockStreamClient({ answer: 'x' });
    const controller: AbortControllerHandle = { runId: 'run-1', aborted: true };
    const opts = newDepsOpts({ config: newConfig(client), controller });
    const result = await runSummary(opts);
    expect(result.stopReason).toBe('interrupted');
    expect(result.rounds).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
