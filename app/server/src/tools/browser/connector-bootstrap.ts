/**
 * ConnectorManager bootstrap 工厂
 * 参考: specs/tech/config/[P1]connectors.md §3.3（bootstrap 只读 intent、不 connect）
 *       states/v0.0.46.connector_opt/design.md §4
 *
 * 负责：
 *   - 构造 BrowserConnectorManager（ConnectorConfigService；v0.0.266 起 driver 不再由
 *     ConnectorManager 持有——attach session 归 InstanceManager）
 *   - 构造共享 ChromeMcpDriver 单例（attachDriver，返回给 InstanceManager 注入）
 *   - 调 `bootstrap()`：仅读持久化 intent 恢复 state.switch，不触发 driver.connect
 *     （避免 chrome-devtools-mcp `--autoConnect` 弹系统 prompt）
 *   - 构造 / bootstrap 失败 → 降级 noopConnectorManager + attachDriver=undefined
 *     （attach 安全 fail-closed）
 *
 * 连接器是可选附件，降级不阻断 app 启动；用户在 UI toggle on 只更新 intent，
 * attach 由 LLM launch(mode='attach') 时经 InstanceManager 触发。
 */
import { ConnectorConfigService } from '../../config/connector-config-service';
import { defaultMcpFactory } from './mcp-factory';
import { ChromeMcpDriver } from './chrome-mcp-driver';
import {
  BrowserConnectorManager,
  noopConnectorManager,
  type ConnectorManager,
} from './connector-manager';

/** bootstrap 产出：ConnectorManager（switch 门禁/UI）+ 共享 attachDriver 单例（InstanceManager 注入） */
export interface ConnectorBootstrapResult {
  connectorManager: ConnectorManager;
  /** ChromeMcpDriver 单例（attach connect/disconnect 用）；降级时 undefined → InstanceManager fail-closed */
  attachDriver: ChromeMcpDriver | undefined;
}

/**
 * 构造 ConnectorManager 并触发 bootstrap（读持久化 intent 恢复 switch 态）。
 *
 * @param dataDir 数据根目录（ConnectorConfigService 落盘根）
 * @returns { connectorManager, attachDriver }（真实 or 降级 noop + undefined driver）
 */
export function createAndBootstrapConnectorManager(dataDir: string): ConnectorBootstrapResult {
  try {
    const connectorConfigService = new ConnectorConfigService({ root: dataDir });
    const attachDriver = new ChromeMcpDriver({ mcpFactory: defaultMcpFactory });
    const connectorManager = new BrowserConnectorManager({
      configService: connectorConfigService,
    });
    // bootstrap 仅读持久化 intent 恢复 state.switch（intent=on → switch=on/connection=disconnected；
    // intent=off → switch=off/connection=disconnected）——**不 connect、不 spawn chrome-devtools-mcp**。
    void connectorManager.bootstrap?.().catch(() => {
      /* bootstrap 语义仅读 intent，此处仅为 defensive fallback */
    });
    return { connectorManager, attachDriver };
  } catch {
    // 降级 noop + 无 driver（attach fail-closed）；用户可在 UI 重试
    return { connectorManager: noopConnectorManager, attachDriver: undefined };
  }
}
