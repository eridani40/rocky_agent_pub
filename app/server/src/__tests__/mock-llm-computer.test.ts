/**
 * mock-llm computer use 剧本单测 —— @@cu:<json>@@ directive 触发单 `computer` tool_call
 * 参考: app/server/src/mock-llm.ts + mock-llm-scenarios.ts
 *       change_plan_v2_batch2 §B2.8 B4（directive 收敛 @@cu:screenshot@@ → @@cu:<json>@@）
 */
import { describe, it, expect } from 'vitest';
import { createMockFetch } from '../mock-llm';
import { buildComputerScenario } from '../mock-llm-scenarios';

/** 造一个流式 chat request body（含 user 消息 + stream:true） */
function streamBody(userText: string, extraMessages: unknown[] = []): string {
  return JSON.stringify({
    model: 'some-real-model-id',
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }, ...extraMessages],
    params: { stream: true },
    stream: true,
  });
}

describe('buildComputerScenario', () => {
  it('首轮：text + computer tool_use（name=computer，arguments=directive json）', () => {
    const s = buildComputerScenario('{"action":"screenshot"}', false);
    expect(s).toBeDefined();
    expect(s).toContain('"name":"computer"');
    expect(s).toContain('"type":"tool_use"');
    expect(s).toContain('tool_use'); // stop_reason
    // arguments 原样嵌入 partial_json（转义后含 action:screenshot）
    expect(s).toContain('screenshot');
  });
  it('首轮：click action（element_index 进 arguments）', () => {
    const s = buildComputerScenario('{"action":"click","element_index":3}', false);
    expect(s).toContain('"name":"computer"');
    expect(s).toContain('click');
    expect(s).toContain('element_index');
  });
  it('续轮：纯 text + end_turn（不再出 tool_call）', () => {
    const s = buildComputerScenario('{"action":"screenshot"}', true);
    expect(s).toContain('end_turn');
    expect(s).not.toContain('"name":"computer"');
  });
  it('json 解析失败 → 返 undefined（fail-safe）', () => {
    expect(buildComputerScenario('{not json', false)).toBeUndefined();
  });
});

describe('createMockFetch — @@cu:<json>@@ directive', () => {
  it('user 含 @@cu:{"action":"screenshot"}@@（首轮）→ 出 computer tool_call', async () => {
    const fetch = createMockFetch({ stepDelayMs: 0 });
    const res = await fetch('http://mock', {
      method: 'POST',
      body: streamBody('请截图 @@cu:{"action":"screenshot"}@@'),
    } as RequestInit);
    const text = await (res as Response).text();
    expect(text).toContain('"name":"computer"');
    expect(text).toContain('"type":"tool_use"');
  });

  it('user 含 click directive → tool_call arguments 携带 action=click + element_index', async () => {
    const fetch = createMockFetch({ stepDelayMs: 0 });
    const res = await fetch('http://mock', {
      method: 'POST',
      body: streamBody('点击 @@cu:{"action":"click","element_index":2}@@'),
    } as RequestInit);
    const text = await (res as Response).text();
    expect(text).toContain('"name":"computer"');
    expect(text).toContain('click');
    expect(text).toContain('element_index');
  });

  it('续轮（末尾 role=tool）→ end_turn，不再出 tool_call', async () => {
    const fetch = createMockFetch({ stepDelayMs: 0 });
    const res = await fetch('http://mock', {
      method: 'POST',
      body: streamBody('请截图 @@cu:{"action":"screenshot"}@@', [
        { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'tool_cu_1', content: [], isError: false }] },
      ]),
    } as RequestInit);
    const text = await (res as Response).text();
    expect(text).toContain('end_turn');
    expect(text).not.toContain('"name":"computer"');
  });

  it('无 directive → 走默认剧本（不出 computer tool_call）', async () => {
    const fetch = createMockFetch({ stepDelayMs: 0 });
    const res = await fetch('http://mock', {
      method: 'POST',
      body: streamBody('普通提问，无 computer 指令'),
    } as RequestInit);
    const text = await (res as Response).text();
    expect(text).not.toContain('"name":"computer"');
  });

  it('directive json 非法（@@cu:{bad@@）→ fail-safe 回退默认剧本（不出 computer tool_call、不崩）', async () => {
    const fetch = createMockFetch({ stepDelayMs: 0 });
    const res = await fetch('http://mock', {
      method: 'POST',
      body: streamBody('坏指令 @@cu:{bad@@'),
    } as RequestInit);
    const text = await (res as Response).text();
    expect((res as Response).status).toBe(200);
    expect(text).not.toContain('"name":"computer"');
  });
});
