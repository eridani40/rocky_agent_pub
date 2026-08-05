/**
 * Browser 连接器类型（thin re-export + browser 特化）
 * 参考: specs/tech/config/[P1]connectors.md §3-§5
 *
 * v0.0.105：与 SessionT 无关的治理类型已提取到 `app/server/src/connector/types.ts`（唯一源，
 * browser + computer 共用）。本文件保留为 browser 门面——
 *   - re-export 共享类型（保外部 import 路径零改动：`from './connector-types'` 不变）
 *   - 把泛型 `ConnectorManager<SessionT>` / `ConnectForToolRunResult<SessionT>` 特化到 BrowserSession
 *   - 保留 browser-local 的 Noop 桩 + CONNECTOR_MANAGER 注入符号
 *
 * 真正实现 BrowserConnectorManager 见 connector-manager.ts。
 */
import type { BrowserSession } from './types';
import type {
  ConnectorManager as GenericConnectorManager,
  ConnectForToolRunResult as GenericConnectForToolRunResult,
} from '../../connector/types';

// 共享治理类型（唯一源在 connector/types.ts；此处 re-export 保 browser import 路径兼容）
export type {
  ConnectorId,
  ConnectorSwitch,
  ConnectorConnection,
  ConnectorState,
  OwnerRef,
  ConnectForToolRunErrorKind,
} from '../../connector/types';

/** browser 特化：ConnectorManager 绑定 BrowserSession（外部按此名 import） */
export type ConnectorManager = GenericConnectorManager<BrowserSession>;

/** browser 特化：connectForToolRun 结果绑定 BrowserSession */
export type ConnectForToolRunResult = GenericConnectForToolRunResult<BrowserSession>;

/** 标识 ConnectorManager（用于在 ToolSessionConfigLike 注入；类似 pluginManager） */
export const CONNECTOR_MANAGER = Symbol('connectorManager');

/**
 * 未连接 stub（默认值）：所有连接器 isReady=false、getAttachSession=undefined。
 * 用于 ConnectorManager 未注入或未启用时，browser attach 安全 fail-closed。
 */
export class NoopConnectorManager implements ConnectorManager {
  isReady(): boolean {
    return false;
  }
  getAttachSession(): BrowserSession | undefined {
    return undefined;
  }
}

/** 共享默认实例（browser Tool fallback） */
export const noopConnectorManager = new NoopConnectorManager();
