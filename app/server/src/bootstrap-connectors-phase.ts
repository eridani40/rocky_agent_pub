/**
 * bootstrap-connectors-phase — Phase 10 装配：ConnectorManager + Channels + Browser + AutoNaming
 *
 * 纯 move 自 bootstrap.ts（v0.0.156 结构性拆分）。函数体 100% copy-paste，签名 + 内部逻辑不变。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §4.1 Phase 10 + §4.2 第六行
 *
 * 装配内容（按原 line 顺序，INV-C-1 严格保留）：
 *   1. ConnectorManager（构造失败不阻塞；createAndBootstrapConnectorManager）
 *   2. ComputerNativePort（三态：AT env-mock > dev-loopback > packaged registry；降级 undefined）
 *   3. ChannelManager（IM 渠道；构造失败 → undefined；shutdown hook 注册）
 *   4. BrowserDriverRegistry（NodeWorkerDriver 实例，mode headless）
 *   5. AutoNamingService（handleMessagesPost 内 fire-and-forget 触发 AI 起名）
 *
 * packaged 护栏（INV-PKG-1/2）：
 *   - computerNativePort 三态 resolution 走 process.env 检测（allowed：resolveMockComputerNativePort
 *     与 resolveLoopbackComputerNativePort 内部封装，phase helper 不直读其他 process.env 键）
 *   - 不拼接相对路径；dataDir 作入参
 */
import type { AgentManagerImpl } from './agent/agent-manager';
import type { SessionStore } from './agent/session-store';
import type { Registry } from './plugin';
import type { PluginManager } from './plugin';
import type { ConnectorManager } from './tools/browser/connector-manager';
import type { ComputerNativePort } from './platform/computer/native-port';
import type { ChannelManager } from './channel/channel-manager';
import type { DriverRegistry } from './tools/browser/pick-driver';
import { BrowserInstanceManager } from './tools/browser/instance-manager';
import { InMemoryModeImplRegistry } from './tools/browser/mode-impl';
import { WorkerModeImpl } from './tools/browser/worker-mode-impl';
import { AttachModeImpl } from './tools/browser/attach-mode-impl';
import type { SessionMetaBroadcaster } from './agent/session-meta-broadcaster';
import type { ObservabilityManager } from './observability/index';
import type { LogWriter } from './dev-logs/log-writer';
// ConnectorManager（连接器运行时双状态机）
import { createAndBootstrapConnectorManager } from './tools/browser/connector-bootstrap';
// ComputerNativePort 三态解析（test-mock > dev-loopback > packaged-registry）
import { resolveMockComputerNativePort } from './platform/computer/mock-native-port';
import { resolveLoopbackComputerNativePort } from './platform/computer/loopback-native-port';
import { getComputerNativePort } from './platform/computer/native-port-registry';
// ChannelManager（IM 渠道接入层管家）
import { createAndBootstrapChannelManager } from './channel/channel-bootstrap';
// BrowserDriverRegistry —— NodeWorkerDriver 实例
import { NodeWorkerDriver } from './tools/browser/node-worker-driver';
import { InMemoryDriverRegistry } from './tools/browser/pick-driver';
// AutoNamingService —— AI 起名
import { invoke as llmCallerInvoke } from './llm/caller/llm_caller';
import { AutoNamingService } from './agent/auto-naming-service';

/**
 * Phase 10 装配：ConnectorManager + ComputerNativePort + ChannelManager + BrowserDriverRegistry + AutoNaming。
 */
export async function bootstrapConnectorsPhase(deps: {
  dataDir: string;
  agentManager: AgentManagerImpl;
  store: SessionStore;
  registry: Registry;
  pluginManager: PluginManager;
  sessionMetaBroadcaster: SessionMetaBroadcaster;
  observabilityManager: ObservabilityManager;
}): Promise<{
  connectorManager: ConnectorManager;
  computerNativePort?: ComputerNativePort;
  channelManager?: ChannelManager;
  browserDriverRegistry: DriverRegistry;
  browserInstanceManager?: BrowserInstanceManager;
  autoNamingService: AutoNamingService;
}> {
  const { dataDir, agentManager, store, registry, pluginManager, sessionMetaBroadcaster, observabilityManager } = deps;

  // ConnectorManager —— 连接器运行时双状态机（spec [P1]connectors §5）。详见 connector-bootstrap.ts。
  // v0.0.266：createAndBootstrapConnectorManager 同时产出共享 attachDriver 单例（InstanceManager 注入）。
  const { connectorManager, attachDriver } = createAndBootstrapConnectorManager(dataDir);
  // ComputerNativePort —— computer use 原生能力端口（change_plan_v2 §2 注入链路）。
  // 三态单选 precedence（互斥）：AT env-mock > dev-loopback（dev.env 开关）> packaged registry 直调。
  // 降级 undefined（非 electron / dev 未开 loopback）不阻断启动——screenshot tool 侧 fail-closed。
  const computerNativePort: ComputerNativePort | undefined =
    resolveMockComputerNativePort(process.env, dataDir) ??
    resolveLoopbackComputerNativePort(process.env) ??
    getComputerNativePort();

  // ChannelManager —— IM 渠道接入层管家（spec channel/[P0]channel_manager §4）。
  // 注入时机：agentManager + agent_loop bus registerTopic 就绪之后，server.listen 之前。
  // connect fire-and-forget 不阻塞 server.listen；构造失败 → undefined 不阻塞 server 启动。
  // 注入依赖：agentManager（inbound deliverTo + outbound subscribe）/ sessionStore（listSessions）/
  //   registry（管理面）/ pluginManager（v0.0.206：getExtensionImpls 供无状态 impl，scope 门物化点）。
  const channelManager: ChannelManager | undefined = createAndBootstrapChannelManager({
    dataDir,
    agentManager,
    sessionStore: store,
    registry,
    pluginManager,
  });
  // 注册 shutdown hook：app shutdown → unregisterConfig 全部（disconnect IM 长连接）。
  if (channelManager && !globalThis.__channelManagerShutdownHookRegistered) {
    process.on('beforeExit', () => {
      for (const state of channelManager.getAllStates()) {
        void channelManager.unregisterConfig(state.id).catch(() => {
          /* shutdown 吞错，不阻塞退出 */
        });
      }
    });
    globalThis.__channelManagerShutdownHookRegistered = true;
  }

  // BrowserDriverRegistry —— NodeWorkerDriver 实例（mode ① headless / ② managed-profile）。
  // Bun 下 playwright.connectOverCDP 永久 hang，改走 node worker 子进程（绕开 Bun bug）。
  // attach 模式由 attachDriver（ChromeMcpDriver）处理，不放入 registry（避免双源）。
  // web_fetch headless 需 navigate+evaluate 长 session，但 NodeWorkerDriver 是一次性的（不支持），
  // buildHeadlessRenderer 检测 driver.connect 缺省时跳过 headless → 静态渲染兜底（headless 本就 Bun 下 hang）。
  const nodeWorkerDriver = new NodeWorkerDriver({ dataDir });
  const browserDriverRegistry: DriverRegistry = new InMemoryDriverRegistry({
    headless: nodeWorkerDriver,
  });

  // BrowserInstanceManager —— headless/managed-profile/attach 常驻浏览器实例管理器（v0.0.264 + v0.0.266）。
  // 构造即触发开机自检（清上次崩溃残留孤儿）+ 注册 shutdown hook（beforeExit/SIGTERM/SIGINT → releaseAll，
  // 模块级标记位防重复挂载，对齐 channelManager/workspaceManager/squad-runtime 模式）。
  // v0.0.266 T3：ActionExecutor registry——headless/managed-profile 注册同一 WorkerModeImpl 两键，
  // attach 注册 AttachModeImpl（无参构造；attachDriver/isAttachEnabled 经 manager env 透传 impl）。
  // 装配失败 → undefined（noop fallback，同 connectorManager 模式，不阻塞 server 启动）。
  const browserInstanceManager: BrowserInstanceManager | undefined = (() => {
    try {
      const workerImpl = new WorkerModeImpl();
      const registry = new InMemoryModeImplRegistry([
        ['headless', workerImpl],
        ['managed-profile', workerImpl],
        ['attach', new AttachModeImpl()],
      ]);
      return new BrowserInstanceManager({
        dataDir,
        registry,
        attachDriver,
        isAttachEnabled: () => connectorManager.getState?.('browser')?.switch === 'on',
      });
    } catch (e) {
      console.warn(
        `[bootstrap] BrowserInstanceManager 装配失败（noop fallback）: ${e instanceof Error ? e.message : String(e)}`,
      );
      return undefined;
    }
  })();

  // AutoNamingService —— handleMessagesPost 内 fire-and-forget 触发 AI 起名
  // （spec auto_naming/[P0]auto_naming_service.md）。与 unreadRuntime / broadcaster 共享同源实例。
  // 注：agentManager.setResolveConfig 已在后置注入完成（见上），此处可直接消费。
  // 起名走 LlmCaller.invoke：复用 adaptive retry + langfuse 闭环 + 错误归一化。
  // observability 真源 = observabilityManager（与 AgentManager 同源）：
  //   起名 applyAiName 走 resolveConfigBySid，不走 activate（observability 注入点），
  //   故必须从 deps 注入（config.observability 恒 undefined）。
  const autoNamingService = new AutoNamingService({
    store,
    agentManager,
    metaBroadcaster: sessionMetaBroadcaster,
    llmCaller: { invoke: llmCallerInvoke },
    observability: observabilityManager,
  });

  return {
    connectorManager,
    ...(computerNativePort ? { computerNativePort } : {}),
    ...(channelManager ? { channelManager } : {}),
    browserDriverRegistry,
    ...(browserInstanceManager ? { browserInstanceManager } : {}),
    autoNamingService,
  };
}

// 模块级标记位（避免 shutdown hook 重复挂载）
declare global {
  // eslint-disable-next-line no-var
  var __channelManagerShutdownHookRegistered: boolean | undefined;
}
