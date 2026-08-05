/**
 * ConnectorManager bootstrap 工厂
 * 参考: specs/tech/config/[P1]connectors.md §3.3（bootstrap 只读 intent、不 connect）
 *       states/v0.0.46.connector_opt/design.md §4
 *
 * 负责：
 *   - 构造 BrowserConnectorManager（ChromeMcpDriver 单例 + ConnectorConfigService）
 *   - 调 `bootstrap()`：仅读持久化 intent 恢复 state.switch，不触发 driver.connect
 *     （避免 chrome-devtools-mcp `--autoConnect` 弹系统 prompt）
 *   - 构造 / bootstrap 失败 → 降级 noopConnectorManager（attach 安全 fail-closed）
 *
 * 连接器是可选附件，降级不阻断 app 启动；用户在 UI toggle on 只更新 intent，
 * connect 由 LLM 首次调 attach（`connectForToolRun`）时 lazy 触发。
 */
import { ConnectorConfigService } from '../../config/connector-config-service';
import { defaultMcpFactory } from './mcp-factory';
import { ChromeMcpDriver } from './chrome-mcp-driver';
import {
  BrowserConnectorManager,
  noopConnectorManager,
  type ConnectorManager,
} from './connector-manager';

/**
 * 构造 ConnectorManager 并触发 bootstrap（读持久化 intent 自动重连）。
 *
 * @param dataDir 数据根目录（ConnectorConfigService 落盘根）
 * @returns ConnectorManager 实例（真实 or 降级 noop）
 */
export function createAndBootstrapConnectorManager(dataDir: string): ConnectorManager {
  try {
    const connectorConfigService = new ConnectorConfigService({ root: dataDir });
    const chromeDriver = new ChromeMcpDriver({ mcpFactory: defaultMcpFactory });
    const connectorManager = new BrowserConnectorManager({
      driver: chromeDriver,
      configService: connectorConfigService,
    });
    // bootstrap 仅读持久化 intent 恢复 state.switch（intent=on → switch=on/connection=disconnected；
    // intent=off → switch=off/connection=disconnected）——**不 connect、不 spawn chrome-devtools-mcp**。
    // 异步调用（不阻塞 app 启动）；本身不做 IO 之外仍容错兜底。
    void connectorManager.bootstrap?.().catch(() => {
      /* bootstrap 语义仅读 intent，此处仅为 defensive fallback */
    });
    return connectorManager;
  } catch {
    // 降级 noop（attach fail-closed）；用户可在 UI 重试
    return noopConnectorManager;
  }
}
