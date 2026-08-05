/**
 * platform/computer 公共 API 桶导出（ComputerNativePort 模式，v0.0.105 pivot 后）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2.md §1/§5
 *
 * 稳定接口面：ComputerNativePort（interface）+ 纯类型 + registry setter/getter + 三态解析器。
 * 去连接器语义：无 Driver/Session/ConnectorManager（已 pivot 到主进程注入 port）。
 */
export type {
  ComputerNativePort,
  ComputerPermissions,
  ComputerScreenshotResult,
  ComputerScreenshotOptions,
  AxTreeNode,
  AxTreeOptions,
  AxTreeResult,
  ComputerActionResult,
  ScrollOptions,
  TypeOptions,
  PressKeyOptions,
  DragOptions,
  SetValueOptions,
  SecondaryActionOptions,
  GetAppStateOptions,
  GetAppStateResult,
  AppInfo,
  PixelPoint,
  WindowBounds,
  ComputerTarget,
  ClickOptions,
  ComputerErrorCode,
} from './native-port';
export { ComputerError } from './native-port';

export { setComputerNativePort, getComputerNativePort } from './native-port-registry';
export {
  MockComputerNativePort,
  resolveMockComputerNativePort,
  type ComputerMockFixture,
} from './mock-native-port';
export {
  LoopbackComputerNativePort,
  resolveLoopbackComputerNativePort,
} from './loopback-native-port';
