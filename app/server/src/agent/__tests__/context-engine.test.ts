/**
 * ContextEngine 单元测试 — ingest / assemble / compact
 * 参考: specs/tech/version_logs/v0.0.8/change_log.md §5
 *       states/v0.0.13/design.md S2（compact 重写用 forked agent + CAS）
 *
 * 覆盖：
 *   (a) ingest 仅 append（前后 getMessages 数量 +N）
 *   (b) assemble 无 summary → picked=all；有 summary 且 >6 → picked=[head3, summaryMsg, tail3]
 *   (c) compact（v0.0.13 重写）：
 *       - markSummaryRunning CAS → ForkedAgent.run(NO_TOOLS, system 注入) → setSummary → markSummaryDone
 *       - CAS 失败（已有 compact 在跑）→ 跳过
 *       - failed 路径（LLM 异常 → markSummaryFailed + setSummary 不被调）
 *       - forked agent 注入 system message（D2.2）→ call.messages 首条 role=system
 *       - summaryUpTo=末尾 messageId、version 递增、extractTag 解析（含「无标签取全文」容错）
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
import { SessionTaskLock } from '../session-task-lock';
import { ContextEngine, extractTag } from '../context-engine';
import { SessionKind } from '@app/shared';
import type { SessionConfig } from '../context-types';
import type { MessageInput } from '../../message/types';
import type { LlmClient } from '../../llm/client';
import type { CanonicalRequest, CanonicalResponse } from '../../llm/protocol';

// ── 公共 fixture ──

let tmpRoot: string;
let store: SessionStore;
let engine: ContextEngine;
/**
 * v0.0.158：CompactSideRunner input 删除 `config` 字段——bootstrap 生产实现从
 *   `agentManager.resolveConfigBySid(sessionId)` 自 resolve。UT 无 agentManager，改用
 *   `configBySid` 映射（newConfig 时登记，mock runner 按 sessionId 反查）代替生产链。
 */
const configBySid = new Map<string, SessionConfig>();

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-context-engine-'));
  configBySid.clear();
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  engine = new ContextEngine({ store });
  // v0.0.55：注入 SessionTaskLock（compact 互斥统一锁，subsumes summaryTask CAS）
  engine.setTaskLock(new SessionTaskLock());
  // v0.0.15 T5：compact 走 manager.sideRun（contextEngine.sideRunner）。
  // UT 不直接构造完整 manager（避免引入 bus/toolEngine 依赖），改注入一个 mock runner：
  // 直接调用 SessionConfig.client.call（非流式），断言 compact 行为不变。
  // 注：原 UT 断言 client.call 被调用、callArg.modelId/messages 结构——本 mock 透传 req，
  //     所以 system 注入 / NO_TOOLS / messages 长度等断言仍有效。
  // v0.0.158：input 无 config 字段，改按 sessionId 从 configBySid 反查（模拟生产 resolveConfigBySid）。
  (engine as unknown as { setSideRunner: (r: unknown) => void }).setSideRunner(
    async (input: {
      sessionId: string;
      snapshot: { system: { role: string }; messages: unknown[] };
      userMessage: { role: string; content: { text?: string }[] };
    }) => {
      const cfg = configBySid.get(input.sessionId);
      if (!cfg) throw new Error(`test fixture: no config registered for sid=${input.sessionId}`);
      // 直接调用 client.call（绕过 ForkedAgent 的流式 + system 注入）
      // 用与 ForkedAgent 相同的 system 注入（D2.2）：system prepend 到 messages 前
      const protocolMessages = [
        input.snapshot.system as never,
        ...input.snapshot.messages as never[],
        input.userMessage as never,
      ];
      const req: CanonicalRequest = {
        modelId: cfg.modelId,
        messages: protocolMessages as unknown as CanonicalRequest['messages'],
        params: {},
      };
      const resp = await cfg.client.call(req);
      const answer = (resp.message.content as { type: string; text?: string }[])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n');
      return { answer, usage: resp.usage ?? {} };
    },
  );
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造一条业务 Message（user/assistant 等通用） */
function newMessage(
  sessionId: string,
  text: string,
  extra: Partial<MessageInput> = {},
): MessageInput {
  return {
    id: extra.id ?? ulid(),
    sessionId,
    role: extra.role ?? 'user',
    content: extra.content ?? [{ type: 'text', text }],
    ...extra,
  };
}

/**
 * mock LlmClient：call 返回含指定 text 的 assistant message。
 * 用法：const client = mockClient({ callText: '<summary>s</summary>' });
 */
function mockClient(opts: {
  callText: string;
  contextWindow?: number;
}): LlmClient {
  const callFn = vi.fn(async (_req: CanonicalRequest): Promise<CanonicalResponse> => ({
    message: {
      id: 'resp-1',
      role: 'assistant',
      content: [{ type: 'text', text: opts.callText }],
    },
    usage: {},
    stopReason: 'stop',
  }));
  const fake = {
    call: callFn,
    contextWindow: opts.contextWindow ?? 100000,
  };
  return fake as unknown as LlmClient;
}

/**
 * 构造 SessionConfig（绑定 mock client）。
 * v0.0.158：同步登记进 `configBySid` 供 mock sideRunner 按 sessionId 反查
 *   （生产链走 `agentManager.resolveConfigBySid`，UT 用 map 代替）。
 */
function newConfig(sessionId: string, client: LlmClient): SessionConfig {
  const cfg: SessionConfig = {
    sessionId,
    systemPrompt: 'You are a helpful assistant.',
    client,
    modelId: 'mock-compact-model',
    // 生产 compact() 的 config 必带 kind（resolveConfigBySid 注入），assemble 按 session scope 解析
    kind: new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent' }),
  };
  configBySid.set(sessionId, cfg);
  return cfg;
}

// ============================================================
// (a) ingest 仅 append
// ============================================================

describe('ContextEngine.ingest — 仅 append（不走 chain/truncate/offload）', () => {
  it('ingest 后 getMessages 增加 N 条', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const client = mockClient({ callText: '' });
    const config = newConfig(sid, client);

    const before = await store.getMessages(sid);
    expect(before.items).toHaveLength(0);

    await engine.ingest(config, [
      newMessage(sid, 'q1'),
      newMessage(sid, 'a1', { role: 'assistant' }),
    ]);

    const after = await store.getMessages(sid);
    expect(after.items).toHaveLength(2);
    expect(after.items[0]!.content[0]).toMatchObject({ type: 'text', text: 'q1' });
    expect(after.items[1]!.role).toBe('assistant');
  });
});

// ============================================================
// (b) assemble picked 算法
// ============================================================

describe('ContextEngine.assemble — picked 选取', () => {
  it('无 summary → picked = all', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const client = mockClient({ callText: '' });
    const config = newConfig(sid, client);

    // 5 条消息（<=6，无 summary）
    const msgs: MessageInput[] = [];
    for (let i = 0; i < 5; i++) {
      msgs.push(newMessage(sid, `m${i}`));
    }
    await store.appendMessages(sid, msgs);

    const snap = await engine.assemble(config);
    expect(snap.messages).toHaveLength(5);
    expect(snap.summary).toBeNull();
    expect(snap.system.role).toBe('system');
    expect(snap.system.content[0]).toMatchObject({ type: 'text', text: config.systemPrompt });
  });

  it('有 summary 但 messages.length<=6 → picked = all（不插 summary 占位）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.setSummary(sid, { content: '已压缩历史', summaryUpTo: 'old-id' });
    const client = mockClient({ callText: '' });
    const config = newConfig(sid, client);

    // 6 条（不大于 6，仍走全量）
    const msgs: MessageInput[] = [];
    for (let i = 0; i < 6; i++) {
      msgs.push(newMessage(sid, `m${i}`));
    }
    await store.appendMessages(sid, msgs);

    const snap = await engine.assemble(config);
    expect(snap.messages).toHaveLength(6);
    // 不含 summary 占位 system 消息
    expect(snap.messages.find((m) => m.id.startsWith('summary:'))).toBeUndefined();
  });

  it('有 summary 且 messages.length>6 → picked=[head3, summaryMsg, tail3]（7 条）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.setSummary(sid, { content: '已压缩历史', summaryUpTo: 'old-id' });
    const client = mockClient({ callText: '' });
    const config = newConfig(sid, client);

    // 10 条（>6，触发 head3+summary+tail3）
    const ids: string[] = [];
    const msgs: MessageInput[] = [];
    for (let i = 0; i < 10; i++) {
      const id = ulid();
      ids.push(id);
      msgs.push({ id, sessionId: sid, role: 'user', content: [{ type: 'text', text: `m${i}` }] });
    }
    await store.appendMessages(sid, msgs);

    const snap = await engine.assemble(config);
    // head3 + summaryMsg + tail3 = 7
    expect(snap.messages).toHaveLength(7);
    // head3 = ids[0..2]
    expect(snap.messages[0]!.id).toBe(ids[0]);
    expect(snap.messages[2]!.id).toBe(ids[2]);
    // summary 占位在 index 3
    const summaryMsg = snap.messages[3]!;
    expect(summaryMsg.id.startsWith('summary:')).toBe(true);
    // [v0.0.81.compaction_bug] summary role 改 user（不是 system）
    expect(summaryMsg.role).toBe('user');
    expect(summaryMsg.content[0]).toMatchObject({ type: 'text', text: '已压缩历史' });
    // tail3 = ids[7..9]
    expect(snap.messages[4]!.id).toBe(ids[7]);
    expect(snap.messages[6]!.id).toBe(ids[9]);
    // summary 字段回填
    expect(snap.summary?.content).toBe('已压缩历史');
  });

  it('contextWindowUsage 7 字段（char × ratio 估算；冷启动 ratio=1.0；v0.0.16）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const client = mockClient({ callText: '', contextWindow: 5000 });
    const config = newConfig(sid, client);

    await store.appendMessages(sid, [
      newMessage(sid, 'hello'), // 5 char
    ]);

    const snap = await engine.assemble(config);
    // 冷启动 ratio=1.0（无 sample）：system/message/tool char × 1.0
    const sysChars = config.systemPrompt.length;
    const msgChars = 5;
    const toolChars = 0; // config.tools 未传
    const totalChars = sysChars + msgChars + toolChars;
    expect(snap.inputCharCount).toBe(totalChars);
    expect(snap.contextWindowUsage.systemTokens).toBe(sysChars);
    expect(snap.contextWindowUsage.messageTokens).toBe(msgChars);
    expect(snap.contextWindowUsage.toolTokens).toBe(toolChars);
    expect(snap.contextWindowUsage.totalTokens).toBe(totalChars);
    expect(snap.contextWindowUsage.maxOutputTokens).toBe(20000);
    expect(snap.contextWindowUsage.tokenLimit).toBe(5000);
    expect(snap.contextWindowUsage.remainingTokens).toBe(5000 - totalChars - 20000);
  });

  // v0.0.10 回归：assemble 必须把 contextWindowUsage 持久化到 session
  //（spec assemble §3 / context_usage_detail §2 / context_snapshot_interface §4 要求
  //  产出 snapshot 后内部调 store.updateContextWindowUsage；旧实现漏调，session.contextWindowUsage 永远是旧值）。
  it('assemble 持久化 contextWindowUsage 到 session.contextWindowUsage', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const client = mockClient({ callText: '', contextWindow: 5000 });
    const config = newConfig(sid, client);

    await store.appendMessages(sid, [newMessage(sid, 'hello')]);

    // assemble 前 session 无 contextWindowUsage
    const before = await store.getSession(sid);
    expect(before?.contextWindowUsage).toBeUndefined();

    await engine.assemble(config);

    // assemble 后 session.contextWindowUsage 被写入（7 字段）
    const after = await store.getSession(sid);
    expect(after?.contextWindowUsage).toBeDefined();
    const cw = after!.contextWindowUsage!;
    expect(cw.systemTokens).toBe(config.systemPrompt.length);
    expect(cw.messageTokens).toBe(5);
    expect(cw.toolTokens).toBe(0);
    expect(cw.totalTokens).toBe(config.systemPrompt.length + 5);
    expect(cw.maxOutputTokens).toBe(20000);
    expect(cw.tokenLimit).toBe(5000);
    expect(cw.remainingTokens).toBe(5000 - (config.systemPrompt.length + 5) - 20000);
  });

  // v0.0.10 回归：每次 assemble 都刷新（不是只第一次写）
  it('assemble 多次调用每次都刷新 session.contextWindowUsage（totalTokens 增大）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const client = mockClient({ callText: '', contextWindow: 5000 });
    const config = newConfig(sid, client);

    await store.appendMessages(sid, [newMessage(sid, 'a')]); // 1 char
    await engine.assemble(config);
    const after1 = await store.getSession(sid);
    const used1 = after1!.contextWindowUsage!.totalTokens;

    // 再加消息 → totalTokens 应增大（messageTokens 增 2）
    await store.appendMessages(sid, [newMessage(sid, 'bb')]); // 2 char
    await engine.assemble(config);
    const after2 = await store.getSession(sid);
    expect(after2!.contextWindowUsage!.totalTokens).toBe(used1 + 2);
  });

  // [v0.0.16] assemble 读 store.getRatio 真值（不再硬编码 1.0）
  // spec context_usage_detail.md §3/§4：ratio 从 session.getRatio(sessionId) 读，窗口满 3 取中位数
  it('assemble 读 store.getRatio 真值（非 1.0，mock ratio=0.5）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const client = mockClient({ callText: '', contextWindow: 10000 });
    const config = newConfig(sid, client);

    await store.appendMessages(sid, [newMessage(sid, 'hello')]); // 5 char

    // mock store.getRatio 返 0.5（模拟 v0.0.14 三轮收敛后的 ratio）
    vi.spyOn(store, 'getRatio').mockResolvedValue(0.5);

    const snap = await engine.assemble(config);
    const sysChars = config.systemPrompt.length;
    const msgChars = 5;
    // system/message char × 0.5（round）
    expect(snap.contextWindowUsage.systemTokens).toBe(Math.round(sysChars * 0.5));
    expect(snap.contextWindowUsage.messageTokens).toBe(Math.round(msgChars * 0.5));
    expect(snap.contextWindowUsage.totalTokens).toBe(
      Math.round(sysChars * 0.5) + Math.round(msgChars * 0.5),
    );
    // remainingTokens 用 ratio=0.5 后的 token 算
    const total = snap.contextWindowUsage.totalTokens;
    expect(snap.contextWindowUsage.remainingTokens).toBe(10000 - total - 20000);

    vi.restoreAllMocks();
  });

  // [v0.0.16] remainingTokens 公式必须含 maxOutputTokens 减项
  // spec context_compact_detail.md §1：remainingTokens = tokenLimit − totalTokens − maxOutputTokens
  // compact 触发条件 remainingTokens < 0；补 maxOutput 后会比旧实现（漏减）更早触发 compact
  it('remainingTokens 算式含 maxOutputTokens 减项（v0.0.16 修复）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    // 故意小 contextWindow（500）+ 大 maxOutputTokens 默认 20000 → remaining 必 < 0
    const client = mockClient({ callText: '', contextWindow: 500 });
    const config = newConfig(sid, client);

    await store.appendMessages(sid, [newMessage(sid, 'hello')]); // 5 char

    const snap = await engine.assemble(config);
    const total = snap.contextWindowUsage.totalTokens;
    // 验证公式：remaining = tokenLimit - total - maxOutput（含减项）
    expect(snap.contextWindowUsage.remainingTokens).toBe(
      500 - total - 20000,
    );
    // 因 maxOutputTokens=20000 >> tokenLimit=500，remainingTokens 必为负
    expect(snap.contextWindowUsage.remainingTokens).toBeLessThan(0);
    // remainingTokens<0 是 compact 触发信号（should_compact EP 判定 → contextEngine.compact）
  });

  // [v0.0.16] assemble 用 AppConfig.context.maxOutputTokens（注入 appConfig mock）
  // [v0.0.89] 自 DevConfig 改名（dev_config.context → app_config.context，group/key 名零变更）
  it('assemble 读 appConfig.context.maxOutputTokens（注入 mock appConfig）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const client = mockClient({ callText: '', contextWindow: 100000 });
    const config = newConfig(sid, client);
    await store.appendMessages(sid, [newMessage(sid, 'hi')]);

    // 用独立 engine + mock appConfig（maxOutputTokens=8000）
    const appConfig = { get: vi.fn((g: string, k: string) =>
      g === 'context' && k === 'maxOutputTokens' ? 8000 : undefined) };
    const engine2 = new ContextEngine({ store, appConfig });

    const snap = await engine2.assemble(config);
    expect(snap.contextWindowUsage.maxOutputTokens).toBe(8000);
    expect(appConfig.get).toHaveBeenCalledWith('context', 'maxOutputTokens');
    // remainingTokens 用注入的 8000
    const total = snap.contextWindowUsage.totalTokens;
    expect(snap.contextWindowUsage.remainingTokens).toBe(100000 - total - 8000);
  });
});

// ============================================================
// (c) compact
// ============================================================

describe('ContextEngine.compact — ForkedAgent + summaryTask CAS（v0.0.13 重写）', () => {
  it('compact → CAS running → forked agent(NO_TOOLS+system 注入) → setSummary → markDone', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const client = mockClient({ callText: '<summary>这是压缩后的总结</summary>' });
    const config = newConfig(sid, client);

    // 预置 3 条消息
    const ids: string[] = [];
    const msgs: MessageInput[] = [];
    for (let i = 0; i < 3; i++) {
      const id = ulid();
      ids.push(id);
      msgs.push({ id, sessionId: sid, role: 'user', content: [{ type: 'text', text: `m${i}` }] });
    }
    await store.appendMessages(sid, msgs);

    const result = await engine.compact(config);
    expect(result).toBe(true);

    // client.call 被调用一次（经 ForkedAgent.run）
    expect(client.call).toHaveBeenCalledTimes(1);
    const calls = (client.call as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const callArg = calls[0]![0] as CanonicalRequest;
    expect(callArg.modelId).toBe('mock-compact-model');
    // messages = [system(D2.2 注入), ...snap.messages(3), compactUserMsg(1)] = 5
    expect(callArg.messages).toHaveLength(5);
    // 首条是 system message（forked agent D2.2 注入 snapshot.system）
    expect(callArg.messages[0]!.role).toBe('system');
    // 末条是 compact user message，含 NO_TOOLS preamble（TEXT ONLY）+ <summary> 要求
    // v0.0.22: prompt 改为 CC 口径（委托 CompactHandler 读 compact.md），不再含中文极简指令
    const lastMsg = callArg.messages[4]!;
    expect(lastMsg.role).toBe('user');
    expect((lastMsg.content[0] as { text: string }).text).toContain('TEXT ONLY');
    expect((lastMsg.content[0] as { text: string }).text).toContain('Do NOT call any tools');
    expect((lastMsg.content[0] as { text: string }).text).toContain('<summary>');

    // [v0.0.54] forked 不变量防回归：compact task message 是**纯 directive**，
    // 不复述 serialized_transcript（对话历史已在 buffer 中——messages[1..3] 是 snap.messages 原文）。
    // 旧实现会把 serializeMessages(snap.messages) 塞进 prompt → 对话历史发两遍。
    // 这里 negative 断言：directive 文本不含 snap.messages 的文本（m0/m1/m2）也不含 [user]/[assistant] 序列化标记。
    const directiveText = (lastMsg.content[0] as { text: string }).text;
    expect(directiveText).not.toContain('m0');
    expect(directiveText).not.toContain('m1');
    expect(directiveText).not.toContain('m2');
    expect(directiveText).not.toContain('[user]');
    expect(directiveText).not.toContain('[assistant]');
    expect(directiveText).not.toMatch(/Conversation to summarize:/);

    // setSummary：content=解析出的 summary、summaryUpTo=末尾 messageId、version=1
    const summary = await store.getSummary(sid);
    expect(summary).not.toBeNull();
    expect(summary!.content).toBe('这是压缩后的总结');
    expect(summary!.summaryUpTo).toBe(ids[2]);
    expect(summary!.version).toBe(1);

    // summaryTask 终态 = done（v0.0.55 起 taskLock 内 done）
    expect(engine.getTaskLock()?.getState(sid, 'compact').status).toBe('done');
  });

  it('CAS 失败（lock=running）→ 跳过 compact、client 不被调', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const client = mockClient({ callText: '<summary>s</summary>' });
    const config = newConfig(sid, client);
    await store.appendMessages(sid, [newMessage(sid, 'q1')]);

    // v0.0.55：预置 lock=running（模拟已有 compact 在跑，subsumes 旧 markSummaryRunning）
    engine.getTaskLock()?.acquire(sid, 'compact', 'compact:other-run');

    const result = await engine.compact(config);
    expect(result).toBe(false); // CAS 失败 → 跳过
    expect(client.call).not.toHaveBeenCalled();

    // summary 不应被改
    const summary = await store.getSummary(sid);
    expect(summary).toBeNull();
  });

  it('LLM 异常 → markSummaryFailed + setSummary 不被调 + rethrow', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    // mock client 抛错
    const callFn = vi.fn(async (): Promise<CanonicalResponse> => {
      throw new Error('LLM boom');
    });
    const client = { call: callFn, contextWindow: 100000 } as unknown as LlmClient;
    const config = newConfig(sid, client);
    await store.appendMessages(sid, [newMessage(sid, 'q1')]);

    await expect(engine.compact(config)).rejects.toThrow('LLM boom');

    // summary 不应被写入
    const summary = await store.getSummary(sid);
    expect(summary).toBeNull();
    // v0.0.55：lock 终态 = failed（含 error message）
    expect(engine.getTaskLock()?.getState(sid, 'compact').status).toBe('failed');
    expect(engine.getTaskLock()?.getState(sid, 'compact').error).toContain('LLM boom');
  });

  it('extractTag 容错：无 <summary> 标签时取全文', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const client = mockClient({ callText: '没有标签的纯文本 summary' });
    const config = newConfig(sid, client);

    await store.appendMessages(sid, [newMessage(sid, 'q1')]);

    await engine.compact(config);

    const summary = await store.getSummary(sid);
    expect(summary!.content).toBe('没有标签的纯文本 summary');
  });

  it('compact 后再次 compact → version 递增、summaryUpTo 更新', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const client = mockClient({ callText: '<summary>v2 summary</summary>' });
    const config = newConfig(sid, client);

    // 先手动写一个 v1 summary（summaryTask 默认 idle，二次 compact CAS 仍可成功）
    await store.setSummary(sid, { content: 'v1', summaryUpTo: 'old' });
    const id2 = ulid();
    await store.appendMessages(sid, [{ id: id2, sessionId: sid, role: 'user', content: [{ type: 'text', text: 'new' }] }]);

    await engine.compact(config);

    const summary = await store.getSummary(sid);
    expect(summary!.content).toBe('v2 summary');
    expect(summary!.summaryUpTo).toBe(id2);
    expect(summary!.version).toBe(2); // 由 store 自增
  });
});

// ============================================================
// helpers 单测（extractTag）—— [v0.0.54] serializeMessages 已删
// ============================================================

describe('helpers', () => {
  it('extractTag：有标签取内文（trim）', () => {
    expect(extractTag('foo <summary>bar</summary> baz', 'summary')).toBe('bar');
    expect(extractTag('<summary>  spaced  </summary>', 'summary')).toBe('spaced');
  });

  it('extractTag：无标签取全文（trim）', () => {
    expect(extractTag('plain text', 'summary')).toBe('plain text');
    expect(extractTag('', 'summary')).toBe('');
  });
});
