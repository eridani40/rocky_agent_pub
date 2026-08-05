/**
 * LangfuseAdapter — v0.0.50 physical+logical 双 generation end 配对测试
 * 参考: specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md §4
 *
 * AT langfuse_physical_generation_tc1 round-1 暴露的 UT 缺口：logPhysical=true 时
 * 同 iteration 启动 logical + physical 两条 generation，逻辑层 end 必须带真实 usage，
 * 物理层 end 必须 usage=0。两者独立 handle + 独立 observation + 独立 update。
 *
 * 本文件验证 LangfuseAdapter 层独立 endGeneration 调用对各 self observation 的正确性
 * （在 manager / port 之外隔离验证 adapter 层 kind 分支）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Langfuse } from 'langfuse';
import type { Usage } from '../../message/types';

type SpyFn = ReturnType<typeof vi.fn>;

/**
 * 带 id 的 observation mock：每次 .generation() / .span() 返回新对象（独立 update spy）。
 * update 推入 calls 时附 observation 序号，便于断言「哪条 obs 收到哪个 update」。
 */
interface ObsMock {
  __id: number;
  update: SpyFn;
  span: (p: unknown) => ObsMock;
  generation: (p: unknown) => ObsMock;
}

type Call = { method: string; obsId: number; args: unknown[] };

const calls: Call[] = [];
let obsSeq = 0;

function makeObs(): ObsMock {
  const id = ++obsSeq;
  return {
    __id: id,
    update: vi.fn((p: unknown) => calls.push({ method: 'obs.update', obsId: id, args: [p] })),
    span: (p: unknown) => {
      const child = makeObs();
      // 记录 child id（返回的 observation），便于和后续 child.update 关联
      calls.push({ method: 'obs.span', obsId: child.__id, args: [p] });
      return child;
    },
    generation: (p: unknown) => {
      const child = makeObs();
      // 记录 child id（返回的 generation observation），便于和后续 child.update 关联
      calls.push({ method: 'obs.generation', obsId: child.__id, args: [p] });
      return child;
    },
  };
}

let traceSpy: SpyFn | null = null;
const proto = Langfuse.prototype as { trace?: unknown };
const origTrace = proto.trace;

function installSpies(): void {
  traceSpy = vi.fn((p: unknown) => {
    const t = makeObs();
    calls.push({ method: 'client.trace', obsId: t.__id, args: [p] });
    return t;
  });
  proto.trace = traceSpy;
}

function restoreSpies(): void {
  proto.trace = origTrace;
  traceSpy = null;
}

/** v0.0.138 起 SDK 调用走 LangfuseEventQueue 异步 consumer（批间 250ms yield），测试需 flush 等 consumer 处理完再断言 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function flush(adapter: any, deadlineMs = 5_000): Promise<void> {
  await adapter['queue'].flush(deadlineMs);
}

function stepMeta(step = 1) {
  return { step, ingestUpTo: null, llmUpTo: null, newMessageCount: 0, hasToolCall: false };
}
function traceMeta() {
  return { runId: 'r', sessionId: 's', inputMessageIds: [] as string[], modelId: 'm', toolNames: [] as string[] };
}

const REAL_USAGE: Usage = {
  input_cache_read: 100, input_cache_write: 50, input_no_cache: 10, input_total_tokens: 160,
  output_response: 20, output_reasoning: 5, output_total_tokens: 25, total_tokens: 185,
  cost: 0.012,
};

describe('LangfuseAdapter — v0.0.50 physical+logical end 配对（AT gap）', () => {
  let Adapter: typeof import('../langfuse-adapter').LangfuseAdapter;

  beforeEach(async () => {
    calls.length = 0;
    obsSeq = 0;
    installSpies();
    Adapter = (await import('../langfuse-adapter')).LangfuseAdapter;
  });
  afterEach(restoreSpies);

  function makeAdapter() {
    return new Adapter({ publicKey: 'pk', secretKey: 'sk', baseUrl: 'http://lf' });
  }

  /**
   * AT 场景：start logical → start physical → end logical（真 usage）→ end physical（空 usage）
   * 验证：两个 obs.update 各自的 usage 字段独立、正确；不相互覆盖。
   */
  it('AT 场景顺序：logical+physical 都 start → end logical（真 usage）→ end physical（空 usage）→ 两 update 各自正确', async () => {
    const a = makeAdapter();
    const trace = a.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const step = a.startSpan({ parent: trace, name: 'step 1', input: { step: 1 }, metadata: stepMeta() });

    const logicalGen = a.startGeneration({
      parent: step, model: 'claude', name: 'llm-1-logical',
      input: {
        system: 'sys', systemCharCount: 3, messages: [], messagesCharCount: 10,
        tools: [], params: {}, modelId: 'claude', iteration: 1,
      },
    });
    const physicalGen = a.startGeneration({
      parent: step, model: 'claude', name: 'llm-1-physical',
      kind: 'physical', physicalInput: { wire: 'body' },
    });

    // v0.0.138：start ops 入队后需 flush 等 consumer 处理完才能读 SDK calls
    await flush(a);

    // 两次 startGeneration → 两次 obs.generation（不同 obs id）
    const genCalls = calls.filter((c) => c.method === 'obs.generation');
    expect(genCalls).toHaveLength(2);
    const logicalObsId = genCalls[0]!.obsId;
    const physicalObsId = genCalls[1]!.obsId;
    expect(logicalObsId).not.toBe(physicalObsId);

    // 清空 calls 只看 end 阶段
    calls.length = 0;

    // AT 顺序：先 end logical（带真 usage），再 end physical（带空 usage）
    a.endGeneration({
      gen: logicalGen,
      output: { message: { id: 'm', sessionId: 's', role: 'assistant', content: [] }, stopReason: 'stop' },
      usage: REAL_USAGE,
      metadata: { iteration: 1, step: 1, cacheReadTokens: 100, cacheWriteTokens: 50 },
      endTime: new Date(),
    });
    a.endGeneration({
      gen: physicalGen,
      usage: {} as Usage,
      metadata: { iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      endTime: new Date(),
    });

    // v0.0.138：end ops 入队后需 flush 等 consumer 处理完才能读 SDK calls
    await flush(a);

    // 两次 update 落在不同 observation 上
    const updates = calls.filter((c) => c.method === 'obs.update');
    expect(updates).toHaveLength(2);
    const logicalUpd = updates.find((u) => u.obsId === logicalObsId);
    const physicalUpd = updates.find((u) => u.obsId === physicalObsId);
    expect(logicalUpd).toBeDefined();
    expect(physicalUpd).toBeDefined();

    // ★ 关键断言：logical update 带 REAL usageDetails（互斥拆分，非 0）+ costDetails
    // cache/reasoning key 用 langfuse Anthropic 原生 snake_case（对齐 langfuse-usage-protocol §二/§四）
    const lArg = logicalUpd!.args[0] as Record<string, unknown>;
    const lUD = lArg['usageDetails'] as Record<string, number>;
    expect(lUD['input']).toBe(10);                // input_no_cache（拆分路径，互斥防双计）
    expect(lUD['cache_read_input_tokens']).toBe(100);
    expect(lUD['cache_creation_input_tokens']).toBe(50);
    expect(lUD['output']).toBe(20);
    expect(lUD['output_reasoning_tokens']).toBe(5);
    const lCD = lArg['costDetails'] as Record<string, number>;
    expect(lCD['total']).toBe(0.012);
    // logical 带 output（透传）
    expect(lArg['output']).toBeDefined();

    // ★ 关键断言：physical update usageDetails 全 0（mapUsageDetails({})）+ costDetails 空
    const pArg = physicalUpd!.args[0] as Record<string, unknown>;
    const pUD = pArg['usageDetails'] as Record<string, number>;
    expect(pUD['input']).toBe(0);
    expect(pUD['output']).toBe(0);
    // physical costDetails 空（cost==null → 不写 total）
    expect(Object.keys(pArg['costDetails'] as Record<string, number>)).toHaveLength(0);
    // physical 不带 output
    expect(pArg['output']).toBeUndefined();
  });

  /**
   * 反向顺序：physical end 先于 logical end（spec 时序图示顺序）。
   * 验证无论 end 顺序，logical 永远带真 usage / physical 永远 0。
   */
  it('反向顺序：end physical 先 → end logical 后 → 各自 usage 仍正确', async () => {
    const a = makeAdapter();
    const trace = a.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const step = a.startSpan({ parent: trace, name: 'step 1', input: { step: 1 }, metadata: stepMeta() });

    const logicalGen = a.startGeneration({
      parent: step, model: 'claude', name: 'llm-1-logical',
      input: {
        system: 'sys', systemCharCount: 3, messages: [], messagesCharCount: 10,
        tools: [], params: {}, modelId: 'claude', iteration: 1,
      },
    });
    const physicalGen = a.startGeneration({
      parent: step, model: 'claude', name: 'llm-1-physical',
      kind: 'physical', physicalInput: { wire: 'body' },
    });

    // v0.0.138：start ops 入队后需 flush 等 consumer 处理完才能读 SDK calls
    await flush(a);
    const genCalls = calls.filter((c) => c.method === 'obs.generation');
    const logicalObsId = genCalls[0]!.obsId;
    const physicalObsId = genCalls[1]!.obsId;

    calls.length = 0;

    // 反向：physical 先 end，logical 后 end
    a.endGeneration({
      gen: physicalGen,
      usage: {} as Usage,
      metadata: { iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      endTime: new Date(),
    });
    a.endGeneration({
      gen: logicalGen,
      output: { message: { id: 'm', sessionId: 's', role: 'assistant', content: [] }, stopReason: 'stop' },
      usage: REAL_USAGE,
      metadata: { iteration: 1, step: 1, cacheReadTokens: 100, cacheWriteTokens: 50 },
      endTime: new Date(),
    });

    // v0.0.138：end ops 入队后需 flush 等 consumer 处理完才能读 SDK calls
    await flush(a);

    const updates = calls.filter((c) => c.method === 'obs.update');
    const logicalUpd = updates.find((u) => u.obsId === logicalObsId);
    const physicalUpd = updates.find((u) => u.obsId === physicalObsId);
    expect(logicalUpd).toBeDefined();
    expect(physicalUpd).toBeDefined();

    const lUD = (logicalUpd!.args[0] as Record<string, unknown>)['usageDetails'] as Record<string, number>;
    // 互斥拆分：input = input_no_cache = 10；cache 单独写不重复计
    expect(lUD['input']).toBe(10);
    expect(lUD['cache_read_input_tokens']).toBe(100);
    const pUD = (physicalUpd!.args[0] as Record<string, unknown>)['usageDetails'] as Record<string, number>;
    expect(pUD['input']).toBe(0);
  });
});
