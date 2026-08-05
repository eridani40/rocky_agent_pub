/**
 * llm logical-view UT（v0.0.50 T1，自 agent/__tests__/message-prefix-renderer.test.ts 迁入）
 * 参考: specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md §3（[P0]llm_logical_view.md）
 *       specs/tech/multi_agent/[P1]a2a_protocol.md §5（sender.source 分流表——前缀权威）
 *       specs/tech/agent/message/[P0]agent_message_interface.md §5（MessageSender 判别联合）
 *
 * 覆盖（task acceptance：4 source + 无sender + 空content + 首块非text 兜底）：
 *   - renderSenderPrefix：4 source 各自渲染前缀格式正确
 *     · agent → `[Message from <name> (<type>, needReply=<bool>)]: `
 *     · user → `[User]: `
 *     · system heartbeat → `[System (heartbeat tick)]: `；reminder → `[System reminder]: `；其他 kind → `[System (<kind>)]: `
 *     · approval → `[Approval result]: `
 *   - sender 缺失 → 无前缀
 *   - renderMessageContentWithPrefix：content 注入（首块 text 拼前/首块非 text prepend/空 content/无 sender 原样）
 *   - toLogicalMessages：sender 展平入首块 + 保留 sender/metadata 等字段 + 不 mutate 原数组
 */
import { describe, it, expect } from 'vitest';
import type { ContentBlock, Message, MessageSender } from '../../message/types';
import {
  renderSenderPrefix,
  renderMessageContentWithPrefix,
  toLogicalMessages,
} from '../logical-view';

// ── 构造 helper ──────────────────────────────────────────────

/** 构造带 sender 的 user-role message（a2a 消息进接收方 inbox 时 role=user） */
function makeMsg(opts: {
  id?: string;
  role?: Message['role'];
  sender?: MessageSender;
  content?: ContentBlock[];
  metadata?: Record<string, unknown>;
}): Message {
  return {
    id: opts.id ?? '01TESTMSG0001',
    sessionId: '01TESTSID0001',
    role: opts.role ?? 'user',
    content: opts.content ?? [{ type: 'text', text: 'hello world' }],
    ...(opts.sender ? { sender: opts.sender } : {}),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
}

const agentSender = (overrides: Partial<{
  name: string;
  // [v0.0.33.1] member→mate（B 方案命名统一）
  type: 'leader' | 'mate' | 'subagent' | 'squad';
  sessionId: string;
  needReply: boolean;
  inReplyTo: string;
}> = {}): MessageSender => ({
  source: 'agent',
  agent: {
    ref: {
      type: overrides.type ?? 'subagent',
      sessionId: overrides.sessionId ?? '01PARENTSID01',
      name: overrides.name ?? 'explorer',
    },
    needReply: overrides.needReply ?? true,
    ...(overrides.inReplyTo ? { inReplyTo: overrides.inReplyTo } : {}),
  },
});

// ── renderSenderPrefix：4 source 格式 ──────────────────────

describe('renderSenderPrefix — 4 source 渲染格式（a2a_protocol §5）', () => {
  it('source=agent → 含 name/type/needReply', () => {
    const prefix = renderSenderPrefix(
      agentSender({ name: 'explorer', type: 'subagent', needReply: false }),
    );
    expect(prefix).toBe(
      '[Message from explorer (subagent, needReply=false)]: ',
    );
  });

  it('source=agent needReply=true（a2a 提问/async spawn 回报）', () => {
    const prefix = renderSenderPrefix(
      agentSender({ name: 'parent-session', type: 'squad', needReply: true }),
    );
    expect(prefix).toBe(
      '[Message from parent-session (squad, needReply=true)]: ',
    );
  });

  it('source=user → [User]:', () => {
    const prefix = renderSenderPrefix({ source: 'user' });
    expect(prefix).toBe('[User]: ');
  });

  it('source=system kind=heartbeat → [System (heartbeat tick)]:', () => {
    const prefix = renderSenderPrefix({
      source: 'system',
      system: { kind: 'heartbeat' },
    });
    expect(prefix).toBe('[System (heartbeat tick)]: ');
  });

  it('source=system kind=reminder → [System reminder]:', () => {
    const prefix = renderSenderPrefix({
      source: 'system',
      system: { kind: 'reminder' },
    });
    expect(prefix).toBe('[System reminder]: ');
  });

  it('source=system 其他 kind（cron） → [System (<kind>)]:', () => {
    const prefix = renderSenderPrefix({
      source: 'system',
      system: { kind: 'cron' },
    });
    expect(prefix).toBe('[System (cron)]: ');
  });

  it('source=approval → [Approval result]:', () => {
    const prefix = renderSenderPrefix({
      source: 'approval',
      approval: { toolCallId: 'tc01', decision: 'allow' },
    });
    expect(prefix).toBe('[Approval result]: ');
  });

  it('sender 缺失 → 空串（普通 message 无前缀）', () => {
    expect(renderSenderPrefix(undefined)).toBe('');
  });
});

// ── renderMessageContentWithPrefix：content 注入策略 ────────

describe('renderMessageContentWithPrefix — content 注入', () => {
  it('首个 TextBlock → 前缀拼其 text 前（不污染原 block）', () => {
    const msg = makeMsg({
      sender: agentSender({ name: 'explorer', needReply: false }),
      content: [{ type: 'text', text: 'done' }],
    });
    const rendered = renderMessageContentWithPrefix(msg);
    expect(rendered[0]).toEqual({
      type: 'text',
      text: '[Message from explorer (subagent, needReply=false)]: done',
    });
    // 原 content 不被修改
    expect(msg.content[0]).toEqual({ type: 'text', text: 'done' });
  });

  it('首个非 TextBlock（tool_result） → prepend 新 TextBlock 承载前缀', () => {
    const msg = makeMsg({
      sender: { source: 'user' },
      content: [{ type: 'tool_result', toolCallId: 'tc1', content: [], isError: false }],
    });
    const rendered = renderMessageContentWithPrefix(msg);
    expect(rendered[0]).toEqual({ type: 'text', text: '[User]: ' });
    expect(rendered[1]?.type).toBe('tool_result');
  });

  it('空 content → 单个前缀 TextBlock', () => {
    const msg = makeMsg({ sender: { source: 'user' }, content: [] });
    const rendered = renderMessageContentWithPrefix(msg);
    expect(rendered).toEqual([{ type: 'text', text: '[User]: ' }]);
  });

  it('无 sender → 原样返回 content（无前缀注入，引用相同）', () => {
    const msg = makeMsg({ content: [{ type: 'text', text: 'plain' }] });
    const rendered = renderMessageContentWithPrefix(msg);
    expect(rendered).toBe(msg.content);
  });
});

// ── toLogicalMessages：sender 展平 + 字段保留 + 不 mutate ──

describe('toLogicalMessages — sender 展平入首块 + 保留字段 + 不 mutate', () => {
  it('a2a 消息（role=user + source=agent）首块含 [Message from ... needReply=true] 前缀', () => {
    // AT case logical_view_prefix_tc1 场景：mate 发消息到 leader
    const msg = makeMsg({
      role: 'user',
      sender: agentSender({ name: 'Parent Session', type: 'subagent', needReply: true }),
      content: [{ type: 'text', text: '请处理' }],
    });
    const [logical] = toLogicalMessages([msg]);
    expect(logical!.role).toBe('user');
    expect(logical!.content[0]).toEqual({
      type: 'text',
      text: '[Message from Parent Session (subagent, needReply=true)]: 请处理',
    });
  });

  it('保留 sender/metadata 等字段原样（仅 content 被替换）', () => {
    const msg = makeMsg({
      sender: agentSender({ name: 'x', needReply: true }),
      metadata: { foo: 'bar', isSystemReminder: true },
    });
    const [logical] = toLogicalMessages([msg]);
    // sender 仍在（toLogicalMessages 不剥信封，剥信封归 toProtocolMessage）
    expect(logical!.sender).toEqual(msg.sender);
    // metadata 原样保留（其他 kv 不受影响）
    expect(logical!.metadata).toEqual({ foo: 'bar', isSystemReminder: true });
    // id/role/sessionId 原样
    expect(logical!.id).toBe(msg.id);
    expect(logical!.role).toBe(msg.role);
    expect(logical!.sessionId).toBe(msg.sessionId);
  });

  it('不 mutate 原数组与原 message（原 content 首块文本不变）', () => {
    const origBlock: ContentBlock = { type: 'text', text: '原始正文' };
    const msg = makeMsg({
      sender: { source: 'user' },
      content: [origBlock],
    });
    const origArray = [msg];
    const logical = toLogicalMessages(origArray);
    // 原 message 的 content 首块未被改写
    expect(msg.content[0]).toEqual({ type: 'text', text: '原始正文' });
    expect(origBlock).toEqual({ type: 'text', text: '原始正文' });
    // 原数组仍是 1 条（未被 push）
    expect(origArray).toHaveLength(1);
    // 返回是新数组（不同引用）
    expect(logical).not.toBe(origArray);
    expect(logical[0]).not.toBe(msg);
  });

  it('无 sender message → content 原样（无前缀注入）', () => {
    const msg = makeMsg({ content: [{ type: 'text', text: 'plain' }] });
    const [logical] = toLogicalMessages([msg]);
    expect(logical!.content).toEqual([{ type: 'text', text: 'plain' }]);
  });

  it('空数组 → 空数组', () => {
    expect(toLogicalMessages([])).toEqual([]);
  });

  it('混合 sender 数组：每条按自身 sender 渲染（user 前缀 + agent 前缀 共存）', () => {
    const msgs = [
      makeMsg({ id: 'm1', sender: { source: 'user' }, content: [{ type: 'text', text: 'hi' }] }),
      makeMsg({
        id: 'm2',
        sender: agentSender({ name: 'bot', type: 'mate', needReply: false }),
        content: [{ type: 'text', text: 'ack' }],
      }),
    ];
    const logical = toLogicalMessages(msgs);
    expect((logical[0]!.content[0] as { text: string }).text).toBe('[User]: hi');
    expect((logical[1]!.content[0] as { text: string }).text).toBe(
      '[Message from bot (mate, needReply=false)]: ack',
    );
  });
});
