/**
 * ChannelHandleBase abstract —— ChannelHandle 契约的通用 helper 基类
 * 参考: specs/tech/channel/[P0]channel_impl_interface.md §3（abstract + 通用方法）
 *       specs/tech/version_logs/v0.0.206/change_plan.md §新契约（会话句柄模型）
 *
 * 设计（v0.0.206 无状态化重构）：
 *   - 原 ChannelBase（焊死 (instance, manager) 构造）整文件重写为 ChannelHandleBase
 *   - 连接句柄（如 FeishuConnection）extends 本类 + 实现 ChannelHandle 的 4 方法，
 *     不重复写通用业务（deliverTo/bind/listSessions 等走 backend 透传，DRY）
 *   - handle 持 config **引用**（PUT updateConfig mutate 同一对象 → 运行中 handle 见新值）
 *   - base 不持连接态（client/dedup/debounce/queue 归 impl 子类）
 *
 * 句柄类构造函数签名约定：(config, backend, ...) 前两参。
 */
import type { Message } from '../message/types';
import type { Session } from '../agent/session-store-types';
import type {
  ChannelHandle,
  ChannelConfig,
  ChannelBoundBy,
} from './types';

/**
 * manager 反向引用的最小接口（避免环引用：channel-base 依赖 manager 类型，manager 也 import Channel）。
 * ChannelManagerImpl 实现此接口；UT 注入 mock 也只需实现此子集。
 */
export interface ChannelManagerBackend {
  /** 查 conversationId 当前绑定的 session（未绑返 null） */
  getBinding(configId: string, conversationId: string): Promise<string | null>;
  /** 投递 Message 到 agent（= agentManager.deliverTo 透传） */
  deliverTo(sessionId: string, message: Message): Promise<unknown>;
  /** 写 binding（双向唯一检查 + 持久化 + 建立 outbound 累积管线） */
  bind(
    configId: string,
    conversationId: string,
    sessionId: string,
    by: ChannelBoundBy,
  ): Promise<void>;
  /** 删 binding + 取消 outbound 订阅（防泄漏） */
  unbind(configId: string, conversationId: string): Promise<void>;
  /**
   * 通过 sessionId 反查 conversationId（sendOutbound 用）。
   * binding 双向唯一下每 (config,session) 至多 1 个 conversation。
   * @returns 反查到的 conversationId；无返 null
   */
  findConversationBySession(configId: string, sessionId: string): Promise<string | null>;
  /** 列 sessions（/listp /lists 用，D1 全给无过滤） */
  listSessions(opts?: { biz?: string; role?: string }): Promise<Session[]>;
}

/**
 * ChannelHandle 契约的 abstract base —— 给连接句柄提供通用方法。
 *
 * 句柄（如 FeishuConnection）extends 本类 + 实现 ChannelHandle 4 方法。
 * base 通过 protected helper 把通用业务透传给 backend（不在 base 写业务逻辑）。
 */
export abstract class ChannelHandleBase implements ChannelHandle {
  /** 本句柄的 config id（ChannelHandle 契约；值来自构造注入的 config.id，不重新生成）。accumulator self 判定用。 */
  get configId(): string {
    return this.config.id;
  }

  /** 本句柄组合的 channel 配置（含凭证；PUT mutate 同一引用 → 运行中见新值） */
  protected readonly config: ChannelConfig;
  /** manager 反向引用（subscribe/unsubscribe/bind 等通用 helper 走它） */
  protected readonly backend: ChannelManagerBackend;

  constructor(config: ChannelConfig, backend: ChannelManagerBackend) {
    this.config = config;
    this.backend = backend;
  }

  // ===== impl 必须实现的 4 方法（abstract） =====
  abstract disconnect(): Promise<void>;
  abstract handleInbound(raw: unknown): Promise<void>;
  abstract sendOutbound(msg: Message): Promise<void>;
  abstract updateInputState(state: 'typing' | 'idle'): Promise<void>;

  // ===== base 提供给句柄调用的通用方法（concrete，全部走 backend 透传） =====

  /** 查 conversationId 当前绑定的 session（未绑返 null） */
  protected async getBindedSession(conversationId: string): Promise<string | null> {
    const sid = await this.backend.getBinding(this.config.id, conversationId);
    return sid;
  }

  /** 投递 Message 到 agent（与 web client 对等的 deliverTo 入口） */
  protected async deliverTo(sessionId: string, message: Message): Promise<unknown> {
    return this.backend.deliverTo(sessionId, message);
  }

  /** 写 binding（双向唯一检查 + 持久化 + 建立 outbound 累积管线） */
  protected async bind(
    conversationId: string,
    sessionId: string,
    by: ChannelBoundBy,
  ): Promise<void> {
    await this.backend.bind(this.config.id, conversationId, sessionId, by);
  }

  /** 删 binding + 取消 outbound 订阅（防泄漏） */
  protected async unbind(conversationId: string): Promise<void> {
    await this.backend.unbind(this.config.id, conversationId);
  }

  /**
   * 通过 sessionId 反查 conversationId（sendOutbound 用）。
   * binding 双向唯一下每 (config,session) 至多 1 个 conversation。
   */
  protected async findConversationBySession(sessionId: string): Promise<string | null> {
    return this.backend.findConversationBySession(this.config.id, sessionId);
  }

  /** 列 playground sessions（/listp，D1 全给无过滤） */
  protected async listPlaygroundSessions(): Promise<Session[]> {
    return this.backend.listSessions({ biz: 'playground' });
  }

  /** 列 studio leader sessions（/lists，D1 全给无过滤） */
  protected async listStudioLeaders(): Promise<Session[]> {
    return this.backend.listSessions({ biz: 'studio', role: 'leader' });
  }
}
