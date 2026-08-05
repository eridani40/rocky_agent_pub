/**
 * computer-native-types —— Electron 侧 ComputerNativePort 的结构化镜像类型（不跨包 import type）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §P1-C
 *       app/server/src/platform/computer/native-port-types.ts（权威契约，字段名对齐）
 *
 * 为何镜像而非 import：electron 侧惯例 = 运行时 require + 结构化类型（见 backend-bootstrap.ts）。
 * @app/server 的 ComputerNativePort 是权威定义；本文件按结构 1:1 镜像，字段名/形状与 native-port-types 对齐，
 * 使 main.ts 直注入（setComputerNativePort）与 dev loopback 双路径的返回形状都能被 @app/server 消费。
 */

/** 窗口边界（screen point，y-down，origin 屏幕左上）—— coordinate 三段式换算源 */
export interface NativePortWindowBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 像素点（drag from/to / coordinate click 用） */
export interface NativePortPixelPoint {
  x: number;
  y: number;
}

/** click/scroll 目标（element_index AX 定位 或 coordinate 像素坐标，二选一） */
export type NativePortTarget = { elementIndex: number } | { coordinate: NativePortPixelPoint };

/** 权限两态（tool 门禁消费；镜像 @app/server ComputerPermissions） */
export interface NativePortPermissions {
  accessibility: 'granted' | 'missing';
  screenRecording: 'granted' | 'missing';
}

/**
 * 截图结果（native 单窗口截图；data = 裸 base64；windowBounds 供 coordinate 三段式）。
 * ok=false 时 data/width/height 缺省，reason 携带原因（fail-closed，tool 转 errorResult）。
 */
export interface NativePortScreenshotResult {
  ok: boolean;
  mediaType?: 'image/png' | 'image/jpeg';
  data?: string;
  width?: number;
  height?: number;
  windowBounds?: NativePortWindowBounds;
  scaleFactor?: number;
  reason?: string;
}

/** AX 树读取结果（readAxTree；text = 行首 element_index 的渲染树，喂 LLM 主体） */
export interface NativePortAxTreeResult {
  ok: boolean;
  text?: string;
  nodes?: unknown[];
  pid?: number;
  scaleFactor?: number;
  reason?: string;
}

/** app 状态合一结果（getAppState；单窗口截图 + AX 树；坐标上下文供 coordinate 三段式） */
export interface NativePortGetAppStateResult {
  ok: boolean;
  screenshot?: NativePortScreenshotResult;
  axText?: string;
  pid?: number;
  scaleFactor?: number;
  windowBounds?: NativePortWindowBounds;
  reason?: string;
}

/** 动作结果（click/type/scroll/pressKey/drag/setValue/performSecondaryAction 统一；ok=false 返 reason 不抛） */
export interface NativePortActionResult {
  ok: boolean;
  reason?: string;
  /** v0.0.160：native 错误分类码（如 `state_unavailable`），供 tool handler 决定友好文案 */
  code?: string;
}

/** 运行中 + Spotlight 最近使用 app 信息（listApps 返回） */
export interface NativePortAppInfo {
  bundleId: string;
  name: string;
  pid: number;
  isRunning: boolean;
  /** v0.0.160：单行 LLM 渲染格式（Spotlight AppDiscovery.renderedLine 输出，含 frontmost/running/last-used/uses 标记） */
  line?: string;
  /** v0.0.160：是否当前前台 app（NSWorkspace.frontmostApplication 匹配） */
  isFrontmost?: boolean;
  /** v0.0.160：最近使用日期（YYYY-MM-DD，Spotlight 索引取值；仅非运行 app 有值时才带） */
  lastUsed?: string;
  /** v0.0.160：Spotlight 记录的使用次数（`kMDItemUseCount`） */
  uses?: number;
}

/** 截图预算选项（app hint 定位 key window，缺省 frontmost） */
export interface NativePortScreenshotOptions {
  app?: string;
  maxBytes?: number;
  maxSide?: number;
}

/** AX 树采集预算（get_app_state 复用同形；全可选，缺省走 addon 默认） */
export interface NativePortAxTreeOptions {
  app?: string;
  /** v0.0.160：支持 `'max'` 字面量 = 无上限（对齐 Swift `SnapshotTextLimit.max`） */
  textLimit?: number | 'max';
  maxNodes?: number;
  maxDepth?: number;
}

/** 鼠标点击选项 */
export interface NativePortClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  pid?: number;
  app?: string;
}

/** 滚动选项（direction 缺省 down；pages 缺省 1） */
export interface NativePortScrollOptions {
  direction?: 'up' | 'down' | 'left' | 'right';
  pages?: number;
  pid?: number;
  app?: string;
}

/** 文本输入选项（全可选；缺省 addon 默认 Unicode chunking） */
export interface NativePortTypeOptions {
  pid?: number;
  chunkSize?: number;
  delayMs?: number;
  app?: string;
}

/** 按键选项（全可选） */
export interface NativePortKeyOptions {
  pid?: number;
  app?: string;
}

/** 拖拽选项（全可选；from/to 已换算 screen point） */
export interface NativePortDragOptions {
  steps?: number;
  pid?: number;
  app?: string;
}

/** setValue / performSecondaryAction 共用选项（全可选） */
export interface NativePortActionOptions {
  pid?: number;
  app?: string;
}

/**
 * ComputerNativePort 结构化镜像（@app/server 权威；此处结构化实现供主进程注入 + dev loopback 分发）。
 * 11 能力：读类 checkPermissions / screenshot / getAppState / readAxTree / listApps；
 *         动作类 click / type / scroll / pressKey / drag / setValue / performSecondaryAction。
 */
export interface ElectronComputerNativePort {
  checkPermissions(): Promise<NativePortPermissions>;
  screenshot(opts?: NativePortScreenshotOptions): Promise<NativePortScreenshotResult>;
  getAppState(opts?: NativePortAxTreeOptions): Promise<NativePortGetAppStateResult>;
  readAxTree(opts?: NativePortAxTreeOptions): Promise<NativePortAxTreeResult>;
  listApps(): Promise<NativePortAppInfo[]>;
  click(target: NativePortTarget, opts?: NativePortClickOptions): Promise<NativePortActionResult>;
  type(text: string, opts?: NativePortTypeOptions): Promise<NativePortActionResult>;
  scroll(target: NativePortTarget, opts?: NativePortScrollOptions): Promise<NativePortActionResult>;
  pressKey(keySpec: string, opts?: NativePortKeyOptions): Promise<NativePortActionResult>;
  drag(
    from: NativePortPixelPoint,
    to: NativePortPixelPoint,
    opts?: NativePortDragOptions,
  ): Promise<NativePortActionResult>;
  setValue(elementIndex: number, value: string, opts?: NativePortActionOptions): Promise<NativePortActionResult>;
  performSecondaryAction(
    elementIndex: number,
    action: string,
    opts?: NativePortActionOptions,
  ): Promise<NativePortActionResult>;
}
