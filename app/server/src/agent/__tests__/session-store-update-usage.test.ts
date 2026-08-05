/**
 * SessionStore.updateUsage — 写+推一体统一接口 UT
 * 参考: specs/tech/agent/session/[P0]session_usage.md §3 §6
 *
 * 不变量：
 *   1. updateUsage({contextWindowUsage}) → cw 写入 + emit 一次（推全量含最新 cw + 最新累计）
 *   2. updateUsage({usagePartition, usage}) → 累计写入 + emit 一次（推全量含最新累计 + 最新 cw）
 *   3. 「改 A 时 B 显示最新」：改 cw 后推的 view 里累计分区是 store 最新值（非旧值）；
 *      改累计后推的 view 里 cw 是 store 最新值
 *   4. 递归 sub 上报 parent：parent 链每个 sid 都被 notify（各自 group 收到自己 view）
 *   5. 两字段同传 → 只 emit 一次（同 sid 不重复推）
 *   6. 失败隔离：notify 失败不翻 write、不抛错
 *   7. 空 opts → 零写零推；session 不存在（仅累计）→ 静默零推
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
import type { ContextWindowUsage } from '../../message/types';
import type { SessionUsageUpdateEvent } from '../session-event-types';

let tmpRoot: string;
let statusBus: ReplayableEventBus;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-update-usage-'));
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

function mkCw(over: Partial<ContextWindowUsage> = {}): ContextWindowUsage {
  return {
    systemTokens: 100,
    messageTokens: 700,
    toolTokens: 200,
    totalTokens: 1000,
    maxOutputTokens: 20000,
    tokenLimit: 200000,
    remainingTokens: 200000 - 1000 - 20000,
    ...over,
  };
}

describe('updateUsage — 写+推一体', () => {
  it('(1) {contextWindowUsage} → cw 落盘 + emit 一次（view 含最新 cw）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const events = collectUsageEvents(sid);
    const cw = mkCw();
    await store.updateUsage(sid, { contextWindowUsage: cw });
    await flushEvents();

    const rec = await store.getSession(sid);
    expect(rec?.contextWindowUsage).toEqual(cw);
    expect(events.length).toBe(1);
    expect(events[0]!.data.contextWindowUsage).toEqual(cw);
  });

  it('(2) {usagePartition, usage} → 累计落盘 + emit 一次（view 含最新累计）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const events = collectUsageEvents(sid);
    await store.updateUsage(sid, {
      usagePartition: 'forked',
      usage: { total_tokens: 42, cost: 0.01 },
    });
    await flushEvents();

    const view = await store.getUsageView(sid);
    expect(view.forked.total_tokens).toBe(42);
    expect(events.length).toBe(1);
    expect(events[0]!.data.forked.total_tokens).toBe(42);
    expect(events[0]!.data.total.total_tokens).toBe(42);
  });

  it('(3) 改 cw 时推的 view 里累计分区是 store 最新值（不被置旧）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    // 先只写累计（write-only 路径，compact 纯生产者同款）
    await store.accumulateUsage(sid, 'current', { total_tokens: 300 });
    await store.accumulateUsage(sid, 'forked', { total_tokens: 50 });

    const events = collectUsageEvents(sid);
    await store.updateUsage(sid, { contextWindowUsage: mkCw() });
    await flushEvents();

    expect(events.length).toBe(1);
    // 推的 view 里累计分区是最新值
    expect(events[0]!.data.current.total_tokens).toBe(300);
    expect(events[0]!.data.forked.total_tokens).toBe(50);
    expect(events[0]!.data.total.total_tokens).toBe(350);
  });

  it('(3) 改累计时推的 view 里 cw 是 store 最新值（不被置旧）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const cw = mkCw({ totalTokens: 7777 });
    await store.updateContextWindowUsage(sid, cw); // write-only 预置 cw

    const events = collectUsageEvents(sid);
    await store.updateUsage(sid, { usagePartition: 'current', usage: { total_tokens: 100 } });
    await flushEvents();

    expect(events.length).toBe(1);
    expect(events[0]!.data.contextWindowUsage).toEqual(cw);
    expect(events[0]!.data.current.total_tokens).toBe(100);
  });

  it('(4) 递归 sub 上报 parent：child updateUsage → child/parent 两 group 各收一次', async () => {
    const parent = ulid();
    const child = ulid();
    await store.createSession({ id: parent });
    await store.createSession({ id: child, parentSessionId: parent });

    const parentEvents = collectUsageEvents(parent);
    const childEvents = collectUsageEvents(child);
    await store.updateUsage(child, { usagePartition: 'current', usage: { total_tokens: 200 } });
    await flushEvents();

    expect(childEvents.length).toBe(1);
    expect(childEvents[0]!.data.current.total_tokens).toBe(200);
    expect(parentEvents.length).toBe(1);
    expect(parentEvents[0]!.data.sub.total_tokens).toBe(200);
    expect(parentEvents[0]!.data.sub.llmCallCount).toBe(1);
  });

  it('(5) 两字段同传 → 同 sid 只 emit 一次，view 含两边最新值', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const events = collectUsageEvents(sid);
    const cw = mkCw();
    await store.updateUsage(sid, {
      contextWindowUsage: cw,
      usagePartition: 'current',
      usage: { total_tokens: 100 },
    });
    await flushEvents();

    expect(events.length).toBe(1);
    expect(events[0]!.data.contextWindowUsage).toEqual(cw);
    expect(events[0]!.data.current.total_tokens).toBe(100);
  });

  it('(6) 失败隔离：notify（bus.emit）抛错 → updateUsage 不抛、cw 已落盘', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    // 打桩 emit 抛错（模拟推送失败）
    statusBus.emit = () => {
      throw new Error('bus boom');
    };
    const cw = mkCw();
    await expect(store.updateUsage(sid, { contextWindowUsage: cw })).resolves.toBeUndefined();
    const rec = await store.getSession(sid);
    expect(rec?.contextWindowUsage).toEqual(cw); // write 不翻
  });

  it('(7) 空 opts → 零写零推', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const events = collectUsageEvents(sid);
    await store.updateUsage(sid, {});
    await flushEvents();
    expect(events.length).toBe(0);
  });

  it('(7) session 不存在（仅累计入参）→ 静默零推不抛', async () => {
    const sid = ulid(); // 未 createSession
    const events = collectUsageEvents(sid);
    await expect(
      store.updateUsage(sid, { usagePartition: 'current', usage: { total_tokens: 1 } }),
    ).resolves.toBeUndefined();
    await flushEvents();
    expect(events.length).toBe(0);
  });
});
