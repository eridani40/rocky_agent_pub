import { defaultTools } from '../../tools/registry';
import { SessionKind } from '@app/shared';
import type { SessionTypePolicy } from '../session-type-policy';
import type { ResolvedSessionProfile } from '../session-type-profile-loader';
/**
 * Agent enqueue cancel 单元测试（v0.0.12 task t3）
 * 参考: states/v0.0.12/design.md 板块 3.4
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_enqueue_cancel.md §2 §4 §5
 *
 * 覆盖（design §10 UT 清单 cancel 部分）：
 *   - InboxStore.appendCancel：追加 kind="cancel" 条目（不删原 message / 不删 inbox）
 *   - AgentManager.cancel：appendCancel 调用，不 emit
 *   - agent_loop drain 配对：同批 message+cancel（同 enqueueId）→ 作废 + emit canceled；
 *     无 cancel → processed；cancel 来晚（message 已被 drain）→ 丢弃，无事件
 *   - enqueued_message_canceled 事件字段（enqueueId）
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
import { ToolExecutionEngine } from '../../tools/engine';
import { InboxStore } from '../inbox';
import { ReplayableEventBus } from '../event-bus';
import { AgentManagerImpl } from '../agent-manager';
import type { AgentEvent, EnqueuedMessageCanceledEvent } from '../agent-event-types';
import type { SessionConfig } from '../context-types';
import type { Message } from '../../message/types';

let tmpRoot: string;
let store: SessionStore;
let contextEngine: ContextEngine;
let toolEngine: ToolExecutionEngine;
let inbox: InboxStore;
let bus: ReplayableEventBus;
let tools: ReturnType<typeof defaultTools>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-agent-cancel-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  bus = new ReplayableEventBus({ replayable: true });
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  contextEngine = new ContextEngine({ store });
  toolEngine = new ToolExecutionEngine();
  inbox = new InboxStore();
  tools = defaultTools(tmpRoot);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** SessionConfig 工厂（注入 mock client） */

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

function newConfig(sessionId: string, client: unknown): SessionConfig {
  return {
    sessionId,
    systemPrompt: 'sys',
    client: client as SessionConfig['client'],
    modelId: 'mock-model',
    kind: parentKind,
    tools,
    workdir: tmpRoot,
  } as SessionConfig;
}

/** mock LlmClient：每次 stream 都立即 finish（让 loop 一轮终结） */
function fastStopClient(): unknown {
  return {
    contextWindow: 100000,
    async *stream() {
      yield { type: 'finish', reason: 'stop' } as const;
    },
    async call() {
      return {
        message: { id: 'c', role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        usage: {},
        stopReason: 'stop',
      };
    },
  };
}

/** 一条 agent-source 消息（走 enqueued_message_processed 路径，便于验证 cancel 配对） */
function agentMsg(sid: string, text: string): Message {
  return {
    id: ulid(),
    sessionId: sid,
    role: 'user',
    content: [{ type: 'text', text }],
    sender: { source: 'agent', agent: { ref: { type: 'leader', sessionId: 'parent-sid', name: 'parent' }, needReply: false } },
  };
}

/** 一条 user-source 消息（走 emitUserMessageBlocks 路径） */
function userMsg(sid: string, text: string): Message {
  return {
    id: ulid(),
    sessionId: sid,
    role: 'user',
    content: [{ type: 'text', text }],
    sender: { source: 'user' },
  };
}

/** 收集 manager.subscribe 流直到 run_end 或超时 */
async function drainEventsUntilRunEnd(
  manager: AgentManagerImpl,
  sid: string,
  timeoutMs = 800,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const iter = manager.subscribe(sid)[Symbol.asyncIterator]();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await Promise.race([
      iter.next(),
      new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 30)),
    ]);
    if ('done' in r && r.done) break;
    const evt = (r as { value?: AgentEvent }).value;
    if (evt) {
      events.push(evt);
      if (evt.type === 'run_end') break;
    }
  }
  await iter.return?.();
  return events;
}

// ============================================================
// InboxStore.appendCancel
// ============================================================

describe('InboxStore.appendCancel — 追加 cancel 条目', () => {
  it('appendCancel 不删原 message、不删 inbox（design §3.4 硬约束）', () => {
    const sid = ulid();
    const m = userMsg(sid, 'hello');
    const [enqueueId] = inbox.enqueue(sid, [m]);
    expect(inbox.peek(sid)).toHaveLength(1);

    inbox.appendCancel(sid, enqueueId!);
    // 原 message 条目 + cancel 条目共存
    expect(inbox.peek(sid)).toHaveLength(2);

    // cancel 条目形态：kind=cancel + cancelFor 指向 enqueueId
    const cancelEntry = inbox.peek(sid).find((e) => e.kind === 'cancel');
    expect(cancelEntry).toBeTruthy();
    if (cancelEntry && cancelEntry.kind === 'cancel') {
      expect(cancelEntry.cancelFor).toBe(enqueueId);
    }
    // 原 message 条目仍存在
    const msgEntry = inbox.peek(sid).find((e) => e.kind === 'message');
    expect(msgEntry).toBeTruthy();
  });

  it('appendCancel 不校验 enqueueId 是否存在（design §3.4 幂等：drain 时自然丢弃）', () => {
    const sid = ulid();
    // 不存在的 enqueueId 也接受（无害，drain 时找不到配对 message 被丢弃）
    inbox.appendCancel(sid, '01NONEXISTENT');
    expect(inbox.peek(sid)).toHaveLength(1);
    expect(inbox.peek(sid)[0]!.kind).toBe('cancel');
  });

  it('drain 一次性取出 message + cancel（原子性）', () => {
    const sid = ulid();
    const m = userMsg(sid, 'a');
    const [eid] = inbox.enqueue(sid, [m]);
    inbox.appendCancel(sid, eid!);
    const drained = inbox.drain(sid);
    expect(drained).toHaveLength(2);
    // drain 后清空
    expect(inbox.peek(sid)).toHaveLength(0);
  });
});

// ============================================================
// AgentManager.cancel
// ============================================================

describe('AgentManager.cancel — 入口行为', () => {
  it('cancel 同步移除 inbox 中 message + 立即 emit enqueued_message_canceled（v0.0.13 增强）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    const config = newConfig(sid, fastStopClient());
    manager.setResolveConfig(async () => config);
    const m = agentMsg(sid, 'q');
    const [eid] = await manager.enqueue(sid, [m]);

    // 订阅事件流（cancel 应立即 emit enqueued_message_canceled）
    const events: AgentEvent[] = [];
    const iter = manager.subscribe(sid)[Symbol.asyncIterator]();
    // 先让 message_enqueued 等 replay 事件入队（bus.replayable 已含历史）
    // 再触发 cancel
    await manager.cancel(sid, eid!);

    // v0.0.13 新行为：message 被同步移除 → 立即 emit canceled
    // 验证 inbox 中已无该 message（被同步移除）
    const peeked = inbox.peek(sid);
    const msgEntry = peeked.find((e) => e.kind === 'message' && e.enqueueId === eid);
    expect(msgEntry).toBeUndefined();
    // cancel 条目也不存在（同步移除路径不追加 cancel 条目）
    const cancels = peeked.filter((e) => e.kind === 'cancel');
    expect(cancels).toHaveLength(0);

    // 收集事件断言 emit 了 enqueued_message_canceled
    const r = await Promise.race([
      iter.next(),
      new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 100)),
    ]);
    while (!('done' in r && r.done)) {
      const evt = (r as { value?: AgentEvent }).value;
      if (evt) events.push(evt);
      if (evt?.type === 'enqueued_message_canceled') break;
      const nr = await Promise.race([
        iter.next(),
        new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 100)),
      ]);
      if ('done' in nr && nr.done) break;
      const ne = (nr as { value?: AgentEvent }).value;
      if (ne) events.push(ne);
      if (ne?.type === 'enqueued_message_canceled') break;
      break;
    }
    await iter.return?.();
    const canceled = events.find((e) => e.type === 'enqueued_message_canceled');
    expect(canceled).toBeTruthy();
  });

  it('cancel 来晚（message 已被 drain）→ 不 emit、appendCancel 兜底（v0.0.13 §4.1 竞态分支）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    const config = newConfig(sid, fastStopClient());
    manager.setResolveConfig(async () => config);
    const m = agentMsg(sid, 'already-drained');
    const [eid] = await manager.enqueue(sid, [m]);

    // 先 drain 掉 inbox（模拟 message 已被消费）
    inbox.drain(sid);

    // 再 cancel（removeMessage 返 false → 走 appendCancel 兜底）
    await manager.cancel(sid, eid!);
    // 验证：appendCancel 追加了 cancel 条目（drain 时找不到配对自然丢弃）
    const peeked = inbox.peek(sid);
    const cancels = peeked.filter((e) => e.kind === 'cancel');
    expect(cancels).toHaveLength(1);
  });
});

// ============================================================
// agent_loop drain 配对作废（核心：design §3.4 / enqueue_cancel.md §4）
// ============================================================

describe('AgentLoop drain — cancel 配对作废', () => {
  it('同批 message+cancel（同 enqueueId）→ 作废 + emit enqueued_message_canceled', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    const config = newConfig(sid, fastStopClient());
    manager.setResolveConfig(async () => config);
    const m = agentMsg(sid, 'will-be-canceled');
    const [eid] = await manager.enqueue(sid, [m]);
    // 在 activate 前 enqueue cancel（保证同批 drain）
    await manager.cancel(sid, eid!);

    await manager.activate(sid);
    const events = await drainEventsUntilRunEnd(manager, sid);

    // 断言：emit 了 enqueued_message_canceled（enqueueId 匹配）
    const canceled = events.find(
      (e): e is EnqueuedMessageCanceledEvent =>
        e.type === 'enqueued_message_canceled',
    ) as EnqueuedMessageCanceledEvent | undefined;
    expect(canceled).toBeTruthy();
    expect(canceled!.enqueueId).toBe(eid);

    // 断言：未 emit enqueued_message_processed（该 message 被作废）
    const processed = events.find((e) => e.type === 'enqueued_message_processed');
    expect(processed).toBeUndefined();

    // 断言：message 未落库（cancel 作废 → 不进主 store）
    const page = await store.getMessages(sid, { limit: 50 });
    const userMsgs = page.items.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(0);
  });

  it('无 cancel 配对 → message 正常 processed（emit enqueued_message_processed + 落库）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    const config = newConfig(sid, fastStopClient());
    manager.setResolveConfig(async () => config);
    const m = agentMsg(sid, 'will-be-processed');
    const [eid] = await manager.enqueue(sid, [m]);

    await manager.activate(sid);
    const events = await drainEventsUntilRunEnd(manager, sid);

    // 断言：emit enqueued_message_processed（enqueueId 匹配）
    const processed = events.find(
      (e) => e.type === 'enqueued_message_processed' && e.enqueueId === eid,
    );
    expect(processed).toBeTruthy();

    // 断言：未 emit enqueued_message_canceled
    const canceled = events.find((e) => e.type === 'enqueued_message_canceled');
    expect(canceled).toBeUndefined();

    // 断言：message 落库（processed → 生成 messageId 写主 store）
    const page = await store.getMessages(sid, { limit: 50 });
    const userMsgs = page.items.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
  });

  it('同批发 2 条 + cancel 第 1 条 → 第 1 条作废、第 2 条 processed（design §10 AT K UT 版）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    const config = newConfig(sid, fastStopClient());
    manager.setResolveConfig(async () => config);
    const m1 = agentMsg(sid, 'first');
    const m2 = agentMsg(sid, 'second');
    const [eid1] = await manager.enqueue(sid, [m1]);
    const [_eid2] = await manager.enqueue(sid, [m2]);
    void _eid2;
    // cancel 第 1 条
    await manager.cancel(sid, eid1!);

    await manager.activate(sid);
    const events = await drainEventsUntilRunEnd(manager, sid);

    // 第 1 条：emit enqueued_message_canceled
    const canceled = events.find(
      (e): e is EnqueuedMessageCanceledEvent =>
        e.type === 'enqueued_message_canceled' && e.enqueueId === eid1,
    );
    expect(canceled).toBeTruthy();

    // 第 2 条：emit enqueued_message_processed（生成 messageId 落库）
    const processed = events.find(
      (e) => e.type === 'enqueued_message_processed' && e.enqueueId !== eid1,
    );
    expect(processed).toBeTruthy();

    // 主 store：仅第 2 条 user 消息落库
    const page = await store.getMessages(sid, { limit: 50 });
    const userMsgs = page.items.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]!.content[0]).toMatchObject({ type: 'text', text: 'second' });
  });

  it('cancel 来晚（message 已被前批 drain processed）→ cancel 丢弃，无事件', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    const config = newConfig(sid, fastStopClient());
    manager.setResolveConfig(async () => config);
    const m = agentMsg(sid, 'already-processed');
    const [eid] = await manager.enqueue(sid, [m]);

    // 先 activate 让 loop drain（message 被 processed）
    await manager.activate(sid);
    const events1 = await drainEventsUntilRunEnd(manager, sid);
    expect(events1.some((e) => e.type === 'enqueued_message_processed')).toBe(true);

    // 再 cancel（此时 message 已不在 inbox，cancel 找不到配对 → 丢弃）
    await manager.cancel(sid, eid!);
    // 短暂等待确认无新事件产生
    const events2 = await drainEventsUntilRunEnd(manager, sid, 200);
    const canceled = events2.find((e) => e.type === 'enqueued_message_canceled');
    expect(canceled).toBeUndefined();
  });
});

// ============================================================
// BUG-008 回归：source=user 消息经 enqueue 后 drain 时也要 emit enqueued_message_processed
// 否则前端 enqueue-view 为该消息建项后永不移除（spec §4.11a / chat-page _overview.md §5-2b）
// ============================================================

describe('BUG-008 回归 — source=user 经 enqueue 后 drain 配对 emit processed', () => {
  it('user 消息经 manager.enqueue + activate → emit message_start + enqueued_message_processed（按 enqueueId 配对）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    sessionTypePolicy: mockMainPolicy(),
    });
    const config = newConfig(sid, fastStopClient());
    manager.setResolveConfig(async () => config);
    const m = userMsg(sid, 'hello');
    const [eid] = await manager.enqueue(sid, [m]);

    await manager.activate(sid);
    const events = await drainEventsUntilRunEnd(manager, sid);

    // message_start 走原 user 路径（不 rewrite messageId）
    const starts = events.filter((e) => e.type === 'message_start');
    expect(starts.length).toBeGreaterThanOrEqual(1);

    // BUG-008 关键断言：必须 emit enqueued_message_processed 且 enqueueId 匹配
    const processed = events.find(
      (e) => e.type === 'enqueued_message_processed' && e.enqueueId === eid,
    );
    expect(processed).toBeTruthy();

    // 落库正常
    const page = await store.getMessages(sid, { limit: 50 });
    const userMsgs = page.items.filter((mm) => mm.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]!.content[0]).toMatchObject({ type: 'text', text: 'hello' });
  });
});
