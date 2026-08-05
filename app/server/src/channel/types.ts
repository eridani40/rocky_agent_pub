/**
 * channel 子系统类型定义
 * 参考: specs/tech/channel/[P0]channel_impl_interface.md §2（Channel interface）
 *       specs/tech/channel/[P0]channel_manager.md §3.4/§3.7/§3.8（binding/config/state 形态）
 *       specs/tech/version_logs/v0.0.206/change_plan.md §新契约（会话句柄模型）
 *
 * 本文件只含类型定义（interface/type），无运行时逻辑。
 * 核心 interface：
 *   - Channel（无状态 impl 契约：type + connect(config, backend) → ChannelHandle）
 *   - ChannelConfig（纯数据配置；原 ChannelInstance 改名，字段全不变 → 磁盘兼容）
 *   - ChannelHandle（per-config 连接句柄：连接态挂这里，不挂 impl）
 *   - ChannelBinding（双向索引记录）/ ChannelState（推前端的状态视图）
 */

import type { Message } from '../message/types';
// ChannelManagerBackend 定义在 channel-base.ts（type-only 互引，编译期擦除无运行时环）
import type { ChannelManagerBackend } from './channel-base';

/**
 * 无状态 channel impl 契约（协议行为类）。
 *
 * 设计要点（v0.0.206 无状态化重构）：
 *   - impl 不持 config、不持连接态——同一无状态 impl 可并行组合多份 config
 *   - 构造签名约定 `(implId, cfg)`（PluginManager.instantiate 标准），由
 *     PluginManager.getExtensionImpls(ChannelPoint, 'default') 直供（scope 门物化点）
 *   - connect(config, backend)：按一份 config 建立连接，返 per-config 连接句柄 ChannelHandle；
 *     失败 throw（凭证缺失/网络）由 Manager 转 connection='error'
 */
export interface Channel {
  /** impl 类型标识（= implId，如 'feishu'） */
  readonly type: string;
  /** 按 config 建立连接并返 per-config 连接句柄；失败 throw */
  connect(config: ChannelConfig, backend: ChannelManagerBackend): Promise<ChannelHandle>;
}

/**
 * per-config 连接句柄（connect 产出的会话对象）。
 *
 * impl 自有实现（如 FeishuConnection），持 client/dedup/debounce/queue 等连接态。
 * 方法映射自旧 Channel 契约：handleInbound（原 onInboundMessage）/ sendOutbound
 * （原 onOutBoundMessage）/ updateInputState（原 onUpdateInputState）。
 */
export interface ChannelHandle {
  /** = ChannelConfig.id（manager 索引 + accumulator echo self 判定用） */
  readonly configId: string;
  /** 主动断开；idempotent */
  disconnect(): Promise<void>;
  /** IM 事件入站（connect 内接 SDK 回调；UT 可直调） */
  handleInbound(raw: unknown): Promise<void>;
  /** 出站：收到完整 assistant Message（累积管线产出） */
  sendOutbound(msg: Message): Promise<void>;
  /** agent 输入状态联动（run_start→'typing' / run_end→'idle'；无原生 API 时 no-op） */
  updateInputState(state: 'typing' | 'idle'): Promise<void>;
}

/**
 * 一份 channel 配置（纯数据；原 ChannelInstance 改名）。一个 implId 可有多份 config。
 * 落 channel_config 域，主键 id（ULID）。字段名全不变 → 磁盘记录零迁移兼容。
 */
export interface ChannelConfig {
  /** 配置 ULID（业务生成；值域=原 instance id，磁盘文件名不变） */
  id: string;
  /** impl id（= manifest extImpls[].implId，如 'feishu'） */
  implId: string;
  /** 用户起的配置名（用于 UI 展示） */
  name: string;
  /** config 级开关（D7：这份 config 要不要连；⊥ impl 级 scope 门） */
  enabled: boolean;
  /**
   * 凭证 + IM 特定配置，形态由 impl 的 configSchema 决定。
   * feishu: `{ appId, appSecret }`。
   */
  config: Record<string, unknown>;
  /** 创建时间（isoDate，store 信封注入） */
  createdAt?: string;
  /** 最近更新时间（isoDate，store 信封注入） */
  updatedAt?: string;
}

/**
 * 绑定方向（D2 仅 slash/manual，本期斜杠指令 or UI 手动绑）。
 */
export type ChannelBoundBy = 'slash' | 'manual';

/**
 * (configId, conversationId) ↔ sessionId 双向唯一映射记录。
 * 落 channel_bindings 域，主键 id = `<configId>__<conversationId>`（文件名模式值不变）。
 * 落盘字段 instanceId→configId 走 MigrationManager 一次性迁移（channel-binding-config-id）。
 */
export interface ChannelBinding {
  /** 复合主键 = `${configId}__${conversationId}`（file 命名约定） */
  id: string;
  /** ChannelConfig.id */
  configId: string;
  /** 群=chatId / 私聊=openId（无 scope 编码，D2） */
  conversationId: string;
  /** 绑定的 agent session */
  sessionId: string;
  /** 绑定发起方 */
  boundBy: ChannelBoundBy;
  /** 绑定时间戳（ms） */
  boundAt: number;
}

/** switch 字段（持久化 intent，与 UI 对齐 connector） */
export type ChannelSwitch = 'on' | 'off';

/** connection 字段（运行时派生，4 态闭合） */
export type ChannelConnection =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

/**
 * 推前端的 channel 实时状态视图（GET /config/channels / UI 轮询）。
 * 双状态机：switch（intent，持久化）+ connection（实况，运行时派生）。
 */
export interface ChannelState {
  /** 配置 id（= ChannelConfig.id） */
  id: string;
  /** impl id（feishu） */
  implId: string;
  /** 用户起的配置名 */
  name: string;
  /** switch INTENT（on=用户已启用） */
  switch: ChannelSwitch;
  /** connection 实况 */
  connection: ChannelConnection;
  /** connection='error' 时的错误详情（前端展示） */
  errorDetail?: string;
  /** 最近一次成功连接时间（isoDate） */
  lastConnectedAt?: string;
  /** 该 config 当前绑定数（GET list 聚合展示用） */
  bindingCount?: number;
}

/** binding 操作抛出的错误 code（SESSION_ALREADY_BOUND = 反向唯一违反，channel D6 双向唯一） */
export type ChannelBindingErrorCode = 'SESSION_ALREADY_BOUND';

/** ChannelManager.bind 违反双向唯一时抛的错 */
export class ChannelBindingError extends Error {
  readonly code: ChannelBindingErrorCode;
  constructor(code: ChannelBindingErrorCode, message: string) {
    super(message);
    this.name = 'ChannelBindingError';
    this.code = code;
  }
}
