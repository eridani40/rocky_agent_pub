/**
 * FeishuConnection.sendOutbound 补充测试：空 payload warn 日志
 * 参考: reqs/[working] v0.0.118/analysis.md Task1 验收标准
 *
 * v0.0.206 无状态化：构造模式 = new FeishuChannel('feishu', {}) + impl.connect(config, backend)。
 *
 * 覆盖：
 *   - formatFeishuOutbound 返回空 payload 时打 warn 日志（含 sessionId + blockTypes）并 return
 *
 * Mock 策略：
 *   - mock feishu-protocol（让 formatFeishuOutbound 返回 []）
 *   - mock feishu-client（不连真飞书）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChannelConfig } from '../../../../server/src/channel/types';
import type { ChannelManagerBackend } from '../../../../server/src/channel/channel-base';

const { MockFeishuClient, mockFormatFn, clientPath, protocolPath, channelPath } = vi.hoisted(() => {
  const { resolve } = require('node:path') as typeof import('node:path');

  class MockFeishuClientImpl {
    static lastInstance: MockFeishuClientImpl | null = null;
    connected = false;
    sentMessages: unknown[] = [];
    constructor(
      public cfg: unknown,
      public callbacks: { onMessage: (raw: unknown) => void; onReady?: () => void },
    ) { MockFeishuClientImpl.lastInstance = this; }
    async connect() { this.connected = true; this.callbacks.onReady?.(); }
    async disconnect() { this.connected = false; }
    async sendMessage(receiveId: string, payload: unknown) { this.sentMessages.push({ receiveId, payload }); }
  }

  // formatFeishuOutbound 的可控 mock（默认返回空数组，测试可覆盖）
  const mockFormatFn = { fn: vi.fn(() => []) };

  return {
    MockFeishuClient: MockFeishuClientImpl,
    mockFormatFn,
    clientPath: resolve(__dirname, '../feishu-client'),
    protocolPath: resolve(__dirname, '../feishu-protocol'),
    channelPath: resolve(__dirname, '../feishu-channel'),
  };
});

vi.mock(clientPath, () => ({ FeishuClient: MockFeishuClient }));
vi.mock(protocolPath, async (importOriginal) => {
  // 只替换 formatFeishuOutbound，其余原样导入
  const original = await importOriginal<typeof import('../feishu-protocol')>();
  return {
    ...original,
    formatFeishuOutbound: (...args: Parameters<typeof original.formatFeishuOutbound>) =>
      mockFormatFn.fn(...args),
  };
});

const FeishuChannelModule = await import(channelPath);
const FeishuChannel = FeishuChannelModule.default as (typeof import('../feishu-channel'))['default'];

function makeConfig(): ChannelConfig {
  return { id: 'cfg_test', implId: 'feishu', name: 'test', enabled: true, config: { appId: 'app_x', appSecret: 'sec_y' } };
}
function makeManager(overrides: Partial<ChannelManagerBackend> = {}): ChannelManagerBackend {
  return {
    getBinding: async () => null,
    deliverTo: async () => undefined,
    bind: async () => {},
    unbind: async () => {},
    findConversationBySession: async (_iid, _sid) => 'oc_chatXYZ',
    listSessions: async () => [],
    ...overrides,
  };
}

beforeEach(() => {
  // 每次测试重置 formatFeishuOutbound mock 返回空（测试空 payload 路径）
  mockFormatFn.fn.mockReturnValue([]);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('FeishuConnection.sendOutbound 空 payload', () => {
  it('formatFeishuOutbound 返回 [] → 打 warn 日志 + 不调 sendMessage', async () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const impl = new FeishuChannel('feishu', {});
    const h = await impl.connect(makeConfig(), makeManager());

    await h.sendOutbound({
      id: 'm1',
      sessionId: 'sess_abc',
      role: 'assistant',
      content: [{ type: 'reasoning_block_end' as 'text' }], // 非 text block → formatFeishuOutbound 返回 []
    });

    // 应打 warn 日志，含 sessionId 和 blockType
    const warnCalls = warnSpy.mock.calls.map((c) => c.join(' '));
    const emptyPayloadWarn = warnCalls.find((msg) => msg.includes('空 payload') || msg.includes('empty'));
    expect(emptyPayloadWarn).toBeDefined();
    expect(emptyPayloadWarn).toContain('sess_abc');

    // sendMessage 不应被调用（sentMessages 应为空或不增加）
    const mockClient = (MockFeishuClient as unknown as { lastInstance: { sentMessages: unknown[] } }).lastInstance;
    expect(mockClient.sentMessages.length).toBe(0);
  });

  it('formatFeishuOutbound 返回非空 → 不打 warn（正常发送路径不受影响）', async () => {
    // 覆盖 mock：返回一个 payload
    mockFormatFn.fn.mockReturnValue([{ msg_type: 'text', content: '{"text":"hi"}', receive_id_type: 'chat_id' }]);

    const warnSpy = vi.spyOn(console, 'warn');
    const impl = new FeishuChannel('feishu', {});
    const h = await impl.connect(makeConfig(), makeManager());

    await h.sendOutbound({
      id: 'm2',
      sessionId: 'sess_def',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
    });

    const warnCalls = warnSpy.mock.calls.map((c) => c.join(' '));
    const emptyPayloadWarn = warnCalls.find((msg) => msg.includes('空 payload') || msg.includes('empty'));
    expect(emptyPayloadWarn).toBeUndefined();

    // sendMessage 被调了一次
    const mockClient = (MockFeishuClient as unknown as { lastInstance: { sentMessages: unknown[] } }).lastInstance;
    expect(mockClient.sentMessages.length).toBe(1);
  });
});
