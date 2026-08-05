/**
 * SessionTaskLock 单元测试（v0.0.55 新建）
 * 参考: specs/tech/agent/session/[P0]session_task_lock.md（权威 spec）
 *       specs/tech/version_logs/v0.0.55.memory_ui_session_lock/change_log.md §0 §2
 *
 * 覆盖（task 验收 4 维 + reconcile no-op）：
 *   - CAS 互斥：同 session × 同 taskType 并发第二次 acquire 返 false
 *   - 不同 session 不阻塞：sessionA 的锁不挡 sessionB
 *   - 不同 taskType 不阻塞：sid × 'compact' 不挡 sid × 'tier1_consolidation'
 *   - release 后下一个 acquire 成功（state 复位 idle）
 *   - markDone / markFailed 后 getState 可读 + CAS 守卫仍放行（done/failed ∈ 放行集合）
 *   - reconcileOnStartup no-op（内存 only，返空 reconciled）
 *   - 非 running 状态调 markDone/markFailed/release 幂等 no-op
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionTaskLock } from '../session-task-lock';
import { ReplayableEventBus } from '../event-bus';
import type { SummaryTaskUpdateEvent } from '../session-event-types';

/**
 * [v0.0.78.bug] 收集 statusBus emit 的事件（subscribe + 微任务拉一轮）。
 * 返回 { bus, events } —— events 累积所有 emit 的 data。
 */
function spyBus(): { bus: ReplayableEventBus; events: SummaryTaskUpdateEvent[] } {
  const bus = new ReplayableEventBus({ replayable: false });
  const events: SummaryTaskUpdateEvent[] = [];
  return {
    bus,
    events,
  };
}

/**
 * [v0.0.78.bug] subscribe 并拉一轮事件（30ms）验证 emit 内容。
 */
async function collectEmits(bus: ReplayableEventBus, sid: string): Promise<SummaryTaskUpdateEvent[]> {
  const collected: SummaryTaskUpdateEvent[] = [];
  const iter = bus.subscribe<SummaryTaskUpdateEvent>(`session_id:${sid}`);
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

let lock: SessionTaskLock;

beforeEach(() => {
  lock = new SessionTaskLock();
});

describe('SessionTaskLock — CAS 互斥（同 session × 同 task）', () => {
  it('首次 acquire 成功 + 返 true', () => {
    const ok = lock.acquire('sid-1', 'compact', 'compact:1');
    expect(ok).toBe(true);
    expect(lock.getState('sid-1', 'compact').status).toBe('running');
    expect(lock.getState('sid-1', 'compact').runId).toBe('compact:1');
    expect(lock.getState('sid-1', 'compact').startedAt).toBeTruthy();
    expect(lock.getState('sid-1', 'compact').error).toBeNull();
  });

  it('同 session × 同 task 第二次 acquire 返 false（CAS 守卫，互斥）', () => {
    expect(lock.acquire('sid-1', 'compact', 'compact:1')).toBe(true);
    // 并发第二次（不同 runId 也挡；同 sid × 同 taskType 同时只 1 个 active）
    expect(lock.acquire('sid-1', 'compact', 'compact:2')).toBe(false);
    // 状态不变，仍是首次 acquire 的 runId
    expect(lock.getState('sid-1', 'compact').runId).toBe('compact:1');
  });
});

describe('SessionTaskLock — 不同 session / 不同 taskType 不阻塞（正交）', () => {
  it('不同 session 同 taskType 互不阻塞', () => {
    expect(lock.acquire('sid-A', 'compact', 'compact:A1')).toBe(true);
    // sid-B 不受 sid-A 持锁影响
    expect(lock.acquire('sid-B', 'compact', 'compact:B1')).toBe(true);
    expect(lock.getState('sid-A', 'compact').runId).toBe('compact:A1');
    expect(lock.getState('sid-B', 'compact').runId).toBe('compact:B1');
  });

  it('同 session 不同 taskType 互不阻塞', () => {
    expect(lock.acquire('sid-1', 'compact', 'compact:1')).toBe(true);
    // tier1 整理与 compact 不互斥（除非同 taskType）
    expect(lock.acquire('sid-1', 'tier1_consolidation', 'tier1:1')).toBe(true);
    expect(lock.getState('sid-1', 'compact').status).toBe('running');
    expect(lock.getState('sid-1', 'tier1_consolidation').status).toBe('running');
  });
});

describe('SessionTaskLock — release 后下一个 acquire 成功', () => {
  it('release(running) → idle，下一次 acquire 通过', () => {
    expect(lock.acquire('sid-1', 'compact', 'compact:1')).toBe(true);
    lock.release('sid-1', 'compact');
    expect(lock.getState('sid-1', 'compact').status).toBe('idle');
    // 复位 → 下一个 acquire 成功
    expect(lock.acquire('sid-1', 'compact', 'compact:2')).toBe(true);
    expect(lock.getState('sid-1', 'compact').runId).toBe('compact:2');
  });

  it('非 running 状态调 release 幂等 no-op（不变 state）', () => {
    // idle → release no-op
    lock.release('sid-1', 'compact');
    expect(lock.getState('sid-1', 'compact').status).toBe('idle');
    // done → release no-op
    lock.acquire('sid-1', 'compact', 'compact:1');
    lock.markDone('sid-1', 'compact');
    lock.release('sid-1', 'compact');
    expect(lock.getState('sid-1', 'compact').status).toBe('done');
  });
});

describe('SessionTaskLock — markDone / markFailed 后状态可读 + CAS 守卫放行', () => {
  it('markDone：running → done + 清 runId/startedAt/error', () => {
    lock.acquire('sid-1', 'compact', 'compact:1');
    lock.markDone('sid-1', 'compact');
    const st = lock.getState('sid-1', 'compact');
    expect(st.status).toBe('done');
    expect(st.runId).toBeNull();
    expect(st.startedAt).toBeNull();
    expect(st.error).toBeNull();
  });

  it('markFailed：running → failed + 设 error', () => {
    lock.acquire('sid-1', 'compact', 'compact:1');
    lock.markFailed('sid-1', 'compact', 'LLM timeout');
    const st = lock.getState('sid-1', 'compact');
    expect(st.status).toBe('failed');
    expect(st.error).toBe('LLM timeout');
  });

  it('done 后再 acquire 成功（done ∈ {idle,done,failed} 放行集合）', () => {
    lock.acquire('sid-1', 'compact', 'compact:1');
    lock.markDone('sid-1', 'compact');
    // done 后允许重试 acquire（spec §3.1 CAS WHERE state IN ('idle','done','failed') → 'running'）
    expect(lock.acquire('sid-1', 'compact', 'compact:2')).toBe(true);
    expect(lock.getState('sid-1', 'compact').status).toBe('running');
  });

  it('failed 后再 acquire 成功（failed 也 ∈ 放行集合）', () => {
    lock.acquire('sid-1', 'compact', 'compact:1');
    lock.markFailed('sid-1', 'compact', 'err');
    expect(lock.acquire('sid-1', 'compact', 'compact:2')).toBe(true);
    expect(lock.getState('sid-1', 'compact').status).toBe('running');
  });

  it('非 running 状态调 markDone / markFailed 幂等 no-op', () => {
    // idle → markDone no-op（仍 idle）
    lock.markDone('sid-1', 'compact');
    expect(lock.getState('sid-1', 'compact').status).toBe('idle');
    // idle → markFailed no-op（仍 idle）
    lock.markFailed('sid-1', 'compact', 'x');
    expect(lock.getState('sid-1', 'compact').status).toBe('idle');

    // done → markFailed no-op（仍 done，不变 failed）
    lock.acquire('sid-1', 'compact', 'c1');
    lock.markDone('sid-1', 'compact');
    lock.markFailed('sid-1', 'compact', 'late');
    expect(lock.getState('sid-1', 'compact').status).toBe('done');
  });
});

describe('SessionTaskLock — getState 不写 Map（避免查询污染）', () => {
  it('未 acquire 过的 (sid, task) → 返 idle 状态（不写 Map）', () => {
    const st = lock.getState('never-acquired', 'compact');
    expect(st.status).toBe('idle');
    expect(st.runId).toBeNull();
    // 后续 acquire 仍能成功（说明 getState 没有预先占位）
    expect(lock.acquire('never-acquired', 'compact', 'c1')).toBe(true);
  });
});

describe('SessionTaskLock — reconcileOnStartup（no-op 但保留契约）', () => {
  it('空 lock：返空 reconciled 列表', () => {
    const r = lock.reconcileOnStartup();
    expect(r.reconciled).toEqual([]);
  });

  it('有 running 状态的 lock：仍返空 reconciled（no-op；内存 only，无 fs 扫描）', () => {
    // 模拟「进程重启前 running」状态——但内存 only 时重启自然清空，reconcile 无对象可扫
    lock.acquire('sid-1', 'compact', 'c1');
    expect(lock.getState('sid-1', 'compact').status).toBe('running');

    // 实际生产中重启后 lock 是全新实例（Map 空）；此处直接调 reconcile 验证契约
    const r = lock.reconcileOnStartup();
    expect(r.reconciled).toEqual([]);
    // reconcile 不影响现有 running 状态（no-op，不清不扫）
    expect(lock.getState('sid-1', 'compact').status).toBe('running');
  });
});

// ============================================================
// [v0.0.78.bug] SSE 推送 — bus 注入 + CAS 状态变更 emit summary_task_update
// ============================================================

describe('SessionTaskLock — [v0.0.78.bug] SSE emit summary_task_update', () => {
  it('未注入 bus → CAS 成功也不 emit（无副作用，UT 兼容）', () => {
    // 不调 setSessionPanelBus；lock 应静默 no-op（不抛、不影响 acquire 返回值）
    expect(lock.acquire('sid-1', 'compact', 'c1')).toBe(true);
    expect(lock.getState('sid-1', 'compact').status).toBe('running');
  });

  it('acquire CAS 成功 → emit summary_task_update(status=running) 到 session_id:<sid> group', async () => {
    const { bus } = spyBus();
    lock.setSessionPanelBus(bus);
    const sid = 'sid-emit-1';

    const collectPromise = collectEmits(bus, sid);

    expect(lock.acquire(sid, 'compact', 'compact:1700000000')).toBe(true);
    const events = await collectPromise;

    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.type).toBe('summary_task_update');
    expect(evt.sessionId).toBe(sid);
    expect(evt.data.status).toBe('running');
    expect(evt.data.runId).toBe('compact:1700000000');
    expect(evt.data.startedAt).toBeTruthy();
    expect(evt.data.error).toBeNull();
    expect(evt.id).toBeTruthy();
    expect(evt.createdAt).toBeTruthy();
  });

  it('acquire CAS 失败（已被占）→ 不 emit（无状态变更）', async () => {
    const { bus } = spyBus();
    lock.setSessionPanelBus(bus);
    const sid = 'sid-emit-2';

    // 首次 acquire 成功（emit 一次）
    lock.acquire(sid, 'compact', 'c1');

    const collectPromise = collectEmits(bus, sid);
    // 第二次 acquire 应被 CAS 守卫挡住
    expect(lock.acquire(sid, 'compact', 'c2')).toBe(false);
    const events = await collectPromise;

    // 第二次没 emit（collectEmits 在 subscribe 之后 sleep 30ms，但只收第二次以后的 emit = 0）
    expect(events).toHaveLength(0);
  });

  it('markDone CAS 成功 → emit summary_task_update(status=done)', async () => {
    const { bus } = spyBus();
    lock.setSessionPanelBus(bus);
    const sid = 'sid-emit-3';
    lock.acquire(sid, 'compact', 'c1');

    const collectPromise = collectEmits(bus, sid);
    lock.markDone(sid, 'compact');
    const events = await collectPromise;

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('summary_task_update');
    expect(events[0]!.data.status).toBe('done');
    expect(events[0]!.data.runId).toBeNull();
    expect(events[0]!.data.error).toBeNull();
  });

  it('markFailed CAS 成功 → emit summary_task_update(status=failed, error)', async () => {
    const { bus } = spyBus();
    lock.setSessionPanelBus(bus);
    const sid = 'sid-emit-4';
    lock.acquire(sid, 'compact', 'c1');

    const collectPromise = collectEmits(bus, sid);
    lock.markFailed(sid, 'compact', 'LLM timeout');
    const events = await collectPromise;

    expect(events).toHaveLength(1);
    expect(events[0]!.data.status).toBe('failed');
    expect(events[0]!.data.error).toBe('LLM timeout');
  });

  it('release CAS 成功 → emit summary_task_update(status=idle)', async () => {
    const { bus } = spyBus();
    lock.setSessionPanelBus(bus);
    const sid = 'sid-emit-5';
    lock.acquire(sid, 'compact', 'c1');

    const collectPromise = collectEmits(bus, sid);
    lock.release(sid, 'compact');
    const events = await collectPromise;

    expect(events).toHaveLength(1);
    expect(events[0]!.data.status).toBe('idle');
  });

  it('非 running 状态调 markDone → no-op + 不 emit（幂等保护）', async () => {
    const { bus } = spyBus();
    lock.setSessionPanelBus(bus);
    const sid = 'sid-emit-6';

    const collectPromise = collectEmits(bus, sid);
    // 未 acquire 直接 markDone（idle → markDone）→ no-op
    lock.markDone(sid, 'compact');
    const events = await collectPromise;

    expect(events).toHaveLength(0);
    expect(lock.getState(sid, 'compact').status).toBe('idle');
  });

  it('不同 sid 互不影响（per-session group 隔离）', async () => {
    const { bus } = spyBus();
    lock.setSessionPanelBus(bus);

    const collectA = collectEmits(bus, 'sid-A');
    const collectB = collectEmits(bus, 'sid-B');

    lock.acquire('sid-A', 'compact', 'c-a');
    lock.acquire('sid-B', 'compact', 'c-b');

    const [eventsA, eventsB] = await Promise.all([collectA, collectB]);

    expect(eventsA).toHaveLength(1);
    expect(eventsA[0]!.sessionId).toBe('sid-A');
    expect(eventsA[0]!.data.runId).toBe('c-a');

    expect(eventsB).toHaveLength(1);
    expect(eventsB[0]!.sessionId).toBe('sid-B');
    expect(eventsB[0]!.data.runId).toBe('c-b');
  });
});
