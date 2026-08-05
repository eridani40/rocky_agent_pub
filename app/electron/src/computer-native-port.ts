/**
 * computer-native-port —— Rocky Electron 主进程的 ComputerNativePort 实现（走 native addon）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §P1-C
 *       app/computer-native/swift/.../Service.swift（各 method 参数 dict 契约）
 *       app/electron/src/computer-permissions-ipc.ts（复用 computeGetPermissions 查权限）
 *
 * 铁律（§B2.0）：macOS 原生能力必须在 Rocky Electron 主进程内（com.rocky.agent = TCC 权限主体）。
 *   本文件是主进程侧 port 实现：11 能力中读/动作类全走 native addon（ScreenCaptureKit + AX + postToPid），
 *   checkPermissions 走 electron systemPreferences（addon 不管权限查询）。
 *   packaged：main.ts 注入本 port 给 @app/server（setComputerNativePort）→ 全闭环。
 *   dev：computer-loopback-server 内部复用本 port（单一 native 逻辑源，dev/packaged 同源）。
 *
 * 截图源（§决策A）：screenshot/getAppState 走 native ScreenCaptureKit 单窗口截图（addon.invoke），
 *   不再用 Electron desktopCapturer 全屏——单一 window-relative 坐标模型不容两套截图坐标空间。
 *
 * addon 调用契约：port 各方法把位置参数拼成单 JSON 对象（named 字段）→ callNative(addon,method,dict)
 *   → 解包信封 {ok,result?|error?} → map 到 TS 结果类型。addon 缺失 → fail-closed（{ok:false}/空数组）。
 *
 * 可测性：makeElectronComputerNativePort 接受 overrides（注入 fake systemPreferences + fake addon），
 *   UT 无需 electron runtime / 无需触真原生动作（守 memory test-no-real-spawn-system-gui）。
 */
import { computeGetPermissions, type SystemPreferencesLike } from './computer-permissions-ipc';
import {
  callNative,
  loadComputerAddon,
  type AddonLike,
} from './computer-native-addon';
import type {
  ElectronComputerNativePort,
  NativePortActionOptions,
  NativePortActionResult,
  NativePortAppInfo,
  NativePortAxTreeOptions,
  NativePortAxTreeResult,
  NativePortClickOptions,
  NativePortDragOptions,
  NativePortGetAppStateResult,
  NativePortKeyOptions,
  NativePortPixelPoint,
  NativePortScreenshotOptions,
  NativePortScreenshotResult,
  NativePortScrollOptions,
  NativePortTarget,
  NativePortTypeOptions,
  NativePortWindowBounds,
} from './computer-native-types';

// 结构化镜像类型透传导出（loopback-server / main.ts 从本文件 import，保持既有 import 面稳定）
export type { ElectronComputerNativePort } from './computer-native-types';

/** makeElectronComputerNativePort 依赖注入（缺省 lazy require('electron') + loadComputerAddon） */
export interface ElectronNativePortDeps {
  /** 权限查询（缺省 require('electron').systemPreferences）；UT 注入 fake */
  systemPreferences?: SystemPreferencesLike;
  /** native addon 加载器（缺省 loadComputerAddon）；UT 注入 fake（返 fakeAddon / undefined 测缺失分支） */
  loadAddon?: () => AddonLike | undefined;
}

/** 未加载标记（区分「addon=undefined 已加载但不可用」与「尚未尝试加载」） */
const UNLOADED = Symbol('addon-unloaded');

/**
 * 构造主进程 ComputerNativePort 实现（11 能力）。
 *   - checkPermissions：computeGetPermissions（electron systemPreferences）→ 两态门禁形状
 *   - 其余 10 方法：拼 native params dict → callNative(addon,method,dict) → map 结果
 *
 * addon 单实例 lazy 缓存在闭包（首个 native 方法调用时加载，之后复用）。
 *
 * @param deps 注入依赖（UT 传 fake systemPreferences + loadAddon）；缺省生产路径
 */
export function makeElectronComputerNativePort(
  deps?: ElectronNativePortDeps,
): ElectronComputerNativePort {
  // systemPreferences：lazy require（仅真 Electron 运行时加载；UT 注入免 electron runtime）
  const getSysPref = (): SystemPreferencesLike =>
    deps?.systemPreferences ??
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('electron') as { systemPreferences: SystemPreferencesLike }).systemPreferences;

  // addon：lazy 加载 + 闭包缓存（UNLOADED 前哨区分未加载 vs 加载失败 undefined）
  const load = deps?.loadAddon ?? loadComputerAddon;
  let addonCache: AddonLike | undefined | typeof UNLOADED = UNLOADED;
  const getAddon = (): AddonLike | undefined => {
    if (addonCache === UNLOADED) addonCache = load();
    return addonCache;
  };

  return {
    async checkPermissions() {
      const p = computeGetPermissions(process.platform, getSysPref());
      // UI spike 形状（accessibility:bool / screenRecording:多态）→ tool 门禁两态（fail-closed）
      return {
        accessibility: p.accessibility ? 'granted' : 'missing',
        screenRecording: p.screenRecording === 'granted' ? 'granted' : 'missing',
      };
    },

    async screenshot(opts?: NativePortScreenshotOptions): Promise<NativePortScreenshotResult> {
      const r = await callNative(getAddon(), 'screenshot', { app: opts?.app });
      if (!r.ok) return { ok: false, reason: r.reason };
      return mapScreenshot(r.result);
    },

    async getAppState(opts?: NativePortAxTreeOptions): Promise<NativePortGetAppStateResult> {
      const r = await callNative(getAddon(), 'getAppState', axParams(opts));
      if (!r.ok) return { ok: false, reason: r.reason };
      const d = asRecord(r.result);
      return {
        ok: true,
        screenshot: d.screenshot ? mapScreenshot(d.screenshot) : undefined,
        axText: d.axText as string | undefined,
        pid: d.pid as number | undefined,
        scaleFactor: d.scaleFactor as number | undefined,
        windowBounds: d.windowBounds as NativePortWindowBounds | undefined,
      };
    },

    async readAxTree(opts?: NativePortAxTreeOptions): Promise<NativePortAxTreeResult> {
      const r = await callNative(getAddon(), 'readAxTree', axParams(opts));
      if (!r.ok) return { ok: false, reason: r.reason };
      const d = asRecord(r.result);
      return {
        ok: true,
        text: d.text as string | undefined,
        nodes: Array.isArray(d.nodes) ? (d.nodes as unknown[]) : undefined,
        pid: d.pid as number | undefined,
        scaleFactor: d.scaleFactor as number | undefined,
      };
    },

    async listApps(): Promise<NativePortAppInfo[]> {
      const r = await callNative(getAddon(), 'listApps', {});
      if (!r.ok) return [];
      return Array.isArray(r.result) ? (r.result as NativePortAppInfo[]) : [];
    },

    async click(target: NativePortTarget, opts?: NativePortClickOptions): Promise<NativePortActionResult> {
      return runAction(getAddon(), 'click', {
        target,
        button: opts?.button,
        clickCount: opts?.clickCount,
        pid: opts?.pid,
        app: opts?.app,
      });
    },

    async type(text: string, opts?: NativePortTypeOptions): Promise<NativePortActionResult> {
      return runAction(getAddon(), 'type', {
        text,
        chunkSize: opts?.chunkSize,
        delayMs: opts?.delayMs,
        pid: opts?.pid,
        app: opts?.app,
      });
    },

    async scroll(target: NativePortTarget, opts?: NativePortScrollOptions): Promise<NativePortActionResult> {
      return runAction(getAddon(), 'scroll', {
        target,
        direction: opts?.direction,
        pages: opts?.pages,
        pid: opts?.pid,
        app: opts?.app,
      });
    },

    async pressKey(keySpec: string, opts?: NativePortKeyOptions): Promise<NativePortActionResult> {
      return runAction(getAddon(), 'pressKey', { key: keySpec, pid: opts?.pid, app: opts?.app });
    },

    async drag(
      from: NativePortPixelPoint,
      to: NativePortPixelPoint,
      opts?: NativePortDragOptions,
    ): Promise<NativePortActionResult> {
      return runAction(getAddon(), 'drag', {
        from,
        to,
        steps: opts?.steps,
        pid: opts?.pid,
        app: opts?.app,
      });
    },

    async setValue(
      elementIndex: number,
      value: string,
      opts?: NativePortActionOptions,
    ): Promise<NativePortActionResult> {
      return runAction(getAddon(), 'setValue', { elementIndex, value, pid: opts?.pid, app: opts?.app });
    },

    async performSecondaryAction(
      elementIndex: number,
      action: string,
      opts?: NativePortActionOptions,
    ): Promise<NativePortActionResult> {
      return runAction(getAddon(), 'performSecondaryAction', {
        elementIndex,
        action,
        pid: opts?.pid,
        app: opts?.app,
      });
    },
  };
}

// —— 内部 helper ——

/** 动作类统一：callNative → 成功 {ok:true} / 失败 {ok:false,reason,code?}（对齐 ComputerActionResult 范式） */
async function runAction(
  addon: AddonLike | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<NativePortActionResult> {
  const r = await callNative(addon, method, params);
  if (r.ok) return { ok: true };
  return r.code ? { ok: false, reason: r.reason, code: r.code } : { ok: false, reason: r.reason };
}

/** native 截图 dict → NativePortScreenshotResult（字段名已对齐；补 ok + mediaType 缺省） */
function mapScreenshot(result: unknown): NativePortScreenshotResult {
  const d = asRecord(result);
  return {
    ok: true,
    mediaType: (d.mediaType as 'image/png' | 'image/jpeg') ?? 'image/png',
    data: d.data as string | undefined,
    width: d.width as number | undefined,
    height: d.height as number | undefined,
    scaleFactor: d.scaleFactor as number | undefined,
    windowBounds: d.windowBounds as NativePortWindowBounds | undefined,
  };
}

/**
 * AX 采集预算 opts → native params dict（undefined 值 JSON.stringify 时自动剔除）。
 * v0.0.160：`textLimit` 支持 `number | 'max'`；字符串 `'max'` 原样透传，Swift 侧 `SnapshotTextLimit.parse` 识别。
 */
function axParams(opts?: NativePortAxTreeOptions): Record<string, unknown> {
  return {
    app: opts?.app,
    textLimit: opts?.textLimit,
    maxNodes: opts?.maxNodes,
    maxDepth: opts?.maxDepth,
  };
}

/** unknown → Record（非对象兜底空对象，安全取字段） */
function asRecord(v: unknown): Record<string, unknown> {
  return (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
}
