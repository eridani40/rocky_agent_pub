/**
 * ComputerNativePort 数据形状类型（纯类型，零运行时；从 native-port.ts 拆出控体量）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §P1-A
 *
 * 本文件 = port 方法的入参/出参形状（截图结果、AX 树、坐标、各动作 options）。
 * 行为契约（ComputerNativePort interface）+ 权限态 + Error 类留在 native-port.ts。
 * native-port.ts `export * from './native-port-types'` 再导出，保持既有 import 面稳定。
 */

/**
 * 截图结果（port.screenshot 返回；ok=false 不抛异常，返 reason 供 tool 转 errorResult）。
 * data 是**裸 base64**（无 `data:image/png;base64,` 前缀），直接进 ImageBlock.source.data。
 */
export interface ComputerScreenshotResult {
  /** 是否成功；false 时 data/width/height 缺省，reason 携带原因 */
  ok: boolean;
  /** 图片 MIME（成功时；缺省按 image/png 处理） */
  mediaType?: 'image/png' | 'image/jpeg';
  /** 裸 base64（无 data: 前缀）；序列化进 ImageBlock.source.data */
  data?: string;
  /** 截图像素宽 */
  width?: number;
  /** 截图像素高 */
  height?: number;
  /**
   * 单窗口截图的窗口 screen point 边界（origin=窗口左上，供 coordinate 三段式换算偏移）。
   * native per-window 截图必带；缺省视为全屏 origin=(0,0)。
   */
  windowBounds?: WindowBounds;
  /** Retina 缩放因子（native backingScaleFactor 报告值；tool 侧 deriveScaleFactor 兜底源） */
  scaleFactor?: number;
  /** 失败原因（无权限 / 无 source / 非 macOS / 异常 / 通道不可达） */
  reason?: string;
}

/** 截图预算选项（可选；缺省 native impl 截 frontmost app key window） */
export interface ComputerScreenshotOptions {
  /** 目标 app hint（bundleId 或 name；native ScreenCaptureKit 定位该 app key window，缺省 frontmost） */
  app?: string;
  /** 截图字节上限（超则降采样；impl 可忽略） */
  maxBytes?: number;
  /** 最大像素边（超则缩放；impl 可忽略） */
  maxSide?: number;
}

/** 窗口边界（point 坐标系，y-down，origin 屏幕左上）—— AX frame + coords 换算用 */
export interface WindowBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** AX tree 节点（get_app_state 返回的 element_index 来源） */
export interface AxTreeNode {
  /** 顺序整数索引（tool click({element_index}) 用此值；非稳定 ID，跨 turn 失效） */
  index: number;
  role: string; // AXButton / AXTextField / AXMenu / ...
  title?: string;
  value?: string;
  frame?: WindowBounds; // window-relative point
  children?: AxTreeNode[];
}

/** 运行中 + Spotlight 最近使用 app 信息（list_apps 返回） */
export interface AppInfo {
  bundleId: string;
  name: string;
  pid: number;
  isRunning: boolean;
  /** v0.0.160：单行 LLM 渲染格式 `"<name> — <bundleId> [<flags>]"`（含 frontmost/running/last-used/uses 标记，对齐 open-codex） */
  line?: string;
  /** v0.0.160：是否当前前台 app（NSWorkspace.frontmostApplication 匹配） */
  isFrontmost?: boolean;
  /** v0.0.160：最近使用日期（YYYY-MM-DD，Spotlight 索引取值；仅非运行 app 有值时才带） */
  lastUsed?: string;
  /** v0.0.160：Spotlight 记录的使用次数（`kMDItemUseCount`） */
  uses?: number;
}

/** click/scroll 共用的点坐标（screenshotPixel 坐标系） */
export interface PixelPoint {
  x: number;
  y: number;
}

/** click/scroll 目标（element_index AX 定位 或 coordinate 像素坐标，二选一） */
export type ComputerTarget = { elementIndex: number } | { coordinate: PixelPoint };

/** 鼠标动作选项 */
export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: 1 | 2 | 3;
  /** postToPid 目标 pid（缺省用 session 缓存的 last getAppState pid） */
  pid?: number;
  /** 目标 app hint（Swift resolvePid 定位；缺省 frontmost） */
  app?: string;
}

/** AX 树采集预算（全可选；缺省走 addon 默认，如 textLimit 500 / maxNodes 1200 / maxDepth 64） */
export interface AxTreeOptions {
  /** 目标 app hint（NSWorkspace 定位；缺省 frontmost） */
  app?: string;
  /**
   * 渲染文本字符上限（喂 LLM 主体，防超长）。
   * v0.0.160：支持 `'max'` 字面量 = 无上限（对齐 Swift `SnapshotTextLimit.max`）。
   */
  textLimit?: number | 'max';
  /** 采集节点数上限 */
  maxNodes?: number;
  /** 采集深度上限 */
  maxDepth?: number;
}

/**
 * AX 树读取结果（readAxTree 返回；ok=false 不抛，返 reason 供 tool 转 errorResult）。
 * text = 行首 element_index 的渲染树（tool 直接作 TextBlock 喂 LLM 主体）；
 * scaleFactor 供 coordinate 模式 click/scroll 的像素→point 换算（tool 按 sessionId 缓存）。
 */
export interface AxTreeResult {
  /** 是否成功；false 时其余字段缺省，reason 携带原因 */
  ok: boolean;
  /** 渲染文本（行首 element_index，喂 LLM 主体） */
  text?: string;
  /** 结构化节点列表（可选；element_index 来源，tool 一般只用 text） */
  nodes?: AxTreeNode[];
  /** 目标进程 pid（后续 click 走 postToPid 复用；Swift-side 亦自缓存） */
  pid?: number;
  /** Retina 缩放因子（coordinate 换算用；electron impl 从 screen.getPrimaryDisplay 补） */
  scaleFactor?: number;
  /** 失败原因（无权限 / addon 不可达 / 目标 app 未找到 / 异常） */
  reason?: string;
}

/**
 * 动作结果（click/type/scroll/pressKey/drag/setValue/performSecondaryAction 统一返回；ok=false 不抛）。
 * 对齐 screenshot fail-closed 范式：tool 见 !ok → errorResult(reason)。
 * v0.0.160：`code` 携带 native 错误分类（如 `state_unavailable`），供 handler 决定是否加友好文案前缀。
 */
export interface ComputerActionResult {
  /** 是否成功；false 时 reason 携带原因（无权限 / addon 不可达 / 目标非法） */
  ok: boolean;
  /** 失败原因（原始 native message，供 debug 附带） */
  reason?: string;
  /** v0.0.160：失败分类码（如 `state_unavailable`；对齐 Swift ComputerUseError.code） */
  code?: string;
}

/** 滚动选项（direction 必填；pages 缺省 1 页；pid 缺省 Swift-side resolvePid frontmost） */
export interface ScrollOptions {
  /** 滚动方向（必填） */
  direction: 'up' | 'down' | 'left' | 'right';
  /** 滚动页数（tool 从 input.pages 映射；缺省 addon 默认 1） */
  pages?: number;
  /** postToPid 目标 pid（缺省 Swift-side resolvePid frontmost） */
  pid?: number;
  /** 目标 app hint（Swift resolvePid 定位；缺省 frontmost） */
  app?: string;
}

/** 文本输入选项（全可选；缺省 addon 默认 Unicode chunking） */
export interface TypeOptions {
  /** postToPid 目标 pid（缺省 Swift-side resolvePid frontmost） */
  pid?: number;
  /** 分块大小（Unicode chunking；缺省 addon 默认） */
  chunkSize?: number;
  /** 块间延迟 ms（缺省 addon 默认） */
  delayMs?: number;
  /** 目标 app hint（Swift resolvePid 定位；缺省 frontmost） */
  app?: string;
}

/** 按键选项（全可选） */
export interface PressKeyOptions {
  /** postToPid 目标 pid（缺省 Swift-side resolvePid frontmost） */
  pid?: number;
  /** 目标 app hint（Swift resolvePid 定位；缺省 frontmost） */
  app?: string;
}

/** 拖拽选项（全可选；from/to 均已换算 screen point） */
export interface DragOptions {
  /** 拖拽插值步数（缺省 addon 默认，平滑度） */
  steps?: number;
  /** postToPid 目标 pid（缺省 Swift-side resolvePid frontmost） */
  pid?: number;
  /** 目标 app hint（Swift resolvePid 定位；缺省 frontmost） */
  app?: string;
}

/** setValue 选项（全可选） */
export interface SetValueOptions {
  /** 目标进程 pid（缺省 Swift-side lastPid） */
  pid?: number;
  /** 目标 app hint（Swift resolvePid 定位；缺省 frontmost） */
  app?: string;
}

/** performSecondaryAction 选项（全可选） */
export interface SecondaryActionOptions {
  /** 目标进程 pid（缺省 Swift-side lastPid） */
  pid?: number;
  /** 目标 app hint（Swift resolvePid 定位；缺省 frontmost） */
  app?: string;
}

/**
 * get_app_state 采集预算（与 AxTreeOptions 同形；语义化别名——get_app_state 复用 AX 采集 + 单窗口截图）。
 * app 缺省 frontmost；textLimit/maxNodes/maxDepth 控 AX 树规模（防超长喂 LLM）。
 */
export type GetAppStateOptions = AxTreeOptions;

/**
 * get_app_state 结果（单窗口截图 + AX 树合一；ok=false 不抛，返 reason 供 tool 转 errorResult）。
 * screenshot = 该 app key window 的 native 截图（ComputerScreenshotResult 形，含裸 base64）；
 * axText = 行首 element_index 的渲染树（tool 作 TextBlock 喂 LLM 主体）；
 * windowBounds + scaleFactor 供 coordinate 三段式（tool 按 sessionId 缓存坐标上下文）。
 */
export interface GetAppStateResult {
  /** 是否成功；false 时其余字段缺省，reason 携带原因 */
  ok: boolean;
  /** 单窗口截图（裸 base64；tool 经 saveSnapshot 落盘 + 路径文本，不 inline 进上下文） */
  screenshot?: ComputerScreenshotResult;
  /** AX 渲染文本（行首 element_index，喂 LLM 主体） */
  axText?: string;
  /** 目标进程 pid（后续 element_index 动作复用；Swift-side 亦自缓存 lastPid） */
  pid?: number;
  /** Retina 缩放因子（coordinate 换算兜底源） */
  scaleFactor?: number;
  /** 窗口 screen point 边界（coordinate 三段式偏移源） */
  windowBounds?: WindowBounds;
  /** 失败原因（无权限 / addon 不可达 / 目标 app 未找到 / 异常） */
  reason?: string;
}
