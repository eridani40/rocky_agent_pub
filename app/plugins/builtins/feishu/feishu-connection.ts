/**
 * FeishuConnection —— per-config 飞书连接句柄（ChannelHandle 实现）
 * 参考: specs/tech/channel/[P0]channel_impl_interface.md §4
 *       specs/tech/version_logs/v0.0.206/change_plan.md 模块三（FeishuConnection 行）
 *       reqs/[done] v0.0.103.channel/design-usecases.md UC-D1（入站三件套）/ UC-C（斜杠）
 *
 * v0.0.206 无状态化重构：原 FeishuChannel 的 per-config 连接态与 5 方法整体搬迁到本类
 * （纯搬迁 + instance→config / manager→backend 改名 + 方法改名 onInboundMessage→handleInbound /
 * onOutBoundMessage→sendOutbound / onUpdateInputState→updateInputState，零逻辑改）。
 * 连接态（client/dedup/debounce/queueLocks）全挂本句柄；无状态 impl 见 feishu-channel.ts。
 *
 * 入站三件套：去重 message_id 幂等 + 去抖 debouncer + 顺序队列 per conversationId。
 */
import type { Message } from '../../../server/src/message/types';
import { ChannelHandleBase } from '../../../server/src/channel/channel-base';
import type { ChannelConfig } from '../../../server/src/channel/types';
import type { ChannelManagerBackend } from '../../../server/src/channel/channel-base';
import { FeishuClient } from './feishu-client';
import {
  parseFeishuMessage,
  formatFeishuOutbound,
  type FeishuChatType,
  type ParsedFeishuInbound,
} from './feishu-protocol';
import { dispatchSlash, isSlashCommand, type SlashDeps } from './feishu-slash';
import {
  readCredentials,
  defaultMessageIdGenerator,
  withTimeout,
  type MessageIdGenerator,
} from './feishu-helpers';

/** message_id 幂等缓存上限 */
const DEDUP_CACHE_LIMIT = 5000;
/** 去抖窗口（ms） */
const DEBOUNCE_MS = 600;
/** 顺序队列任务超时（ms） */
const SEQ_TASK_TIMEOUT_MS = 30000;

/**
 * FeishuConnection：extends ChannelHandleBase 实现 ChannelHandle 4 方法。
 * 由 FeishuChannel.connect(config, backend) 构造 + open() 开启 WS 长连接。
 */
export class FeishuConnection extends ChannelHandleBase {
  private client: FeishuClient | null = null;
  private readonly processed = new Set<string>();
  private readonly processedOrder: string[] = [];
  private readonly debouncers = new Map<string, NodeJS.Timeout>();
  private readonly debouncedText = new Map<string, string[]>();
  private readonly queueLocks = new Map<string, Promise<void>>();
  private readonly genMessageId: MessageIdGenerator;

  constructor(
    config: ChannelConfig,
    backend: ChannelManagerBackend,
    genMessageId?: MessageIdGenerator,
  ) {
    super(config, backend);
    this.genMessageId = genMessageId ?? defaultMessageIdGenerator;
  }

  /** 建立 WS 长连接 + 注册 im.message.receive_v1 → handleInbound（原 connect 逻辑） */
  async open(): Promise<void> {
    const { appId, appSecret } = readCredentials(this.config);
    if (!appId || !appSecret) {
      throw new Error('FeishuConnection.open: config.config 缺少 appId 或 appSecret');
    }
    this.client = new FeishuClient(
      { appId, appSecret },
      {
        onMessage: (raw) => {
          void this.handleInbound(raw).catch((e) => {
            console.error('[feishu] handleInbound 异常:', e);
          });
        },
      },
    );
    await this.client.connect();
  }

  /** 主动断开（idempotent） */
  async disconnect(): Promise<void> {
    for (const timer of this.debouncers.values()) clearTimeout(timer);
    this.debouncers.clear();
    this.debouncedText.clear();
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
  }

  /**
   * IM 事件入站：去重 → 去抖/斜杠路由 → 顺序队列 → deliverTo。
   * 命令消息立即派发（跳过去抖），普通消息进 per-conversationId 去抖合并。
   */
  async handleInbound(raw: unknown): Promise<void> {
    console.log('[feishu][inbound] >>> handleInbound 进入, 完整 raw:\n', JSON.stringify(raw, null, 2));
    const parsed = parseFeishuMessage(raw);
    if (!parsed) {
      console.warn('[feishu][inbound] parse=null（malformed event，drop）— raw 见上');
      return; // malformed event，drop
    }
    console.log('[feishu][inbound] parse ok: messageId=%s conversationId=%s chatType=%s imUserId=%s imUserName=%s text=%j', parsed.messageId, parsed.conversationId, parsed.chatType, parsed.imUserId, parsed.imUserName, parsed.text);

    // 1) 去重（message_id 幂等，飞书 at-least-once 重发）
    if (!this.tryBeginProcessing(parsed.messageId)) {
      console.log('[feishu][inbound] 去重命中(重复 messageId=%s)，drop', parsed.messageId);
      return;
    }

    const { conversationId, text } = parsed;

    // 2) 斜杠指令 → 立即派发（跳过去抖）
    if (isSlashCommand(text)) {
      console.log('[feishu][inbound] 路由→slash 指令 %j（跳过去抖，立即派发）', text);
      await this.enqueueSequential(conversationId, () => this.handleSlash(parsed));
      return;
    }

    // 3) 普通消息 → per conversationId 去抖（合并连发）
    console.log('[feishu][inbound] 路由→debounce(600ms 合并连发) conversationId=%s', conversationId);
    this.scheduleDebounce(conversationId, text, (combined) => {
      void this.enqueueSequential(conversationId, () =>
        this.deliverUserMessage({ ...parsed, text: combined }),
      );
    });
  }

  /** 出站：完整 assistant Message → 飞书消息发送 */
  async sendOutbound(msg: Message): Promise<void> {
    console.log('[feishu][outbound] >>> sendOutbound sessionId=%s contentBlocks=%d', msg.sessionId, msg.content.length);
    if (!this.client) {
      console.warn('[feishu] sendOutbound: client 未连接，drop');
      return;
    }
    const conversationId = await this.findConversationBySession(msg.sessionId);
    if (!conversationId) {
      console.warn('[feishu][outbound] session %s 未绑定 conversation，drop', msg.sessionId);
      return;
    }

    const chatType = this.resolveChatType(conversationId);
    const payloads = formatFeishuOutbound(msg, chatType);
    if (payloads.length === 0) {
      // 空 payload 是排查盲点：content blocks 有内容但格式化后为空，需要可见
      console.warn('[feishu][outbound] 空 payload 丢弃 sessionId=%s blockTypes=[%s]', msg.sessionId, msg.content.map((b) => b.type).join(','));
      return;
    }

    for (const payload of payloads) {
      try {
        await this.client.sendMessage(conversationId, payload);
      } catch (e) {
        console.error('[feishu] sendMessage 失败:', e);
      }
    }
  }

  /** typing indicator：飞书无原生 API → no-op（design §6，保守） */
  async updateInputState(_state: 'typing' | 'idle'): Promise<void> {
    // no-op（reaction emoji hack 留未来增强）
  }

  // ===== 私有 helper =====

  /** 去重 + LRU 淘汰 */
  private tryBeginProcessing(messageId: string): boolean {
    if (this.processed.has(messageId)) return false;
    this.processed.add(messageId);
    this.processedOrder.push(messageId);
    if (this.processedOrder.length > DEDUP_CACHE_LIMIT) {
      const evict = this.processedOrder.shift();
      if (evict) this.processed.delete(evict);
    }
    return true;
  }

  /** 去抖调度：累积同会话文本，DEBOUNCE_MS 后 flush */
  private scheduleDebounce(
    conversationId: string,
    text: string,
    onFlush: (combinedText: string) => void,
  ): void {
    const list = this.debouncedText.get(conversationId) ?? [];
    list.push(text);
    this.debouncedText.set(conversationId, list);

    const existing = this.debouncers.get(conversationId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debouncers.delete(conversationId);
      const combined = (this.debouncedText.get(conversationId) ?? []).join('\n');
      this.debouncedText.delete(conversationId);
      onFlush(combined);
    }, DEBOUNCE_MS);
    timer.unref?.();
    this.debouncers.set(conversationId, timer);
  }

  /**
   * 顺序队列：保证同 conversationId 串行执行；不同 conversationId 并行。
   * 任务超时 SEQ_TASK_TIMEOUT_MS 兜底，防一个任务卡死整队列。
   */
  private async enqueueSequential(
    conversationId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const prev = this.queueLocks.get(conversationId) ?? Promise.resolve();
    const next = prev
      .then(() => withTimeout(task(), SEQ_TASK_TIMEOUT_MS))
      .catch((e) => {
        console.error(`[feishu] queue task error (conv=${conversationId}):`, e);
      });
    this.queueLocks.set(conversationId, next);
    next.finally(() => {
      if (this.queueLocks.get(conversationId) === next) {
        this.queueLocks.delete(conversationId);
      }
    });
    await next;
  }

  /** 派发斜杠指令（注入 SlashDeps = base helper） */
  private async handleSlash(parsed: ParsedFeishuInbound): Promise<void> {
    const deps: SlashDeps = {
      listPlaygroundSessions: () => this.listPlaygroundSessions(),
      listStudioLeaders: () => this.listStudioLeaders(),
      bind: (conv, sid, by) => this.bind(conv, sid, by),
      unbind: (conv) => this.unbind(conv),
      getBindedSession: (conv) => this.getBindedSession(conv),
    };
    const result = await dispatchSlash(parsed.text, deps, parsed.conversationId);
    if (!result.replyText || !this.client) return;
    const receiveIdType = parsed.chatType === 'group' || parsed.chatType === 'topic_group'
      ? 'chat_id'
      : 'open_id';
    try {
      await this.client.sendMessage(parsed.conversationId, {
        msg_type: 'text',
        content: JSON.stringify({ text: result.replyText }),
        receive_id_type: receiveIdType,
      });
    } catch (e) {
      console.error('[feishu] 斜杠回执发送失败:', e);
    }
  }

  /** 构造 user Message + deliverTo（sender.channel：type=config.implId，configId=config.id） */
  private async deliverUserMessage(parsed: {
    conversationId: string; text: string; imUserId: string; imUserName: string; chatType: FeishuChatType;
  }): Promise<void> {
    const sessionId = await this.getBindedSession(parsed.conversationId);
    if (!sessionId) {
      await this.sendUnboundHint(parsed.conversationId, parsed.chatType);
      return;
    }

    // genMessageId() 分配的 id 是 **throwaway 占位**——drain 时会被
    //   agent-loop-stage-pre.drainAndPartition 用新 ulid() 重写（I1/I3；
    //   与 POST /messages 路径同轨）。channel 入口的 msgId 从未外泄给外部系统。
    const msg: Message = {
      id: this.genMessageId(),
      sessionId,
      role: 'user',
      content: [{ type: 'text', text: parsed.text }],
      sender: {
        source: 'user',
        channel: {
          type: this.config.implId,
          configId: this.config.id,
          conversationId: parsed.conversationId,
          imUserId: parsed.imUserId,
          imUserName: parsed.imUserName,
        },
      },
    };

    try {
      console.log('[feishu][inbound] >>> deliverTo sessionId=%s text=%j', sessionId, parsed.text);
      await this.deliverTo(sessionId, msg);
    } catch (e) {
      console.error('[feishu] deliverTo 失败:', e);
    }
  }

  /** 未绑定 conversation 时给用户的提示（UC-G3） */
  private async sendUnboundHint(
    conversationId: string,
    chatType: FeishuChatType,
  ): Promise<void> {
    if (!this.client) return;
    const receiveIdType =
      chatType === 'group' || chatType === 'topic_group' ? 'chat_id' : 'open_id';
    try {
      await this.client.sendMessage(conversationId, {
        msg_type: 'text',
        content: JSON.stringify({
          text: '当前会话未绑定 agent。请发送 /listp 查看可用会话，再 /bindp N 绑定。',
        }),
        receive_id_type: receiveIdType,
      });
    } catch {
      /* 提示失败不阻塞 */
    }
  }

  /** conversationId → chatType（决定 receive_id_type）：飞书 chat_id 前缀 oc_ / open_id 前缀 ou_ */
  private resolveChatType(conversationId: string): FeishuChatType {
    return conversationId.startsWith('ou_') ? 'p2p' : 'group';
  }
}
