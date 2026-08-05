/**
 * session_usage_update event 推送测试 — v0.0.44 write/notify 分离契约
 * 参考: specs/tech/agent/session/[P0]session_usage.md §3 §5 §6 §10
 *       reqs/v0.0.44.session_usage_zero/req.md（write 静默 + notify 完整 + 全量 view）
 *
 * 覆盖（v0.0.44 write/notify 分离契约验收）：
 *   (a) accumulateUsage 后 statusBus 无 session_usage_update 事件（write 静默）
 *   (b) updateContextWindowUsage 后 statusBus 无事件（write 静默）
 *   (c) notifyUsageChanged(sid) 后 emit 一次；data === getUsageView(sid)（含 contextWindowUsage）
 *   (d) accumulateUsage 递归 sub 上报 → 返回 sid 链含 [child, parent]；逐 sid notify 后
 *       两个 group 都收到自己的事件（每个 group 数据是 getUsageView 全量）
 *   (e) accumulateUsage 返回 sid 链正确性（自身 + 递归 parent，顶层最后）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ReplayableEventBus } from '../event-bus';
import { ulid } from '../../config/ulid';
import { SessionStore } from '../session-store';
import type { SessionUsageUpdateEvent } from '../session-event-types';

let tmpRoot: string;
let statusBus: ReplayableEventBus;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-usage-event-'));
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

/** 订阅 session_id:<sid> group，收集 session_usage_update 事件 */
function collectUsageEvents(sid: string): SessionUsageUpdateEvent[] {
  const out: SessionUsageUpdateEvent[] = [];
  const iter = statusBus.subscribe<SessionUsageUpdateEvent>(`session_id:${sid}`)[Symbol.asyncIterator]();
  void (async () => {
    while (true) {
      const r = await iter.next();
      if (r.done) break;
      if (r.value?.data?.type === 'session_usage_update') {
        out.push(r.value.data as SessionUsageUpdateEvent);
      }
    }
  })();
  return out;
}

/** 让事件循环跑一拍，使订阅者消费 emit 队列 */
function flushEvents(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ============================================================
// (a)(b) write 静默：accumulateUsage / updateContextWindowUsage 均不 emit
// ============================================================

describe('v0.0.44 write 静默 — accumulateUsage / updateContextWindowUsage 不 emit', () => {
  it('(a) accumulateUsage 后 bus 无 session_usage_update 事件', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const events = collectUsageEvents(sid);
    await store.accumulateUsage(sid, 'current', { total_tokens: 100, cost: 0.01 });
    await flushEvents();
    expect(events.length).toBe(0);
  });

  it('(a) 多次 accumulateUsage 全部静默（write 完不 emit）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const events = collectUsageEvents(sid);
    await store.accumulateUsage(sid, 'current', { total_tokens: 100 });
    await store.accumulateUsage(sid, 'current', { total_tokens: 50 });
    await store.accumulateUsage(sid, 'forked', { total_tokens: 30 });
    await flushEvents();
    expect(events.length).toBe(0);
  });

  it('(b) updateContextWindowUsage 后 bus 无事件', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const events = collectUsageEvents(sid);
    const cw = {
      systemTokens: 100,
      messageTokens: 700,
      toolTokens: 200,
      totalTokens: 1000,
      maxOutputTokens: 20000,
      tokenLimit: 8000,
      remainingTokens: 8000 - 1000 - 20000,
    };
    await store.updateContextWindowUsage(sid, cw);
    await flushEvents();
    expect(events.length).toBe(0);
  });
});

// ============================================================
// (c) notifyUsageChanged 后 emit 一次；data == getUsageView(sid)
// ============================================================

describe('v0.0.44 notifyUsageChanged — emit 全量 view（与 getUsageView 同权威源）', () => {
  it('(c) notifyUsageChanged 后 emit 一次；data 与 getUsageView(sid) 深度相等', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    // 先 write 一堆状态：accumulate current + forked + updateContextWindowUsage
    await store.accumulateUsage(sid, 'current', {
      input_cache_read: 80,
      input_total_tokens: 200,
      total_tokens: 250,
      cost: 0.02,
      inputCharCount: 1000,
    });
    await store.accumulateUsage(sid, 'forked', { total_tokens: 30 });
    const cw = {
      systemTokens: 100,
      messageTokens: 700,
      toolTokens: 200,
      totalTokens: 1000,
      maxOutputTokens: 20000,
      tokenLimit: 200000,
      remainingTokens: 200000 - 1000 - 20000,
    };
    await store.updateContextWindowUsage(sid, cw);

    const events = collectUsageEvents(sid);
    // notify 一次
    await store.notifyUsageChanged(sid);
    await flushEvents();

    expect(events.length).toBe(1);
    const evt = events[0]!;
    expect(evt.type).toBe('session_usage_update');
    expect(evt.sessionId).toBe(sid);

    // data 与当时 getUsageView(sid) 深度相等（同一权威源，与 GET /session/:id/usage 形状一致）
    const view = await store.getUsageView(sid);
    expect(evt.data).toEqual(view);
    // 明确检查关键字段
    expect(evt.data.contextWindowUsage).toEqual(cw);
    expect(evt.data.current.input_cache_read).toBe(80);
    expect(evt.data.current.total_tokens).toBe(250);
    expect(evt.data.forked.total_tokens).toBe(30);
    expect(evt.data.total.total_tokens).toBe(280);
  });

  it('(c) notifyUsageChanged 每次调用都 emit 一次（幂等；每次读的都是最新态）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const events = collectUsageEvents(sid);
    await store.accumulateUsage(sid, 'current', { total_tokens: 100 });
    await store.notifyUsageChanged(sid);
    await store.accumulateUsage(sid, 'current', { total_tokens: 50 });
    await store.notifyUsageChanged(sid);
    await flushEvents();
    expect(events.length).toBe(2);
    // 第二次事件反映累计
    expect(events[0]!.data.current.total_tokens).toBe(100);
    expect(events[1]!.data.current.total_tokens).toBe(150);
  });

  it('(c) session 不存在 → notifyUsageChanged 静默 no-op（不抛错、不 emit）', async () => {
    const sid = ulid(); // 未 createSession
    const events = collectUsageEvents(sid);
    await store.notifyUsageChanged(sid);
    await flushEvents();
    expect(events.length).toBe(0);
  });
});

// ============================================================
// (d)(e) accumulateUsage 返回 sid 链 + 递归 sub 上报
// ============================================================

describe('v0.0.44 accumulateUsage 返回 sid 链 + 递归 sub 上报', () => {
  it('(e) 顶层 session（无 parent）→ 链 = [self]', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const chain = await store.accumulateUsage(sid, 'current', { total_tokens: 100 });
    expect(chain).toEqual([sid]);
  });

  it('(d)(e) 子 session accumulate → 链 = [child, parent]（顶层最后）；逐链 notify 两 group 都收', async () => {
    const parent = ulid();
    const child = ulid();
    await store.createSession({ id: parent });
    await store.createSession({ id: child, parentSessionId: parent });

    const parentEvents = collectUsageEvents(parent);
    const childEvents = collectUsageEvents(child);

    const chain = await store.accumulateUsage(child, 'current', { total_tokens: 200 });
    // 链首=child，链末=parent（顶层）
    expect(chain).toEqual([child, parent]);

    // 逐链 notify（模拟 lifecycle onUsage 的调用模式）
    for (const s of chain) {
      await store.notifyUsageChanged(s);
    }
    await flushEvents();

    // child group 收到 1 个事件（自身 view：current 累计）
    expect(childEvents.length).toBe(1);
    expect(childEvents[0]!.data.current.total_tokens).toBe(200);
    expect(childEvents[0]!.data.sub.total_tokens).toBeUndefined();

    // parent group 收到 1 个事件（自身 view：sub 累计——child 递归上报）
    expect(parentEvents.length).toBe(1);
    expect(parentEvents[0]!.data.sub.total_tokens).toBe(200);
    expect(parentEvents[0]!.data.sub.llmCallCount).toBe(1);
    expect(parentEvents[0]!.data.current.total_tokens).toBeUndefined();
  });

  it('(e) 三层嵌套（grandparent ← parent ← child）→ 链 = [child, parent, grandparent]', async () => {
    const gp = ulid();
    const p = ulid();
    const c = ulid();
    await store.createSession({ id: gp });
    await store.createSession({ id: p, parentSessionId: gp });
    await store.createSession({ id: c, parentSessionId: p });

    const chain = await store.accumulateUsage(c, 'current', { total_tokens: 300 });
    expect(chain).toEqual([c, p, gp]);

    // 每层 usage view 都能派生（sub 一路递归上报）
    const gpView = await store.getUsageView(gp);
    const pView = await store.getUsageView(p);
    const cView = await store.getUsageView(c);
    expect(cView.current.total_tokens).toBe(300);
    expect(pView.sub.total_tokens).toBe(300);
    expect(gpView.sub.total_tokens).toBe(300);
  });

  it('(e) session 不存在 accumulate → 链 = [] 空（容错静默）', async () => {
    const sid = ulid(); // 未 createSession
    const chain = await store.accumulateUsage(sid, 'current', { total_tokens: 100 });
    expect(chain).toEqual([]);
  });
});
