/**
 * EventHub 单测
 * 参考: specs/tech/agent/event/[P0]event_hub.md §2 §3 §4
 *
 * 校验点：
 *   - registerTopic 重复注册同 topic 幂等覆盖（对齐 spec §2/§3 "重复注册覆盖"）
 *   - sub/unsub 幂等
 *   - 同 (topic, group) hub 层去重（不重复创建消费循环）
 *   - 未注册 topic 返回空订阅（不抛错）
 *   - listener 收到的 msg 是 unwrap 的 e.data（非 EventBusEvent）
 *   - 取消订阅后不再收到事件
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventHub } from '../agent/event-hub';
import { ReplayableEventBus } from '../agent/event-bus';

describe('EventHub', () => {
  beforeEach(() => {
    EventHub.resetForTest();
  });

  it('singleton 全局唯一', () => {
    const a = EventHub.singleton();
    const b = EventHub.singleton();
    expect(a).toBe(b);
  });

  it('registerTopic 重复注册同 topic 幂等覆盖（对齐 spec §2/§3）', () => {
    const hub = EventHub.singleton();
    const bus1 = new ReplayableEventBus();
    const bus2 = new ReplayableEventBus();
    hub.registerTopic('agent_loop', bus1);
    expect(() => hub.registerTopic('agent_loop', bus2)).not.toThrow();
    // 覆盖后路由到 bus2（不是 bus1）
    expect(hub.hasTopic('agent_loop')).toBe(true);
  });

  it('sub 后 listener 收到 unwrap 的 data（非 EventBusEvent）', async () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus({ replayable: true });
    hub.registerTopic('agent_loop', bus);

    const got: string[] = [];
    const sub = hub.sub<string>('agent_loop', 'session_id:S1', (msg) => {
      got.push(msg);
    });
    await Promise.resolve();

    bus.emit('session_id:S1', { data: 'A', timestamp: 't1' });
    bus.emit('session_id:S1', { data: 'B', timestamp: 't2' });
    await new Promise((r) => setTimeout(r, 10));

    expect(got).toEqual(['A', 'B']);
    hub.unsub(sub);
  });

  it('同 (topic, group) sub 多次：v0.0.207 每 sub 独立 consume 循环，listener 各调一次', async () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus({ replayable: true });
    hub.registerTopic('agent_loop', bus);

    const got: string[] = [];
    const listener = (msg: string) => got.push(msg);
    const sub1 = hub.sub('agent_loop', 'session_id:S1', listener);
    const sub2 = hub.sub('agent_loop', 'session_id:S1', listener);
    await Promise.resolve();

    // v0.0.207：每 sub 独立 bus.subscribe + consume → 两条 record
    expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S1')).toBe(2);

    bus.emit('session_id:S1', { data: 'X', timestamp: 't1' });
    await new Promise((r) => setTimeout(r, 10));

    // 每 listener 独立被调一次 → got 含两次 'X'（修复第二订阅者拿不到 replay 的核心保证）
    expect(got).toEqual(['X', 'X']);

    hub.unsub(sub1);
    hub.unsub(sub2); // 幂等，不再抛错
  });

  it('v0.0.207：第二订阅者晚到（首订阅者 replay 排空后才 subscribe）仍拿得到 replay', async () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus({ replayable: true });
    hub.registerTopic('agent_loop', bus);

    // 先 emit 两事件到 buffer（无订阅者）
    bus.emit('g_late', { data: 'A', timestamp: 't1' });
    bus.emit('g_late', { data: 'B', timestamp: 't2' });

    // 首订阅者：subscribe 触发 replay 排空（buffer 帧灌入首订阅者 queue）
    const got1: string[] = [];
    const sub1 = hub.sub<string>('agent_loop', 'g_late', (m) => got1.push(m));
    await new Promise((r) => setTimeout(r, 10));
    expect(got1).toEqual(['A', 'B']);

    // 第二订阅者晚到：旧设计复用 head consume 循环 → 拿不到自己的 replay（head 排空了）；
    // v0.0.207 每 sub 独立 bus.subscribe → 第二订阅者也有独立 replay queue
    const got2: string[] = [];
    const sub2 = hub.sub<string>('agent_loop', 'g_late', (m) => got2.push(m));
    await new Promise((r) => setTimeout(r, 10));
    expect(got2).toEqual(['A', 'B']); // 修复核心断言：第二订阅者也拿完整 replay

    hub.unsub(sub1);
    hub.unsub(sub2);
  });

  it('unsub 幂等：多次 cancel 不抛错', async () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus();
    hub.registerTopic('agent_loop', bus);

    const sub = hub.sub('agent_loop', 'g', () => {});
    hub.unsub(sub);
    expect(() => hub.unsub(sub)).not.toThrow();
    expect(() => sub.cancel()).not.toThrow();
  });

  it('未注册 topic 的 sub 返回空订阅（不抛错，listener 永不触发）', () => {
    const hub = EventHub.singleton();
    let called = false;
    const sub = hub.sub('unknown_topic', 'g', () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(() => hub.unsub(sub)).not.toThrow();
  });

  it('取消订阅后不再收到新事件', async () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus({ replayable: false });
    hub.registerTopic('agent_loop', bus);

    const got: string[] = [];
    const sub = hub.sub<string>('agent_loop', 'g', (msg) => got.push(msg));
    await Promise.resolve();

    bus.emit('g', { data: 'A', timestamp: 't1' });
    await new Promise((r) => setTimeout(r, 10));

    hub.unsub(sub);
    bus.emit('g', { data: 'B', timestamp: 't2' });
    await new Promise((r) => setTimeout(r, 10));

    expect(got).toEqual(['A']); // B 不应到达
  });

  it('topics() 返回已注册 topic 列表', () => {
    const hub = EventHub.singleton();
    hub.registerTopic('agent_loop', new ReplayableEventBus());
    hub.registerTopic('session_panel', new ReplayableEventBus());
    expect(hub.topics().sort()).toEqual(['agent_loop', 'session_panel']);
  });

  it('多 topic 路由：同 group 名落不同 bus，事件不串', async () => {
    const hub = EventHub.singleton();
    const busA = new ReplayableEventBus();
    const busB = new ReplayableEventBus();
    hub.registerTopic('agent_loop', busA);
    hub.registerTopic('session_panel', busB);

    const gotA: string[] = [];
    const gotB: string[] = [];
    const subA = hub.sub<string>('agent_loop', 'session_id:S1', (m) => gotA.push(m));
    const subB = hub.sub<string>('session_panel', 'session_id:S1', (m) => gotB.push(m));
    await Promise.resolve();

    busA.emit('session_id:S1', { data: 'agent-event', timestamp: 't1' });
    busB.emit('session_id:S1', { data: 'panel-event', timestamp: 't2' });
    await new Promise((r) => setTimeout(r, 10));

    expect(gotA).toEqual(['agent-event']);
    expect(gotB).toEqual(['panel-event']);
    hub.unsub(subA);
    hub.unsub(subB);
  });

  // v0.0.10 回归：cancel 不污染 replay buffer（旧实现用 emit({data:undefined}) 哨兵唤醒，
  // 会把 undefined 写入 buffer，紧随的新 sub 会回放出 data:undefined 伪事件，直连 hub.sub
  // 的消费者如 SseChannel 无兜底会收坏帧）。
  it('cancel 后新 sub 不会回放出 data:undefined 伪事件（replay buffer 不污染）', async () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus({ replayable: true });
    hub.registerTopic('agent_loop', bus);

    // 第一个订阅者收一个真事件，然后 cancel（cancel 时消费者阻塞在 next()）
    const got1: unknown[] = [];
    const sub1 = hub.sub<string>('agent_loop', 'session_id:S1', (m) => got1.push(m));
    await new Promise((r) => setTimeout(r, 10));

    bus.emit('session_id:S1', { data: 'real-event', timestamp: 't1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(got1).toEqual(['real-event']);

    // cancel：旧实现此刻会把 data:undefined 哨兵写进 replay buffer
    hub.unsub(sub1);
    await new Promise((r) => setTimeout(r, 10));

    // 新 sub 同 group：replayable bus 应只回放真实事件，不含 undefined 伪事件
    const got2: unknown[] = [];
    const sub2 = hub.sub<string>('agent_loop', 'session_id:S1', (m) => got2.push(m));
    await new Promise((r) => setTimeout(r, 20));

    expect(got2).toEqual(['real-event']); // 只回放真事件；不含 undefined
    expect(got2.some((m) => m === undefined)).toBe(false);
    hub.unsub(sub2);
  });

  // v0.0.10 回归：cancel 唤醒阻塞消费者后 hub 正常清理记录（不卡死、不泄漏）
  it('cancel 后 hub 清理 activeSubs（bus 级唤醒，不依赖 emit）', async () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus({ replayable: true });
    hub.registerTopic('agent_loop', bus);

    // 消费者订阅后阻塞在 next()（无事件）→ cancel 应唤醒并让它退出
    const sub = hub.sub<string>('agent_loop', 'g_cancel_exit', () => {
      // noop
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(hub.activeSubscriptionCount('agent_loop', 'g_cancel_exit')).toBe(1);

    hub.unsub(sub);
    await new Promise((r) => setTimeout(r, 20));

    // hub 已清除 activeSubs 记录（cancel 完整执行，消费循环退出）
    expect(hub.activeSubscriptionCount('agent_loop', 'g_cancel_exit')).toBe(0);
  });
});
