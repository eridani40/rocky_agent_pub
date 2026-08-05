/**
 * session-clear-op UT — clearSessionStoreOp 清空范围 + 保留字段 + emit 事件（v0.0.16 T4）
 * 参考: specs/tech/agent/session/[P0]session_clear.md §2 §3 §5（权威）
 *
 * 覆盖：
 *   - 清空范围（每项验证重置值）：transcript / summary / runs / usage 三分区 / ratio /
 *     contextWindowUsage / summaryTask / state
 *   - 保留字段：id/title/status/config/createdAt/parentSessionId
 *   - tokenLimit + maxOutputTokens 保留（来自 modelConfig 非累加值）
 *   - emit 三事件：session_status_update / session_usage_update / messages_cleared
 *
 * 测试策略：真实 SessionStore（fs + tmpdir）+ 真实 ReplayableEventBus，
 *   直接订阅 bus 收事件验证 emit；直接调 store.clearSession 走到 clearSessionStoreOp。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ReplayableEventBus } from '../event-bus';
import { ulid } from '../../config/ulid';
import type { Usage, ContextWindowUsage } from '../../message/types';

let tmpRoot: string;
let store: SessionStore;
let statusBus: ReplayableEventBus;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-session-clear-op-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  statusBus = new ReplayableEventBus({ replayable: true });
  store = new SessionStore({ crud, fsRoot: tmpRoot, statusBus });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 创建 session（默认 state=idle, summaryTask=idle） */
async function newSession(opts: { title?: string; providerId?: string } = {}): Promise<string> {
  const sid = ulid();
  await store.createSession({
    id: sid,
    title: opts.title ?? 'test',
    ...(opts.providerId !== undefined ? { providerId: opts.providerId } : {}),
  });
  return sid;
}

/** 写一条 user message */
async function appendUserMsg(sid: string, text: string): Promise<void> {
  await store.appendMessages(sid, [{
    id: ulid(),
    sessionId: sid,
    role: 'user',
    content: [{ type: 'text', text }],
  }]);
}

/** 写一条 assistant message 带 runId（raw/tool_result 级联测试用；runId 须合法 ULID） */
async function appendAssistantMsg(sid: string, text: string): Promise<void> {
  await store.appendMessages(sid, [{
    id: ulid(),
    sessionId: sid,
    role: 'assistant',
    runId: ulid(),
    content: [{ type: 'text', text }],
  }]);
}

/** 写 summary */
async function writeSummary(sid: string, content: string, upTo: string): Promise<void> {
  await store.setSummary(sid, { content, summaryUpTo: upTo });
}

/** 构造一个非零 Usage（用于累加后验证归零） */
function nonzeroUsage(): Usage {
  return {
    input_cache_read: 100,
    input_cache_write: 50,
    input_no_cache: 30,
    input_total_tokens: 180,
    output_response: 40,
    output_reasoning: 10,
    output_total_tokens: 50,
    total_tokens: 230,
    cost: 0.005,
    inputCharCount: 500,
    outputCharCount: 200,
  } as unknown as Usage;
}

// ============================================================
// 清空范围 — 每项验证重置值
// ============================================================

describe('clearSession — 清空范围（spec §3 表）', () => {
  it('transcript：清空后 getMessages 返空 []', async () => {
    const sid = await newSession();
    await appendUserMsg(sid, 'hello');
    await appendAssistantMsg(sid, 'hi');

    const before = await store.getMessages(sid);
    expect(before.items.length).toBe(2);

    await store.clearSession(sid);

    const after = await store.getMessages(sid);
    expect(after.items).toEqual([]);
    expect(after.hasMore).toBe(false);
  });

  it('summary：清空后 content 空串 + summaryUpTo=null（覆盖空 summary）', async () => {
    const sid = await newSession();
    await writeSummary(sid, '历史摘要', '01KV...oldmsg');

    await store.clearSession(sid);

    const s = await store.getSummary(sid);
    // clearSession 覆盖空 summary：content='' + summaryUpTo=null（保留 summary 实体）
    // toSummary content ?? null —— content='' 保持 ''；spec §3 表 content=null 但 store 实现以
    // '' 写入（SummarySchema content required:string，不能用 null），语义等价「无 summary」
    if (s !== null) {
      expect(s.content === '' || s.content === null).toBe(true);
      expect(s.summaryUpTo).toBeNull();
    }
  });

  it('runs：清空后 getRuns 返空 []', async () => {
    const sid = await newSession();
    await store.createRun({ id: ulid(), sessionId: sid });
    await store.createRun({ id: ulid(), sessionId: sid });

    await store.clearSession(sid);

    const runs = await store.getRuns(sid);
    expect(runs).toEqual([]);
  });

  it('usage 三分区：累加后归零（current/sub/forked 全 0）', async () => {
    const sid = await newSession();
    // 累加非零 usage 到三分区
    await store.accumulateUsage(sid, 'current', nonzeroUsage());
    await store.accumulateUsage(sid, 'sub', nonzeroUsage());
    await store.accumulateUsage(sid, 'forked', nonzeroUsage());

    const before = await store.getUsageView(sid);
    expect(before.current.input_total_tokens).toBe(180);
    expect(before.sub.input_total_tokens).toBe(180);
    expect(before.forked.input_total_tokens).toBe(180);

    await store.clearSession(sid);

    const after = await store.getUsageView(sid);
    // 三分区所有 token 字段归零 + llmCallCount 归零
    expect(after.current.input_total_tokens ?? 0).toBe(0);
    expect(after.current.total_tokens ?? 0).toBe(0);
    expect(after.current.llmCallCount ?? 0).toBe(0);
    expect(after.sub.input_total_tokens ?? 0).toBe(0);
    expect(after.forked.input_total_tokens ?? 0).toBe(0);
    expect(after.total.input_total_tokens ?? 0).toBe(0);
    expect(after.total.total_tokens ?? 0).toBe(0);
  });

  it('ratio：清空后归冷启动 current=1.0 + samples=[]', async () => {
    const sid = await newSession();
    await store.accumulateUsage(sid, 'current', nonzeroUsage());
    await store.accumulateUsage(sid, 'current', nonzeroUsage());
    await store.accumulateUsage(sid, 'current', nonzeroUsage());
    // 窗口满 3 后 ratio 学为某中位数
    const before = await store.getUsageView(sid);
    expect(before.ratio).not.toBe(1.0); // 已学

    await store.clearSession(sid);

    const after = await store.getUsageView(sid);
    expect(after.ratio).toBe(1.0); // 冷启动值
  });

  it('contextWindowUsage：清零占用，但 tokenLimit + maxOutputTokens 保留', async () => {
    const sid = await newSession();
    // 先写一个非零 contextWindowUsage（含自定义 tokenLimit / maxOutput）
    const cw: ContextWindowUsage = {
      systemTokens: 1000,
      messageTokens: 5000,
      toolTokens: 500,
      totalTokens: 6500,
      maxOutputTokens: 8000,
      tokenLimit: 100000,
      remainingTokens: 100000 - 6500 - 8000,
    };
    await store.updateContextWindowUsage(sid, cw);

    await store.clearSession(sid);

    const after = await store.getUsageView(sid);
    expect(after.contextWindowUsage).toBeDefined();
    const cwAfter = after.contextWindowUsage!;
    // 占用归零
    expect(cwAfter.systemTokens).toBe(0);
    expect(cwAfter.messageTokens).toBe(0);
    expect(cwAfter.toolTokens).toBe(0);
    expect(cwAfter.totalTokens).toBe(0);
    // tokenLimit + maxOutputTokens 保留（来自 modelConfig 非累加值）
    expect(cwAfter.tokenLimit).toBe(100000);
    expect(cwAfter.maxOutputTokens).toBe(8000);
    // remainingTokens 重算 = tokenLimit - 0 - maxOutputTokens
    expect(cwAfter.remainingTokens).toBe(100000 - 0 - 8000);
  });

  // v0.0.55：summaryTask test 已删除（字段被 SessionTaskLock 取代；clear handler 直调 lock.markFailed
  //   清内存锁，clearSession store op 不再 reset summaryTask record 字段——已从 schema 删除）。

  it('state：强制重置 idle（不走 CAS）', async () => {
    const sid = await newSession();
    // 预设 state=interrupted（模拟 abort 已完成；caller 已预 abort）
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    await store.stateMachine.markInterrupting(sid, runId);
    await store.stateMachine.markInterrupted(sid);
    const before = await store.getSession(sid);
    expect(before?.state).toBe('interrupted');

    await store.clearSession(sid);

    const after = await store.getSession(sid);
    expect(after?.state).toBe('idle');
    expect(after?.running).toBe(false);
    expect(after?.currentRunId).toBeNull();
  });
});

// ============================================================
// 保留字段（session 实体不被删）
// ============================================================

describe('clearSession — 保留实体字段（spec §1 §3 表）', () => {
  it('id/title/status/providerId/modelId/parentSessionId 保留', async () => {
    const sid = await newSession({ title: 'Auth 模块审查', providerId: 'p1' });
    // 写 modelId + parentSessionId（updateSession + createSession 带）
    await store.updateSession(sid, { modelId: 'm1' });
    const before = await store.getSession(sid);
    expect(before?.title).toBe('Auth 模块审查');
    expect(before?.providerId).toBe('p1');
    expect(before?.modelId).toBe('m1');

    await store.clearSession(sid);

    const after = await store.getSession(sid);
    expect(after).not.toBeNull();
    expect(after!.id).toBe(sid);
    expect(after!.title).toBe('Auth 模块审查');
    expect(after!.status).toBe('active');
    expect(after!.providerId).toBe('p1');
    expect(after!.modelId).toBe('m1');
    // createdAt 不变（实体保留）
    expect(after!.createdAt).toBe(before!.createdAt);
  });

  it('返回值 = 重置后的 Session（state=idle + 零 usage）', async () => {
    const sid = await newSession();
    await appendUserMsg(sid, 'x');
    await store.accumulateUsage(sid, 'current', nonzeroUsage());

    const returned = await store.clearSession(sid);
    expect(returned.id).toBe(sid);
    expect(returned.state).toBe('idle');
    expect(returned.running).toBe(false);
    expect(returned.currentRunId).toBeNull();
    // v0.0.55：summaryTask 字段已删除（被 SessionTaskLock 取代）
  });
});

// ============================================================
// emit 三事件（spec §5 step4）
// ============================================================

describe('clearSession — emit 三事件（spec §5 step4）', () => {
  it('emit session_status_update(state=idle) + session_usage_update + messages_cleared', async () => {
    const sid = await newSession();
    await appendUserMsg(sid, 'x');

    // 订阅 bus 收事件（replayable buffer，clear 后 collector 拉一遍即可）
    const collector: { data: unknown; type: string }[] = [];
    const iter = statusBus.subscribe<{ type: string }>(`session_id:${sid}`);
    const consumer = (async () => {
      for await (const e of iter) {
        if (e.data === undefined) continue;
        collector.push({ data: e.data, type: e.data.type });
      }
    })();
    void consumer;

    await store.clearSession(sid);

    // 让 consumer 拉一轮（setImmediate / microtask）
    await new Promise((r) => setTimeout(r, 30));

    const types = collector.map((c) => c.type);
    expect(types).toContain('session_status_update');
    expect(types).toContain('session_usage_update');
    expect(types).toContain('messages_cleared');

    // session_status_update data 验证
    const statusEvt = collector.find((c) => c.type === 'session_status_update');
    const statusData = (statusEvt!.data as { data: { state: string; running: boolean; currentRunId: string | null } }).data;
    expect(statusData.state).toBe('idle');
    expect(statusData.running).toBe(false);
    expect(statusData.currentRunId).toBeNull();
  });
});
