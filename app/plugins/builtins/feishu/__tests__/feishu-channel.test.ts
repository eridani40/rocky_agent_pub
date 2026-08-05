/**
 * feishu impl + FeishuConnection 单测（mock SDK 边界，不连真飞书）
 * 参考: specs/tech/channel/[P0]channel_impl_interface.md §4.2
 *       reqs/[done] v0.0.103.channel/design-feishu.md §4（入站三件套）
 *
 * v0.0.206 无状态化重构：构造模式 = `new FeishuChannel('feishu', {}, genId)`（无状态 impl）
 *   + `impl.connect(config, backend)` → FeishuConnection 句柄（handleInbound/sendOutbound/
 *   disconnect/updateInputState）。「未连接」路径直 new FeishuConnection 不开 open()。
 *
 * 覆盖（与原 feishu-channel.test.ts 逐用例语义等价）：
 *   - connect 读凭证 + new FeishuClient + start / 缺凭证抛错
 *   - disconnect 清去抖 timer + client.disconnect / idempotent
 *   - handleInbound 去重（message_id 幂等）
 *   - handleInbound 斜杠识别 → 立即派发（不进 agent）
 *   - handleInbound 普通消息 → 未绑定提示 / 已绑定 → deliverTo / 去抖合并多条
 *   - sendOutbound 未绑定 conversation → drop / 已绑定 → sendMessage / client 未连接 drop
 *   - updateInputState no-op
 *
 * Mock 边界：
 *   - FeishuClient（不直 import SDK）
 *   - ChannelManagerBackend（listSessions/bind/getBindedSession/deliverTo/findConversationBySession）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChannelConfig } from '../../../../server/src/channel/types';
import type { ChannelManagerBackend } from '../../../../server/src/channel/channel-base';
import type { Message } from '../../../../server/src/message/types';
import type { FeishuOutboundPayload } from '../feishu-protocol';

// vi.mock 用绝对路径（memory: test-vitest-mock-absolute-path，bun+vitest 全量并发下相对路径静默失效）。
// vi.mock 被 vitest 提升到文件顶部（早于 import/const），故 path/mockFn 必须用 vi.hoisted 声明。
// ⚠️ 绝对路径用 __dirname 派生（portable），严禁硬编码 worktree 路径。
const { MockFeishuClient, clientPath, channelPath, connectionPath } = vi.hoisted(() => {
  const { resolve } = require('node:path') as typeof import('node:path');
  class MockFeishuClientImpl {
    static lastInstance: MockFeishuClientImpl | null = null;
    sentMessages: { receiveId: string; payload: FeishuOutboundPayload }[] = [];
    connected = false;
    constructor(
      public cfg: { appId: string; appSecret: string },
      public callbacks: {
        onMessage: (raw: unknown) => void;
        onReady?: () => void;
        onError?: (err: Error) => void;
      },
    ) {
      MockFeishuClientImpl.lastInstance = this;
    }
    async connect() {
      this.connected = true;
      this.callbacks.onReady?.();
    }
    async disconnect() {
      this.connected = false;
    }
    async sendMessage(receiveId: string, payload: FeishuOutboundPayload) {
      this.sentMessages.push({ receiveId, payload });
    }
  }
  return {
    MockFeishuClient: MockFeishuClientImpl,
    clientPath: resolve(__dirname, '../feishu-client'),
    channelPath: resolve(__dirname, '../feishu-channel'),
    connectionPath: resolve(__dirname, '../feishu-connection'),
  };
});

vi.mock(clientPath, () => ({ FeishuClient: MockFeishuClient }));

// 必须在 mock 之后 import（mock hoisting 顺序，绝对路径避免相对路径全量并发静默失效）
const FeishuChannelModule = await import(channelPath);
const FeishuChannel = FeishuChannelModule.default as (typeof import('../feishu-channel'))['default'];
const { FeishuConnection } = await import(connectionPath);

function makeConfig(config: Record<string, unknown> = {}): ChannelConfig {
  return {
    id: 'cfg_test',
    implId: 'feishu',
    name: 'test-config',
    enabled: true,
    config: { appId: 'app_x', appSecret: 'sec_y', ...config },
  };
}

function makeManager(overrides: Partial<ChannelManagerBackend> = {}): ChannelManagerBackend {
  return {
    getBinding: async () => null,
    deliverTo: async () => undefined,
    bind: async () => {},
    unbind: async () => {},
    findConversationBySession: async () => null,
    listSessions: async () => [],
    ...overrides,
  };
}

// 所有 describe 共用 fake timers（去抖 setTimeout 是核心机制）
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 构造飞书 group 消息事件 */
function makeGroupEvent(
  messageId: string,
  text: string,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    sender: { sender_id: { open_id: 'ou_user1' } },
    message: {
      message_id: messageId,
      chat_id: 'oc_chatXYZ',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      ...extra,
    },
  };
}

describe('FeishuChannel.connect/disconnect', () => {

  it('connect：读 appId/appSecret + new FeishuClient + start', async () => {
    const impl = new FeishuChannel('feishu', {});
    await impl.connect(makeConfig(), makeManager());
    expect((MockFeishuClient as unknown as { lastInstance: unknown }).lastInstance).toBeDefined();
    // mockClient.connected=true 即 start 被调
    const mockClient = (MockFeishuClient as unknown as { lastInstance: { connected: boolean } })
      .lastInstance;
    expect(mockClient.connected).toBe(true);
  });

  it('connect：缺凭证抛错', async () => {
    const impl = new FeishuChannel('feishu', {});
    await expect(impl.connect(makeConfig({ appId: '', appSecret: '' }), makeManager()))
      .rejects.toThrow(/appId 或 appSecret/);
  });

  it('disconnect：清去抖 timer + client.disconnect', async () => {
    const impl = new FeishuChannel('feishu', {});
    const h = await impl.connect(makeConfig(), makeManager());
    await h.disconnect();
    const mockClient = (MockFeishuClient as unknown as { lastInstance: { connected: boolean } })
      .lastInstance;
    expect(mockClient.connected).toBe(false);
  });

  it('disconnect：idempotent（未连接不抛错）', async () => {
    // 未 open 的 FeishuConnection（client=null）→ disconnect 不抛错
    const conn = new FeishuConnection(makeConfig(), makeManager());
    await expect(conn.disconnect()).resolves.toBeUndefined();
  });
});

describe('FeishuConnection.handleInbound 去重（message_id 幂等）', () => {
  it('同 message_id 第二次 drop', async () => {
    const deliverTo = vi.fn(async () => undefined);
    const manager = makeManager({
      getBinding: async () => 'sess_bound',
      deliverTo,
    });
    const impl = new FeishuChannel('feishu', {});
    const h = await impl.connect(makeConfig(), manager);

    await h.handleInbound(makeGroupEvent('om_dup_1', 'hello'));
    await h.handleInbound(makeGroupEvent('om_dup_1', 'hello')); // 重复

    // 去抖 flush 后只 deliverTo 1 次
    await vi.advanceTimersByTimeAsync(700);
    expect(deliverTo).toHaveBeenCalledTimes(1);
  });
});

describe('FeishuConnection.handleInbound 斜杠识别', () => {
  it('斜杠消息立即派发 → bind（不进 agent deliverTo）', async () => {
    const deliverTo = vi.fn(async () => undefined);
    const bind = vi.fn(async () => {});
    const listPlaygroundSessions = vi.fn(async () => [
      { id: 'sess_p1', title: 'P1' },
    ]) as unknown as () => Promise<{ id: string; title: string }[]>;
    const manager = makeManager({
      deliverTo,
      bind,
      listSessions: listPlaygroundSessions as never,
    });

    const impl = new FeishuChannel('feishu', {});
    const h = await impl.connect(makeConfig(), manager);

    await h.handleInbound(makeGroupEvent('om_slash1', '/bindp 1'));

    // bind 应被调用（绑 oc_chatXYZ → sess_p1）
    expect(bind).toHaveBeenCalledWith('cfg_test', 'oc_chatXYZ', 'sess_p1', 'slash');
    // deliverTo 不应被调用（斜杠不进 agent）
    expect(deliverTo).not.toHaveBeenCalled();
    // 飞书应收到回执（mock client.sentMessages）
    const mockClient = (MockFeishuClient as unknown as {
      lastInstance: { sentMessages: unknown[] };
    }).lastInstance;
    expect(mockClient.sentMessages.length).toBeGreaterThan(0);
  });

  it('斜杠指令不进过去抖（立即执行）', async () => {
    const deliverTo = vi.fn(async () => undefined);
    const manager = makeManager({ deliverTo });
    const impl = new FeishuChannel('feishu', {});
    const h = await impl.connect(makeConfig(), manager);

    await h.handleInbound(makeGroupEvent('om_slash_immediate', '/listp'));

    // 不需要 advance timer（斜杠立即执行）
    expect(deliverTo).not.toHaveBeenCalled();
    const mockClient = (MockFeishuClient as unknown as {
      lastInstance: { sentMessages: unknown[] };
    }).lastInstance;
    expect(mockClient.sentMessages.length).toBeGreaterThan(0);
  });
});

describe('FeishuConnection.handleInbound 普通消息', () => {
  it('未绑定 conversation → 提示用户先 /bindp', async () => {
    const deliverTo = vi.fn(async () => undefined);
    const manager = makeManager({
      getBinding: async () => null,
      deliverTo,
    });
    const impl = new FeishuChannel('feishu', {});
    const h = await impl.connect(makeConfig(), manager);

    await h.handleInbound(makeGroupEvent('om_unbound', '你好'));
    await vi.advanceTimersByTimeAsync(700);

    expect(deliverTo).not.toHaveBeenCalled();
    const mockClient = (MockFeishuClient as unknown as {
      lastInstance: { sentMessages: { payload: FeishuOutboundPayload }[] };
    }).lastInstance;
    const lastSent = mockClient.sentMessages.at(-1);
    expect(lastSent).toBeDefined();
    const text = JSON.parse(lastSent!.payload.content).text as string;
    expect(text).toContain('未绑定');
  });

  it('已绑定 conversation → deliverTo（sender 带 channel 字段：type=implId + configId=config.id）', async () => {
    const deliverTo = vi.fn(async (_sid: string, msg: Message) => undefined);
    const manager = makeManager({
      getBinding: async () => 'sess_target',
      deliverTo: deliverTo as never,
    });
    const impl = new FeishuChannel('feishu', {});
    const h = await impl.connect(makeConfig(), manager);

    await h.handleInbound(makeGroupEvent('om_msg1', '你好 agent'));
    await vi.advanceTimersByTimeAsync(700);

    expect(deliverTo).toHaveBeenCalledTimes(1);
    const [sid, msg] = deliverTo.mock.calls[0] as [string, Message];
    expect(sid).toBe('sess_target');
    expect(msg.role).toBe('user');
    expect(msg.content[0]).toEqual({ type: 'text', text: '你好 agent' });
    // sender 带 channel 字段：type = config.implId（accumulator 来源标识用），configId = config.id
    const sender = msg.sender as { source: string; channel?: { type: string; configId: string; conversationId: string } };
    expect(sender.source).toBe('user');
    expect(sender.channel?.type).toBe('feishu'); // === config.implId
    expect(sender.channel?.configId).toBe('cfg_test');
    expect(sender.channel?.conversationId).toBe('oc_chatXYZ');
  });

  it('去抖合并多条同 conversation 消息', async () => {
    const deliverTo = vi.fn(async () => undefined);
    const manager = makeManager({
      getBinding: async () => 'sess_target',
      deliverTo,
    });
    const impl = new FeishuChannel('feishu', {});
    const h = await impl.connect(makeConfig(), manager);

    // 连发 3 条（同 conversationId）—— 应合并成 1 次 deliverTo
    await h.handleInbound(makeGroupEvent('om_d_1', '第一'));
    await h.handleInbound(makeGroupEvent('om_d_2', '第二'));
    await h.handleInbound(makeGroupEvent('om_d_3', '第三'));

    expect(deliverTo).not.toHaveBeenCalled(); // 还在去抖窗口
    await vi.advanceTimersByTimeAsync(700);

    expect(deliverTo).toHaveBeenCalledTimes(1);
    const msg = (deliverTo.mock.calls[0] as [string, Message])[1];
    const text = (msg.content[0] as { text: string }).text;
    expect(text).toContain('第一');
    expect(text).toContain('第二');
    expect(text).toContain('第三');
  });
});

describe('FeishuConnection.sendOutbound', () => {
  it('未绑定 conversation → drop（不 sendMessage）', async () => {
    const manager = makeManager({
      findConversationBySession: async () => null,
    });
    const impl = new FeishuChannel('feishu', {});
    const h = await impl.connect(makeConfig(), manager);

    const before = (MockFeishuClient as unknown as {
      lastInstance: { sentMessages: unknown[] };
    }).lastInstance.sentMessages.length;
    await h.sendOutbound({
      id: 'm1',
      sessionId: 'sess_x',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
    });
    const after = (MockFeishuClient as unknown as {
      lastInstance: { sentMessages: unknown[] };
    }).lastInstance.sentMessages.length;
    expect(after).toBe(before); // 没新增
  });

  it('已绑定 → sendMessage 调用（群聊 receiveIdType=chat_id）', async () => {
    const manager = makeManager({
      findConversationBySession: async (_iid: string, _sid: string) => 'oc_chatXYZ',
    });
    const impl = new FeishuChannel('feishu', {});
    const h = await impl.connect(makeConfig(), manager);

    await h.sendOutbound({
      id: 'm2',
      sessionId: 'sess_x',
      role: 'assistant',
      content: [{ type: 'text', text: 'agent 回复' }],
    });

    const mockClient = (MockFeishuClient as unknown as {
      lastInstance: {
        sentMessages: { receiveId: string; payload: FeishuOutboundPayload }[];
      };
    }).lastInstance;
    const last = mockClient.sentMessages.at(-1);
    expect(last).toBeDefined();
    expect(last!.receiveId).toBe('oc_chatXYZ');
    expect(last!.payload.msg_type).toBe('text');
    expect(last!.payload.receive_id_type).toBe('chat_id');
    expect(JSON.parse(last!.payload.content).text).toBe('agent 回复');
  });

  it('已绑定 → 私聊（conversationId 以 ou_ 开头）receiveIdType=open_id', async () => {
    const manager = makeManager({
      findConversationBySession: async () => 'ou_userXYZ',
    });
    const impl = new FeishuChannel('feishu', {});
    const h = await impl.connect(makeConfig(), manager);

    await h.sendOutbound({
      id: 'm3',
      sessionId: 'sess_x',
      role: 'assistant',
      content: [{ type: 'text', text: '私聊回复' }],
    });

    const mockClient = (MockFeishuClient as unknown as {
      lastInstance: { sentMessages: { receiveId: string; payload: FeishuOutboundPayload }[] };
    }).lastInstance;
    expect(mockClient.sentMessages.at(-1)!.payload.receive_id_type).toBe('open_id');
  });

  it('client 未连接 → drop 不抛错', async () => {
    // 未 open 的 FeishuConnection（client=null）
    const conn = new FeishuConnection(makeConfig(), makeManager());
    await expect(
      conn.sendOutbound({
        id: 'm4',
        sessionId: 'sess_x',
        role: 'assistant',
        content: [{ type: 'text', text: 'x' }],
      }),
    ).resolves.toBeUndefined();
  });
});

describe('FeishuConnection.updateInputState', () => {
  it('飞书无 typing API → no-op（不抛错）', async () => {
    const conn = new FeishuConnection(makeConfig(), makeManager());
    await expect(conn.updateInputState('typing')).resolves.toBeUndefined();
    await expect(conn.updateInputState('idle')).resolves.toBeUndefined();
  });
});
