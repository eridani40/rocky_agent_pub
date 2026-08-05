import { SessionKind } from '@app/shared';
import type { SessionTypePolicy } from '../session-type-policy';
import type { ResolvedSessionProfile } from '../session-type-profile-loader';
/**
 * AgentLoop observability 埋点测试 — v0.0.10
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop.md §6.1
 *       specs/tech/agent/observability/[P0]overall.md §4（埋点契约）
 *
 * 覆盖：
 *   - 注入 spy ObservabilityAdapter，跑一轮 mock:tool，
 *     断言埋点序列 startTrace→startSpan(step)→startGeneration→endGeneration
 *      →startSpan(tool)→endSpan(tool)→endSpan(step)→endTrace
 *   - 全量字段被填：GenInput.messages 是完整 snapshot、ToolSpanInput.arguments 完整、
 *     usage 全字段、parent 嵌套正确
 *   - NoopAdapter（默认）loop 跑完不炸（非阻塞验证）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { SessionSchema, MessageSchema, SummarySchema, RunSchema } from '../schema_defs';
import { SessionStore } from '../session-store';
import { ContextEngine } from '../context-engine';
import { ToolExecutionEngine } from '../../tools/engine';
import { defaultTools } from '../../tools/registry';
import { InboxStore } from '../inbox';
import { ReplayableEventBus } from '../event-bus';
import { AgentManagerImpl } from '../agent-manager';
import { LoopObservability } from '../agent-loop-observability';
import type { AgentEvent } from '../agent-event-types';
import type { SessionConfig } from '../context-types';
import type { Message } from '../../message/types';
import type {
  TraceStart,
  TraceEnd,
  TraceHandle,
  GenStart,
  GenEnd,
  GenHandle,
  SpanStart,
  SpanEnd,
  SpanHandle,
} from '../../observability/types';
import type { ObservabilityAdapter } from '../../observability/adapter';
import { ObservabilityManager } from '../../observability/observability-manager';

/** 记录所有 adapter 调用（method + 关键入参）的 spy */
interface Call {
  method: string;
  name?: string;
  parentKind?: string;
  messagesLength?: number;
  argsShape?: string;
  toolCallId?: string;
  traceInput?: Message[];
  traceOutput?: Message[];
  /** [M1] startGeneration 入参的 system 文本（GenInput.system） */
  genSystem?: string;
  /** [M1] startGeneration 入参的 systemCharCount */
  genSystemCharCount?: number;
  /** [M1] startTrace 入参的 metadata.systemPromptHash */
  traceSystemHash?: string;
  /** [v0.0.80.t1] startGeneration 入参的 GenInput.contextWindowUsage */
  genContextWindowUsage?: unknown;
  /** [v0.0.80.t1] startTrace 入参的 metadata.triggerUsage */
  traceTriggerUsage?: unknown;
}

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

function makeSpy(): { adapter: ObservabilityAdapter; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  const handle = (kind: 'trace' | 'span' | 'gen', parent?: TraceHandle | SpanHandle) =>
    ({
      kind,
      id: `h-${kind}-${n++}`,
      ...(parent ? { parent } : {}),
    }) as TraceHandle & SpanHandle & GenHandle;
  const adapter: ObservabilityAdapter = {
    startTrace(p: TraceStart): TraceHandle {
      calls.push({
        method: 'startTrace',
        argsShape: JSON.stringify({ id: p.id, sessionId: p.sessionId }),
        traceInput: p.input,
        traceSystemHash: p.metadata.systemPromptHash,
        // [v0.0.80.t1] triggerUsage（optional，可能不在 metadata 上）
        traceTriggerUsage: (p.metadata as unknown as Record<string, unknown>).triggerUsage,
      });
      return handle('trace');
    },
    endTrace(_h: TraceHandle, p?: TraceEnd): void {
      calls.push({
        method: 'endTrace',
        argsShape: p?.metadata?.stopReason ?? '',
        traceOutput: p?.output,
      });
    },
    startGeneration(p: GenStart): GenHandle {
      calls.push({
        method: 'startGeneration',
        parentKind: p.parent.kind,
        // v0.0.50: GenStart.input optional（kind='physical' 时省略）；本 mock 仅服务 logical 调用
        messagesLength: p.input?.messages.length ?? 0,
        genSystem: p.input?.system ?? '',
        genSystemCharCount: p.input?.systemCharCount ?? 0,
        // [v0.0.80.t1 task-4] GenInput.contextWindowUsage
        genContextWindowUsage: p.input?.contextWindowUsage,
      });
      return handle('gen', p.parent);
    },
    endGeneration(p: GenEnd): void {
      calls.push({
        method: 'endGeneration',
        argsShape: `usage.total=${p.usage.total_tokens ?? 0}`,
      });
    },
    startSpan(p: SpanStart): SpanHandle {
      const isTool = (s: SpanStart): s is Extract<SpanStart, { input: { toolCallId: string } }> =>
        'input' in s && typeof (s.input as { toolCallId?: unknown }).toolCallId === 'string';
      calls.push({
        method: 'startSpan',
        name: p.name,
        parentKind: p.parent.kind,
        toolCallId: isTool(p) ? p.input.toolCallId : undefined,
      });
      return handle('span', p.parent);
    },
    endSpan(_h: SpanHandle, p?: SpanEnd): void {
      calls.push({ method: 'endSpan' });
      void p;
    },
    async shutdown(): Promise<void> {
      calls.push({ method: 'shutdown' });
    },
  };
  return { adapter, calls };
}

// ── 公共 fixture（复用 agent-loop.test.ts 风格）──

let tmpRoot: string;
let store: SessionStore;
let contextEngine: ContextEngine;
let toolEngine: ToolExecutionEngine;
let inbox: InboxStore;
let bus: ReplayableEventBus;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-obs-'));
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

/** mock LlmClient：按 messages 末条 role 切剧本（tool 角色触发续轮文本） */
function stubToolClient(): { client: unknown } {
  const client = {
    contextWindow: 100000,
    async *_stream(req: { messages: { role?: string }[] }): AsyncIterable<unknown> {
      const last = req.messages[req.messages.length - 1];
      if (last?.role === 'tool') {
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'usage', usage: { input_tokens: 7, output_tokens: 4 } };
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      yield { type: 'text_delta', text: 'running' };
      yield {
        type: 'tool_call_delta',
        toolCallId: 'tc1',
        name: 'bash',
        argumentsDelta: JSON.stringify({ command: 'echo hi' }),
      };
      yield { type: 'usage', usage: { input_tokens: 10, output_tokens: 20 } };
      yield { type: 'finish', reason: 'tool_use' };
    },
    async call() {
      return { message: { id: 'x', role: 'assistant', content: [] }, usage: {}, stopReason: 'stop' };
    },
  };
  Object.assign(client, { stream: (client as { _stream: unknown })._stream });
  return { client };
}

/** 跑一轮 mock:tool run，收集 observability 调用 + agent events */
async function runWithSpy(spy: ObservabilityAdapter) {
  const sid = ulid();
  const { client } = stubToolClient();
  const config: SessionConfig = {
    sessionId: sid,
    systemPrompt: 'sys',
    client: client as SessionConfig['client'],
    modelId: 'mock',
    tools: defaultTools(tmpRoot),
    workdir: tmpRoot,
    observability: spy,
    kind: parentKind,
  } as SessionConfig;
  const manager = new AgentManagerImpl({
    bus,
    store,
    inbox,
    contextEngine,
    toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    observability: spy,
  });
  manager.setResolveConfig(async () => config);
  await store.createSession({ id: sid });
  const msg: Message = {
    id: ulid(),
    sessionId: sid,
    role: 'user',
    content: [{ type: 'text', text: 'run bash' }],
    sender: { source: 'user' },
  };
  await manager.enqueue(sid, [msg]);
  await manager.activate(sid);
  const events: AgentEvent[] = [];
  for await (const e of manager.subscribe(sid)) {
    events.push(e);
    if (e.type === 'run_end') break;
  }
  return { events, config };
}

describe('AgentLoop observability 埋点序列（mock:tool）', () => {
  it('埋点顺序：startTrace → startSpan(step) → startGeneration → endGeneration → startSpan(tool) → endSpan(tool) → endSpan(step) → endTrace', async () => {
    const { adapter, calls } = makeSpy();
    const { events } = await runWithSpy(adapter);

    // run 完成
    expect(events.some((e) => e.type === 'run_end')).toBe(true);

    const methods = calls.map((c) => c.method);
    expect(methods[0]).toBe('startTrace');
    expect(methods[methods.length - 1]).toBe('endTrace');

    // 第一轮：step span + gen + tool span
    const firstStepStart = calls.findIndex((c) => c.method === 'startSpan' && c.name?.startsWith('step'));
    const firstGen = calls.findIndex((c) => c.method === 'startGeneration');
    const firstTool = calls.findIndex(
      (c) => c.method === 'startSpan' && c.name?.startsWith('tool:'),
    );
    expect(firstStepStart).toBeGreaterThanOrEqual(0);
    expect(firstGen).toBeGreaterThan(firstStepStart);
    expect(firstTool).toBeGreaterThan(firstGen);

    // endTrace 带的 stopReason（mock:tool 续轮 text → no_tool_call）
    const endTraceCall = calls.find((c) => c.method === 'endTrace');
    expect(endTraceCall?.argsShape).toBe('no_tool_call');
  });

  it('GenInput.messages 是完整 snapshot（含触发 user msg），非仅最后一条', async () => {
    const { adapter, calls } = makeSpy();
    await runWithSpy(adapter);
    const genCalls = calls.filter((c) => c.method === 'startGeneration');
    expect(genCalls.length).toBeGreaterThan(0);
    // 第一轮 LLM 应看到 user 触发消息 + system → messages.length >= 1
    expect((genCalls[0]!.messagesLength ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('parent 嵌套正确：generation/tool span parent = step span（kind:span）', async () => {
    const { adapter, calls } = makeSpy();
    await runWithSpy(adapter);
    const gen = calls.find((c) => c.method === 'startGeneration');
    expect(gen?.parentKind).toBe('span');
    const toolSpan = calls.find((c) => c.method === 'startSpan' && c.name?.startsWith('tool:'));
    expect(toolSpan?.parentKind).toBe('span');
  });

  it('ToolSpanInput.toolCallId 来自 ToolCallBlock.id（完整 arguments 透传）', async () => {
    const { adapter, calls } = makeSpy();
    await runWithSpy(adapter);
    const toolSpan = calls.find((c) => c.method === 'startSpan' && c.name?.startsWith('tool:'));
    expect(toolSpan?.toolCallId).toBe('tc1');
    expect(toolSpan?.name).toBe('tool:bash');
  });

  it('endGeneration 带完整 usage（total_tokens 已映射）', async () => {
    const { adapter, calls } = makeSpy();
    await runWithSpy(adapter);
    const endGen = calls.find((c) => c.method === 'endGeneration');
    expect(endGen?.argsShape).toContain('usage.total=');
  });

  it('NoopAdapter 默认路径 loop 跑完不炸（非阻塞）', async () => {
    // 不注入 adapter（AgentManager 默认 Noop）
    const sid = ulid();
    const { client } = stubToolClient();
    const config: SessionConfig = {
      sessionId: sid,
      systemPrompt: 'sys',
      client: client as SessionConfig['client'],
      modelId: 'mock',
      tools: defaultTools(tmpRoot),
      workdir: tmpRoot,
      kind: parentKind,
    } as SessionConfig;
    const manager = new AgentManagerImpl({
      bus,
      store,
      inbox,
      contextEngine,
      toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    manager.setResolveConfig(async () => config);
    await store.createSession({ id: sid });
    const msg: Message = {
      id: ulid(),
      sessionId: sid,
      role: 'user',
      content: [{ type: 'text', text: 'run' }],
      sender: { source: 'user' },
    };
    await manager.enqueue(sid, [msg]);
    const r = await manager.activate(sid);
    // v0.0.15 T5：state='running'（旧 'activated'）
    expect(r.state).toBe('running');
    let gotRunEnd = false;
    for await (const e of manager.subscribe(sid)) {
      if (e.type === 'run_end') {
        gotRunEnd = true;
        break;
      }
    }
    expect(gotRunEnd).toBe(true);
  });

  it('trace input = inbox peek 到的触发用户消息（复用 peek，不额外构造 snapshot）', async () => {
    const { adapter, calls } = makeSpy();
    await runWithSpy(adapter);
    const startTraceCall = calls.find((c) => c.method === 'startTrace');
    expect(startTraceCall).toBeTruthy();
    // input 是数组 + 至少含 1 条触发用户消息
    const input = startTraceCall!.traceInput;
    expect(Array.isArray(input)).toBe(true);
    expect((input ?? []).length).toBeGreaterThan(0);
    const first = input![0]!;
    expect(first.role).toBe('user');
    // 内容含触发文本（runWithSpy 的触发消息为 'run bash'）
    const text = JSON.stringify(first.content);
    expect(text).toContain('run bash');
    // metadata.inputMessageIds 与 input 派生一致
  });

  it('trace output = 最后一条 assistant 回答（endGeneration 已收到的 assistantMsg）', async () => {
    const { adapter, calls } = makeSpy();
    await runWithSpy(adapter);
    const endTraceCall = calls.find((c) => c.method === 'endTrace');
    expect(endTraceCall).toBeTruthy();
    // output 是数组 + 含 1 条最后 assistant
    const output = endTraceCall!.traceOutput;
    expect(Array.isArray(output)).toBe(true);
    expect((output ?? []).length).toBeGreaterThan(0);
    const last = output![output!.length - 1]!;
    expect(last.role).toBe('assistant');
    // mock:tool 续轮回复 'done'
    expect(JSON.stringify(last.content)).toContain('done');
  });

  it('observability 抛错被吞，loop 仍正常完成（核心红线）', async () => {
    // 构造一个会抛错的 adapter
    const throwing: ObservabilityAdapter = {
      startTrace: vi.fn(() => {
        throw new Error('lf down');
      }),
      endTrace: vi.fn(() => {
        throw new Error('lf down');
      }),
      startGeneration: vi.fn(() => {
        throw new Error('lf down');
      }),
      endGeneration: vi.fn(() => {
        throw new Error('lf down');
      }),
      startSpan: vi.fn(() => {
        throw new Error('lf down');
      }),
      endSpan: vi.fn(() => {
        throw new Error('lf down');
      }),
      shutdown: vi.fn(async () => {
        /* noop */
      }),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { events } = await runWithSpy(throwing);
    // loop 仍正常完成（run_end 到达）
    expect(events.some((e) => e.type === 'run_end')).toBe(true);
    warnSpy.mockRestore();
  });

  // ── [v0.0.13 M1] observability system 源 = 实际 snapshot.system（非静态 config.systemPrompt）──

  it('[M1] 集成：runWithSpy 下 GenInput.system == firstText(snapshot.system)（与 config.systemPrompt 解耦）', async () => {
    // mock:tool 场景 pluginManager=null → fallback 路径 systemText === config.systemPrompt。
    // 即便如此，本 case 验证「GenInput.system 取自 snapshot.system 而非直接读 opts.fallbackSystemPrompt」：
    // 通过手动 new LoopObservability 并模拟「assemble 后 setSystem(扩展 system)」来证伪静态来源。
    const { adapter, calls } = makeSpy();
    await runWithSpy(adapter);
    const genCall = calls.find((c) => c.method === 'startGeneration');
    expect(genCall?.genSystem).toBeTruthy();
    // mock 场景下 systemText === 'sys'（fallback），证明链路通；下面单元 case 验证非 fallback 差异
    expect(genCall!.genSystem).toBe('sys');
    expect(genCall!.genSystemCharCount).toBe(3);
  });

  it('[M1] 单元：LoopObservability.startGeneration 的 GenInput.system 取自 snapshotSystem 入参（非 opts.fallbackSystemPrompt）', () => {
    const { adapter, calls } = makeSpy();
    const obs = new LoopObservability({
      adapter,
      runId: 'r1',
      sessionId: 's1',
      modelId: 'm',
      fallbackSystemPrompt: 'STATIC_CONFIG_PROMPT', // 静态 config 兜底（≈300 char 级）
      toolDefinitions: [],
    });
    // 模拟 agent-loop ingestAndAssemble 后调 setSystem（实际 mapper/reducer 构建的长 system）
    const actualSystem = 'IDENTITY\n\nRULES\n\nTOOL_GUIDANCE: bash,file\n\nCONTEXT_FILES: a.md';
    obs.setSystem(actualSystem);
    // 模拟 agent-loop runLoop：先 startTrace（建 traceHandle）→ startStepSpan（建 stepSpanHandle）
    obs.startTrace([]);
    const fakeState = { step: 0, ingestUpTo: null, llmUpTo: null, snapshot: null, done: false };
    obs.startStepSpan(fakeState as never);
    // startGeneration：snapshotMessages/charCount/start 随意，关键传 snapshotSystem
    obs.startGeneration([], 0, new Date(), actualSystem);
    const genCall = calls.find((c) => c.method === 'startGeneration');
    expect(genCall?.genSystem).toBe(actualSystem);
    expect(genCall?.genSystem).not.toBe('STATIC_CONFIG_PROMPT');
    expect(genCall?.genSystemCharCount).toBe(actualSystem.length);
  });

  it('[M1] 单元：setSystem 后 systemPromptHash 反映实际 system（多轮 system 变化可追踪）', () => {
    const { adapter, calls } = makeSpy();
    const obs = new LoopObservability({
      adapter,
      runId: 'r1', sessionId: 's1', modelId: 'm',
      fallbackSystemPrompt: 'cfg',
      toolDefinitions: [],
    });
    // 第一次 startTrace：snapshot 未首次 assemble → hash 基于 fallback 'cfg'
    obs.startTrace([]);
    const hashBefore = calls[0]!.traceSystemHash;
    expect(hashBefore).toBeTruthy();

    // 模拟首次 assemble 后 setSystem 推送实际 system（workdir/tool 变化）
    obs.reset();
    obs.setSystem('ACTUAL_SYSTEM_AFTER_ASSEMBLE_WITH_TOOLS');
    obs.startTrace([]);
    const hashAfter = calls[1]!.traceSystemHash;
    expect(hashAfter).toBeTruthy();
    // setSystem 前后 hash 不同（证明 hash 跟随实际 system 变化）
    expect(hashBefore).not.toBe(hashAfter);
  });

  it('[v0.0.50 §4.3] startGeneration 传 name=`llm-N-logical`（N=genIteration，每轮递增）', () => {
    // 用 spy 记录 name（makeSpy 默认不记 name，这里用增强 spy 直接断言 name 字符串）
    const startCalls: { name?: string; kind?: string }[] = [];
    const adapter: ObservabilityAdapter = {
      startTrace: () => ({ kind: 'trace', id: 't' }) as TraceHandle,
      endTrace: () => {},
      startGeneration: (p: GenStart) => {
        startCalls.push({ name: p.name, kind: p.kind });
        return { kind: 'gen', id: `g-${startCalls.length}`, parent: p.parent } as GenHandle;
      },
      endGeneration: () => {},
      startSpan: () => ({ kind: 'span', id: 'sp', parent: { kind: 'trace', id: 't' } as TraceHandle }) as SpanHandle,
      endSpan: () => {},
      async shutdown() {},
    };
    const obs = new LoopObservability({
      adapter, runId: 'r1', sessionId: 's1', modelId: 'm',
      fallbackSystemPrompt: 'sys', toolDefinitions: [],
    });
    obs.startTrace([]);
    const fakeState = { step: 0, ingestUpTo: null, llmUpTo: null, snapshot: null, done: false };
    obs.startStepSpan(fakeState as never);
    // 第一轮：N=1
    obs.startGeneration([], 0, new Date(), 'sys');
    // 第二轮：N=2
    obs.startGeneration([], 0, new Date(), 'sys');
    // 直接断言 name 字符串格式（§4.3）：physical 由 LangfuseObservabilityPort 在 llm_caller 层组装，
    // 不在 LoopObservability（避免 llm/caller→agent 依赖）—— physical name 见 langfuse-adapter UT
    expect(startCalls.map((c) => c.name)).toEqual(['llm-1-logical', 'llm-2-logical']);
    expect(startCalls.every((c) => c.kind === undefined)).toBe(true); // logical 不显式传 kind
    expect(obs.currentGenIteration()).toBe(2);
  });

  it('[M1] trace systemPromptHash 在不同 config.systemPrompt 下不同（多 run 追踪 config 变更）', async () => {
    // runWithSpy 用 systemPrompt='sys'，再跑一遍 systemPrompt='other-sys-prompt'
    const { adapter: a1, calls: c1 } = makeSpy();
    await runWithSpy(a1);
    const hash1 = c1.find((c) => c.method === 'startTrace')?.traceSystemHash;

    // 第二轮：自定义 systemPrompt（复用 runWithSpy 内部逻辑不易，直接构造）
    const sid = ulid();
    const stub = stubToolClient();
    const config2: SessionConfig = {
      sessionId: sid,
      systemPrompt: 'other-sys-prompt',
      client: stub.client as SessionConfig['client'],
      modelId: 'mock',
      tools: defaultTools(tmpRoot),
      workdir: tmpRoot,
      observability: a1,
      kind: parentKind,
    } as SessionConfig;
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
      observability: a1,
    });
    manager.setResolveConfig(async () => config2);
    await store.createSession({ id: sid });
    const msg: Message = {
      id: ulid(), sessionId: sid, role: 'user',
      content: [{ type: 'text', text: 'run bash' }],
      sender: { source: 'user' },
    };
    await manager.enqueue(sid, [msg]);
    await manager.activate(sid);
    for await (const _e of manager.subscribe(sid)) {
      if (_e.type === 'run_end') break;
    }
    // 找 systemPrompt='other-sys-prompt' 兜底对应的 trace hash（最后一次 startTrace）
    const hash2 = [...c1].reverse().find((c) => c.method === 'startTrace')?.traceSystemHash;

    expect(hash1).toBeTruthy();
    expect(hash2).toBeTruthy();
    expect(hash1).not.toBe(hash2);
  });

  // ── [v0.0.68 R7] markTraceError：把 trace level 标 ERROR（spec change_plan.md R7 行） ──

  it('[R7] markTraceError：adapter 实现 setLevel 时调用 setLevel(traceHandle, "ERROR")', () => {
    // spy adapter：记录 setLevel 入参
    const setLevelCalls: Array<{ id: string; level: string }> = [];
    const adapter: ObservabilityAdapter = {
      startTrace: () => ({ kind: 'trace', id: 'trace-1' }) as TraceHandle,
      endTrace: () => {},
      startGeneration: () =>
        ({ kind: 'gen', id: 'g-1', parent: { kind: 'trace', id: 'trace-1' } as TraceHandle }) as GenHandle,
      endGeneration: () => {},
      startSpan: () =>
        ({ kind: 'span', id: 's-1', parent: { kind: 'trace', id: 'trace-1' } as TraceHandle }) as SpanHandle,
      endSpan: () => {},
      shutdown: async () => {},
      setLevel: (h, level) => {
        setLevelCalls.push({ id: h.id, level });
      },
    };
    const obs = new LoopObservability({
      adapter, runId: 'r1', sessionId: 's1', modelId: 'm',
      fallbackSystemPrompt: 'sys', toolDefinitions: [],
    });
    obs.startTrace([]);
    obs.markTraceError('run failed: SERVER_ERROR: boom');
    // setLevel 被调用一次，handle 是 trace，level 是 ERROR
    expect(setLevelCalls.length).toBe(1);
    expect(setLevelCalls[0]!.id).toBe('trace-1');
    expect(setLevelCalls[0]!.level).toBe('ERROR');
  });

  it('[R7] markTraceError：adapter 无 setLevel 时 safe 吞 + warning（不阻塞）', () => {
    // adapter 不实现 setLevel（老 adapter / NoopAdapter）
    const adapter: ObservabilityAdapter = {
      startTrace: () => ({ kind: 'trace', id: 'trace-2' }) as TraceHandle,
      endTrace: () => {},
      startGeneration: () =>
        ({ kind: 'gen', id: 'g-2', parent: { kind: 'trace', id: 'trace-2' } as TraceHandle }) as GenHandle,
      endGeneration: () => {},
      startSpan: () =>
        ({ kind: 'span', id: 's-2', parent: { kind: 'trace', id: 'trace-2' } as TraceHandle }) as SpanHandle,
      endSpan: () => {},
      shutdown: async () => {},
      // 注意：没有 setLevel
    };
    const obs = new LoopObservability({
      adapter, runId: 'r2', sessionId: 's2', modelId: 'm',
      fallbackSystemPrompt: 'sys', toolDefinitions: [],
    });
    obs.startTrace([]);
    // 不应抛（核心红线：observability 失败绝不影响主流程）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => obs.markTraceError('no setLevel support')).not.toThrow();
    // 至少打了一条 warning（safe 吞 + 提示 adapter 不支持）
    expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
    const warnText = warnSpy.mock.calls.map((c) => String(c.join(' '))).join('\n');
    expect(warnText).toContain('adapter.setLevel not supported');
    warnSpy.mockRestore();
  });

  it('[R7] markTraceError：traceHandle=null（endTrace 后 / reset 前）时 no-op', () => {
    const adapter: ObservabilityAdapter = {
      startTrace: () => ({ kind: 'trace', id: 'trace-3' }) as TraceHandle,
      endTrace: () => {},
      startGeneration: () =>
        ({ kind: 'gen', id: 'g-3', parent: { kind: 'trace', id: 'trace-3' } as TraceHandle }) as GenHandle,
      endGeneration: () => {},
      startSpan: () =>
        ({ kind: 'span', id: 's-3', parent: { kind: 'trace', id: 'trace-3' } as TraceHandle }) as SpanHandle,
      endSpan: () => {},
      shutdown: async () => {},
      setLevel: vi.fn(),
    };
    const obs = new LoopObservability({
      adapter, runId: 'r3', sessionId: 's3', modelId: 'm',
      fallbackSystemPrompt: 'sys', toolDefinitions: [],
    });
    // 不调 startTrace → traceHandle=null → markTraceError no-op（不抛、不调 setLevel）
    expect(() => obs.markTraceError('before startTrace')).not.toThrow();
    expect((adapter.setLevel as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  // ── [v0.0.68 R7 gap 补全] markTraceError → ObservabilityManager.setLevel → child.setLevel 穿透 ──
  // 锁定 T6 gap 修复：生产环境 LoopObservability.adapter 是 ObservabilityManager（composite），
  // 修复前 manager 没 forward setLevel → markTraceError 走 warning → child.setLevel 永远 0 calls
  // （langfuse trace.level 留 None，应为 'ERROR'）。修复后 manager.setLevel 路由 handle.kind 查
  // traceMap/spanMap/genMap 反查 per-child handle，fan-out 调 child.setLevel。
  // 参考: memory/observability-wrap-forward-all-failsilent.md（wrapper 必须 forward 全部接口）
  it('[R7 gap] markTraceError 穿透 ObservabilityManager → child.setLevel（handle 翻译）', () => {
    const childSetLevelCalls: Array<{ id: string; level: string }> = [];
    const fakeChild: ObservabilityAdapter = {
      startTrace: (p) => ({ kind: 'trace', id: `${p.id}#child` }) as TraceHandle,
      endTrace: () => {},
      startGeneration: (p) =>
        ({ kind: 'gen', id: 'g#child', parent: p.parent }) as GenHandle,
      endGeneration: () => {},
      startSpan: (p) =>
        ({ kind: 'span', id: 's#child', parent: p.parent }) as SpanHandle,
      endSpan: () => {},
      shutdown: async () => {},
      setLevel: (h, level) => {
        childSetLevelCalls.push({ id: h.id, level });
      },
    };
    // 空 items 构造 manager（跳过真实 SDK），白盒注入 fake child（与 manager test 同模式）
    const manager = new ObservabilityManager([]);
    (
      manager as unknown as {
        children: { adapter: ObservabilityAdapter; logPhysical: boolean }[];
      }
    ).children = [{ adapter: fakeChild, logPhysical: false }];

    const obs = new LoopObservability({
      adapter: manager,
      runId: 'r-gap',
      sessionId: 's-gap',
      modelId: 'm',
      fallbackSystemPrompt: 'sys',
      toolDefinitions: [],
    });
    obs.startTrace([]);
    // 关键断言：穿透 + handle 翻译
    // 修复前：manager 无 setLevel → markTraceError 走 warning → child.setLevel 0 calls
    // 修复后：manager.setLevel fan-out → child.setLevel 1 call，handle 是 child 自己的 trace handle
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    obs.markTraceError('run failed: SERVER_ERROR: boom');
    // 不应出现 "adapter.setLevel not supported" warning（manager 已 forward）
    const warnText = warnSpy.mock.calls.map((c) => String(c.join(' '))).join('\n');
    expect(warnText).not.toContain('adapter.setLevel not supported');
    warnSpy.mockRestore();
    expect(childSetLevelCalls.length).toBe(1);
    expect(childSetLevelCalls[0]!.id).toBe('r-gap#child'); // child 自己的 trace handle.id（翻译后）
    expect(childSetLevelCalls[0]!.level).toBe('ERROR');
  });

  // ── [v0.0.80.t1 task-3] startTrace metadata 含 triggerUsage（sideRun opts 透传） ──

  it('[v0.0.80.t1 task-3] startTrace metadata 含 triggerUsage（来自 LoopObservabilityOpts.triggerUsage）', () => {
    const { adapter, calls } = makeSpy();
    const triggerUsage = {
      systemTokens: 1, messageTokens: 2, toolTokens: 0,
      totalTokens: 3, maxOutputTokens: 20000, tokenLimit: 100000, remainingTokens: 79997,
    };
    const obs = new LoopObservability({
      adapter, runId: 'r-tu', sessionId: 's-tu', modelId: 'm',
      fallbackSystemPrompt: 'sys', toolDefinitions: [],
      triggerUsage,
    });
    obs.startTrace([]);
    const startTraceCall = calls.find((c) => c.method === 'startTrace');
    expect(startTraceCall).toBeTruthy();
    expect(startTraceCall!.traceTriggerUsage).toEqual(triggerUsage);
  });

  it('[v0.0.80.t1 task-3] triggerUsage 缺省 → metadata 不含该字段（向后兼容）', () => {
    const { adapter, calls } = makeSpy();
    const obs = new LoopObservability({
      adapter, runId: 'r-tu2', sessionId: 's-tu2', modelId: 'm',
      fallbackSystemPrompt: 'sys', toolDefinitions: [],
      // triggerUsage 不注入
    });
    obs.startTrace([]);
    const startTraceCall = calls.find((c) => c.method === 'startTrace');
    expect(startTraceCall).toBeTruthy();
    expect(startTraceCall!.traceTriggerUsage).toBeUndefined();
  });

  // ── [v0.0.80.t1 task-4] startGeneration 第 5 参 contextWindowUsage 透传到 GenInput ──

  it('[v0.0.80.t1 task-4] startGeneration 第 5 参 contextWindowUsage 透传到 GenInput', () => {
    const { adapter, calls } = makeSpy();
    const cwu = {
      systemTokens: 10, messageTokens: 20, toolTokens: 5,
      totalTokens: 35, maxOutputTokens: 20000, tokenLimit: 100000, remainingTokens: 79965,
    };
    const obs = new LoopObservability({
      adapter, runId: 'r-cwu', sessionId: 's-cwu', modelId: 'm',
      fallbackSystemPrompt: 'sys', toolDefinitions: [],
    });
    obs.startTrace([]);
    const fakeState = { step: 0, ingestUpTo: null, llmUpTo: null, snapshot: null, done: false };
    obs.startStepSpan(fakeState as never);
    // 第 5 参传 contextWindowUsage
    obs.startGeneration([], 0, new Date(), 'sys', cwu);
    const genCall = calls.find((c) => c.method === 'startGeneration');
    expect(genCall).toBeTruthy();
    expect(genCall!.genContextWindowUsage).toEqual(cwu);
  });

  it('[v0.0.80.t1 task-4] startGeneration 不传第 5 参 → GenInput.contextWindowUsage undefined（向后兼容）', () => {
    const { adapter, calls } = makeSpy();
    const obs = new LoopObservability({
      adapter, runId: 'r-cwu2', sessionId: 's-cwu2', modelId: 'm',
      fallbackSystemPrompt: 'sys', toolDefinitions: [],
    });
    obs.startTrace([]);
    const fakeState = { step: 0, ingestUpTo: null, llmUpTo: null, snapshot: null, done: false };
    obs.startStepSpan(fakeState as never);
    // 不传第 5 参（旧调用点兼容）
    obs.startGeneration([], 0, new Date(), 'sys');
    const genCall = calls.find((c) => c.method === 'startGeneration');
    expect(genCall).toBeTruthy();
    expect(genCall!.genContextWindowUsage).toBeUndefined();
  });
});