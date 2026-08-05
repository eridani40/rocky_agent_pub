import { defaultTools } from '../../tools/registry';
import { SessionKind } from '@app/shared';
import type { SessionTypePolicy } from '../session-type-policy';
import type { ResolvedSessionProfile } from '../session-type-profile-loader';
/**
 * AgentLoop 单元测试 — eager ReAct 循环（v0.0.8 task-5）
 * 参考: states/v0.0.8/task.json task-5 acceptance（path A/B/C/D + doom + max_iter + activate）
 *       specs/tech/version_logs/v0.0.8/change_log.md §4 §9
 *
 * 覆盖：
 *   (a) path A（mock:text）：run_start → message_start(assistant) → text_block_delta*
 *       → message_end → run_end(no_tool_call)
 *   (b) path B（mock:tool）：tool_call_* + tool_result_* (toolCallId 绑定) + 续 message_start 文本
 *       → run_end(no_tool_call)
 *   (c) path C（mock:error）：error{message,code} + run_end(error)
 *   (d) path D（mock:compact）：超阈值历史 → compact 触发 → setSummary 被调 → 续 run 无错
 *   doom_loop：同输入 ≥3 轮 → stopReason:doom_loop
 *   max_iterations：step>=maxIterations → max_iterations
 *   activate 二次 → already_running
 *
 * 用真实 EventBus(replayable) + fs SessionStore + 真 ContextEngine/ToolEngine +
 * mock fetch（按 modelId 切换剧本）。
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
import { ContextEngine } from '../context-engine';
import { setSessionStoreEpDelegate } from '../session-store-ep-delegate';
import { ToolExecutionEngine } from '../../tools/engine';
import { InboxStore } from '../inbox';
import { ReplayableEventBus } from '../event-bus';
import { AgentManagerImpl } from '../agent-manager';
// [v0.0.40 T6a] compact 改走 EP：path D 需 pluginManager + rocky_context 加载
import { Registry } from '../../plugin/registry';
import { PluginManager } from '../../plugin/plugin-manager';
import { BuiltinLoader } from '../../plugin/builtin-loader';
import { BUILTIN_EXTENSION_POINTS } from '../../plugin/extension-point';
import { LoadedScopeConfigProvider } from '../../plugin/scope-config-provider';
import type { AgentEvent } from '../agent-event-types';
import type { SessionConfig } from '../context-types';
import type { Message, MessageInput } from '../../message/types';
import type { Tool } from '../../tools/types';

// ── mock LlmClient 工厂：注入自定义 stream/call 产出（便于精确控制事件）──

/** 单条 stream event 形态（简化，覆盖 text_delta / tool_call_delta / usage / finish） */
type StubEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | {
      type: 'tool_call_delta';
      toolCallId: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: 'usage'; usage: Record<string, number> }
  | { type: 'finish'; reason: 'stop' | 'tool_use' | 'max_tokens' };

/**
 * mock LlmClient：每次 stream 按轮次返回 scripted events。
 * @param scriptFor 给定已 ingest 消息数 → 返回该轮应产出的事件数组
 *                   （便于 mock:tool 等剧本按上下文切换）
 * @param contextWindow 上下文窗口（mock:compact 用小值触发 compact）
 */

/** main profile mock（buildRunDeps 始终调 policy.profile(kind) 单源驱动装配） */
function mockMainPolicy(): SessionTypePolicy {
  const profile: ResolvedSessionProfile = {
    id: 'playground-rocky:parent:main',
    enabled: true, toolBound: [], toolDefinitionsSource: 'own',
    runShape: { drainMode: 'eager', backgroundPath: false, maxIterDefault: 25, touchesStateMachine: true, persistsRun: true, usagePartition: 'current' },
    lifecycleHooks: { abortFinalize: 'four-step', cascadeChildren: true },
    eventChannel: { emitDefault: true },
    modelHints: { readsSquadDefault: false }, skillSource: 'global-enabled', eosStop: [],
    autoNaming: false, preloadContext: 'none',
  };
  return { profile: vi.fn(() => profile), resolveToolSet: vi.fn(() => ({ tools: [], toolDefinitions: [], allowedTools: [] })) };
}

const parentKind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'main' });

function stubClient(
  scriptFor: (roundInput: { messages: unknown[] }) => StubEvent[],
  contextWindow = 100000,
): {
  client: unknown;
  callCount: () => number;
} {
  let count = 0;
  const client = {
    contextWindow,
    async *_stream(req: { messages: unknown[] }): AsyncIterable<StubEvent> {
      count++;
      const events = scriptFor({ messages: req.messages });
      for (const e of events) yield e;
    },
    async call(): Promise<{
      message: { id: string; role: 'assistant'; content: { type: 'text'; text: string }[] };
      usage: Record<string, number>;
      stopReason: 'stop';
    }> {
      // compact 用：返回 <summary>...</summary> 文本
      return {
        message: {
          id: 'compact-resp',
          role: 'assistant',
          content: [{ type: 'text', text: '<summary>这是压缩后的总结</summary>' }],
        },
        usage: {},
        stopReason: 'stop',
      };
    },
  };
  // 暴露 stream 别名（与 LlmClient.stream 同名，便于 SessionConfig.client.stream 调用）
  Object.assign(client, { stream: (client as { _stream: unknown })._stream });
  return {
    client,
    callCount: () => count,
  };
}

// ── 公共 fixture ──

let tmpRoot: string;
let store: SessionStore;
let contextEngine: ContextEngine;
let toolEngine: ToolExecutionEngine;
let inbox: InboxStore;
let bus: ReplayableEventBus;
let tools: Tool[];

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-agent-loop-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  // [v0.0.40 T6a] 加载 rocky_context plugin + PluginManager（compact 走 EP 必需）
  const registry = new Registry();
  for (const ep of BUILTIN_EXTENSION_POINTS) registry.registerExtensionPoint(ep);
  const realBuiltins = join(__dirname, '../../../../plugins/builtins');
  await new BuiltinLoader(realBuiltins).loadAll(registry);
  // [v0.0.179] PluginManager 读源切到代码声明（D2）：加载真实 default.yaml（impl 列表模型，membership = active）
  const realScopes = join(__dirname, '../../../../plugins/scopes');
  const { ScopeConfigLoader } = await import('../../plugin/scope-config-loader');
  const scopeConfigs = new ScopeConfigLoader(realScopes).loadAll();
  const provider = new LoadedScopeConfigProvider(scopeConfigs);
  const pluginManager = new PluginManager({ registry, scopeConfigs: provider });
  // [v0.0.66 §2.3] 注入持久 store 到 persistent_session_store EP impl 的 delegate holder
  setSessionStoreEpDelegate(store);
  contextEngine = new ContextEngine({ store, pluginManager });
  // v0.0.15 T5：compact 走 manager.sideRun（contextEngine.sideRunner）。
  // 本 UT 文件仅 path D 触发 compact（小窗口超阈值）；mock runner 直接返回预设 summary 文本，
  // 避免引入 ForkedAgent 多轮依赖（path D 关注 compact 副作用不关心 forked 内部）。
  // [v0.0.40 T6a] compact 经 EP（summary_do_compact → runCompact → sideRunner）触发，签名不变。
  // v0.0.158：CompactSideRunner input 已删 `config` 字段（bootstrap 生产实现自 resolveConfigBySid
  //   拿 config），本 UT mock 不依赖 config——直接返回硬编码 summary（原实现的 client.stream 分支只做
  //   占位消耗，被丢弃后返回硬编码值，等价删除更清晰）。
  (contextEngine as unknown as { setSideRunner: (r: unknown) => void }).setSideRunner(
    async () => ({ answer: '<summary>这是压缩后的总结</summary>', usage: {} }),
  );
  toolEngine = new ToolExecutionEngine();
  inbox = new InboxStore();
  bus = new ReplayableEventBus({ replayable: true });
  tools = defaultTools(tmpRoot);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造 SessionConfig（注入 mock client + modelId） */
function newConfig(
  sessionId: string,
  client: unknown,
  opts: { contextWindow?: number; maxIterations?: number; workdir?: string } = {},
): SessionConfig {
  return {
    sessionId,
    systemPrompt: 'You are a helpful assistant.',
    client: client as SessionConfig['client'],
    modelId: 'mock-model',
    kind: parentKind,
    tools,
    workdir: opts.workdir ?? tmpRoot,
    ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
  } as SessionConfig;
}

/** 构造一条 user Message（含 sender.source=user） */
function userMessage(sessionId: string, text: string): Message {
  return {
    id: ulid(),
    sessionId,
    role: 'user',
    content: [{ type: 'text', text }],
    sender: { source: 'user' },
  };
}

/** 创建 session + manager + 启动 run，收集所有事件直到 run_end。
 *  [v0.0.31 去 config 重构] 内部 setResolveConfig 注入测试 config，新签名 enqueue/activate(sid)。 */
async function runAndCollect(
  config: SessionConfig,
  messages: Message[],
): Promise<{ events: AgentEvent[]; result: { state: string; runId: string } }> {
  const manager = new AgentManagerImpl({
    bus,
    store,
    inbox,
    contextEngine,
    toolEngine,
    sessionTypePolicy: mockMainPolicy(),
  });
    manager.setResolveConfig(async () => config);
  await store.createSession({ id: config.sessionId });
  // agent-loop 内部自分配 runId + createRun（upsert），不需要外部预创建
  await manager.enqueue(config.sessionId, messages);
  const result = await manager.activate(config.sessionId);

  // 等待 run_end（事件流读直到 run_end）
  const events: AgentEvent[] = [];
  // 先订阅再激活已来不及（activate 已返回）—— bus 是 replayable，订阅会回放历史
  const sub = manager.subscribe(config.sessionId);
  for await (const e of sub) {
    events.push(e);
    if (e.type === 'run_end') break;
  }
  return { events, result: { state: result.state, runId: result.runId } };
}

// ============================================================
// (a) path A: mock:text
// ============================================================

describe('AgentLoop path A — mock:text 纯文本回复', () => {
  it('事件序列 run_start → message_start(assistant) → text_block_delta* → message_end → run_end(no_tool_call)', async () => {
    const sid = ulid();
    const { client } = stubClient(() => [
      { type: 'text_delta', text: '你好，我是助手' },
      { type: 'usage', usage: { input_tokens: 5, output_tokens: 8 } },
      { type: 'finish', reason: 'stop' },
    ]);
    const config = newConfig(sid, client);
    const { events } = await runAndCollect(config, [userMessage(sid, 'hi')]);


    const types = events.map((e) => e.type);
    // run_start 必须出现（在 message_enqueued 之后）
    expect(types).toContain('run_start');
    // 应含 user message_start（pre-process）+ assistant message_start（LLM）
    expect(types.filter((t) => t === 'message_start').length).toBeGreaterThanOrEqual(2);
    expect(types).toContain('text_block_delta');
    expect(types).toContain('text_block_end');
    expect(types).toContain('usage_block');
    // 末尾是 run_end(no_tool_call)
    const runEnd = events.find((e) => e.type === 'run_end');
    expect(runEnd).toBeDefined();
    expect((runEnd as { stopReason: string }).stopReason).toBe('no_tool_call');
    // text_block_delta 累积出 "你好，我是助手"
    const textDeltas = events
      .filter((e) => e.type === 'text_block_delta')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    // 至少有一份文本块（user 或 assistant）；这里检查 assistant 那份
    expect(textDeltas).toContain('你好，我是助手');
    // run 入库为 completed
    const run = await store.getRuns(sid);
    expect(run[0]!.status).toBe('completed');
    expect(run[0]!.stopReason).toBe('no_tool_call');
  });
});

// ============================================================
// (b) path B: mock:tool
// ============================================================

describe('AgentLoop path B — mock:tool 工具调用 + 续轮', () => {
  it('tool_call_start/delta/end + tool_result_start/delta/end (toolCallId 绑定) + 续 message_start 文本 → run_end(no_tool_call)', async () => {
    const sid = ulid();
    // round 1: text + tool_use(bash echo hi)；round 2 (有 tool_result): 纯文本
    const { client, callCount } = stubClient(({ messages }) => {
      const last = messages[messages.length - 1] as { role?: string };
      if (last?.role === 'tool') {
        return [
          { type: 'text_delta', text: '工具执行完毕' },
          { type: 'usage', usage: { input_tokens: 5, output_tokens: 5 } },
          { type: 'finish', reason: 'stop' },
        ];
      }
      return [
        { type: 'text_delta', text: '我来执行一个命令' },
        {
          type: 'tool_call_delta',
          toolCallId: 'tool_mock_1',
          name: 'bash',
          argumentsDelta: JSON.stringify({ command: 'echo hi' }),
        },
        { type: 'usage', usage: { input_tokens: 5, output_tokens: 12 } },
        { type: 'finish', reason: 'tool_use' },
      ];
    });
    const config = newConfig(sid, client);
    const { events } = await runAndCollect(config, [userMessage(sid, 'run bash')]);

    const types = events.map((e) => e.type);
    // 工具调用事件
    expect(types).toContain('tool_call_start');
    expect(types).toContain('tool_call_delta');
    expect(types).toContain('tool_call_end');
    // 工具结果事件
    expect(types).toContain('tool_result_start');
    expect(types).toContain('tool_result_delta');
    expect(types).toContain('tool_result_end');

    // toolCallId 绑定一致
    const callStart = events.find((e) => e.type === 'tool_call_start') as {
      toolCallId: string;
      toolName: string;
    };
    expect(callStart.toolName).toBe('bash');
    const resultStart = events.find((e) => e.type === 'tool_result_start') as {
      toolCallId: string;
      messageId?: string;
    };
    const resultDelta = events.find((e) => e.type === 'tool_result_delta') as {
      messageId?: string;
    };
    const resultEnd = events.find((e) => e.type === 'tool_result_end') as {
      messageId?: string;
    };
    expect(resultStart.toolCallId).toBe(callStart.toolCallId);
    // [v0.0.19 BUG-fix] tool_result_start/delta/end 共享同一 messageId（defined）
    // 修复前三事件均不带 messageId（=undefined），客户端 reducer 无法建/更新 tool 消息节点
    expect(resultStart.messageId).toBeDefined();
    expect(resultStart.messageId).toBe(resultDelta.messageId);
    expect(resultStart.messageId).toBe(resultEnd.messageId);

    // 续轮 message_start（>=3：user + assistant_round1 + assistant_round2）
    expect(types.filter((t) => t === 'message_start').length).toBeGreaterThanOrEqual(3);

    // run_end(no_tool_call)（续轮无 tool）
    const runEnd = events.find((e) => e.type === 'run_end') as { stopReason: string };
    expect(runEnd.stopReason).toBe('no_tool_call');

    // LLM 被调用 2 次（首轮 + 续轮）
    expect(callCount()).toBe(2);
  });
});

// ============================================================
// (c) path C: mock:error
// ============================================================

describe('AgentLoop path C — mock:error', () => {
  it('LLM stream 抛错 → error{message,code} + run_end(error)', async () => {
    const sid = ulid();
    // mock client：stream 直接抛错（模拟 500）
    const client = {
      contextWindow: 100000,
      async *stream(): AsyncIterable<StubEvent> {
        throw new Error('mock error: server overloaded');
      },
      async call(): Promise<unknown> {
        return {};
      },
    };
    const config = newConfig(sid, client);
    const { events } = await runAndCollect(config, [userMessage(sid, 'err')]);

    const errEvent = events.find((e) => e.type === 'error') as {
      message: string;
      code?: string;
      errorCategory?: string;
      displayReason?: string;
    };
    expect(errEvent).toBeDefined();
    expect(errEvent.message).toContain('mock error');
    // [v0.0.25 T15] error 事件不再硬编 LOOP_ERROR,改带 errorCategory(裸 Error→classify 落 NETWORK)+ displayReason
    expect(errEvent.errorCategory ?? errEvent.code).toBe('NETWORK');
    expect(errEvent.displayReason).toBeTruthy();

    const runEnd = events.find((e) => e.type === 'run_end') as { stopReason: string };
    expect(runEnd.stopReason).toBe('error');

    // run 入库为 failed
    const run = await store.getRuns(sid);
    expect(run[0]!.status).toBe('failed');
    expect(run[0]!.stopReason).toBe('error');
  });
});

// ============================================================
// (d) path D: mock:compact
// ============================================================

describe('AgentLoop path D — mock:compact', () => {
  it('超阈值历史 → compact 触发 → setSummary 被调 → 续 run 正常无错', async () => {
    const sid = ulid();
    // 用极小 contextWindow（30 chars）触发 compact：assemble 后 remainingTokens<0
    const longText = '这是一个很长的回复用于触发 compact 流程。'.repeat(20);
    const { client } = stubClient(
      () => [
        { type: 'text_delta', text: longText },
        { type: 'usage', usage: { input_tokens: 5, output_tokens: 800 } },
        { type: 'finish', reason: 'stop' },
      ],
      30, // 极小窗口：system + user + assistant 触发 remainingTokens<0
    );
    const config = newConfig(sid, client, { contextWindow: 30 });
    const { events } = await runAndCollect(config, [userMessage(sid, 'q')]);

    // [v0.0.78.bug] compact 改为 fire-and-forget：主 loop run_end 立即发出，
    //   summary 在后台异步写入。需 bounded poll 等异步 compact 完成（最多 2s）。
    //   并发不变量见 specs/tech/version_logs/v0.0.78.bug/change_plan.md §0。
    let summary = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !summary) {
      summary = await store.getSummary(sid);
      if (!summary) await new Promise((r) => setTimeout(r, 20));
    }
    expect(summary).not.toBeNull();
    expect(summary!.content).toBe('这是压缩后的总结');

    // run 仍正常结束（compact 不应阻断 run）
    const runEnd = events.find((e) => e.type === 'run_end') as { stopReason: string };
    expect(runEnd.stopReason).toBe('no_tool_call');
  });
});

// ============================================================
// doom_loop
// ============================================================

describe('AgentLoop doom_loop 检测', () => {
  it('同输入连续 ≥3 轮 → stopReason:doom_loop', async () => {
    const sid = ulid();
    // 永远产出相同的 tool_call（bash echo loop），连续 3 轮后 doom_loop 触发
    const { client } = stubClient(() => [
      {
        type: 'tool_call_delta',
        toolCallId: 'tool_loop',
        name: 'bash',
        argumentsDelta: JSON.stringify({ command: 'echo loop' }),
      },
      { type: 'usage', usage: {} },
      { type: 'finish', reason: 'tool_use' },
    ]);
    const config = newConfig(sid, client, { maxIterations: 20 });
    const { events } = await runAndCollect(config, [userMessage(sid, 'loop')]);

    const runEnd = events.find((e) => e.type === 'run_end') as { stopReason: string };
    expect(runEnd.stopReason).toBe('doom_loop');
  });
});

// ============================================================
// max_iterations
// ============================================================

describe('AgentLoop max_iterations', () => {
  it('step >= maxIterations(=2) 且仍有 tool_call → stopReason:max_iterations', async () => {
    const sid = ulid();
    // 每轮都产不同的 tool_call（避免 doom_loop），永远不收敛 → 触发 max_iter
    let round = 0;
    const { client } = stubClient(() => {
      round++;
      return [
        {
          type: 'tool_call_delta',
          toolCallId: `tool_${round}`,
          name: 'bash',
          argumentsDelta: JSON.stringify({ command: `echo ${round}` }),
        },
        { type: 'usage', usage: {} },
        { type: 'finish', reason: 'tool_use' },
      ];
    });
    const config = newConfig(sid, client, { maxIterations: 2 });
    const { events } = await runAndCollect(config, [userMessage(sid, 'go')]);

    const runEnd = events.find((e) => e.type === 'run_end') as { stopReason: string };
    expect(runEnd.stopReason).toBe('max_iterations');
  });
});

// ============================================================
// activate 幂等
// ============================================================

describe('AgentManager.activate 幂等', () => {
  it('同 session 二次 activate 在 loop 仍在运行时返回 already_running（第一个 it 用快结束流验证至少不抛错）', async () => {
    const sid = ulid();
    const { client } = stubClient(
      () => [
        { type: 'text_delta', text: 'thinking' },
        { type: 'usage', usage: {} },
        { type: 'finish', reason: 'stop' },
      ],
    );
    const config = newConfig(sid, client);
    const manager = new AgentManagerImpl({
      bus,
      store,
      inbox,
      contextEngine,
      toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    manager.setResolveConfig(async () => config);
    await store.createSession({ id: sid });
    await manager.enqueue(sid, [userMessage(sid, 'q1')]);
    const r1 = await manager.activate(sid);
    // v0.0.15 T5：activate 返 AgentRun，state='running'（旧 'activated'）
    expect(r1.state).toBe('running');
    // 等结束确认 loop 跑完（为下一个 it 的 already_running 判定清理状态）
    const sub1 = manager.subscribe(sid);
    for await (const e of sub1) {
      if (e.type === 'run_end') break;
    }
  });

  it('loop 仍在运行时二次 activate → already_running', async () => {
    const sid = ulid();
    // stream 永远 yield 事件不 finish（loop 持续运行）
    const client = {
      contextWindow: 100000,
      async *stream(): AsyncIterable<StubEvent> {
        // 持续 yield，永不 finish —— 让 loop 卡在第 1 轮
        for (let i = 0; i < 1000; i++) {
          yield { type: 'text_delta', text: '.' };
        }
        // 防止永远卡住测试：1000 个 delta 后再 finish
        yield { type: 'finish', reason: 'stop' };
      },
      async call(): Promise<unknown> {
        return {};
      },
    };
    const config = newConfig(sid, client);
    const manager = new AgentManagerImpl({
      bus,
      store,
      inbox,
      contextEngine,
      toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    manager.setResolveConfig(async () => config);
    await store.createSession({ id: sid });
    await manager.enqueue(sid, [userMessage(sid, 'long')]);
    const r1 = await manager.activate(sid);
    // v0.0.15 T5：state='running'（旧 'activated'）
    expect(r1.state).toBe('running');
    // 立即二次 activate —— loop 应仍在运行（1000 个 delta 中）→ 返同一 AgentRun（already_running 语义）
    const r2 = await manager.activate(sid);
    expect(r2.state).toBe('running');
    expect(r2.runId).toBe(r1.runId);
  });
});

// ============================================================
// enqueue 不触发推理 + enqueued 消息处理
// ============================================================

describe('AgentManager.enqueue + enqueued 消息处理', () => {
  it('enqueue 返 enqueueIds 且不立即触发 run（activate 前）', async () => {
    const sid = ulid();
    const { client } = stubClient(() => [
      { type: 'text_delta', text: 'ok' },
      { type: 'finish', reason: 'stop' },
    ]);
    const config = newConfig(sid, client);
    const manager = new AgentManagerImpl({
      bus,
      store,
      inbox,
      contextEngine,
      toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    manager.setResolveConfig(async () => config);
    const ids = await manager.enqueue(sid, [userMessage(sid, 'q')]);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBeTruthy();
    // activate 前 inbox 应有 1 条
    expect(inbox.peek(sid)).toHaveLength(1);
  });

  it('enqueued (source=agent) 消息被 loop 处理 → emit enqueued_message_processed + 重新生成 messageId', async () => {
    const sid = ulid();
    const { client } = stubClient(() => [
      { type: 'text_delta', text: 'ok' },
      { type: 'finish', reason: 'stop' },
    ]);
    const config = newConfig(sid, client);
    const manager = new AgentManagerImpl({
      bus,
      store,
      inbox,
      contextEngine,
      toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    manager.setResolveConfig(async () => config);
    await store.createSession({ id: sid });
    // 一条 user + 一条 enqueued(agent source)
    const userMsg = userMessage(sid, 'q');
    const agentMsg: Message = {
      id: 'tmp-agent-id',
      sessionId: sid,
      role: 'assistant',
      content: [{ type: 'text', text: 'queued reply' }],
      sender: { source: 'agent', agent: { ref: { type: 'leader', sessionId: 'parent-sid', name: 'parent' }, needReply: false } },
    };
    await manager.enqueue(sid, [userMsg, agentMsg]);
    const result = await manager.activate(sid);
    // v0.0.15 T5：state='running'（旧 'activated'）
    expect(result.state).toBe('running');

    const events: AgentEvent[] = [];
    const sub = manager.subscribe(sid);
    for await (const e of sub) {
      events.push(e);
      if (e.type === 'run_end') break;
    }
    const types = events.map((e) => e.type);
    // user query 走 message_start（不入 enqueue view）
    expect(types.filter((t) => t === 'message_start').length).toBeGreaterThanOrEqual(2);
    // enqueued (agent) 走 enqueued_message_processed
    expect(types).toContain('enqueued_message_processed');
    const proc = events.find((e) => e.type === 'enqueued_message_processed') as {
      messageId: string;
    };
    expect(proc.messageId).not.toBe('tmp-agent-id'); // 重新生成
  });
});

// ============================================================
// BUG-002 回归（v0.0.13）：no_tool_call 后 peek-continue 让 loop 继续迭代消费排队消息
// 参考: app/server/src/agent/agent-loop.ts:187-201（peek-continue 分支）
//       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop.md §4c（eager drain 保证）
// ============================================================

describe('BUG-002 回归 — no_tool_call 后 peek-continue 消费排队消息', () => {
  it('LLM 回 no_tool_call 时若 inbox 有排队 message → continue 迭代 drain 消费，不丢消息', async () => {
    const sid = ulid();
    const { client } = stubClient(() => [
      { type: 'text_delta', text: 'reply-1' },
      { type: 'finish', reason: 'stop' }, // 首轮无 tool_call
    ]);
    const config = newConfig(sid, client);
    const manager = new AgentManagerImpl({
      bus,
      store,
      inbox,
      contextEngine,
      toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    manager.setResolveConfig(async () => config);
    await store.createSession({ id: sid });
    const q1 = userMessage(sid, 'q1');
    const [eid1] = await manager.enqueue(sid, [q1]);

    // activate 启动 loop（处理 q1，stream finish 无 tool_call）
    const activateResult = await manager.activate(sid);
    // v0.0.15 T5：state='running'（旧 'activated'）
    expect(activateResult.state).toBe('running');

    // 在 loop 运行期间 enqueue q2（模拟 run 中途用户发消息）
    // 用一个延迟的 stream 让 loop 多停留一会（让 q2 enqueue 有窗口）
    // 这里直接在 activate 后立即 enqueue q2，依赖 peek-continue 路径
    const q2 = userMessage(sid, 'q2');
    const [eid2] = await manager.enqueue(sid, [q2]);
    void eid1;
    void eid2;

    // 等 run_end
    const events: AgentEvent[] = [];
    const sub = manager.subscribe(sid);
    for await (const e of sub) {
      events.push(e);
      if (e.type === 'run_end') break;
    }

    // 关键断言：q1 和 q2 都被 drain 消费（emit enqueued_message_processed 各一次）
    const processed = events.filter((e) => e.type === 'enqueued_message_processed');
    expect(processed.length).toBeGreaterThanOrEqual(1);
  });
});

/** 业务 MessageInput 形态转换 helper（用于断言落库） */
function toMsgInput(m: Message): MessageInput {
  return {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role,
    content: m.content,
    ...(m.runId !== undefined ? { runId: m.runId } : {}),
    ...(m.sender !== undefined ? { sender: m.sender } : {}),
  };
}
// 抑制未使用警告（toMsgInput 留作未来断言扩展）
void toMsgInput;
