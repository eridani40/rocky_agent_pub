/**
 * computer-permissions-ipc — 主进程原生权限 / 截图 IPC（v0.0.105 架构验证 spike）
 * 参考: reqs/[working] v0.0.105.computer_use/design.md §5（权限双重防线）
 *       specs/ui/components/connector-page/section-computer-connector.md（前端契约）
 *
 * 架构 pivot（今天真机 dogfood 结论）：权限主体必须是 Rocky Electron 本体。
 *   - 裸 spawn 子进程二进制拿不到 macOS TCC 权限（TCC 按进程签名身份判定，不继承宿主授权）。
 *   - 故原生能力（desktopCapturer / systemPreferences）必须在 Electron 主进程内调用，
 *     共享 Rocky 的 TCC 身份。**绝不 spawn helper 二进制。**
 *
 * 可测性设计（对齐 backend-bootstrap.ts）：本文件顶层**不 import electron**——纯计算函数
 *   接收注入的结构化依赖（SystemPreferencesLike / DesktopCapturerLike / ShellLike），
 *   UT 无需 Electron runtime 即可覆盖非 macOS 降级分支与返回形状。electron 值（ipcMain/
 *   systemPreferences/desktopCapturer/shell）只在 register / self-check 函数体内 require，
 *   仅在真 Electron 主进程运行时加载。
 */

/** 屏幕录制权限态（systemPreferences.getMediaAccessStatus('screen') 值域 + unknown 兜底） */
export type ScreenRecordingStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown';

/** 权限查询结果（getPermissions 返回） */
export interface ComputerPermissions {
  /** 运行平台（process.platform） */
  platform: string;
  /** 是否支持原生权限能力（仅 macOS true；其余平台优雅降级） */
  supported: boolean;
  /** 辅助功能（Accessibility）是否已授权（键鼠 + AX 树所需） */
  accessibility: boolean;
  /** 屏幕录制（Screen Recording）授权态（截图所需） */
  screenRecording: ScreenRecordingStatus;
}

/** 测试截图结果 */
export interface ScreenshotResult {
  ok: boolean;
  /** 成功：thumbnail 转 dataURL（data:image/png;base64,...） */
  dataUrl?: string;
  width?: number;
  height?: number;
  /** 失败原因（无权限 / 无 source / 非 macOS / 异常） */
  reason?: string;
}

/** 打开系统设置结果 */
export interface OpenSettingsResult {
  ok: boolean;
  reason?: string;
}

// —— 结构化依赖接口（只声明本模块用到的最小 API 面，避免硬依赖 electron 类型）——

/** systemPreferences 最小面（macOS 权限查询/引导） */
export interface SystemPreferencesLike {
  isTrustedAccessibilityClient(prompt: boolean): boolean;
  getMediaAccessStatus(mediaType: 'screen' | 'camera' | 'microphone'): string;
}

/** NativeImage 最小面（desktopCapturer thumbnail） */
export interface NativeImageLike {
  toDataURL(): string;
  getSize(): { width: number; height: number };
  isEmpty(): boolean;
}

/** desktopCapturer 最小面（主进程截图） */
export interface DesktopCapturerLike {
  getSources(options: {
    types: string[];
    thumbnailSize?: { width: number; height: number };
  }): Promise<Array<{ name: string; thumbnail: NativeImageLike }>>;
}

/** shell 最小面（openExternal 深链系统设置） */
export interface ShellLike {
  openExternal(url: string): Promise<void>;
}

/** 屏幕录制系统设置深链（屏幕录制不能程序弹窗，只能引导用户去开） */
const SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

// —— 纯计算函数（注入依赖，可 UT）——

/**
 * 查询当前权限态。非 macOS 优雅降级（supported=false + 都不可用），不崩。
 * macOS：isTrustedAccessibilityClient(false) 只查不弹；getMediaAccessStatus('screen') 查屏幕录制。
 */
export function computeGetPermissions(
  platform: string,
  sys: SystemPreferencesLike,
): ComputerPermissions {
  if (platform !== 'darwin') {
    return { platform, supported: false, accessibility: false, screenRecording: 'unknown' };
  }
  const accessibility = sys.isTrustedAccessibilityClient(false);
  const screenRecording = normalizeScreenStatus(sys.getMediaAccessStatus('screen'));
  return { platform, supported: true, accessibility, screenRecording };
}

/** 把 getMediaAccessStatus('screen') 原始字符串收敛到已知枚举（未知值 → 'unknown'） */
function normalizeScreenStatus(raw: string): ScreenRecordingStatus {
  switch (raw) {
    case 'granted':
    case 'denied':
    case 'restricted':
    case 'not-determined':
      return raw;
    default:
      return 'unknown';
  }
}

/**
 * 请求辅助功能授权（isTrustedAccessibilityClient(true) 会弹系统授权引导窗）。
 * 返回当前信任态（用户尚未在系统设置勾选前通常仍为 false，需引导后回来重检）。
 * 非 macOS 返回 false（无此概念）。
 */
export function computeRequestAccessibility(
  platform: string,
  sys: SystemPreferencesLike,
): boolean {
  if (platform !== 'darwin') return false;
  return sys.isTrustedAccessibilityClient(true);
}

/**
 * 打开系统设置的屏幕录制页（深链）。屏幕录制权限 askForMediaAccess 不支持 'screen'，
 * 只能引导用户手动去系统设置开启。非 macOS 返回 ok=false。
 */
export async function computeOpenScreenRecordingSettings(
  platform: string,
  shell: ShellLike,
): Promise<OpenSettingsResult> {
  if (platform !== 'darwin') {
    return { ok: false, reason: 'not-macos' };
  }
  try {
    await shell.openExternal(SCREEN_RECORDING_SETTINGS_URL);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
}

/**
 * 用 desktopCapturer 真截一张屏（主进程调用，共享 Rocky TCC 身份）。
 * 取第一个 screen source 的 thumbnail（NativeImage）转 dataURL 返回。
 * 无权限 / 无 source / 空图 / 异常 → ok=false + reason（不抛）。
 *
 * 注意（macOS 现象）：屏幕录制权限首次授权后，getSources 可能仍返回空/黑图，
 *   需重启 app 才生效（屏幕录制权限进程内缓存）——由调用方/用户感知，本函数如实返回。
 *
 * @param thumbnailSize 缩略图尺寸（缺省 640×400 = UI「测试截图」用的小图）。
 *   agent 截图（computer-native-port）传显示器实际像素尺寸取全分辨率，否则 LLM 看不清屏幕。
 */
export async function computeTestScreenshot(
  platform: string,
  capturer: DesktopCapturerLike,
  thumbnailSize: { width: number; height: number } = { width: 640, height: 400 },
): Promise<ScreenshotResult> {
  if (platform !== 'darwin') {
    return { ok: false, reason: 'not-macos' };
  }
  try {
    const sources = await capturer.getSources({
      types: ['screen'],
      thumbnailSize,
    });
    const first = sources && sources[0];
    if (!first) {
      return { ok: false, reason: 'no-screen-source（无屏幕源，通常=缺屏幕录制权限或需重启 app）' };
    }
    const thumb = first.thumbnail;
    if (thumb.isEmpty()) {
      return { ok: false, reason: 'empty-thumbnail（缩略图为空，通常=缺屏幕录制权限或需重启 app 生效）' };
    }
    const { width, height } = thumb.getSize();
    return { ok: true, dataUrl: thumb.toDataURL(), width, height };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
}

/** 从 unknown error 取可读信息 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// —— Electron 主进程接线（仅运行时 require electron，不进 UT）——

/**
 * 注册 computer 权限 / 截图 IPC handler（main.ts 在 app.whenReady 后调用）。
 * 四个 channel：getPermissions / requestAccessibility / openScreenRecordingSettings / testScreenshot。
 */
export function registerComputerPermissionsIpc(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ipcMain, systemPreferences, desktopCapturer, shell } = require('electron');
  const platform = process.platform;

  ipcMain.handle('computer:getPermissions', () =>
    computeGetPermissions(platform, systemPreferences),
  );
  ipcMain.handle('computer:requestAccessibility', () =>
    computeRequestAccessibility(platform, systemPreferences),
  );
  ipcMain.handle('computer:openScreenRecordingSettings', () =>
    computeOpenScreenRecordingSettings(platform, shell),
  );
  ipcMain.handle('computer:testScreenshot', () =>
    computeTestScreenshot(platform, desktopCapturer),
  );
}

/**
 * 启动自检 log（app.whenReady 后调一次）。
 * 只做**非侵入**权限态查询（computeGetPermissions 内 isTrustedAccessibilityClient(false)
 * + getMediaAccessStatus('screen')，二者均纯查询、不弹窗），在启动 stdout 打印 Rocky
 * 作为权限主体当前的授权态，便于诊断。
 *
 * 不变量（v0.0.105）：**启动自检绝不主动触发任何 TCC 权限请求 / 系统弹窗**。
 *   截图（desktopCapturer.getSources）首次会触发屏幕录制系统请求，故绝不在自检内调用——
 *   截图仅由用户在电脑 tab 主动点「测试截图」时触发（computer:testScreenshot channel）。
 *
 * @param natives 注入的 electron 原生（默认 require('electron')）。仅读 systemPreferences；
 *   desktopCapturer 注入进来仅供 UT 守护「自检绝不调 getSources」——函数体刻意不读它。
 */
export function runComputerSelfCheck(natives?: {
  systemPreferences: SystemPreferencesLike;
  desktopCapturer: DesktopCapturerLike;
}): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { systemPreferences } = natives ?? require('electron');
    const perms = computeGetPermissions(process.platform, systemPreferences);
    // eslint-disable-next-line no-console
    console.log('[computer] self-check permissions:', JSON.stringify(perms));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[computer] self-check threw:', errText(e));
  }
}
