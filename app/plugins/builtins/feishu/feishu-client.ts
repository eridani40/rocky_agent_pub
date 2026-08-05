/**
 * 飞书 WSClient 封装 —— channel impl 与 @larksuiteoapi/node-sdk 的边界
 * 参考: reqs/[done] v0.0.103.channel/design-feishu.md §1（连接）/ §5（出站）/ §7（重连）
 *       refs/openclaw/extensions/feishu/src/client.ts（WSClient 构造参考）
 *       scripts/feishu-smoke.ts（Bun+SDK 兼容冒烟已验 ✅）
 *
 * Bun 兼容结论：bun 1.3.11 + @larksuiteoapi/node-sdk 1.70.0 —— WSClient.start()/onReady 正常
 * 触发，不需要走 node 子进程兜底方案（design-feishu §5.5）。
 *
 * 职责：
 *   - 连接/断开 WSClient + 注册 im.message.receive_v1 回调
 *   - 提供 sendMessage（im.message.create）出口
 *   - 把 SDK 类型细节封装在此（feishu-channel.ts 不直 import SDK）
 *
 * 重连策略：本期 WSClient 内置 autoReconnect（不指数退避），上层 ChannelManager.reconnectWithRetry
 * 处理 3 次 × 5s 上限（与 channel-retry.ts 协同）。本封装只暴露 onError 让上层裁决。
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import type { FeishuOutboundPayload } from './feishu-protocol';
import { withTimeout } from './feishu-helpers';

/** sendMessage 调用超时（Lark SDK axios 默认无超时，必须手动包住防永久冻结出站管线） */
const SEND_TIMEOUT_MS = 30000;

/** FeishuClient 配置（从 ChannelConfig.config 读） */
export interface FeishuClientConfig {
  appId: string;
  appSecret: string;
  /** 可选：域名（默认 Feishu，国际版用 Lark） */
  domain?: 'feishu' | 'lark';
}

/** WSClient 生命周期回调（注入便于 FeishuChannel 调用 manager.markConnected/markError） */
export interface FeishuClientCallbacks {
  /** 飞书消息事件入站（im.message.receive_v1 解包后的原始 data） */
  onMessage: (raw: unknown) => void;
  /** 连接成功（WSClient onReady） */
  onReady?: () => void;
  /** 连接错误（WSClient onError） */
  onError?: (err: Error) => void;
  /** 进入重连循环（WSClient onReconnecting） */
  onReconnecting?: () => void;
  /** 重连成功（WSClient onReconnected） */
  onReconnected?: () => void;
}

/**
 * 飞书 WSClient 封装（SDK 边界隔离）。
 *
 * 设计：构造时 new WSClient（不 start）；connect() 调 start()；disconnect() 调 close()。
 * 重连委托给上层（ChannelManager.connectWithRetry），本封装只透传 onError。
 */
export class FeishuClient {
  private wsClient: Lark.WSClient | null = null;
  /** HTTP Client（im.message.create 等用），connect 时 new 一次缓存（Lark.Client 内部做 token 缓存，避免重复构造） */
  private httpClient: Lark.Client | null = null;
  private readonly cfg: FeishuClientConfig;
  private readonly callbacks: FeishuClientCallbacks;

  constructor(cfg: FeishuClientConfig, callbacks: FeishuClientCallbacks) {
    if (!cfg.appId || !cfg.appSecret) {
      throw new Error('FeishuClient: appId/appSecret 不能为空');
    }
    this.cfg = cfg;
    this.callbacks = callbacks;
  }

  /** 建立 WS 长连接 + 注册 im.message.receive_v1 */
  async connect(): Promise<void> {
    if (this.wsClient) return; // idempotent
    console.log('[feishu][connect] >>> 开始连接 appId=%s domain=%s', this.cfg.appId, this.cfg.domain ?? 'feishu');

    // 缓存 Lark.Client（HTTP 发送 API 用，token 缓存避免重复构造）
    this.httpClient = new Lark.Client({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: this.cfg.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
    });

    const dispatcher = new Lark.EventDispatcher({});
    dispatcher.register({
      'im.message.receive_v1': (data) => {
        console.log('[feishu][client.onMessage] 收到事件:\n', JSON.stringify(data, null, 2));
        try {
          this.callbacks.onMessage(data);
        } catch (e) {
          // 单条事件处理失败不应中断 SDK loop
          console.error('[feishu] onMessage handler 抛错:', e);
        }
        return Promise.resolve();
      },
    });

    const domain = this.cfg.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;

    this.wsClient = new Lark.WSClient({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      domain,
      loggerLevel: Lark.LoggerLevel.debug,
      onReady: () => {
        console.log('[feishu][connect] onReady ✓ WSClient 连接就绪');
        this.callbacks.onReady?.();
      },
      onError: (err: Error) => {
        console.error('[feishu][connect] onError:', err.message);
        this.callbacks.onError?.(err);
      },
      onReconnecting: () => {
        console.warn('[feishu][connect] onReconnecting ⚠ WS 断连，SDK 重连中');
        this.callbacks.onReconnecting?.();
      },
      onReconnected: () => {
        console.log('[feishu][connect] onReconnected ✓ WS 重连成功');
        this.callbacks.onReconnected?.();
      },
    });

    console.log('[feishu][connect] WSClient 实例已创建，调 start() 建立 WS...');
    await this.wsClient.start({ eventDispatcher: dispatcher });
    console.log('[feishu][connect] WSClient.start() 已返回（WS 连接协商中，等 onReady 确认真连上），im.message.receive_v1 已注册');
  }

  /** 主动断开（idempotent） */
  async disconnect(): Promise<void> {
    console.log('[feishu][connect] disconnect 调用');
    if (!this.wsClient) {
      console.log('[feishu][connect] disconnect: wsClient 已 null，跳过');
      return;
    }
    try {
      this.wsClient.close({ force: true });
    } catch {
      /* idempotent */
    }
    this.wsClient = null;
    this.httpClient = null;
  }

  /**
   * 发送飞书消息（im.message.create，复用 connect 时缓存的 httpClient）。
   * 用 withTimeout(30s) 包住 HTTP 调用——Lark SDK axios 默认无超时，不包会永久冻结出站管线。
   *
   * @param receiveId 接收方 id（群=chatId / 私聊=openId）
   * @param payload formatFeishuOutbound 产出的 payload
   */
  async sendMessage(receiveId: string, payload: FeishuOutboundPayload): Promise<void> {
    if (!this.wsClient || !this.httpClient) {
      throw new Error('FeishuClient.sendMessage: 未连接（wsClient/httpClient 为 null）');
    }
    const contentPreview = payload.content.slice(0, 50);
    const start = Date.now();
    console.log(
      '[feishu][outbound] sendMessage 开始 receiveId=%s msg_type=%s content(%d 字符)=%j',
      receiveId,
      payload.msg_type,
      payload.content.length,
      contentPreview,
    );

    let resp: Awaited<ReturnType<typeof this.httpClient.im.message.create>>;
    try {
      resp = await withTimeout(
        this.httpClient.im.message.create({
          data: {
            receive_id: receiveId,
            msg_type: payload.msg_type,
            content: payload.content,
          },
          params: {
            receive_id_type: payload.receive_id_type,
          },
        }),
        SEND_TIMEOUT_MS,
        `feishu sendMessage receiveId=${receiveId}`,
      );
    } catch (e) {
      const elapsed = Date.now() - start;
      console.error('[feishu][outbound] sendMessage 失败 receiveId=%s 耗时=%dms 错误:', receiveId, elapsed, e);
      throw e;
    }

    if (resp.code !== undefined && resp.code !== 0) {
      const elapsed = Date.now() - start;
      const err = new Error(`FeishuClient.sendMessage 失败 code=${resp.code} msg=${resp.msg ?? ''}`);
      console.error('[feishu][outbound] sendMessage API 错误 receiveId=%s 耗时=%dms', receiveId, elapsed, err.message);
      throw err;
    }

    const elapsed = Date.now() - start;
    console.log(
      '[feishu][outbound] sendMessage 成功 receiveId=%s 耗时=%dms%s',
      receiveId,
      elapsed,
      resp.data?.message_id ? ` message_id=${resp.data.message_id}` : '',
    );
  }
}
