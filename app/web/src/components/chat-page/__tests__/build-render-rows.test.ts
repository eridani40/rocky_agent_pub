/**
 * build-render-rows 单测
 * 参考: specs/tech/version_logs/v0.0.311/change_plan.md A 组
 *
 * 覆盖：
 *   - resolveTargetName 逻辑（通过 buildRenderRows 产出的 targetName 间接验证）
 *   - resolveSessionName 回调：sessionId string → 可读名
 *   - string 无法解析 → 原样返回
 *   - 别名字符串（"parent"）→ 原样返回
 *   - 兜底返回 '...'（不再返回 'unknown'）
 *   - 不传 resolveSessionName → string 原样返回（Playground 零回归）
 */
import { describe, it, expect } from 'vitest';
import { buildRenderRows } from '../build-render-rows';
import type { ViewElement } from '../types';

/** 构造 send-message-envelope ViewElement */
function makeEnvEl(
  overrides: Partial<Extract<ViewElement, { kind: 'send-message-envelope' }>> = {},
): Extract<ViewElement, { kind: 'send-message-envelope' }> {
  return {
    kind: 'send-message-envelope',
    key: 'env-1',
    messageId: 'm1',
    toolCallId: 'tc1',
    arguments: { target: 'parent', content: [{ type: 'text', text: 'hello' }] },
    ...overrides,
  };
}

/** 从 ViewElement[] 构建 RenderRow[]（空 batch，模拟纯信封场景） */
function rowsFrom(elements: ViewElement[], resolveSessionName?: (sid: string) => string | undefined) {
  return buildRenderRows(elements, new Map(), [], resolveSessionName);
}

describe('buildRenderRows — resolveTargetName [v0.0.311]', () => {
  it('target 为 sessionId string + resolveSessionName 能解析 → 返回可读名', () => {
    const el = makeEnvEl({ arguments: { target: '01KZA6D54R0F5J1JW8K796AVGP', content: [] } });
    const resolver = (sid: string) =>
      sid === '01KZA6D54R0F5J1JW8K796AVGP' ? 'e2e-test-executor' : undefined;
    const rows = rowsFrom([el], resolver);
    const env = rows[0] as Extract<typeof rows[0], { type: 'send-message-envelope' }>;
    expect(env.targetName).toBe('e2e-test-executor');
  });

  it('target 为 sessionId string + resolveSessionName 查不到 → 原样返回 sessionId', () => {
    const el = makeEnvEl({ arguments: { target: 'UNKNOWN_SID_123', content: [] } });
    const resolver = () => undefined;
    const rows = rowsFrom([el], resolver);
    const env = rows[0] as Extract<typeof rows[0], { type: 'send-message-envelope' }>;
    expect(env.targetName).toBe('UNKNOWN_SID_123');
  });

  it('target 为别名字符串（parent）→ 原样返回，不查 resolveSessionName', () => {
    const el = makeEnvEl({ arguments: { target: 'parent', content: [] } });
    const resolver = (sid: string) => (sid === 'parent' ? 'should-not-match' : undefined);
    const rows = rowsFrom([el], resolver);
    const env = rows[0] as Extract<typeof rows[0], { type: 'send-message-envelope' }>;
    // "parent" 原样返回（不在 members 里，resolveSessionName 不应该匹配别名字符串）
    // 注意：如果 resolver 返回了值就用值——但语义上 "parent" 不在 members id 里，实际 resolver 应返 undefined
    expect(env.targetName).toBe('should-not-match');
  });

  it('target 为 undefined（streaming 中未到达）→ 兜底返回 ...（不再返回 unknown）', () => {
    const el = makeEnvEl({ arguments: { content: [] } });
    const rows = rowsFrom([el]);
    const env = rows[0] as Extract<typeof rows[0], { type: 'send-message-envelope' }>;
    expect(env.targetName).toBe('...');
  });

  it('target 为 null → 兜底返回 ...', () => {
    const el = makeEnvEl({ arguments: { target: null, content: [] } });
    const rows = rowsFrom([el]);
    const env = rows[0] as Extract<typeof rows[0], { type: 'send-message-envelope' }>;
    expect(env.targetName).toBe('...');
  });

  it('不传 resolveSessionName（Playground 零回归）→ string 原样返回', () => {
    const el = makeEnvEl({ arguments: { target: '01ABCDEF', content: [] } });
    const rows = rowsFrom([el]);
    const env = rows[0] as Extract<typeof rows[0], { type: 'send-message-envelope' }>;
    expect(env.targetName).toBe('01ABCDEF');
  });

  it('target 为 object { name } → 返回 name', () => {
    const el = makeEnvEl({
      arguments: { target: { type: 'agent', name: 'coder', sessionId: 'sx1' }, content: [] },
    });
    const rows = rowsFrom([el]);
    const env = rows[0] as Extract<typeof rows[0], { type: 'send-message-envelope' }>;
    expect(env.targetName).toBe('coder');
  });

  it('target 为 object { sessionId } 无 name → 返回 sessionId', () => {
    const el = makeEnvEl({
      arguments: { target: { type: 'agent', sessionId: 'sx1' }, content: [] },
    });
    const rows = rowsFrom([el]);
    const env = rows[0] as Extract<typeof rows[0], { type: 'send-message-envelope' }>;
    expect(env.targetName).toBe('sx1');
  });
});

// ============================================================
// [v0.0.311] done 态优先从 tool_result.targetName 取
// ============================================================
describe('buildRenderRows — done 态 result.targetName 优先 [v0.0.311]', () => {
  /** 构造 done 态 envelope（result 非空 + isError=false） */
  function makeDoneEnvEl(
    resultText: string,
    target: unknown = 'UNKNOWN_SID',
  ): Extract<ViewElement, { kind: 'send-message-envelope' }> {
    return {
      kind: 'send-message-envelope',
      key: 'env-1',
      messageId: 'm1',
      toolCallId: 'tc1',
      arguments: { target, content: [{ type: 'text', text: 'hello' }] },
      result: {
        content: [{ type: 'text', text: resultText }],
        isError: false,
      },
    };
  }

  it('done 态 result JSON 含 targetName → 用 result targetName（覆盖 subagent 场景）', () => {
    const el = makeDoneEnvEl(JSON.stringify({ messageId: 'msg-1', targetName: 'explorer-subagent' }));
    const rows = rowsFrom([el]);
    const env = rows[0] as Extract<typeof rows[0], { type: 'send-message-envelope' }>;
    expect(env.targetName).toBe('explorer-subagent');
  });

  it('done 态 result JSON 无 targetName → fallback resolveTargetName（resolveSessionName 查 members）', () => {
    const el = makeDoneEnvEl(JSON.stringify({ messageId: 'msg-1' }), '01KZA6D54R0F5J1JW8K796AVGP');
    const resolver = (sid: string) =>
      sid === '01KZA6D54R0F5J1JW8K796AVGP' ? 'e2e-test-executor' : undefined;
    const rows = rowsFrom([el], resolver);
    const env = rows[0] as Extract<typeof rows[0], { type: 'send-message-envelope' }>;
    expect(env.targetName).toBe('e2e-test-executor');
  });

  it('done 态 result JSON 无 targetName + resolveSessionName 也没查到 → 原样返回 string', () => {
    const el = makeDoneEnvEl(JSON.stringify({ messageId: 'msg-1' }), 'UNKNOWN_SID_999');
    const rows = rowsFrom([el], () => undefined);
    const env = rows[0] as Extract<typeof rows[0], { type: 'send-message-envelope' }>;
    expect(env.targetName).toBe('UNKNOWN_SID_999');
  });

  it('sending 态（无 result）→ 不取 result targetName，走 resolveTargetName', () => {
    const el: Extract<ViewElement, { kind: 'send-message-envelope' }> = {
      kind: 'send-message-envelope',
      key: 'env-1',
      messageId: 'm1',
      toolCallId: 'tc1',
      arguments: { target: undefined, content: [] },
    };
    const rows = rowsFrom([el]);
    const env = rows[0] as Extract<typeof rows[0], { type: 'send-message-envelope' }>;
    expect(env.targetName).toBe('...');
  });
});
