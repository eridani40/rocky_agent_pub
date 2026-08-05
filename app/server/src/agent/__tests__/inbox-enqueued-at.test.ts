/**
 * InboxStore enqueuedAt 字段单元测试（v0.0.31 Task5）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md §2
 *
 * 验证点（task.json acceptanceCriteria）：
 *   - enqueue（写 message 条目）落库条目含 enqueuedAt（isoDate 格式）
 *   - appendCancel（写 cancel 条目）落库条目含 enqueuedAt
 *   - drain 取出的条目保留 enqueuedAt
 */
import { describe, it, expect } from 'vitest';
import { InboxStore, type InboxEntry } from '../inbox';
import type { Message } from '../../message/types';

/** isoDate 字符串校验：YYYY-MM-DDTHH:mm:ss.sssZ 形式（Date.parse 可解析 + 以 Z 结尾） */
function isIsoDate(s: unknown): boolean {
  if (typeof s !== 'string' || !s.endsWith('Z')) return false;
  const parsed = Date.parse(s);
  return Number.isFinite(parsed);
}

/** 构造最小可用 Message（仅满足类型约束；字段值无关紧要，本测试只看信封 enqueuedAt） */
function mkMessage(role: Message['role'] = 'user'): Message {
  return {
    id: 'msg-' + Math.random().toString(36).slice(2),
    role,
    content: 'x',
    sender: { source: 'user' },
    sessionId: 'sess-x',
    createdAt: new Date().toISOString(),
  } as unknown as Message;
}

describe('InboxStore enqueuedAt（v0.0.31 Task5）', () => {
  it('enqueue 落库的 message 条目含 enqueuedAt（isoDate）', () => {
    const inbox = new InboxStore();
    const sid = 'sess-1';

    const [eid] = inbox.enqueue(sid, [mkMessage()]);

    const peeked = inbox.peek(sid);
    expect(peeked).toHaveLength(1);
    const entry = peeked[0] as Extract<InboxEntry, { kind: 'message' }>;
    expect(entry.kind).toBe('message');
    expect(entry.enqueueId).toBe(eid);
    // 核心断言：enqueuedAt 存在 + isoDate 格式
    expect(isIsoDate(entry.enqueuedAt)).toBe(true);
  });

  it('enqueue 多条消息：每条都各自注入 enqueuedAt', () => {
    const inbox = new InboxStore();
    const sid = 'sess-2';

    inbox.enqueue(sid, [mkMessage('user'), mkMessage('assistant'), mkMessage('user')]);

    const peeked = inbox.peek(sid);
    expect(peeked).toHaveLength(3);
    for (const e of peeked) {
      expect(e.kind).toBe('message');
      expect(isIsoDate((e as { enqueuedAt: unknown }).enqueuedAt)).toBe(true);
    }
  });

  it('appendCancel 落库的 cancel 条目含 enqueuedAt（isoDate）', () => {
    const inbox = new InboxStore();
    const sid = 'sess-3';

    const [targetEid] = inbox.enqueue(sid, [mkMessage()]);
    expect(targetEid).toBeDefined();
    inbox.appendCancel(sid, targetEid!);

    const peeked = inbox.peek(sid);
    expect(peeked).toHaveLength(2);

    const cancelEntry = peeked.find(
      (e): e is Extract<InboxEntry, { kind: 'cancel' }> => e.kind === 'cancel',
    );
    expect(cancelEntry).toBeDefined();
    expect(cancelEntry?.cancelFor).toBe(targetEid);
    // 核心断言：cancel 条目也含 enqueuedAt（isoDate）
    expect(isIsoDate(cancelEntry?.enqueuedAt)).toBe(true);
  });

  it('appendCancel 不带 message 上下文也注入 enqueuedAt（兜底 cancel 来晚场景）', () => {
    const inbox = new InboxStore();
    const sid = 'sess-4';

    // message 已被 drain / 不存在，appendCancel 仍可独立追加（见 removeMessage 失败兜底路径）
    inbox.appendCancel(sid, '01XXXXXXX-not-exist');

    const peeked = inbox.peek(sid);
    expect(peeked).toHaveLength(1);
    const cancelEntry = peeked[0] as Extract<InboxEntry, { kind: 'cancel' }>;
    expect(cancelEntry.kind).toBe('cancel');
    expect(isIsoDate(cancelEntry.enqueuedAt)).toBe(true);
  });

  it('drain 取出的条目保留 enqueuedAt（message + cancel 均透传）', () => {
    const inbox = new InboxStore();
    const sid = 'sess-5';

    const [eid1, eid2] = inbox.enqueue(sid, [mkMessage(), mkMessage()]);
    expect(eid1).toBeDefined();
    expect(eid2).toBeDefined();
    inbox.appendCancel(sid, eid1!);

    const drained = inbox.drain(sid);
    expect(drained).toHaveLength(3);

    // drain 后 inbox 清空（保留语义不变）
    expect(inbox.drain(sid)).toEqual([]);

    // message 条目
    const msgEntries = drained.filter(
      (e): e is Extract<InboxEntry, { kind: 'message' }> => e.kind === 'message',
    );
    expect(msgEntries).toHaveLength(2);
    expect(msgEntries.map((e) => e.enqueueId).sort()).toEqual([eid1, eid2].sort());
    for (const e of msgEntries) {
      expect(isIsoDate(e.enqueuedAt)).toBe(true);
    }

    // cancel 条目
    const cancelEntries = drained.filter(
      (e): e is Extract<InboxEntry, { kind: 'cancel' }> => e.kind === 'cancel',
    );
    expect(cancelEntries).toHaveLength(1);
    const cancelEntry = cancelEntries[0];
    expect(cancelEntry?.cancelFor).toBe(eid1);
    expect(isIsoDate(cancelEntry?.enqueuedAt)).toBe(true);
  });

  it('enqueuedAt 反映"进 inbox 的时刻"（非消息自身 createdAt）', () => {
    const inbox = new InboxStore();
    const sid = 'sess-6';

    // 构造一条 createdAt 很久远的 message
    const oldMsg = mkMessage();
    oldMsg.createdAt = '2020-01-01T00:00:00.000Z';

    const beforeAppend = Date.now();
    inbox.enqueue(sid, [oldMsg]);
    const afterAppend = Date.now();

    const [entry] = inbox.peek(sid) as Extract<InboxEntry, { kind: 'message' }>[];
    // entry 经下标解构得 undefined（noUncheckedIndexedAccess），用非空断言（前面 expect toHaveLength(1) 已守卫）
    expect(entry).toBeDefined();
    const enqueuedMs = Date.parse(entry!.enqueuedAt);

    // enqueuedAt 应接近 enqueue 调用时刻（与 createdAt 解耦）
    expect(enqueuedMs).toBeGreaterThanOrEqual(beforeAppend);
    expect(enqueuedMs).toBeLessThanOrEqual(afterAppend);
    // 且不等于 message.createdAt
    expect(entry!.enqueuedAt).not.toBe(oldMsg.createdAt);
  });
});
