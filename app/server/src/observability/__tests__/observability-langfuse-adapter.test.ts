/**
 * Observability 单测 — LangfuseAdapter + factory。
 * 从 observability.test.ts 拆分而来（v0.0.10：原文件 345 行 > 300 硬规，按主题分文件）。
 *
 * 本文件覆盖：
 *   (b) LangfuseAdapter：prototype spy 模拟 SDK，验证 startTrace/startSpan/startGeneration
 *       字段映射（mapUsageDetails、metadata、嵌套 parent、isError→level:ERROR）；SDK 抛错被吞。
 *   (c) factory：dev_config + singleton + shutdown。
 *
 * ENV 激活路径见 observability-noop.test.ts（[v0.0.11] ENV 兜底已移除，旧 env.test.ts 删除）。
 *
 * flaky 修复（BUG-001）：原 vi.mock('langfuse') 在 bun runtime 全量并发下对 npm 包
 * langfuse 拦截失效。改用 prototype monkey-patch：直接替换 Langfuse.prototype.trace /
 * shutdownAsync，每 it 在 beforeEach 重设、afterEach restore。bun/node runtime 下都稳定。
 *
 * 参考: specs/tech/agent/observability/[P0]overall.md §6/§7
 *       specs/tech/agent/observability/[P0]langfuse_adapter.md §4/§5/§6
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Langfuse } from 'langfuse';
import type { Usage } from '../../message/types';

type SpyFn = ReturnType<typeof vi.fn>;
interface ObsMock {
  update: SpyFn;
  span: SpyFn;
  generation: SpyFn;
}
type Call = { method: string; args: unknown[] };

/** calls 容器（module-level，beforeEach 清空） */
const calls: Call[] = [];

/** 递归构造 observation mock：span/generation 返回新 ObsMock */
function makeObs(): ObsMock {
  return {
    update: vi.fn((p: unknown) => calls.push({ method: 'obs.update', args: [p] })),
    span: vi.fn((p: unknown) => {
      calls.push({ method: 'obs.span', args: [p] });
      return makeObs();
    }),
    generation: vi.fn((p: unknown) => {
      calls.push({ method: 'obs.generation', args: [p] });
      return makeObs();
    }),
  };
}

/** 当前 prototype spy（beforeEach 重设，afterEach restore） */
let traceSpy: SpyFn | null = null;
let shutdownSpy: SpyFn | null = null;
const proto = Langfuse.prototype as { trace?: unknown; shutdownAsync?: unknown };
const origTrace = proto.trace;
const origShutdown = proto.shutdownAsync;

/** 安装 prototype spy：替换 Langfuse.prototype.trace / shutdownAsync */
function installSpies(): void {
  traceSpy = vi.fn((p: unknown) => {
    calls.push({ method: 'client.trace', args: [p] });
    return makeObs();
  });
  shutdownSpy = vi.fn(async () => {
    calls.push({ method: 'shutdownAsync', args: [] });
  });
  proto.trace = traceSpy;
  proto.shutdownAsync = shutdownSpy;
}

/** 还原 prototype，避免影响其他 file */
function restoreSpies(): void {
  proto.trace = origTrace;
  proto.shutdownAsync = origShutdown;
  traceSpy = null;
  shutdownSpy = null;
}

/** step span metadata 工厂 */
function stepMeta(step = 1) {
  return { step, ingestUpTo: null, llmUpTo: null, newMessageCount: 0, hasToolCall: false };
}

/** trace metadata 工厂 */
function traceMeta(runId = 'r', sessionId = 's') {
  return { runId, sessionId, inputMessageIds: [] as string[], modelId: 'm', toolNames: [] as string[] };
}

/**
 * v0.0.138 起 SDK 调用走 LangfuseEventQueue 异步 consumer loop（批间 250ms yield）。
 * 测试需 flush 等队列消费完再断言（禁 wall clock >1s/批）。
 * 用 any + bracket 访问私有 queue 字段（TS 允许 bracket 访问 private，测试场景可接受）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function flush(adapter: any, deadlineMs = 5_000): Promise<void> {
  await adapter['queue'].flush(deadlineMs);
}

// ============================================================
// (b) LangfuseAdapter（prototype spy）
// ============================================================

describe('LangfuseAdapter — SDK 字段映射 + 零异常', () => {
  let Adapter: typeof import('../langfuse-adapter').LangfuseAdapter;

  beforeEach(async () => {
    calls.length = 0;
    installSpies();
    Adapter = (await import('../langfuse-adapter')).LangfuseAdapter;
  });
  afterEach(restoreSpies);

  function makeAdapter() {
    return new Adapter({ publicKey: 'pk', secretKey: 'sk', baseUrl: 'http://lf' });
  }

  it('startTrace 调 client.trace 全量字段', async () => {
    const a = makeAdapter();
    const h = a.startTrace({
      id: 'run-x',
      sessionId: 'sess-1',
      name: 'agent',
      input: [],
      metadata: { runId: 'run-x', sessionId: 'sess-1', inputMessageIds: ['m1'], modelId: 'claude', toolNames: ['read'] },
    });
    expect(h).toEqual({ kind: 'trace', id: 'run-x' });
    await flush(a);
    const tc = calls.filter((c) => c.method === 'client.trace');
    expect(tc).toHaveLength(1);
    const arg = tc[0]!.args[0] as Record<string, unknown>;
    expect(arg['id']).toBe('run-x');
    expect(arg['sessionId']).toBe('sess-1');
    expect(arg['name']).toBe('agent');
    expect((arg['metadata'] as { runId: string }).runId).toBe('run-x');
  });

  it('startSpan(step) → trace.span({name, input:{step}, metadata, startTime})', async () => {
    const a = makeAdapter();
    const trace = a.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    a.startSpan({ parent: trace, name: 'step 1', input: { step: 1 }, metadata: stepMeta() });
    await flush(a);
    const spanCall = calls.find((c) => c.method === 'obs.span');
    expect(spanCall).toBeDefined();
    const arg = spanCall!.args[0] as Record<string, unknown>;
    expect(arg['name']).toBe('step 1');
    expect(arg['input']).toEqual({ step: 1 });
    expect((arg['metadata'] as { step: number }).step).toBe(1);
    expect(arg['startTime']).toBeInstanceOf(Date);
  });

  it('startSpan(tool) → input=ToolSpanInput(arguments 完整) + metadata', async () => {
    const a = makeAdapter();
    const trace = a.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const stepSpan = a.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    a.startSpan({
      parent: stepSpan,
      name: 'tool:read',
      input: { toolCallId: 'tc1', toolName: 'read', arguments: { path: '/x', n: 3 } },
      metadata: { step: 1, toolCallId: 'tc1' },
    });
    await flush(a);
    const spanCalls = calls.filter((c) => c.method === 'obs.span');
    const toolArg = spanCalls[1]!.args[0] as Record<string, unknown>;
    expect((toolArg['input'] as { arguments: { path: string } }).arguments.path).toBe('/x');
    expect((toolArg['input'] as { arguments: { n: number } }).arguments.n).toBe(3);
  });

  it('endSpan(tool, isError=true) → output + level:ERROR', async () => {
    const a = makeAdapter();
    const trace = a.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const stepSpan = a.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    const toolSpan = a.startSpan({
      parent: stepSpan,
      name: 'tool:x',
      input: { toolCallId: 't', toolName: 'x', arguments: {} },
      metadata: { step: 1, toolCallId: 't' },
    });
    a.endSpan(toolSpan, {
      output: { result: { type: 'tool_result', toolCallId: 't', content: [], isError: true }, isError: true },
    });
    await flush(a);
    const upd = calls
      .filter((c) => c.method === 'obs.update')
      .find((c) => (c.args[0] as Record<string, unknown>)['level'] === 'ERROR');
    expect(upd).toBeDefined();
  });

  // [v0.0.68 R7 BUG-001] setLevel 等价机制：trace 顶层无 level 字段，用 metadata.errorLevel 落盘
  it('setLevel(trace, ERROR) → obs.update 收 metadata.errorLevel（langfuse trace 顶层无 level 字段，等价机制）', async () => {
    const a = makeAdapter();
    const trace = a.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    await flush(a);
    calls.length = 0; // 清掉 startTrace 的 client.trace，只看 setLevel 触发的 update
    a.setLevel(trace, 'ERROR');
    await flush(a);
    const upd = calls.find((c) => c.method === 'obs.update');
    expect(upd).toBeDefined();
    const arg = upd!.args[0] as Record<string, unknown>;
    // trace 类型走 metadata.errorLevel（ApiTraceBody 无 level 字段；spec R7 行 101 允许等价机制）
    expect((arg['metadata'] as { errorLevel: string }).errorLevel).toBe('ERROR');
    // 不应传 level（trace 顶层 level 无效，会被后端 silently 忽略）
    expect(arg['level']).toBeUndefined();
  });

  it('setLevel(span, ERROR) → obs.update 收 level（observation schema 支持 level）', async () => {
    const a = makeAdapter();
    const trace = a.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const stepSpan = a.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    await flush(a);
    calls.length = 0;
    a.setLevel(stepSpan, 'ERROR');
    await flush(a);
    const upd = calls.find((c) => c.method === 'obs.update');
    expect(upd).toBeDefined();
    const arg = upd!.args[0] as Record<string, unknown>;
    // span/generation 走 level（ApiOptionalObservationBody 支持）
    expect(arg['level']).toBe('ERROR');
    expect(arg['metadata']).toBeUndefined();
  });

  it('setLevel 不存在的 handle → noop 不抛', async () => {
    const a = makeAdapter();
    expect(() =>
      a.setLevel({ kind: 'trace', id: 'never-existed' }, 'ERROR'),
    ).not.toThrow();
    await flush(a);
    // 不存在的 handle → enqueue update → consumer obs.get 返 undefined → noop（不抛）
  });

  it('startGeneration/endGeneration 字段映射 + mapUsageDetails usageDetails/costDetails', async () => {
    const a = makeAdapter();
    const trace = a.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const step = a.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    const gen = a.startGeneration({
      parent: step,
      model: 'claude-3',
      input: {
        system: 'sys', systemCharCount: 3, messages: [], messagesCharCount: 10,
        tools: [], params: { stream: true }, modelId: 'claude-3', iteration: 1,
      },
    });
    await flush(a);
    const genCall = calls.find((c) => c.method === 'obs.generation');
    expect(genCall).toBeDefined();
    const gArg = genCall!.args[0] as Record<string, unknown>;
    expect(gArg['name']).toBe('llm');
    expect(gArg['model']).toBe('claude-3');
    expect((gArg['input'] as { messagesCharCount: number }).messagesCharCount).toBe(10);

    const usage: Usage = {
      input_cache_read: 100, input_cache_write: 50, input_no_cache: 10, input_total_tokens: 160,
      output_response: 20, output_reasoning: 5, output_total_tokens: 25, total_tokens: 185,
      cost: 0.012, inputCharCount: 500, outputCharCount: 80,
    };
    a.endGeneration({
      gen,
      output: { message: { id: 'm', sessionId: 's', role: 'assistant', content: [] }, stopReason: 'stop' },
      usage,
      metadata: { iteration: 1, step: 1, cacheReadTokens: 100, cacheWriteTokens: 50, durationMs: 42 },
    });
    await flush(a);
    const upds = calls.filter((c) => c.method === 'obs.update');
    const uArg = upds[upds.length - 1]!.args[0] as Record<string, unknown>;
    // [v0.0.61] usage → usageDetails/costDetails（互斥拆分防双计）
    // cache/reasoning key 用 langfuse Anthropic 原生 snake_case（对齐 langfuse-usage-protocol §二/§四）
    const usageDetails = uArg['usageDetails'] as Record<string, number>;
    expect(usageDetails['input']).toBe(10);              // input_no_cache（拆分路径，不含 cache）
    expect(usageDetails['cache_read_input_tokens']).toBe(100);
    expect(usageDetails['cache_creation_input_tokens']).toBe(50);
    expect(usageDetails['output']).toBe(20);
    expect(usageDetails['output_reasoning_tokens']).toBe(5);
    const costDetails = uArg['costDetails'] as Record<string, number>;
    expect(costDetails['total']).toBe(0.012);
    // 防双计：旧的 usage 字段不再写入
    expect(uArg['usage']).toBeUndefined();
  });

  it('SDK 抛错被吞（核心红线：observability 不向 loop 抛）', async () => {
    traceSpy!.mockImplementationOnce(() => {
      throw new Error('network down');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = makeAdapter();
    expect(() => a.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() })).not.toThrow();
    await flush(a); // consumer _apply 时 client.trace 抛 → catch 吞 + console.warn
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('shutdown → client.shutdownAsync()', async () => {
    const a = makeAdapter();
    await a.shutdown();
    expect(shutdownSpy).toHaveBeenCalled();
  });
});

// ============================================================
// (c) factory（[v0.0.11] 列表驱动 → ObservabilityManager；singleton + shutdown）
//   ENV 兜底已移除（observability-env.test.ts 已删除）。真 fan-out 由 t2 实现，
//   此处仅验证 factory 形态：列表 → manager / 空列表 → manager（0 child）/ singleton 复用 / shutdown。
// ============================================================

describe('createObservabilityManager — dev_config 列表 → ObservabilityManager', () => {
  let factory: typeof import('../index');

  beforeEach(async () => {
    calls.length = 0;
    installSpies();
    factory = await import('../index');
    factory._resetSingletonForTest();
  });
  afterEach(() => {
    restoreSpies();
    factory._resetSingletonForTest();
  });

  it('无配置（undefined）→ ObservabilityManager（0 child，等价 Noop）', () => {
    const m = factory.createObservabilityManager(undefined);
    expect(m).toBeInstanceOf(factory.ObservabilityManager);
    expect(m.items.length).toBe(0);
  });

  it('空列表 → ObservabilityManager（0 child）', () => {
    const m = factory.createObservabilityManager([]);
    expect(m).toBeInstanceOf(factory.ObservabilityManager);
    expect(m.items.length).toBe(0);
  });

  it('含 enabled langfuse 项 → ObservabilityManager（持 1 item；t3 桩未构造 child，t2 填 fan-out）', () => {
    const m = factory.createObservabilityManager([
      {
        id: '01J', name: 'self-host', type: 'langfuse',
        baseUrl: 'http://localhost:3000', publicKey: 'pk', secretKey: 'sk',
        enabled: true,
      },
    ]);
    expect(m).toBeInstanceOf(factory.ObservabilityManager);
    expect(m.items.length).toBe(1);
  });

  it('singleton：第二次调复用同一 manager 实例', () => {
    const m1 = factory.createObservabilityManager([
      { id: 'a', name: 'a', type: 'langfuse', baseUrl: 'u', publicKey: 'p', secretKey: 's', enabled: true },
    ]);
    const m2 = factory.createObservabilityManager([
      { id: 'b', name: 'b', type: 'langfuse', baseUrl: 'u2', publicKey: 'p2', secretKey: 's2', enabled: false },
    ]);
    // singleton：bootstrap 起来构造一次全程复用，第二次入参被忽略（dev_config 不热更新）
    expect(m2).toBe(m1);
  });

  it('shutdownObservability 调 manager.shutdown 并清空 singleton', async () => {
    const m = factory.createObservabilityManager([
      { id: 'a', name: 'a', type: 'langfuse', baseUrl: 'u', publicKey: 'p', secretKey: 's', enabled: true },
    ]);
    const spy = vi.spyOn(m, 'shutdown').mockResolvedValue(undefined);
    await factory.shutdownObservability();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ============================================================
// (d) LangfuseAdapter v0.0.50 physical generation kind 分支
//   - startGeneration kind='physical'：name='llm-physical' / input=physicalInput / metadata.physicalWire=true
//   - startGeneration kind='logical'（默认）：name='llm'（既有行为不变）
//   - endGeneration physical：mapUsageDetails({}) → usageDetails/costDetails 全 0；不传 output
//   - endGeneration logical：usageDetails 正常映射（互斥拆分，既有行为不变）
//   - 双层容错（§4.5）：两次 startGeneration 独立 try/catch
// 参考: specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md §4
// ============================================================

describe('LangfuseAdapter — v0.0.50 physical generation kind 分支', () => {
  let Adapter: typeof import('../langfuse-adapter').LangfuseAdapter;

  beforeEach(async () => {
    calls.length = 0;
    installSpies();
    Adapter = (await import('../langfuse-adapter')).LangfuseAdapter;
  });
  afterEach(restoreSpies);

  function makeAdapter() {
    return new Adapter({ publicKey: 'pk', secretKey: 'sk', baseUrl: 'http://lf' });
  }

  /** 构造 trace + step span，返回 step span handle（用于挂 generation） */
  function makeStep(adapter: ReturnType<typeof makeAdapter>) {
    const trace = adapter.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    return adapter.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
  }

  it("kind='physical' startGeneration → name='llm-physical' / input=physicalInput / metadata.physicalWire=true", async () => {
    const a = makeAdapter();
    const step = makeStep(a);
    const wireBody = { model: 'claude', messages: [{ role: 'user', content: 'wire' }] };
    a.startGeneration({
      parent: step,
      model: 'claude',
      kind: 'physical',
      physicalInput: wireBody,
    });
    await flush(a);
    const genCalls = calls.filter((c) => c.method === 'obs.generation');
    expect(genCalls).toHaveLength(1);
    const arg = genCalls[0]!.args[0] as Record<string, unknown>;
    expect(arg['name']).toBe('llm-physical');
    expect(arg['input']).toEqual(wireBody);
    expect((arg['metadata'] as { physicalWire: boolean }).physicalWire).toBe(true);
    expect(arg['model']).toBe('claude');
    expect(arg['startTime']).toBeInstanceOf(Date);
  });

  it("kind='logical'（默认，不传 kind）startGeneration → name='llm' / input=GenInput / metadata 不带 physicalWire", async () => {
    const a = makeAdapter();
    const step = makeStep(a);
    a.startGeneration({
      parent: step,
      model: 'claude',
      input: {
        system: 'sys', systemCharCount: 3, messages: [], messagesCharCount: 10,
        tools: [], params: {}, modelId: 'claude', iteration: 1,
      },
    });
    await flush(a);
    const genCalls = calls.filter((c) => c.method === 'obs.generation');
    expect(genCalls).toHaveLength(1);
    const arg = genCalls[0]!.args[0] as Record<string, unknown>;
    expect(arg['name']).toBe('llm');
    expect((arg['input'] as { messagesCharCount: number }).messagesCharCount).toBe(10);
    // metadata 不被 logical 路径显式写入（沿用 SDK 默认 undefined）
    expect(arg['metadata']).toBeUndefined();
  });

  it("kind='logical' 显式传 → 等价默认（name='llm'，向后兼容）", async () => {
    const a = makeAdapter();
    const step = makeStep(a);
    a.startGeneration({
      parent: step,
      model: 'claude',
      kind: 'logical',
      input: {
        system: 'sys', systemCharCount: 3, messages: [], messagesCharCount: 0,
        tools: [], params: {}, modelId: 'claude', iteration: 1,
      },
    });
    await flush(a);
    const arg = calls.find((c) => c.method === 'obs.generation')!.args[0] as Record<string, unknown>;
    expect(arg['name']).toBe('llm');
  });

  it("kind='physical' endGeneration → usageDetails 全 0（mapUsageDetails({}) 路径）+ 不传 output + metadata.physicalWire=true", async () => {
    const a = makeAdapter();
    const step = makeStep(a);
    const gen = a.startGeneration({
      parent: step,
      model: 'claude',
      kind: 'physical',
      physicalInput: { wire: 'body' },
    });
    await flush(a);
    calls.length = 0; // 隔离 start 的 calls，只看 end
    // 即使 endGeneration 传了非空 usage，physical 路径也应忽略（mapUsageDetails({}) → 全 0）
    const nonZeroUsage: Usage = {
      input_total_tokens: 999, output_total_tokens: 888, total_tokens: 1887, cost: 1.5,
    };
    a.endGeneration({
      gen,
      usage: nonZeroUsage,
      metadata: { iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    await flush(a);
    const upds = calls.filter((c) => c.method === 'obs.update');
    expect(upds).toHaveLength(1);
    const uArg = upds[0]!.args[0] as Record<string, unknown>;
    // [v0.0.61] physical 路径 usageDetails/costDetails 全 0（不污染 token/cost dashboard）
    const usageDetails = uArg['usageDetails'] as Record<string, number>;
    expect(usageDetails['input']).toBe(0);
    expect(usageDetails['output']).toBe(0);
    // cost==null（mapUsageDetails({})）→ costDetails 空（不写 total）
    expect(Object.keys(uArg['costDetails'] as Record<string, number>)).toHaveLength(0);
    // 防双计：旧的 usage 字段不再写入
    expect(uArg['usage']).toBeUndefined();
    // physical 路径不传 output（物理层不承载 LLM 产出）
    expect(uArg['output']).toBeUndefined();
    // metadata 合并 physicalWire=true（与 startGeneration 的标识一致）
    const meta = uArg['metadata'] as Record<string, unknown>;
    expect(meta['physicalWire']).toBe(true);
  });

  it("kind='logical' endGeneration → usageDetails 正常映射（互斥拆分，既有行为不变）+ output 透传", async () => {
    const a = makeAdapter();
    const step = makeStep(a);
    const gen = a.startGeneration({
      parent: step,
      model: 'claude',
      input: {
        system: 'sys', systemCharCount: 3, messages: [], messagesCharCount: 10,
        tools: [], params: {}, modelId: 'claude', iteration: 1,
      },
    });
    await flush(a);
    calls.length = 0;
    const usage: Usage = {
      input_cache_read: 100, input_cache_write: 50, input_no_cache: 10, input_total_tokens: 160,
      output_response: 20, output_reasoning: 5, output_total_tokens: 25, total_tokens: 185,
      cost: 0.012,
    };
    a.endGeneration({
      gen,
      output: {
        message: { id: 'm', sessionId: 's', role: 'assistant', content: [] },
        stopReason: 'stop',
      },
      usage,
      metadata: { iteration: 1, step: 1, cacheReadTokens: 100, cacheWriteTokens: 50 },
    });
    await flush(a);
    const upds = calls.filter((c) => c.method === 'obs.update');
    expect(upds).toHaveLength(1);
    const uArg = upds[0]!.args[0] as Record<string, unknown>;
    // [v0.0.61] usage → usageDetails/costDetails（互斥拆分防双计）
    // cache/reasoning key 用 langfuse Anthropic 原生 snake_case（对齐 langfuse-usage-protocol §二/§四）
    const usageDetails = uArg['usageDetails'] as Record<string, number>;
    expect(usageDetails['input']).toBe(10);              // input_no_cache（拆分路径，不含 cache）
    expect(usageDetails['cache_read_input_tokens']).toBe(100);
    expect(usageDetails['cache_creation_input_tokens']).toBe(50);
    expect(usageDetails['output']).toBe(20);
    expect(usageDetails['output_reasoning_tokens']).toBe(5);
    const costDetails = uArg['costDetails'] as Record<string, number>;
    expect(costDetails['total']).toBe(0.012);
    // 防双计：旧的 usage 字段不再写入
    expect(uArg['usage']).toBeUndefined();
    // logical 路径透传 output
    expect(uArg['output']).toBeDefined();
    // logical 路径 metadata 不带 physicalWire 标识
    const meta = uArg['metadata'] as Record<string, unknown>;
    expect(meta['physicalWire']).toBeUndefined();
  });

  it('同一 step 内连续两次 startGeneration（physical + logical）→ 两条独立 generation', async () => {
    const a = makeAdapter();
    const step = makeStep(a);
    // 顺序无所谓（spec 时序 logical 先 physical 后；UT 验证独立性）
    a.startGeneration({
      parent: step, model: 'claude', kind: 'physical', physicalInput: { wire: 1 },
    });
    a.startGeneration({
      parent: step, model: 'claude',
      input: {
        system: 'sys', systemCharCount: 3, messages: [], messagesCharCount: 10,
        tools: [], params: {}, modelId: 'claude', iteration: 1,
      },
    });
    await flush(a);
    const genCalls = calls.filter((c) => c.method === 'obs.generation');
    expect(genCalls).toHaveLength(2);
    const names = genCalls.map((c) => (c.args[0] as Record<string, unknown>)['name']);
    expect(names).toContain('llm');
    expect(names).toContain('llm-physical');
  });

  it("startGeneration 传入 name 时优先用 caller name（覆盖 fallback，§4.3 方案 A）", async () => {
    const a = makeAdapter();
    const step = makeStep(a);
    a.startGeneration({
      parent: step,
      model: 'claude',
      name: 'llm-3-logical',
      input: {
        system: 'sys', systemCharCount: 3, messages: [], messagesCharCount: 0,
        tools: [], params: {}, modelId: 'claude', iteration: 3,
      },
    });
    await flush(a);
    const arg = calls.find((c) => c.method === 'obs.generation')!.args[0] as Record<string, unknown>;
    expect(arg['name']).toBe('llm-3-logical');
  });

  it("startGeneration kind='physical' 传入 name 时优先用 caller name（`llm-N-physical`，§4.3）", async () => {
    const a = makeAdapter();
    const step = makeStep(a);
    a.startGeneration({
      parent: step,
      model: 'claude',
      name: 'llm-5-physical',
      kind: 'physical',
      physicalInput: { wire: true },
    });
    await flush(a);
    const arg = calls.find((c) => c.method === 'obs.generation')!.args[0] as Record<string, unknown>;
    expect(arg['name']).toBe('llm-5-physical');
  });

  it('physical startGeneration SDK 抛错被吞，不影响后续 logical startGeneration（双层容错 §4.5）', async () => {
    // 核心红线：observability 失败绝不影响主流程。两次 startGeneration 各自独立 try/catch。
    // 验证手段：让 trace 返回的 step span obs.generation 第一次抛错（physical 失败），第二次正常。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const throwingTraceSpy = vi.fn((tp: unknown) => {
      calls.push({ method: 'client.trace', args: [tp] });
      const traceObs = makeObs();
      // 覆盖 trace.span：返回的 step obs 的 generation 第一次抛错、第二次恢复正常
      let stepObsCache: ObsMock | null = null;
      let throwOnce = true;
      traceObs.span = vi.fn((sp: unknown) => {
        calls.push({ method: 'obs.span', args: [sp] });
        if (!stepObsCache) {
          stepObsCache = makeObs();
          const origGen = stepObsCache.generation;
          stepObsCache.generation = vi.fn((gp: unknown) => {
            if (throwOnce) {
              throwOnce = false;
              throw new Error('physical wire network down');
            }
            return origGen(gp);
          });
        }
        return stepObsCache;
      });
      return traceObs;
    });
    proto.trace = throwingTraceSpy;

    // 重新构造 adapter（让新 prototype 生效）
    const a = makeAdapter();
    const trace = a.startTrace({ id: 'r2', sessionId: 's', metadata: traceMeta() });
    const step = a.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });

    // 第一次（physical）：step obs.generation 抛错 → consumer _apply catch 吞 + warn
    const genPhysical = a.startGeneration({
      parent: step, model: 'claude', kind: 'physical', physicalInput: {},
    });
    expect(genPhysical.kind).toBe('gen'); // handle 同步返（loop 不感知失败）

    // 第二次（logical）：不受前次失败影响，正常执行（同 step obs，generation 第二次正常）
    const genLogical = a.startGeneration({
      parent: step, model: 'claude',
      input: {
        system: 'sys', systemCharCount: 3, messages: [], messagesCharCount: 10,
        tools: [], params: {}, modelId: 'claude', iteration: 1,
      },
    });
    expect(genLogical.kind).toBe('gen');
    expect(genPhysical.id).not.toBe(genLogical.id); // 两条独立 handle
    await flush(a); // 等 consumer 处理完（physical _apply 抛 → catch + warn）
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ============================================================
// (e) v0.0.138 LangfuseEventQueue bounded consumer
//   - ① start-end 时序：嵌套 trace+span+gen + 各 end → flush 后 SDK 按 FIFO 依次调
//   - ② drop new：buffer 近 500MB → enqueue update 未到达 SDK
//   - ③ FIFO 保 parent 命中：startSpan(parent) + endSpan → resolveParent 命中（不丢 parent）
//   - ④ shutdown drain：enqueue 3 ops → shutdown → 全到 SDK + shutdownAsync 被调
// 参考: specs/tech/version_logs/v0.0.138/change_plan.md §改造#2 + §5 个结论
// ============================================================

describe('LangfuseEventQueue bounded consumer', () => {
  let Adapter: typeof import('../langfuse-adapter').LangfuseAdapter;

  beforeEach(async () => {
    calls.length = 0;
    installSpies();
    Adapter = (await import('../langfuse-adapter')).LangfuseAdapter;
  });
  afterEach(restoreSpies);

  function makeAdapter() {
    return new Adapter({ publicKey: 'pk', secretKey: 'sk', baseUrl: 'http://lf' });
  }

  it('① start-end 时序：trace→span→gen + 3 end update，SDK 调用顺序保 FIFO', async () => {
    const a = makeAdapter();
    const trace = a.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const step = a.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    const gen = a.startGeneration({
      parent: step, model: 'claude',
      input: { system: 's', systemCharCount: 1, messages: [], messagesCharCount: 1, tools: [], params: {}, modelId: 'c', iteration: 1 },
    });
    a.endGeneration({ gen, output: { message: { id: 'm', sessionId: 's', role: 'assistant', content: [] }, stopReason: 'stop' }, usage: {} as Usage, metadata: { iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    a.endSpan(step);
    a.endTrace(trace, { metadata: { stopReason: 'stop' } });
    await flush(a);
    // FIFO 顺序：client.trace → obs.span → obs.generation → 3× obs.update（gen end / span end / trace end）
    const sdkOrder = calls.map((c) => c.method);
    expect(sdkOrder.indexOf('client.trace')).toBeLessThan(sdkOrder.indexOf('obs.span'));
    expect(sdkOrder.indexOf('obs.span')).toBeLessThan(sdkOrder.indexOf('obs.generation'));
    // generation 之后有 3 个 update（gen end、span end、trace end）
    const genIdx = sdkOrder.indexOf('obs.generation');
    const updatesAfterGen = sdkOrder.slice(genIdx + 1).filter((m) => m === 'obs.update');
    expect(updatesAfterGen.length).toBeGreaterThanOrEqual(3);
  });

  it('② drop new：bufferedBytes 近 500MB 后 enqueue update → 未到达 SDK + warn 被调', async () => {
    const a = makeAdapter();
    // mock 队列已近 500MB（下一条应 drop new）
    const queue = a['queue'];
    (queue as unknown as { bufferedBytes: number }).bufferedBytes = 500 * 1024 * 1024 - 10;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 先 startTrace 建 trace（会被 drop，因 buffer 满），验证 drop 后 SDK 未被调
    a.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    await flush(a, 200); // 短 deadline（队列空，drop 后 consumer 不会处理任何东西）
    // client.trace 未被调（create-trace op 被 drop）
    expect(calls.filter((c) => c.method === 'client.trace')).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('③ FIFO 保 parent 命中：startSpan(parent=trace) + endSpan → resolveParent 命中（obs.span 被调）', async () => {
    const a = makeAdapter();
    const trace = a.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const step = a.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    a.endSpan(step);
    await flush(a);
    // consumer FIFO：create-trace 先处理（obs.set trace）→ create-span 处理时 resolveParent 命中
    const spanCalls = calls.filter((c) => c.method === 'obs.span');
    expect(spanCalls).toHaveLength(1); // resolveParent 命中 → span 被创建
    // endSpan 的 update 也到达（obs.get(step.id) 命中）
    const updateCalls = calls.filter((c) => c.method === 'obs.update');
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('④ shutdown drain：enqueue 3 ops → shutdown → 全到 SDK + shutdownAsync 被调', async () => {
    const a = makeAdapter();
    const trace = a.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const step = a.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    a.endSpan(step);
    // shutdown drain：不等 flush，直接 shutdown → drainAndShutdown 应等队列消费完再 shutdownAsync
    await a.shutdown();
    // 3 ops（create-trace + create-span + update）全到达 SDK
    expect(calls.filter((c) => c.method === 'client.trace')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'obs.span')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'obs.update').length).toBeGreaterThanOrEqual(1);
    // shutdownAsync 被调
    expect(shutdownSpy).toHaveBeenCalled();
  });
});

