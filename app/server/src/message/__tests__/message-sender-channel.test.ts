/**
 * MessageSender user variant — channel? 字段类型与运行时（T4 模块 5，D5）
 * 参考: app/server/src/message/types.ts（MessageSender 判别联合 + user 变体）
 *       specs/tech/channel/[P0]channel_impl_interface.md §5.1（D5：channel=client 对等不扩 source）
 *
 * 核心约束（D5）：
 *   - 不新增 source 类型（source 仍是 'user'，不是 'channel'）
 *   - 老消息无 channel 字段仍合法（向后兼容）
 *   - channel 字段含 5 子字段：type / configId / conversationId / imUserId / imUserName
 *     （type=ChannelConfig.implId，如 'feishu'；client 缺省语义 'client'）
 *
 * 此测试同时是类型级断言（编译期）+ 运行时断言。
 */
import { describe, it, expect } from 'vitest';
import type { Message, MessageSender, MessageSenderChannel } from '../types';

describe('MessageSender user variant — channel? 字段（D5）', () => {
  it('source="user" 无 channel 字段仍合法（向后兼容）', () => {
    const sender: MessageSender = { source: 'user' };
    expect(sender.source).toBe('user');
    // channel 字段可选，未填不报错
    expect((sender as { channel?: unknown }).channel).toBeUndefined();
  });

  it('source="user" + channel 含 5 子字段 → 合法', () => {
    const sender: MessageSender = {
      source: 'user',
      channel: {
        type: 'feishu',
        configId: '01HX...',
        conversationId: 'oc_xyz',
        imUserId: 'ou_abc',
        imUserName: '张三',
      },
    };
    expect(sender.source).toBe('user');
    if (sender.source === 'user') {
      expect(sender.channel?.type).toBe('feishu');
      expect(sender.channel?.configId).toBe('01HX...');
      expect(sender.channel?.conversationId).toBe('oc_xyz');
      expect(sender.channel?.imUserId).toBe('ou_abc');
      expect(sender.channel?.imUserName).toBe('张三');
    }
  });

  it("channel 字段不改变 source 枚举（仍是 'user'）", () => {
    // D5 核心约束：不新增 'channel' source
    const sender: MessageSender = { source: 'user', channel: {
      type: 'feishu', configId: 'i', conversationId: 'c', imUserId: 'u', imUserName: 'n',
    } };
    expect(sender.source).not.toBe('channel');
    expect(sender.source).toBe('user');
  });

  it('MessageSenderChannel 接口字段闭合（5 子字段含 type）', () => {
    const ch: MessageSenderChannel = {
      type: 'feishu',
      configId: 'inst-1',
      conversationId: 'conv-1',
      imUserId: 'user-1',
      imUserName: 'Alice',
    };
    expect(Object.keys(ch).sort()).toEqual(
      ['configId', 'conversationId', 'imUserId', 'imUserName', 'type'],
    );
  });

  it('Message.sender 接受 user+channel 信封（端到端类型）', () => {
    const msg: Message = {
      id: 'msg-1',
      sessionId: 'sess-1',
      role: 'user',
      content: [{ type: 'text', text: 'hello from feishu' }],
      sender: {
        source: 'user',
        channel: {
          type: 'feishu',
          configId: 'inst-feishu-1',
          conversationId: 'oc_chat_1',
          imUserId: 'ou_open_id',
          imUserName: '飞书用户',
        },
      },
    };
    expect(msg.role).toBe('user');
    expect(msg.sender).toBeDefined();
    if (msg.sender && msg.sender.source === 'user') {
      expect(msg.sender.channel?.conversationId).toBe('oc_chat_1');
    }
  });

  it('其他 source（agent/system/approval）不受 channel 字段影响', () => {
    const agentSender: MessageSender = {
      source: 'agent',
      agent: {
        ref: { sessionId: 's1', name: 'A', type: 'rocky' },
        needReply: false,
      },
    };
    expect(agentSender.source).toBe('agent');
    // agent 变体经判别联合窄化后不含 channel 字段
    if (agentSender.source === 'agent') {
      expect(agentSender.agent.ref.sessionId).toBe('s1');
    }
  });

  it('feishu inbound 构造的 sender 形态匹配（handleInbound 用）', () => {
    // 验证 feishu-connection.ts 的构造已可去掉 cast——构造合法对象不需 cast
    const sender: MessageSender = {
      source: 'user',
      channel: {
        type: 'feishu', // this.config.implId
        configId: '01J...', // this.config.id
        conversationId: 'oc_chat_x', // parsed.conversationId
        imUserId: 'ou_open_y', // parsed.imUserId
        imUserName: '', // parsed.imUserName（可能为空串）
      },
    };
    expect(sender.source).toBe('user');
    expect(sender.channel?.type).toBe('feishu');
    expect(sender.channel?.imUserName).toBe('');
  });
});
