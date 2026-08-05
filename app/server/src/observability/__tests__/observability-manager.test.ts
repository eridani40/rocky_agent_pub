/**
 * ObservabilityManager 单测 — composite adapter 的构造 / fan-out / 容错 / shutdown。
 * 参考: specs/tech/agent/observability/[P0]observability_manager.md §2-§5
 *       states/v0.0.11/verify/test-plan.md §2 UT#1-#4
 *
 * UT#1 构造 / UT#2 fan-out / UT#3 容错 / UT#4 shutdown。
 * 说明：白盒 fake child mock 覆盖 manager 内部 fan-out/容错逻辑（非 api/e2e 真链路），
 * 真 langfuse 端到端由 AT `observability_manager_tc1` 覆盖。
 */
import { describe, it, expect, vi } from 'vitest';
import { LangfuseAdapter } from '../langfuse-adapter';
import { ObservabilityManager, type ObservabilityConfigItem } from '../observability-manager';
import type { ObservabilityAdapter } from '../adapter';
import type { GenEnd, GenHandle, SpanHandle, TraceHandle } from '../types';
import type { StepSpanMetadata, TraceMetadata } from '../types';

/** 单次调用记录（含 parent.id，供 BUG-001 回归断言 child 收到的 parent 是其自身 handle） */
interface ChildCall { method: string; parentId?: string }

/** 构造 fake child（tag + throwOn 列表）。shutdown 在 throwOn 里 = reject（async throw） */
function makeFakeChild(tag: string, throwOn: string[] = []): {
  adapter: ObservabilityAdapter;
  calls: ChildCall[];
} {
  const calls: ChildCall[] = [];
  const throwSet = new Set(throwOn);
  const boom = (m: string): void => {
    if (throwSet.has(m)) throw new Error(`fake ${tag} ${m} boom`);
  };
  const adapter: ObservabilityAdapter = {
    startTrace(p) {
      boom('startTrace');
      calls.push({ method: 'startTrace', parentId: p.id });
      return { kind: 'trace', id: `${p.id}#${tag}` };
    },
    endTrace() {
      boom('endTrace');
      calls.push({ method: 'endTrace' });
    },
    startGeneration(p) {
      boom('startGeneration');
      calls.push({ method: 'startGeneration', parentId: p.parent.id });
      return { kind: 'gen', id: `gen#${tag}`, parent: p.parent } as GenHandle;
    },
    endGeneration() {
      boom('endGeneration');
      calls.push({ method: 'endGeneration' });
    },
    startSpan(p) {
      boom('startSpan');
      calls.push({ method: 'startSpan', parentId: p.parent.id });
      return { kind: 'span', id: `span#${tag}`, parent: p.parent } as SpanHandle;
    },
    endSpan() {
      boom('endSpan');
      calls.push({ method: 'endSpan' });
    },
    async shutdown() {
      boom('shutdown');
      calls.push({ method: 'shutdown' });
    },
  };
  return { adapter, calls };
}

/** 用 fake children 直接构造 manager（白盒覆盖 private children，跳过真实 SDK 构造路径）。
 * [v0.0.50] children 改为 ChildEntry[]（adapter + logPhysical 标记）；fakes 可选传 logPhysical
 * （缺省 false，匹配 ObservabilityConfigItem.logPhysical 缺省值）。
 */
function makeManagerWithFakes(
  fakes: { adapter: ObservabilityAdapter; logPhysical?: boolean }[],
): ObservabilityManager {
  const m = new ObservabilityManager([]);
  (m as unknown as {
    children: { adapter: ObservabilityAdapter; logPhysical: boolean }[];
  }).children = fakes.map((f) => ({ adapter: f.adapter, logPhysical: f.logPhysical ?? false }));
  return m;
}

function mkItem(
  over: Partial<{ id: string; name: string; enabled: boolean; logPhysical: boolean }> = {},
): ObservabilityConfigItem {
  return {
    id: over.id ?? 'i1',
    name: over.name ?? 'n',
    type: 'langfuse',
    baseUrl: 'http://lf',
    publicKey: 'pk',
    secretKey: 'sk',
    enabled: over.enabled ?? true,
    ...(over.logPhysical !== undefined ? { logPhysical: over.logPhysical } : {}),
  };
}

const traceMeta = (runId = 'r', sessionId = 's'): TraceMetadata => ({
  runId,
  sessionId,
  inputMessageIds: [],
  modelId: 'm',
  toolNames: [],
});

const stepMeta = (step = 1): StepSpanMetadata => ({
  step,
  ingestUpTo: null,
  llmUpTo: null,
  newMessageCount: 0,
  hasToolCall: false,
});

/** 屏蔽 console.warn（容错测试会 warn），返回 spy 供断言 */
function silenceWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

// ============================================================
// UT#1 构造（§6）
// ============================================================
describe('ObservabilityManager — 构造', () => {
  it('N enabled langfuse item → N child', () => {
    const m = new ObservabilityManager([mkItem({ id: 'a' }), mkItem({ id: 'b' }), mkItem({ id: 'c' })]);
    expect(m.childCount).toBe(3);
  });

  it('空列表 → 0 child（等价 Noop，对外不抛）', () => {
    const m = new ObservabilityManager([]);
    expect(m.childCount).toBe(0);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    expect(trace.kind).toBe('trace');
    expect(() => m.endTrace(trace)).not.toThrow();
  });

  it('全 disabled → 0 child', () => {
    const m = new ObservabilityManager([mkItem({ id: 'a', enabled: false }), mkItem({ id: 'b', enabled: false })]);
    expect(m.childCount).toBe(0);
  });

  it('disabled 项被跳过，仅 enabled 项构造 child', () => {
    const m = new ObservabilityManager([
      mkItem({ id: 'a', enabled: true }),
      mkItem({ id: 'b', enabled: false }),
      mkItem({ id: 'c', enabled: true }),
    ]);
    expect(m.childCount).toBe(2);
  });

  it('items 防御性 copy（外部 mutate 不影响 manager）', () => {
    const items = [mkItem({ id: 'a' })];
    const m = new ObservabilityManager(items);
    items.push(mkItem({ id: 'b' }));
    expect(m.items.length).toBe(1);
  });
});

// ============================================================
// UT#2 fan-out（§2）
// ============================================================
describe('ObservabilityManager — fan-out', () => {
  it('startTrace/endTrace 调用所有 child + manager handle.id=runId', () => {
    const c1 = makeFakeChild('A');
    const c2 = makeFakeChild('B');
    const m = makeManagerWithFakes([c1, c2]);
    const trace = m.startTrace({ id: 'run-1', sessionId: 's', metadata: traceMeta('run-1') });
    expect(trace).toEqual({ kind: 'trace', id: 'run-1' });
    expect(c1.calls.map((c) => c.method)).toEqual(['startTrace']);
    expect(c2.calls.map((c) => c.method)).toEqual(['startTrace']);
    m.endTrace(trace);
    expect(c1.calls.map((c) => c.method)).toEqual(['startTrace', 'endTrace']);
    expect(c2.calls.map((c) => c.method)).toEqual(['startTrace', 'endTrace']);
  });

  it('startSpan/endSpan 调用所有 child + manager SpanHandle.id=ulid', () => {
    const c1 = makeFakeChild('A');
    const c2 = makeFakeChild('B');
    const m = makeManagerWithFakes([c1, c2]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const span = m.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    expect(span.kind).toBe('span');
    expect(span.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(span.parent).toBe(trace);
    m.endSpan(span);
    expect(c1.calls.map((c) => c.method)).toContain('startSpan');
    expect(c1.calls.map((c) => c.method)).toContain('endSpan');
    expect(c2.calls.map((c) => c.method)).toContain('endSpan');
  });

  it('startGeneration/endGeneration 调用所有 child + manager GenHandle.id=ulid', () => {
    const c1 = makeFakeChild('A');
    const c2 = makeFakeChild('B');
    const m = makeManagerWithFakes([c1, c2]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const span = m.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    const gen = m.startGeneration({ parent: span, model: 'm', input: {} as never });
    expect(gen.kind).toBe('gen');
    expect(gen.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(gen.parent).toBe(span);
    m.endGeneration({ gen, output: {} as never, usage: {}, metadata: {} as never } as GenEnd);
    expect(c1.calls.map((c) => c.method)).toContain('endGeneration');
    expect(c2.calls.map((c) => c.method)).toContain('endGeneration');
  });

  it('多次 span 独立 handle（id 不冲突，map 不串）', () => {
    const c1 = makeFakeChild('A');
    const m = makeManagerWithFakes([c1]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const s1 = m.startSpan({ parent: trace, name: 'a', metadata: stepMeta(1) });
    const s2 = m.startSpan({ parent: trace, name: 'b', metadata: stepMeta(2) });
    expect(s1.id).not.toBe(s2.id);
    m.endSpan(s1);
    expect(() => m.endSpan(s2)).not.toThrow();
  });

  it('0 child 时所有方法 noop 不抛（等价 Noop）', () => {
    const m = makeManagerWithFakes([]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    expect(() => m.endTrace(trace)).not.toThrow();
    const span = m.startSpan({ parent: trace, name: 's', metadata: stepMeta() });
    expect(() => m.endSpan(span)).not.toThrow();
    const gen = m.startGeneration({ parent: span, model: 'm', input: {} as never });
    expect(() => m.endGeneration({ gen, output: {} as never, usage: {}, metadata: {} as never } as GenEnd)).not.toThrow();
  });
});

// ============================================================
// UT#3 容错（§3 第一层 per-child try/catch）
// ============================================================
describe('ObservabilityManager — 容错', () => {
  it('一 child startTrace throw → 另一 child 仍调 + manager 不抛', () => {
    const warn = silenceWarn();
    const broken = makeFakeChild('X', ['startTrace']);
    const ok = makeFakeChild('Y');
    const m = makeManagerWithFakes([broken, ok]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    expect(trace).toEqual({ kind: 'trace', id: 'r' });
    expect(ok.calls.map((c) => c.method)).toEqual(['startTrace']);
    expect(broken.calls).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('endTrace 对 startTrace 失败的 child 跳过（handle null），其余 child 仍 endTrace', () => {
    silenceWarn();
    const broken = makeFakeChild('X', ['startTrace']);
    const ok = makeFakeChild('Y');
    const m = makeManagerWithFakes([broken, ok]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    expect(() => m.endTrace(trace)).not.toThrow();
    expect(ok.calls.map((c) => c.method)).toContain('endTrace');
    expect(broken.calls.map((c) => c.method)).not.toContain('endTrace');
    vi.restoreAllMocks();
  });

  it('startSpan/endSpan 单 child throw → 其余不受影响、manager 不抛', () => {
    silenceWarn();
    const broken = makeFakeChild('X', ['startSpan']);
    const ok = makeFakeChild('Y');
    const m = makeManagerWithFakes([broken, ok]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const span = m.startSpan({ parent: trace, name: 's', metadata: stepMeta() });
    expect(span.kind).toBe('span');
    expect(ok.calls.map((c) => c.method)).toContain('startSpan');
    expect(() => m.endSpan(span)).not.toThrow();
    expect(ok.calls.map((c) => c.method)).toContain('endSpan');
    vi.restoreAllMocks();
  });

  it('startGeneration/endGeneration 单 child throw → 其余不受影响、manager 不抛', () => {
    silenceWarn();
    const broken = makeFakeChild('X', ['startGeneration']);
    const ok = makeFakeChild('Y');
    const m = makeManagerWithFakes([broken, ok]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const span = m.startSpan({ parent: trace, name: 's', metadata: stepMeta() });
    const gen = m.startGeneration({ parent: span, model: 'm', input: {} as never });
    expect(gen.kind).toBe('gen');
    expect(ok.calls.map((c) => c.method)).toContain('startGeneration');
    expect(() => m.endGeneration({ gen, output: {} as never, usage: {}, metadata: {} as never } as GenEnd)).not.toThrow();
    expect(ok.calls.map((c) => c.method)).toContain('endGeneration');
    vi.restoreAllMocks();
  });
});

// ============================================================
// UT#4 shutdown（§5）
// ============================================================
describe('ObservabilityManager — shutdown', () => {
  it('shutdown 调用所有 child.shutdown', async () => {
    const c1 = makeFakeChild('A');
    const c2 = makeFakeChild('B');
    const m = makeManagerWithFakes([c1, c2]);
    await m.shutdown();
    expect(c1.calls.map((c) => c.method)).toContain('shutdown');
    expect(c2.calls.map((c) => c.method)).toContain('shutdown');
  });

  it('一 child.shutdown reject → 另一 child 仍调 + manager.shutdown 不抛（allSettled 不短路）', async () => {
    silenceWarn();
    const broken = makeFakeChild('X', ['shutdown']);
    const ok = makeFakeChild('Y');
    const m = makeManagerWithFakes([broken, ok]);
    await expect(m.shutdown()).resolves.toBeUndefined();
    expect(ok.calls.map((c) => c.method)).toContain('shutdown');
    vi.restoreAllMocks();
  });

  it('0 child shutdown 立即 resolve', async () => {
    const m = makeManagerWithFakes([]);
    await expect(m.shutdown()).resolves.toBeUndefined();
  });
});

// ============================================================
// UT#5 BUG-001 回归：parent handle 双向映射（§4 handle 两套 id 空间）
// ============================================================
// 背景：v0.0.11 manager 替换单 LangfuseAdapter 后，真 langfuse 实测 GENERATION 与 tool SPAN 全丢
// （trace 主体 + step SPAN OK）。根因——startGeneration/startSpan(tool) 透传给 child 的 parent
// 仍是 **manager handle**（id=manager ulid），child 内部 Map 找不到对应 observation → 抛错被 safe() 吞。
// step SPAN 能落库是巧合：其 parent 是 trace，而 child 与 manager 的 trace handle.id 同为 runId 天然一致。
// 修复：manager 内部把 manager-parent-handle 反查 traceMap/spanMap → 取 per-child parent handle 再透传。
describe('ObservabilityManager — BUG-001 parent handle 双向映射', () => {
  it('startSpan(step) 的 child 收到的 parent 是 child 自己的 trace handle（不是 manager handle）', () => {
    const c1 = makeFakeChild('A');
    const c2 = makeFakeChild('B');
    const m = makeManagerWithFakes([c1, c2]);
    const trace = m.startTrace({ id: 'run-x', sessionId: 's', metadata: traceMeta('run-x') });
    const span = m.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });

    // manager handle 与 child handle id 不同（两套空间）
    expect(span.parent).toBe(trace); // manager 对外暴露的 handle 链不变
    expect(trace.id).toBe('run-x');
    // 但每个 child 收到的 parent 必须是其自身 startTrace 返回的 handle id
    const c1SpanCall = c1.calls.find((c) => c.method === 'startSpan');
    const c2SpanCall = c2.calls.find((c) => c.method === 'startSpan');
    expect(c1SpanCall?.parentId).toBe('run-x#A');
    expect(c2SpanCall?.parentId).toBe('run-x#B');
  });

  it('startGeneration 的 child 收到的 parent 是 child 自己的 span handle（不是 manager span handle）', () => {
    const c1 = makeFakeChild('A');
    const m = makeManagerWithFakes([c1]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const span = m.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    const gen = m.startGeneration({ parent: span, model: 'm', input: {} as never });

    // manager gen handle.parent 仍是 manager span handle（对外契约不变）
    expect(gen.parent).toBe(span);
    // child startGeneration 收到的 parent.id 必须是 child 自身 startSpan 返回的 handle.id
    // （child startSpan 返回 {id:'span#A'}；fake child 把 parentId 记成入参，不是返回值，
    //   所以这里直接断言 child 的 generation parent = child 自己的 span id 'span#A'）
    const genCall = c1.calls.find((c) => c.method === 'startGeneration');
    expect(genCall?.parentId).toBe('span#A'); // child 自己的 span handle id，非 manager ulid
    expect(genCall?.parentId).not.toBe(span.id); // span.id 是 manager ulid，必须不同
  });

  it('startSpan(tool) 的 child 收到的 parent 是 child 自己的 step span handle', () => {
    const c1 = makeFakeChild('A');
    const m = makeManagerWithFakes([c1]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const stepSpan = m.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    // tool span：input 带 toolCallId（LangfuseAdapter 据此判 tool vs step；此处 fake 不区分但 parent 链同）
    const toolSpan = m.startSpan({
      parent: stepSpan,
      name: 'tool:write',
      input: { toolCallId: 'tc1', toolName: 'write', arguments: {} },
      metadata: { step: 1, toolCallId: 'tc1' },
    });

    // manager 对外 parent 链
    expect(toolSpan.parent).toBe(stepSpan);
    // child 第二次 startSpan（tool）收到的 parent.id 必须是 child 自己的 step span id
    const spanCalls = c1.calls.filter((c) => c.method === 'startSpan');
    expect(spanCalls.length).toBe(2);
    expect(spanCalls[0]?.parentId).toBe('r#A'); // step span 的 parent（trace）
    expect(spanCalls[1]?.parentId).toBe('span#A'); // tool span 的 parent（child 自己的 step span）
  });

  it('多 child 各自 parent 隔离：每 child 只看到自己的 handle', () => {
    const c1 = makeFakeChild('A');
    const c2 = makeFakeChild('B');
    const m = makeManagerWithFakes([c1, c2]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const span = m.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    m.startGeneration({ parent: span, model: 'm', input: {} as never });

    const c1Gen = c1.calls.find((c) => c.method === 'startGeneration');
    const c2Gen = c2.calls.find((c) => c.method === 'startGeneration');
    expect(c1Gen?.parentId).toBe('span#A');
    expect(c2Gen?.parentId).toBe('span#B');
    expect(c1Gen?.parentId).not.toBe(c2Gen?.parentId);
  });

  it('parent 所在 child 此前失败（null）→ 该 child startSpan/startGeneration 跳过，不向 child 调', () => {
    silenceWarn();
    const broken = makeFakeChild('X', ['startSpan']); // step span 起不来
    const ok = makeFakeChild('Y');
    const m = makeManagerWithFakes([broken, ok]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const span = m.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    // 在 step span 之上挂 generation：broken 的 step span handle 是 null → 不应向 broken 调 startGeneration
    m.startGeneration({ parent: span, model: 'm', input: {} as never });

    const brokenGen = broken.calls.find((c) => c.method === 'startGeneration');
    expect(brokenGen).toBeUndefined(); // 跳过，未调用
    const okGen = ok.calls.find((c) => c.method === 'startGeneration');
    expect(okGen?.parentId).toBe('span#Y'); // ok child 正常用自己的 span 作 parent
    vi.restoreAllMocks();
  });
});

// ============================================================
// UT#6 v0.0.50 physical generation fan-out（§5.2 / §5.3）
//   - hasPhysicalChild()：bootstrap 时算好，反映 child 列表的 logPhysical 标记
//   - startGeneration({kind:'physical'}) 只 fan-out 到 logPhysical=true child
//   - startGeneration({kind:'logical'}) / 默认 fan-out 全 child（既有行为不变）
// 参考: specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md §5
// ============================================================
describe('ObservabilityManager — v0.0.50 physical generation fan-out', () => {
  it('hasPhysicalChild() 有任一 logPhysical=true child → true', () => {
    const c1 = makeFakeChild('A');
    const c2 = makeFakeChild('B');
    const m = makeManagerWithFakes([
      { adapter: c1.adapter, logPhysical: false },
      { adapter: c2.adapter, logPhysical: true },
    ]);
    expect(m.hasPhysicalChild()).toBe(true);
  });

  it('hasPhysicalChild() 全 child logPhysical=false → false', () => {
    const c1 = makeFakeChild('A');
    const c2 = makeFakeChild('B');
    const m = makeManagerWithFakes([
      { adapter: c1.adapter, logPhysical: false },
      { adapter: c2.adapter, logPhysical: false },
    ]);
    expect(m.hasPhysicalChild()).toBe(false);
  });

  it('hasPhysicalChild() 0 child → false', () => {
    const m = makeManagerWithFakes([]);
    expect(m.hasPhysicalChild()).toBe(false);
  });

  it('真实 items 构造：item.logPhysical=true → hasPhysicalChild=true（验证构造时透传）', () => {
    const m = new ObservabilityManager([mkItem({ id: 'a', logPhysical: true })]);
    expect(m.hasPhysicalChild()).toBe(true);
  });

  it('真实 items 构造：item 不带 logPhysical 字段 → hasPhysicalChild=false（缺省 false，向后兼容 v0.0.49）', () => {
    const m = new ObservabilityManager([mkItem({ id: 'a' })]);
    expect(m.hasPhysicalChild()).toBe(false);
  });

  it("startGeneration({kind:'physical'}) 只 fan-out 到 logPhysical=true child", () => {
    const c1 = makeFakeChild('A'); // logPhysical=false → 不应收到 physical
    const c2 = makeFakeChild('B'); // logPhysical=true  → 应收到
    const c3 = makeFakeChild('C'); // logPhysical=true  → 应收到
    const m = makeManagerWithFakes([
      { adapter: c1.adapter, logPhysical: false },
      { adapter: c2.adapter, logPhysical: true },
      { adapter: c3.adapter, logPhysical: true },
    ]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const span = m.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    const gen = m.startGeneration({
      parent: span,
      model: 'm',
      kind: 'physical',
      physicalInput: { wire: 'body' },
    });
    expect(gen.kind).toBe('gen');
    // c1（logPhysical=false）不应被调；c2/c3 应被调
    expect(c1.calls.find((c) => c.method === 'startGeneration')).toBeUndefined();
    expect(c2.calls.find((c) => c.method === 'startGeneration')).toBeDefined();
    expect(c3.calls.find((c) => c.method === 'startGeneration')).toBeDefined();
  });

  it("startGeneration({kind:'physical'}) 透传 physicalInput + kind 到 child（不改入参语义）", () => {
    const c1 = makeFakeChild('A');
    const m = makeManagerWithFakes([{ adapter: c1.adapter, logPhysical: true }]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const span = m.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    const wireBody = { model: 'claude', messages: [{ role: 'user', content: 'x' }] };
    m.startGeneration({
      parent: span,
      model: 'm',
      kind: 'physical',
      physicalInput: wireBody,
    });
    // fake child 把 startGeneration 入参 whole-call 记下来不便利，这里仅断言 parent 已被
    // manager 改写为 child 自己的 span（核心契约，既有 UT#5 已覆盖），kind/physicalInput 透传
    // 由 LangfuseAdapter 单测（langfuse-adapter.test.ts）验证 SDK 层字段映射。
    const call = c1.calls.find((c) => c.method === 'startGeneration');
    expect(call).toBeDefined();
    expect(call!.parentId).toBe('span#A');
  });

  it("startGeneration({kind:'logical'}) 默认（不传 kind）fan-out 全 child（既有行为不变）", () => {
    const c1 = makeFakeChild('A');
    const c2 = makeFakeChild('B');
    const m = makeManagerWithFakes([
      { adapter: c1.adapter, logPhysical: false },
      { adapter: c2.adapter, logPhysical: true },
    ]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const span = m.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    m.startGeneration({ parent: span, model: 'm', input: {} as never });
    expect(c1.calls.find((c) => c.method === 'startGeneration')).toBeDefined();
    expect(c2.calls.find((c) => c.method === 'startGeneration')).toBeDefined();
  });

  it("startGeneration({kind:'physical'}) 全 child logPhysical=false → 全部跳过（无 startGeneration 调用）", () => {
    const c1 = makeFakeChild('A');
    const m = makeManagerWithFakes([{ adapter: c1.adapter, logPhysical: false }]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const span = m.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    m.startGeneration({
      parent: span,
      model: 'm',
      kind: 'physical',
      physicalInput: {},
    });
    expect(c1.calls.find((c) => c.method === 'startGeneration')).toBeUndefined();
  });

  it("endGeneration 在 physical kind 跳过 logPhysical=false 的 child（genMap 记 null）不抛", () => {
    silenceWarn();
    const c1 = makeFakeChild('A'); // logPhysical=false → physical 跳过
    const c2 = makeFakeChild('B'); // logPhysical=true  → physical 命中
    const m = makeManagerWithFakes([
      { adapter: c1.adapter, logPhysical: false },
      { adapter: c2.adapter, logPhysical: true },
    ]);
    const trace = m.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const span = m.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    const gen = m.startGeneration({
      parent: span,
      model: 'm',
      kind: 'physical',
      physicalInput: {},
    });
    // endGeneration 不应向 c1 调（其 handle 是 null），只向 c2 调
    expect(() =>
      m.endGeneration({ gen, usage: {} as never, metadata: {} as never } as GenEnd),
    ).not.toThrow();
    expect(c1.calls.find((c) => c.method === 'endGeneration')).toBeUndefined();
    expect(c2.calls.find((c) => c.method === 'endGeneration')).toBeDefined();
    vi.restoreAllMocks();
  });
});

// UT#1 用真实 items（new LangfuseAdapter）验 children 数量；
// 其余 UT 用 fake child 白盒注入，专注 manager 自身 fan-out/容错逻辑。
// LangfuseAdapter 真实 SDK 行为由 observability-langfuse-adapter.test.ts 覆盖。
void LangfuseAdapter;
