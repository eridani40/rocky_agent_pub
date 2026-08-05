/**
 * EventHub refcount 单测（v0.0.88 §3.1）
 * 参考:
 *   - specs/tech/agent/event/[P0]event_hub.md §3.1（多消费者 refcount 设计）
 *   - specs/tech/version_logs/v0.0.88/change_plan.md §「后端 — event_hub refcount」L23-25
 *
 * 校验点（白盒，对齐 spec §3.1 + change_plan +35/-12 行契约）：
 *   1. refcount +1（push 第二条）—— 命中已有 key 时不再 return head 的 cancel，
 *      而是 push 真 ActiveSub record 到数组
 *   2. refcount -1（splice 单条）—— cancel 按引用从数组 splice 移除；
 *      单条 cancel 不影响其他 record（其他句柄仍可正常 cancel）
 *   3. refcount 归零 —— 数组空才 activeSubs.delete(key) + 调 head 的 bus 消费循环 teardown
 *   4. 多消费者各拿独立 cancel 句柄；cancel 幂等
 *   5. FIFO 边界（head 先 cancel，non-head 仍在）：消费循环不拆，仍可正常清零
 *   6. 同 listener 重复订阅事件不重复（consume 循环只调 head 的 listener）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventHub } from '../agent/event-hub';
import { ReplayableEventBus } from '../agent/event-bus';

describe('EventHub refcount (v0.0.88 §3.1)', () => {
  beforeEach(() => {
    EventHub.resetForTest();
  });

  it('refcount +1：命中已有 key 时 push 真 record 而非 return head cancel', () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus();
    hub.registerTopic('agent_loop', bus);

    const sub1 = hub.sub('agent_loop', 'session_id:S1', () => {});
    const sub2 = hub.sub('agent_loop', 'session_id:S1', () => {});

    // 两次 sub → 两条独立 record（refcount=2）
    expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S1')).toBe(2);

    // 两个 cancel 句柄不同（独立生命周期）
    expect(sub1.cancel).not.toBe(sub2.cancel);

    hub.unsub(sub1);
    hub.unsub(sub2);
  });

  it('refcount -1：单条 cancel splice 自身，不影响其他 record', () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus();
    hub.registerTopic('agent_loop', bus);

    const sub1 = hub.sub('agent_loop', 'g_ref_neg', () => {});
    const sub2 = hub.sub('agent_loop', 'g_ref_neg', () => {});
    const sub3 = hub.sub('agent_loop', 'g_ref_neg', () => {});
    expect(hub.activeSubscriptionCount('agent_loop', 'g_ref_neg')).toBe(3);

    // cancel 中间一条：剩余 record 数 -1，head 与尾 record 仍存在（消费循环未拆）
    hub.unsub(sub2);
    expect(hub.activeSubscriptionCount('agent_loop', 'g_ref_neg')).toBe(2);

    hub.unsub(sub1);
    hub.unsub(sub3);
  });

  it('refcount 归零：数组空才 delete(key) + 拆 bus 消费循环', async () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus();
    hub.registerTopic('agent_loop', bus);

    const sub1 = hub.sub('agent_loop', 'g_zero', () => {});
    const sub2 = hub.sub('agent_loop', 'g_zero', () => {});
    expect(hub.activeSubscriptionCount('agent_loop', 'g_zero')).toBe(2);

    // 只 cancel 一条：消费循环仍存活（key 未删）
    hub.unsub(sub1);
    expect(hub.activeSubscriptionCount('agent_loop', 'g_zero')).toBe(1);

    // emit 应仍可被消费（消费循环未拆，head listener 仍调）
    // （注：non-head listener 不被 consume 直接调，由 bus 层 / channel 层 fan-out 负责）

    // 最后一条 cancel：refcount=0 → 拆 bus 消费循环 + 清 key
    hub.unsub(sub2);
    expect(hub.activeSubscriptionCount('agent_loop', 'g_zero')).toBe(0);

    // key 确实被清（activeSubscriptionCount 返回 0 已隐含，再校验 emit 不抛错兜底）
    expect(() =>
      bus.emit('g_zero', { data: 'after', timestamp: 't' }),
    ).not.toThrow();
  });

  it('多消费者各拿独立 cancel 句柄，单条 cancel 不影响其他句柄', () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus();
    hub.registerTopic('agent_loop', bus);

    const handles: ReturnType<typeof hub.sub>[] = [];
    for (let i = 0; i < 5; i++) {
      handles.push(hub.sub('agent_loop', 'g_handles', () => {}));
    }
    expect(hub.activeSubscriptionCount('agent_loop', 'g_handles')).toBe(5);

    // 随机 cancel 中间几个（push 保证非空，断言辅助 TS 收窄）
    const h1 = handles[1]!;
    const h3 = handles[3]!;
    h1.cancel();
    h3.cancel();
    expect(hub.activeSubscriptionCount('agent_loop', 'g_handles')).toBe(3);

    // 剩余句柄仍可正常 cancel（无副作用）
    const h0 = handles[0]!;
    const h2 = handles[2]!;
    const h4 = handles[4]!;
    expect(() => h0.cancel()).not.toThrow();
    expect(() => h2.cancel()).not.toThrow();
    expect(() => h4.cancel()).not.toThrow();
    expect(hub.activeSubscriptionCount('agent_loop', 'g_handles')).toBe(0);
  });

  it('cancel 幂等：同句柄二次调用 no-op（不误删其他 record）', () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus();
    hub.registerTopic('agent_loop', bus);

    const sub1 = hub.sub('agent_loop', 'g_idem', () => {});
    const sub2 = hub.sub('agent_loop', 'g_idem', () => {});
    expect(hub.activeSubscriptionCount('agent_loop', 'g_idem')).toBe(2);

    // 二次 cancel 是 no-op
    sub1.cancel();
    sub1.cancel();
    sub1.cancel();
    expect(hub.activeSubscriptionCount('agent_loop', 'g_idem')).toBe(1);

    // sub2 仍正常
    sub2.cancel();
    expect(hub.activeSubscriptionCount('agent_loop', 'g_idem')).toBe(0);
  });

  it('FIFO 边界：head 先 cancel，non-head 仍在时不拆 bus 消费循环', async () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus();
    hub.registerTopic('agent_loop', bus);

    // head + non-head
    const sub1 = hub.sub('agent_loop', 'g_fifo', () => {});
    const sub2 = hub.sub('agent_loop', 'g_fifo', () => {});
    expect(hub.activeSubscriptionCount('agent_loop', 'g_fifo')).toBe(2);

    // head 先 cancel：数组非空（non-head 仍在）→ 不 delete(key)
    hub.unsub(sub1);
    expect(hub.activeSubscriptionCount('agent_loop', 'g_fifo')).toBe(1);

    // non-head 后 cancel：refcount=0 → 才拆 bus 消费循环 + 清 key
    hub.unsub(sub2);
    expect(hub.activeSubscriptionCount('agent_loop', 'g_fifo')).toBe(0);
  });

  it('LIFO 边界：non-head 先 cancel，head 后 cancel', async () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus();
    hub.registerTopic('agent_loop', bus);

    const sub1 = hub.sub('agent_loop', 'g_lifo', () => {});
    const sub2 = hub.sub('agent_loop', 'g_lifo', () => {});
    expect(hub.activeSubscriptionCount('agent_loop', 'g_lifo')).toBe(2);

    // non-head 先 cancel
    hub.unsub(sub2);
    expect(hub.activeSubscriptionCount('agent_loop', 'g_lifo')).toBe(1);

    // head 后 cancel → refcount=0 → 拆
    hub.unsub(sub1);
    expect(hub.activeSubscriptionCount('agent_loop', 'g_lifo')).toBe(0);
  });

  it('v0.0.207：同 listener 重复订阅每 listener 独立被调（per-sub 独立 consume 循环）', async () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus({ replayable: false });
    hub.registerTopic('agent_loop', bus);

    const got: string[] = [];
    const listener = (msg: string) => got.push(msg);

    // 同 listener 订两次
    hub.sub('agent_loop', 'g_dup_listener', listener);
    hub.sub('agent_loop', 'g_dup_listener', listener);
    await Promise.resolve();

    bus.emit('g_dup_listener', { data: 'X', timestamp: 't1' });
    await new Promise((r) => setTimeout(r, 10));

    // v0.0.207：每 sub 独立 consume 循环 → 同 listener 被调两次（got 含两次 'X'）
    // 旧 head 复用设计下 got 只 1 个；新设计每 listener 独立被调，保证 per-sub replay 完整
    expect(got).toEqual(['X', 'X']);
  });

  it('不同 group 独立 refcount：互不影响', () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus();
    hub.registerTopic('agent_loop', bus);

    const subA1 = hub.sub('agent_loop', 'session_id:A', () => {});
    const subA2 = hub.sub('agent_loop', 'session_id:A', () => {});
    const subB1 = hub.sub('agent_loop', 'session_id:B', () => {});

    // 各 group 独立计数
    expect(hub.activeSubscriptionCount('agent_loop', 'session_id:A')).toBe(2);
    expect(hub.activeSubscriptionCount('agent_loop', 'session_id:B')).toBe(1);

    // cancel A 不影响 B
    hub.unsub(subA1);
    expect(hub.activeSubscriptionCount('agent_loop', 'session_id:A')).toBe(1);
    expect(hub.activeSubscriptionCount('agent_loop', 'session_id:B')).toBe(1);

    hub.unsub(subA2);
    hub.unsub(subB1);
    expect(hub.activeSubscriptionCount('agent_loop', 'session_id:A')).toBe(0);
    expect(hub.activeSubscriptionCount('agent_loop', 'session_id:B')).toBe(0);
  });

  it('不同 topic 同 group 名：refcount 独立（topic+group 是 key）', () => {
    const hub = EventHub.singleton();
    const bus = new ReplayableEventBus();
    hub.registerTopic('agent_loop', new ReplayableEventBus());
    hub.registerTopic('session_panel', new ReplayableEventBus());

    // 同 group 名、不同 topic → 独立 refcount
    const subA = hub.sub('agent_loop', 'session_id:S1', () => {});
    const subB = hub.sub('session_panel', 'session_id:S1', () => {});

    expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S1')).toBe(1);
    expect(hub.activeSubscriptionCount('session_panel', 'session_id:S1')).toBe(1);

    hub.unsub(subA);
    expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S1')).toBe(0);
    expect(hub.activeSubscriptionCount('session_panel', 'session_id:S1')).toBe(1);

    hub.unsub(subB);
  });
});
