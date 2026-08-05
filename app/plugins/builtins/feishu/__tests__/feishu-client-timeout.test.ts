/**
 * feishu-client.ts 单测：sendMessage 超时 + 日志
 * 参考: reqs/[working] v0.0.118/analysis.md（根因：Lark SDK axios 默认无超时）
 *
 * 覆盖：
 *   - sendMessage 挂死的 im.message.create → 30s 后超时 reject，错误信息可定位
 *   - sendMessage 成功路径不受影响（正常 resolve）
 *   - sendMessage 未连接抛错
 *
 * Mock 策略：
 *   - 不 import 真实 Lark SDK（避免副作用/网络调用）
 *   - 用 vi.hoisted + vi.mock 替换 @larksuiteoapi/node-sdk
 *   - withTimeout 走真实实现（它是被测行为）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { MockLarkModule, feishuClientPath } = vi.hoisted(() => {
  const { resolve } = require('node:path') as typeof import('node:path');

  // 构造一个最小化的 Lark mock，模拟 httpClient.im.message.create 调用
  let mockCreateFn: (...args: unknown[]) => Promise<unknown> = async () => ({ code: 0, data: { message_id: 'msg_123' } });

  const MockLark = {
    AppType: { SelfBuild: 'SelfBuild' as const },
    Domain: { Feishu: 'feishu' as const, Lark: 'lark' as const },
    LoggerLevel: { debug: 'debug' as const },
    Client: class {
      im = {
        message: {
          create: (...args: unknown[]) => mockCreateFn(...args),
        },
      };
    },
    WSClient: class {
      onReady?: () => void;
      onError?: (e: Error) => void;
      onReconnecting?: () => void;
      onReconnected?: () => void;
      constructor(opts: { onReady?: () => void; onError?: (e: Error) => void; onReconnecting?: () => void; onReconnected?: () => void }) {
        this.onReady = opts.onReady;
        this.onError = opts.onError;
        this.onReconnecting = opts.onReconnecting;
        this.onReconnected = opts.onReconnected;
      }
      async start(_: unknown) { this.onReady?.(); }
      close(_: unknown) {}
    },
    EventDispatcher: class {
      private handlers: Record<string, (...args: unknown[]) => unknown> = {};
      register(h: Record<string, (...args: unknown[]) => unknown>) { Object.assign(this.handlers, h); }
    },
  };

  return {
    MockLarkModule: { module: MockLark, setCreate: (fn: (...args: unknown[]) => Promise<unknown>) => { mockCreateFn = fn; } },
    feishuClientPath: resolve(__dirname, '../feishu-client'),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => MockLarkModule.module);

const { FeishuClient } = await import(feishuClientPath) as typeof import('../feishu-client');

function makeCallbacks() {
  return {
    onMessage: vi.fn(),
    onReady: vi.fn(),
    onError: vi.fn(),
  };
}

function makeClient(callbacks = makeCallbacks()) {
  return new FeishuClient({ appId: 'app_x', appSecret: 'sec_y' }, callbacks);
}

/** 连接好的 client */
async function makeConnectedClient() {
  const client = makeClient();
  await client.connect();
  return client;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('FeishuClient.sendMessage 超时', () => {
  it('im.message.create 挂死 → 30s 后 reject，错误信息含 receiveId', async () => {
    // 模拟永不 resolve 的 create，但保留 reject 引用以防止 unhandled rejection 警告
    let rejectOuter!: (e: Error) => void;
    MockLarkModule.setCreate(() => new Promise<never>((_, reject) => { rejectOuter = reject; }));
    const client = await makeConnectedClient();

    const sendPromise = client.sendMessage('oc_chat123', {
      msg_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
      receive_id_type: 'chat_id',
    });
    // 给 promise 加 catch 防止 unhandled rejection
    sendPromise.catch(() => {});

    // 推进 30s（withTimeout 超时阈值）
    await vi.advanceTimersByTimeAsync(30000);

    await expect(sendPromise).rejects.toThrow(/feishu sendMessage.*oc_chat123.*timeout.*30000ms/);
    // 清理：reject 挂死的底层 promise，避免后续泄漏
    rejectOuter?.(new Error('cleanup'));
  });

  it('29s 内正常 resolve → 不超时', async () => {
    // 延迟 100ms resolve 的 create（模拟正常响应）
    MockLarkModule.setCreate(() => new Promise((resolve) => setTimeout(() => resolve({ code: 0, data: { message_id: 'msg_ok' } }), 100)));
    const client = await makeConnectedClient();

    const sendPromise = client.sendMessage('oc_chat123', {
      msg_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
      receive_id_type: 'chat_id',
    });

    await vi.advanceTimersByTimeAsync(200);
    await expect(sendPromise).resolves.toBeUndefined();
  });

  it('API 返回 code!=0 → 抛 Error（业务错误，非超时）', async () => {
    MockLarkModule.setCreate(async () => ({ code: 99991401, msg: '无权限' }));
    const client = await makeConnectedClient();

    const sendPromise = client.sendMessage('oc_chat123', {
      msg_type: 'text',
      content: 'payload',
      receive_id_type: 'chat_id',
    });

    await expect(sendPromise).rejects.toThrow(/code=99991401/);
  });
});

describe('FeishuClient.sendMessage 未连接', () => {
  it('未 connect 时调 sendMessage → 抛错（wsClient/httpClient 为 null）', async () => {
    const client = makeClient();
    // 不 connect
    await expect(
      client.sendMessage('oc_x', { msg_type: 'text', content: '{}', receive_id_type: 'chat_id' }),
    ).rejects.toThrow(/未连接/);
  });
});
