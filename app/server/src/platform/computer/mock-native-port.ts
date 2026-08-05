/**
 * MockComputerNativePort —— AT/UT 注入的假 native port（零子进程 / 零 GUI）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2.md §5 P0-C/P0-F
 *       memory test-no-real-spawn-system-gui（测试绝不 spawn 系统进程 / 弹 GUI）
 *
 * 设计（守 test-no-real-spawn-system-gui）：**每次调用 fresh 读** fixture 文件
 *   `<DATA_DIR>/computer-mock.json`（非构造缓存——多 case 共享 booted env 写不同 fixture 时，
 *   缓存会定死先 boot 的那个）；缺失/损坏 → 合理默认（开箱可用）；返回值确定性、零 OS 依赖。
 *
 * ── computer-mock.json fixture 契约（AT case 写；全字段可选，缺则合理默认，mock 开箱可用）──
 *   {
 *     // 权限
 *     "permissions": { "accessibility": "granted"|"missing", "screenRecording": "granted"|"missing" },
 *     // screenshot action（native 单窗口）；windowBounds 供 coordinate 三段式；缺 → 默认 1×1PNG+scaleFactor:2
 *     "screenshotBase64": "<裸 base64，无 data: 前缀>", "mediaType": "image/png"|"image/jpeg",
 *     "width": <int>, "height": <int>,
 *     "screenshotScaleFactor": <number>, "screenshotWindowBounds": { "x":0, "y":0, "w":0, "h":0 },
 *     // get_app_state action（图+树合一）；缺 → 默认小树 + 1×1PNG + scaleFactor:2 + windowBounds
 *     "appState": {
 *       "ok": <bool，缺省 true；置 false 测 tool !ok errorResult 分支>,
 *       "screenshot": { "data": "<裸 base64>", "mediaType": "image/png", "width": <int>, "height": <int>,
 *                       "windowBounds": {"x":0,"y":0,"w":0,"h":0} },
 *       "axText": "[0] AXButton \"OK\" Secondary Actions: Raise\n[1] ...",
 *       "pid": <int>, "scaleFactor": <number>, "windowBounds": {"x":0,"y":0,"w":0,"h":0}, "reason"?
 *     },
 *     // read_ax_tree action；缺 → 默认小树(2 node)+scaleFactor:2+pid:1234
 *     "axTree": {
 *       "ok": <bool，缺省 true；置 false 测 tool !ok errorResult 分支>,
 *       "text": "<行首 element_index 的渲染文本>",
 *       "nodes": [ { "index": <int>, "role": "<AXRole>", "title"?, "value"?, "frame"?:{x,y,w,h}, "children"? } ],
 *       "pid": <int>, "scaleFactor": <number>, "reason"?
 *     },
 *     // list_apps action；缺 → 默认 1 app（Safari）
 *     "apps": [ { "bundleId": "com.apple.Safari", "name": "Safari", "pid": 501, "isRunning": true } ],
 *     // 动作结果（7 键：click/type/scroll/pressKey/drag/setValue/performSecondaryAction）；
 *     // 每键形状 { "ok": <bool，缺省 true>, "reason"?: "<ok:false 时原因>" }；缺键 → {ok:true}
 *     "actionResults": { "click": { "ok": true }, "drag": { "ok": false, "reason": "..." }, ... }
 *   }
 *   注：mock 不真操作 OS，忽略 target/opts；action 成败纯由 fixture.actionResults 驱动（确定性）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  coercePermissions,
  type AppInfo,
  type AxTreeNode,
  type AxTreeResult,
  type ClickOptions,
  type ComputerActionResult,
  type ComputerNativePort,
  type ComputerPermissions,
  type ComputerScreenshotResult,
  type ComputerTarget,
  type DragOptions,
  type GetAppStateResult,
  type PixelPoint,
  type PressKeyOptions,
  type ScrollOptions,
  type SecondaryActionOptions,
  type SetValueOptions,
  type TypeOptions,
  type WindowBounds,
} from './native-port';

/** 1×1 透明 PNG 裸 base64（默认截图；fixture 缺 screenshotBase64 时兜底） */
const DEFAULT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** 默认 AX 树渲染文本（fixture 缺 axTree.text 时兜底；行首 element_index） */
const DEFAULT_AX_TREE_TEXT = '[0] AXButton "OK"\n[1] AXTextField value=""';

/** 默认 AX 节点（fixture 缺 axTree.nodes 时兜底；与 DEFAULT_AX_TREE_TEXT 对应） */
const DEFAULT_AX_NODES: AxTreeNode[] = [
  { index: 0, role: 'AXButton', title: 'OK' },
  { index: 1, role: 'AXTextField', value: '' },
];

/** 默认窗口边界（fixture 缺 windowBounds 时兜底；全屏 origin=0 语义） */
const DEFAULT_WINDOW_BOUNDS: WindowBounds = { x: 0, y: 0, w: 1, h: 1 };

/** 默认 get_app_state AX 文本（含 Secondary Actions 行，供 LLM 知可用 secondary action） */
const DEFAULT_APP_STATE_AX_TEXT =
  '[0] AXButton "OK" Secondary Actions: Raise\n[1] AXTextField value=""';

/** 默认 list_apps 结果（fixture 缺 apps 时兜底） */
const DEFAULT_APPS: AppInfo[] = [
  { bundleId: 'com.apple.Safari', name: 'Safari', pid: 501, isRunning: true },
];

/** 动作结果 fixture 项（ok 缺省 true；置 false 测 tool !ok 分支） */
interface MockActionResultFixture {
  ok?: boolean;
  reason?: string;
}

/** 动作 fixture 键集合（click/type/scroll/pressKey/drag/setValue/performSecondaryAction） */
type MockActionName =
  | 'click'
  | 'type'
  | 'scroll'
  | 'pressKey'
  | 'drag'
  | 'setValue'
  | 'performSecondaryAction';

/** computer-mock.json fixture 结构（全可选，缺则用默认） */
export interface ComputerMockFixture {
  permissions?: { accessibility?: string; screenRecording?: string };
  /** screenshot action（native 单窗口）；windowBounds 供 coordinate 三段式 */
  screenshotBase64?: string;
  mediaType?: 'image/png' | 'image/jpeg';
  width?: number;
  height?: number;
  screenshotScaleFactor?: number;
  screenshotWindowBounds?: WindowBounds;
  /** get_app_state 结果（图+树合一）；缺 → 默认小树 + 1×1PNG + scaleFactor:2 + windowBounds */
  appState?: {
    ok?: boolean;
    screenshot?: {
      data?: string;
      mediaType?: 'image/png' | 'image/jpeg';
      width?: number;
      height?: number;
      windowBounds?: WindowBounds;
    };
    axText?: string;
    pid?: number;
    scaleFactor?: number;
    windowBounds?: WindowBounds;
    reason?: string;
  };
  /** AX 树读取结果（read_ax_tree action）；缺 → 默认小树 */
  axTree?: {
    ok?: boolean;
    text?: string;
    nodes?: AxTreeNode[];
    pid?: number;
    scaleFactor?: number;
    reason?: string;
  };
  /** 运行中 app 列表（list_apps action）；缺 → 默认 1 app */
  apps?: AppInfo[];
  /** 动作结果（click/type/scroll/pressKey/drag/setValue/performSecondaryAction action）；每项缺 → {ok:true} */
  actionResults?: Partial<Record<MockActionName, MockActionResultFixture>>;
}

/** fixture 加载器（每次 fresh 读文件；缺失/解析失败 → 空 fixture 走默认） */
export type FixtureLoader = () => ComputerMockFixture;

/** 默认 loader：读 <dataDir>/computer-mock.json（call-time fresh read，支持 case 中途改 fixture） */
export function fileFixtureLoader(dataDir: string): FixtureLoader {
  const path = join(dataDir, 'computer-mock.json');
  return () => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as ComputerMockFixture;
    } catch {
      return {}; // 文件缺失/损坏 → 默认 fixture
    }
  };
}

/**
 * MockComputerNativePort —— 实现 ComputerNativePort，每调用 fresh 读 fixture。
 */
export class MockComputerNativePort implements ComputerNativePort {
  constructor(private readonly load: FixtureLoader) {}

  /** call-time 读 fixture；无 permissions → 默认两 granted（开箱可用），否则归一化两态 */
  async checkPermissions(): Promise<ComputerPermissions> {
    const f = this.load();
    if (!f.permissions) return { accessibility: 'granted', screenRecording: 'granted' };
    return coercePermissions(f.permissions);
  }

  /** call-time 读 fixture；返 fixture 的 base64（缺 → 默认 1×1 PNG）+ windowBounds/scaleFactor，恒 ok（截图能力可用） */
  async screenshot(): Promise<ComputerScreenshotResult> {
    const f = this.load();
    const data = typeof f.screenshotBase64 === 'string' && f.screenshotBase64.length > 0
      ? f.screenshotBase64
      : DEFAULT_PNG_BASE64;
    return {
      ok: true,
      mediaType: f.mediaType ?? 'image/png',
      data,
      width: f.width ?? 1,
      height: f.height ?? 1,
      scaleFactor: f.screenshotScaleFactor ?? 2,
      windowBounds: f.screenshotWindowBounds ?? DEFAULT_WINDOW_BOUNDS,
    };
  }

  /** call-time 读 fixture.appState；缺 → 默认小树 + 1×1PNG + scaleFactor:2 + windowBounds；ok===false → {ok:false,reason} */
  async getAppState(): Promise<GetAppStateResult> {
    const s = this.load().appState;
    if (s && s.ok === false) {
      return { ok: false, reason: s.reason ?? 'mock getAppState failed' };
    }
    const shotBounds = s?.screenshot?.windowBounds ?? s?.windowBounds ?? DEFAULT_WINDOW_BOUNDS;
    return {
      ok: true,
      screenshot: {
        ok: true,
        data: s?.screenshot?.data ?? DEFAULT_PNG_BASE64,
        mediaType: s?.screenshot?.mediaType ?? 'image/png',
        width: s?.screenshot?.width ?? 1,
        height: s?.screenshot?.height ?? 1,
        windowBounds: shotBounds,
      },
      axText: s?.axText ?? DEFAULT_APP_STATE_AX_TEXT,
      pid: s?.pid ?? 1234,
      scaleFactor: s?.scaleFactor ?? 2,
      windowBounds: s?.windowBounds ?? DEFAULT_WINDOW_BOUNDS,
    };
  }

  /** call-time 读 fixture.axTree；缺 → 默认小树+scaleFactor:2；axTree.ok===false → {ok:false,reason} */
  async readAxTree(): Promise<AxTreeResult> {
    const ax = this.load().axTree;
    if (ax && ax.ok === false) {
      return { ok: false, reason: ax.reason ?? 'mock readAxTree failed' };
    }
    return {
      ok: true,
      text: ax?.text ?? DEFAULT_AX_TREE_TEXT,
      nodes: ax?.nodes ?? DEFAULT_AX_NODES,
      pid: ax?.pid ?? 1234,
      scaleFactor: ax?.scaleFactor ?? 2,
    };
  }

  /** call-time 读 fixture.apps；缺 → 默认 1 app（Safari） */
  async listApps(): Promise<AppInfo[]> {
    return this.load().apps ?? DEFAULT_APPS;
  }

  /** mock 不真操作 OS，忽略 target/opts；成败由 fixture.actionResults.click 驱动（缺 → {ok:true}） */
  async click(_target: ComputerTarget, _opts?: ClickOptions): Promise<ComputerActionResult> {
    return this.actionResult('click');
  }

  /** mock 忽略 text/opts；成败由 fixture.actionResults.type 驱动（缺 → {ok:true}） */
  async type(_text: string, _opts?: TypeOptions): Promise<ComputerActionResult> {
    return this.actionResult('type');
  }

  /** mock 忽略 target/opts；成败由 fixture.actionResults.scroll 驱动（缺 → {ok:true}） */
  async scroll(_target: ComputerTarget, _opts: ScrollOptions): Promise<ComputerActionResult> {
    return this.actionResult('scroll');
  }

  /** mock 忽略 keySpec/opts；成败由 fixture.actionResults.pressKey 驱动（缺 → {ok:true}） */
  async pressKey(_keySpec: string, _opts?: PressKeyOptions): Promise<ComputerActionResult> {
    return this.actionResult('pressKey');
  }

  /** mock 忽略 from/to/opts；成败由 fixture.actionResults.drag 驱动（缺 → {ok:true}） */
  async drag(_from: PixelPoint, _to: PixelPoint, _opts?: DragOptions): Promise<ComputerActionResult> {
    return this.actionResult('drag');
  }

  /** mock 忽略 elementIndex/value/opts；成败由 fixture.actionResults.setValue 驱动（缺 → {ok:true}） */
  async setValue(_elementIndex: number, _value: string, _opts?: SetValueOptions): Promise<ComputerActionResult> {
    return this.actionResult('setValue');
  }

  /** mock 忽略 elementIndex/action/opts；成败由 fixture.actionResults.performSecondaryAction 驱动（缺 → {ok:true}） */
  async performSecondaryAction(
    _elementIndex: number,
    _action: string,
    _opts?: SecondaryActionOptions,
  ): Promise<ComputerActionResult> {
    return this.actionResult('performSecondaryAction');
  }

  /** call-time 读 fixture.actionResults[name]；缺 → {ok:true}；ok===false → {ok:false,reason} */
  private actionResult(name: MockActionName): ComputerActionResult {
    const r = this.load().actionResults?.[name];
    if (!r) return { ok: true };
    if (r.ok === false) return { ok: false, reason: r.reason ?? `mock ${name} failed` };
    return { ok: true };
  }
}

/**
 * 解析 mock native port（bootstrap precedence 最高优先级）。
 * `ROCKY_TEST_COMPUTER_NATIVE_PORT==='mock'` → 建读 `<dataDir>/computer-mock.json` 的 mock port。
 *
 * @param env   进程环境（读 ROCKY_TEST_COMPUTER_NATIVE_PORT 开关 + DATA_DIR 兜底）
 * @param dataDir server 权威 dataDir（bootstrap 传入；缺则回退 env.DATA_DIR）
 * @returns mock port（开关命中）或 undefined（未命中 → precedence 下探 loopback/registry）
 */
export function resolveMockComputerNativePort(
  env: NodeJS.ProcessEnv,
  dataDir?: string,
): ComputerNativePort | undefined {
  if (env.ROCKY_TEST_COMPUTER_NATIVE_PORT !== 'mock') return undefined;
  const root = dataDir ?? env.DATA_DIR ?? process.cwd();
  return new MockComputerNativePort(fileFixtureLoader(root));
}
