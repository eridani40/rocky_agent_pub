/**
 * buildTraceName 纯函数单测（v0.0.61）。
 * 参考: specs/tech/agent/observability/[P0]observability_interface.md §5.1（TraceStart.name 语义）
 *       specs/tech/agent/observability/log.md v0.0.61
 *
 * 覆盖 trace name 格式 `${kind} ${sid6} ${input10}`（空格分隔）：
 *   - kind = sessionKind ?? 'session'（兜底）
 *   - sid6 = sessionId.slice(0, 6)
 *   - input10 = 首条 user 消息所有 TextBlock.text 拼接，`\s+`→单空格 trim 后 slice(0, 10)；
 *     无 user 消息则空串（trailing space 由 trimEnd 处理）
 *
 * v0.0.61 拆分后 buildTraceName 已从 LoopObservability private method 迁到
 * agent-loop-helpers.ts 独立导出函数（签名变为纯函数），本测直接 import 纯函数断言，
 * 不再需要构造 LoopObservability 实例 + spy adapter。
 */
import { describe, it, expect } from 'vitest';
import { buildTraceName } from '../agent-loop-helpers';
import type { Message } from '../../message/types';

/** 构造 user/assistant message（单个 TextBlock） */
function makeMsg(role: 'user' | 'assistant', text: string): Message {
  return {
    id: `m-${role}`,
    sessionId: 's',
    role,
    content: [{ type: 'text', text }],
  } as Message;
}

describe('buildTraceName（v0.0.61）', () => {
  it('格式 = `${kind} ${sid6} ${input10}`；input 取首条 user 消息 TextBlock.text', () => {
    const name = buildTraceName(
      'studio-leader',
      '01KWBPABCDEF', // slice(0,6) = '01KWBP'
      [makeMsg('user', 'helloworld')],
    );
    expect(name).toBe('studio-leader 01KWBP helloworld');
  });

  it('kind 缺省（undefined）→ 兜底 "session"', () => {
    const name = buildTraceName(undefined, 'ABCDEF', [makeMsg('user', 'hi')]);
    expect(name).toBe('session ABCDEF hi');
  });

  it('input > 10 chars → slice(0,10) 截断', () => {
    const name = buildTraceName(
      undefined,
      'ABCDEF',
      [makeMsg('user', 'abcdefghijklmnopqrstuvwxyz')], // 26 chars
    );
    expect(name).toBe('session ABCDEF abcdefghij'); // slice(0,10)
  });

  it('多个 TextBlock 拼接后 \\s+ → 单空格 trim，再 slice(0,10)', () => {
    const msg: Message = {
      id: 'm1',
      sessionId: 's',
      role: 'user',
      content: [
        { type: 'text', text: 'hello\n' },
        { type: 'text', text: '  world\nfoo' },
      ],
    } as Message;
    const name = buildTraceName(undefined, 'SID123', [msg]);
    // 'hello\n' + '  world\nfoo' = 'hello\n  world\nfoo' → \s+→' ' → 'hello world foo'
    // slice(0,10) = 'hello worl'
    expect(name).toBe('session SID123 hello worl');
  });

  it('无 user 消息 → trailing trim，仅 kind + sid6', () => {
    const name = buildTraceName(
      'playground-rocky',
      'ABCDEF',
      // 仅 assistant 消息 → 无 user input
      [makeMsg('assistant', 'response')],
    );
    expect(name).toBe('playground-rocky ABCDEF');
  });

  it('空 triggerMessages → 仅 kind + sid6', () => {
    const name = buildTraceName(undefined, 'ABCDEF', []);
    expect(name).toBe('session ABCDEF');
  });
});

// ============================================================
// [v0.0.78.bug] runKind 段（forked 任务标识）
// ============================================================

describe('buildTraceName — [v0.0.78.bug] runKind 段', () => {
  it('runKind=summary → kind 段拼 [summary] 后缀', () => {
    const name = buildTraceName(
      'studio-leader',
      '01KWBPa3BCDE', // slice(0,6) = '01KWBPa'... 实际 '01KWBP'
      [makeMsg('user', 'helloworld')],
      'summary',
    );
    // 期望格式：`studio-leader[summary] 01KWBP helloworld`
    expect(name).toBe('studio-leader[summary] 01KWBP helloworld');
  });

  it('runKind=consolidate → kind 段拼 [consolidate] 后缀', () => {
    const name = buildTraceName(
      'studio-leader',
      'ABCDEF',
      [makeMsg('user', 'hi')],
      'consolidate',
    );
    expect(name).toBe('studio-leader[consolidate] ABCDEF hi');
  });

  it("runKind='main' → 退原格式（main loop 视觉零回归，不加 [])", () => {
    const name = buildTraceName(
      'studio-leader',
      'ABCDEF',
      [makeMsg('user', 'hi')],
      'main',
    );
    expect(name).toBe('studio-leader ABCDEF hi');
  });

  it('runKind=undefined → 退原格式（与 v0.0.61 行为对齐）', () => {
    const name = buildTraceName(
      'studio-leader',
      'ABCDEF',
      [makeMsg('user', 'hi')],
      undefined,
    );
    expect(name).toBe('studio-leader ABCDEF hi');
  });

  it('runKind + 无 user 消息 → kind[runKind] + sid6（trailing trim）', () => {
    const name = buildTraceName(
      'playground-rocky',
      'ABCDEF',
      [makeMsg('assistant', 'response')], // 仅 assistant → 无 user input
      'summary',
    );
    expect(name).toBe('playground-rocky[summary] ABCDEF');
  });

  it('runKind 段紧贴 kind 不加空格（与 sid6 之间仍单空格分隔）', () => {
    const name = buildTraceName('session', 'ABCDEF', [], 'summary');
    // 注意：'session[summary]' 段无内部空格；与 sid6 'ABCDEF' 之间单空格
    expect(name).toBe('session[summary] ABCDEF');
  });
});
