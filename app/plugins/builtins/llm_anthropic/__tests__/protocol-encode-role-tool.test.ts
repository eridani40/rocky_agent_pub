/**
 * BUG-002 修复单测 —— role:"tool" → "user" 映射 + 相邻同 role 合并
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §2
 *       （外层 message role 转换规则 + 连续同 role 合并规则）
 *       specs/api/version_logs/v0.0.25/change_log.md §2
 *
 * 覆盖 edge case：
 *   - 单 tool result
 *   - 多个连续 tool result（tool→user 后变连续 user，需合并）
 *   - tool result 紧跟 user（合并）
 *   - tool result 紧跟 assistant（user/assistant 交替）
 *   - system 提取到顶层
 *   - 无 tool 的正常流不变（向后兼容）
 *   - eager + forked 语义（都走 encode，都覆盖）
 *
 * 直接测 encodeAnthropicMessages（导出的纯函数），断言 wire role 序列 + 交替 + tool_result block 存在。
 */
import { describe, it, expect } from 'vitest';
import { encodeAnthropicMessages } from '../protocol-encode';
import type { CanonicalRequest } from '../../../../server/src/llm/protocol';
import type { Message } from '../../../../server/src/llm/protocol-types';

/** 构造 CanonicalRequest（messages 直传，便于复现 eager/forked 场景） */
function req(messages: Message[], tools?: unknown[]): CanonicalRequest {
  return {
    modelId: 'claude-sonnet-4-6',
    messages,
    params: { maxTokens: 1024 },
    ...(tools !== undefined ? { tools } : {}),
  };
}

/** 取 wire messages 的 role 序列（去掉 system 后的 wire 数组） */
function roles(wire: Record<string, unknown>): string[] {
  return (wire['messages'] as Array<{ role: string }>).map((m) => m.role);
}

/** 验证 wire messages 严格 user/assistant 交替（无相邻同 role） */
function isStrictlyAlternating(wire: Record<string, unknown>): boolean {
  const r = roles(wire);
  for (let i = 1; i < r.length; i++) {
    if (r[i] === r[i - 1]) return false;
  }
  return true;
}

/** 找到 wire messages 中第一个含 tool_result block 的 message，返回其 content 数组 */
function findToolResultContent(
  wire: Record<string, unknown>,
): Array<Record<string, unknown>> | undefined {
  const msgs = wire['messages'] as Array<{ content: Array<Record<string, unknown>> }>;
  for (const m of msgs) {
    if (m.content.some((b) => b['type'] === 'tool_result')) {
      return m.content;
    }
  }
  return undefined;
}

const TOOL_USE_BLOCK = {
  type: 'tool_call',
  id: 't1',
  name: 'get_weather',
  arguments: { city: 'BJ' },
} as const;

const TOOL_RESULT_MSG = (id: string, result: string): Message => ({
  role: 'tool',
  content: [
    {
      type: 'tool_result',
      toolCallId: id,
      content: [{ type: 'text', text: result }],
      isError: false,
    },
  ],
});

describe('BUG-002 encodeAnthropicMessages role:"tool" → "user" 映射', () => {
  it('单 tool result：role 被映射为 user，tool_result block 存在', () => {
    const wire = encodeAnthropicMessages(
      req([
        { role: 'user', content: [{ type: 'text', text: '问天' }] },
        {
          role: 'assistant',
          content: [TOOL_USE_BLOCK],
        },
        TOOL_RESULT_MSG('t1', '晴天'),
      ]),
    ) as Record<string, unknown>;

    // wire 中不应再有 role:"tool"
    expect(roles(wire)).not.toContain('tool');
    expect(roles(wire)).toEqual(['user', 'assistant', 'user']);
    const tr = findToolResultContent(wire);
    expect(tr).toBeDefined();
    const toolResultBlock = tr!.find((b) => b['type'] === 'tool_result')!;
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock['tool_use_id']).toBe('t1');
  });

  it('多个连续 tool result：合并为单条 user（多个 tool_result block）', () => {
    const wire = encodeAnthropicMessages(
      req([
        { role: 'user', content: [{ type: 'text', text: '调A和B' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', id: 't1', name: 'A', arguments: {} },
            { type: 'tool_call', id: 't2', name: 'B', arguments: {} },
          ],
        },
        TOOL_RESULT_MSG('t1', '结果A'),
        TOOL_RESULT_MSG('t2', '结果B'),
      ]),
    ) as Record<string, unknown>;

    expect(roles(wire)).toEqual(['user', 'assistant', 'user']);
    expect(isStrictlyAlternating(wire)).toBe(true);
    const tr = findToolResultContent(wire)!;
    const toolResults = tr.filter((b) => b['type'] === 'tool_result');
    expect(toolResults.length).toBe(2);
    expect(toolResults.map((b) => b['tool_use_id'])).toEqual(['t1', 't2']);
  });

  it('tool result 紧跟 user：tool→user 后与下条 user 连续 → 合并', () => {
    const wire = encodeAnthropicMessages(
      req([
        { role: 'user', content: [{ type: 'text', text: 'q1' }] },
        {
          role: 'assistant',
          content: [TOOL_USE_BLOCK],
        },
        TOOL_RESULT_MSG('t1', '结果'),
        { role: 'user', content: [{ type: 'text', text: '继续' }] },
      ]),
    ) as Record<string, unknown>;

    // tool→user 后与下条 user 合并成单条 user（content 拼接）
    expect(roles(wire)).toEqual(['user', 'assistant', 'user']);
    expect(isStrictlyAlternating(wire)).toBe(true);
    const tr = findToolResultContent(wire)!;
    // tool_result block + text block 都在同一条 message.content
    expect(tr.some((b) => b['type'] === 'tool_result')).toBe(true);
    expect(tr.some((b) => b['type'] === 'text' && b['text'] === '继续')).toBe(true);
  });

  it('tool result 紧跟 assistant：保持 user/assistant 交替（assistant 的 tool_use block）', () => {
    const wire = encodeAnthropicMessages(
      req([
        { role: 'user', content: [{ type: 'text', text: 'q1' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 't1', name: 'X', arguments: {} }],
        },
        TOOL_RESULT_MSG('t1', '结果'),
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'final answer' }],
        },
      ]),
    ) as Record<string, unknown>;

    // user → assistant → user(tool) → assistant：严格交替
    expect(roles(wire)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(isStrictlyAlternating(wire)).toBe(true);
    const tr = findToolResultContent(wire)!;
    expect(tr.some((b) => b['type'] === 'tool_result')).toBe(true);
  });

  it('system 仍提取到顶层（不被 role 合并影响）', () => {
    const wire = encodeAnthropicMessages(
      req([
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [TOOL_USE_BLOCK],
        },
        TOOL_RESULT_MSG('t1', 'r'),
      ]),
    ) as Record<string, unknown>;

    // system 提到顶层（v0.0.8 后是 content block array）
    expect(Array.isArray(wire['system'])).toBe(true);
    const sys = wire['system'] as Array<Record<string, unknown>>;
    expect(sys[0]!['text']).toBe('sys');
    // wire messages 不含 system role
    expect(roles(wire)).not.toContain('system');
    expect(roles(wire)).toEqual(['user', 'assistant', 'user']);
  });

  it('无 tool 的正常流：行为不变（向后兼容）', () => {
    const wire = encodeAnthropicMessages(
      req([
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: [{ type: 'text', text: 'q1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { role: 'user', content: [{ type: 'text', text: 'q2' }] },
      ]),
    ) as Record<string, unknown>;

    expect(roles(wire)).toEqual(['user', 'assistant', 'user']);
    expect(isStrictlyAlternating(wire)).toBe(true);
    // 无 tool_result block
    const tr = findToolResultContent(wire);
    expect(tr).toBeUndefined();
  });

  it('eager 语义：agent-loop 主路径产 role:tool，encode 覆盖', () => {
    // 模拟 agent-loop eager 路径：连续 assistant tool_use → tool result
    const wire = encodeAnthropicMessages(
      req([
        { role: 'user', content: [{ type: 'text', text: 'run' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'e1', name: 'eager', arguments: {} }],
        },
        TOOL_RESULT_MSG('e1', 'done'),
      ]),
    ) as Record<string, unknown>;

    expect(roles(wire)).toEqual(['user', 'assistant', 'user']);
    expect(isStrictlyAlternating(wire)).toBe(true);
  });

  it('forked 语义：forked-agent 直接 push role:tool（不走 assemble），encode 覆盖', () => {
    // 模拟 forked-agent.ts:181-184 直接 push tool message，不经过 assemble reducer
    // 这条路径只能靠 encode 层修复（assemble reducer 对它无效）
    const wire = encodeAnthropicMessages(
      req([
        { role: 'user', content: [{ type: 'text', text: 'forked' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'f1', name: 'forked', arguments: {} }],
        },
        TOOL_RESULT_MSG('f1', 'forked-result'),
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
      ]),
    ) as Record<string, unknown>;

    // tool→user 后与下条 user 合并
    expect(roles(wire)).toEqual(['user', 'assistant', 'user']);
    expect(isStrictlyAlternating(wire)).toBe(true);
    const tr = findToolResultContent(wire)!;
    expect(tr.some((b) => b['type'] === 'tool_result' && b['tool_use_id'] === 'f1')).toBe(true);
    expect(tr.some((b) => b['type'] === 'text' && b['text'] === 'next')).toBe(true);
  });

  it('tool_result.isError=true 映射为 wire is_error:true', () => {
    const wire = encodeAnthropicMessages(
      req([
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [TOOL_USE_BLOCK],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 't1',
              content: [{ type: 'text', text: 'err' }],
              isError: true,
            },
          ],
        },
      ]),
    ) as Record<string, unknown>;

    const tr = findToolResultContent(wire)!;
    const block = tr.find((b) => b['type'] === 'tool_result')!;
    expect(block['is_error']).toBe(true);
  });

  it('不 mutate 入参 messages 数组（encode 产新对象）', () => {
    const input = [
      TOOL_RESULT_MSG('t1', 'r1'),
      TOOL_RESULT_MSG('t2', 'r2'),
    ];
    const before = JSON.parse(JSON.stringify(input));
    encodeAnthropicMessages(req(input));
    // 入参 content 数组未被 push（合并发生在新对象上）
    expect(input[0]!.content.length).toBe(before[0]!.content.length);
    expect(input[1]!.content.length).toBe(before[1]!.content.length);
  });
});
