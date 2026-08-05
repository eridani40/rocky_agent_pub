/**
 * feishu-protocol.ts 单测
 * 参考: specs/tech/channel/[P0]channel_impl_interface.md §2/§4
 *       reqs/[done] v0.0.103.channel/design-feishu.md §2/§3/§5
 *
 * 覆盖：
 *   - parseFeishuMessage：群/私聊、@bot 剥离、文本解析、malformed 拒绝
 *   - formatFeishuOutbound：text blocks 拼接、tool blocks 跳过、空内容返 []
 *   - chunkTextForOutbound：超长分块（段落边界优先）
 */
import { describe, it, expect } from 'vitest';
import {
  parseFeishuMessage,
  formatFeishuOutbound,
  chunkTextForOutbound,
} from '../feishu-protocol';
import type { Message } from '../../../../server/src/message/types';

describe('parseFeishuMessage', () => {
  it('群聊（group）消息：conversationId=chatId', () => {
    const raw = {
      sender: {
        sender_id: { open_id: 'ou_user123' },
      },
      message: {
        message_id: 'om_msg1',
        chat_id: 'oc_chatABC',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '你好' }),
      },
    };
    const r = parseFeishuMessage(raw);
    expect(r).not.toBeNull();
    expect(r!.conversationId).toBe('oc_chatABC');
    expect(r!.chatType).toBe('group');
    expect(r!.text).toBe('你好');
    expect(r!.messageId).toBe('om_msg1');
    expect(r!.imUserId).toBe('ou_user123');
    expect(r!.receiveIdType).toBe('chat_id');
  });

  it('私聊（p2p）消息：conversationId=openId', () => {
    const raw = {
      sender: { sender_id: { open_id: 'ou_userXYZ' } },
      message: {
        message_id: 'om_msg2',
        chat_id: 'oc_p2p',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello /listp' }),
      },
    };
    const r = parseFeishuMessage(raw);
    expect(r).not.toBeNull();
    expect(r!.conversationId).toBe('ou_userXYZ');
    expect(r!.chatType).toBe('p2p');
    expect(r!.text).toBe('hello /listp');
    expect(r!.receiveIdType).toBe('open_id');
  });

  it('剥离 @bot mention（保留 / 前缀）', () => {
    const botOpenId = 'ou_bot123';
    const raw = {
      sender: { sender_id: { open_id: 'ou_user' } },
      message: {
        message_id: 'om_msg3',
        chat_id: 'oc_chat',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 /status' }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bot123' }, name: 'BotName' },
        ],
      },
    };
    const r = parseFeishuMessage(raw, botOpenId);
    expect(r).not.toBeNull();
    // @bot 占位符被剥离，/ 前缀保留在首位
    expect(r!.text).toBe('/status');
  });

  it('剥离 @bot 但保留其他 @mention 文本', () => {
    const botOpenId = 'ou_bot';
    const raw = {
      sender: { sender_id: { open_id: 'ou_sender' } },
      message: {
        message_id: 'om_msg4',
        chat_id: 'oc_chat',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 hello @_user_2' }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'BotName' },
          { key: '@_user_2', id: { open_id: 'ou_other' }, name: 'OtherUser' },
        ],
      },
    };
    const r = parseFeishuMessage(raw, botOpenId);
    expect(r).not.toBeNull();
    expect(r!.text).toBe('hello @_user_2');
  });

  it('无 botOpenId 时保留 @bot 占位符（caller 责任）', () => {
    const raw = {
      sender: { sender_id: { open_id: 'ou_sender' } },
      message: {
        message_id: 'om_msg5',
        chat_id: 'oc_chat',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 hi' }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'BotName' }],
      },
    };
    const r = parseFeishuMessage(raw);
    expect(r).not.toBeNull();
    expect(r!.text).toBe('@_user_1 hi');
  });

  it('imUserName: 非 @all 非 @bot 的 mention name', () => {
    const raw = {
      sender: { sender_id: { open_id: 'ou_sender' } },
      message: {
        message_id: 'om_msg6',
        chat_id: 'oc_chat',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'hi' }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_alice' }, name: 'Alice' }],
      },
    };
    const r = parseFeishuMessage(raw, 'ou_bot');
    expect(r).not.toBeNull();
    expect(r!.imUserName).toBe('Alice');
  });

  it('拒绝 malformed event（缺字段）返 null', () => {
    expect(parseFeishuMessage(null)).toBeNull();
    expect(parseFeishuMessage({})).toBeNull();
    expect(parseFeishuMessage({ sender: {}, message: {} })).toBeNull();
    expect(
      parseFeishuMessage({
        sender: { sender_id: {} },
        message: { message_id: 'x', chat_id: '', chat_type: 'group', message_type: 'text', content: '{}' },
      }),
    ).toBeNull();
  });

  it('非文本消息（message_type=image）返 null（本期不支持图片入站）', () => {
    const raw = {
      sender: { sender_id: { open_id: 'ou_x' } },
      message: {
        message_id: 'om_img',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'image',
        content: '{}',
      },
    };
    expect(parseFeishuMessage(raw)).toBeNull();
  });
});

describe('formatFeishuOutbound', () => {
  function makeMsg(content: Message['content']): Message {
    return {
      id: 'msg_test',
      sessionId: 'sess_test',
      role: 'assistant',
      content,
    };
  }

  it('TextBlock → text payload', () => {
    const payloads = formatFeishuOutbound(makeMsg([{ type: 'text', text: 'hi' }]), 'group');
    expect(payloads).toHaveLength(1);
    expect(payloads[0].msg_type).toBe('text');
    expect(JSON.parse(payloads[0].content)).toEqual({ text: 'hi' });
    expect(payloads[0].receive_id_type).toBe('chat_id');
  });

  it('私聊（p2p）→ receive_id_type=open_id', () => {
    const payloads = formatFeishuOutbound(makeMsg([{ type: 'text', text: 'hi' }]), 'p2p');
    expect(payloads[0].receive_id_type).toBe('open_id');
  });

  it('多 TextBlock 用 \\n\\n 拼接', () => {
    const payloads = formatFeishuOutbound(
      makeMsg([
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ]),
      'group',
    );
    expect(payloads).toHaveLength(1);
    expect(JSON.parse(payloads[0].content).text).toBe('第一段\n\n第二段');
  });

  it('ToolCallBlock / ToolResultBlock / ReasoningBlock / UsageBlock 跳过', () => {
    const payloads = formatFeishuOutbound(
      makeMsg([
        { type: 'tool_call', id: 'tc1', name: 'x', arguments: {} },
        { type: 'text', text: '实际回复' },
        { type: 'tool_result', toolCallId: 'tc1', content: [], isError: false },
        { type: 'reasoning', text: '内心独白' },
        { type: 'usage', usage: { total_tokens: 0 } },
      ]),
      'group',
    );
    expect(payloads).toHaveLength(1);
    expect(JSON.parse(payloads[0].content).text).toBe('实际回复');
  });

  it('空内容（无 TextBlock）返 []', () => {
    expect(formatFeishuOutbound(makeMsg([]), 'group')).toEqual([]);
    expect(
      formatFeishuOutbound(
        makeMsg([{ type: 'text', text: '' }, { type: 'text', text: '  ' }]),
        'group',
      ),
    ).toEqual([]);
  });

  it('超长文本触发分块', () => {
    const longText = 'a'.repeat(5000);
    const payloads = formatFeishuOutbound(makeMsg([{ type: 'text', text: longText }]), 'group');
    expect(payloads.length).toBe(2);
    // 拼接应能还原原文（无丢失）
    const joined = payloads.map((p) => JSON.parse(p.content).text).join('');
    expect(joined).toBe(longText);
  });
});

describe('chunkTextForOutbound', () => {
  it('短文本不切', () => {
    expect(chunkTextForOutbound('short', 100)).toEqual(['short']);
  });

  it('段落边界优先切', () => {
    const text = `第一段\n\n${'b'.repeat(50)}\n\n第三段`;
    const chunks = chunkTextForOutbound(text, 30);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // 拼接无丢失
    expect(chunks.join('')).not.toContain('undefined');
  });

  it('无换行时硬切', () => {
    const text = 'x'.repeat(100);
    const chunks = chunkTextForOutbound(text, 30);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.join('')).toBe(text);
  });
});
