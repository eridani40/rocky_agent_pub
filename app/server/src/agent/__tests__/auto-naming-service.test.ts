/**
 * AutoNamingService UT
 * 参考: specs/tech/agent/auto_naming/index.md（7 核心原则）
 *       specs/tech/agent/auto_naming/[P0]auto_naming_service.md（触发 hook + CAS + NAMING_PROMPT）
 *       specs/tech/version_logs/v0.0.84.auto_naming_fix/change_plan.md（v0.0.84 起名改走 invoke）
 *
 * 覆盖：
 *   - triggerIfFirstQuery gate：首 query / 非首 / bizType=studio / type=subagent / titled 已 true
 *   - CAS：titled false + aiName 非空 → updateSession({title, titled:true}) + broadcast
 *           titled true（re-read 后）→ 不调 updateSession 不 broadcast（AI 名丢弃）
 *   - silent-fail：注入 throw 的 invoke → applyAiName 不抛 + 不 updateSession + 不 broadcast
 *   - extractPlainName：去引号 / 标点 / 首行 / trim / 空→null
 *   - PUT 3 call site（session.ts + session-update.ts 两分支）：body.title 时 updateSession
 *     收到 titled:true + broadcast 被调
 *   - [v0.0.84] invoke 路径：backgroundPath=true / baseReq 不含 params / 观测闭环
 *
 * 测试策略：mock store/agentManager/broadcaster/llmCaller/observability（不真调 LLM、不真写 fs）。
 * 文件系统隔离：本测试纯 mock，无 tmpdir 占用（除 PUT workspace 路径用 tmpdir）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AutoNamingService,
  extractPlainName,
} from '../auto-naming-service';
import type { SessionMetaBroadcaster } from '../session-meta-broadcaster';
import type { AgentManagerImpl } from '../agent-manager';
import type { SessionStore } from '../session-store';
import type { Session, MessagePage } from '../session-store-types';
import type { CanonicalRequest } from '../../llm/protocol';
import type { InvokeContext, InvokeResponse } from '../../llm/caller/llm_caller';
import type { Message as ProtocolMessage } from '../../llm/protocol-types';
import type { Message as BizMessage } from '../../message/types';
import type { ObservabilityAdapter } from '../../observability/adapter';

// ============================================================
// Mock 构造 helpers
// ============================================================

/** 构造最小 Session literal（默认 playground + 无 type + titled false） */
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sid-1',
    title: '新会话',
    status: 'active',
    state: 'idle',
    running: false,
    currentRunId: null,
    unread: false,
    titled: false,
    workspaceDir: '/tmp/ws',
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

/** 构造 mock store（spec testid 不依赖 fs） */
function makeMockStore(opts: {
  session?: Session | null;
  messages?: BizMessage[];
  reReadSession?: Session | null;
  updates?: { sid: string; patch: Record<string, unknown> }[];
}) {
  let sessionCallIdx = 0;
  const firstSession = opts.session === undefined ? makeSession() : opts.session;
  const reReadSessionRaw =
    opts.reReadSession === undefined ? opts.session : opts.reReadSession;
  const reReadSession = reReadSessionRaw === undefined ? makeSession() : reReadSessionRaw;
  return {
    getSession: vi.fn(async () => {
      const cur = sessionCallIdx === 0 ? firstSession : reReadSession;
      sessionCallIdx++;
      return cur;
    }),
    getMessages: vi.fn(async (): Promise<MessagePage> => ({
      items: opts.messages ?? [],
      hasMore: false,
    })),
    updateSession: vi.fn(async (sid: string, patch: Record<string, unknown>) => {
      opts.updates?.push({ sid, patch });
    }),
  } as unknown as SessionStore & {
    getSession: ReturnType<typeof vi.fn>;
    getMessages: ReturnType<typeof vi.fn>;
    updateSession: ReturnType<typeof vi.fn>;
  };
}

/**
 * 构造 mock agentManager（resolveConfigBySid 返 SessionConfig-like）。
 * [v0.0.84] 不再塞 observability 进 config —— observability 真源是 deps 注入
 *   （resolveConfigBySid 返的 SessionConfig 本就无 observability 字段；旧实现误用导致 trace 恒落 noop）。
 */
function makeMockAgentManager(opts: {
  throwOnResolve?: Error;
} = {}) {
  return {
    resolveConfigBySid: vi.fn(async () => {
      if (opts.throwOnResolve) throw opts.throwOnResolve;
      return {
        sessionId: 'sid-1',
        systemPrompt: '',
        modelId: 'mock-model',
        client: {},
      } as never;
    }),
  } as unknown as AgentManagerImpl;
}

/**
 * [v0.0.84] 构造 mock LlmCaller.invoke。
 * 默认返 happy-path InvokeResponse（content=[text:'关于天气的查询']）。
 * invokeImpl/throwOnInvoke 二选一控制行为；captureReq/captureCtx 收集调用入参供断言。
 */
function makeMockLlmCaller(opts: {
  invokeImpl?: (req: CanonicalRequest, ctx: InvokeContext) => Promise<InvokeResponse>;
  throwOnInvoke?: Error;
} = {}) {
  const captureReq: CanonicalRequest[] = [];
  const captureCtx: InvokeContext[] = [];
  const defaultInvokeImpl = async (): Promise<InvokeResponse> => ({
    message: {
      id: 'resp-1',
      role: 'assistant',
      content: [{ type: 'text', text: '关于天气的查询' }],
    },
    usage: null,
    stopReason: 'stop',
  });
  const invoke = vi.fn(async (req: CanonicalRequest, ctx: InvokeContext): Promise<InvokeResponse> => {
    captureReq.push(req);
    captureCtx.push(ctx);
    if (opts.throwOnInvoke) throw opts.throwOnInvoke;
    if (opts.invokeImpl) return opts.invokeImpl(req, ctx);
    return defaultInvokeImpl();
  });
  return {
    invoke,
    captureReq,
    captureCtx,
  } as unknown as { invoke: typeof invoke; captureReq: CanonicalRequest[]; captureCtx: InvokeContext[] };
}

/** 构造 mock SessionMetaBroadcaster */
function makeMockBroadcaster() {
  return {
    broadcast: vi.fn((_sid: string) => {
      /* 同步 void，模拟真实 SessionMetaBroadcaster.broadcast */
    }),
  } as unknown as SessionMetaBroadcaster & { broadcast: ReturnType<typeof vi.fn> };
}

/** [v0.0.84] 构造 mock ObservabilityAdapter（spy startTrace/startGeneration/endGeneration/endTrace） */
function makeMockObservabilityAdapter() {
  const calls: { method: string; args: unknown[] }[] = [];
  const trace = { kind: 'trace' as const, id: 'mock-trace' };
  const gen = { kind: 'gen' as const, id: 'mock-gen', parent: trace };
  const adapter = {
    startTrace: vi.fn((p: unknown) => { calls.push({ method: 'startTrace', args: [p] }); return trace; }),
    endTrace: vi.fn((h: unknown, p?: unknown) => { calls.push({ method: 'endTrace', args: [h, p] }); }),
    startGeneration: vi.fn((p: unknown) => { calls.push({ method: 'startGeneration', args: [p] }); return gen; }),
    endGeneration: vi.fn((p: unknown) => { calls.push({ method: 'endGeneration', args: [p] }); }),
    startSpan: vi.fn(() => ({ kind: 'span' as const, id: 'mock-span', parent: trace })),
    endSpan: vi.fn(() => {}),
    shutdown: vi.fn(async () => {}),
  } as unknown as ObservabilityAdapter & { endGeneration: ReturnType<typeof vi.fn> };
  return { adapter, calls };
}

// ============================================================
// triggerIfFirstQuery gate 测试
// ============================================================

describe('AutoNamingService.triggerIfFirstQuery gate', () => {
  it('首 query（无 prior user 消息 + playground + titled false）→ 触发 applyAiName（updateSession 被调）', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ titled: false }),
      messages: [],
      updates,
    });
    const caller = makeMockLlmCaller();
    const svc = new AutoNamingService({
      store,
      agentManager: makeMockAgentManager(),
      metaBroadcaster: makeMockBroadcaster(),
      llmCaller: caller,
    });

    await svc.triggerIfFirstQuery('sid-1', '今天天气怎么样');

    expect(store.getMessages).toHaveBeenCalledWith('sid-1', { limit: 200 });
    expect(caller.invoke).toHaveBeenCalledTimes(1);
    expect(updates.length).toBe(1);
    expect(updates[0]!.patch).toEqual({ title: '关于天气的查询', titled: true });
  });

  it('非首 query（有 prior user 消息）→ no-op（不扫 LLM、不 updateSession）', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ titled: false }),
      messages: [
        { id: 'm1', role: 'user', content: [] } as unknown as BizMessage,
      ],
      updates,
    });
    const agentManager = makeMockAgentManager();
    const caller = makeMockLlmCaller();
    const svc = new AutoNamingService({
      store,
      agentManager,
      metaBroadcaster: makeMockBroadcaster(),
      llmCaller: caller,
    });

    await svc.triggerIfFirstQuery('sid-1', '再问一次');

    expect(agentManager.resolveConfigBySid).not.toHaveBeenCalled();
    expect(caller.invoke).not.toHaveBeenCalled();
    expect(updates.length).toBe(0);
  });

  it('bizType=studio → no-op（studio scope 不起名）', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ biz: 'studio', titled: false }),
      messages: [],
      updates,
    });
    const agentManager = makeMockAgentManager();
    const caller = makeMockLlmCaller();
    const svc = new AutoNamingService({
      store,
      agentManager,
      metaBroadcaster: makeMockBroadcaster(),
      llmCaller: caller,
    });

    await svc.triggerIfFirstQuery('sid-1', 'squad message');

    expect(agentManager.resolveConfigBySid).not.toHaveBeenCalled();
    expect(updates.length).toBe(0);
  });

  it('type=subagent → no-op（subagent 不起名，由 parent 驱动）', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ derivation: 'subagent', role: 'rocky', titled: false }),
      messages: [],
      updates,
    });
    const agentManager = makeMockAgentManager();
    const caller = makeMockLlmCaller();
    const svc = new AutoNamingService({
      store,
      agentManager,
      metaBroadcaster: makeMockBroadcaster(),
      llmCaller: caller,
    });

    await svc.triggerIfFirstQuery('sid-1', 'child query');

    expect(agentManager.resolveConfigBySid).not.toHaveBeenCalled();
    expect(updates.length).toBe(0);
  });

  it('titled 已 true → no-op（防御：不再触发）', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ titled: true }),
      messages: [],
      updates,
    });
    const agentManager = makeMockAgentManager();
    const caller = makeMockLlmCaller();
    const svc = new AutoNamingService({
      store,
      agentManager,
      metaBroadcaster: makeMockBroadcaster(),
      llmCaller: caller,
    });

    await svc.triggerIfFirstQuery('sid-1', 'first query but titled');

    expect(agentManager.resolveConfigBySid).not.toHaveBeenCalled();
    expect(updates.length).toBe(0);
  });

  it('session 不存在（getSession null）→ no-op 不抛', async () => {
    const store = makeMockStore({ session: null, messages: [] });
    const agentManager = makeMockAgentManager();
    const caller = makeMockLlmCaller();
    const svc = new AutoNamingService({
      store,
      agentManager,
      metaBroadcaster: makeMockBroadcaster(),
      llmCaller: caller,
    });

    await expect(svc.triggerIfFirstQuery('missing', 'q')).resolves.toBeUndefined();
    expect(agentManager.resolveConfigBySid).not.toHaveBeenCalled();
  });

  it('type 为 undefined（顶层 standalone）→ 视为非 subagent，正常触发', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ derivation: 'parent', role: 'rocky' }),
      messages: [],
      updates,
    });
    const caller = makeMockLlmCaller();
    const svc = new AutoNamingService({
      store,
      agentManager: makeMockAgentManager(),
      metaBroadcaster: makeMockBroadcaster(),
      llmCaller: caller,
    });

    await svc.triggerIfFirstQuery('sid-1', 'q');

    expect(updates.length).toBe(1);
  });
});

// ============================================================
// CAS 应用测试（applyAiName re-read gate）
// ============================================================

describe('AutoNamingService CAS（titled re-read gate）', () => {
  it('titled false（re-read）+ aiName 非空 → updateSession({title, titled:true}) + broadcast 被调', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ titled: false }),
      reReadSession: makeSession({ titled: false }),
      messages: [],
      updates,
    });
    const broadcaster = makeMockBroadcaster();
    const svc = new AutoNamingService({
      store,
      agentManager: makeMockAgentManager(),
      metaBroadcaster: broadcaster,
      llmCaller: makeMockLlmCaller(),
    });

    await svc.triggerIfFirstQuery('sid-1', 'q');

    expect(updates.length).toBe(1);
    expect(updates[0]!.patch).toEqual({ title: '关于天气的查询', titled: true });
    expect(broadcaster.broadcast).toHaveBeenCalledTimes(1);
    expect(broadcaster.broadcast).toHaveBeenCalledWith('sid-1');
  });

  it('titled true（re-read 后已被改名）→ 不调 updateSession + 不 broadcast（AI 名丢弃）', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ titled: false }),
      reReadSession: makeSession({ titled: true, title: '用户改的名' }),
      messages: [],
      updates,
    });
    const broadcaster = makeMockBroadcaster();
    const svc = new AutoNamingService({
      store,
      agentManager: makeMockAgentManager(),
      metaBroadcaster: broadcaster,
      llmCaller: makeMockLlmCaller(),
    });

    await svc.triggerIfFirstQuery('sid-1', 'q');

    expect(updates.length).toBe(0);
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
  });

  it('无 metaBroadcaster 注入 → updateSession 仍执行，broadcast no-op（不抛）', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ titled: false }),
      messages: [],
      updates,
    });
    const svc = new AutoNamingService({
      store,
      agentManager: makeMockAgentManager(),
      llmCaller: makeMockLlmCaller(),
    });

    await svc.triggerIfFirstQuery('sid-1', 'q');

    expect(updates.length).toBe(1);
  });
});

// ============================================================
// silent-fail 测试
// ============================================================

describe('AutoNamingService silent-fail', () => {
  it('invoke throw → 不抛 + 不 updateSession + 不 broadcast', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ titled: false }),
      messages: [],
      updates,
    });
    const broadcaster = makeMockBroadcaster();
    const svc = new AutoNamingService({
      store,
      agentManager: makeMockAgentManager(),
      metaBroadcaster: broadcaster,
      llmCaller: makeMockLlmCaller({ throwOnInvoke: new Error('LLM 500') }),
    });

    await expect(svc.triggerIfFirstQuery('sid-1', 'q')).resolves.toBeUndefined();

    expect(updates.length).toBe(0);
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
  });

  it('resolveConfigBySid throw → 不抛 + 不 updateSession', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ titled: false }),
      messages: [],
      updates,
    });
    const svc = new AutoNamingService({
      store,
      agentManager: makeMockAgentManager({ throwOnResolve: new Error('config 缺失') }),
      llmCaller: makeMockLlmCaller(),
    });

    await expect(svc.triggerIfFirstQuery('sid-1', 'q')).resolves.toBeUndefined();
    expect(updates.length).toBe(0);
  });

  it('LLM 返空 text → aiName null → 不 updateSession', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ titled: false }),
      messages: [],
      updates,
    });
    const svc = new AutoNamingService({
      store,
      agentManager: makeMockAgentManager(),
      llmCaller: makeMockLlmCaller({
        invokeImpl: async () => ({
          message: { id: 'r', role: 'assistant', content: [{ type: 'text', text: '   ' }] },
          usage: null,
          stopReason: 'stop',
        }),
      }),
    });

    await svc.triggerIfFirstQuery('sid-1', 'q');
    expect(updates.length).toBe(0);
  });

  it('updateSession throw → 外层 .catch 兜底（triggerIfFirstQuery 不抛）', async () => {
    const store = makeMockStore({
      session: makeSession({ titled: false }),
      messages: [],
    });
    (store.updateSession as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('DB error');
    });
    const svc = new AutoNamingService({
      store,
      agentManager: makeMockAgentManager(),
      metaBroadcaster: makeMockBroadcaster(),
      llmCaller: makeMockLlmCaller(),
    });

    await expect(svc.triggerIfFirstQuery('sid-1', 'q')).resolves.toBeUndefined();
  });
});

// ============================================================
// [v0.0.84] invoke 路径契约测试（backgroundPath / baseReq / 观测）
// ============================================================

describe('[v0.0.84] AutoNamingService 走 LlmCaller.invoke 契约', () => {
  it('ctx.backgroundPath === true（防雪崩：capacity 类不重试）', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ titled: false }),
      messages: [],
      updates,
    });
    const caller = makeMockLlmCaller();
    const svc = new AutoNamingService({
      store,
      agentManager: makeMockAgentManager(),
      metaBroadcaster: makeMockBroadcaster(),
      llmCaller: caller,
    });

    await svc.triggerIfFirstQuery('sid-1', 'q');

    expect(caller.captureCtx.length).toBe(1);
    expect(caller.captureCtx[0]!.backgroundPath).toBe(true);
  });

  it('baseReq.params 不含 maxTokens/temperature（完全复用 session/model 配置，D3）', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ titled: false }),
      messages: [],
      updates,
    });
    const caller = makeMockLlmCaller();
    const svc = new AutoNamingService({
      store,
      agentManager: makeMockAgentManager(),
      llmCaller: caller,
    });

    await svc.triggerIfFirstQuery('sid-1', 'q');

    expect(caller.captureReq.length).toBe(1);
    const req = caller.captureReq[0]!;
    expect(req.params.maxTokens).toBeUndefined();
    expect(req.params.temperature).toBeUndefined();
    expect(req.modelId).toBe('mock-model');
    expect(req.messages.length).toBe(1);
    expect(req.messages[0]!.role).toBe('user');
  });

  it('invoke 成功 → adapter.endGeneration 由 invoke 内部 langfuse port 调（auto-naming 仅 endTrace）', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ titled: false }),
      messages: [],
      updates,
    });
    const obs = makeMockObservabilityAdapter();
    const caller = makeMockLlmCaller();
    const svc = new AutoNamingService({
      store,
      agentManager: makeMockAgentManager(),
      llmCaller: caller,
      observability: obs.adapter,
    });

    await svc.triggerIfFirstQuery('sid-1', 'q');

    // startTrace / startGeneration 各 1 次（独立 trace + generation）
    expect(obs.calls.filter((c) => c.method === 'startTrace')).toHaveLength(1);
    expect(obs.calls.filter((c) => c.method === 'startGeneration')).toHaveLength(1);
    // endTrace 1 次（auto-naming 收尾）
    expect(obs.calls.filter((c) => c.method === 'endTrace')).toHaveLength(1);
  });

  it('resolveConfigBySid 抛 → pre-invoke 失败 → 无 obs 资源 → 不调 endGeneration（pure silent-fail）', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ titled: false }),
      messages: [],
      updates,
    });
    const obs = makeMockObservabilityAdapter();
    const caller = makeMockLlmCaller();
    const svc = new AutoNamingService({
      store,
      agentManager: makeMockAgentManager({ throwOnResolve: new Error('config 缺失') }),
      llmCaller: caller,
      observability: obs.adapter,
    });

    await expect(svc.triggerIfFirstQuery('sid-1', 'q')).resolves.toBeUndefined();

    // resolveConfigBySid 抛在 startGeneration 前 → 无 trace/gen 资源建立
    expect(caller.invoke).not.toHaveBeenCalled();
    expect(obs.calls.filter((c) => c.method === 'startTrace')).toHaveLength(0);
    expect(obs.calls.filter((c) => c.method === 'startGeneration')).toHaveLength(0);
    expect(obs.calls.filter((c) => c.method === 'endGeneration')).toHaveLength(0);
    expect(updates.length).toBe(0);
  });

  it('invoke 抛 ClassifiedLlmError → invoke 内部已 end，auto-naming 仅 endTrace（fail-silent）', async () => {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ titled: false }),
      messages: [],
      updates,
    });
    const obs = makeMockObservabilityAdapter();
    // 模拟 ClassifiedLlmError（带 category 字段）—— invoke 内部已 endGenerationError，
    // auto-naming 不应再调 observeFailure（避免双 end）。
    const classifiedErr = new Error('LLM 500') as Error & { category: string };
    classifiedErr.category = 'PROVIDER_OVERLOADED';
    const caller = makeMockLlmCaller({ throwOnInvoke: classifiedErr });
    const svc = new AutoNamingService({
      store,
      agentManager: makeMockAgentManager(),
      llmCaller: caller,
      observability: obs.adapter,
    });

    await expect(svc.triggerIfFirstQuery('sid-1', 'q')).resolves.toBeUndefined();

    // trace + gen 已建立
    expect(obs.calls.filter((c) => c.method === 'startTrace')).toHaveLength(1);
    expect(obs.calls.filter((c) => c.method === 'startGeneration')).toHaveLength(1);
    // auto-naming fail-silent 收尾 endTrace
    expect(obs.calls.filter((c) => c.method === 'endTrace')).toHaveLength(1);
    // 双 end 守护：invoke 内部已 end（契约），auto-naming 不应再调 observeFailure/endGeneration
    expect(obs.calls.filter((c) => c.method === 'endGeneration')).toHaveLength(0);
    // 不 updateSession（静默失败）
    expect(updates.length).toBe(0);
  });

  it('[bug-fix] observability 真源 = deps.observability（resolveConfigBySid 返的 config 无 observability 字段也走注入的 adapter）', async () => {
    // [v0.0.84 返工] AT 暴露 bug：旧实现 `config.observability ?? noopAdapter` 恒落 noop
    //   （resolveConfigBySid 返的 SessionConfig 无 observability 字段）→ 起名 trace 从未进 langfuse。
    // 本 case 验证：deps.observability 被消费（即使 config 上没 observability 字段也起 trace）。
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ titled: false }),
      messages: [],
      updates,
    });
    const obs = makeMockObservabilityAdapter();
    const caller = makeMockLlmCaller();
    const svc = new AutoNamingService({
      store,
      agentManager: makeMockAgentManager(), // config 无 observability 字段
      llmCaller: caller,
      observability: obs.adapter, // 真源 = deps
    });

    await svc.triggerIfFirstQuery('sid-1', 'q');

    // 关键断言：deps 注入的 adapter 真被调（trace 建立），不是落 noop
    expect(obs.calls.filter((c) => c.method === 'startTrace')).toHaveLength(1);
    expect(obs.calls.filter((c) => c.method === 'startGeneration')).toHaveLength(1);
    expect(obs.calls.filter((c) => c.method === 'endTrace')).toHaveLength(1);
  });

  it('[bug-fix] 未注入 deps.observability → 落 noopAdapter（noop.startTrace 是空操作不抛，invoke 仍跑）', async () => {
    // 防御性 case：deps.observability 缺省时落 noopAdapter（不爆），功能仍正常。
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const store = makeMockStore({
      session: makeSession({ titled: false }),
      messages: [],
      updates,
    });
    const caller = makeMockLlmCaller();
    const svc = new AutoNamingService({
      store,
      agentManager: makeMockAgentManager(),
      llmCaller: caller,
      // observability 故意不传
    });

    await svc.triggerIfFirstQuery('sid-1', 'q');

    // 不爆，起名仍走通（noopAdapter.startTrace/endTrace 空操作）
    expect(caller.invoke).toHaveBeenCalledTimes(1);
    expect(updates.length).toBe(1);
  });
});

// ============================================================
// extractPlainName 测试（净化规则）
// ============================================================

describe('extractPlainName（净化规则）', () => {
  function respOf(text: string): { message: { content: ProtocolMessage['content'] } } {
    return {
      message: { content: [{ type: 'text', text }] } as { content: ProtocolMessage['content'] },
    };
  }

  it('纯文本 → 原样返回（trim）', () => {
    expect(extractPlainName(respOf('关于天气的查询'))).toBe('关于天气的查询');
    expect(extractPlainName(respOf('  带空格的标题  '))).toBe('带空格的标题');
  });

  it('去半角双引号包围（"..."）', () => {
    expect(extractPlainName(respOf('"天气查询"'))).toBe('天气查询');
  });

  it('去全角引号包围（"..."）', () => {
    expect(extractPlainName(respOf('“天气查询”'))).toBe('天气查询');
  });

  it('去单引号包围（\'...\'）', () => {
    expect(extractPlainName(respOf("'天气查询'"))).toBe('天气查询');
  });

  it('去末尾声明标点（。.!！?？）', () => {
    expect(extractPlainName(respOf('天气查询。'))).toBe('天气查询');
    expect(extractPlainName(respOf('天气查询!'))).toBe('天气查询');
    expect(extractPlainName(respOf('天气查询？'))).toBe('天气查询');
  });

  it('取首行（多行解释只取第一行）', () => {
    expect(extractPlainName(respOf('天气查询\n这是解释，不要取'))).toBe('天气查询');
  });

  it('去前缀「标题：」类标记（不删，由 prompt 兜底；只清引号/末尾标点）', () => {
    expect(extractPlainName(respOf('标题：天气查询'))).toBe('标题：天气查询');
  });

  it('空字符串 → null', () => {
    expect(extractPlainName(respOf(''))).toBeNull();
    expect(extractPlainName(respOf('   '))).toBeNull();
  });

  it('纯标点 → null（去标点后空）', () => {
    expect(extractPlainName(respOf('。'))).toBeNull();
    expect(extractPlainName(respOf('？'))).toBeNull();
  });

  it('无 text block → null', () => {
    const resp = {
      message: {
        content: [{ type: 'tool_call', id: 't', name: 'x', arguments: {} }],
      } as { content: ProtocolMessage['content'] },
    };
    expect(extractPlainName(resp)).toBeNull();
  });
});

// ============================================================
// PUT title 3 call site 测试
// ============================================================

describe('PUT /session/:id title 3 call site（titled:true + broadcast）', () => {
  async function setup() {
    const updates: { sid: string; patch: Record<string, unknown> }[] = [];
    const session = makeSession({ titled: false });
    const store = {
      getSession: vi.fn(async () => ({ ...session, ...updates[0]?.patch })),
      updateSession: vi.fn(async (sid: string, patch: Record<string, unknown>) => {
        updates.push({ sid, patch });
        Object.assign(session, patch);
      }),
    } as unknown as SessionStore;
    const broadcaster = makeMockBroadcaster();
    const { handleSessionItem } = await import('../../handlers/session');
    const { handleSessionUpdate } = await import('../../handlers/session-update');
    return { store, broadcaster, updates, handleSessionItem, handleSessionUpdate };
  }

  function mkDeps(store: SessionStore, broadcaster: SessionMetaBroadcaster) {
    return {
      store,
      agentManager: {} as never,
      appConfig: {} as never,
      pluginManager: {} as never,
      devConfig: {} as never,
      contextEngine: {} as never,
      dataDir: '/tmp',
      metaBroadcaster: broadcaster,
    } as never;
  }

  it('session.ts handleSessionItem PUT body.title → updateSession 收到 titled:true + broadcast', async () => {
    const { store, broadcaster, updates, handleSessionItem } = await setup();
    const req = new Request('http://x/session/sid-1', {
      method: 'PUT',
      body: JSON.stringify({ title: '用户改的名' }),
    });
    const res = await handleSessionItem(req, 'PUT', 'sid-1', mkDeps(store, broadcaster));
    expect(res.status).toBe(200);
    expect(updates.length).toBe(1);
    expect(updates[0]!.patch).toEqual({ title: '用户改的名', titled: true });
    expect(broadcaster.broadcast).toHaveBeenCalledWith('sid-1');
  });

  it('session.ts handleSessionItem PUT 仅 providerId（无 title）→ 不置 titled + 不 broadcast', async () => {
    const { store, broadcaster, updates, handleSessionItem } = await setup();
    const req = new Request('http://x/session/sid-1', {
      method: 'PUT',
      body: JSON.stringify({ providerId: 'p1' }),
    });
    try {
      await handleSessionItem(req, 'PUT', 'sid-1', mkDeps(store, broadcaster));
    } catch {
      /* mock appConfig 不完整可能抛，忽略 */
    }
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
    const titledUpdate = updates.find((u) => 'titled' in u.patch);
    expect(titledUpdate).toBeUndefined();
  });

  it('session-update.ts PUT 仅 title → updateSession 收到 titled:true + broadcast', async () => {
    const { store, broadcaster, updates, handleSessionUpdate } = await setup();
    const req = new Request('http://x/session/sid-1', {
      method: 'PUT',
      body: JSON.stringify({ title: '只改 title' }),
    });
    const res = await handleSessionUpdate(req, 'PUT', 'sid-1', mkDeps(store, broadcaster));
    expect(res.status).toBe(200);
    expect(updates.length).toBe(1);
    expect(updates[0]!.patch).toEqual({ title: '只改 title', titled: true });
    expect(broadcaster.broadcast).toHaveBeenCalledWith('sid-1');
  });

  it('session-update.ts PUT workspaceDir + title → 两路径都置 titled + broadcast', async () => {
    const realDir = mkdtempSync(join(tmpdir(), 'oobt-auto-naming-ws-'));
    try {
      const { store, broadcaster, updates, handleSessionUpdate } = await setup();
      (store as unknown as { setWorkspaceDir: unknown }).setWorkspaceDir = vi.fn(async () => {
        /* no-op */
      });
      const req = new Request('http://x/session/sid-1', {
        method: 'PUT',
        body: JSON.stringify({ workspaceDir: realDir, title: '同时改' }),
      });
      const res = await handleSessionUpdate(req, 'PUT', 'sid-1', mkDeps(store, broadcaster));
      expect(res.status).toBe(200);
      const titleUpdate = updates.find((u) => u.patch.title === '同时改');
      expect(titleUpdate).toBeDefined();
      expect(titleUpdate!.patch.titled).toBe(true);
      expect(broadcaster.broadcast).toHaveBeenCalledWith('sid-1');
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });

  it('无 metaBroadcaster 注入（旧测试场景）→ PUT title 仍写 titled:true，broadcast no-op（不抛）', async () => {
    const { store, updates, handleSessionItem } = await setup();
    const req = new Request('http://x/session/sid-1', {
      method: 'PUT',
      body: JSON.stringify({ title: '无广播' }),
    });
    const depsNoBroadcast = {
      store,
      agentManager: {} as never,
      appConfig: {} as never,
      pluginManager: {} as never,
      devConfig: {} as never,
      contextEngine: {} as never,
      dataDir: '/tmp',
    } as never;
    const res = await handleSessionItem(req, 'PUT', 'sid-1', depsNoBroadcast);
    expect(res.status).toBe(200);
    expect(updates[0]!.patch).toEqual({ title: '无广播', titled: true });
  });
});
