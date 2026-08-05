/**
 * deliverTo wrapper + abort 级联 + running 并发上限 UT（v0.0.28 task-2）
 * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md
 *   - §4.1 deliverTo（统一投递入口，只需 sessionId 不碰 config）
 *   - §3.1 running 并发上限（全局 sub / 单 parent sub，超限拒）
 *   - §6 abort 单向级联（parent abort → in-flight child；child 挂不连坐 parent；传递性 grandchild）
 *
 * 白盒：测 ChildrenTracker + deliverTo + cascadeAbortChildren + checkRunningLimit 纯逻辑。
 *
 * 文件系统隔离：纯内存对象测试，无 fs 操作。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ChildrenTracker, deliverTo, cascadeAbortChildren, checkRunningLimit,
  ConcurrencyLimitError, LIMIT_GLOBAL_SUB, LIMIT_PER_PARENT_SUB,
  type DeliverToDeps, type CascadeAbortDeps,
} from '../agent-manager-children';
import type { Message } from '../../message/types';
import type { AgentRun, AbortResult } from '../agent-interface';

/** 构造 mock AgentRun */
function mockRun(sid: string): AgentRun {
  return {
    sessionId: sid, runKind: 'main', runId: 'r-' + sid,
    groupKey: 'g', state: 'running',
    promise: Promise.resolve({ answer: 'ok', usage: {}, stopReason: 'no_tool_call', rounds: 1 }),
  };
}

/** 构造 mock Message */
function mockMsg(sid: string): Message {
  return { id: 'm1', sessionId: sid, role: 'user', content: [{ type: 'text', text: 'task' }] };
}

describe('ChildrenTracker — 运行追踪容器', () => {
  it('track + untrack + trackedOf + perParentCount + globalSubCount', () => {
    const t = new ChildrenTracker();
    t.track('parent1', 'child1');
    t.track('parent1', 'child2');
    t.track('parent2', 'child3');
    expect(t.trackedOf('parent1')).toEqual(['child1', 'child2']);
    expect(t.trackedOf('parent2')).toEqual(['child3']);
    expect(t.perParentCount('parent1')).toBe(2);
    expect(t.globalSubCount()).toBe(3);
    t.untrack('parent1', 'child1');
    expect(t.perParentCount('parent1')).toBe(1);
    expect(t.globalSubCount()).toBe(2);
  });

  it('untrack 不存在的 child 不报错（幂等）', () => {
    const t = new ChildrenTracker();
    t.untrack('parent', 'child'); // 空 bucket 不报错
    expect(t.globalSubCount()).toBe(0);
  });

  it('bucket 清空后从 map 删除', () => {
    const t = new ChildrenTracker();
    t.track('p', 'c');
    t.untrack('p', 'c');
    expect(t.trackedOf('p')).toEqual([]);
    t.track('p', 'c2'); // 重新建 bucket 不报错
    expect(t.perParentCount('p')).toBe(1);
  });
});

describe('deliverTo — 统一投递入口', () => {
  it('deliverTo(sessionId, msg) = enqueue(sessionId, [msg]) + activate(sessionId)，新签名不碰 config', async () => {
    // [v0.0.31 去 config 重构] deliverTo 内部不再 resolveConfig（manager 内部封装）。
    //   deps 只持 enqueue(sessionId, msgs) + activate(sessionId) 新签名。
    const enqueue = vi.fn().mockResolvedValue(['e1']);
    const activate = vi.fn().mockResolvedValue(mockRun('s1'));
    const deps: DeliverToDeps = { enqueue, activate };

    const msg = mockMsg('s1');
    const run = await deliverTo(deps, 's1', msg);

    expect(enqueue).toHaveBeenCalledTimes(1);
    // enqueue 第一参 = sessionId（不碰 config——caller 不传）
    const enqueueCall = enqueue.mock.calls[0]!;
    expect(enqueueCall[0]).toBe('s1');
    expect(enqueueCall[1]).toEqual([msg]);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0]![0]).toBe('s1');
    expect(run.sessionId).toBe('s1');
  });
});

describe('cascadeAbortChildren — D6 单向级联', () => {
  it('parent abort → 遍历 in-flight child 级联中断（传递性到 grandchild）', async () => {
    const t = new ChildrenTracker();
    t.track('parent', 'child1');
    t.track('parent', 'child2');
    t.track('child1', 'grandchild'); // child1 也有 child → 级联传递性
    const aborted: string[] = [];
    const deps: CascadeAbortDeps = {
      abortChild: async (childSid) => {
        aborted.push(childSid);
        // 模拟传递性：abort child1 后级联到 grandchild（cascadeAbortChildren 递归）
        if (childSid === 'child1') {
          await cascadeAbortChildren(t, deps, childSid);
        }
        return { accepted: true };
      },
      getChildState: async (sid) => (sid === 'child2' ? 'idle' : 'running'), // child2 已 idle 跳过
    };
    await cascadeAbortChildren(t, deps, 'parent');
    expect(aborted).toContain('child1');
    expect(aborted).toContain('grandchild'); // 传递性级联
    expect(aborted).not.toContain('child2'); // 已 terminated 不级联
  });

  it('无 tracked child → no-op', async () => {
    const t = new ChildrenTracker();
    const deps: CascadeAbortDeps = {
      abortChild: vi.fn(),
      getChildState: vi.fn(),
    };
    await cascadeAbortChildren(t, deps, 'parent');
    expect(deps.abortChild).not.toHaveBeenCalled();
  });

  it('单 child 级联失败不阻断其他 child（best-effort）', async () => {
    const t = new ChildrenTracker();
    t.track('p', 'c1');
    t.track('p', 'c2');
    const aborted: string[] = [];
    const deps: CascadeAbortDeps = {
      abortChild: async (childSid) => {
        if (childSid === 'c1') throw new Error('fail');
        aborted.push(childSid);
        return { accepted: true };
      },
      getChildState: async () => 'running',
    };
    await cascadeAbortChildren(t, deps, 'p');
    expect(aborted).toEqual(['c2']); // c1 失败但 c2 仍执行
  });
});

describe('checkRunningLimit — O5 三限（超限拒）', () => {
  it('subagent 未超限 → 不抛', () => {
    const t = new ChildrenTracker();
    for (let i = 0; i < LIMIT_PER_PARENT_SUB - 1; i++) t.track('p', `c${i}`);
    expect(() => checkRunningLimit(t, 'subagent', 'p')).not.toThrow();
  });

  it('per-parent sub 超限 → throw ConcurrencyLimitError(per_parent_sub)', () => {
    const t = new ChildrenTracker();
    for (let i = 0; i < LIMIT_PER_PARENT_SUB; i++) t.track('p', `c${i}`);
    expect(() => checkRunningLimit(t, 'subagent', 'p')).toThrow(ConcurrencyLimitError);
    try {
      checkRunningLimit(t, 'subagent', 'p');
    } catch (e) {
      expect((e as ConcurrencyLimitError).which).toBe('per_parent_sub');
    }
  });

  it('global sub 超限 → throw ConcurrencyLimitError(global_sub)', () => {
    const t = new ChildrenTracker();
    // 分散到多个 parent 绕开 per-parent 限，撑爆全局
    for (let i = 0; i < LIMIT_GLOBAL_SUB; i++) t.track(`p${i}`, `c${i}`);
    expect(() => checkRunningLimit(t, 'subagent', 'newParent')).toThrow(ConcurrencyLimitError);
    try {
      checkRunningLimit(t, 'subagent', 'newParent');
    } catch (e) {
      expect((e as ConcurrencyLimitError).which).toBe('global_sub');
    }
  });

  it('main 不进 children tracker → checkRunningLimit 不抛（main 限留口）', () => {
    const t = new ChildrenTracker();
    t.track('p', 'c');
    expect(() => checkRunningLimit(t, 'main', 'p')).not.toThrow();
  });
});
