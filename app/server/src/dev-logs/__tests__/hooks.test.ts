/**
 * 4 hook 单测（spec dev-logs §7）
 * 参考: specs/tech/app/dev-logs/[P0]overall.md §3.1/§3.2/§3.3/§3.4 §7
 *
 * 各 hook：开关 on 时各产一条正确字段 / off 时 no-op（不调 write / write 早 return）。
 *   - llm hook：invoke 成功/失败各产一条（provider/model/request/response|error）
 *   - tool hook：executeOne 产一条（tool/input/output/isError）；not-allowed 不写
 *   - api hook：handleRequest 产一条（method/path/status/requestBody/responseBody）；排除 /sse /health
 *   - event hook：bus.emit 产一条（topic/group/event）—— 见 wrap-bus-with-log.test.ts
 *
 * 测试方式：deps 注入 mock（mock LogWriter.write 计数 + 字段验证），禁真实 spawn 系统命令。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
// llm hook
import { invoke, type InvokeContext, type InvokeBaseReq } from '../../llm/caller/llm_caller';
import { createLlmErrorState } from '../../llm/caller/llm_error_state';
import { createProviderHealthRegistry, __resetProviderHealthRegistryForTest } from '../../llm/caller/provider_health_registry';
import { DEFAULT_LLM_REQUEST_CONFIG } from '../../config/llm_request_config';
import type { LlmClient } from '../../llm/client';
import type { LlmProviderConfig, LlmModelConfig } from '../../llm/provider-types';
import type { StreamEvent } from '../../llm/protocol';
// tool hook
import { ToolExecutionEngine } from '../../tools/engine';
import type { Tool, ToolSessionConfigLike } from '../../tools/types';
import type { ToolCallBlock, ToolResultBlock } from '../../message/types';
// LogWriter
import { LogWriter, resetLogWriterForTest } from '../log-writer';

/** 构造可控开关的 mock devConfig */
function makeMockDevConfig(overrides: Record<string, unknown> = {}): {
  get: (g: string, k: string) => unknown;
} {
  const store: Record<string, unknown> = { ...overrides };
  return { get: (g: string, k: string) => store[`${g}.${k}`] };
}

async function flushAppend(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

/** 读 JSONL 文件全部行 parse */
function readJsonl(p: string): Record<string, unknown>[] {
  const content = readFileSync(p, 'utf-8').trim();
  if (content.length === 0) return [];
  return content.split('\n').map((l) => JSON.parse(l));
}

// ============================================================
// llm hook（spec dev-logs §3.1）
// ============================================================

/** 构造 LlmClient stub（text 流） */
function makeStubTextClient(text: string): LlmClient {
  const streamFn = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', text } as StreamEvent;
    yield { type: 'usage', usage: { output_total_tokens: 10, input_total_tokens: 5 } as never } as StreamEvent;
    yield { type: 'finish', reason: 'stop' } as StreamEvent;
  };
  return { stream: streamFn } as unknown as LlmClient;
}

/** 构造抛错的 LlmClient stub */
function makeStubErrorClient(err: Error): LlmClient {
  const streamFn = async function* (): AsyncGenerator<StreamEvent> {
    throw err;
  };
  return { stream: streamFn } as unknown as LlmClient;
}

function makeProvider(id: string): LlmProviderConfig {
  return {
    id, name: 'anthropic_compatible', protocolId: 'anthropic_messages', baseUrl: `https://${id}.example.com`,
    credentials: { key: 'sk-test' },
    pluginId: 'builtin.anthropic', enabled: true, models: [makeModel('m1')],
  };
}

function makeModel(modelId: string): LlmModelConfig {
  return {
    modelId, inputModalities: ['text'], outputModalities: ['text'],
    contextWindow: 200000, maxOutputTokens: 8192, paramConstraints: {},
    pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
    providerId: '',
    capabilities: { maxOutputTokens: 8192, supportsPrefill: true, supportsThinking: false },
  };
}

function makeCtx(client: LlmClient, logWriter: unknown): InvokeContext {
  const provider = makeProvider('p1');
  const model = provider.models[0]!;
  return {
    errorState: createLlmErrorState(),
    controller: { runId: 'r1', aborted: false },
    providers: new Map([[provider.id, provider]]),
    clientFactory: { getClient: () => client },
    fallback: { provider, keyRef: 'default', model, client },
    config: { ...DEFAULT_LLM_REQUEST_CONFIG, retry: { ...DEFAULT_LLM_REQUEST_CONFIG.retry, backoff_base_s: 0, backoff_cap_s: 0, jitter: false, max_attempts: 1 } },
    health: createProviderHealthRegistry(),
    logWriter: logWriter as LogWriter,
  };
}

function makeBaseReq(): InvokeBaseReq {
  return {
    modelId: 'm1',
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    params: { stream: true, maxTokens: 1024 },
  };
}

describe('llm hook（invoke 级，spec dev-logs §3.1）', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-llmhook-'));
    __resetProviderHealthRegistryForTest();
    resetLogWriterForTest();
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    resetLogWriterForTest();
  });

  it('开关 on + 成功：产一条 {provider, model, request, response}', async () => {
    const devConfig = makeMockDevConfig({ 'logs.enableLlmRequestLog': true });
    const logWriter = new LogWriter(dataDir, devConfig);
    const resp = await invoke(makeBaseReq(), makeCtx(makeStubTextClient('hello'), logWriter));
    await flushAppend();
    expect(resp.message).toBeTruthy();
    const lines = readJsonl(join(dataDir, 'logs', 'llm.log'));
    expect(lines.length).toBe(1);
    const rec = lines[0]!;
    expect(rec.provider).toBe('p1');
    expect(rec.model).toBe('m1');
    expect((rec.request as { modelId: string }).modelId).toBe('m1');
    expect((rec.response as { message: unknown }).message).toBeTruthy();
  });

  it('开关 on + 失败：产一条 {provider, model, request, error}（re-throw 保留）', async () => {
    const devConfig = makeMockDevConfig({ 'logs.enableLlmRequestLog': true });
    const logWriter = new LogWriter(dataDir, devConfig);
    // 抛一个会被 NO_RETRY 的错误（AUTH_INVALID → 不可恢复）
    const err = new Error('auth failed') as Error & { status?: number; body?: unknown };
    err.status = 401;
    err.body = { error: { message: 'auth failed' } };
    await expect(invoke(makeBaseReq(), makeCtx(makeStubErrorClient(err), logWriter))).rejects.toThrow();
    await flushAppend();
    const lines = readJsonl(join(dataDir, 'logs', 'llm.log'));
    expect(lines.length).toBe(1);
    const rec = lines[0]!;
    expect(rec.provider).toBe('p1');
    expect(rec.error).toBeTruthy();
    // 错误字段含 category/message（具体值由 classify 决定，只验证结构）
    expect(typeof (rec.error as { message?: string }).message).toBe('string');
  });

  it('开关 off：不写日志（no-op，零开销）', async () => {
    const devConfig = makeMockDevConfig({}); // 开关缺省 false
    const logWriter = new LogWriter(dataDir, devConfig);
    await invoke(makeBaseReq(), makeCtx(makeStubTextClient('hi'), logWriter));
    await flushAppend();
    expect(existsSync(join(dataDir, 'logs', 'llm.log'))).toBe(false);
  });

  it('logWriter 未注入（undefined）：不写日志', async () => {
    const devConfig = makeMockDevConfig({ 'logs.enableLlmRequestLog': true });
    // ctx 不传 logWriter（undefined）
    const ctx = makeCtx(makeStubTextClient('hi'), undefined);
    await invoke(makeBaseReq(), ctx);
    await flushAppend();
    expect(existsSync(join(dataDir, 'logs', 'llm.log'))).toBe(false);
  });
});

// ============================================================
// tool hook（spec dev-logs §3.2）
// ============================================================

/** 构造最小 echo tool */
function makeEchoTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `${name} tool`,
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
    },
    async run(input: unknown) {
      return { content: [{ type: 'text' as const, text: `echo:${JSON.stringify(input)}` }], isError: false };
    },
  };
}

describe('tool hook（executeOne 级，spec dev-logs §3.2）', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-toolhook-'));
    resetLogWriterForTest();
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    resetLogWriterForTest();
  });

  it('开关 on：每次工具调用产一条 {tool, input, output, isError}', async () => {
    const devConfig = makeMockDevConfig({ 'logs.enableToolResultLog': true });
    const logWriter = new LogWriter(dataDir, devConfig);
    const engine = new ToolExecutionEngine();
    const config: ToolSessionConfigLike = { tools: [makeEchoTool('echo')], logWriter };
    const calls: ToolCallBlock[] = [{ id: 'c1', type: 'tool_call', name: 'echo', arguments: { msg: 'a' } }];
    const results = (await engine.execute(config, calls)).results;
    await flushAppend();
    expect(results.length).toBe(1);
    const lines = readJsonl(join(dataDir, 'logs', 'tool.log'));
    expect(lines.length).toBe(1);
    const rec = lines[0]!;
    expect(rec.tool).toBe('echo');
    expect(rec.input).toEqual({ msg: 'a' });
    // output 是 ContentBlock[]
    expect(Array.isArray(rec.output)).toBe(true);
    expect((rec.output as { type: string; text: string }[])[0]!.type).toBe('text');
    expect(rec.isError).toBe(false);
  });

  it('not-allowed 分支不写日志（避免噪音，spec §3.2）', async () => {
    const devConfig = makeMockDevConfig({ 'logs.enableToolResultLog': true });
    const logWriter = new LogWriter(dataDir, devConfig);
    const engine = new ToolExecutionEngine();
    const config: ToolSessionConfigLike = { tools: [makeEchoTool('echo')], logWriter };
    // allowedTools=[] 全拦，call 走 not-allowed 分支不执行
    const calls: ToolCallBlock[] = [{ id: 'c1', type: 'tool_call', name: 'echo', arguments: {} }];
    const results = (await engine.execute(config, calls, [])).results; // allowedTools=[]
    await flushAppend();
    expect(results.length).toBe(1);
    expect((results[0] as ToolResultBlock).isError).toBe(true); // not-allowed 标 isError
    expect(existsSync(join(dataDir, 'logs', 'tool.log'))).toBe(false); // 不写
  });

  it('开关 off：不写日志（no-op）', async () => {
    const devConfig = makeMockDevConfig({}); // false
    const logWriter = new LogWriter(dataDir, devConfig);
    const engine = new ToolExecutionEngine();
    const config: ToolSessionConfigLike = { tools: [makeEchoTool('echo')], logWriter };
    await engine.execute(config, [{ id: 'c1', type: 'tool_call', name: 'echo', arguments: { msg: 'a' } }]);
    await flushAppend();
    expect(existsSync(join(dataDir, 'logs', 'tool.log'))).toBe(false);
  });

  it('logWriter 未注入（undefined）：不写日志', async () => {
    const engine = new ToolExecutionEngine();
    const config: ToolSessionConfigLike = { tools: [makeEchoTool('echo')] }; // 无 logWriter
    await engine.execute(config, [{ id: 'c1', type: 'tool_call', name: 'echo', arguments: {} }]);
    await flushAppend();
    // 无 dataDir 也无文件（仅验证不抛）
    expect(engine).toBeTruthy();
  });

  it('工具 run 抛错：异常路径也写一条 isError=true', async () => {
    const devConfig = makeMockDevConfig({ 'logs.enableToolResultLog': true });
    const logWriter = new LogWriter(dataDir, devConfig);
    const throwTool: Tool = {
      definition: { name: 'boom', description: 'throws', inputSchema: { type: 'object' } },
      async run() { throw new Error('boom!'); },
    };
    const engine = new ToolExecutionEngine();
    const config: ToolSessionConfigLike = { tools: [throwTool], logWriter };
    await engine.execute(config, [{ id: 'c1', type: 'tool_call', name: 'boom', arguments: {} }]);
    await flushAppend();
    const lines = readJsonl(join(dataDir, 'logs', 'tool.log'));
    expect(lines.length).toBe(1);
    expect(lines[0]!.tool).toBe('boom');
    expect(lines[0]!.isError).toBe(true);
  });
});
