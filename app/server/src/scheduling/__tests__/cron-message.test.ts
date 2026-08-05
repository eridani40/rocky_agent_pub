/**
 * buildCronUserMessage UT — Message 子类 "cron" 正确性。
 * 参考: specs/tech/scheduling/[P1]cron_subsystem.md §4（权威契约）
 *       specs/tech/agent/message/[P0]agent_message_interface.md §5（MessageSender 'system'）
 *
 * 覆盖：
 *   - role='user'（走 inbox enqueue）
 *   - sender.source='system' + sender.system.kind='cron'（启用预留枚举值）
 *   - content=[TextBlock `[cron:name] prompt`]
 *   - metadata.cron={at,name,prompt}（不与 TickMessage 的 metadata.tickMessage 混 key）
 *   - id 是 ulid（26 字符 Crockford Base32）
 *   - sessionId 透传
 */
import { describe, it, expect } from 'vitest';
import { buildCronUserMessage } from '../cron-message';
import type { CronPayload } from '../payloads';

function mkPayload(overrides: Partial<CronPayload> = {}): CronPayload {
  return {
    sessionId: 'S-1',
    name: '检查 todo',
    prompt: '推进未完成任务',
    squadId: null,
    ...overrides,
  };
}

describe('buildCronUserMessage', () => {
  it('role=user（走 inbox enqueue 原语）', () => {
    const msg = buildCronUserMessage(mkPayload(), '2026-07-03T10:00:00.000Z');
    expect(msg.role).toBe('user');
  });

  it('sender.source=system + sender.system.kind=cron（启用预留枚举值）', () => {
    const msg = buildCronUserMessage(mkPayload(), '2026-07-03T10:00:00.000Z');
    expect(msg.sender?.source).toBe('system');
    expect(msg.sender && 'system' in msg.sender ? msg.sender.system.kind : null).toBe('cron');
  });

  it('sender.system.refId = payload.sessionId（cron message 标识归属 session）', () => {
    const msg = buildCronUserMessage(mkPayload({ sessionId: 'S-XYZ' }), '2026-07-03T10:00:00.000Z');
    const sys = msg.sender && 'system' in msg.sender ? msg.sender.system : null;
    expect(sys?.refId).toBe('S-XYZ');
  });

  it('content = [TextBlock `[cron:name] prompt`]', () => {
    const msg = buildCronUserMessage(
      mkPayload({ name: '检查 todo', prompt: '推进未完成任务' }),
      '2026-07-03T10:00:00.000Z',
    );
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toMatchObject({ type: 'text' });
    expect((msg.content[0] as { text: string }).text).toBe('[cron:检查 todo] 推进未完成任务');
  });

  it('metadata.cron = {at,name,prompt}（不与 TickMessage 的 metadata.tickMessage 混 key）', () => {
    const msg = buildCronUserMessage(
      mkPayload({ name: 'daily', prompt: 'hi' }),
      '2026-07-03T10:00:00.000Z',
    );
    expect(msg.metadata?.cron).toEqual({
      at: '2026-07-03T10:00:00.000Z',
      name: 'daily',
      prompt: 'hi',
    });
    // 不应混入 tickMessage key
    expect(msg.metadata?.tickMessage).toBeUndefined();
  });

  it('id 是 ulid（26 字符 Crockford Base32，单调）', () => {
    const msg = buildCronUserMessage(mkPayload(), '2026-07-03T10:00:00.000Z');
    expect(msg.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sessionId 透传 payload.sessionId', () => {
    const msg = buildCronUserMessage(mkPayload({ sessionId: 'S-9' }), '2026-07-03T10:00:00.000Z');
    expect(msg.sessionId).toBe('S-9');
  });

  it('不同 payload.name/prompt 生成不同 content text（不缓存的纯函数）', () => {
    const a = buildCronUserMessage(mkPayload({ name: 'A', prompt: 'pa' }), '2026-07-03T10:00:00.000Z');
    const b = buildCronUserMessage(mkPayload({ name: 'B', prompt: 'pb' }), '2026-07-03T10:00:00.000Z');
    expect((a.content[0] as { text: string }).text).toBe('[cron:A] pa');
    expect((b.content[0] as { text: string }).text).toBe('[cron:B] pb');
  });
});
