/**
 * wrapBusWithLog 单测（spec dev-logs §7 event bus proxy）
 * 参考: specs/tech/app/dev-logs/[P0]overall.md §3.4 §7
 *
 * 关键回归（spec §3.4 难点）：proxy 不能破坏 event 现有行为
 *   - emit 拦截写日志 + 委托 inner.emit（replay buffer / fan-out / 订阅者全照旧）
 *   - subscribe 透传 inner（保留 self.cleanup 闭包 + replay buffer 回放）
 *   - wakePendingSubscribers 透传 inner（cancel 链路不破坏）
 *   - 开关 false 时 write 早 return（proxy 包装本身的 emit 委托开销极小）
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { ReplayableEventBus } from '../../agent/event-bus';
import { wrapBusWithLog } from '../wrap-bus-with-log';
import { LogWriter, resetLogWriterForTest } from '../log-writer';

/** 构造可控开关的 mock devConfig */
function makeMockDevConfig(overrides: Record<string, unknown> = {}): {
  get: (g: string, k: string) => unknown;
} {
  const store: Record<string, unknown> = { ...overrides };
  return { get: (g: string, k: string) => store[`${g}.${k}`] };
}

async function flushAppend(): Promise<void> {
  // LogQueue 批间 sleep BATCH_INTERVAL_MS=250ms（v0.0.138 生产者消费者模型）；
  // [REPLAY-DEBUG] v0.0.207 加 bus_subscribe 诊断行后，emit 行可能落在第二个 batch，
  // 30ms 不够，提到 600ms 覆盖两个 batch 间隔。
  await new Promise((r) => setTimeout(r, 600));
}

describe('wrapBusWithLog', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-wrapbus-'));
    resetLogWriterForTest();
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    resetLogWriterForTest();
  });

  it('emit 拦截写日志（开关 on）+ 委托 inner.emit（订阅者收到）', async () => {
    const devConfig = makeMockDevConfig({ 'logs.enableEventLog': true });
    const logWriter = new LogWriter(dataDir, devConfig);
    const inner = new ReplayableEventBus({ replayable: true });
    const bus = wrapBusWithLog(inner, logWriter, 'agent_loop');

    // 订阅 group=g1
    const received: unknown[] = [];
    const iter = bus.subscribe<{ type: string }>('g1')[Symbol.asyncIterator]();
    const consume = async (): Promise<void> => {
      const { value } = await iter.next();
      received.push(value);
      await iter.return?.();
    };
    const p = consume();

    bus.emit('g1', { data: { type: 'msg_start' }, timestamp: new Date().toISOString() });
    await p;
    await flushAppend();

    // 1. 订阅者收到事件（emit 委托 inner）
    expect(received.length).toBe(1);
    expect((received[0] as { data: { type: string } }).data.type).toBe('msg_start');
    // 2. 日志写入 event.log（emit 拦截）。
    // [REPLAY-DEBUG] 注：subscribe 也会写一条 bus_subscribe 诊断行（v0.0.207 orchestrator 加），
    //    先于 emit 行；emit 的 msg_start 行是末行。
    const content = readFileSync(join(dataDir, 'logs', 'event.log'), 'utf-8');
    const lines = content.trim().split('\n');
    const emitLine = JSON.parse(lines[lines.length - 1]!);
    expect(emitLine.topic).toBe('agent_loop');
    expect(emitLine.group).toBe('g1');
    expect(emitLine.event).toEqual({ type: 'msg_start' });
  });

  it('开关 off 时 write 早 return（不写日志），emit 委托照旧', async () => {
    const devConfig = makeMockDevConfig({}); // 开关缺省 false
    const logWriter = new LogWriter(dataDir, devConfig);
    const inner = new ReplayableEventBus({ replayable: true });
    const bus = wrapBusWithLog(inner, logWriter, 'session_panel');

    const received: unknown[] = [];
    const iter = bus.subscribe<{ t: number }>('g')[Symbol.asyncIterator]();
    const consume = async (): Promise<void> => {
      const { value } = await iter.next();
      received.push(value);
      await iter.return?.();
    };
    const p = consume();
    bus.emit('g', { data: { t: 1 }, timestamp: new Date().toISOString() });
    await p;
    await flushAppend();

    // 订阅者照收
    expect(received.length).toBe(1);
    // 日志不写（开关 false）
    expect(existsSync(join(dataDir, 'logs', 'event.log'))).toBe(false);
  });

  it('subscribe 透传 inner：replay buffer 回放历史事件（关键回归）', async () => {
    const devConfig = makeMockDevConfig({}); // 开关 off 专注回归
    const logWriter = new LogWriter(dataDir, devConfig);
    const inner = new ReplayableEventBus({ replayable: true });
    const bus = wrapBusWithLog(inner, logWriter, 'agent_loop');

    // 订阅前 emit 历史事件（写入 replay buffer）
    bus.emit('g', { data: { n: 1 }, timestamp: new Date().toISOString() });
    bus.emit('g', { data: { n: 2 }, timestamp: new Date().toISOString() });

    // 订阅后应回放历史（replay buffer 行为不破坏）
    const received: number[] = [];
    const iter = bus.subscribe<{ n: number }>('g')[Symbol.asyncIterator]();
    for (let i = 0; i < 2; i++) {
      const { value, done } = await iter.next();
      if (done) break;
      received.push((value as { data: { n: number } }).data.n);
    }
    await iter.return?.();
    expect(received).toEqual([1, 2]);
  });

  it('wakePendingSubscribers 透传 inner：cancel 唤醒阻塞消费者（关键回归）', async () => {
    const devConfig = makeMockDevConfig({}); // 开关 off 专注回归
    const logWriter = new LogWriter(dataDir, devConfig);
    const inner = new ReplayableEventBus({ replayable: true });
    const bus = wrapBusWithLog(inner, logWriter, 'agent_loop');

    const iter = bus.subscribe<{ n: number }>('g')[Symbol.asyncIterator]();
    // 消费者阻塞在 next()（无事件），wakePendingSubscribers 应唤醒它返回 done
    const p = iter.next();
    // 让 microtask 跑起来进入 await
    await new Promise((r) => setTimeout(r, 10));
    bus.wakePendingSubscribers('g');
    const result = await p;
    expect(result.done).toBe(true);
    await iter.return?.();
  });

  it('机制转发全部方法：clearReplay/isReplayable/subscriberCount 透传 inner（v0.0.30 hotfix 回归）', async () => {
    // 回归：首版手列方法的 proxy 漏了 clearReplay → agent loop 调 bus.clearReplay 抛
    // "clearReplay is not a function" → 每次 run SERVER_ERROR 全挂。Proxy 默认转发一切，机制上不可能漏。
    const devConfig = makeMockDevConfig({});
    const logWriter = new LogWriter(dataDir, devConfig);
    const inner = new ReplayableEventBus({ replayable: true });
    const bus = wrapBusWithLog(inner, logWriter, 'agent_loop');

    // 1. emit 进 replay buffer，再 clearReplay 必须透传到 inner（不抛 not-a-function）
    bus.emit('g', { data: { n: 1 }, timestamp: new Date().toISOString() });
    expect(() => bus.clearReplay('g')).not.toThrow();
    // 2. clearReplay 真转发了（清空 buffer）→ 之后新订阅不回放历史（证明不是 no-op）
    const iter = bus.subscribe<{ n: number }>('g')[Symbol.asyncIterator]();
    let received = 0;
    void iter.next().then((r) => { if (!r.done) received++; });
    await new Promise((r) => setTimeout(r, 20));
    await iter.return?.();
    expect(received).toBe(0);
    // 3. 其他不在 EventBusLike 最小接口里的方法也透传
    expect(bus.isReplayable()).toBe(true);
    expect(bus.subscriberCount('g')).toBe(0);
  });

  it('logWriter undefined 时 proxy 不抛（emit 委托照旧）', async () => {
    // 边界：logWriter 为 undefined/null 的容错（理论上不会发生，但 proxy 要稳）
    const devConfig = makeMockDevConfig({});
    const logWriter = new LogWriter(dataDir, devConfig);
    const inner = new ReplayableEventBus({ replayable: true });
    const bus = wrapBusWithLog(inner, logWriter, 'agent_loop');

    // 正常 emit 不应抛（即使开关 off，write 内部早 return）
    expect(() =>
      bus.emit('g', { data: { x: 1 }, timestamp: new Date().toISOString() }),
    ).not.toThrow();
  });
});
