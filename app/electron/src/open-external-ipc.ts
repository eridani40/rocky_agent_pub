/**
 * open-external-ipc — 主进程通用「打开外部资源」IPC（v0.0.253）
 * 参考: specs/tech/app/package/[P0]package_structure.md §4.4（通用打开外部资源 IPC 不变量）
 *       specs/tech/version_logs/v0.0.253/change_plan.md 模块 A
 *
 * 设计与 computer-permissions-ipc.ts 范本一致：
 *   - 顶层**不 import electron**——纯 compute* 函数注入 ShellLike / FsLike / home 依赖，UT 无需 electron runtime。
 *   - electron / fs 值仅在 registerOpenExternalIpc 函数体内 require，仅在真 Electron 主进程运行时加载。
 *
 * 三 channel（名硬编码 shell:* 非 protocols，对齐 v0.0.105 computer:* 范式）：
 *   - shell:openExternal  → 系统默认浏览器（web scheme）
 *   - shell:openPath      → 系统默认应用（本地非 viewer 型文件）
 *   - shell:readFileText  → 读绝对路径文本喂内置 viewer（utf8，≤2MB）
 *
 * 路径解析单一权威在 main 侧：computeResolveLocalPath 注入 home（不读 process.env / cwd，
 * 防 packaged cwd=`/` BUG-004）；workspace 相对路径不走本通道（继续走 HTTP readWorkspaceFile）。
 */

/** openExternal / openPath 公共返回形状 */
export interface OpenExternalResult {
  ok: boolean;
  reason?: string;
}

/** readFileText 返回形状（含内容） */
export interface ReadFileTextResult {
  ok: boolean;
  content?: string;
  reason?: string;
}

/** 路径解析返回形状 */
export interface ResolveLocalPathResult {
  ok: boolean;
  absPath?: string;
  reason?: string;
}

// —— 结构化依赖接口（仅声明本模块用到的最小 API 面，不 import electron）——

/** shell 最小面（openExternal 打开浏览器；openPath 打开系统默认应用） */
export interface ShellLike {
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
}

/** fs 最小面（读 utf8 文本喂 viewer） */
export interface FsLike {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  stat?(path: string): Promise<{ size: number }>;
}

// —— 纯计算函数（注入依赖，可 UT）——

/**
 * 解析本地路径为绝对路径（main 侧单一权威）。
 *
 * 步骤：
 *   1. strip `file://` 前缀
 *   2. 展开 `~` / `~/` 用注入的 home（不读 process.env，packaged cwd=`/` 不依赖工作目录）
 *   3. 验证结果为绝对路径（POSIX `/` 或 win 盘符）；非绝对（workspace 相对路径）→ ok=false reason='relative-not-allowed'
 *
 * workspace 相对路径不走本通道（继续走 HTTP readWorkspaceFile），故遇到相对路径直接拒绝。
 *
 * @param raw renderer 传来的原始 target（可能带 file://、~ 前缀，或已是绝对路径）
 * @param home 用户 home 目录绝对路径（由 main 注入，UT 用 fake home）
 */
export function computeResolveLocalPath(raw: string, home: string): ResolveLocalPathResult {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, reason: 'empty-path' };
  }
  // strip file:// 前缀（兼容 file:///abs 和 file://host/abs 两种形式）
  let p = raw;
  if (p.startsWith('file://')) {
    p = p.slice('file://'.length);
    // file://localhost/abs → 去 host（仅当剩余不以 / 开头时认为是 host 形式）
    if (!p.startsWith('/') && /^[^/]+\//.test(p)) {
      p = p.replace(/^[^/]+\//, '/');
    }
  }
  // 展开 ~ / ~/
  if (p === '~') {
    p = home;
  } else if (p.startsWith('~/')) {
    p = home + p.slice(1); // 保留后续 /...
  }
  // 验证绝对路径：POSIX `/` 开头 或 win 盘符 `X:\` / `X:/`
  const isPosixAbs = p.startsWith('/');
  const isWinAbs = /^[A-Za-z]:[\\/]/.test(p);
  if (!isPosixAbs && !isWinAbs) {
    return { ok: false, reason: 'relative-not-allowed' };
  }
  return { ok: true, absPath: p };
}

/**
 * 打开 web scheme URL（系统默认浏览器）。
 * 不在 main 侧做协议白名单——renderer 侧 classifyLinkTarget 已过滤危险协议（isDangerousScheme），
 * main 信任 renderer 调用；catch 异常返 reason 不抛。
 */
export async function computeOpenExternal(url: string, shell: ShellLike): Promise<OpenExternalResult> {
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
}

/**
 * 打开绝对路径（系统默认应用）。接收**已展开的绝对路径**（computeResolveLocalPath 输出），
 * 不自行展开 `~`（职责分离）。catch 异常返 reason 不抛。
 */
export async function computeOpenPath(absPath: string, shell: ShellLike): Promise<OpenExternalResult> {
  try {
    await shell.openPath(absPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
}

/** readFileText 大小上限（防 LLM 链接指向超大文件拖垮 viewer，2MB） */
const READ_FILE_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 读绝对路径文本文件喂内置 viewer（utf8）。
 * 接收**已展开的绝对路径**。限制 utf8 文本（图片/pdf 走 openPath 不进本通道）。
 * 文件大小上限 2MB（防超大文件），超限返 reason='too-large'。
 * ENOENT / EACCES / 异常均返 reason 不抛。
 *
 * @param fs 注入的 FsLike（含可选 stat 用于大小预检）
 */
export async function computeReadFileText(
  absPath: string,
  fs: FsLike,
): Promise<ReadFileTextResult> {
  try {
    // 大小预检（若 fs.stat 可用）
    if (typeof fs.stat === 'function') {
      const st = await fs.stat(absPath);
      if (st.size > READ_FILE_TEXT_MAX_BYTES) {
        return { ok: false, reason: 'too-large' };
      }
    }
    const content = await fs.readFile(absPath, 'utf8');
    return { ok: true, content };
  } catch (e) {
    const code = (e as { code?: string } | undefined)?.code;
    if (code === 'ENOENT') return { ok: false, reason: 'not-found' };
    if (code === 'EACCES') return { ok: false, reason: 'permission-denied' };
    return { ok: false, reason: errText(e) };
  }
}

/** 从 unknown error 取可读信息 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// —— Electron 主进程接线（仅运行时 require electron / fs，不进 UT）——

/**
 * 注册通用打开外部资源 IPC handler（main.ts 在 app.whenReady 后调用）。
 * 三 channel：shell:openExternal / shell:openPath / shell:readFileText。
 * openPath / readFileText 先调 computeResolveLocalPath 展开（renderer 传 raw target 原样）。
 */
export function registerOpenExternalIpc(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ipcMain, shell } = require('electron');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs/promises') as FsLike;
  // home 由 main 进程的 os.homedir() 解析（packaged 不依赖 cwd）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const home = require('node:os').homedir();

  ipcMain.handle(
    'shell:openExternal',
    (_e: unknown, args: { url: string }) => computeOpenExternal(args.url, shell),
  );
  ipcMain.handle('shell:openPath', (_e: unknown, args: { path: string }) => {
    const resolved = computeResolveLocalPath(args.path, home);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    return computeOpenPath(resolved.absPath!, shell);
  });
  ipcMain.handle('shell:readFileText', (_e: unknown, args: { path: string }) => {
    const resolved = computeResolveLocalPath(args.path, home);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    return computeReadFileText(resolved.absPath!, fs);
  });
}
