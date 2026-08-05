// @vitest-environment jsdom
/**
 * message-flatten 单测 —— 视图层合并核心（§2 rule4/5/6）
 * 参考: specs/ui/components/chat-page/_overview.md §2
 */
import { describe, it, expect } from 'vitest';
import {
  flattenMessages,
  groupToolBatches,
  flattenAndGroup,
  buildToolResultMap,
} from '../message-flatten';
import type { Message } from '../types';

const userMsg = (id: string, text: string): Message => ({
  id,
  sessionId: 'S1',
  role: 'user',
  content: [{ type: 'text', text }],
  createdAt: '2026-06-21T00:00:00Z',
  sender: { source: 'user' },
});

const assistantMsg = (id: string, content: Message['content']): Message => ({
  id,
  sessionId: 'S1',
  role: 'assistant',
  content,
  createdAt: '2026-06-21T00:00:01Z',
  runId: 'R1',
});

const toolMsg = (id: string, toolCallId: string, text: string, isError = false): Message => ({
  id,
  sessionId: 'S1',
  role: 'tool',
  content: [{ type: 'tool_result', toolCallId, content: [{ type: 'text', text }], isError }],
  createdAt: '2026-06-21T00:00:02Z',
});

describe('flattenMessages — 基础', () => {
  it('user 消息 → user-text', () => {
    const els = flattenMessages([userMsg('u1', '你好')]);
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ kind: 'user-text', messageId: 'u1', text: '你好' });
    expect(els[0]!.key).toBe('u1:u0');
  });

  it('assistant TextBlock → agent-answer，text-index 递增', () => {
    const els = flattenMessages([
      assistantMsg('a1', [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ]),
    ]);
    expect(els).toHaveLength(2);
    expect(els[0]).toMatchObject({ kind: 'agent-answer', messageId: 'a1', textIndex: 0 });
    expect(els[1]).toMatchObject({ kind: 'agent-answer', messageId: 'a1', textIndex: 1 });
    expect(els[0]!.key).toBe('a1:t0');
    expect(els[1]!.key).toBe('a1:t1');
  });

  it('ReasoningBlock 跳过不渲染', () => {
    const els = flattenMessages([
      assistantMsg('a1', [
        { type: 'reasoning', text: '内心独白' },
        { type: 'text', text: '回复' },
      ]),
    ]);
    expect(els).toHaveLength(1);
    expect(els[0]!.kind).toBe('agent-answer');
  });

  it('part key 含 toolCallId（§2 rule6）', () => {
    const els = flattenMessages([
      assistantMsg('a1', [
        { type: 'tool_call', id: 'call_1', name: 'bash', arguments: { cmd: 'ls' } },
      ]),
    ]);
    expect(els[0]!.key).toBe('a1:c:call_1');
    expect(els[0]).toMatchObject({ kind: 'tool-call-item', toolCallId: 'call_1', name: 'bash' });
  });
});

describe('buildToolResultMap — result 绑定（§2 rule4）', () => {
  it('role=tool 消息的 result 按 toolCallId 建 map', () => {
    const map = buildToolResultMap([
      toolMsg('t1', 'call_1', 'output1'),
      toolMsg('t2', 'call_2', 'err', true),
    ]);
    expect(map.get('call_1')).toMatchObject({ isError: false });
    expect(map.get('call_1')!.content[0]).toMatchObject({ text: 'output1' });
    expect(map.get('call_2')!.isError).toBe(true);
  });

  it('tool-call-item 自动绑定 result', () => {
    const els = flattenMessages([
      assistantMsg('a1', [
        { type: 'tool_call', id: 'call_1', name: 'bash', arguments: {} },
      ]),
      toolMsg('t1', 'call_1', 'result text'),
    ]);
    expect(els[0]).toMatchObject({ kind: 'tool-call-item' });
    expect((els[0] as { result?: unknown }).result).toMatchObject({
      content: [{ type: 'text', text: 'result text' }],
      isError: false,
    });
  });
});

describe('groupToolBatches — 视图层连续合并（§2 rule5）', () => {
  it('单 message 内连续多个 tool_call 合并为一个 batch', () => {
    const els = flattenMessages([
      assistantMsg('a1', [
        { type: 'tool_call', id: 'c1', name: 'f1', arguments: {} },
        { type: 'tool_call', id: 'c2', name: 'f2', arguments: {} },
      ]),
    ]);
    const { batches } = groupToolBatches(els);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.elementKeys).toEqual(['a1:c:c1', 'a1:c:c2']);
  });

  it('answer 文本断开 batch（text 在中间）', () => {
    const els = flattenMessages([
      assistantMsg('a1', [
        { type: 'tool_call', id: 'c1', name: 'f1', arguments: {} },
        { type: 'text', text: '结果说明' },
        { type: 'tool_call', id: 'c2', name: 'f2', arguments: {} },
      ]),
    ]);
    const { batches } = groupToolBatches(els);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.elementKeys).toEqual(['a1:c:c1']);
    expect(batches[1]!.elementKeys).toEqual(['a1:c:c2']);
  });

  it('跨消息边界连续合并（核心 MANDATORY）', () => {
    // assistant m1 末尾是 tool_call；assistant m2 紧接着 tool_call（无 text）
    // → 两个 call 并入同一 batch
    const els = flattenMessages([
      assistantMsg('m1', [
        { type: 'tool_call', id: 'c1', name: 'f1', arguments: {} },
      ]),
      toolMsg('t1', 'c1', 'r1'),
      assistantMsg('m2', [
        { type: 'tool_call', id: 'c2', name: 'f2', arguments: {} },
      ]),
    ]);
    const { batches } = groupToolBatches(els);
    // 注意：中间有 role=tool 的 m1 result，但 result 不产出 view-element，
    // 所以 view 序列是 [tool-call c1, tool-call c2]，连续 → 一个 batch
    expect(batches).toHaveLength(1);
    expect(batches[0]!.elementKeys).toEqual(['m1:c:c1', 'm2:c:c2']);
  });

  it('user 消息断开 batch', () => {
    const els = flattenMessages([
      assistantMsg('a1', [{ type: 'tool_call', id: 'c1', name: 'f1', arguments: {} }]),
      userMsg('u1', '继续'),
      assistantMsg('a2', [{ type: 'tool_call', id: 'c2', name: 'f2', arguments: {} }]),
    ]);
    const { batches } = groupToolBatches(els);
    expect(batches).toHaveLength(2);
  });

  it('flattenAndGroup 端到端：[text, callA, callB] → [answer, batch{A,B}]', () => {
    const { elements, batches } = flattenAndGroup([
      assistantMsg('a1', [
        { type: 'text', text: '先看一下' },
        { type: 'tool_call', id: 'cA', name: 'fA', arguments: {} },
        { type: 'tool_call', id: 'cB', name: 'fB', arguments: {} },
      ]),
    ]);
    expect(elements.map((e) => e.kind)).toEqual(['agent-answer', 'tool-call-item', 'tool-call-item']);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.elementKeys).toEqual(['a1:c:cA', 'a1:c:cB']);
  });
});

describe('flattenMessages — [v0.0.107] 来源徽标 name 派生', () => {
  const userMsgWithChannel = (
    id: string,
    text: string,
    channel?: { type: string; configId: string },
  ): Message => ({
    id,
    sessionId: 'S1',
    role: 'user',
    content: [{ type: 'text', text }],
    createdAt: '2026-07-10T00:00:00Z',
    sender: channel ? { source: 'user', channel } : { source: 'user' },
  });

  it('非 client channel（feishu）→ name = 原始 type（渲染层拼「来自」）', () => {
    const els = flattenMessages([userMsgWithChannel('u1', '你好', { type: 'feishu', configId: 'inst-1' })]);
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ kind: 'user-text', messageId: 'u1', name: 'feishu' });
  });

  it('client channel（type=client）→ name = undefined（不显徽标）', () => {
    const els = flattenMessages([userMsgWithChannel('u1', 'hi', { type: 'client', configId: '0' })]);
    expect(els[0]!.kind).toBe('user-text');
    expect((els[0] as { name?: string }).name).toBeUndefined();
  });

  it('无 channel（web 自发 user 消息）→ name = undefined', () => {
    const els = flattenMessages([userMsgWithChannel('u1', 'hi')]);
    expect((els[0] as { name?: string }).name).toBeUndefined();
  });
});
