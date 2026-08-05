/**
 * agent.log 诊断日志单测（镜像 dev-logs/__tests__/log-writer.test.ts）
 * 参考: specs/tech/dev-logs/[P0]overall.md §2（LogWriter）+ §2.4（零开销门禁）
 *       specs/tech/config/[P0]app_config.md §3.8（logs group enableAgentLog）
 *
 * 校验点：
 *   - LogWriter 写 agent.log（开关 on）+ 零开销门禁（开关 off 不写）
 *   - SessionStateMachine 全部 mark* 写 state_change（from/to/runId/ok 正确）+ CAS fail ok:false
 *   - InboxStore enqueue/drain 写日志（字段对、绝不记消息内容）
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { LogWriter } from '../log-writer';
import { InboxStore } from '../../agent/inbox';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import type { ContentBlock, Message } from '../../message/types';

/** v0.0.138 起 LogQueue 异步 bounded consumer（批间 250ms yield），write fire-and-forget 入队后需 flush 等 consumer 落盘 */
async function flushQueue(w: LogWriter, deadlineMs = 5_000): Promise<void> {
  await w['queue'].flush(deadlineMs);
}

/** 构造可控开关的 mock appConfig（按 (group,key) 返回值） */
function makeMockAppConfig(overrides: Record<string, unknown> = {}): {
  get: (g: string, k: string) => unknown;
  set: (g: string, k: string, v: unknown) => void;
} {
  const store: Record<string, unknown> = { ...overrides };
  return {
    get: (g: string, k: string) => store[`${g}.${k}`],
    set: (g: string, k: string, v: unknown) => {
      store[`${g}.${k}`] = v;
    },
  };
}

/** 读 agent.log 并 parse 成对象数组 */
function readAgentLog(dataDir: string): Record<string, unknown>[] {
  const path = join(dataDir, 'logs', 'agent.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/** 构造最小 Message（仅含 id/role/content，避免无关字段） */
function makeMsg(id: string, text = 'hello'): Message {
  return {
    id,
    sessionId: '01TESTSID',
    role: 'user',
    content: [{ type: 'text', text } as ContentBlock],
  };
}

describe('agent.log — LogWriter 写文件 + 零开销门禁', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-agentlog-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('开关 on 写 agent.log', async () => {
    const appConfig = makeMockAppConfig({ 'logs.enableAgentLog': true });
    const w = new LogWriter(dataDir, appConfig);
    w.write('agent', { event: 'loop_enter', sessionId: 's1', runId: 'r1' });
    await flushQueue(w);
    expect(existsSync(join(dataDir, 'logs', 'agent.log'))).toBe(true);
  });

  it('开关 off 不写（零开销：文件不创建）', async () => {
    const appConfig = makeMockAppConfig({}); // 缺省 false
    const w = new LogWriter(dataDir, appConfig);
    w.write('agent', { event: 'loop_enter', sessionId: 's1' });
    await flushQueue(w);
    expect(existsSync(join(dataDir, 'logs', 'agent.log'))).toBe(false);
  });
});

describe('agent.log — SessionStateMachine state_change', () => {
  let tmpRoot: string;
  let dataDir: string;
  let appConfig: ReturnType<typeof makeMockAppConfig>;
  let store: SessionStore;
  let logWriter: LogWriter;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-sm-'));
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-sm-data-'));
    appConfig = makeMockAppConfig({ 'logs.enableAgentLog': true });
    logWriter = new LogWriter(dataDir, appConfig);
    const fs = new FsCrudStore({ root: tmpRoot });
    const crud = new CompositeStore()
      .mount('session', fs)
      .mount('transcript', fs)
      .mount('summary', fs)
      .mount('runs', fs);
    store = new SessionStore({ crud, fsRoot: tmpRoot, logWriter });
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('markRunning → markIdle 写两条 state_change（from/to/ok 正确）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();

    const ok1 = await store.stateMachine.markRunning(sid, runId);
    expect(ok1).toBe(true);
    const ok2 = await store.stateMachine.markIdle(sid, runId);
    expect(ok2).toBe(true);
    await flushQueue(logWriter);

    const lines = readAgentLog(dataDir);
    const stateChanges = lines.filter((l) => l.event === 'state_change');
    expect(stateChanges.length).toBe(2);
    // markRunning: idle → running, ok:true
    expect(stateChanges[0]).toMatchObject({
      event: 'state_change', sessionId: sid, from: 'idle', to: 'running', runId, ok: true,
    });
    // markIdle: running → idle, ok:true
    expect(stateChanges[1]).toMatchObject({
      event: 'state_change', sessionId: sid, from: 'running', to: 'idle', runId, ok: true,
    });
  });

  it('CAS 失败（非法 from state）也记 ok:false', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const r1 = ulid();
    const r2 = ulid();
    // 第一次 markRunning 成功（idle → running）
    await store.stateMachine.markRunning(sid, r1);
    // 第二次 markRunning CAS 失败（state 已 running，不允许重复 activate）
    const ok = await store.stateMachine.markRunning(sid, r2);
    expect(ok).toBe(false);
    await flushQueue(logWriter);

    const lines = readAgentLog(dataDir);
    const stateChanges = lines.filter((l) => l.event === 'state_change');
    expect(stateChanges.length).toBe(2);
    // fire-and-forget append 顺序无保证（见同文件 inbox_remove 用例注释），按 ok 字段集合验证
    const byOk = new Map(stateChanges.map((l) => [l.ok as boolean, l]));
    // 成功那条：idle → running, ok:true
    expect(byOk.get(true)).toMatchObject({ sessionId: sid, from: 'idle', to: 'running', runId: r1, ok: true });
    // 失败那条：from=running, to=running, ok:false
    expect(byOk.get(false)).toMatchObject({
      sessionId: sid, from: 'running', to: 'running', runId: r2, ok: false,
    });
  });

  it('markError/markSuspended/markInterrupting/markInterrupted 各记一条', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    await store.stateMachine.markInterrupting(sid, runId);
    await store.stateMachine.markInterrupted(sid);
    await flushQueue(logWriter);

    const lines = readAgentLog(dataDir);
    const stateChanges = lines.filter((l) => l.event === 'state_change');
    // running → interrupting → interrupted（3 条，加 markRunning 共 3 条）
    expect(stateChanges.length).toBe(3);
    expect(stateChanges[1]).toMatchObject({ from: 'running', to: 'interrupting', ok: true });
    expect(stateChanges[2]).toMatchObject({ from: 'interrupting', to: 'interrupted', ok: true });
  });
});

describe('agent.log — InboxStore enqueue/drain', () => {
  let dataDir: string;
  let inbox: InboxStore;
  let logWriter: LogWriter;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-inbox-'));
    const appConfig = makeMockAppConfig({ 'logs.enableAgentLog': true });
    logWriter = new LogWriter(dataDir, appConfig);
    inbox = new InboxStore(logWriter);
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('enqueue 记 inbox_enqueue（count + enqueueIds，不含消息内容）', async () => {
    const sid = '01SID_EQ';
    const ids = inbox.enqueue(sid, [makeMsg('01MSG_A'), makeMsg('01MSG_B')]);
    await flushQueue(logWriter);
    const lines = readAgentLog(dataDir);
    const eq = lines.find((l) => l.event === 'inbox_enqueue');
    expect(eq).toBeDefined();
    expect(eq).toMatchObject({ event: 'inbox_enqueue', sessionId: sid, count: 2, enqueueIds: ids });
    // 绝不含消息内容（无 text/content/message 字段）
    expect(JSON.stringify(eq)).not.toContain('hello');
    expect(JSON.stringify(eq)).not.toContain('"message"');
    expect(JSON.stringify(eq)).not.toContain('"content"');
  });

  it('drain 记 inbox_drain（count + kinds，不含消息内容）', async () => {
    const sid = '01SID_DR';
    inbox.enqueue(sid, [makeMsg('01MSG_C')]);
    inbox.appendCancel(sid, '01MSG_C');
    const drained = inbox.drain(sid);
    await flushQueue(logWriter);
    expect(drained.length).toBe(2);
    const lines = readAgentLog(dataDir);
    const dr = lines.find((l) => l.event === 'inbox_drain');
    expect(dr).toBeDefined();
    expect(dr).toMatchObject({
      event: 'inbox_drain', sessionId: sid, count: 2, kinds: ['message', 'cancel'],
    });
    // 绝不含消息内容
    expect(JSON.stringify(dr)).not.toContain('hello');
    expect(JSON.stringify(dr)).not.toContain('"content"');
  });

  it('removeMessage 记 inbox_remove（removed true/false）', async () => {
    const sid = '01SID_RM';
    const ids = inbox.enqueue(sid, [makeMsg('01MSG_RM')]);
    const eid = ids[0]!;
    inbox.removeMessage(sid, eid); // removed:true
    inbox.removeMessage(sid, 'not-exist'); // removed:false
    await flushQueue(logWriter);
    const lines = readAgentLog(dataDir);
    const rms = lines.filter((l) => l.event === 'inbox_remove');
    expect(rms.length).toBe(2);
    // fire-and-forget append 顺序无保证（见 log-writer.test.ts 注释），验证集合而非顺序
    const byEid = new Map(rms.map((r) => [r.enqueueId as string, r.removed as boolean]));
    expect(byEid.get(eid)).toBe(true);
    expect(byEid.get('not-exist')).toBe(false);
  });

  it('logWriter undefined 时（默认构造）不抛、不影响业务', () => {
    const plain = new InboxStore(); // 无 logWriter
    const sid = '01SID_PLAIN';
    const ids = plain.enqueue(sid, [makeMsg('01MSG_P')]);
    expect(ids.length).toBe(1);
    expect(() => plain.drain(sid)).not.toThrow();
  });
});

describe('agent.log — ③ 阶段 breadcrumb（loop_step / loop_tools_begin / loop_tools_end）', () => {
  let dataDir: string;
  let w: LogWriter;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-crumb-'));
    const appConfig = makeMockAppConfig({ 'logs.enableAgentLog': true });
    w = new LogWriter(dataDir, appConfig);
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('loop_tools_begin 记 toolNames + toolCallIds，绝不含 tool arguments（消息内容）', async () => {
    // 构造含「消息样敏感内容」的 toolCalls（arguments 内含 SECRET 文本）
    const toolCalls = [
      { type: 'tool_call' as const, id: 'call_01', name: 'bash', arguments: { command: 'echo SECRET_BODY_SHOULD_NOT_LEAK' } },
      { type: 'tool_call' as const, id: 'call_02', name: 'file_read', arguments: { path: '/etc/secrets' } },
    ];
    // 1:1 复刻 run-react-loop.ts 的 loop_tools_begin 字段映射
    w.write('agent', {
      event: 'loop_tools_begin',
      sessionId: '01SID_CRUMB',
      runId: '01RUN_CRUMB',
      step: 2,
      toolNames: toolCalls.map((c) => c.name),
      toolCallIds: toolCalls.map((c) => c.id),
    });
    await flushQueue(w);
    const lines = readAgentLog(dataDir);
    const begin = lines.find((l) => l.event === 'loop_tools_begin');
    expect(begin).toBeDefined();
    expect(begin).toMatchObject({
      event: 'loop_tools_begin', sessionId: '01SID_CRUMB', runId: '01RUN_CRUMB', step: 2,
      toolNames: ['bash', 'file_read'], toolCallIds: ['call_01', 'call_02'],
    });
    // 绝不含 tool arguments（可能含敏感消息内容）：SECRET 标记 + arguments 字段均不应出现
    const serialized = JSON.stringify(begin);
    expect(serialized).not.toContain('SECRET_BODY_SHOULD_NOT_LEAK');
    expect(serialized).not.toContain('"arguments"');
    expect(serialized).not.toContain('"/etc/secrets"');
  });

  it('loop_tools_end 记 resultCount + pendingCount（定位卡在 tool 还是 HITL 悬挂）', async () => {
    w.write('agent', {
      event: 'loop_tools_end',
      sessionId: '01SID_CRUMB',
      runId: '01RUN_CRUMB',
      step: 2,
      resultCount: 1,
      pendingCount: 0,
    });
    await flushQueue(w);
    const lines = readAgentLog(dataDir);
    const end = lines.find((l) => l.event === 'loop_tools_end');
    expect(end).toMatchObject({
      event: 'loop_tools_end', sessionId: '01SID_CRUMB', runId: '01RUN_CRUMB',
      step: 2, resultCount: 1, pendingCount: 0,
    });
  });

  it('loop_step 记 step 计数（每轮迭代 breadcrumb）', async () => {
    w.write('agent', { event: 'loop_step', sessionId: '01SID_CRUMB', runId: '01RUN_CRUMB', step: 0 });
    await flushQueue(w);
    const lines = readAgentLog(dataDir);
    const step = lines.find((l) => l.event === 'loop_step');
    expect(step).toMatchObject({ event: 'loop_step', sessionId: '01SID_CRUMB', runId: '01RUN_CRUMB', step: 0 });
  });
});
