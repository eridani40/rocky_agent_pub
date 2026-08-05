// @vitest-environment jsdom
/**
 * message-flatten 过滤单测（v0.0.39 块级 reminder + 消息级白名单）
 * 参考: specs/ui/components/studio-page/squad-chat-page.md「渲染策略契约」
 *       specs/ui/components/chat-page/_overview.md §2
 *
 * 契约注解（reminder 仍发 LLM）：
 *   reminder block 标记 isSystemReminder=true 是**前端渲染过滤标记**，与 LLM encode 无关。
 *   llm/protocol-encode.ts encodeContentBlock 对 text block 只读 b.text 透传 wire，
 *   isSystemReminder 字段不进 wire body → reminder 文本仍正常发给 LLM（语义不变）。
 *   本测试只覆盖**前端渲染过滤**行为；LLM 收到 reminder 的契约由 protocol-encode 自身保证
 *   （text case 只取 b.text，新字段透明）。
 */
import { describe, it, expect } from 'vitest';
import { flattenMessages, flattenAndGroup, DEFAULT_BLOCK_FILTER } from '../message-flatten';
import { isUser, isA2aInbox, groupMessageFilter } from '../chat-actor-strategy';
import type { Message } from '../types';

const userMsg = (id: string, content: Message['content']): Message => ({
  id,
  sessionId: 'S1',
  role: 'user',
  content,
  createdAt: '2026-06-29T00:00:00Z',
  sender: { source: 'user' },
});

const assistantMsg = (id: string, content: Message['content']): Message => ({
  id,
  sessionId: 'S1',
  role: 'assistant',
  content,
  createdAt: '2026-06-29T00:00:01Z',
  runId: 'R1',
});

/** a2a inbox 消息（role='user' + source='agent' + agent.ref） */
const a2aInboxMsg = (id: string, name: string, type: 'leader' | 'mate'): Message => ({
  id,
  sessionId: 'S1',
  role: 'user',
  content: [{ type: 'text', text: id + '-a2a' }],
  createdAt: '2026-06-29T00:00:02Z',
  sender: { source: 'agent', agent: { ref: { type, name, sessionId: 'sx' }, needReply: false } },
});

describe('reminder 块级过滤（DEFAULT_BLOCK_FILTER）', () => {
  it('isSystemReminder=true 的 text block 不进 view 序列', () => {
    const els = flattenMessages([
      userMsg('u1', [
        { type: 'text', text: '真实问题' },
        { type: 'text', text: '[system_reminder]\n- 提醒', isSystemReminder: true },
      ]),
    ]);
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ kind: 'user-text', text: '真实问题' });
    // reminder block 被滤
    expect(els.some((e) => e.kind === 'user-text' && e.text.includes('system_reminder'))).toBe(false);
  });

  it('普通 text block（无标记）正常渲染（向后兼容）', () => {
    const els = flattenMessages([
      userMsg('u1', [{ type: 'text', text: '普通文本' }]),
    ]);
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ kind: 'user-text', text: '普通文本' });
  });

  it('assistant 的 reminder text block 也被滤（assistant 也可能被注入）', () => {
    const els = flattenMessages([
      assistantMsg('a1', [
        { type: 'text', text: '回复', isSystemReminder: true },
        { type: 'text', text: '正常回复' },
      ]),
    ]);
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ kind: 'agent-answer', text: '正常回复' });
  });

  it('reminder block 的 part key 不影响其他 text block 的 key（同 message 内）', () => {
    // u1 有 3 个 text block：[normal, reminder, normal2] → 渲染 normal(u0) + normal2(u2)
    // key 用原 index（u0/u2），不重排为 u0/u1（保持稳定，SSE 乱序不抖动）
    const els = flattenMessages([
      userMsg('u1', [
        { type: 'text', text: '第一' },
        { type: 'text', text: 'reminder', isSystemReminder: true },
        { type: 'text', text: '第三' },
      ]),
    ]);
    expect(els.map((e) => (e as { key: string }).key)).toEqual(['u1:u0', 'u1:u2']);
  });

  it('DEFAULT_BLOCK_FILTER 谓词本身：reminder text→false，普通 text→true，tool_call→true', () => {
    expect(DEFAULT_BLOCK_FILTER({ type: 'text', text: 'r', isSystemReminder: true }, {} as Message)).toBe(false);
    expect(DEFAULT_BLOCK_FILTER({ type: 'text', text: 'n' }, {} as Message)).toBe(true);
    expect(DEFAULT_BLOCK_FILTER({ type: 'tool_call', id: 'c', name: 'x', arguments: {} }, {} as Message)).toBe(true);
  });
});

describe('消息分类谓词（isUser / isA2aInbox）— a2a 双重身份关键', () => {
  it('a2a inbox: role=user + source=agent + ref → isA2aInbox=true, isUser=false（★ 不能裸用 role）', () => {
    const m = a2aInboxMsg('a1', 'captain', 'leader');
    expect(isA2aInbox(m)).toBe(true);
    // ★ 关键：a2a role='user' 但 isUser 必须返回 false（否则误纳右侧 user 气泡）
    expect(isUser(m)).toBe(false);
  });

  it('human user: source=user → isUser=true, isA2aInbox=false', () => {
    const m = userMsg('u1', [{ type: 'text', text: 'hi' }]);
    expect(isUser(m)).toBe(true);
    expect(isA2aInbox(m)).toBe(false);
  });

  it('assistant answer: role=assistant 无 sender → isUser=false, isA2aInbox=false', () => {
    const m = assistantMsg('a1', [{ type: 'text', text: 'reply' }]);
    expect(isUser(m)).toBe(false);
    expect(isA2aInbox(m)).toBe(false);
  });

  it('历史兼容：role=user 无 sender → isUser=true（非 a2a 兜底）', () => {
    const m: Message = { id: 'x', sessionId: 's', role: 'user', content: [{ type: 'text', text: 'a' }], createdAt: 't' };
    expect(isUser(m)).toBe(true);
    expect(isA2aInbox(m)).toBe(false);
  });
});

describe('群聊白名单（groupMessageFilter + flattenAndGroup）', () => {
  it('白名单：user + a2a inbox 通过，assistant answer + tool + system mute', () => {
    const msgs: Message[] = [
      userMsg('u1', [{ type: 'text', text: 'hi' }]),
      a2aInboxMsg('a1', 'captain', 'leader'),
      assistantMsg('as1', [{ type: 'text', text: 'loop-reply' }]),
      { id: 't1', sessionId: 'S1', role: 'tool', content: [{ type: 'tool_result', toolCallId: 'c1', content: [], isError: false }], createdAt: 't' },
    ];
    // 谓词层
    expect(groupMessageFilter(msgs[0]!)).toBe(true); // user
    expect(groupMessageFilter(msgs[1]!)).toBe(true); // a2a inbox
    expect(groupMessageFilter(msgs[2]!)).toBe(false); // assistant answer mute
    expect(groupMessageFilter(msgs[3]!)).toBe(false); // tool mute
    // 集成层：flattenAndGroup 只产 user-text(human) + user-text(a2a) 两条
    // ★ 注：a2a inbox role='user' → flatten 产 user-text（非 agent-answer）；
    //   side 重分类（a2a→assistant 左侧）是内核 component-message-stream 的职责（sideOfMessage），
    //   不在 flatten 层。这里只验白名单过滤生效（assistant answer + tool 被滤）。
    const { elements } = flattenAndGroup(msgs, { messageFilter: groupMessageFilter });
    expect(elements).toHaveLength(2);
    expect(elements[0]).toMatchObject({ kind: 'user-text', messageId: 'u1' });
    expect(elements[1]).toMatchObject({ kind: 'user-text', messageId: 'a1' }); // a2a role='user'
  });

  it('群聊 reminder block 也被默认 blockFilter 滤（a2a message 带 reminder）', () => {
    const msgs: Message[] = [
      {
        id: 'a1',
        sessionId: 'S1',
        role: 'user',
        content: [
          { type: 'text', text: 'a2a 正文' },
          { type: 'text', text: '[system_reminder]...', isSystemReminder: true },
        ],
        createdAt: 't',
        sender: { source: 'agent', agent: { ref: { type: 'leader', name: 'c', sessionId: 's' }, needReply: false } },
      },
    ];
    const { elements } = flattenAndGroup(msgs, { messageFilter: groupMessageFilter });
    // a2a role='user' → flatten 产 user-text（仅 1 条：reminder block 被默认 blockFilter 滤）
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ kind: 'user-text', text: 'a2a 正文' });
  });
});

describe('单聊全展示（不传 messageFilter）', () => {
  it('user + assistant + tool_call 全部进 view 序列（仅 reminder 被默认滤）', () => {
    const msgs: Message[] = [
      userMsg('u1', [{ type: 'text', text: 'hi' }]),
      assistantMsg('a1', [
        { type: 'text', text: '回复' },
        { type: 'tool_call', id: 'c1', name: 'bash', arguments: {} },
      ]),
      { id: 't1', sessionId: 'S1', role: 'tool', content: [{ type: 'tool_result', toolCallId: 'c1', content: [{ type: 'text', text: 'r' }], isError: false }], createdAt: 't' },
    ];
    const { elements } = flattenAndGroup(msgs);
    // user-text + agent-answer + tool-call-item（tool_result 绑定到 call，不单独产 element）
    expect(elements.map((e) => e.kind)).toEqual(['user-text', 'agent-answer', 'tool-call-item']);
  });
});
