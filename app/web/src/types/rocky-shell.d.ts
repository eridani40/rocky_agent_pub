/**
 * window.rockyShell 类型声明（v0.0.253 通用打开外部资源 IPC）
 * 参考: app/electron/src/open-external-ipc.ts（主进程 handler，结果形状权威源）
 *       app/electron/src/preload.ts（contextBridge 暴露）
 *       specs/tech/app/package/[P0]package_structure.md §4.4（IPC 契约不变量）
 *
 * IPC 边界契约：electron 与 web 是独立包（web 不 reference electron），故结果形状在此镜像，
 * 与 open-external-ipc.ts 返回形状逐字一致（无法跨包共享 type）。
 * window.rockyShell 仅在 Electron 桌面 app 存在；dev web 浏览器为 undefined → 前端降级。
 */

/** openExternal / openPath 返回形状（镜像 electron OpenExternalResult） */
export interface RockyShellOpenResult {
  ok: boolean;
  reason?: string;
}

/** readFileText 返回形状（镜像 electron ReadFileTextResult） */
export interface RockyShellReadFileTextResult {
  ok: boolean;
  content?: string;
  reason?: string;
}

/** readFileBinary 返回形状（镜像 electron ReadFileBinaryResult；content=base64） */
export interface RockyShellReadFileBinaryResult {
  ok: boolean;
  content?: string;
  reason?: string;
}

/** preload 经 contextBridge 暴露的通用打开外部资源能力（package_structure §4.4） */
export interface RockyShellApi {
  /** 打开 web scheme URL（系统默认浏览器）；main 侧 shell.openExternal */
  openExternal(url: string): Promise<RockyShellOpenResult>;
  /** 打开本地文件 / 目录（系统默认应用）；path 可含 ~ / file://，main 侧展开 */
  openPath(path: string): Promise<RockyShellOpenResult>;
  /** 读绝对路径 utf8 文本喂内置 viewer；main 侧 fs.readFile（≤2MB） */
  readFileText(path: string): Promise<RockyShellReadFileTextResult>;
  /** [v0.0.280] 写绝对路径 utf8 文本（覆盖，last-write-wins）；main 侧 fs.writeFile——absolute 源编辑器保存用 */
  writeFileText(path: string, content: string): Promise<RockyShellOpenResult>;
  /** [v0.0.280] 读绝对路径二进制 → base64（≤2MB）；main 侧 fs.readFile Buffer——absolute 源图片 viewer 用 */
  readFileBinary(path: string): Promise<RockyShellReadFileBinaryResult>;
}

declare global {
  interface Window {
    /** 仅 Electron 桌面 app 存在（preload 暴露）；非 Electron 环境 undefined → 前端降级 */
    rockyShell?: RockyShellApi;
  }
}
