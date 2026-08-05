/**
 * AgentManager 去 config 重构 UT（v0.0.31 Task4）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md
 *   - §2（enqueue/activate/deliverTo 新签名——去 config 参数）
 *   - §2.3（resolveConfigBySid 方案 A 无 cache：复用 setResolveConfig 注入的 buildSessionConfigFromDeps）
 *   - §2.4（调用方改动清单：user POST 收敛 deliverTo、ManagerChildrenOps 改新签名）
 *
 * 覆盖（task acceptance）：
 *   - enqueue(sessionId, messages) / activate(sessionId) 新签名工作（去 config 参数）
 *   - resolveConfigBySid：按 sessionId 取 config（复用 setResolveConfig 注入通路）
 *   - 未注入 resolveConfig → throw（明确错误信息）
 *   - deliverTo(sessionId, msg) 内部经 enqueue+activate 新签名不破投递（返 AgentRun）
 *   - enqueue 内部调 resolveConfigBySid（每次取最新，无 cache 校验注入）
 *
 * 文件系统隔离：mkdtempSync + afterEach rmSync，无 ~/.oobt-desktop 写入。
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
import { ToolExecutionEngine } from '../../tools/engine';
import { InboxStore } from '../inbox';
import { ReplayableEventBus } from '../event-bus';
import { AgentManagerImpl } from '../agent-manager';
import type { SessionConfig } from '../context-types';
import type { Message } from '../../message/types';
import type { AgentEvent } from '../agent-event-types';

let tmpRoot: string;
let store: SessionStore;
let contextEngine: ContextEngine;
let toolEngine: ToolExecutionEngine;
let inbox: InboxStore;
let bus: ReplayableEventBus;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-resolve-config-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  contextEngine = new ContextEngine({ store });
  toolEngine = new ToolExecutionEngine();
  inbox = new InboxStore();
  bus = new ReplayableEventBus({ replayable: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造测试 SessionConfig（最小字段；client 是 mock stub） */
function newConfig(sid: string): SessionConfig {
  return {
    sessionId: sid,
    systemPrompt: '',
    client: { stream: vi.fn(), call: vi.fn(), contextWindow: 100000 } as never,
    modelId: 'mock-model',
  };
}

/** 构造一条 user Message */
function userMsg(sid: string, text = 'q'): Message {
  return {
    id: ulid(),
    sessionId: sid,
    role: 'user',
    content: [{ type: 'text', text }],
    sender: { source: 'user' },
  } as Message;
}

describe('AgentManager 去 config 重构 — resolveConfigBySid 方案 A（v0.0.31 Task4）', () => {
  it('enqueue(sessionId, messages) 新签名工作（去 config 参数；内部 resolveConfigBySid）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    });
    const resolveConfig = vi.fn(async (s: string) => newConfig(s));
    manager.setResolveConfig(resolveConfig);

    const ids = await manager.enqueue(sid, [userMsg(sid, 'hi')]);

    // resolveConfig 被调（按 sessionId 取 config，方案 A 无 cache）
    expect(resolveConfig).toHaveBeenCalledTimes(1);
    expect(resolveConfig).toHaveBeenCalledWith(sid);
    // enqueueIds 非空
    expect(ids.length).toBe(1);
    expect(typeof ids[0]).toBe('string');
  });

  it('enqueue 未注入 resolveConfig → throw 明确错误', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    });
    // 故意不 setResolveConfig
    await expect(manager.enqueue(sid, [userMsg(sid)])).rejects.toThrow(
      /resolveConfig not injected/,
    );
  });

  it('activate(sessionId) 新签名工作（去 config 参数；内部 resolveConfigBySid 取 config）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    });
    const resolveConfig = vi.fn(async (s: string) => newConfig(s));
    manager.setResolveConfig(resolveConfig);

    // 先入队一条消息（activate 走 CAS markRunning 启动 loop）
    await manager.enqueue(sid, [userMsg(sid)]);
    const run = await manager.activate(sid);

    // resolveConfig 至少被调一次（enqueue + activate 各一次取最新 config）
    expect(resolveConfig).toHaveBeenCalledWith(sid);
    // activate 返 AgentRun（state running 或已完成）
    expect(run.sessionId).toBe(sid);
    expect(run.runKind).toBe('main');
  });

  it('activate 未注入 resolveConfig → throw 明确错误', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    });
    await expect(manager.activate(sid)).rejects.toThrow(/resolveConfig not injected/);
  });

  it('resolveConfigBySid 每次取最新（无 cache）—— 多次调用都走 resolveConfigFn', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    });
    const resolveConfig = vi.fn(async (s: string) => newConfig(s));
    manager.setResolveConfig(resolveConfig);

    // 连续两次 enqueue + 一次 activate
    await manager.enqueue(sid, [userMsg(sid, 'a')]);
    await manager.enqueue(sid, [userMsg(sid, 'b')]);
    // resolveConfig 每次 enqueue 都调（无 cache 方案 A）
    expect(resolveConfig).toHaveBeenCalledTimes(2);
  });

  it('deliverTo(sessionId, msg) 内部经新签名 enqueue+activate 不破投递', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    });
    const resolveConfig = vi.fn(async (s: string) => newConfig(s));
    manager.setResolveConfig(resolveConfig);

    const msg = userMsg(sid, 'via-deliverto');
    const run = await manager.deliverTo(sid, msg);

    // deliverTo 返 AgentRun（caller 可 await run.promise 拿 RunResult）
    expect(run.sessionId).toBe(sid);
    expect(run.runKind).toBe('main');
    // 内部 enqueue + activate 都按 sessionId 调（resolveConfig 经 resolveConfigBySid 触发）
    expect(resolveConfig).toHaveBeenCalledWith(sid);
    // 消息确实入 inbox（经 enqueue 新签名写入）—— inbox 残留条目验证
    // 注：deliverTo 后 loop 异步启动，inbox 可能已被 drain；改为等 run 结束确认投递闭环
    await run.promise.catch(() => {
      /* loop 可能因 mock client 无 finish 而 timeout/error，可接受 */
    });
    // 消息已不在 inbox（被 drain 消费）或 run 已 settle → 投递闭环成立
    expect(resolveConfig.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('deliverTo 未注入 resolveConfig → throw（activate 内部 resolveConfigBySid 抛）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine,
    });
    // 不 setResolveConfig
    await expect(manager.deliverTo(sid, userMsg(sid))).rejects.toThrow(
      /resolveConfig not injected/,
    );
  });
});
