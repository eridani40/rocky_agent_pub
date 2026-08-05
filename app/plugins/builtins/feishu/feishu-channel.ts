/**
 * FeishuChannel —— channel EP 的飞书无状态 ExtImpl（v0.0.206 无状态化重构）
 * 参考: specs/tech/channel/[P0]channel_impl_interface.md §4
 *       specs/tech/version_logs/v0.0.206/change_plan.md §新契约（会话句柄模型）
 *
 * 模型（类比 SQL driver）：
 *   - 本类 = 无状态协议行为 impl：不持 config、不持连接态；
 *     构造 `(implId?, cfg?, genMessageId?)` 标准 EP 签名（PluginManager.instantiate 直供，
 *     scope 门 = getExtensionImpls(ChannelPoint, 'default') map miss 即未激活）
 *   - connect(config, backend) → FeishuConnection（per-config 连接句柄，连接态全挂句柄）
 *   - 同一 impl 实例可并行组合多份 config（每份一个 FeishuConnection，互不影响）
 *
 * cfg 参数忽略：configSchema 是 channel_config 的校验 schema（凭证在 config 里），
 * 非 impl 级 cfg；impl 级配置 feishu 无。
 *
 * Bun+SDK 兼容：scripts/feishu-smoke.ts 已验 ✅（onReady 触发，无需 node 子进程）。
 */
import type {
  Channel,
  ChannelConfig,
  ChannelHandle,
} from '../../../server/src/channel/types';
import type { ChannelManagerBackend } from '../../../server/src/channel/channel-base';
import { FeishuConnection } from './feishu-connection';
import {
  defaultMessageIdGenerator,
  type MessageIdGenerator,
} from './feishu-helpers';

/**
 * FeishuChannel：implements Channel（无状态 impl 契约）。
 * connect 按 config 建 FeishuConnection + open() 开启 WS 长连接，返句柄。
 */
export default class FeishuChannel implements Channel {
  readonly type: string;
  private readonly genMessageId: MessageIdGenerator;

  constructor(implId?: string, _cfg?: unknown, genMessageId?: MessageIdGenerator) {
    this.type = implId ?? 'feishu';
    this.genMessageId = genMessageId ?? defaultMessageIdGenerator;
  }

  /** 按 config 建立连接：new FeishuConnection + open()；失败 throw（凭证缺失/网络） */
  async connect(config: ChannelConfig, backend: ChannelManagerBackend): Promise<ChannelHandle> {
    const conn = new FeishuConnection(config, backend, this.genMessageId);
    await conn.open();
    return conn;
  }
}
