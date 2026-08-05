/**
 * window.rockyComputer 类型声明（v0.0.105 架构验证 spike）
 * 参考: app/electron/src/computer-permissions-ipc.ts（主进程 handler，结果形状权威源）
 *       app/electron/src/preload.ts（contextBridge 暴露）
 *
 * IPC 边界契约：electron 与 web 是独立包（web 不 reference electron），故结果形状在此镜像。
 * window.rockyComputer 仅在 Electron 桌面 app 存在；dev web 浏览器为 undefined → 前端降级。
 */

/** 屏幕录制授权态（镜像 electron ScreenRecordingStatus） */
export type ScreenRecordingStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown';

/** 权限查询结果（镜像 electron ComputerPermissions） */
export interface ComputerPermissions {
  platform: string;
  supported: boolean;
  accessibility: boolean;
  screenRecording: ScreenRecordingStatus;
}

/** 测试截图结果（镜像 electron ScreenshotResult） */
export interface ComputerScreenshotResult {
  ok: boolean;
  dataUrl?: string;
  width?: number;
  height?: number;
  reason?: string;
}

/** 打开系统设置结果（镜像 electron OpenSettingsResult） */
export interface ComputerOpenSettingsResult {
  ok: boolean;
  reason?: string;
}

/** preload 经 contextBridge 暴露的 computer 能力 */
export interface RockyComputerApi {
  getPermissions(): Promise<ComputerPermissions>;
  requestAccessibility(): Promise<boolean>;
  openScreenRecordingSettings(): Promise<ComputerOpenSettingsResult>;
  testScreenshot(): Promise<ComputerScreenshotResult>;
}

declare global {
  interface Window {
    /** 仅 Electron 桌面 app 存在（preload 暴露）；非 Electron 环境 undefined */
    rockyComputer?: RockyComputerApi;
  }
}
