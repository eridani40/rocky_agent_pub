/**
 * createAndBootstrapChannelManager —— bootstrap factory（fail-safe 不阻塞 server）
 * 参考: specs/tech/channel/[P0]channel_manager.md §4（启动注入）
 *       app/server/src/tools/browser/connector-bootstrap.ts（同款 fail-safe 模式）
 *
 * 调用时机（bootstrap.ts）：在 `new AgentManagerImpl`（agent_loop bus 就绪）之后，
 * 早于 server.listen。connect fire-and-forget 不阻塞 server.listen。
 *
 * 失败处理：构造失败 → log + 返 undefined（不抛错，不阻塞 server 启动）。
 * ChannelManager 自身的 bootstrap() 内部已 fire-and-forget（每份 config connect 不阻塞）。
 * v0.0.206：ChannelManagerImpl 经 pluginManager.getExtensionImpls(ChannelPoint,'default')
 * 供无状态 impl（scope 门物化点），opts 由 bootstrap-connectors-phase 注入。
 */
import type { ChannelManager, ChannelManagerOptions } from './channel-manager';
import { ChannelManagerImpl } from './channel-manager';

/** factory 构造参数（与 ChannelManagerOptions 同款） */
export type CreateChannelManagerOptions = ChannelManagerOptions;

/**
 * 构造 ChannelManager 并触发 bootstrap（扫盘 + fire-and-forget connect）。
 *
 * @returns ChannelManager 实例（永不抛错；构造失败 log 后返 undefined）
 */
export function createAndBootstrapChannelManager(
  opts: CreateChannelManagerOptions,
): ChannelManager | undefined {
  try {
    const cm: ChannelManager = new ChannelManagerImpl(opts);
    // bootstrap fire-and-forget：内部 void connect() 不 await，server.listen 不阻塞
    void cm.bootstrap().catch((err) => {
      // bootstrap 内部应已吞所有 instance 级 connect 错误；此处仅兜底
      console.error('[ChannelManager] bootstrap failed:', err);
    });
    return cm;
  } catch (err) {
    // 构造失败（如 dataDir 不可写）→ log + 不阻塞 server 启动
    console.error('[ChannelManager] construct failed:', err);
    return undefined;
  }
}
