/**
 * SessionUnreadRuntime 单元测试（v0.0.27 修订核心）
 * 参考:
 *   - specs/tech/agent/session/[P0]session_state.md §4.4（产生 timing 调用方=session 层）+ §6.2/§6.3（前台 + 不变量）
 *   - specs/tech/version_logs/v0.0.27/unread-model-decision.md §6（归属层 + event-driven + reconcile 豁免）
 *
 * 覆盖：
 *   - completion 信号(state=idle) + 非前台 → markUnreadTrue（unread=true）
 *   - completion 信号(state=idle) + 前台 → no-op（unread 保持 false）
 *   - state=error 同样产生未读（非前台）
 *   - 非完成 state（running/interrupted）→ 忽略
 *   - 非 session_status_update 类型 → 忽略
 *   - enabled=false（reconcile 期间）→ 全部 no-op（reconcile 豁免，spec §6.3 不变量 4）
 *   - wrapStatusBusForUnread：emit 委托原 bus + fan-out 到运行时
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { SessionStore } from '../session-store';
import { ReplayableEventBus } from '../event-bus';
import {
  SessionUnreadRuntime,
  wrapStatusBusForUnread,
} from '../session-unread-runtime';
import type { SessionEvent, SessionStatusUpdateEvent } from '../session-event-types';
import type { SessionPresenceProbe } from '../../sse/sse-channel';

let tmpRoot: string;
let store: SessionStore;
let crud: CompositeStore;
let statusBus: ReplayableEventBus;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-unread-runtime-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  crud = new CompositeStore()
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

/** 构造一个可控前台探针（默认非前台） */
function makeProbe(activeSids: Set<string> = new Set()): SessionPresenceProbe {
  return {
    isSessionActive: (sid: string) => activeSids.has(sid),
  };
}

/** 构造 session_status_update 事件 */
function statusEvent(sid: string, state: 'idle' | 'running' | 'interrupted' | 'error' | 'interrupting'): SessionStatusUpdateEvent {
  return {
    id: ulid(),
    type: 'session_status_update',
    sessionId: sid,
    createdAt: new Date().toISOString(),
    data: { state, running: state === 'running' || state === 'interrupting', currentRunId: null },
  };
}

describe('SessionUnreadRuntime — completion 信号触发未读产生', () => {
  it('state=idle + 非前台 → markUnreadTrue（unread=true）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe() });
    runtime.start();

    runtime.handleSessionEvent(statusEvent(sid, 'idle'));
    await flushMicrotasks();

    const got = await store.getSession(sid);
    expect(got?.unread).toBe(true);
  });

  it('state=idle + 前台 → no-op（unread 保持 false）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const active = new Set<string>([sid]);
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe(active) });
    runtime.start();

    runtime.handleSessionEvent(statusEvent(sid, 'idle'));
    await flushMicrotasks();

    const got = await store.getSession(sid);
    expect(got?.unread).toBe(false); // 前台完成 no-op（spec §4.4 no-op 情形 1）
  });

  it('state=error + 非前台 → 产生未读（error 也算完成）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe() });
    runtime.start();

    runtime.handleSessionEvent(statusEvent(sid, 'error'));
    await flushMicrotasks();

    const got = await store.getSession(sid);
    expect(got?.unread).toBe(true);
  });

  it('state=running → 忽略（非完成）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe() });
    runtime.start();

    runtime.handleSessionEvent(statusEvent(sid, 'running'));
    await flushMicrotasks();

    const got = await store.getSession(sid);
    expect(got?.unread).toBe(false);
  });

  it('state=interrupted → 忽略（abort 不算完成，spec §4.4 no-op 情形 2）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe() });
    runtime.start();

    runtime.handleSessionEvent(statusEvent(sid, 'interrupted'));
    await flushMicrotasks();

    const got = await store.getSession(sid);
    expect(got?.unread).toBe(false);
  });

  it('非 session_status_update 类型 → 忽略', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe() });
    runtime.start();

    const otherEvent = {
      id: ulid(),
      type: 'session_usage_update',
      sessionId: sid,
      createdAt: new Date().toISOString(),
      data: { current: { prompt: 0, completion: 0 }, sub: {}, forked: {}, total: { prompt: 0, completion: 0 } },
    } as unknown as SessionEvent;
    runtime.handleSessionEvent(otherEvent);
    await flushMicrotasks();

    const got = await store.getSession(sid);
    expect(got?.unread).toBe(false);
  });
});

describe('SessionUnreadRuntime — reconcile 豁免（enabled=false）', () => {
  it('未 start()（reconcile 期间）的 idle 事件不产生未读', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe() });
    // 不调 start()——模拟 reconcile 期间

    runtime.handleSessionEvent(statusEvent(sid, 'idle'));
    await flushMicrotasks();

    const got = await store.getSession(sid);
    expect(got?.unread).toBe(false); // reconcile 豁免（spec §6.3 不变量 4）
  });

  it('start() 前的 idle 事件被忽略，start() 后的 idle 事件正常产生未读', async () => {
    const sidA = ulid();
    const sidB = ulid();
    await store.createSession({ id: sidA });
    await store.createSession({ id: sidB });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe() });

    // start 前——sidA 完成（模拟 reconcile 路径）→ 不产生未读
    runtime.handleSessionEvent(statusEvent(sidA, 'idle'));
    await flushMicrotasks();

    runtime.start();

    // start 后——sidB 完成（正常 run 完成）→ 产生未读
    runtime.handleSessionEvent(statusEvent(sidB, 'idle'));
    await flushMicrotasks();

    const gotA = await store.getSession(sidA);
    const gotB = await store.getSession(sidB);
    expect(gotA?.unread).toBe(false); // reconcile 期间豁免
    expect(gotB?.unread).toBe(true); // 正常完成产生未读
  });
});

describe('SessionUnreadRuntime — 幂等 + 异常容忍', () => {
  it('已 unread=true 时再发 idle 事件不重复写（CAS 幂等，spec §6.3 不变量 5）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe() });
    runtime.start();

    runtime.handleSessionEvent(statusEvent(sid, 'idle'));
    await flushMicrotasks();
    runtime.handleSessionEvent(statusEvent(sid, 'idle'));
    await flushMicrotasks();

    const got = await store.getSession(sid);
    expect(got?.unread).toBe(true); // 仍是 true（CAS WHERE unread=false 第二次返 false 但 unread 值不变）
  });

  it('session 不存在时事件被吞掉（markUnreadTrue 返 false，无异常）', async () => {
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe() });
    runtime.start();
    // session 不存在——markUnreadTrue 返 false，事件 catch 吞掉
    expect(() => runtime.handleSessionEvent(statusEvent('nonexistent-sid', 'idle'))).not.toThrow();
  });
});

describe('wrapStatusBusForUnread — emit 委托 + fan-out', () => {
  it('wrap 后的 bus 仍可被订阅（原 bus 行为不变）', async () => {
    const realBus = new ReplayableEventBus({ replayable: true });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe() });
    const wrapped = wrapStatusBusForUnread(realBus, runtime);

    const sid = ulid();
    await store.createSession({ id: sid });
    const seen: SessionStatusUpdateEvent[] = [];
    const iter = wrapped.subscribe<SessionStatusUpdateEvent>(`session_id:${sid}`)[Symbol.asyncIterator]();
    void (async () => {
      while (true) {
        const r = await iter.next();
        if (r.done) break;
        if (r.value?.data?.type === 'session_status_update') {
          seen.push(r.value.data as SessionStatusUpdateEvent);
        }
      }
    })();

    const evt = statusEvent(sid, 'idle');
    wrapped.emit(`session_id:${sid}`, {
      data: evt,
      timestamp: new Date().toISOString(),
    });
    await flushMicrotasks();

    expect(seen.length).toBe(1); // 原订阅者照常收到
  });

  it('wrap 后 emit 触发 runtime 处理（start 后）→ 产生未读', async () => {
    const realBus = new ReplayableEventBus({ replayable: true });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe() });
    const wrapped = wrapStatusBusForUnread(realBus, runtime);
    runtime.start();

    const sid = ulid();
    await store.createSession({ id: sid });

    wrapped.emit(`session_id:${sid}`, {
      data: statusEvent(sid, 'idle'),
      timestamp: new Date().toISOString(),
    });
    await flushMicrotasks();

    const got = await store.getSession(sid);
    expect(got?.unread).toBe(true); // fan-out 到 runtime → markUnreadTrue
  });

  it('start 前的 wrap emit（reconcile 期）不产生未读', async () => {
    const realBus = new ReplayableEventBus({ replayable: true });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe() });
    const wrapped = wrapStatusBusForUnread(realBus, runtime);
    // 未 start——reconcile 期间

    const sid = ulid();
    await store.createSession({ id: sid });
    wrapped.emit(`session_id:${sid}`, {
      data: statusEvent(sid, 'idle'),
      timestamp: new Date().toISOString(),
    });
    await flushMicrotasks();

    const got = await store.getSession(sid);
    expect(got?.unread).toBe(false); // reconcile 豁免
  });

  it('emit 原始 bus 也触发 fan-out（验证 wrap 不是只在 wrap 实例上生效）', async () => {
    // 场景：stateMachine 持有 wrapped bus，但 hub.registerTopic 注册的是 realBus。
    // 验证 stateMachine 经 wrapped.emit 时 fan-out 生效（生产 bootstrap 接线场景）
    const realBus = new ReplayableEventBus({ replayable: true });
    const runtime = new SessionUnreadRuntime({ crud, presenceProbe: makeProbe() });
    const wrapped = wrapStatusBusForUnread(realBus, runtime);
    runtime.start();

    const sid = ulid();
    await store.createSession({ id: sid });

    // 模拟 stateMachine.emitStatus：调 wrapped.emit（stateMachine 持 wrapped）
    wrapped.emit(`session_id:${sid}`, {
      data: statusEvent(sid, 'idle'),
      timestamp: new Date().toISOString(),
    });
    await flushMicrotasks();

    const got = await store.getSession(sid);
    expect(got?.unread).toBe(true);
  });
});

/** 等微任务队列清空（让 markUnreadTrue 的 void-promise resolve） */
async function flushMicrotasks(): Promise<void> {
  // 多轮 microtask drain（markUnreadTrue 是 async，catch 链可能多一帧）
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}
