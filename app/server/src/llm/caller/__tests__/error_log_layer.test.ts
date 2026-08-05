/**
 * v0.0.144 需求1+3 后端 — 分层失败日志（error.log layer=llm）+ llm_attempt 补字段 UT
 * 参考: specs/tech/version_logs/v0.0.144/change_plan.md「需求 1」+「需求 3 后端」
 *       specs/tech/dev-logs/[P0]overall.md §3.6（error.log + layer 字段）
 *       specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §3.1（llm_attempt emit）
 *
 * 覆盖：
 *   1. 每次 attempt 失败经 ctx.logWriter 写一条 layer:'llm' 精简失败事件（含重试中每次）：
 *      enableErrorLog=true + stub 恒错 max_attempts=3 → error.log 收 3 条（含 category/attempt）；
 *      enableErrorLog=false → 零写入（LogWriter 内部零开销早 return，文件不创建）。
 *   2. emitLlmAttempt 合成 event 含 maxAttempts + message（= deriveDisplayReason(category)）。
 *   3. invoke onEvent 集成：8 处 emit 调用点补传 config.retry.max_attempts → 出站 llm_attempt
 *      StreamEvent 携带 maxAttempts（= config 值）+ message。
 *
 * 文件系统隔离：真实落盘用 os.tmpdir + mkdtempSync + afterEach 清理；health 每例独立 registry。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invoke, type InvokeContext, type InvokeBaseReq } from '../llm_caller';
import { buildInvokeContext } from '../build_invoke_context';
import { createLlmErrorState } from '../llm_error_state';
import {
  createProviderHealthRegistry,
  __resetProviderHealthRegistryForTest,
} from '../provider_health_registry';
import { DEFAULT_LLM_REQUEST_CONFIG } from '../../../config/llm_request_config';
import { LogWriter } from '../../../dev-logs/log-writer';
import { emitLlmAttempt } from '../llm_attempt_emit';
import { deriveDisplayReason } from '../display_reason';
import { LlmErrorCategory } from '../error_types';
import type { LlmClient } from '../../client';
import type { StreamEvent } from '../../protocol';

// ── 测试辅助 ──

/** 构造可控开关的 mock appConfig（按 (group,key) 返回值，镜像 dev-logs/__tests__）。 */
function makeMockAppConfig(overrides: Record<string, unknown> = {}): {
  get: (g: string, k: string) => unknown;
} {
  const store: Record<string, unknown> = { ...overrides };
  return { get: (g: string, k: string) => store[`${g}.${k}`] };
}

/** v0.0.138 起 LogQueue 异步 bounded consumer，write fire-and-forget 入队后需 flush 等落盘。 */
async function flushQueue(w: LogWriter, deadlineMs = 5_000): Promise<void> {
  await (w as unknown as { queue: { flush(ms: number): Promise<void> } }).queue.flush(deadlineMs);
}

/** 读 error.log 并 parse 成对象数组（文件不存在 → 空数组）。 */
function readErrorLog(dataDir: string): Record<string, unknown>[] {
  const path = join(dataDir, 'logs', 'error.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/** HTTP 500 错（SERVER_ERROR，retryable → attempt<max 走 RETRY，attempt==max 走 NO_RETRY throw）。 */
function http500(): Error {
  const e = new Error('server error');
  (e as unknown as { status: number }).status = 500;
  (e as unknown as { body: unknown }).body = { error: { type: 'api_error', message: 'server error' } };
  return e;
}

async function* textStream(text: string): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', text };
  yield { type: 'usage', usage: { output_total_tokens: 10, input_total_tokens: 5 } as never };
  yield { type: 'finish', reason: 'stop' };
}

/** 构造 stub client：按序号抛错或产流（duck-typed，无 getInfo → buildInvokeContext 用 stub 兜底形态）。 */
function makeStubClient(streams: Array<AsyncIterable<StreamEvent> | Error>): LlmClient {
  let idx = 0;
  const stream = async function* (_req: unknown, _signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const cur = streams[idx++];
    if (cur === undefined) throw new Error(`stub client: no stream queued for call ${idx - 1}`);
    if (cur instanceof Error) throw cur;
    for await (const evt of cur) yield evt;
  };
  return { stream } as unknown as LlmClient;
}

function makeBaseReq(): InvokeBaseReq {
  return {
    modelId: 'm1',
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    params: { stream: true, maxTokens: 1024 },
  };
}

/** 零退避 config（避免 sleep 拖慢），仅覆盖 max_attempts。 */
function configWithMaxAttempts(max: number) {
  return {
    ...DEFAULT_LLM_REQUEST_CONFIG,
    retry: { ...DEFAULT_LLM_REQUEST_CONFIG.retry, max_attempts: max, backoff_base_s: 0, backoff_cap_s: 0, jitter: false },
  };
}

beforeEach(() => {
  __resetProviderHealthRegistryForTest();
});

// ============================================================
// 1. per-attempt error.log（layer='llm'，含重试中每次）
// ============================================================
describe('[v0.0.144 需求1] invoke 每次 attempt 失败经 error.log 写 layer=llm', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-errlog-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('enableErrorLog=true + 恒错 max_attempts=3 → error.log 收 3 条 layer=llm（含 category/attempt）', async () => {
    const appConfig = makeMockAppConfig({ 'logs.enableErrorLog': true });
    const logWriter = new LogWriter(dataDir, appConfig);
    const client = makeStubClient([http500(), http500(), http500()]);
    const ctx = buildInvokeContext({
      client,
      errorState: createLlmErrorState(),
      sessionId: 'sess-err',
      controller: { runId: 'r1', aborted: false },
      logWriter,
    });
    ctx.config = configWithMaxAttempts(3);
    ctx.health = createProviderHealthRegistry();

    await expect(invoke(makeBaseReq(), ctx)).rejects.toThrow();
    await flushQueue(logWriter);

    const lines = readErrorLog(dataDir);
    // 每次 attempt 失败一条（含重试中每次）→ 恰 3 条
    expect(lines.length).toBe(3);
    for (const l of lines) {
      expect(l.layer).toBe('llm');
      expect(l.sessionId).toBe('sess-err');
      expect(l.category).toBe(LlmErrorCategory.SERVER_ERROR);
      expect(typeof l.message).toBe('string');
      expect(l.providerId).toBeDefined();
      expect(l.modelId).toBeDefined();
      expect(l.keyRef).toBe('default');
    }
    // attempt 覆盖 1/2/3（fire-and-forget 单队列 FIFO；按集合断言更稳）
    const attempts = new Set(lines.map((l) => l.attempt));
    expect(attempts).toEqual(new Set([1, 2, 3]));
  });

  it('enableErrorLog=false → 零写入（零开销早 return，error.log 文件不创建）', async () => {
    const appConfig = makeMockAppConfig({}); // 缺省 false
    const logWriter = new LogWriter(dataDir, appConfig);
    const client = makeStubClient([http500(), http500(), http500()]);
    const ctx = buildInvokeContext({
      client,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
      logWriter,
    });
    ctx.config = configWithMaxAttempts(3);
    ctx.health = createProviderHealthRegistry();

    await expect(invoke(makeBaseReq(), ctx)).rejects.toThrow();
    await flushQueue(logWriter);

    expect(existsSync(join(dataDir, 'logs', 'error.log'))).toBe(false);
  });
});

// ============================================================
// 2. emitLlmAttempt 合成 event 含 maxAttempts + message
// ============================================================
describe('[v0.0.144 需求3] emitLlmAttempt 合成 event 含 maxAttempts + message', () => {
  it('attempt 失败 → event.maxAttempts=传入值、event.message=deriveDisplayReason(category)', () => {
    const events: StreamEvent[] = [];
    const ctx = { onEvent: (e: StreamEvent) => events.push(e) } as unknown as InvokeContext;
    emitLlmAttempt(
      ctx,
      LlmErrorCategory.RATE_LIMITED,
      { providerId: 'p1', keyRef: 'k1', model: { modelId: 'm1' } },
      2,
      'RETRY',
      5,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'llm_attempt',
      category: LlmErrorCategory.RATE_LIMITED,
      providerId: 'p1',
      keyRef: 'k1',
      modelId: 'm1',
      attempt: 2,
      maxAttempts: 5,
      action: 'RETRY',
      message: deriveDisplayReason(LlmErrorCategory.RATE_LIMITED),
    });
  });

  it('终结 all_dead FAIL（target=null）→ maxAttempts 透传、providerId 空串、message 派生', () => {
    const events: StreamEvent[] = [];
    const ctx = { onEvent: (e: StreamEvent) => events.push(e) } as unknown as InvokeContext;
    emitLlmAttempt(ctx, LlmErrorCategory.SERVER_ERROR, null, 0, 'FAIL', 3);
    expect(events[0]).toMatchObject({
      type: 'llm_attempt',
      action: 'FAIL',
      attempt: 0,
      maxAttempts: 3,
      providerId: '',
      modelId: '',
      message: deriveDisplayReason(LlmErrorCategory.SERVER_ERROR),
    });
  });
});

// ============================================================
// 3. invoke onEvent 集成：出站 llm_attempt 携带 maxAttempts(=config) + message
// ============================================================
describe('[v0.0.144 需求3] invoke 出站 llm_attempt 携带 maxAttempts(=config.retry.max_attempts) + message', () => {
  it('SERVER_ERROR 首次失败 RETRY → llm_attempt.maxAttempts=config 值、message=派生文案', async () => {
    const events: StreamEvent[] = [];
    // 第 1 次错、第 2 次成功 → 只 emit 一次 RETRY
    const client = makeStubClient([http500(), textStream('ok')]);
    const ctx = buildInvokeContext({
      client,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
      onEvent: (e) => events.push(e),
    });
    ctx.config = configWithMaxAttempts(4);
    ctx.health = createProviderHealthRegistry();

    await invoke(makeBaseReq(), ctx);

    const attempt = events.find((e) => e.type === 'llm_attempt') as
      | Extract<StreamEvent, { type: 'llm_attempt' }>
      | undefined;
    expect(attempt).toBeDefined();
    expect(attempt!.action).toBe('RETRY');
    expect(attempt!.attempt).toBe(1);
    expect(attempt!.maxAttempts).toBe(4);
    expect(attempt!.message).toBe(deriveDisplayReason(LlmErrorCategory.SERVER_ERROR));
  });
});
