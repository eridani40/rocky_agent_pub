/**
 * LangfuseAdapter 单测 — v0.0.25 BUG-001 §3 metadata 补全。
 * 参考: specs/api/version_logs/v0.0.25/change_log.md §3
 *       states/v0.0.25/bugs/BUG-001-tool-result-visibility-[open].md
 *
 * 覆盖：
 *   - mapGenMetadata：physical_wire_body / errorCategory / retry_chain 字段写入
 *     （不传字段时 undefined → 不写入，向后兼容）
 *   - endGeneration status='error'：写 level:ERROR + status:ERROR + metadata.errorCategory
 *   - endGeneration status='success'（默认）：不写 level / status（向后兼容）
 *   - endGeneration errorCategory 入参优先于 metadata.errorCategory
 *   - output 省略（error 路径）时不写入 output 字段
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Langfuse } from 'langfuse';
import type { Usage } from '../../message/types';

type SpyFn = ReturnType<typeof vi.fn>;
interface ObsMock {
  update: SpyFn;
  span: SpyFn;
  generation: SpyFn;
}
type Call = { method: string; args: unknown[] };

const calls: Call[] = [];

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

let traceSpy: SpyFn | null = null;
const proto = Langfuse.prototype as { trace?: unknown };
const origTrace = proto.trace;

function installSpies(): void {
  traceSpy = vi.fn((p: unknown) => {
    calls.push({ method: 'client.trace', args: [p] });
    return makeObs();
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

const ZERO_USAGE: Usage = {
  input_cache_read: 0, input_cache_write: 0, input_no_cache: 0, input_total_tokens: 0,
  output_response: 0, output_reasoning: 0, output_total_tokens: 0, total_tokens: 0,
  cost: 0,
};

// ============================================================
// 1. mapGenMetadata 字段映射（纯函数，无 SDK）
// ============================================================

describe('mapGenMetadata (v0.0.25 BUG-001 §3)', () => {
  let mapGenMetadata: typeof import('../langfuse-metadata').mapGenMetadata;
  beforeEach(async () => {
    calls.length = 0;
    mapGenMetadata = (await import('../langfuse-metadata')).mapGenMetadata;
  });

  it('基础字段（iteration/step/cache/duration）透传', () => {
    const out = mapGenMetadata({
      iteration: 2, step: 1, cacheReadTokens: 100, cacheWriteTokens: 50,
      durationMs: 1234,
    });
    expect(out['iteration']).toBe(2);
    expect(out['step']).toBe(1);
    expect(out['cacheReadTokens']).toBe(100);
    expect(out['cacheWriteTokens']).toBe(50);
    expect(out['durationMs']).toBe(1234);
  });

  it('physical_wire_body 写入（onWire 钩子记录的 wire body）', () => {
    const wireBody = {
      model: 'claude',
      messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'REAL' }] }],
    };
    const out = mapGenMetadata({
      iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      physicalWireBody: wireBody,
    });
    expect(out['physical_wire_body']).toEqual(wireBody);
  });

  it('physical_wire_body 未传时不写入（向后兼容）', () => {
    const out = mapGenMetadata({
      iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    expect(out['physical_wire_body']).toBeUndefined();
  });

  it('errorCategory 从 category 入参写入', () => {
    const out = mapGenMetadata(
      { iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      'AUTH_INVALID',
    );
    expect(out['errorCategory']).toBe('AUTH_INVALID');
  });

  it('errorCategory 从 metadata.errorCategory 写入（category 入参缺省时）', () => {
    const out = mapGenMetadata({
      iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      errorCategory: 'PROVIDER_OVERLOADED',
    });
    expect(out['errorCategory']).toBe('PROVIDER_OVERLOADED');
  });

  it('errorCategory 入参优先于 metadata.errorCategory', () => {
    const out = mapGenMetadata(
      {
        iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
        errorCategory: 'LOOP_ERROR',
      },
      'AUTH_INVALID',
    );
    expect(out['errorCategory']).toBe('AUTH_INVALID');
  });

  it('errorCategory 都未传时不写入（向后兼容）', () => {
    const out = mapGenMetadata({
      iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    expect(out['errorCategory']).toBeUndefined();
  });

  it('retry_chain 写入（attemptLoop 多次 attempt 记录）', () => {
    const chain = [
      { providerId: 'p1', keyRef: 'default', attempt: 1, category: 'RATE_LIMITED', delayMs: 2000 },
      { providerId: 'p1', keyRef: 'default', attempt: 2, category: undefined, delayMs: undefined },
    ];
    const out = mapGenMetadata({
      iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      retryChain: chain,
    });
    expect(out['retry_chain']).toEqual(chain);
  });

  it('retry_chain 空数组时不写入', () => {
    const out = mapGenMetadata({
      iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      retryChain: [],
    });
    expect(out['retry_chain']).toBeUndefined();
  });

  // [v0.0.353 T2] provider 真实记录（调用谁记录谁）
  it('[T2] providerId/providerName/modelId 透传（physical generation 真实信息）', () => {
    const out = mapGenMetadata({
      iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      providerId: 'p1', providerName: 'anthropic_compatible', modelId: 'real-m1',
    });
    expect(out['providerId']).toBe('p1');
    expect(out['providerName']).toBe('anthropic_compatible');
    expect(out['modelId']).toBe('real-m1');
  });

  it('[T2] logicalView 标识透传（A1 治理）', () => {
    const out = mapGenMetadata({
      iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      logicalView: true,
    });
    expect(out['logicalView']).toBe(true);
  });

  it('[T2] provider 字段未传时不写入（向后兼容）', () => {
    const out = mapGenMetadata({
      iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    expect(out['providerId']).toBeUndefined();
    expect(out['providerName']).toBeUndefined();
    expect(out['modelId']).toBeUndefined();
    expect(out['logicalView']).toBeUndefined();
  });
});

// ============================================================
// 2. endGeneration error 路径集成（LangfuseAdapter）
// ============================================================

describe('LangfuseAdapter.endGeneration (v0.0.25 BUG-001 §3)', () => {
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

  /** 在给定 adapter 上创建一个 generation（返回 GenHandle） */
  function makeGen(a: ReturnType<typeof makeAdapter>) {
    const trace = a.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    const step = a.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    return a.startGeneration({
      parent: step,
      model: 'claude',
      input: {
        system: 'sys', systemCharCount: 3, messages: [], messagesCharCount: 10,
        tools: [], params: { stream: true }, modelId: 'claude', iteration: 1,
      },
    });
  }

  it("status='error' 写 level:ERROR + status:ERROR + metadata.errorCategory", async () => {
    const a = makeAdapter();
    const gen = makeGen(a);
    a.endGeneration({
      gen,
      usage: ZERO_USAGE,
      metadata: { iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      status: 'error',
      errorCategory: 'AUTH_INVALID',
    });
    await flush(a);
    const upd = calls
      .filter(c => c.method === 'obs.update')
      .map(c => c.args[0] as Record<string, unknown>);
    const err = upd.find(u => u['level'] === 'ERROR');
    expect(err).toBeDefined();
    expect(err!['status']).toBe('ERROR');
    const meta = err!['metadata'] as Record<string, unknown>;
    expect(meta['errorCategory']).toBe('AUTH_INVALID');
  });

  it("status='error' output 省略时不写入 output 字段（错误路径无有效产出）", async () => {
    const a = makeAdapter();
    const gen = makeGen(a);
    a.endGeneration({
      gen,
      usage: ZERO_USAGE,
      metadata: { iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      status: 'error',
      errorCategory: 'CONTENT_FILTERED',
    });
    await flush(a);
    const upd = calls
      .filter(c => c.method === 'obs.update')
      .map(c => c.args[0] as Record<string, unknown>);
    const err = upd.find(u => u['level'] === 'ERROR');
    expect(err).toBeDefined();
    expect(err!['output']).toBeUndefined();
  });

  it("status 默认（不传）= success：不写 level / status（向后兼容）", async () => {
    const a = makeAdapter();
    const gen = makeGen(a);
    a.endGeneration({
      gen,
      output: {
        message: { id: 'm', sessionId: 's', role: 'assistant', content: [] },
        stopReason: 'stop',
      },
      usage: ZERO_USAGE,
      metadata: { iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      // 不传 status
    });
    await flush(a);
    const upd = calls
      .filter(c => c.method === 'obs.update')
      .map(c => c.args[0] as Record<string, unknown>);
    const successUpd = upd.find(u => u['output'] !== undefined);
    expect(successUpd).toBeDefined();
    expect(successUpd!['level']).toBeUndefined();
    expect(successUpd!['status']).toBeUndefined();
  });

  it('physical_wire_body 从 metadata 写入 langfuse generation（BUG-001 核心）', async () => {
    const a = makeAdapter();
    const gen = makeGen(a);
    const wireBody = { model: 'claude', messages: [{ role: 'user', content: 'REAL' }] };
    a.endGeneration({
      gen,
      output: {
        message: { id: 'm', sessionId: 's', role: 'assistant', content: [] },
        stopReason: 'stop',
      },
      usage: ZERO_USAGE,
      metadata: {
        iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
        physicalWireBody: wireBody,
      },
    });
    await flush(a);
    const upd = calls
      .filter(c => c.method === 'obs.update')
      .map(c => c.args[0] as Record<string, unknown>);
    const successUpd = upd.find(u => u['output'] !== undefined);
    const meta = successUpd!['metadata'] as Record<string, unknown>;
    expect(meta['physical_wire_body']).toEqual(wireBody);
  });

  it('error 路径 retry_chain 写入（attemptLoop 失败链）', async () => {
    const a = makeAdapter();
    const gen = makeGen(a);
    const chain = [
      { providerId: 'p1', keyRef: 'default', attempt: 1, category: 'RATE_LIMITED', delayMs: 2000 },
      { providerId: 'p1', keyRef: 'default', attempt: 2, category: 'RATE_LIMITED', delayMs: 4000 },
      { providerId: 'p1', keyRef: 'default', attempt: 3, category: 'RATE_LIMITED', delayMs: 8000 },
    ];
    a.endGeneration({
      gen,
      usage: ZERO_USAGE,
      metadata: {
        iteration: 1, step: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
        errorCategory: 'RATE_LIMITED',
        retryChain: chain,
      },
      status: 'error',
      errorCategory: 'RATE_LIMITED',
    });
    await flush(a);
    const upd = calls
      .filter(c => c.method === 'obs.update')
      .map(c => c.args[0] as Record<string, unknown>);
    const err = upd.find(u => u['level'] === 'ERROR');
    const meta = err!['metadata'] as Record<string, unknown>;
    expect(meta['retry_chain']).toEqual(chain);
    expect(meta['errorCategory']).toBe('RATE_LIMITED');
  });
});
