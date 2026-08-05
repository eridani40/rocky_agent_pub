/**
 * drainAndPartition + emitDrainResult — 离线/在线统一 SSE emit UT
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_eager_drain.md §5.1
 *       specs/tech/scheduling/[P1]cron_subsystem.md §4（cronMessage 走统一 SSE）
 *
 * v0.0.58.cron-fix：验证「drain 的所有 message（含 system/agent/approval source）都 emit SSE」。
 * 之前只 user-source 走 emitUserMessageBlocks，cron/heartbeat tick/a2a 等系统消息入主对话 store
 * （GET /messages 能看到）但 SSE 实时看不到 → 离线/在线不统一。修复后 SSE 发的 = store 存的。
 *
 * 覆盖：
 *   - source='user' message 仍 emit SSE（回归）
 *   - source='system' message（cron-style：role='user' + sender.source='system'）emit SSE（核心修复）
 *   - source='agent' message（a2a-style：role='user' + sender.agent.ref）emit SSE
 *   - 混合批：user + system + agent 都 emit（顺序：user 在前，system/agent 在后）
 *   - cancel 配对的 message 不 emit message_*（只 emit canceled；回归）
 *   - system message 用重写后的新 messageId emit（与 store 入库 id 一致）
 */
import { describe, it, expect, vi } from 'vitest';
import type { ContentBlock, Message, MessageSender } from '../../message/types';
import { drainAndPartition, emitDrainResult } from '../agent-loop-stage-pre';
import { InboxStore } from '../inbox';
import type { EmitContext } from '../agent-loop-emitters';
import type { AgentEvent } from '../agent-event-types';
import type { ReplayableEventBus } from '../event-bus';

// ── 构造 helper ──────────────────────────────────────────────

function makeMsg(opts: {
  id?: string;
  role?: Message['role'];
  sender?: MessageSender;
  content?: ContentBlock[];
  metadata?: Record<string, unknown>;
}): Message {
  return {
    id: opts.id ?? '01TESTMSG0001',
    sessionId: '01TESTSID0001',
    role: opts.role ?? 'user',
    content: opts.content ?? [{ type: 'text', text: 'hello' }],
    ...(opts.sender ? { sender: opts.sender } : {}),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
}

/** mock bus：捕获所有 emit 事件（对齐 side-run-loop.test.ts:mockBus 风格） */
function mockBus(): { bus: ReplayableEventBus; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const bus = {
    emit(_group: string, e: { data: AgentEvent; timestamp: string }) {
      events.push(e.data);
    },
    subscribe: vi.fn(),
    clearReplay: vi.fn(),
    isReplayable: () => false,
  };
  return { bus: bus as unknown as ReplayableEventBus, events };
}

function makeCtx(bus: ReplayableEventBus): EmitContext {
  return {
    sessionId: '01TESTSID0001',
    runId: '01TESTRUN0001',
    runKind: 'main',
    bus,
    now: () => '2026-07-04T00:00:00.000Z',
  };
}

/** 提取事件 type 列表（便于断言「事件序列包含哪些 type」） */
function types(events: AgentEvent[]): string[] {
  return events.map((e) => e.type);
}

// ── 离线/在线统一：所有 source 都 emit SSE ────────────────────

describe('emitDrainResult — 离线/在线统一：所有 source 都 emit SSE', () => {
  it('source=user message 仍 emit SSE（回归）', () => {
    const inbox = new InboxStore();
    const sid = '01SID_USER';
    inbox.enqueue(sid, [
      makeMsg({
        id: '01USERMSG0001',
        role: 'user',
        sender: { source: 'user' },
        content: [{ type: 'text', text: '用户提问' }],
      }),
    ]);

    const { bus, events } = mockBus();
    const result = drainAndPartition(inbox, sid);
    emitDrainResult(makeCtx(bus), result);

    // 期望序列：message_start → text_block_start → text_block_delta → text_block_end → message_end
    //          + enqueued_message_processed
    const t = types(events);
    expect(t).toContain('message_start');
    expect(t).toContain('text_block_delta');
    expect(t).toContain('message_end');
    expect(t).toContain('enqueued_message_processed');
    // 不应发 canceled
    expect(t).not.toContain('enqueued_message_canceled');
  });

  it('source=system message（cron-style）emit SSE（核心修复）', () => {
    const inbox = new InboxStore();
    const sid = '01SID_CRON';
    // 模拟 buildCronUserMessage 产出的 cron message：
    // role='user' + sender.source='system' + system.kind='cron' + metadata.cron
    inbox.enqueue(sid, [
      makeMsg({
        id: '01CRONMSG001',
        role: 'user',
        sender: { source: 'system', system: { kind: 'cron', refId: sid } },
        content: [{ type: 'text', text: '[cron:check-todo] 检查 todo' }],
        metadata: { cron: { at: '2026-07-04T00:00:00.000Z', name: 'check-todo', prompt: '检查 todo' } },
      }),
    ]);

    const { bus, events } = mockBus();
    const result = drainAndPartition(inbox, sid);
    emitDrainResult(makeCtx(bus), result);

    // 核心修复断言：system-source message 也 emit message_start/blocks/end（不再只进 store 不发 SSE）
    const t = types(events);
    expect(t).toContain('message_start');
    expect(t.filter((x) => x === 'text_block_delta')).toHaveLength(1);
    expect(t).toContain('message_end');
    expect(t).toContain('enqueued_message_processed');

    // 验证 message_start 用的是重写后的新 messageId（与 newMessages/processed 同 id，与 store 入库一致）
    const starts = events.filter((e) => e.type === 'message_start');
    expect(starts).toHaveLength(1);
    const start = starts[0]!;
    const processed = events.filter((e) => e.type === 'enqueued_message_processed');
    const processedMsgId = processed[0]!.messageId;
    expect(start.messageId).toBe(processedMsgId);
    // 重写后 id 应不同于原 cron message id
    expect(start.messageId).not.toBe('01CRONMSG001');
    // role 透传为 user（cron message role='user'，前端 flatten 走 user 分支默认展示）
    expect(start.role).toBe('user');
  });

  it('source=agent message（a2a-style）emit SSE', () => {
    const inbox = new InboxStore();
    const sid = '01SID_A2A';
    inbox.enqueue(sid, [
      makeMsg({
        id: '01A2AMSG0001',
        role: 'user',
        sender: {
          source: 'agent',
          agent: {
            ref: { type: 'mate', sessionId: '01PARENTSID', name: 'explorer' },
            needReply: false,
          },
        },
        content: [{ type: 'text', text: '任务完成' }],
      }),
    ]);

    const { bus, events } = mockBus();
    const result = drainAndPartition(inbox, sid);
    emitDrainResult(makeCtx(bus), result);

    const t = types(events);
    expect(t).toContain('message_start');
    expect(t).toContain('text_block_delta');
    expect(t).toContain('message_end');
    expect(t).toContain('enqueued_message_processed');
  });

  it('混合批：user + system + agent 都 emit message_start/blocks/end', () => {
    const inbox = new InboxStore();
    const sid = '01SID_MIX';
    inbox.enqueue(sid, [
      makeMsg({
        id: '01MIX_USER_01',
        role: 'user',
        sender: { source: 'user' },
        content: [{ type: 'text', text: 'q1' }],
      }),
      makeMsg({
        id: '01MIX_CRON_01',
        role: 'user',
        sender: { source: 'system', system: { kind: 'cron', refId: sid } },
        content: [{ type: 'text', text: '[cron:x] do' }],
      }),
      makeMsg({
        id: '01MIX_A2A_01',
        role: 'user',
        sender: {
          source: 'agent',
          agent: {
            ref: { type: 'mate', sessionId: '01P', name: 'm' },
            needReply: false,
          },
        },
        content: [{ type: 'text', text: 'a2a' }],
      }),
    ]);

    const { bus, events } = mockBus();
    const result = drainAndPartition(inbox, sid);
    emitDrainResult(makeCtx(bus), result);

    // 3 条 message 都 emit message_start（核心：之前只有 user 1 条，现在 3 条）
    const starts = events.filter((e) => e.type === 'message_start');
    expect(starts).toHaveLength(3);
    // 3 条 text_block_delta（每条 message 1 个 text block）
    expect(types(events).filter((x) => x === 'text_block_delta')).toHaveLength(3);
    // 3 条 message_end
    expect(types(events).filter((x) => x === 'message_end')).toHaveLength(3);
    // 3 条 enqueued_message_processed
    expect(types(events).filter((x) => x === 'enqueued_message_processed')).toHaveLength(3);
    // [v0.0.161] 全部 source（user/system/agent）drain 时 reissue 新 id — 三分支对称化后
    //   原 id 都不再作为 SSE emit 使用；processed 事件里的 messageId 就是新 id。
    const userStart = starts.find((e) => e.messageId === '01MIX_USER_01');
    expect(userStart).toBeUndefined(); // v0.0.161 user 也 reissue，原 id 不再出现
    const cronStart = starts.find((e) => e.messageId === '01MIX_CRON_01');
    expect(cronStart).toBeUndefined(); // system 分支同样 reissue（既有）
    const a2aStart = starts.find((e) => e.messageId === '01MIX_A2A_01');
    expect(a2aStart).toBeUndefined();  // agent 分支同样 reissue（既有）
    // 3 条 start 都是 26 位 reissued ulid（一致性检查）
    for (const s of starts) {
      expect(s.messageId).toBeDefined();
      expect(s.messageId!.length).toBe(26);
    }
  });

  it('cancel 配对的 message 不 emit message_*（只 emit canceled，回归）', () => {
    const inbox = new InboxStore();
    const sid = '01SID_CANCEL';
    const m = makeMsg({
      id: '01CANCELMSG01',
      role: 'user',
      sender: { source: 'user' },
      content: [{ type: 'text', text: 'cancel me' }],
    });
    const [eid] = inbox.enqueue(sid, [m]);
    inbox.appendCancel(sid, eid!);

    const { bus, events } = mockBus();
    const result = drainAndPartition(inbox, sid);
    emitDrainResult(makeCtx(bus), result);

    // 作废的 message 不 emit message_start/blocks/end
    const t = types(events);
    expect(t).not.toContain('message_start');
    expect(t).not.toContain('text_block_delta');
    expect(t).not.toContain('message_end');
    // 只 emit canceled（不 emit processed）
    expect(t).toContain('enqueued_message_canceled');
    expect(t).not.toContain('enqueued_message_processed');
  });

  it('system message 的 SSE emit id == 入库 id（与 GET /messages 同源）', () => {
    const inbox = new InboxStore();
    const sid = '01SID_ID_CONSISTENCY';
    inbox.enqueue(sid, [
      makeMsg({
        id: '01ORIG_CRON_ID',
        role: 'user',
        sender: { source: 'system', system: { kind: 'cron', refId: sid } },
        content: [{ type: 'text', text: '[cron] x' }],
      }),
    ]);

    const result = drainAndPartition(inbox, sid);

    // newMessages（→ ingest → store）的 id 与 systemMessages（→ SSE emit）的 id 必须一致
    expect(result.newMessages).toHaveLength(1);
    expect(result.systemMessages).toHaveLength(1);
    const ingestId = result.newMessages[0]!.id;
    const emitId = result.systemMessages[0]!.id;
    expect(ingestId).toBe(emitId);
    // 重写后 ≠ 原 id
    expect(ingestId).not.toBe('01ORIG_CRON_ID');

    // processed 列表的 messageId 也用同一个重写 id（前端 enqueue-view 配对依赖一致）
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]!.messageId).toBe(ingestId);
  });
});
