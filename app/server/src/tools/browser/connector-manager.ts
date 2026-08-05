/**
 * BrowserConnectorManager 真实实现
 * 参考: specs/tech/config/[P1]connectors.md §2-§6
 *       states/v0.0.46.connector_opt/design.md §2
 *
 * 核心模型：
 *   - `enable()` / `bootstrap()` 只写 intent + 更新 state.switch，不调 driver.connect
 *   - `connectForToolRun(id, sessionId)`：LLM 首次调 attach 时触发 lazy connect（含门禁分层）
 *   - `disconnect(id, sessionId?)`：LLM disconnect action / session DELETE 兜底；idempotent
 *   - owner（`{ sessionId, connectedAt }`）：sessionId 粒度全局唯一；enable/disable/bootstrap 不改 owner
 *   - switch 与 connection 完全解耦：switch=on 仅表示「已启用（feature flag）」，与是否连上无关
 *
 * 类型/接口/桩集中在 connector-types.ts；此处 re-export 保持外部兼容。
 */
import type { BrowserSession, BrowserConnectOptions } from './types';
import type { ChromeMcpDriver } from './chrome-mcp-driver';
import type { ConnectorConfigService } from '../../config/connector-config-service';
// 共享治理类型（非泛型）从唯一源 connector/types.ts 取
import type { ConnectorId, ConnectorState, OwnerRef } from '../../connector/types';
// browser 特化类型（绑定 BrowserSession）从 browser 门面取
import type { ConnectForToolRunResult, ConnectorManager } from './connector-types';

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
  OwnerRef,
  ConnectForToolRunResult,
  ConnectorManager,
} from './connector-types';

/** BrowserConnectorManager 构造参数（依赖注入：driver + configService + 可选 connect 选项） */
export interface BrowserConnectorManagerOptions {
  /** ChromeMcpDriver 实例（ConnectorManager 持有单例，attach session 长存复用） */
  driver: ChromeMcpDriver;
  /** connector_config 持久化服务（落盘 switch intent） */
  configService: ConnectorConfigService;
  /** attach connect 选项（profileName/userDataDir/cdpUrl；缺省走 driver autoConnect） */
  connectOptions?: BrowserConnectOptions;
}

/**
 * BrowserConnectorManager —— 真实连接器运行时服务。
 *
 * 内部状态：
 *   - state: ConnectorState（switch/connection/lastConnectedAt/errorDetail）
 *   - attachSession: 已建立的 driver session（connected 时持有）
 *   - owner: 当前 attach 资源占用者（sessionId 粒度）
 */
export class BrowserConnectorManager implements ConnectorManager {
  /** browser 连接器实时态（唯一连接器） */
  private state: ConnectorState = {
    id: 'browser',
    switch: 'off',
    connection: 'disconnected',
  };
  /** 已建立的 attach session（connected 时缓存；disconnect 清空） */
  private attachSession: BrowserSession | undefined;
  /** 当前 attach 占用者（空=未占用） */
  private owner: OwnerRef = null;
  private readonly opts: BrowserConnectorManagerOptions;

  constructor(opts: BrowserConnectorManagerOptions) {
    this.opts = opts;
  }

  /** 只在 browser id 上生效（防御性；唯一 id） */
  private isBrowser(id: ConnectorId): boolean {
    return id === 'browser';
  }

  /** 连接器是否就绪：switch on + connection connected（tech spec §6） */
  isReady(id: ConnectorId): boolean {
    if (!this.isBrowser(id)) return false;
    return this.state.switch === 'on' && this.state.connection === 'connected';
  }

  /** 取 attach session（connected 时返缓存 session；未连接返 undefined） */
  getAttachSession(id: ConnectorId): BrowserSession | undefined {
    if (!this.isBrowser(id)) return undefined;
    return this.isReady('browser') ? this.attachSession : undefined;
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

  /** 当前 attach 占用者（null = 未占用） */
  getOwner(id: ConnectorId): OwnerRef {
    if (!this.isBrowser(id)) return null;
    return this.owner ? { ...this.owner } : null;
  }

  /**
   * 用户 toggle on（tech spec §3.2）：
   *   仅持久化 intent + state.switch='on'（保 connection='disconnected'）；**不 connect、不改 owner**。
   *   connect 由 LLM 首次调 attach 触发（connectForToolRun）。
   */
  async enable(id: ConnectorId): Promise<void> {
    if (!this.isBrowser(id)) return;
    this.opts.configService.setEnabled('browser', true);
    this.state = {
      id: 'browser',
      switch: 'on',
      connection: 'disconnected',
    };
    // owner / attachSession 不动
  }

  /**
   * 用户 toggle off（tech spec §3.2 迁移表「用户点 toggle off」）：
   *   持久化 intent=off + 若 attachSession 存在则 driver.disconnect（graceful，不杀 chrome）
   *   + owner=null + state={switch:'off', connection:'disconnected'}。失败吞错。
   */
  async disable(id: ConnectorId): Promise<void> {
    if (!this.isBrowser(id)) return;
    this.opts.configService.setEnabled('browser', false);
    if (this.attachSession) {
      try {
        await this.opts.driver.disconnect(this.opts.connectOptions ?? {});
      } catch {
        /* graceful，不阻断状态迁移 */
      }
    }
    this.attachSession = undefined;
    this.owner = null;
    this.state = {
      id: 'browser',
      switch: 'off',
      connection: 'disconnected',
    };
  }

  /**
   * app 启动（tech spec §3.3）：
   *   仅读持久化 intent 恢复 state.switch，connection 一律 'disconnected'。**不 connect**。
   *   幂等：可重复调用。
   */
  async bootstrap(): Promise<void> {
    const intentOn = this.opts.configService.getEnabled('browser');
    this.state = {
      id: 'browser',
      switch: intentOn ? 'on' : 'off',
      connection: 'disconnected',
    };
    // owner/attachSession 不写
  }

  /**
   * LLM 首次调 attach 时触发 lazy connect（tech spec §5 门禁分层）。
   *   1. switch='off'                                 → not_enabled
   *   2. owner!=null && owner.sid≠sid && connected    → in_use_by_other
   *   3. owner?.sid===sid && attachSession && connected → 复用 session
   *   4. 否则 → 触发 driver.connect；失败即停不重试
   */
  async connectForToolRun(
    id: ConnectorId,
    sessionId: string,
  ): Promise<ConnectForToolRunResult> {
    if (!this.isBrowser(id)) {
      return {
        ok: false,
        error: { kind: 'not_enabled', message: `unknown connector id: ${id}` },
      };
    }
    // 门禁 1：未启用
    if (this.state.switch === 'off') {
      return {
        ok: false,
        error: {
          kind: 'not_enabled',
          message: 'browser attach 未启用：请在「连接器 → 浏览器」中开启开关',
        },
      };
    }
    // 门禁 2：被其他 session 占用（且当前实际 connected）
    if (
      this.owner &&
      this.owner.sessionId !== sessionId &&
      this.state.connection === 'connected'
    ) {
      return {
        ok: false,
        error: {
          kind: 'in_use_by_other',
          ownerSessionId: this.owner.sessionId,
          message: `browser attach 已被其他会话占用（sessionId=${this.owner.sessionId}），请先在该会话调用 disconnect`,
        },
      };
    }
    // 门禁 3：同 owner 复用
    if (
      this.owner?.sessionId === sessionId &&
      this.attachSession &&
      this.state.connection === 'connected'
    ) {
      return { ok: true, session: this.attachSession };
    }
    // 门禁 4：触发 lazy connect
    this.state = {
      id: 'browser',
      switch: 'on',
      connection: 'connecting',
    };
    try {
      const session = await this.opts.driver.connect(this.opts.connectOptions ?? {});
      const now = Date.now();
      this.attachSession = session;
      this.owner = { sessionId, connectedAt: now };
      this.state = {
        id: 'browser',
        switch: 'on',
        connection: 'connected',
        lastConnectedAt: now,
      };
      return { ok: true, session };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 失败即停：state=error + owner=null + attachSession=undefined；不重试
      this.attachSession = undefined;
      this.owner = null;
      this.state = {
        id: 'browser',
        switch: 'on',
        connection: 'error',
        errorDetail: msg,
      };
      return {
        ok: false,
        error: {
          kind: 'connect_failed',
          message: `browser attach 连接失败：${msg}`,
        },
      };
    }
  }

  /**
   * 主动断开（LLM disconnect action / session DELETE 兜底）；idempotent。
   *   - owner==null                       → no-op
   *   - sessionId 传入 && 与 owner 不匹配   → no-op（不能替他人断）
   *   - 匹配（或未传 sessionId）             → driver.disconnect（吞错） + 清 owner/session/connection
   *   switch 保持不变（对比 disable：disable 会清 switch）。
   */
  async disconnect(id: ConnectorId, sessionId?: string): Promise<void> {
    if (!this.isBrowser(id)) return;
    if (!this.owner) return; // 无占用 → no-op
    if (sessionId !== undefined && this.owner.sessionId !== sessionId) {
      return; // 不能替他人 disconnect
    }
    try {
      await this.opts.driver.disconnect(this.opts.connectOptions ?? {});
    } catch {
      /* graceful，不阻断状态迁移 */
    }
    this.attachSession = undefined;
    this.owner = null;
    this.state = {
      id: 'browser',
      switch: this.state.switch, // 保持（不改 intent）
      connection: 'disconnected',
    };
  }
}
