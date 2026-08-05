/**
 * ComputerNativePort —— agent 控制本机桌面的原生能力端口（纯 TS 接口，零 electron）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2.md §1 架构总览 + §5 P0-A
 *       specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §P1-A（11 能力对齐 open-codex）
 *
 * 架构 pivot（v0.0.105）：废除「ConnectorManager → spawn Swift helper → IPC session」三层，
 * 改为「Rocky Electron 主进程注入 ComputerNativePort 实现 → server tool 直调 port」。
 * computer 去连接器语义（无 toggle / owner 锁 / connect-disconnect；本机主进程常驻能力）。
 *
 * 不变量（§1）：
 *   1. 本文件是**纯 TS interface + 权限态 + Error 类**，绝不 import electron、绝不 spawn。
 *   2. server 只调 port；port 的电子实现（native addon / desktopCapturer）在 app/electron。
 *   3. UT/AT 可注入 mock port（守 memory test-no-real-spawn-system-gui）。
 *
 * 接口方法（11 能力，对齐 open-codex 9-tool + 2 省 token 补充）：
 *   - 读类：checkPermissions / screenshot（native 单窗口截图）/ getAppState（截图+AX 合一）/
 *     readAxTree（纯 AX 树）/ listApps（运行中 app 列表）
 *   - 动作类：click / type / scroll / pressKey / drag（坐标拖拽）/ setValue（AX 直接赋值）/
 *     performSecondaryAction（AX 语义次要动作，如 Raise/Press menu）
 *   impl 三态：主进程直调 / dev loopback / AT mock。tool 层收敛为单 `computer` tool 后，
 *   port 仍保持分方法粒度（底层能力粒度与 tool 暴露形态无关）。
 *
 * 坐标模型（window-relative 三段式，对齐 open-codex）：screenshot/getAppState 返 windowBounds
 *   （screen point 边界）+ 截图像素宽 → tool 按 sessionId 缓存 {scaleFactor,windowBounds}；
 *   coordinate 动作（x,y / drag from-to）前必先 screenshot/get_app_state 建坐标上下文。
 *
 * 数据形状类型（截图结果 / AX 树 / 坐标 / 各动作 options）拆到 `native-port-types.ts` 控体量，
 *   本文件 `export *` 再导出保持既有 import 面稳定。
 */
import type {
  AppInfo,
  AxTreeOptions,
  AxTreeResult,
  ClickOptions,
  ComputerActionResult,
  ComputerScreenshotOptions,
  ComputerScreenshotResult,
  ComputerTarget,
  DragOptions,
  GetAppStateOptions,
  GetAppStateResult,
  PixelPoint,
  PressKeyOptions,
  ScrollOptions,
  SecondaryActionOptions,
  SetValueOptions,
  TypeOptions,
} from './native-port-types';

export * from './native-port-types';

/**
 * 权限态（tool 门禁消费；两态闭合，unknown/denied 一律收敛到 'missing' 由 impl 侧适配）。
 * 与 UI 路径 spike ComputerPermissions（platform/supported/accessibility:bool/screenRecording:多态）
 * 形状不同——UI 面板需展示细分态，tool 门禁只需 granted/missing 二值判定。impl 内做形状适配。
 */
export interface ComputerPermissions {
  accessibility: 'granted' | 'missing';
  screenRecording: 'granted' | 'missing';
}

/**
 * 把任意来源（mock fixture / loopback json）的权限值归一化到两态闭合。
 * 非 'granted' 一律 'missing'（fail-closed）；null/undefined/非对象安全兜底双 missing。
 * mock/loopback port impl 共用（避免各写一份 normalize）。
 */
export function coercePermissions(raw: unknown): ComputerPermissions {
  const p = (raw ?? {}) as { accessibility?: unknown; screenRecording?: unknown };
  return {
    accessibility: p.accessibility === 'granted' ? 'granted' : 'missing',
    screenRecording: p.screenRecording === 'granted' ? 'granted' : 'missing',
  };
}

/**
 * ComputerNativePort —— agent 原生桌面能力端口（唯一接口，主进程实现 + mock + loopback 各一份）。
 *
 * **MUST** 零 electron 依赖（纯 interface）；**MUST NOT** 声明 connect/session/disconnect
 * （去连接器语义——本机主进程常驻能力，不像 browser 连外部 CDP）。
 *
 * 动作类方法返 ComputerActionResult{ok,reason?}——对齐 screenshot 不抛异常范式
 * （ok=false 返 reason，tool 转 errorResult；addon 缺失/权限缺失 impl 侧收敛为 ok:false）。
 */
export interface ComputerNativePort {
  /** 权限预检（tool 门禁消费；两态判定）。impl 侧不抛，异常降级双 missing（fail-closed） */
  checkPermissions(): Promise<ComputerPermissions>;
  /** native 单窗口截图（ScreenCaptureKit；opts.app 指定 app key window，缺省 frontmost）；ok=false 返 reason 不抛 */
  screenshot(opts?: ComputerScreenshotOptions): Promise<ComputerScreenshotResult>;
  /** app 状态合一：单窗口截图 + AX 树一次返回（open-codex 每 turn 先调的主 action）；ok=false 返 reason 不抛 */
  getAppState(opts?: GetAppStateOptions): Promise<GetAppStateResult>;
  /** 读当前 AX 树：返渲染文本（行首 element_index，喂 LLM 主体）+ 结构化 nodes + pid + scaleFactor；ok=false 返 reason 不抛 */
  readAxTree(opts?: AxTreeOptions): Promise<AxTreeResult>;
  /** 列运行中 app（name/bundleId/pid；供 LLM 定位 app hint）；异常返空数组不抛 */
  listApps(): Promise<AppInfo[]>;
  /** 点击（element_index 主 / coordinate 辅，见 ComputerTarget）；ok=false 返 reason 不抛 */
  click(target: ComputerTarget, opts?: ClickOptions): Promise<ComputerActionResult>;
  /** 输入 Unicode 文本（focused 元素）；ok=false 返 reason 不抛 */
  type(text: string, opts?: TypeOptions): Promise<ComputerActionResult>;
  /** 滚动（opts.direction 必填 + pages 页数）；ok=false 返 reason 不抛 */
  scroll(target: ComputerTarget, opts: ScrollOptions): Promise<ComputerActionResult>;
  /** 按键/组合键（xdotool 语法，如 cmd+s / enter）；ok=false 返 reason 不抛 */
  pressKey(keySpec: string, opts?: PressKeyOptions): Promise<ComputerActionResult>;
  /** 坐标拖拽（from→to 均已换算为 screen point）；ok=false 返 reason 不抛 */
  drag(from: PixelPoint, to: PixelPoint, opts?: DragOptions): Promise<ComputerActionResult>;
  /** 给 AX 元素直接赋值（settable 元素，如输入框；Swift 侧校验 settable）；ok=false 返 reason 不抛 */
  setValue(elementIndex: number, value: string, opts?: SetValueOptions): Promise<ComputerActionResult>;
  /** 执行 AX 元素的次要语义动作（如 Raise / Press menu，从 read_ax_tree 的 Secondary Actions 取名）；ok=false 返 reason 不抛 */
  performSecondaryAction(elementIndex: number, action: string, opts?: SecondaryActionOptions): Promise<ComputerActionResult>;
}

/** Computer use 错误码（native addon 层错误统一集） */
export type ComputerErrorCode =
  | 'unsupported_platform'
  | 'permission_missing'
  | 'no_coordinate_context'
  | 'native_error'
  | 'state_unavailable' // v0.0.160：元素还在但没坐标 / 消失 / 无 backing AX object；对齐 Swift ComputerUseError.stateUnavailable
  | 'unknown';

/**
 * Computer use 统一错误。
 * which：permission_missing 时携带缺失的权限名（tool 门禁 formatter 用）。
 */
export class ComputerError extends Error {
  constructor(
    public readonly code: ComputerErrorCode | string,
    message: string,
    public readonly which?: 'accessibility' | 'screenRecording',
  ) {
    super(message);
    this.name = 'ComputerError';
  }
}
