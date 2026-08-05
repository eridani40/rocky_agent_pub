/**
 * BUG-002 防回归测试 — mock-llm 非流式响应 + compact 完整路径
 * 参考: states/v0.0.8/bugs/BUG-002-context-engine-compact-not-triggered-[fixed].md
 *
 * BUG-002 根因：mock-llm 之前不按 request body 的 stream 字段分流。
 * compact 路径用 client.call（非流式，期望 /v1/messages 返标准 JSON），
 * 但 mock 始终返 SSE 流 → client.call 的 `await resp.json()` 解析 SSE 文本失败抛错
 * → agent-loop 顶层 catch → run 以 stopReason=error 结束 → setSummary 没执行。
 *
 * 本测试覆盖（端到端经 mock fetch）：
 *   1. mock:compact stream:false → mock fetch 返标准 anthropic JSON（content-type=application/json）
 *   2. 经真实 LlmClient.call 解析，resp.message.content 含 <summary> 文本
 *   3. ContextEngine.compact 完整流程（mock:compact + contextWindow=500 + 长历史）
 *      → setSummary 被调、GET /summary 非 null
 *   4. assemble contextWindowUsage 用 client.contextWindow（=modelConfig.contextWindow=500）
 *
 * 隔离：fs engine + 临时 DATA_DIR（os.tmpdir + mkdtempSync）+ afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockFetch } from '../mock-llm';
import { LlmClient } from '../llm/client';
import AnthropicMessagesProtocol from '../../../plugins/builtins/llm_anthropic/protocol';
import { CompositeStore } from '../persistence/composite';
import { FsCrudStore } from '../persistence/fs-store';
import { ulid } from '../config/ulid';
import { SessionStore } from '../agent/session-store';
import { ContextEngine, extractTag } from '../agent/context-engine';
import { SessionKind } from '@app/shared';
import type { SessionConfig } from '../agent/context-types';
import type { MessageInput } from '../message/types';
import type { LlmProviderConfig, LlmModelConfig } from '../llm/provider-types';
import type { LlmProvider } from '../llm/provider';

let tmpRoot: string;
let store: SessionStore;
let engine: ContextEngine;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-compact-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  engine = new ContextEngine({ store });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造一个用 mock fetch 的 LlmClient（不走真实网络） */
function makeClient(contextWindow: number): LlmClient {
  const providerConfig: LlmProviderConfig = {
    id: 'provider-mock',
    name: 'mock',
    kind: 'anthropic',
    baseUrl: 'http://mock',
    credentials: { key: 'test-key' },
  } as unknown as LlmProviderConfig;
  const provider: LlmProvider = {
    buildAuthHeaders: () => ({ 'x-api-key': 'test-key' }),
    protocol: 'anthropic',
  } as unknown as LlmProvider;
  const protocol = new AnthropicMessagesProtocol('anthropic');
  const modelConfig: LlmModelConfig = {
    id: 'mock:compact',
    label: 'mock compact',
    providerId: 'provider-mock',
    contextWindow,
    // v0.0.10 t6：client.call 现在按 spec §3.3 消费 modelConfig.pricing 算 cost，
    // 测试需补 pricing 字段（否则 computeCost 访问 inputPerMillion 会炸）
    pricing: {
      inputPerMillion: 3,
      outputPerMillion: 15,
      currency: 'USD',
    },
  } as unknown as LlmModelConfig;
  return new LlmClient({
    providerConfig,
    provider,
    protocol,
    modelConfig,
    fetchImpl: createMockFetch({ stepDelayMs: 0 }),
  });
}

/** 一条业务消息 */
function newMessage(sessionId: string, text: string, role: 'user' | 'assistant' = 'user'): MessageInput {
  return { id: ulid(), sessionId, role, content: [{ type: 'text', text }] };
}

describe('BUG-002: mock-llm 非流式响应（compact 路径）', () => {
  it('mock:compact stream:false → mock fetch 返标准 anthropic JSON', async () => {
    const fetchImpl = createMockFetch({ stepDelayMs: 0 });
    // 模拟 client.call prepare 后的 body：params.stream=false
    const resp = await fetchImpl('http://mock/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'mock:compact',
        messages: [{ role: 'user', content: 'hi' }],
        params: { stream: false },
      }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('application/json');
    // 关键：必须能被 resp.json() 解析（SSE 流做不到）
    const body = (await resp.json()) as { type: string; content: Array<{ type: string; text: string }> };
    expect(body.type).toBe('message');
    expect(body.content[0]!.type).toBe('text');
    expect(body.content[0]!.text).toContain('<summary>');
  });

  it('mock:text stream:true → mock fetch 仍返 SSE（不破坏正常 chat 路径）', async () => {
    const fetchImpl = createMockFetch({ stepDelayMs: 0 });
    const resp = await fetchImpl('http://mock/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'mock:text',
        messages: [{ role: 'user', content: 'hi' }],
        params: { stream: true },
      }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    const text = await resp.text();
    expect(text).toContain('event: message_start');
  });
});

describe('BUG-002: 经真实 LlmClient.call 的 compact 完整路径', () => {
  it('compact 调 client.call → 解析 JSON 成功 → setSummary 被调', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const client = makeClient(500);
    const config: SessionConfig = {
      sessionId: sid,
      systemPrompt: 'You are helpful.',
      client,
      modelId: 'mock:compact',
      // 生产 compact() 的 config 必带 kind（resolveConfigBySid 注入），assemble 按 session scope 解析
      kind: new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent' }),
    };

    // 灌超阈值历史（char ≫ 500）触发 compact
    const big = 'x'.repeat(2000);
    const msgs: MessageInput[] = [];
    for (let i = 0; i < 4; i++) {
      msgs.push(newMessage(sid, big, 'user'));
      msgs.push(newMessage(sid, 'y'.repeat(500), 'assistant'));
    }
    await store.appendMessages(sid, msgs);

    // 验证 assemble 用对 contextWindow（=500），remainingTokens<0
    // [v0.0.16] 7 字段：totalTokens 是 input 侧 token；remainingTokens = tokenLimit - totalTokens - maxOutput
    const snap = await engine.assemble(config);
    expect(snap.contextWindowUsage.tokenLimit).toBe(500);
    expect(snap.contextWindowUsage.totalTokens).toBeGreaterThan(500);
    expect(snap.contextWindowUsage.remainingTokens).toBeLessThan(0);

    // v0.0.15 T5：ContextEngine.compact 改走 sideRunner 回调（bootstrap 注 manager.sideRun）。
    // 本测试不引 manager，直接注入一个用 client.call（非流式）的 stub，复现旧 ForkedAgent NO_TOOLS 行为。
    engine.setSideRunner(async (input) => {
      const resp = await client.call({
        modelId: config.modelId,
        messages: [
          { id: 'sys', role: 'system', content: input.snapshot.system },
          ...input.snapshot.messages,
          input.userMessage,
        ] as unknown as Parameters<typeof client.call>[0]['messages'],
        params: { stream: false },
      });
      const textBlock = resp.message.content.find((b) => b.type === 'text') as { text: string } | undefined;
      return { answer: textBlock?.text ?? '', usage: resp.usage };
    });

    // 跑 compact（关键：不抛错 = mock 非流式修复生效）
    await engine.compact(config);

    // setSummary 被调，GET /summary 非 null
    const summary = await store.getSummary(sid);
    expect(summary).not.toBeNull();
    expect(summary!.content).toBeTruthy();
    // extractTag 能从 <summary> 解出（验 mock:compact 响应格式正确）
    expect(extractTag(summary!.content as string, 'summary')).toBe(summary!.content);
  });
});
