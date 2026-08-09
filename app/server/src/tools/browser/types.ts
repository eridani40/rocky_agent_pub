/**
 * Browser 工具统一协议抽象（BrowserDriver/BrowserSession）
 * 参考: specs/tech/agent/tools/[P1]browser_tool.md §2（协议抽象·权威）
 *       specs/research/v0.0.23-browser-use.md §5.2（a11y tree + element ref 驱动模型）
 *
 * 设计：底层驱动栈分裂（Playwright CDP / chrome-devtools-mcp MCP），但抽象一层统一协议——
 * browser Tool 与上层只见 BrowserSession，各 mode 的 driver 实现此接口，底层差异封装在 driver 内部。
 *
 * mode ① headless / ② managed-profile → PlaywrightDriver
 * mode ③ attach → ChromeMcpDriver（MCP 协议）
 */

/** 浏览器会话操作 mode（与 driver 实现一一对应） */
export type BrowserMode = 'headless' | 'managed-profile' | 'attach';

/** 页面信息（listPages 返回元素） */
export interface PageInfo {
  /** 页面 id（CDP targetId / MCP page id） */
  id: string;
  /** 当前 URL */
  url: string;
  /** 是否为当前选中页（可选，仅一个为 true） */
  selected?: boolean;
}

/**
 * element ref 信息（snapshot 返回的 refs 表元素）。
 * click/type 按 ref 定位（精度高、token 省、不需 vision 二次定位）。
 */
export interface RefInfo {
  /** aria role（button/link/textbox/...） */
  role: string;
  /** accessible name */
  name: string;
  /** 同 role 同 name 时的第几个（从 0 起） */
  nth: number;
}

/** snapshot 返回值：a11y tree 文本 + ref 映射表 */
export interface SnapshotResult {
  /** a11y tree 序列化文本（给 LLM 看） */
  snapshot: string;
  /** ref id → RefInfo 映射（ref id 形如 'clickBtn' / 数字） */
  refs: Record<string, RefInfo>;
}

/**
 * 浏览器连接选项（driver.connect 入参）。
 * mode ①② 必填 executablePath（或自动发现）/ 可选 headless；
 * mode ②③ 用 profileName 定位持久目录；
 * mode ③ 用 cdpUrl 作为 fallback。
 */
export interface BrowserConnectOptions {
  /** mode ②③：profile 名（持久目录 / attach 定位） */
  profileName?: string;
  /** mode ①②（与 profile 正交）。true=无头 */
  headless?: boolean;
  /** mode ③ fallback（用户已手动 --remote-debugging-port） */
  cdpUrl?: string;
  /** mode ①② chrome 路径（覆盖自动发现） */
  executablePath?: string;
  /** mode ③ attach 非默认 profile 时透传 --userDataDir（定位 Brave/Edge 等） */
  userDataDir?: string;
}

/**
 * 浏览器驱动工厂——按 mode 产出会话。三 mode 各一个实现。
 * 调用方（browser Tool）按 input.mode pickDriver 后 connect → session → finally close。
 */
export interface BrowserDriver {
  /** 本 driver 处理的 mode */
  readonly mode: BrowserMode;
  /**
   * 启动/连接浏览器并返回会话。
   * mode ①② launch chrome（headless/持久profile）+ connectOverCdp；
   * mode ③ spawn chrome-devtools-mcp --autoConnect（Task 4）。
   * @param opts 连接选项
   * @param signal 取消信号（透传到底层 launch/连接）
   */
  connect(opts: BrowserConnectOptions, signal?: AbortSignal): Promise<BrowserSession>;
  /**
   * 一次性执行（绕开 Bun 不支持 playwright connectOverCDP 的 bug）。
   *
   * mode ①② headless/managed-profile 走此路径：在 node 子进程内
   * spawn chrome + connectOverCDP + 执行单个 action + cleanup chrome，
   * 避免在 Bun 主进程内调 playwright.connectOverCDP（永久 hang）。
   *
   * 与 connect 的区别：connect 返回长生命周期 BrowserSession（attach 复用），
   * executeOnce 单次执行即销毁，无跨调用状态（refs 不跨 action，pre-existing 限制）。
   *
   * @param opts 连接选项（profileName/headless/executablePath/userDataDir）
   * @param action navigate/snapshot/click/type/evaluate/listPages/selectPage/screenshot
   * @param params action 参数（url/ref/text/format）
   * @param signal 取消信号（abort 时 kill worker 进程组，防 hang）
   * @returns 单行结果：{ok:true,text} 或 {ok:false,error:{kind,message}}
   */
  executeOnce?(
    opts: BrowserConnectOptions,
    action: string,
    params: BrowserActionParams,
    signal?: AbortSignal,
  ): Promise<BrowserExecuteResult>;
}

/**
 * executeOnce 的 action 参数（一次性执行的入参子集，不含 mode/profileName）。
 * 各 action 用到的字段：navigate→url / click+type+selectPage→ref / type+evaluate→text / snapshot→format。
 */
export interface BrowserActionParams {
  /** navigate 目标 URL */
  url?: string;
  /** click/type/selectPage 的 ref（来自 snapshot） */
  ref?: string;
  /** type 待输入文本 / evaluate 待执行 JS */
  text?: string;
  /** snapshot 输出格式 'aria' | 'ai' */
  format?: 'aria' | 'ai';
}

/**
 * executeOnce 一次性结果（worker stdout 单行 JSON 反序列化）。
 * ok=true 时 text 为 action 结果文本（navigate→提示 / snapshot→JSON / screenshot→base64 / evaluate→JSON.stringify）。
 * ok=false 时 error 携带 kind（BrowserErrorKind）+ message。
 */
export interface BrowserExecuteResult {
  ok: boolean;
  text?: string;
  error?: { kind?: string; message: string };
  /** launch 确认帧携带的 chrome 进程 pid（v0.0.272 孤儿对账锚点；旧 worker 无此字段=undefined） */
  chromePid?: number;
}

/**
 * 统一会话协议——所有 mode 实现同一组操作。
 * 底层（Playwright page / MCP tool）封装在实现内。
 */
export interface BrowserSession {
  /** 列举当前打开的页面 */
  listPages(): Promise<PageInfo[]>;
  /** 选中指定页面（后续 navigate/click/type 在该页执行） */
  selectPage(pageId: string): Promise<void>;
  /** 当前页导航到 url */
  navigate(url: string): Promise<void>;
  /**
   * 拍快照（a11y tree + element ref，统一驱动模型）。
   * @param opts.format 'aria'（默认，文本树）/ 'ai'（紧凑 ai 格式）
   */
  snapshot(opts?: { format?: 'aria' | 'ai' }): Promise<SnapshotResult>;
  /** 点击 ref 对应元素（ref 来自 snapshot.refs） */
  click(ref: string): Promise<void>;
  /** 在 ref 对应输入元素中输入文本 */
  type(ref: string, text: string): Promise<void>;
  /** 在当前页执行 JS（受 driver 限制；attach 模式可能被禁） */
  evaluate(script: string): Promise<unknown>;
  /** 截图（辅助：vision 校验/给 LLM 看长相，非主交互通道） */
  screenshot?(): Promise<{ mime: string; data: Buffer }>;
  /**
   * 关闭会话。语义按 mode 分化（封装在实现内，调用方不感知）：
   *   mode ①② 杀 chrome 进程（自启的）；
   *   mode ③ 只清 emulation 不杀用户浏览器。
   */
  close(): Promise<void>;
}

/**
 * 浏览器连接失败错误（driver 实现抛出，调用方 catch 后转 ToolResult isError）。
 * 带 kind 便于上层归类（profile 占用 / chrome 未找到 / CDP 超时 / SSRF / ...）。
 */
export type BrowserErrorKind =
  | 'chrome_not_found'
  | 'cdp_timeout'
  | 'profile_in_use'
  | 'port_exhausted'
  | 'ssrf_blocked'
  | 'launch_failed'
  | 'attach_failed'
  | 'unknown';

export class BrowserError extends Error {
  readonly kind: BrowserErrorKind;
  constructor(kind: BrowserErrorKind, message: string) {
    super(message);
    this.name = 'BrowserError';
    this.kind = kind;
  }
}

// ============================================================
// [v0.0.264] Browser Instance Manager 类型（常驻实例 + 持久 worker）
// [v0.0.266] attach 纳入：mode 扩展 'attach'，worker-based 字段可选 + session/cdpUrl 承载
// [v0.0.266 T3] BrowserInstance 迁 mode-impl.ts（BrowserHandle + impl 私有扩展）
// ============================================================

/**
 * 常驻 worker 协议（stdin 每行任务 / stdout 每行响应，requestId 路由）。
 * 单 worker 单任务串行：pending 一次一个（对齐 executeOnce 串行语义）。
 */
export interface PersistentWorker {
  child: import('node:child_process').ChildProcess;
  nextReqId: number;
  pending: Map<number, { resolve: (r: BrowserExecuteResult) => void; reject: (e: Error) => void }>;
  /** 发任务 → 等对应 requestId 响应；worker exit → reject 全部 pending */
  send(action: string, params: BrowserActionParams): Promise<BrowserExecuteResult>;
}

/** worker 内跨 action 会话状态（snapshot 的 ref 供后续 click/type 用） */
export interface WorkerSessionState {
  lastRefs: Record<string, RefInfo>;
}

/** browser-instances.json 记录条目（开机自检/残留清理数据锚点；不存运行时 worker/state） */
export interface PersistedInstanceRecord {
  key: string;
  mode: 'headless' | 'managed-profile';
  profileName?: string;
  userDataDir: string;
  cdpPort: number;
  workerPid: number;
  /** chrome 进程 pid（v0.0.272 起 launch 确认帧上报；旧记录无此字段=undefined，孤儿判定走 ppid 兼容） */
  chromePid?: number;
  createdAt: number;
}

/** launch/execute/close 的实例选择参数（对齐 tool.ts toConnectOpts 语义） */
export interface BrowserLaunchOptions {
  mode: 'headless' | 'managed-profile' | 'attach';
  /** 仅 managed-profile 有意义 */
  profileName?: string;
  /** attach 连接端点（缺省 → DEFAULT_ATTACH_CDP_URL driver 内部兜底）；仅 attach 有意义 */
  cdpUrl?: string;
  executablePath?: string;
}
