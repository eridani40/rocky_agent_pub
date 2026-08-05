/**
 * RunLifecyclePort onUsage 分区分派 UT（fork-1 usage 双计修复防线）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md §3.2
 *
 * 钉死 usage 累计口径：
 *   1. 旁路分区（summary/consolidate → forked 桶）→ onUsage 不调 updateUsage
 *      （caller 按 run 结束总量一次性累计——fork-1 在 runCompact；防「逐调用 + 总量」双计）
 *   2. main 分区（current）→ updateUsage({usagePartition:'current', usage})（写+推一体）
 *   3. sub 分区 → updateUsage({usagePartition:'sub', usage})
 *   4. usage=null → 零调用（不变）
 */
import { describe, it, expect, vi } from 'vitest';
import { RunLifecyclePort } from '../run-lifecycle-port';
import type { SessionStore } from '../session-store';
import type { SessionConfig } from '../context-types';
import type { ResolvedSessionProfile } from '../session-type-profile-loader';
import type { Message, Usage } from '../../message/types';
import { A2aReplyTracker } from '../a2a-reply-tracker';
import type { LoopState } from '../loop-ports';

const SID = 'sid-lifecycle';

function mkProfile(usagePartition: ResolvedSessionProfile['runShape']['usagePartition']): ResolvedSessionProfile {
  return {
    id: 'test-profile',
    enabled: true,
    toolBound: [],
    toolDefinitionsSource: 'own',
    runShape: { drainMode: 'eager', backgroundPath: false, maxIterDefault: 25, touchesStateMachine: true, persistsRun: true, usagePartition },
    lifecycleHooks: { abortFinalize: 'four-step', cascadeChildren: true },
    eventChannel: { emitDefault: true },
    modelHints: { readsSquadDefault: false },
    skillSource: 'none',
    eosStop: [],
    autoNaming: false,
    preloadContext: 'none',
  };
}

function mkStore(): SessionStore & {
  updateUsage: ReturnType<typeof vi.fn>;
} {
  return {
    updateUsage: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof mkStore>;
}

function mkPort(profile: ResolvedSessionProfile, store: SessionStore): RunLifecyclePort {
  return new RunLifecyclePort({
    config: { sessionId: SID } as SessionConfig,
    store,
    runId: 'run-1',
    profile,
  });
}

const USAGE = { input_tokens: 10, output_tokens: 5 } as unknown as Usage;

describe('RunLifecyclePort.onUsage — 分区分派', () => {
  it('summary 分区（→forked 桶）→ 不 updateUsage（caller 总量单计，防双计）', async () => {
    const store = mkStore();
    await mkPort(mkProfile('summary'), store).onUsage(USAGE);
    expect(store.updateUsage).not.toHaveBeenCalled();
  });

  it('consolidate 分区（→forked 桶）→ 不 updateUsage（同 summary 口径）', async () => {
    const store = mkStore();
    await mkPort(mkProfile('consolidate'), store).onUsage(USAGE);
    expect(store.updateUsage).not.toHaveBeenCalled();
  });

  it('current 分区 → updateUsage(sid, {usagePartition: current, usage})', async () => {
    const store = mkStore();
    await mkPort(mkProfile('current'), store).onUsage(USAGE);
    expect(store.updateUsage).toHaveBeenCalledWith(SID, { usagePartition: 'current', usage: USAGE });
  });

  it('sub 分区 → updateUsage(sid, {usagePartition: sub, usage})', async () => {
    const store = mkStore();
    await mkPort(mkProfile('sub'), store).onUsage(USAGE);
    expect(store.updateUsage).toHaveBeenCalledWith(SID, { usagePartition: 'sub', usage: USAGE });
  });

  it('usage=null → 零调用（不变）', async () => {
    const store = mkStore();
    await mkPort(mkProfile('current'), store).onUsage(null);
    expect(store.updateUsage).not.toHaveBeenCalled();
  });
});

// ── onRunEnd/onInterrupted — async subagent 回报兜底（replySettle） ──

const CHILD = SID; // 本 run 所属 subagent（config.sessionId）
const PARENT = 'parent-sid-1';

/** 支持 persistRun + 五态机 CAS 的 store mock（getRun 返 existing → updateRun 落库） */
function mkStoreFull(): SessionStore & {
  updateUsage: ReturnType<typeof vi.fn>;
  updateRun: ReturnType<typeof vi.fn>;
  getMessages: ReturnType<typeof vi.fn>;
  stateMachine: { markIdle: ReturnType<typeof vi.fn>; markError: ReturnType<typeof vi.fn>; markSuspended: ReturnType<typeof vi.fn> };
} {
  return {
    updateUsage: vi.fn(async () => {}),
    getRun: vi.fn(async () => ({ id: 'run-1' })),
    updateRun: vi.fn(async () => {}),
    getMessages: vi.fn(async () => ({
      items: [{ role: 'assistant', content: [{ type: 'text', text: 'FINAL-TEXT' }] }],
    })),
    stateMachine: {
      markIdle: vi.fn(async () => {}),
      markError: vi.fn(async () => {}),
      markSuspended: vi.fn(async () => {}),
    },
  } as unknown as ReturnType<typeof mkStoreFull>;
}

function mkState(stopReason: LoopState['stopReason'], reqs: { messageId: string; fromSessionId: string }[] = []): LoopState {
  return {
    ingestUpTo: null, llmUpTo: null, snapshot: null, step: 1, done: true,
    stopReason, agentReplyRequests: reqs,
  };
}

function mkSettlePort(store: SessionStore, deliverTo: (sid: string, msg: Message) => Promise<unknown>) {
  const tracker = new A2aReplyTracker();
  const port = new RunLifecyclePort({
    config: { sessionId: SID } as SessionConfig,
    store,
    runId: 'run-1',
    profile: mkProfile('current'),
    replySettle: { deliverTo, tracker, baseline: tracker.deliveryEpoch(), carried: [] },
  });
  return { port, tracker };
}

describe('RunLifecyclePort replySettle — async subagent 回报兜底', () => {
  const REQ = { messageId: 'm-1', fromSessionId: PARENT };

  it('tool_pending → 只 stash 不代发（续跑那轮才结算）+ 五态机 markSuspended', async () => {
    const store = mkStoreFull();
    const deliverTo = vi.fn(async (_sid: string, _msg: Message) => ({}));
    const { port, tracker } = mkSettlePort(store, deliverTo);
    await port.onRunEnd(mkState('tool_pending', [REQ]));
    expect(deliverTo).not.toHaveBeenCalled();
    expect(tracker.takePending(CHILD)).toEqual([REQ]); // stash 跨 run 携带
    expect(store.stateMachine.markSuspended).toHaveBeenCalledWith(SID, 'run-1');
  });

  it('no_tool_call 未履约 → settle 代发（deliverTo 被调，final text 回报）', async () => {
    const store = mkStoreFull();
    const deliverTo = vi.fn(async (_sid: string, _msg: Message) => ({}));
    const { port } = mkSettlePort(store, deliverTo);
    await port.onRunEnd(mkState('no_tool_call', [REQ]));
    expect(deliverTo).toHaveBeenCalledTimes(1);
    const msg = deliverTo.mock.calls[0]![1] as Message;
    expect((msg.content[0] as { text: string }).text).toBe('FINAL-TEXT');
    expect(msg.sender?.source === 'agent' && msg.sender.agent.needReply).toBe(false);
    expect(store.stateMachine.markIdle).toHaveBeenCalledWith(SID, 'run-1');
  });

  it('no_tool_call 已履约（baseline 后 child→parent 有投递）→ 不重复代发', async () => {
    const store = mkStoreFull();
    const deliverTo = vi.fn(async (_sid: string, _msg: Message) => ({}));
    const { port, tracker } = mkSettlePort(store, deliverTo);
    tracker.markDelivery(CHILD, PARENT); // 本 run LLM 已自觉 send_message 回 parent
    await port.onRunEnd(mkState('no_tool_call', [REQ]));
    expect(deliverTo).not.toHaveBeenCalled();
  });

  it('onInterrupted → settle(interrupted) 代发结局通知', async () => {
    const store = mkStoreFull();
    const deliverTo = vi.fn(async (_sid: string, _msg: Message) => ({}));
    const { port } = mkSettlePort(store, deliverTo);
    await port.onInterrupted(mkState(undefined, [REQ]));
    expect(deliverTo).toHaveBeenCalledTimes(1);
    const msg = deliverTo.mock.calls[0]![1] as Message;
    expect((msg.content[0] as { text: string }).text).toContain('interrupted');
  });

  it('replySettle 缺省 → 纯旧行为（persistRun + CAS 正常，零代发零异常）', async () => {
    const store = mkStoreFull();
    const port = mkPort(mkProfile('current'), store);
    await port.onRunEnd(mkState('no_tool_call', [REQ]));
    expect(store.updateRun).toHaveBeenCalled();
    expect(store.stateMachine.markIdle).toHaveBeenCalledWith(SID, 'run-1');
    await port.onInterrupted(mkState(undefined, [REQ])); // noop 不抛
  });

  it('settle 异常吞掉不阻断：deliverTo reject → onRunEnd 正常 resolve（CAS 已完成）', async () => {
    const store = mkStoreFull();
    const deliverTo = vi.fn(async (_sid: string, _msg: Message) => Promise.reject(new Error('parent gone')));
    const { port } = mkSettlePort(store, deliverTo);
    await expect(port.onRunEnd(mkState('error', [REQ]))).resolves.toBeUndefined();
    expect(store.stateMachine.markError).toHaveBeenCalledWith(SID, 'run-1');
  });
});
