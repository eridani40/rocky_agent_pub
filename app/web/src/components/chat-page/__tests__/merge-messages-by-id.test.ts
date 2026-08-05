/**
 * merge-messages-by-id 单测（v0.0.81.compaction_bug 变更 E：UI dedup by-id merge）
 * 参考: specs/tech/version_logs/v0.0.81.compaction_bug/change_plan.md §3
 *
 * 覆盖：
 *   - 同 id 时优先保留 prev（SSE 累积态：含 tool_call 增量等 part 级状态）
 *   - incoming 自身去重保序
 *   - prepend=true（loadMore 续载）：incoming 在前，prev 独有 id 按原序补回
 *   - prepend=false（transcript fetch 整体替换）：不补 prev 独有 id（transcript 权威）
 */
import { describe, it, expect } from 'vitest';
import { mergeMessagesById } from '../merge-messages-by-id';
import type { Message } from '../types';

function mk(id: string, role: Message['role'] = 'user', text = ''): Message {
  return {
    id,
    sessionId: 'sid',
    role,
    content: text ? [{ type: 'text', text }] : [],
    createdAt: '2026-07-06T00:00:00.000Z',
  };
}

function mkWithParts(id: string): Message {
  // 模拟 SSE 累积态：含 tool_call block
  return {
    id,
    sessionId: 'sid',
    role: 'assistant',
    content: [
      { type: 'text', text: 'partial' },
      { type: 'tool_call', id: `${id}_call`, name: 'bash', arguments: { cmd: '...' } },
    ],
    createdAt: '2026-07-06T00:00:00.000Z',
  };
}

describe('[v0.0.81.E] mergeMessagesById', () => {
  it('prev 空 → 直接返回 incoming 副本', () => {
    const incoming = [mk('a'), mk('b')];
    const out = mergeMessagesById([], incoming, false);
    expect(out.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('incoming 空 → 返回 prev 不变', () => {
    const prev = [mk('a'), mk('b')];
    const out = mergeMessagesById(prev, [], false);
    expect(out).toBe(prev);
  });

  it('同 id 时优先保留 prev（不覆盖 SSE 累积的 tool_call 增量）', () => {
    // prev: a 含 tool_call block（SSE 累积态）
    // incoming: a 只有 text block（transcript fetch 初始态，不含增量）
    const prev = [mkWithParts('a')];
    const incoming = [mk('a', 'assistant', 'final')];
    const out = mergeMessagesById(prev, incoming, false);
    expect(out).toHaveLength(1);
    // 关键：返回的是 prev 那个（含 tool_call block），不是 incoming 的
    expect(out[0]).toBe(prev[0]);
    expect(out[0]!.content.some((b) => b.type === 'tool_call')).toBe(true);
  });

  it('incoming 自身去重保序（同 id 取第一条出现）', () => {
    const incoming = [mk('a'), mk('b'), mk('a'), mk('c')];
    const out = mergeMessagesById([], incoming, false);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('prepend=false（整体替换）：不补 prev 独有 id', () => {
    // prev 有 a, b, c；incoming 只 a → 输出只 a（transcript 权威，prev 中 b/c 不在新 transcript）
    const prev = [mk('a'), mk('b'), mk('c')];
    const incoming = [mk('a')];
    const out = mergeMessagesById(prev, incoming, false);
    expect(out.map((m) => m.id)).toEqual(['a']);
  });

  it('prepend=true（loadMore 续载）：incoming 在前，prev 独有 id 按原序补回', () => {
    // prev 有 new1, new2（近期，SSE 已渲染）
    // incoming 有 old1, old2（loadMore 拉的前页）
    // 结果：old1, old2, new1, new2
    const prev = [mk('new1'), mk('new2')];
    const incoming = [mk('old1'), mk('old2')];
    const out = mergeMessagesById(prev, incoming, true);
    expect(out.map((m) => m.id)).toEqual(['old1', 'old2', 'new1', 'new2']);
  });

  it('prepend=true 且同 id：取 prev 累积态（保留 SSE 增量）', () => {
    // 模拟：loadMore 拉的 incoming 含某条 id，prev 也已有（SSE 渲染中）→ 取 prev
    const prev = [mkWithParts('shared')];
    const incoming = [mk('shared', 'assistant', 'transcript-version')];
    const out = mergeMessagesById(prev, incoming, true);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(prev[0]); // 取 prev
  });

  it('prepend=true 且 incoming 与 prev 全不重叠 → 拼接保序', () => {
    const prev = [mk('p1'), mk('p2')];
    const incoming = [mk('i1'), mk('i2')];
    const out = mergeMessagesById(prev, incoming, true);
    expect(out.map((m) => m.id)).toEqual(['i1', 'i2', 'p1', 'p2']);
  });

  it('prepend=true 且 incoming 内部有重复 id → 去重', () => {
    const prev = [mk('p1')];
    const incoming = [mk('i1'), mk('i1'), mk('i2')];
    const out = mergeMessagesById(prev, incoming, true);
    expect(out.map((m) => m.id)).toEqual(['i1', 'i2', 'p1']);
  });
});
