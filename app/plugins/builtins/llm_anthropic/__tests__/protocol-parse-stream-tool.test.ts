/**
 * AnthropicMessagesProtocol.parseStream tool_use 翻译集成测试（v0.0.8 BUG-003 回归）
 * 参考: states/v0.0.8/bugs/BUG-003-protocol-parse-stream-drops-tool_use-block-[open].md
 *       specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §3.6
 *
 * 关键：经真实 parseStream（AnthropicMessagesProtocol 实例 + parseAnthropicSseFrame），
 * 不用 stub StreamEvent 绕过协议层。喂 mock:tool 剧本的 anthropic tool_use wire 帧
 * （content_block_start tool_use + input_json_delta + content_block_stop）→
 * 断言产出 tool_call_delta（含 id/name + argumentsDelta）+ finish 仍工作。
 *
 * 对齐 StreamConsumer 契约（agent-loop-stream.ts handleToolCall）：
 *   - content_block_start tool_use → tool_call_delta{toolCallId,name}（触发 tool_call_start）
 *   - input_json_delta → tool_call_delta{toolCallId,argumentsDelta}（触发 tool_call_delta + 累积）
 *   - finish(tool_use) → 由 StreamConsumer closeActive 产 tool_call_end
 */
import { describe, it, expect } from 'vitest';
import AnthropicMessagesProtocol from '../protocol';
import { toolUseBashBlock, textBlock, msgStart, usageAndFinish } from '../../../../server/src/mock-llm-scenarios';

/** 构造 mock:tool 首轮完整 SSE body（与 mock-llm-scenarios buildToolScenario 一致） */
function mockToolFirstRoundBody(): string {
  return [msgStart(), textBlock(0, '我来执行一个命令'), toolUseBashBlock(1), usageAndFinish('tool_use', 12)].join('\n');
}

describe('BUG-003 regression: parseStream tool_use 翻译', () => {
  it('content_block_start(tool_use) 产 tool_call_delta{toolCallId,name}（无 argumentsDelta）', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const frame =
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_mock_1","name":"bash","input":{}}}\n\n';
    const evts = p.parseStream(frame);
    expect(evts).toEqual([
      { type: 'tool_call_delta', toolCallId: 'tool_mock_1', name: 'bash' },
    ]);
  });

  it('input_json_delta 产 tool_call_delta{toolCallId,argumentsDelta}（按 index 映射）', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    // 先 content_block_start 注册 index→id，再 input_json_delta 才能查到 toolCallId
    p.parseStream(
      'event: content_block_start\n' +
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_mock_1","name":"bash","input":{}}}\n\n',
    );
    const deltaEvts = p.parseStream(
      'event: content_block_delta\n' +
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\": \\"echo hi\\"}"}}\n\n',
    );
    expect(deltaEvts).toEqual([
      {
        type: 'tool_call_delta',
        toolCallId: 'tool_mock_1',
        argumentsDelta: '{"command": "echo hi"}',
      },
    ]);
  });

  it('mock:tool 首轮完整 body → text + tool_call + finish 序列正确', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    // mock-llm 把 body 按帧切逐帧 enqueue；这里一次性 parseStream 等价（buffer 切帧）
    const evts = p.parseStream(mockToolFirstRoundBody());
    const types = evts.map((e) => e.type);
    // 期望：text_delta（text 块）+ tool_call_delta×2（start + input_json_delta）+ usage + finish(tool_use)
    expect(types).toContain('text_delta');
    expect(types.filter((t) => t === 'tool_call_delta').length).toBe(2);
    expect(types).toContain('usage');
    const finishes = evts.filter((e) => e.type === 'finish');
    expect(finishes.length).toBeGreaterThanOrEqual(1);
    // message_delta 携带 stop_reason:tool_use → finish(tool_use)；
    // message_stop → finish(stop)（后置）。序列中应含 tool_use finish
    const reasons = finishes.map((f) => (f as { reason: string }).reason);
    expect(reasons).toContain('tool_use');

    // tool_call_delta 第一帧带 name，第二帧带 argumentsDelta
    const toolDeltas = evts.filter((e) => e.type === 'tool_call_delta');
    const first = toolDeltas[0] as { toolCallId: string; name?: string; argumentsDelta?: string };
    const second = toolDeltas[1] as { toolCallId: string; name?: string; argumentsDelta?: string };
    expect(first.toolCallId).toBe('tool_mock_1');
    expect(first.name).toBe('bash');
    expect(first.argumentsDelta).toBeUndefined();
    expect(second.toolCallId).toBe('tool_mock_1');
    expect(second.argumentsDelta).toBe('{"command": "echo hi"}');
  });

  it('index 不泄露（tool_call_delta 不带 index 字段）', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const evts = p.parseStream(
      'event: content_block_start\n' +
        'data: {"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"t1","name":"x","input":{}}}\n\n',
    );
    for (const e of evts) {
      expect((e as Record<string, unknown>)['index']).toBeUndefined();
    }
  });

  it('text/thinking 既有行为不破坏（content_block_start text 仍不产事件）', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const evts = p.parseStream(
      'event: content_block_start\n' +
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    );
    expect(evts).toEqual([]);
  });

  it('跨 chunk 拆分 tool_use wire 仍正确产事件（buffer + index mapping 跨帧持久）', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const body = mockToolFirstRoundBody();
    // 从中间切开（可能切在 JSON 内部）
    const mid = Math.floor(body.length / 2);
    const part1 = body.slice(0, mid);
    const part2 = body.slice(mid);
    const all = [...p.parseStream(part1), ...p.parseStream(part2)];
    const toolDeltas = all.filter((e) => e.type === 'tool_call_delta');
    expect(toolDeltas.length).toBe(2);
    expect((toolDeltas[1] as { argumentsDelta?: string }).argumentsDelta).toBe(
      '{"command": "echo hi"}',
    );
  });
});
