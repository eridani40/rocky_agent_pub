/**
 * Electron preload 脚本 — contextBridge 最小暴露
 * 参考: specs/tech/app/package/[P0]package_structure.md §2.1/§4.3
 *
 * v0.0.1 无真实 IPC 业务（计数器走 HTTP 不走 IPC），故只暴露最小占位
 * window.rocky.version，让渲染层未来扩展有挂载点。
 * 渲染沙箱内不能 require Node；所有跨进程能力必须经此桥。
 *
 * [preload fix] sandbox:true 下 preload 不能 require('electron').app（app 为 undefined，
 * 抛 Cannot read properties of undefined (reading 'getVersion')）。改用 ipcRenderer.invoke
 * 走主进程 ipcMain.handle('app:get-version') 拿 version（sandboxed preload 允许 ipcRenderer）。
 */
import { contextBridge, ipcRenderer } from 'electron';

/**
 * 把最小 API 暴露到 window.rocky（contextIsolation 沙箱安全）。
 * version 是 Promise（主进程 IPC 返回）；后续版本在此扩展 session/agent 等 IPC channel。 */
contextBridge.exposeInMainWorld('rocky', {
  /** 应用版本（主进程 app.getVersion()，经 IPC 桥） */
  version: ipcRenderer.invoke('app:get-version'),
});

/**
 * v0.0.105 spike：暴露 computer 权限 / 截图能力到 window.rockyComputer。
 * 各方法经 ipcRenderer.invoke 对应主进程 computer:* channel（computer-permissions-ipc.ts）。
 * 前端类型声明镜像见 app/web/src/types/rocky-computer.d.ts（IPC 边界契约）。
 * window.rockyComputer 不存在 = 非 Electron 环境（如 dev web 浏览器）→ 前端降级「仅桌面 App 可用」。
 */
contextBridge.exposeInMainWorld('rockyComputer', {
  /** 查询权限态 → { platform, supported, accessibility, screenRecording } */
  getPermissions: () => ipcRenderer.invoke('computer:getPermissions'),
  /** 弹辅助功能授权引导窗，返回当前信任态 */
  requestAccessibility: () => ipcRenderer.invoke('computer:requestAccessibility'),
  /** 深链打开系统设置屏幕录制页（屏幕录制不能程序弹窗，只能引导） */
  openScreenRecordingSettings: () => ipcRenderer.invoke('computer:openScreenRecordingSettings'),
  /** desktopCapturer 真截一张屏 → { ok, dataUrl?, width?, height?, reason? } */
  testScreenshot: () => ipcRenderer.invoke('computer:testScreenshot'),
});

/**
 * v0.0.253：暴露通用「打开外部资源」能力到 window.rockyShell（package_structure §4.4）。
 * 五方法经 ipcRenderer.invoke 对应主进程 shell:* channel（open-external-ipc.ts）：
 *   - openExternal(url) → 系统默认浏览器（web scheme）
 *   - openPath(path)    → 系统默认应用（绝对路径，main 侧展开 ~ / file://）
 *   - readFileText(path) → 读绝对路径 utf8 文本喂内置 viewer
 *   - writeFileText(path, content) → 写绝对路径 utf8 文本（覆盖，last-write-wins）
 *   - readFileBinary(path) → 读绝对路径二进制 → base64（图片 viewer）
 * 前端类型声明镜像见 app/web/src/types/rocky-shell.d.ts（IPC 边界契约）。
 * window.rockyShell 不存在 = 非 Electron 环境 → 前端降级（web→window.open 兜底 / local→系统打开 / 无内置 viewer）。
 */
contextBridge.exposeInMainWorld('rockyShell', {
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', { url }),
  openPath: (path: string) => ipcRenderer.invoke('shell:openPath', { path }),
  readFileText: (path: string) => ipcRenderer.invoke('shell:readFileText', { path }),
  // [v0.0.280] 写绝对路径文本（utf8 覆盖，last-write-wins）——absolute 源编辑器保存用
  writeFileText: (path: string, content: string) => ipcRenderer.invoke('shell:writeFileText', { path, content }),
  // [v0.0.280] 读绝对路径二进制 → base64（≤2MB）——absolute 源图片 viewer 用
  readFileBinary: (path: string) => ipcRenderer.invoke('shell:readFileBinary', { path }),
  // [v0.0.339] stat 绝对路径文件 → { size }（文件大小判定，供前端打开分流）
  stat: (path: string) => ipcRenderer.invoke('shell:stat', { path }),
});
