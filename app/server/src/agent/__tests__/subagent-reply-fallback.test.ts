/**
 * async subagent 回报兜底 UT（v0.0.255）
 * 参考: specs/tech/version_logs/v0.0.255/change_plan.md（判定规则全表）
 *
 * 覆盖三层：
 *   1. A2aReplyTracker：markDelivery/deliveryEpoch/hasDeliverySince/stashPending/takePending
 *   2. drainAndPartition 收集：agent+needReply=true 收集（reissue 后 id）；其他来源不收集
 *   3. settleAgentReplyFallback：已履约跳过 / 成功代发 final text / final 空退化通知 /
 *      error·interrupted·doom_loop·max_iterations 结局通知 / 多 sender 去重 / carried 合并 /
 *      deliverTo 失败 best-effort
 */
import { describe, it, expect, vi } from 'vitest';
import type { ContentBlock, Message, MessageSender } from '../../message/types';
import { A2aReplyTracker } from '../a2a-reply-tracker';
import { settleAgentReplyFallback, type ReplyFallbackDeps } from '../subagent-reply-fallback';
import { drainAndPartition } from '../agent-loop-stage-pre';
import { InboxStore } from '../inbox';
import type { AgentReplyRequest, LoopState } from '../loop-ports';
import { LlmErrorCategory } from '../../llm/caller/error_types';

const CHILD = 'child-sid-1';
const PARENT = 'parent-sid-1';

// ── A2aReplyTracker ─────────────────────────────────────────

describe('A2aReplyTracker', () => {
  it('markDelivery 后 hasDeliverySince（baseline 之前）=true；（baseline 之后）=false', () => {
    const t = new A2aReplyTracker();
    const baseline = t.deliveryEpoch();
    expect(t.hasDeliverySince(CHILD, PARENT, baseline)).toBe(false); // 无记录返 false
    t.markDelivery(CHILD, PARENT);
    expect(t.hasDeliverySince(CHILD, PARENT, baseline)).toBe(true);
    expect(t.hasDeliverySince(CHILD, PARENT, t.deliveryEpoch())).toBe(false); // 同 epoch 不算 since 之后
  });

  it('deliveryEpoch 单调递增；不同 from/to 对互不影响', () => {
    const t = new A2aReplyTracker();
    t.markDelivery('a', 'b');
    const e1 = t.deliveryEpoch();
    t.markDelivery('c', 'd');
    expect(t.deliveryEpoch()).toBeGreaterThan(e1);
    expect(t.hasDeliverySince('a', 'b', 0)).toBe(true);
    expect(t.hasDeliverySince('a', 'd', 0)).toBe(false);
    expect(t.hasDeliverySince('c', 'b', 0)).toBe(false);
  });

  it('stashPending/takePending：take 返回所存 + take 即清 + 空 reqs 不写桶', () => {
    const t = new A2aReplyTracker();
    const reqs: AgentReplyRequest[] = [{ messageId: 'm1', fromSessionId: PARENT }];
    t.stashPending(CHILD, []);
    expect(t.takePending(CHILD)).toEqual([]); // 空不写桶
    t.stashPending(CHILD, reqs);
    expect(t.takePending(CHILD)).toEqual(reqs);
    expect(t.takePending(CHILD)).toEqual([]); // take 即清（防双 run 重复结算）
  });
});

// ── drainAndPartition 收集 agentReplyRequests ───────────────

function mkAgentMsg(id: string, needReply: boolean, fromSid = PARENT): Message {
  const sender: MessageSender = {
    source: 'agent',
    agent: { ref: { type: 'rocky', sessionId: fromSid, name: 'parent' }, needReply },
  };
  return { id, sessionId: CHILD, role: 'user', content: [{ type: 'text', text: 'task' }], sender };
}

function drainOne(msg: Message) {
  const inbox = new InboxStore();
  inbox.enqueue(CHILD, [msg]);
  return drainAndPartition(inbox, CHILD);
}

describe('drainAndPartition — agentReplyRequests 收集', () => {
  it('agent+needReply=true → 收集（messageId=reissue 后新 id，非 inbox 原 id）', () => {
    const r = drainOne(mkAgentMsg('01ORIGID0001', true));
    expect(r.agentReplyRequests).toHaveLength(1);
    expect(r.agentReplyRequests[0]!.fromSessionId).toBe(PARENT);
    expect(r.agentReplyRequests[0]!.messageId).not.toBe('01ORIGID0001');
    expect(r.agentReplyRequests[0]!.messageId).toBe(r.newMessages[0]!.id);
  });

  it('agent+needReply=false → 不收集', () => {
    expect(drainOne(mkAgentMsg('01ORIGID0002', false)).agentReplyRequests).toEqual([]);
  });

  it('user/system/approval 来源 → 不收集', () => {
    const user: Message = { id: 'u1', sessionId: CHILD, role: 'user', content: [], sender: { source: 'user' } };
    expect(drainOne(user).agentReplyRequests).toEqual([]);
    const sys: Message = { id: 's1', sessionId: CHILD, role: 'user', content: [], sender: { source: 'system' } as Message['sender'] };
    expect(drainOne(sys).agentReplyRequests).toEqual([]);
  });

  it('被 cancel 作废的 agent 消息 → 不收集', () => {
    const inbox = new InboxStore();
    const [enqueueId] = inbox.enqueue(CHILD, [mkAgentMsg('01ORIGID0003', true)]);
    inbox.appendCancel(CHILD, enqueueId!);
    const r = drainAndPartition(inbox, CHILD);
    expect(r.canceledEnqueueIds).toEqual([enqueueId]);
    expect(r.agentReplyRequests).toEqual([]);
  });
});

// ── settleAgentReplyFallback ────────────────────────────────

function mkState(reqs: AgentReplyRequest[], displayReason?: string): LoopState {
  return {
    ingestUpTo: null, llmUpTo: null, snapshot: null, step: 1, done: true,
    agentReplyRequests: reqs,
    ...(displayReason
      ? { error: { errorCategory: LlmErrorCategory.RATE_LIMITED, displayReason } }
      : {}),
  };
}

function mkDeps(overrides: Partial<ReplyFallbackDeps> = {}) {
  const tracker = new A2aReplyTracker();
  const store = {
    getMessages: vi.fn(async () => ({
      items: [{ role: 'assistant', content: [{ type: 'text', text: 'FINAL-TEXT' }] }],
    })),
  };
  const deliverTo = vi.fn(async (_targetSid: string, _msg: Message) => ({}));
  const deps: ReplyFallbackDeps = {
    childSid: CHILD, store, deliverTo, tracker,
    baseline: tracker.deliveryEpoch(), carried: [],
    ...overrides,
  };
  return { deps, tracker, store, deliverTo };
}

const REQ: AgentReplyRequest = { messageId: 'm-latest', fromSessionId: PARENT };

function deliveredMsg(deliverTo: ReturnType<typeof vi.fn>, idx = 0): Message {
  return deliverTo.mock.calls[idx]![1] as Message;
}

describe('settleAgentReplyFallback', () => {
  it('已履约（baseline 后 child→parent 有投递）→ 跳过代发', async () => {
    const { deps, tracker, deliverTo } = mkDeps();
    tracker.markDelivery(CHILD, PARENT); // 本 run 内 LLM 已自觉 send_message 回 parent
    await settleAgentReplyFallback(mkState([REQ]), deps, 'no_tool_call');
    expect(deliverTo).not.toHaveBeenCalled();
  });

  it('空请求集 → 零代发', async () => {
    const { deps, deliverTo } = mkDeps();
    await settleAgentReplyFallback(mkState([]), deps, 'no_tool_call');
    expect(deliverTo).not.toHaveBeenCalled();
  });

  it('no_tool_call 未履约 → 代发 final text（child 身份 + needReply=false + inReplyTo=M.id）', async () => {
    const { deps, deliverTo } = mkDeps();
    await settleAgentReplyFallback(mkState([REQ]), deps, 'no_tool_call');
    expect(deliverTo).toHaveBeenCalledTimes(1);
    expect(deliverTo.mock.calls[0]![0]).toBe(PARENT);
    const msg = deliveredMsg(deliverTo);
    expect(msg.sessionId).toBe(PARENT);
    expect(msg.role).toBe('user');
    expect((msg.content[0] as { text: string }).text).toBe('FINAL-TEXT');
    expect(msg.sender?.source).toBe('agent');
    if (msg.sender?.source === 'agent') {
      expect(msg.sender.agent.ref.sessionId).toBe(CHILD); // 以 child 身份
      expect(msg.sender.agent.needReply).toBe(false); // 防回话风暴
      expect(msg.sender.agent.inReplyTo).toBe('m-latest');
    }
  });

  it('final text 取不到（无 assistant message）→ 退化为结局通知文案', async () => {
    const { deps, deliverTo, store } = mkDeps();
    store.getMessages.mockResolvedValue({ items: [] });
    await settleAgentReplyFallback(mkState([REQ]), deps, 'no_tool_call');
    const text = (deliveredMsg(deliverTo).content[0] as { text: string }).text;
    expect(text).toContain('未产出文本结果');
  });

  it('no_new_messages 也走成功分支（代发 final text）', async () => {
    const { deps, deliverTo } = mkDeps();
    await settleAgentReplyFallback(mkState([REQ]), deps, 'no_new_messages');
    expect((deliveredMsg(deliverTo).content[0] as { text: string }).text).toBe('FINAL-TEXT');
  });

  it('error → 结局通知（含 stopReason + displayReason；needReply=false + inReplyTo）', async () => {
    const { deps, deliverTo } = mkDeps();
    await settleAgentReplyFallback(mkState([REQ], '模型限流'), deps, 'error');
    const msg = deliveredMsg(deliverTo);
    const text = (msg.content[0] as { text: string }).text;
    expect(text).toContain('error');
    expect(text).toContain('模型限流');
    expect(msg.sender?.source === 'agent' && msg.sender.agent.needReply).toBe(false);
    expect(msg.sender?.source === 'agent' && msg.sender.agent.inReplyTo).toBe('m-latest');
  });

  it.each(['interrupted', 'doom_loop', 'max_iterations'] as const)(
    '%s → 结局通知（含 stopReason，不读 transcript）',
    async (reason) => {
      const { deps, deliverTo, store } = mkDeps();
      await settleAgentReplyFallback(mkState([REQ]), deps, reason);
      const text = (deliveredMsg(deliverTo).content[0] as { text: string }).text;
      expect(text).toContain(reason);
      expect(store.getMessages).not.toHaveBeenCalled();
    },
  );

  it('多 sender 去重：同 sender 多条取最新 M.id（一次代发）', async () => {
    const { deps, deliverTo } = mkDeps();
    const reqs: AgentReplyRequest[] = [
      { messageId: 'm-old', fromSessionId: PARENT },
      { messageId: 'm-new', fromSessionId: PARENT },
    ];
    await settleAgentReplyFallback(mkState(reqs), deps, 'error');
    expect(deliverTo).toHaveBeenCalledTimes(1);
    const msg = deliveredMsg(deliverTo);
    expect(msg.sender?.source === 'agent' && msg.sender.agent.inReplyTo).toBe('m-new');
  });

  it('carried 合并：state 空 + carried 有（跨 run 未决）→ 仍结算', async () => {
    const { deps, deliverTo } = mkDeps({ carried: [REQ] });
    await settleAgentReplyFallback(mkState([]), deps, 'error');
    expect(deliverTo).toHaveBeenCalledTimes(1);
  });

  it('deliverTo 失败 best-effort：单 sender 失败续下一条，不抛出', async () => {
    const tracker = new A2aReplyTracker();
    const deliverTo = vi
      .fn()
      .mockRejectedValueOnce(new Error('parent gone'))
      .mockResolvedValueOnce({});
    const deps: ReplyFallbackDeps = {
      childSid: CHILD,
      store: { getMessages: vi.fn(async () => ({ items: [] })) },
      deliverTo, tracker, baseline: tracker.deliveryEpoch(), carried: [],
    };
    const reqs: AgentReplyRequest[] = [
      { messageId: 'm1', fromSessionId: 'p1' },
      { messageId: 'm2', fromSessionId: 'p2' },
    ];
    await expect(settleAgentReplyFallback(mkState(reqs), deps, 'error')).resolves.toBeUndefined();
    expect(deliverTo).toHaveBeenCalledTimes(2);
  });
});
