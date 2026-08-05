/**
 * AppTaskLock 单元测试（v0.0.164.memory_opt 新建）
 * 参考: specs/tech/agent/session/[P0]app_task_lock.md（权威 spec §2 §3.1 §3.4 §6）
 *       specs/tech/version_logs/v0.0.164.memory_opt/change_plan.md 模块 F 后半
 *
 * 覆盖（spec 6 不变量 + emit 三不原则）：
 *   - CAS 语义：idle/done/failed → running；running 态 acquire 返 false；state 保持不变
 *   - getState 幂等：未 acquire → 返 idle 不写 Map
 *   - reconcileOnStartup no-op：空 lock / 有 running lock 均返空 reconciled、不清 state
 *   - markDone/markFailed/release：running → done/failed/idle；非 running 幂等 no-op
 *   - 不同 taskType 互不阻塞：'tier2_consolidation' 不挡 'backup'（未来扩展）
 *   - emit 三不原则：bus 未注入 no-op / CAS 失败不 emit / emit 异常吞错
 *   - emit target：事件 type='consolidation_task_update'、payload data=AppTaskState、
 *     emit 到 (_all) group（广播非 per-sid）
 *   - 超时接管（[v0.0.205.t2_cons] spec §3.1）：running 且 startedAt>1h → acquire 强制
 *     接管成功（新 runId 覆盖 + startedAt 刷新 + emit）；<1h / =1h → 拒获；内存 only 不变
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppTaskLock, STALE_RUNNING_MS } from '../app-task-lock';
import { ReplayableEventBus } from '../event-bus';
import { APP_TASK_BROADCAST_GROUP, type ConsolidationTaskUpdateEvent } from '../session-event-types';

/** 建 spy bus + 提供拉 emit 事件的 helper（对齐 SessionTaskLock 测试范式） */
async function collectEmits(bus: ReplayableEventBus): Promise<ConsolidationTaskUpdateEvent[]> {
  const collected: ConsolidationTaskUpdateEvent[] = [];
  const iter = bus.subscribe<ConsolidationTaskUpdateEvent>(APP_TASK_BROADCAST_GROUP);
  const consumer = (async () => {
    for await (const e of iter) {
      if (e.data === undefined) continue;
      collected.push(e.data);
    }
  })();
  void consumer;
  await new Promise((r) => setTimeout(r, 30));
  return collected;
}

let lock: AppTaskLock;

beforeEach(() => {
  lock = new AppTaskLock();
});

afterEach(() => {
  // fake timers 用例的兜底清理（未启用时 useRealTimers 为安全 no-op）
  vi.useRealTimers();
});

describe('AppTaskLock — 超时接管（STALE_RUNNING_MS=1h，spec §3.1 [v0.0.205.t2_cons]）', () => {
  it('running 且 startedAt 距今 >1h → acquire 强制接管成功（覆盖写新 running）', () => {
    vi.useFakeTimers();
    expect(lock.acquire('tier2_consolidation', 'cron:t0')).toBe(true);
    const firstStartedAt = lock.getState('tier2_consolidation').startedAt;

    // 推进系统时间 1h+1ms（越过 STALE_RUNNING_MS 阈值）
    vi.setSystemTime(Date.now() + STALE_RUNNING_MS + 1);

    expect(lock.acquire('tier2_consolidation', 'manual:t1')).toBe(true);
    const st = lock.getState('tier2_consolidation');
    expect(st.status).toBe('running');
    expect(st.runId).toBe('manual:t1'); // 新 runId 覆盖旧的（release+re-acquire 原子一步）
    expect(st.startedAt).not.toBe(firstStartedAt); // startedAt 刷新
    expect(st.error).toBeNull();
  });

  it('running 未超时（<1h）→ acquire 拒获（返 false，state 不变）', () => {
    vi.useFakeTimers();
    expect(lock.acquire('tier2_consolidation', 'cron:t0')).toBe(true);

    // 只推进 30min（阈值内）
    vi.setSystemTime(Date.now() + 30 * 60 * 1000);

    expect(lock.acquire('tier2_consolidation', 'manual:t1')).toBe(false);
    expect(lock.getState('tier2_consolidation').runId).toBe('cron:t0');
  });

  it('恰好等于阈值（=1h，未超过）→ 仍拒获（严格 > 语义）', () => {
    vi.useFakeTimers();
    expect(lock.acquire('tier2_consolidation', 'cron:t0')).toBe(true);
    vi.setSystemTime(Date.now() + STALE_RUNNING_MS);
    expect(lock.acquire('tier2_consolidation', 'manual:t1')).toBe(false);
  });

  it('超时接管成功 → emit 一次（CAS 成功分支，让前端立即渲染新 running）', async () => {
    vi.useFakeTimers();
    const bus = new ReplayableEventBus({ replayable: false });
    lock.setAppTaskBus(bus);
    lock.acquire('tier2_consolidation', 'cron:t0'); // 首次 emit 发生在 subscribe 前，丢弃

    vi.setSystemTime(Date.now() + STALE_RUNNING_MS + 1);

    const collectPromise = collectEmits(bus); // 挂上 subscribe + 注册内部 setTimeout(30)
    expect(lock.acquire('tier2_consolidation', 'manual:t1')).toBe(true);
    // fake timers 下 collectEmits 的 setTimeout(30) 需显式推进（同时 flush microtask 链）
    await vi.advanceTimersByTimeAsync(30);
    const events = await collectPromise;
    expect(events).toHaveLength(1);
    expect(events[0]!.data.status).toBe('running');
    expect(events[0]!.data.runId).toBe('manual:t1');
  });

  it('超时接管仍内存 only：reconcileOnStartup 仍 no-op（不落盘语义不变）', () => {
    vi.useFakeTimers();
    lock.acquire('tier2_consolidation', 'cron:t0');
    vi.setSystemTime(Date.now() + STALE_RUNNING_MS + 1);
    expect(lock.reconcileOnStartup().reconciled).toEqual([]);
  });
});

describe('AppTaskLock — CAS 互斥（同 taskType）', () => {
  it('首次 acquire 成功 + 返 true + state=running', () => {
    const ok = lock.acquire('tier2_consolidation', 'manual:abc');
    expect(ok).toBe(true);
    const st = lock.getState('tier2_consolidation');
    expect(st.status).toBe('running');
    expect(st.runId).toBe('manual:abc');
    expect(st.startedAt).toBeTruthy();
    expect(st.error).toBeNull();
  });

  it('同 taskType 第二次 acquire 返 false（CAS 守卫）+ 不覆盖首次 runId', () => {
    expect(lock.acquire('tier2_consolidation', 'manual:1')).toBe(true);
    expect(lock.acquire('tier2_consolidation', 'cron:2')).toBe(false);
    expect(lock.getState('tier2_consolidation').runId).toBe('manual:1');
  });

  it('runId 省略时 state.runId=null（可选参 spec §2）', () => {
    expect(lock.acquire('tier2_consolidation')).toBe(true);
    expect(lock.getState('tier2_consolidation').runId).toBeNull();
  });
});

describe('AppTaskLock — 不同 taskType 互不阻塞（不变量 §6.4）', () => {
  it('tier2_consolidation running 不挡 backup（未来扩展场景）', () => {
    expect(lock.acquire('tier2_consolidation', 't2:1')).toBe(true);
    expect(lock.acquire('backup', 'bk:1')).toBe(true);
    expect(lock.getState('tier2_consolidation').status).toBe('running');
    expect(lock.getState('backup').status).toBe('running');
  });
});

describe('AppTaskLock — markDone / markFailed / release', () => {
  it('markDone：running → done + 清 runId/startedAt/error', () => {
    lock.acquire('tier2_consolidation', 'm1');
    lock.markDone('tier2_consolidation');
    const st = lock.getState('tier2_consolidation');
    expect(st.status).toBe('done');
    expect(st.runId).toBeNull();
    expect(st.startedAt).toBeNull();
    expect(st.error).toBeNull();
  });

  it('markFailed：running → failed + 设 error', () => {
    lock.acquire('tier2_consolidation', 'm1');
    lock.markFailed('tier2_consolidation', 'LLM timeout');
    const st = lock.getState('tier2_consolidation');
    expect(st.status).toBe('failed');
    expect(st.error).toBe('LLM timeout');
  });

  it('release：running → idle', () => {
    lock.acquire('tier2_consolidation', 'm1');
    lock.release('tier2_consolidation');
    expect(lock.getState('tier2_consolidation').status).toBe('idle');
  });

  it('done 后再 acquire 成功（放行集合 = idle/done/failed，spec §3.1）', () => {
    lock.acquire('tier2_consolidation', 'm1');
    lock.markDone('tier2_consolidation');
    expect(lock.acquire('tier2_consolidation', 'm2')).toBe(true);
    expect(lock.getState('tier2_consolidation').runId).toBe('m2');
  });

  it('failed 后再 acquire 成功', () => {
    lock.acquire('tier2_consolidation', 'm1');
    lock.markFailed('tier2_consolidation', 'err');
    expect(lock.acquire('tier2_consolidation', 'm2')).toBe(true);
    expect(lock.getState('tier2_consolidation').status).toBe('running');
  });

  it('非 running 状态调 markDone/markFailed/release 幂等 no-op（不变量 §6.6）', () => {
    // idle → markDone / markFailed / release 均 no-op（仍 idle）
    lock.markDone('tier2_consolidation');
    expect(lock.getState('tier2_consolidation').status).toBe('idle');
    lock.markFailed('tier2_consolidation', 'x');
    expect(lock.getState('tier2_consolidation').status).toBe('idle');
    lock.release('tier2_consolidation');
    expect(lock.getState('tier2_consolidation').status).toBe('idle');

    // done → markFailed no-op（仍 done，不变 failed）
    lock.acquire('tier2_consolidation', 'm1');
    lock.markDone('tier2_consolidation');
    lock.markFailed('tier2_consolidation', 'late');
    expect(lock.getState('tier2_consolidation').status).toBe('done');
  });
});

describe('AppTaskLock — getState 幂等（不写 Map，避免查询污染）', () => {
  it('未 acquire 过的 taskType → 返 idle + 后续 acquire 仍可成功', () => {
    const st = lock.getState('never-touched');
    expect(st.status).toBe('idle');
    expect(st.runId).toBeNull();
    expect(lock.acquire('never-touched', 'x')).toBe(true);
  });

  it('多次 getState 返新对象副本（不能污染内部 state）', () => {
    const st1 = lock.getState('tier2_consolidation');
    st1.status = 'running'; // 修改副本
    const st2 = lock.getState('tier2_consolidation');
    expect(st2.status).toBe('idle'); // 内部仍是 idle
  });
});

describe('AppTaskLock — reconcileOnStartup（no-op 但保留契约，spec §3.4）', () => {
  it('空 lock：返空 reconciled 列表', () => {
    const r = lock.reconcileOnStartup();
    expect(r.reconciled).toEqual([]);
  });

  it('有 running 状态的 lock：仍返空 reconciled（no-op）+ 不清 state', () => {
    lock.acquire('tier2_consolidation', 'm1');
    expect(lock.getState('tier2_consolidation').status).toBe('running');
    const r = lock.reconcileOnStartup();
    expect(r.reconciled).toEqual([]);
    // reconcile 不影响现有 state（no-op，不清不扫）
    expect(lock.getState('tier2_consolidation').status).toBe('running');
  });
});

describe('AppTaskLock — SSE emit consolidation_task_update（不变量 §6.7 §6.8）', () => {
  it('未注入 bus → CAS 成功也不 emit（UT 兼容）', () => {
    // 不调 setAppTaskBus；lock 应静默 no-op
    expect(lock.acquire('tier2_consolidation', 'm1')).toBe(true);
    expect(lock.getState('tier2_consolidation').status).toBe('running');
  });

  it('acquire CAS 成功 → emit(status=running) 到 (_all) group', async () => {
    const bus = new ReplayableEventBus({ replayable: false });
    lock.setAppTaskBus(bus);

    const collectPromise = collectEmits(bus);
    expect(lock.acquire('tier2_consolidation', 'manual:xyz')).toBe(true);
    const events = await collectPromise;

    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.type).toBe('consolidation_task_update');
    expect(evt.data.status).toBe('running');
    expect(evt.data.runId).toBe('manual:xyz');
    expect(evt.data.startedAt).toBeTruthy();
    expect(evt.data.error).toBeNull();
    expect(evt.id).toBeTruthy();
    expect(evt.createdAt).toBeTruthy();
    // 无 sessionId 字段（app 级广播非 per-sid）
    expect((evt as unknown as { sessionId?: unknown }).sessionId).toBeUndefined();
  });

  it('acquire CAS 失败（已被占）→ 不 emit（幂等保护）', async () => {
    const bus = new ReplayableEventBus({ replayable: false });
    lock.setAppTaskBus(bus);
    lock.acquire('tier2_consolidation', 'm1'); // 首次 emit 一次

    const collectPromise = collectEmits(bus);
    expect(lock.acquire('tier2_consolidation', 'm2')).toBe(false);
    const events = await collectPromise;
    expect(events).toHaveLength(0);
  });

  it('markDone CAS 成功 → emit(status=done)', async () => {
    const bus = new ReplayableEventBus({ replayable: false });
    lock.setAppTaskBus(bus);
    lock.acquire('tier2_consolidation', 'm1');

    const collectPromise = collectEmits(bus);
    lock.markDone('tier2_consolidation');
    const events = await collectPromise;

    expect(events).toHaveLength(1);
    expect(events[0]!.data.status).toBe('done');
    expect(events[0]!.data.runId).toBeNull();
    expect(events[0]!.data.error).toBeNull();
  });

  it('markFailed CAS 成功 → emit(status=failed, error)', async () => {
    const bus = new ReplayableEventBus({ replayable: false });
    lock.setAppTaskBus(bus);
    lock.acquire('tier2_consolidation', 'm1');

    const collectPromise = collectEmits(bus);
    lock.markFailed('tier2_consolidation', 'LLM timeout');
    const events = await collectPromise;

    expect(events).toHaveLength(1);
    expect(events[0]!.data.status).toBe('failed');
    expect(events[0]!.data.error).toBe('LLM timeout');
  });

  it('release CAS 成功 → emit(status=idle)', async () => {
    const bus = new ReplayableEventBus({ replayable: false });
    lock.setAppTaskBus(bus);
    lock.acquire('tier2_consolidation', 'm1');

    const collectPromise = collectEmits(bus);
    lock.release('tier2_consolidation');
    const events = await collectPromise;

    expect(events).toHaveLength(1);
    expect(events[0]!.data.status).toBe('idle');
  });

  it('非 running 状态调 markDone → no-op + 不 emit（幂等保护）', async () => {
    const bus = new ReplayableEventBus({ replayable: false });
    lock.setAppTaskBus(bus);

    const collectPromise = collectEmits(bus);
    lock.markDone('tier2_consolidation'); // idle → markDone no-op
    const events = await collectPromise;

    expect(events).toHaveLength(0);
    expect(lock.getState('tier2_consolidation').status).toBe('idle');
  });

  it('emit 异常吞错 → 不影响 acquire 返值（三不原则 §3.4 第 3 条）', () => {
    // 构造一个 emit 抛错的 bus mock
    const brokenBus = {
      emit: () => {
        throw new Error('bus broken');
      },
    } as unknown as ReplayableEventBus;
    lock.setAppTaskBus(brokenBus);
    // acquire 不应抛错、返 true、state 正常写入
    expect(lock.acquire('tier2_consolidation', 'm1')).toBe(true);
    expect(lock.getState('tier2_consolidation').status).toBe('running');
  });
});
