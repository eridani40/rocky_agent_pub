/**
 * compact runner 委托 CompactHandler 单测（v0.0.22；[v0.0.54] 改纯 directive；
 * [v0.0.80.t1 task-1/3] 加纯生产者 + trigger meta 透传验证）
 * 参考: specs/tech/version_logs/v0.0.22/change_log.md §3.3 §8.1
 *       specs/tech/agent/context/[P0]context_compact_detail.md §3.0
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_forked.md §1（forked 不变量）
 *       specs/tech/version_logs/v0.0.80.t1/change_plan.md §1.0/§2.6/§2.7
 *
 * 验证：taskMessage.text 来自 CompactHandler（纯 directive：含 NO_TOOLS preamble +
 * trailer 双保险 + 9 板块，**不含** serialized_transcript / old_summary 占位符渲染）；
 * 其余流程不回归。
 *
 * [v0.0.54] 回归 forked 不变量：snapshot 是唯一信息源，task message 是纯 directive，
 * 对话历史已在 forked buffer 中（snap.messages 由 sideRunner 注入 CanonicalRequest.messages），
 * prompt 不复述、不注入。Negative 断言防回归（旧实现曾把 serializeMessages(snap.messages)
 * 塞 prompt → 对话历史发两遍）。
 *
 * [v0.0.235] forked usage 推送修复：runCompact 在 accumulateUsage write 完成后，对返回的
 *   sid 链逐个调 store.notifyUsageChanged（让 forked 分区增量即时可见，不依赖下一轮 main
 *   assemble；spec session_usage §6.1 修正口径）。accumulateUsage / onUsage 仍防双计。
 * [v0.0.80.t1 task-3] trigger meta 透传：runCompact 第 8/9 参数 triggerMessageId/triggerUsage
 *   透传到 sideRunner input（→ forked trace metadata；change_plan §2.6 改进#1）。
 *
 * 走真实 SessionStore + ContextEngine.assemble（构造真实 snapshot.messages）+
 * mock sideRunner 捕获 userMessage（绕开 manager 装配）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { SessionStore } from '../session-store';
import { ContextEngine } from '../context-engine';
import { runCompact } from '../context-compact-runner';
import type { SessionConfig } from '../context-types';
import type { LlmClient } from '../../llm/client';
import type { CanonicalRequest, CanonicalResponse } from '../../llm/protocol';

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-compact-delegate-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** mock LlmClient：call 返回含指定 text 的 assistant message */
function mockClient(text: string): LlmClient {
  const callFn = vi.fn(async (_req: CanonicalRequest): Promise<CanonicalResponse> => {
    return {
      message: { id: 'resp-1', role: 'assistant', content: [{ type: 'text', text }] },
      usage: {},
      stopReason: 'stop',
    };
  });
  return { call: callFn, contextWindow: 100000 } as unknown as LlmClient;
}

/**
 * 捕获 sideRunner 收到的 userMessage，返 fixed answer。
 *
 * v0.0.158：CompactSideRunner input 删 config 字段（bootstrap 闭包内部自 resolve）。
 *   本 mock 从闭包直接取 client + 用固定 modelId 'test-model'（原来从 input.config.client/modelId 取）。
 */
function captureSideRunner(client: LlmClient, answer: string, captured: { msg?: unknown }) {
  return async (input: {
    snapshot: { system: unknown; messages: unknown[] };
    userMessage: unknown;
    triggerMessageId?: string;
    triggerUsage?: unknown;
  }) => {
    captured.msg = input.userMessage;
    const protocolMessages = [
      input.snapshot.system as never,
      ...input.snapshot.messages as never[],
      input.userMessage as never,
    ];
    const req: CanonicalRequest = {
      modelId: 'test-model',
      messages: protocolMessages as unknown as CanonicalRequest['messages'],
      params: {},
    };
    const resp = await client.call(req);
    return { answer, usage: resp.usage ?? {} };
  };
}

function newConfig(sessionId: string, client: LlmClient): SessionConfig {
  return {
    sessionId,
    systemPrompt: 'You are a helpful assistant.',
    client,
    modelId: 'test-model',
  } as unknown as SessionConfig;
}

describe('runCompact — 委托 CompactHandler（v0.0.22; v0.0.54 改纯 directive）', () => {
  it('taskMessage.text 来自 CompactHandler：纯 directive 含 NO_TOOLS preamble + trailer + 9 板块，不复述 snapshot', async () => {
    const sid = ulid();
    const client = mockClient('<summary>x</summary>');
    const config = newConfig(sid, client);
    await store.createSession({ id: sid });
    await store.appendMessages(sid, [
      { id: ulid(), sessionId: sid, role: 'user', content: [{ type: 'text', text: 'hello world' }] },
    ]);

    const captured: { msg?: unknown } = {};
    const snapshot = await new ContextEngine({ store }).assemble(config);
    await runCompact(
      store,
      undefined,
      config,
      snapshot,
      captureSideRunner(client, '<summary>x</summary>', captured),
    );

    expect(captured.msg).toBeDefined();
    const msg = captured.msg as { content: { type: string; text: string }[] };
    const text = msg.content.find((b) => b.type === 'text')?.text ?? '';
    // NO_TOOLS preamble（CRITICAL TEXT ONLY）
    expect(text).toContain('CRITICAL');
    expect(text).toContain('TEXT ONLY');
    // NO_TOOLS trailer（REMINDER 双保险）
    expect(text).toContain('REMINDER');
    // 9 板块（directive 自身的格式约束，仍保留）
    expect(text).toContain('Primary Request and Intent');
    expect(text).toContain('Optional Next Step');

    // [v0.0.54] forked 不变量防回归：prompt 是纯 directive
    // 不复述 snapshot.messages（旧实现会塞 serializeMessages → 含 [user] + 原消息文本）
    expect(text).not.toContain('[user]');
    expect(text).not.toContain('[assistant]');
    expect(text).not.toContain('hello world'); // snapshot.messages 原文不应在 prompt 里
    // 占位符已删（CompactHandler 不再渲染任何 vars）
    expect(text).not.toContain('{{serialized_transcript}}');
    expect(text).not.toContain('{{old_summary}}');
    expect(text).not.toContain('Conversation to summarize:');
    // 旧 prompt 常量已删除（不应再含中文极简指令）
    expect(text).not.toContain('请把以下对话压缩为 summary');
  });

  it('[v0.0.54] store 有老 summary → taskMessage 仍是纯 directive，不注入 old_summary merge 提示块', async () => {
    const sid = ulid();
    const client = mockClient('<summary>x</summary>');
    const config = newConfig(sid, client);
    await store.createSession({ id: sid });
    await store.appendMessages(sid, [
      { id: ulid(), sessionId: sid, role: 'user', content: [{ type: 'text', text: 'q1' }] },
    ]);
    await store.setSummary(sid, { content: 'OLD_SUMMARY_BODY', summaryUpTo: 'old' });

    const captured: { msg?: unknown } = {};
    const snapshot = await new ContextEngine({ store }).assemble(config);
    await runCompact(
      store,
      undefined,
      config,
      snapshot,
      captureSideRunner(client, '<summary>x</summary>', captured),
    );

    const text = (captured.msg as { content: { type: string; text: string }[] })
      .content.find((b) => b.type === 'text')?.text ?? '';
    // [v0.0.54] old_summary 不再注入 prompt（forked 不变量：task message 是纯 directive）
    expect(text).not.toContain('Earlier retained context');
    expect(text).not.toContain('OLD_SUMMARY_BODY');
    expect(text).not.toContain('Merge with the new portion');
  });

  it('其余流程不回归：sideRunner answer 提取 <summary> → setSummary 落库；[v0.0.81.compaction_bug] compact_notice 留痕已删（不再 append）', async () => {
    const sid = ulid();
    const client = mockClient('<summary>FINAL_SUMMARY</summary>');
    const config = newConfig(sid, client);
    await store.createSession({ id: sid });
    await store.appendMessages(sid, [
      { id: ulid(), sessionId: sid, role: 'user', content: [{ type: 'text', text: 'msg' }] },
    ]);

    const snapshot = await new ContextEngine({ store }).assemble(config);
    const ok = await runCompact(
      store,
      undefined,
      config,
      snapshot,
      captureSideRunner(client, '<summary>FINAL_SUMMARY</summary>', {}),
    );
    expect(ok).toBe(true);

    // setSummary 落库（extractTag 提取 <summary>）
    const written = await store.getSummary(sid);
    expect(written).not.toBeNull();
    expect(written!.content).toBe('FINAL_SUMMARY');

    // [v0.0.81.compaction_bug] compact_notice 留痕已删：transcript 不应有 compact_notice system msg
    const page = await store.getMessages(sid);
    const notice = page.items.find(
      (m) => m.role === 'system' && m.metadata?.kind === 'compact_notice',
    );
    expect(notice).toBeUndefined();
    // 原始 1 条 user message 不变（compact 不再 appendMessages）
    expect(page.items.length).toBe(1);
  });
});

// ============================================================
// [v0.0.235] forked usage 推送：runCompact accumulateUsage 后对 sid 链补 notifyUsageChanged
// ============================================================

describe('[v0.0.235] runCompact caller 补 notify（accumulateUsage write 后逐 sid 推送）', () => {
  it('accumulateUsage 后对返回 sid 链每个 sid 调一次 notifyUsageChanged（write 先于 notify）', async () => {
    const sid = ulid();
    const client = mockClient('<summary>x</summary>');
    const config = newConfig(sid, client);
    await store.createSession({ id: sid });
    await store.appendMessages(sid, [
      { id: ulid(), sessionId: sid, role: 'user', content: [{ type: 'text', text: 'q' }] },
    ]);
    // accumulateUsage mock 返 sid 链 [sid, parent]（模拟递归 sub 上报两条）
    const chain = [sid, 'parent-sid'];
    const accumulateSpy = vi.spyOn(store, 'accumulateUsage').mockResolvedValue(chain);
    const notifySpy = vi.spyOn(store, 'notifyUsageChanged').mockResolvedValue(undefined);
    const callOrder: string[] = [];
    accumulateSpy.mockImplementation(async () => {
      callOrder.push('accumulateUsage');
      return chain;
    });
    notifySpy.mockImplementation(async (s: string) => {
      callOrder.push(`notify:${s}`);
    });

    const snapshot = await new ContextEngine({ store }).assemble(config);
    await runCompact(
      store,
      undefined,
      config,
      snapshot,
      captureSideRunner(client, '<summary>x</summary>', {}),
    );

    // accumulateUsage 先 write，再对链上每个 sid 各 notify 一次
    expect(accumulateSpy).toHaveBeenCalledOnce();
    expect(notifySpy).toHaveBeenCalledTimes(chain.length);
    expect(notifySpy.mock.calls[0]![0]).toBe(sid);
    expect(notifySpy.mock.calls[1]![0]).toBe('parent-sid');
    // 顺序契约：write 完 → 逐 sid notify（spec §3）
    expect(callOrder[0]).toBe('accumulateUsage');
    expect(callOrder[1]).toBe(`notify:${sid}`);
    expect(callOrder[2]).toBe('notify:parent-sid');
    accumulateSpy.mockRestore();
    notifySpy.mockRestore();
  });

  it('accumulateUsage write 保留（forked cost 必须落盘）', async () => {
    const sid = ulid();
    const usage = { input_tokens: 100, output_tokens: 50, total_tokens: 150 };
    const client = {
      call: vi.fn(async (): Promise<CanonicalResponse> => ({
        message: { id: 'r', role: 'assistant', content: [{ type: 'text', text: '<summary>x</summary>' }] },
        usage,
        stopReason: 'stop',
      })),
      contextWindow: 100000,
    } as unknown as LlmClient;
    const config = newConfig(sid, client);
    await store.createSession({ id: sid });
    await store.appendMessages(sid, [
      { id: ulid(), sessionId: sid, role: 'user', content: [{ type: 'text', text: 'q' }] },
    ]);
    // spy accumulateUsage
    const accumulateSpy = vi.spyOn(store, 'accumulateUsage').mockResolvedValue([sid]);

    const snapshot = await new ContextEngine({ store }).assemble(config);
    await runCompact(
      store,
      undefined,
      config,
      snapshot,
      captureSideRunner(client, '<summary>x</summary>', {}),
    );

    // accumulateUsage 被调一次，'forked' 分区，usage 透传
    expect(accumulateSpy).toHaveBeenCalledOnce();
    const args = accumulateSpy.mock.calls[0]!;
    expect(args[0]).toBe(sid);
    expect(args[1]).toBe('forked');
    expect(args[2]).toBe(usage);
    accumulateSpy.mockRestore();
  });
});

// ============================================================
// [v0.0.80.t1 task-3] trigger meta 透传：triggerMessageId/triggerUsage 透传到 sideRunner input
// ============================================================

describe('[v0.0.80.t1 task-3] runCompact trigger meta 透传（change_plan §2.6 改进#1）', () => {
  it('triggerMessageId/triggerUsage 透传到 sideRunner input（→ forked trace meta）', async () => {
    const sid = ulid();
    const client = mockClient('<summary>x</summary>');
    const config = newConfig(sid, client);
    await store.createSession({ id: sid });
    await store.appendMessages(sid, [
      { id: ulid(), sessionId: sid, role: 'user', content: [{ type: 'text', text: 'q' }] },
    ]);
    const captured: { input?: { triggerMessageId?: string; triggerUsage?: unknown } } = {};
    // v0.0.158：CompactSideRunner input 删 config 字段（bootstrap 闭包内部自 resolve）；
    //   client + modelId 从闭包直接取（原 input.config.client / input.config.modelId）。
    const sideRunner = async (input: {
      snapshot: { system: unknown; messages: unknown[] };
      userMessage: unknown;
      triggerMessageId?: string;
      triggerUsage?: unknown;
    }) => {
      captured.input = input;
      const protocolMessages = [
        input.snapshot.system as never,
        ...input.snapshot.messages as never[],
        input.userMessage as never,
      ];
      const req: CanonicalRequest = {
        modelId: 'test-model',
        messages: protocolMessages as unknown as CanonicalRequest['messages'],
        params: {},
      };
      const resp = await client.call(req);
      return { answer: '<summary>x</summary>', usage: resp.usage ?? {} };
    };

    const triggerUsage = {
      systemTokens: 1, messageTokens: 2, toolTokens: 0,
      totalTokens: 3, maxOutputTokens: 20000, tokenLimit: 100000, remainingTokens: 79997,
    };
    const snapshot = await new ContextEngine({ store }).assemble(config);
    await runCompact(
      store,
      undefined,
      config,
      snapshot,
      sideRunner,
      'msg-trigger-1',
      triggerUsage,
    );

    expect(captured.input).toBeDefined();
    expect(captured.input!.triggerMessageId).toBe('msg-trigger-1');
    expect(captured.input!.triggerUsage).toBe(triggerUsage);
  });

  it('旧调用点不传 triggerMessageId/triggerUsage → sideRunner input 字段 undefined（向后兼容）', async () => {
    const sid = ulid();
    const client = mockClient('<summary>x</summary>');
    const config = newConfig(sid, client);
    await store.createSession({ id: sid });
    await store.appendMessages(sid, [
      { id: ulid(), sessionId: sid, role: 'user', content: [{ type: 'text', text: 'q' }] },
    ]);
    const captured: { input?: { triggerMessageId?: string; triggerUsage?: unknown } } = {};
    // v0.0.158：CompactSideRunner input 删 config 字段（bootstrap 闭包内部自 resolve）；
    //   client + modelId 从闭包直接取（原 input.config.client / input.config.modelId）。
    const sideRunner = async (input: {
      snapshot: { system: unknown; messages: unknown[] };
      userMessage: unknown;
      triggerMessageId?: string;
      triggerUsage?: unknown;
    }) => {
      captured.input = input;
      const protocolMessages = [
        input.snapshot.system as never,
        ...input.snapshot.messages as never[],
        input.userMessage as never,
      ];
      const req: CanonicalRequest = {
        modelId: 'test-model',
        messages: protocolMessages as unknown as CanonicalRequest['messages'],
        params: {},
      };
      const resp = await client.call(req);
      return { answer: '<summary>x</summary>', usage: resp.usage ?? {} };
    };

    // 旧调用：只传 6 个必填参，不传第 8/9 trigger 参
    const snapshot = await new ContextEngine({ store }).assemble(config);
    await runCompact(
      store,
      undefined,
      config,
      snapshot,
      sideRunner,
    );

    expect(captured.input).toBeDefined();
    expect(captured.input!.triggerMessageId).toBeUndefined();
    expect(captured.input!.triggerUsage).toBeUndefined();
  });
});
