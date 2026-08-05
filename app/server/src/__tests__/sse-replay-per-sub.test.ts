/**
 * v0.0.207 SSE replay per-sub 修复验证
 * 参考:
 *   - specs/tech/agent/event/[P0]event_bus.md §4（replay buffer 行为）
 *   - specs/tech/version_logs/v0.0.207/change_plan.md（去两层去重恢复 per-sub 独立语义）
 *   - states/v0.0.207/bugs/BUG-001-abort-loses-toolcall-[open].md (b)（切走→切回渲染 bug）
 *
 * 校验点（5 条保住的语义）：
 *   1. 多订阅者同 group 都拿到完整 replay（buffer 帧全到）+ 实时帧
 *   2. 第二订阅者晚到（首订阅者 replay 排空后才 subscribe）也能拿到 replay ← 修复核心
 *   3. cancel 一个订阅者不影响其他订阅者继续收帧
 *   4. onSubscribe/onUnsubscribe 钩子在 group 级 0↔1 正确触发（不是每次 sub/unsub 都触发）
 *   5. 不泄漏（cancel 后 bus subscribers 清除、hub activeSubs 清零）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventHub } from '../agent/event-hub';
import { ReplayableEventBus } from '../agent/event-bus';
import { SseChannel, parseSseFrame } from '../sse/sse-channel';

/** 从 ReadableStream<Uint8Array> 拉取所有 SSE 帧（按 \n\n 切分），返回非 null SseFrame[] */
async function drainFrames(
  stream: ReadableStream<Uint8Array>,
  timeoutMs = 500,
): Promise<NonNullable<ReturnType<typeof parseSseFrame>>[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames: NonNullable<ReturnType<typeof parseSseFrame>>[] = [];
  const deadline = Date.now() + timeoutMs;
  let gotAny = false;
  while (Date.now() < deadline) {
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), 80),
    );
    const { done, value } = await Promise.race([readPromise, timeoutPromise]);
    if (done || value === undefined) {
      if (gotAny) break;
      continue;
    }
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf('\n\n');
    while (idx !== -1) {
      const raw = buf.slice(0, idx + 2);
      buf = buf.slice(idx + 2);
      const f = parseSseFrame(raw);
      if (f) {
        frames.push(f);
        gotAny = true;
      }
      idx = buf.indexOf('\n\n');
    }
  }
  try {
    await reader.cancel();
  } catch {
    // ignore
  }
  return frames;
}

describe('v0.0.207 SSE replay per-sub 修复', () => {
  let hub: EventHub;
  let bus: ReplayableEventBus;

  beforeEach(() => {
    EventHub.resetForTest();
    hub = EventHub.singleton();
    bus = new ReplayableEventBus({ replayable: true });
    hub.registerTopic('agent_loop', bus);
  });

  describe('语义 1+2：多订阅者各自拿完整 replay + 实时帧（修复核心）', () => {
    it('多订阅者同 group：每 subId 各自拿到完整 replay 帧', async () => {
      const ch = new SseChannel(hub);
      const { body } = ch.openConnection();

      // 先 emit 3 个事件进 buffer（无订阅者）
      bus.emit('session_id:S1', { data: 'A', timestamp: 't1' });
      bus.emit('session_id:S1', { data: 'B', timestamp: 't2' });
      bus.emit('session_id:S1', { data: 'C', timestamp: 't3' });
      await new Promise((r) => setTimeout(r, 5));

      // 同 (topic,group) 两个 subId 同时订阅
      ch.subscribe('agent_loop', 'session_id:S1', 'subA');
      ch.subscribe('agent_loop', 'session_id:S1', 'subB');
      await new Promise((r) => setTimeout(r, 20));

      // emit 一个实时帧
      bus.emit('session_id:S1', { data: 'LIVE', timestamp: 't4' });
      await new Promise((r) => setTimeout(r, 20));

      const frames = await drainFrames(body, 800);
      const subAFrames = frames.filter((f) => f.subId === 'subA').map((f) => f.data);
      const subBFrames = frames.filter((f) => f.subId === 'subB').map((f) => f.data);

      // 两个 subId 都拿到完整 replay (A,B,C) + 实时帧 LIVE（修复核心断言）
      expect(subAFrames).toEqual(['A', 'B', 'C', 'LIVE']);
      expect(subBFrames).toEqual(['A', 'B', 'C', 'LIVE']);
    });

    it('第二订阅者晚到（首订阅者 replay 排空后才 subscribe）也能拿 replay ← 修复核心', async () => {
      const ch = new SseChannel(hub);
      const { body } = ch.openConnection();

      // buffer 先放 2 个事件
      bus.emit('session_id:S2', { data: 'X', timestamp: 't1' });
      bus.emit('session_id:S2', { data: 'Y', timestamp: 't2' });

      // 首订阅者：subscribe 触发 replay 排空（buffer 帧灌入首订阅者 queue）
      ch.subscribe('agent_loop', 'session_id:S2', 'subFirst');
      await new Promise((r) => setTimeout(r, 20));

      // 第二订阅者晚到：旧设计 dispatcher fan-out 兜不住 replay（首 subId 的 hub.sub 已排空）；
      // v0.0.207 每 subId 各自 hub.sub → 第二订阅者也有独立 replay queue
      ch.subscribe('agent_loop', 'session_id:S2', 'subLate');
      await new Promise((r) => setTimeout(r, 20));

      const frames = await drainFrames(body, 800);
      const lateFrames = frames.filter((f) => f.subId === 'subLate').map((f) => f.data);

      // 修复核心断言：晚到的第二订阅者也拿到完整 replay（X,Y）
      expect(lateFrames).toEqual(['X', 'Y']);
    });

    it('sticky（run_start/run_end）先于 content buffer 回放到每 subId', async () => {
      // 注册带 lifecyclePredicate 的 bus（agent_loop 真实配置）
      EventHub.resetForTest();
      const hub = EventHub.singleton();
      const stickyBus = new ReplayableEventBus({
        replayable: true,
        lifecyclePredicate: (e) => {
          const t = (e.data as { type?: string }).type;
          return t === 'run_start' || t === 'run_end';
        },
      });
      hub.registerTopic('agent_loop', stickyBus);

      const ch = new SseChannel(hub);
      const { body } = ch.openConnection();

      // 先 emit run_start + content（buffer）
      stickyBus.emit('g_sticky', { data: { type: 'run_start', runId: 'R1' }, timestamp: 't0' });
      stickyBus.emit('g_sticky', { data: { type: 'text_delta', text: 'hi' }, timestamp: 't1' });

      // 两个 subId 都订阅
      ch.subscribe('agent_loop', 'g_sticky', 'subA');
      ch.subscribe('agent_loop', 'g_sticky', 'subB');
      await new Promise((r) => setTimeout(r, 20));

      const frames = await drainFrames(body, 800);
      const subATypes = frames.filter((f) => f.subId === 'subA').map((f) => (f.data as { type: string }).type);
      const subBTypes = frames.filter((f) => f.subId === 'subB').map((f) => (f.data as { type: string }).type);

      // 两个 subId 都先收到 run_start（sticky）再收 text_delta（buffer），顺序一致
      expect(subATypes).toEqual(['run_start', 'text_delta']);
      expect(subBTypes).toEqual(['run_start', 'text_delta']);
    });
  });

  describe('语义 3：cancel 一个订阅者不影响其他订阅者继续收帧', () => {
    it('中间 unsubscribe subA，subB 继续收实时帧（且 subA 不再收到）', async () => {
      const ch = new SseChannel(hub);
      const { body } = ch.openConnection();
      ch.subscribe('agent_loop', 'session_id:S3', 'subA');
      ch.subscribe('agent_loop', 'session_id:S3', 'subB');
      await new Promise((r) => setTimeout(r, 10));

      // 退 subA（hub 层 subA 的 consume 循环拆，subB 仍存活）
      ch.unsubscribe('subA');
      await new Promise((r) => setTimeout(r, 10));

      // emit 实时帧：subB 应收，subA 不应再收
      bus.emit('session_id:S3', { data: 'AFTER', timestamp: 't1' });
      const frames = await drainFrames(body, 500);

      const subAFrames = frames.filter((f) => f.subId === 'subA').map((f) => f.data);
      const subBFrames = frames.filter((f) => f.subId === 'subB').map((f) => f.data);

      expect(subAFrames).not.toContain('AFTER'); // subA 已退，不再收
      expect(subBFrames).toContain('AFTER'); // subB 继续收
    });
  });

  describe('语义 4：onSubscribe/onUnsubscribe 在 group 级 0↔1 正确触发', () => {
    it('group 级 0→1 触发 onSubscribe；N→1→0 中间 unsub 不触发；末 unsub 触发 onUnsubscribe', async () => {
      const events: string[] = [];
      const ch = new SseChannel(hub);
      ch.setSubscribeHooks({
        onSubscribe: () => {
          events.push('sub');
        },
        onUnsubscribe: () => {
          events.push('unsub');
        },
      });

      // 0→1：首 sub 触发
      await ch.subscribe('agent_loop', 'session_id:S4', 'subA');
      expect(events).toEqual(['sub']);

      // 1→2：第二 sub 不触发（group 已有订阅）
      await ch.subscribe('agent_loop', 'session_id:S4', 'subB');
      expect(events).toEqual(['sub']);

      // 2→1：中间 unsub 不触发
      await ch.unsubscribe('subA');
      expect(events).toEqual(['sub']);

      // 1→0：末 unsub 触发
      await ch.unsubscribe('subB');
      expect(events).toEqual(['sub', 'unsub']);
    });

    it('不同 group 各自的 0↔1 边界独立触发', async () => {
      const events: string[] = [];
      const ch = new SseChannel(hub);
      ch.setSubscribeHooks({
        onSubscribe: (_t, g) => {
          events.push(`sub:${g}`);
        },
        onUnsubscribe: (_t, g) => {
          events.push(`unsub:${g}`);
        },
      });

      await ch.subscribe('agent_loop', 'session_id:GA', 'a1');
      await ch.subscribe('agent_loop', 'session_id:GB', 'b1');
      // 各 group 首订阅独立触发
      expect(events).toEqual(['sub:session_id:GA', 'sub:session_id:GB']);

      await ch.unsubscribe('a1');
      expect(events).toEqual(['sub:session_id:GA', 'sub:session_id:GB', 'unsub:session_id:GA']);

      // GB 仍有订阅（subB），再 sub GB 不触发（非 0→1）
      await ch.subscribe('agent_loop', 'session_id:GB', 'b2');
      expect(events).toEqual(['sub:session_id:GA', 'sub:session_id:GB', 'unsub:session_id:GA']);

      // 退 b2：GB 仍有 subB（2→1，不触发）
      await ch.unsubscribe('b2');
      expect(events).toEqual(['sub:session_id:GA', 'sub:session_id:GB', 'unsub:session_id:GA']);

      // 退 subB：GB 1→0 触发
      await ch.unsubscribe('b1');
      expect(events).toEqual([
        'sub:session_id:GA',
        'sub:session_id:GB',
        'unsub:session_id:GA',
        'unsub:session_id:GB',
      ]);
    });
  });

  describe('语义 5：cancel 不泄漏（bus subscribers 清除 + hub activeSubs 清零）', () => {
    it('全部 unsubscribe 后 hub activeSubs 清零、bus subscribers 清空', async () => {
      const ch = new SseChannel(hub);
      ch.subscribe('agent_loop', 'session_id:S5', 'subA');
      ch.subscribe('agent_loop', 'session_id:S5', 'subB');
      await new Promise((r) => setTimeout(r, 10));

      // 两 record 都登记
      expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S5')).toBe(2);
      expect(bus.subscriberCount('session_id:S5')).toBe(2);

      ch.unsubscribe('subA');
      await new Promise((r) => setTimeout(r, 20));
      // subA cancel：hub record -1，bus subscribers -1
      expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S5')).toBe(1);
      expect(bus.subscriberCount('session_id:S5')).toBe(1);

      ch.unsubscribe('subB');
      await new Promise((r) => setTimeout(r, 20));
      // 全清：hub activeSubs 0，bus subscribers 0
      expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S5')).toBe(0);
      expect(bus.subscriberCount('session_id:S5')).toBe(0);
    });

    it('hub.sub 直连 cancel 后 bus subscribers 也清空（无遗留 consume 循环）', async () => {
      // 不经 channel，直连 hub.sub 验证底层
      const sub1 = hub.sub('agent_loop', 'g_leak', () => {});
      const sub2 = hub.sub('agent_loop', 'g_leak', () => {});
      await new Promise((r) => setTimeout(r, 10));
      expect(bus.subscriberCount('g_leak')).toBe(2);

      hub.unsub(sub1);
      await new Promise((r) => setTimeout(r, 20));
      expect(bus.subscriberCount('g_leak')).toBe(1);

      hub.unsub(sub2);
      await new Promise((r) => setTimeout(r, 20));
      expect(bus.subscriberCount('g_leak')).toBe(0);
      expect(hub.activeSubscriptionCount('agent_loop', 'g_leak')).toBe(0);
    });

    it('destroy 清所有订阅：channel + hub + bus 全部归零', async () => {
      const ch = new SseChannel(hub);
      ch.subscribe('agent_loop', 'session_id:S6', 'subA');
      ch.subscribe('agent_loop', 'session_id:S6', 'subB');
      ch.subscribe('agent_loop', 'session_id:S7', 'subC');
      await new Promise((r) => setTimeout(r, 10));

      expect(bus.subscriberCount('session_id:S6')).toBe(2);
      expect(bus.subscriberCount('session_id:S7')).toBe(1);

      ch.destroy();
      await new Promise((r) => setTimeout(r, 30));

      expect(ch.activeSubscriptionCount()).toBe(0);
      expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S6')).toBe(0);
      expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S7')).toBe(0);
      expect(bus.subscriberCount('session_id:S6')).toBe(0);
      expect(bus.subscriberCount('session_id:S7')).toBe(0);
    });
  });
});
