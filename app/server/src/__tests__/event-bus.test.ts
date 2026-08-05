/**
 * ReplayableEventBus 单测
 * 参考: specs/tech/agent/event/[P0]event_bus.md §4 §5
 *
 * 校验点：
 *   - replay=true：emit A,B → 后 subscribe → 收到回放 [A,B] 再收新 C
 *   - replay=false：只收订阅后事件，不回放
 *   - 多订阅者 fan-out 互不干扰
 *   - 消费者 break 不泄漏（subscribers 集合缩小）
 *   - clearReplay 行为
 */
import { describe, it, expect } from 'vitest';
import { ReplayableEventBus, type EventBusEvent } from '../agent/event-bus';

/** 同步收集 N 个事件 */
async function collectN<T>(iter: AsyncIterable<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  for await (const e of iter) {
    out.push(e);
    if (out.length >= n) break;
  }
  return out;
}

describe('ReplayableEventBus', () => {
  it('replay=true：sub 前的历史会被回放，且继续收新事件', async () => {
    const bus = new ReplayableEventBus({ replayable: true });
    const group = 'session_id:S1';
    bus.emit<string>(group, { data: 'A', timestamp: 't1' });
    bus.emit<string>(group, { data: 'B', timestamp: 't2' });

    const iter = bus.subscribe<string>(group);
    // 让异步订阅注册完成
    await Promise.resolve();

    bus.emit<string>(group, { data: 'C', timestamp: 't3' });

    const got = await collectN(iter, 3);
    expect(got.map((e) => e.data)).toEqual(['A', 'B', 'C']);
    expect(got.map((e) => e.timestamp)).toEqual(['t1', 't2', 't3']);
  });

  it('replay=false：只收订阅之后的事件，不回放历史', async () => {
    const bus = new ReplayableEventBus({ replayable: false });
    const group = 'g1';
    bus.emit(group, { data: 'A', timestamp: 't1' }); // 订阅前，应丢

    const iter = bus.subscribe<string>(group);
    await Promise.resolve();

    bus.emit(group, { data: 'B', timestamp: 't2' });
    bus.emit(group, { data: 'C', timestamp: 't3' });

    const got = await collectN(iter, 2);
    expect(got.map((e) => e.data)).toEqual(['B', 'C']);
  });

  it('默认构造（无 options）= non-replayable', async () => {
    const bus = new ReplayableEventBus();
    expect(bus.isReplayable()).toBe(false);
    bus.emit('g', { data: 'X', timestamp: 't1' });
    const iter = bus.subscribe<string>('g');
    await Promise.resolve();
    bus.emit('g', { data: 'Y', timestamp: 't2' });
    const got = await collectN(iter, 1);
    expect(got.map((e) => e.data)).toEqual(['Y']);
  });

  it('多订阅者 fan-out：互不干扰，各自收到全量', async () => {
    const bus = new ReplayableEventBus({ replayable: false });
    const group = 'fanout';

    const s1 = bus.subscribe<string>(group);
    const s2 = bus.subscribe<string>(group);
    await Promise.resolve();

    bus.emit(group, { data: 'A', timestamp: 't1' });
    bus.emit(group, { data: 'B', timestamp: 't2' });

    const [a, b] = await Promise.all([collectN(s1, 2), collectN(s2, 2)]);
    expect(a.map((e) => e.data)).toEqual(['A', 'B']);
    expect(b.map((e) => e.data)).toEqual(['A', 'B']);
  });

  it('消费者 break 后从 subscribers 移除（不泄漏）', async () => {
    const bus = new ReplayableEventBus({ replayable: false });
    const group = 'leak';

    const iter = bus.subscribe<string>(group);
    await Promise.resolve();
    expect(bus.subscriberCount(group)).toBe(1);

    // 先 emit 一个事件让 next() resolve，for-await 才能 break → 触发 return → 清理 subscribers
    bus.emit(group, { data: 'X', timestamp: 't1' });

    // break 退出
    for await (const _ of iter) {
      void _;
      break;
    }
    // 退出后订阅者集合应缩小
    expect(bus.subscriberCount(group)).toBe(0);
  });

  it('clearReplay：replayable bus 清空 buffer，已订阅者不受影响，新订阅从此回放', async () => {
    const bus = new ReplayableEventBus({ replayable: true });
    const group = 'g';

    bus.emit(group, { data: 'A', timestamp: 't1' });
    bus.emit(group, { data: 'B', timestamp: 't2' });
    bus.clearReplay(group);

    const iter = bus.subscribe<string>(group);
    await Promise.resolve();
    bus.emit(group, { data: 'C', timestamp: 't3' });

    const got = await collectN(iter, 1);
    expect(got.map((e) => e.data)).toEqual(['C']); // A,B 已被 clear，不回放
  });

  it('clearReplay 对 non-replayable bus 无效果', () => {
    const bus = new ReplayableEventBus({ replayable: false });
    expect(() => bus.clearReplay('g')).not.toThrow();
  });

  it('EventBusEvent payload 形态 {data, timestamp}（为 AgentEvent §8 装载预留）', async () => {
    const bus = new ReplayableEventBus({ replayable: true });
    // 模拟 AgentEvent 形态（task-2 只验证 {data,timestamp} 信封；具体 AgentEvent 类型归 task-5）
    type FakeAgentEvent = { type: 'text_block_delta'; sessionId: string; delta: string };
    const evt: EventBusEvent<FakeAgentEvent> = {
      data: { type: 'text_block_delta', sessionId: 'S1', delta: 'hi' },
      timestamp: '2026-06-21T00:00:00.000Z',
    };
    bus.emit<FakeAgentEvent>('g', evt);

    const iter = bus.subscribe<FakeAgentEvent>('g');
    await Promise.resolve();
    const got = await collectN(iter, 1);
    expect(got[0]).toEqual(evt);
    expect(got[0]!.data.type).toBe('text_block_delta');
  });
});

/**
 * [v0.0.42] lifecyclePredicate + sticky slot 单测
 * 参考: specs/tech/agent/event/[P0]event_bus.md §2.1/§2.2/§4.3/§5
 *       specs/tech/version_logs/v0.0.42/change_log.md 块1
 *
 * 校验点（白盒，对齐 spec §4.3 行为契约）：
 *   1. 命中 predicate → 写 sticky slot + 推 live 订阅者（sticky-exclusive，不进 buffer）
 *   2. clearReplay 清 buffer 不清 sticky
 *   3. subscribe 先回放 sticky 再回放 buffer（sticky 在前）
 *   4. 多 run：emit run_start → run_end → 再 run_start，sticky 反映最新一组（replace 语义）
 *   5. 零回归：不配 lifecyclePredicate 的 bus = 旧行为（无 sticky，clearReplay 清整个 buffer）
 *   6. [v0.0.42 T1 回归] subscribe replay 无重复 run_start（emit run_start 后未 clearReplay 立即 subscribe → 恰好一次）
 */
describe('ReplayableEventBus lifecyclePredicate + sticky slot（v0.0.42）', () => {
  /** 模拟 agent_loop 生命周期 event（type 字段在 data 上，与 AgentEvent 一致） */
  type LoopEvent =
    | { type: 'run_start'; runId: string }
    | { type: 'run_end'; runId: string }
    | { type: 'message_start'; messageId: string }
    | { type: 'text_delta'; delta: string };

  /** 构造一个与 bootstrap.ts 同款的 agent_loop bus（replayable + predicate 识别 run_start/run_end） */
  function makeAgentLoopBus(): ReplayableEventBus {
    return new ReplayableEventBus({
      replayable: true,
      lifecyclePredicate: (e) => {
        const t = (e.data as { type?: string } | null | undefined)?.type;
        return t === 'run_start' || t === 'run_end';
      },
    });
  }

  it('命中 predicate → 写 sticky slot + 推 live 订阅者（sticky-exclusive，不进 buffer）', async () => {
    const bus = makeAgentLoopBus();
    const group = 'session_id:S1';
    // emit 一个生命周期事件（命中 predicate）
    bus.emit<LoopEvent>(group, { data: { type: 'run_start', runId: 'R1' }, timestamp: 't1' });

    const iter = bus.subscribe<LoopEvent>(group);
    await Promise.resolve();
    // 订阅者应收到 1 帧（fan-out 推送，sticky 不影响 live fan-out）
    const got = await collectN(iter, 1);
    expect(got[0]!.data).toEqual({ type: 'run_start', runId: 'R1' });
  });

  it('clearReplay 清 buffer 不清 sticky（切走切回 run_start 仍能 replay）', async () => {
    const bus = makeAgentLoopBus();
    const group = 'session_id:S1';
    bus.emit<LoopEvent>(group, { data: { type: 'run_start', runId: 'R1' }, timestamp: 't1' });
    bus.emit<LoopEvent>(group, { data: { type: 'message_start', messageId: 'M1' }, timestamp: 't2' });
    bus.emit<LoopEvent>(group, { data: { type: 'text_delta', delta: 'hi' }, timestamp: 't3' });

    // ingest 一批 → clearReplay（清 content buffer，不清 sticky）
    bus.clearReplay(group);

    // 切回重订阅：应只回放 sticky [run_start_R1]（buffer 已被清空）
    const iter = bus.subscribe<LoopEvent>(group);
    await Promise.resolve();
    const got = await collectN(iter, 1);
    expect(got).toHaveLength(1);
    expect(got[0]!.data).toEqual({ type: 'run_start', runId: 'R1' });
  });

  it('subscribe 先回放 sticky 再回放 buffer（reducer 喂入序：run_start → content delta）', async () => {
    const bus = makeAgentLoopBus();
    const group = 'session_id:S2';
    // run 进行中：run_start 粘在 sticky + 半截 message content 在 buffer
    bus.emit<LoopEvent>(group, { data: { type: 'run_start', runId: 'R2' }, timestamp: 't1' });
    bus.emit<LoopEvent>(group, { data: { type: 'message_start', messageId: 'M2' }, timestamp: 't2' });
    bus.emit<LoopEvent>(group, { data: { type: 'text_delta', delta: 'hello' }, timestamp: 't3' });

    // 不 clearReplay（run 还在进行，半截还在 buffer）→ 切走再切回
    const iter = bus.subscribe<LoopEvent>(group);
    await Promise.resolve();

    // 预期回放顺序：sticky [run_start_R2] 在前，再 buffer [message_start_M2, text_delta]
    //   [v0.0.42 T1] sticky-exclusive：run_start 不进 buffer（修复重复回放回归）
    //   → run_start 恰好出现一次（sticky 先回放，让 reducer 先翻 runActive=true）
    const got = await collectN(iter, 3);
    const types = got.map((e) => (e.data as { type: string }).type);
    // 第一个必须是 run_start（sticky 先回放，让 reducer 先翻 runActive=true）
    expect(types[0]).toBe('run_start');
    // 后续是 buffer 内容（content delta：message_start + text_delta）
    expect(types.slice(1)).toEqual(['message_start', 'text_delta']);
  });

  it('[v0.0.42 T1 回归] subscribe replay 无重复 run_start（run 刚起未 clearReplay 立即 subscribe）', async () => {
    // 场景：run 刚起 → run_start 已 emit 但还没 ingest/clearReplay → 立即 subscribe
    //   旧行为（BUG）：replay = sticky(run_start) + buffer(run_start) → run_start 出现 2 次
    //   修复后（sticky-exclusive）：run_start 只写 sticky 不进 buffer → 恰好 1 次
    const bus = makeAgentLoopBus();
    const group = 'session_id:S_dup';
    bus.emit<LoopEvent>(group, { data: { type: 'run_start', runId: 'Rdup' }, timestamp: 't1' });

    // 关键：不调 clearReplay（模拟 subscribe 发生在 ingest/clearReplay 之前）
    const iter = bus.subscribe<LoopEvent>(group);
    await Promise.resolve();

    // 收 replay：sticky + buffer。sticky-exclusive 下 buffer 不含 run_start → 只 1 次
    const got = await collectN(iter, 1);
    expect(got).toHaveLength(1);
    expect(got[0]!.data).toEqual({ type: 'run_start', runId: 'Rdup' });
    // 计数 run_start 次数：必须恰好 1（不是 2）
    const runStartCount = got.filter(
      (e) => (e.data as { type: string }).type === 'run_start',
    ).length;
    expect(runStartCount).toBe(1);
  });

  it('多 run：emit run_start → run_end → 再 run_start，sticky 反映最新一组（replace 语义）', async () => {
    const bus = makeAgentLoopBus();
    const group = 'session_id:S3';
    // run1 完整生命周期
    bus.emit<LoopEvent>(group, { data: { type: 'run_start', runId: 'R1' }, timestamp: 't1' });
    bus.emit<LoopEvent>(group, { data: { type: 'run_end', runId: 'R1' }, timestamp: 't2' });
    // run2 开始：emit run_start 时应清掉 sticky 内 run_start_R1 + run_end_R1
    bus.emit<LoopEvent>(group, { data: { type: 'run_start', runId: 'R2' }, timestamp: 't3' });

    // clearReplay（清 buffer，留 sticky）
    bus.clearReplay(group);

    // 重订阅：sticky 只含最新一组（run_start_R2），无旧 run1 噪音
    const iter = bus.subscribe<LoopEvent>(group);
    await Promise.resolve();
    const got = await collectN(iter, 1);
    expect(got).toHaveLength(1);
    expect(got[0]!.data).toEqual({ type: 'run_start', runId: 'R2' });
  });

  it('run 结束后 sticky 保留 run_start + run_end（成对，reducer 最终 runActive=false）', async () => {
    const bus = makeAgentLoopBus();
    const group = 'session_id:S4';
    bus.emit<LoopEvent>(group, { data: { type: 'run_start', runId: 'R3' }, timestamp: 't1' });
    bus.emit<LoopEvent>(group, { data: { type: 'run_end', runId: 'R3' }, timestamp: 't2' });
    bus.clearReplay(group);

    const iter = bus.subscribe<LoopEvent>(group);
    await Promise.resolve();
    const got = await collectN(iter, 2);
    // 顺序：run_start → run_end（Map 插入序）
    expect(got.map((e) => (e.data as { type: string }).type)).toEqual(['run_start', 'run_end']);
    expect((got[0]!.data as { runId: string }).runId).toBe('R3');
    expect((got[1]!.data as { runId: string }).runId).toBe('R3');
  });

  it('零回归：不配 lifecyclePredicate = 旧行为（无 sticky，clearReplay 清整个 buffer）', async () => {
    // 与 v0.0.8 以来行为完全一致：clearReplay 清空后，重订阅收不到任何回放
    const bus = new ReplayableEventBus({ replayable: true });
    const group = 'session_id:S5';
    bus.emit<LoopEvent>(group, { data: { type: 'run_start', runId: 'RX' }, timestamp: 't1' });
    bus.emit<LoopEvent>(group, { data: { type: 'message_start', messageId: 'MX' }, timestamp: 't2' });
    bus.clearReplay(group);

    // 重订阅 + emit 新事件，只应收到新事件（无任何回放）
    const iter = bus.subscribe<LoopEvent>(group);
    await Promise.resolve();
    bus.emit<LoopEvent>(group, { data: { type: 'text_delta', delta: 'new' }, timestamp: 't3' });
    const got = await collectN(iter, 1);
    expect(got).toHaveLength(1);
    expect(got[0]!.data).toEqual({ type: 'text_delta', delta: 'new' });
  });

  it('predicate 返 false 的普通 content 事件只走 buffer（不写 sticky）', async () => {
    const bus = makeAgentLoopBus();
    const group = 'session_id:S6';
    // message_start / text_delta 不命中 predicate → 只进 buffer
    bus.emit<LoopEvent>(group, { data: { type: 'message_start', messageId: 'M9' }, timestamp: 't1' });
    bus.emit<LoopEvent>(group, { data: { type: 'text_delta', delta: 'x' }, timestamp: 't2' });
    bus.clearReplay(group);

    // sticky 应为空（无生命周期事件）→ 重订阅收不到任何回放
    const iter = bus.subscribe<LoopEvent>(group);
    await Promise.resolve();
    bus.emit<LoopEvent>(group, { data: { type: 'text_delta', delta: 'after' }, timestamp: 't3' });
    const got = await collectN(iter, 1);
    expect(got[0]!.data).toEqual({ type: 'text_delta', delta: 'after' });
  });
});
