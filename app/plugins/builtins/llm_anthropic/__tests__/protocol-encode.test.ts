/**
 * AnthropicMessagesProtocol.encode 单测（白盒）—— canonical → wire 字段映射
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §2/§3.5/§4
 *       specs/research/v0.0.3-anthropic-protocol.md §1（request body 形状）
 *
 * 覆盖（test-plan §2 P1）：
 *   - maxTokens → max_tokens、system 落点 top_level、stream 标志、content block 翻译
 *   - path/contentType 自承载常量
 */
import { describe, it, expect } from 'vitest';
import AnthropicMessagesProtocol from '../protocol';
import type { CanonicalRequest } from '../../../../server/src/llm/protocol';
import type { ContentBlock } from '../../../../server/src/llm/protocol-types';

/** 构造 reminder text block 用于测试（isSystemReminder 块级标记，protocol-types 已声明）。 */
function reminderBlock(text: string): ContentBlock {
  return { type: 'text', text, isSystemReminder: true };
}

function makeRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    modelId: 'claude-sonnet-4-6',
    messages: [
      { role: 'system', content: [{ type: 'text', text: '你是助手' }] },
      {
        role: 'user',
        content: [{ type: 'text', text: '你好' }],
      },
    ],
    params: { maxTokens: 1024 },
    ...overrides,
  };
}

describe('AnthropicMessagesProtocol 常量', () => {
  it('path is /v1/messages, contentType application/json', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    expect(p.path).toBe('/v1/messages');
    expect(p.contentType).toBe('application/json');
  });
});

describe('AnthropicMessagesProtocol.encode', () => {
  it('maps maxTokens → max_tokens, model, system top_level, messages, stream=false', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(makeRequest()) as Record<string, unknown>;
    expect(wire['model']).toBe('claude-sonnet-4-6');
    expect(wire['max_tokens']).toBe(1024);
    expect(wire['stream']).toBe(false);
    // system 落点 top_level（来自 messages[] 中 role:system）；
    // v0.0.8 cache_control 2bp 后 system 转为 content block array（末 block 带 cache_control）
    const sys = wire['system'] as Array<Record<string, unknown>>;
    expect(Array.isArray(sys)).toBe(true);
    expect(sys[0]!.type).toBe('text');
    expect(sys[0]!.text).toBe('你是助手');
    expect(sys[0]!.cache_control).toEqual({ type: 'ephemeral' });
    const msgs = wire['messages'] as Array<{ role: string; content: unknown }>;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe('user');
  });

  it('drops system message from messages[], keeps user/assistant', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'sys' }] },
          { role: 'user', content: [{ type: 'text', text: 'q1' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
          { role: 'user', content: [{ type: 'text', text: 'q2' }] },
        ],
      }),
    ) as { messages: Array<{ role: string }> };
    expect(wire.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('encodes stream=true when params.stream=true', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({ params: { maxTokens: 100, stream: true } }),
    ) as Record<string, unknown>;
    expect(wire['stream']).toBe(true);
  });

  it('translates text content block to anthropic wire block', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(makeRequest()) as {
      messages: Array<{ content: Array<{ type: string; text: string }> }>;
    };
    // v0.0.8 cache_control bp#2：最后 message 最后 block 带 cache_control。
    // 该请求只有 1 条 user message（1 个 block），故它就是被注入 bp 的那个 block。
    expect(wire.messages[0]!.content[0]).toEqual({
      type: 'text',
      text: '你好',
      cache_control: { type: 'ephemeral' },
    });
  });

  // [v0.0.105] ImageBlock 全链路：encode 把 spec 形（source.kind + mediaType 顶层）翻译为
  //   anthropic wire 形（source:{type, media_type, data}）。禁直接透传 source（drift 致 LLM 收错字段名）。
  it('translates base64 image block: spec form (source.kind+mediaType) → wire source {type:base64, media_type, data}', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { kind: 'base64', data: 'iVBOR' },
                mediaType: 'image/png',
              },
            ],
          },
        ],
      }),
    ) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const block = wire.messages[0]!.content[0]!;
    expect(block['type']).toBe('image');
    // wire 形：source 内嵌 {type:'base64', media_type, data}（无 kind/mediaType 顶层）
    expect(block['source']).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: 'iVBOR',
    });
    // 防回归：绝不透传 spec 形字段（kind / mediaType 不得进 wire）
    expect(block).not.toHaveProperty('mediaType');
    expect((block['source'] as Record<string, unknown>)['kind']).toBeUndefined();
  });

  it('translates url image block: spec form (source.kind=url) → wire source {type:url, url}', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { kind: 'url', url: 'https://example.com/a.png' },
                mediaType: 'image/png',
              },
            ],
          },
        ],
      }),
    ) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const block = wire.messages[0]!.content[0]!;
    expect(block['type']).toBe('image');
    expect(block['source']).toEqual({ type: 'url', url: 'https://example.com/a.png' });
  });

  // computer use get_app_state 路径：ToolResultBlock.content 含 ImageBlock（+ TextBlock），
  //   encodeToolResultContent 逐块翻译——image 也走 encodeContentBlock 翻译为 wire 形。
  it('translates image nested inside tool_result.content (computer use get_app_state path)', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({
        messages: [
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                toolCallId: 'call_1',
                isError: false,
                content: [
                  { type: 'image', source: { kind: 'base64', data: 'PNGDATA' }, mediaType: 'image/png' },
                  { type: 'text', text: 'ax tree' },
                ],
              },
            ],
          },
        ],
      }),
    ) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const toolResult = wire.messages[0]!.content[0]!;
    expect(toolResult['type']).toBe('tool_result');
    const inner = toolResult['content'] as Array<Record<string, unknown>>;
    expect(inner[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'PNGDATA' },
    });
    expect(inner[1]!['type']).toBe('text');
  });

  it('system absent when no role:system message', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ],
      }),
    ) as Record<string, unknown>;
    expect(wire['system']).toBeUndefined();
  });

  it('forwards temperature when provided', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({ params: { maxTokens: 100, temperature: 0.5 } }),
    ) as Record<string, unknown>;
    expect(wire['temperature']).toBe(0.5);
  });
});

// BUG-007：tools 字段 encode 覆盖（encode 从未被测过带 tools 的缺口）
describe('AnthropicMessagesProtocol.encode tools (BUG-007)', () => {
  it('maps request.tools to wire tools [{name, description, input_schema}]', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({
        tools: [
          {
            name: 'write',
            description: 'write a file',
            inputSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        ],
      }),
    ) as Record<string, unknown>;
    expect(Array.isArray(wire['tools'])).toBe(true);
    const tools = wire['tools'] as Array<Record<string, unknown>>;
    expect(tools.length).toBe(1);
    expect(tools[0]!['name']).toBe('write');
    expect(tools[0]!['description']).toBe('write a file');
    // inputSchema → input_schema 字段名映射
    expect(tools[0]!['input_schema']).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
  });

  it('maps multiple tools preserving order', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({
        tools: [
          { name: 'read', description: 'd1', inputSchema: { type: 'object' } },
          { name: 'bash', description: 'd2', inputSchema: { type: 'object' } },
        ],
      }),
    ) as Record<string, unknown>;
    const tools = wire['tools'] as Array<Record<string, unknown>>;
    expect(tools.map((t) => t['name'])).toEqual(['read', 'bash']);
  });

  it('omits tools field when request.tools is undefined/empty', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const w1 = p.encode(makeRequest()) as Record<string, unknown>;
    expect(w1['tools']).toBeUndefined();
    const w2 = p.encode(makeRequest({ tools: [] })) as Record<string, unknown>;
    expect(w2['tools']).toBeUndefined();
  });

  it('skips invalid tool entries (no name) defensively', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({
        tools: [
          { name: 'valid', description: 'v', inputSchema: { type: 'object' } },
          { description: 'no name' }, // 应被跳过
          null,
          { name: '', description: 'empty name' }, // 应被跳过
        ],
      }),
    ) as Record<string, unknown>;
    const tools = wire['tools'] as Array<Record<string, unknown>>;
    expect(tools.length).toBe(1);
    expect(tools[0]!['name']).toBe('valid');
  });

  it('defaults description/inputSchema when missing', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({ tools: [{ name: 'bare' }] }),
    ) as Record<string, unknown>;
    const tool = (wire['tools'] as Array<Record<string, unknown>>)[0]!;
    expect(tool['description']).toBe('');
    expect(tool['input_schema']).toEqual({ type: 'object', properties: {} });
  });
});

// v0.0.52 cache_control spec 对齐（[P0]cache_control.md §3.2 bp#2 落点 + §3.3 reminder 过滤）
describe('cache_control bp#2 落点 + reminder wire 过滤 (v0.0.52)', () => {
  it('bp#2 落在最后非 reminder block，不落 reminder（reminder 在末）', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'sys' }] },
          { role: 'user', content: [{ type: 'text', text: 'q1' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'q2' },
              reminderBlock('[system_reminder]环境'),
            ],
          },
        ],
      }),
    ) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    const lastMsg = wire.messages[wire.messages.length - 1]!;
    const q2 = lastMsg.content.find((b) => b['text'] === 'q2');
    const reminder = lastMsg.content.find((b) => b['text'] === '[system_reminder]环境');
    // bp#2 应落在 q2（非 reminder），不落 reminder block
    expect(q2!['cache_control']).toEqual({ type: 'ephemeral' });
    expect(reminder!['cache_control']).toBeUndefined();
    // wire block 不带 isSystemReminder 字段（LLM 零侵入）
    expect(reminder!['isSystemReminder']).toBeUndefined();
  });

  it('bp#2 落最后 block 当无 reminder（行为回归）', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'hey' }] },
          { role: 'user', content: [{ type: 'text', text: 'bye' }] },
        ],
      }),
    ) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    const lastMsg = wire.messages[wire.messages.length - 1]!;
    expect(lastMsg.content[0]!['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('bp#2 跨 message 边界反向扫（末 message 全是 reminder 时落到前一 message）', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    // 最末 user 只有 reminder → bp#2 落到前一条 assistant 的 block
    const wire = p.encode(
      makeRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'q' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'a-stable' }] },
          {
            role: 'user',
            content: [reminderBlock('only-reminder')],
          },
        ],
      }),
    ) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
    const reminderMsg = wire.messages[wire.messages.length - 1]!;
    // 最末 message 的 reminder 不带 cache_control
    expect(reminderMsg.content[0]!['cache_control']).toBeUndefined();
    // bp#2 落在前一条 assistant 的 'a-stable'
    const assistantMsg = wire.messages[wire.messages.length - 2]!;
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.content[0]!['text']).toBe('a-stable');
    expect(assistantMsg.content[0]!['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('过滤：非最末 user message drop 所有 reminder block', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '历史问题' },
              reminderBlock('[reminder old]'),
            ],
          },
          { role: 'assistant', content: [{ type: 'text', text: '历史回复' }] },
          {
            role: 'user',
            content: [
              { type: 'text', text: '当前问题' },
              reminderBlock('[r1]'),
              reminderBlock('[r2]'),
            ],
          },
        ],
      }),
    ) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
    // 历史 user 的 reminder 被 drop（只剩「历史问题」）
    const firstUser = wire.messages[0]!;
    expect(firstUser.content.map((b) => b['text'])).toEqual(['历史问题']);
    // 最末 user 只保留最末一个 reminder（r2）
    const lastUser = wire.messages[2]!;
    expect(lastUser.content.map((b) => b['text'])).toEqual(['当前问题', '[r2]']);
  });

  it('过滤：最末 user message 多 reminder 只保留最末一个 + wire 无 isSystemReminder 字段', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hi' },
              reminderBlock('[r1]'),
              reminderBlock('[r2]'),
            ],
          },
        ],
      }),
    ) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    expect(wire.messages[0]!.content.map((b) => b['text'])).toEqual(['hi', '[r2]']);
    // 所有 wire block 均不带 isSystemReminder 字段（encode 零侵入）
    for (const b of wire.messages[0]!.content) {
      expect(b['isSystemReminder']).toBeUndefined();
    }
  });

  it('过滤：无 reminder 的 message 形状不变（回归）', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'plain' }] },
        ],
      }),
    ) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    expect(wire.messages[0]!.content.map((b) => b['text'])).toEqual(['plain']);
  });
});
