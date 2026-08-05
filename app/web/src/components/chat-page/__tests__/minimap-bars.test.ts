// @vitest-environment jsdom
/**
 * minimap-bars（deriveMinimapBars）单测（v0.0.131 T6）
 * 参考: specs/tech/version_logs/v0.0.131/change_plan.md G 组
 *       specs/ui/components/chat-page/component-history-minimap.md §2
 *
 * 覆盖 PRD §9 UT 全部派生分支：
 *   - user-text → bar
 *   - ≤10 取最近 10（时间序末尾）
 *   - a2a inbox 群聊（默认 sideOfMessage）不产 bar / 单聊（memberSideResolver）产 bar
 *   - system-reminder 天然无 bar（block 级过滤已在 flatten 阶段剔除，elements 里不出现）
 *   - preview = 下一个 agent-answer.text
 *   - 无 answer → undefined（占位）
 *   - 无 answer 但下一个 user-text 先到 → undefined（截断扫描）
 *
 * 用真实 flattenMessages 产 elements（与生产 useFlattenedView 同源管线），保证 UT 贴合实际输入形态。
 */
import { describe, it, expect } from 'vitest';
import { flattenMessages } from '../message-flatten';
import { deriveMinimapBars } from '../minimap-bars';
import { memberSideResolver } from '../chat-actor-strategy';
import type { Message } from '../types';

/** human user 消息（role='user' + sender.source='user'） */
const userMsg = (id: string, text: string): Message => ({
  id,
  sessionId: 'S1',
  role: 'user',
  content: [{ type: 'text', text }],
  createdAt: '2026-07-01T00:00:00Z',
  sender: { source: 'user' },
});

/** assistant 回答消息 */
const assistantMsg = (id: string, text: string): Message => ({
  id,
  sessionId: 'S1',
  role: 'assistant',
  content: [{ type: 'text', text }],
  createdAt: '2026-07-01T00:00:01Z',
  runId: 'R1',
});

/** a2a inbox 消息（role='user' + sender.source='agent' + agent.ref，chat-actor-strategy.isA2aInbox 判定依据） */
const a2aMsg = (id: string, text: string): Message => ({
  id,
  sessionId: 'S1',
  role: 'user',
  content: [{ type: 'text', text }],
  createdAt: '2026-07-01T00:00:02Z',
  sender: { source: 'agent', agent: { ref: { type: 'leader', sessionId: 'leader-s1', name: 'leader1' }, needReply: false } },
});

/** 含 system-reminder 标记的 user 消息（block 级过滤，flatten 后不产 user-text） */
const reminderMsg = (id: string, text: string): Message => ({
  id,
  sessionId: 'S1',
  role: 'user',
  content: [{ type: 'text', text, isSystemReminder: true }],
  createdAt: '2026-07-01T00:00:03Z',
  sender: { source: 'user' },
});

describe('deriveMinimapBars — user-text 产 bar', () => {
  it('单条 human user 消息 → 产一个 bar（messageId/query 对应）', () => {
    const messages = [userMsg('u1', '你好')];
    const elements = flattenMessages(messages);
    const bars = deriveMinimapBars(elements, messages);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ messageId: 'u1', query: '你好' });
  });
});

describe('deriveMinimapBars — ≤20 取最近 20（v0.0.172.ui_fix 由 10 提到 20）', () => {
  it('25 条 user 消息 → 仅返回时间序末尾 20 条', () => {
    const messages: Message[] = [];
    for (let i = 1; i <= 25; i++) {
      messages.push(userMsg(`u${i}`, `q${i}`));
      messages.push(assistantMsg(`a${i}`, `ans${i}`));
    }
    const elements = flattenMessages(messages);
    const bars = deriveMinimapBars(elements, messages);
    expect(bars).toHaveLength(20);
    // 末尾 20 条 = u6..u25（时间序末尾）
    expect(bars.map((b) => b.messageId)).toEqual([
      'u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12', 'u13', 'u14', 'u15',
      'u16', 'u17', 'u18', 'u19', 'u20', 'u21', 'u22', 'u23', 'u24', 'u25',
    ]);
  });

  it('恰好 20 条 → 全部返回，未截断', () => {
    const messages: Message[] = [];
    for (let i = 1; i <= 20; i++) messages.push(userMsg(`u${i}`, `q${i}`));
    const elements = flattenMessages(messages);
    const bars = deriveMinimapBars(elements, messages);
    expect(bars).toHaveLength(20);
  });

  it('少于 20 条（5 条）→ 全部返回，未补齐', () => {
    const messages: Message[] = [];
    for (let i = 1; i <= 5; i++) messages.push(userMsg(`u${i}`, `q${i}`));
    const elements = flattenMessages(messages);
    const bars = deriveMinimapBars(elements, messages);
    expect(bars).toHaveLength(5);
  });

  it('max 参数显式覆盖 → 按传入 max 截取（向后兼容）', () => {
    // 显式传 max=3（极端小值覆盖默认 20），验证 max 参数仍生效
    const messages: Message[] = [];
    for (let i = 1; i <= 10; i++) messages.push(userMsg(`u${i}`, `q${i}`));
    const elements = flattenMessages(messages);
    const bars = deriveMinimapBars(elements, messages, undefined, 3);
    expect(bars).toHaveLength(3);
    expect(bars.map((b) => b.messageId)).toEqual(['u8', 'u9', 'u10']);
  });
});

describe('deriveMinimapBars — a2a inbox side 判定（MUST NOT 按 kind 裸判）', () => {
  it('群聊默认 sideOfMessage（不传 sideResolver）→ a2a inbox 不产 bar', () => {
    const messages = [userMsg('u1', '真人问题'), a2aMsg('a2a1', 'leader 转发消息')];
    const elements = flattenMessages(messages);
    // a2a inbox role='user' 确会产 user-text 元素（PRD §2.2 表述不准确的修正点）
    expect(elements.some((el) => el.kind === 'user-text' && el.messageId === 'a2a1')).toBe(true);
    const bars = deriveMinimapBars(elements, messages); // 不传 sideResolver = 默认 sideOfMessage
    // a2a inbox 默认 side='assistant'（左侧），不产 bar；仅真人 user 消息产 bar
    expect(bars).toHaveLength(1);
    expect(bars[0]!.messageId).toBe('u1');
  });

  it('单聊传 memberSideResolver → a2a inbox 产 bar（右侧，与真人 user 同侧）', () => {
    const messages = [userMsg('u1', '真人问题'), a2aMsg('a2a1', 'leader 转发消息')];
    const elements = flattenMessages(messages);
    // memberSideResolver 签名 (msg: Message)=>...（不接受 undefined），deriveMinimapBars 的
    // SideResolver 类型是 (msg: Message|undefined)=>...（防御 msgById 查不到）；与生产代码
    // section-chat-session 同款内联适配器包一层（纯类型层面适配，undefined 分支理论不可达）
    const bars = deriveMinimapBars(elements, messages, (msg) => (msg ? memberSideResolver(msg) : 'assistant'));
    expect(bars).toHaveLength(2);
    expect(bars.map((b) => b.messageId)).toEqual(['u1', 'a2a1']);
  });
});

describe('deriveMinimapBars — system-reminder 天然无 bar', () => {
  it('reminder text block（isSystemReminder=true）flatten 阶段已过滤，elements 无对应 user-text → 无 bar', () => {
    const messages = [reminderMsg('r1', '[system_reminder]\n提醒内容')];
    const elements = flattenMessages(messages); // 默认 DEFAULT_BLOCK_FILTER 滤 reminder block
    expect(elements).toHaveLength(0);
    const bars = deriveMinimapBars(elements, messages);
    expect(bars).toHaveLength(0);
  });

  it('reminder 与正常 user 消息混合 → 仅正常消息产 bar', () => {
    const messages = [reminderMsg('r1', '提醒'), userMsg('u1', '正常提问')];
    const elements = flattenMessages(messages);
    const bars = deriveMinimapBars(elements, messages);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.messageId).toBe('u1');
  });
});

describe('deriveMinimapBars — preview 派生', () => {
  it('preview = 该 user-text 后、下一 user-text 前的首个 agent-answer.text', () => {
    const messages = [userMsg('u1', '问题1'), assistantMsg('a1', '回答1')];
    const elements = flattenMessages(messages);
    const bars = deriveMinimapBars(elements, messages);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.preview).toBe('回答1');
  });

  it('尚未生成 answer（无后续元素）→ preview=undefined（占位）', () => {
    const messages = [userMsg('u1', '问题1')];
    const elements = flattenMessages(messages);
    const bars = deriveMinimapBars(elements, messages);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.preview).toBeUndefined();
  });

  it('下一个 user-text 先于 agent-answer 到达（尚未回复即追问）→ preview=undefined', () => {
    const messages = [userMsg('u1', '问题1'), userMsg('u2', '问题2（还没等到回答）')];
    const elements = flattenMessages(messages);
    const bars = deriveMinimapBars(elements, messages);
    expect(bars).toHaveLength(2);
    // u1 在 u2（下一个 user-text）到达前未见 agent-answer → undefined
    expect(bars[0]!.preview).toBeUndefined();
    // u2 后无更多元素 → 同样 undefined
    expect(bars[1]!.preview).toBeUndefined();
  });

  it('tool-call-item 夹在 user-text 与 agent-answer 之间 → 跳过继续扫，preview 仍正确', () => {
    const messages: Message[] = [
      userMsg('u1', '帮我查一下天气'),
      {
        id: 'a1',
        sessionId: 'S1',
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'call_1', name: 'weather', arguments: {} }],
        createdAt: '2026-07-01T00:00:01Z',
        runId: 'R1',
      },
      assistantMsg('a2', '今天晴天'),
    ];
    const elements = flattenMessages(messages);
    expect(elements.map((e) => e.kind)).toEqual(['user-text', 'tool-call-item', 'agent-answer']);
    const bars = deriveMinimapBars(elements, messages);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.preview).toBe('今天晴天');
  });
});
