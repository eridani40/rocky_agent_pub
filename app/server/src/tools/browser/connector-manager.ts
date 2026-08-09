/**
 * BrowserConnectorManager 真实实现
 * 参考: specs/tech/config/[P1]connectors.md §2-§6
 *       states/v0.0.46.connector_opt/design.md §2
 *
 * 核心模型（v0.0.266 瘦身）：
 *   - 职责 = 「switch 门禁 + UI 状态」：enable/disable/bootstrap 只写 intent + 更新 state.switch，
 *     不调 driver.connect；attach session 生命周期（launch/操作/close）归 BrowserInstanceManager
 *     （经 attachDriver + isAttachEnabled 注入）。
 *   - switch 与 connection 解耦：switch=on 仅表示「已启用（feature flag）」，与是否连上无关。
 *   - connection 仅 UI 展示（disconnected/error 反映最近 connect 结果；bootstrap 一律 disconnected）。
 *
 * 类型/接口/桩集中在 connector-types.ts；此处 re-export 保持外部兼容。
 */
import type { ConnectorConfigService } from '../../config/connector-config-service';
// 共享治理类型（非泛型）从唯一源 connector/types.ts 取
import type { ConnectorId, ConnectorState } from '../../connector/types';
// browser 特化类型（绑定 BrowserSession）从 browser 门面取
import type { ConnectorManager } from './connector-types';

// re-export：外部（bootstrap.ts / handlers / tool.ts / UT）保持从 connector-manager 导入
export {
  CONNECTOR_MANAGER,
  NoopConnectorManager,
  noopConnectorManager,
} from './connector-types';
export type {
  ConnectorId,
  ConnectorSwitch,
  ConnectorConnection,
  ConnectorState,
  ConnectorManager,
} from './connector-types';

/** BrowserConnectorManager 构造参数（依赖注入：configService） */
export interface BrowserConnectorManagerOptions {
  /** connector_config 持久化服务（落盘 switch intent） */
  configService: ConnectorConfigService;
}

/**
 * BrowserConnectorManager —— 浏览器连接器开关门禁（switch intent + UI 状态）。
 * v0.0.266 起不再持有 attach session/owner（归 InstanceManager）。
 */
export class BrowserConnectorManager implements ConnectorManager {
  /** browser 连接器实时态（唯一连接器） */
  private state: ConnectorState = {
    id: 'browser',
    switch: 'off',
    connection: 'disconnected',
  };
  private readonly opts: BrowserConnectorManagerOptions;

  constructor(opts: BrowserConnectorManagerOptions) {
    this.opts = opts;
  }

  /** 只在 browser id 上生效（防御性；唯一 id） */
  private isBrowser(id: ConnectorId): boolean {
    return id === 'browser';
  }

  /** 连接器是否就绪：switch on（feature flag 门禁；attach 实际连通由 InstanceManager 判） */
  isReady(id: ConnectorId): boolean {
    if (!this.isBrowser(id)) return false;
    return this.state.switch === 'on';
  }

  /** browser 连接器实时态（GET /config/connectors / UI 用） */
  getState(id: ConnectorId): ConnectorState {
    if (!this.isBrowser(id)) {
      return { id, switch: 'off', connection: 'disconnected' };
    }
    return { ...this.state };
  }

  /** 所有连接器实时态（仅 browser） */
  getAll(): ConnectorState[] {
    return [this.getState('browser')];
  }

  /** 用户 toggle on：仅持久化 intent + state.switch='on'；不 connect（attach 由 LLM launch 触发） */
  async enable(id: ConnectorId): Promise<void> {
    if (!this.isBrowser(id)) return;
    this.opts.configService.setEnabled('browser', true);
    this.state = {
      id: 'browser',
      switch: 'on',
      connection: 'disconnected',
    };
  }

  /** 用户 toggle off：仅持久化 intent=off + state={switch:'off', connection:'disconnected'}；不 connect/disconnect */
  async disable(id: ConnectorId): Promise<void> {
    if (!this.isBrowser(id)) return;
    this.opts.configService.setEnabled('browser', false);
    this.state = {
      id: 'browser',
      switch: 'off',
      connection: 'disconnected',
    };
  }

  /** app 启动：仅读持久化 intent 恢复 state.switch，connection 一律 'disconnected'。幂等。 */
  async bootstrap(): Promise<void> {
    const intentOn = this.opts.configService.getEnabled('browser');
    this.state = {
      id: 'browser',
      switch: intentOn ? 'on' : 'off',
      connection: 'disconnected',
    };
  }
}
