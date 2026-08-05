/**
 * protocol-encode cache control 单测
 * 参考:
 *   - specs/tech/agent/providers_and_models/anthropic_impl.md §4（cache control 2bp）
 *   - specs/tech/version_logs/v0.0.8/change_log.md §10
 *
 * 校验点：
 *   - encode 产出含 2 个 cache_control breakpoint（system 末 block + 最后 message 末 block）
 *   - string system 自动转 content block array（type:text + cache_control）
 *   - 无 system（无 role:system message）时跳过 system bp（只 1 bp 在最后 message）
 *   - ttl=ephemeral（无显式 ttl 字段）
 *   - task-1 已做的字段名对齐不被破坏（tool_call→tool_use 的 input 等）
 *   - messages 为空时只 system bp（无最后 message bp）
 */
import { describe, it, expect } from 'vitest';
import { encodeAnthropicMessages } from '../protocol-encode';
import type { CanonicalRequest } from '../../../../server/src/llm/protocol';
import type { ContentBlock, Message } from '../../../../server/src/llm/protocol-types';

/** 构造最小 CanonicalRequest（仅 messages + 最小 params） */
function req(messages: Message[]): CanonicalRequest {
  return {
    modelId: 'claude-test',
    messages,
    params: { maxTokens: 1024 },
  };
}

describe('encodeAnthropicMessages — cache control 2bp', () => {
  it('string system 自动转 content block array 且末 block 带 cache_control', () => {
    const messages: Message[] = [
      { role: 'system', content: [{ type: 'text', text: '你是助手' }] },
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
    ];
    const body = encodeAnthropicMessages(req(messages));

    const system = body['system'] as Record<string, unknown>[];
    expect(Array.isArray(system)).toBe(true);
    expect(system).toHaveLength(1);
    expect(system[0]!).toMatchObject({
      type: 'text',
      text: '你是助手',
      cache_control: { type: 'ephemeral' },
    });
    // ttl 默认 ephemeral：不显式 ttl 字段
    expect(system[0]!.cache_control).not.toHaveProperty('ttl');
  });

  it('完整 encode 含恰好 2 个 cache_control breakpoint（system 末 + 最后 message 末）', () => {
    const messages: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: '历史' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: '最后一块' },
        ],
      },
    ];
    const body = encodeAnthropicMessages(req(messages));

    // 统计 cache_control 出现次数
    const allBlocks: Record<string, unknown>[] = [];
    allBlocks.push(...(body['system'] as Record<string, unknown>[]));
    for (const m of body['messages'] as { content: Record<string, unknown>[] }[]) {
      allBlocks.push(...m.content);
    }
    const withCache = allBlocks.filter((b) => b.cache_control !== undefined);
    expect(withCache).toHaveLength(2);

    // bp#1: system 末 block
    const sysBlocks = body['system'] as Record<string, unknown>[];
    expect(sysBlocks[sysBlocks.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });

    // bp#2: 最后 message 最后 block
    const msgs = body['messages'] as { content: Record<string, unknown>[] }[];
    const lastMsg = msgs[msgs.length - 1]!;
    const lastBlock = lastMsg.content[lastMsg.content.length - 1]!;
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
    // 倒数第二个 block 不应有 cache_control
    expect(lastMsg.content[lastMsg.content.length - 2]!.cache_control).toBeUndefined();
  });

  it('无 system message 时只 1 个 bp（最后 message 末 block），body 无 system 字段', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ];
    const body = encodeAnthropicMessages(req(messages));

    expect(body['system']).toBeUndefined();

    const msgs = body['messages'] as { content: Record<string, unknown>[] }[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content[0]!.cache_control).toEqual({ type: 'ephemeral' });

    // 全量仅 1 个 bp
    const allBlocks: Record<string, unknown>[] = [];
    for (const m of msgs) allBlocks.push(...m.content);
    const withCache = allBlocks.filter((b) => b.cache_control !== undefined);
    expect(withCache).toHaveLength(1);
  });

  it('messages 为空（仅 system）时只 system bp（无最后 message bp）', () => {
    const messages: Message[] = [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }];
    const body = encodeAnthropicMessages(req(messages));

    const system = body['system'] as Record<string, unknown>[];
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });

    expect(body['messages']).toEqual([]);
  });

  it('cache_control 不破坏 task-1 字段名对齐（tool_call→tool_use input 等）', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'tc1', name: 'read', arguments: { path: '/a' } }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool_result', toolCallId: 'tc1', content: [{ type: 'text', text: 'r' }], isError: false },
        ],
      },
    ];
    const body = encodeAnthropicMessages(req(messages));
    const msgs = body['messages'] as { role: string; content: Record<string, unknown>[] }[];

    // [v0.0.25 BUG-002] encode 边界 role:tool → user（库内 Message 仍 role:tool）。
    // 倒数第一条原为 tool message，wire 映射后 role=user，其最后 block（tool_result）应被加 cache_control。
    const lastMsg = msgs[msgs.length - 1]!;
    expect(lastMsg.role).toBe('user');
    const lastBlock = lastMsg.content[lastMsg.content.length - 1]!;
    expect(lastBlock.type).toBe('tool_result');
    expect(lastBlock.tool_use_id).toBe('tc1'); // task-1 字段名对齐保留
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' }); // bp 注入
  });

  it('多 block message：仅最后 block 带 bp，前面 block 不带', () => {
    const messages: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 's' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
          { type: 'text', text: 'c' },
        ],
      },
    ];
    const body = encodeAnthropicMessages(req(messages));
    const msgs = body['messages'] as { content: Record<string, unknown>[] }[];
    const content = msgs[0]!.content;
    expect(content[0]!.cache_control).toBeUndefined();
    expect(content[1]!.cache_control).toBeUndefined();
    expect(content[2]!.cache_control).toEqual({ type: 'ephemeral' });
  });
});
