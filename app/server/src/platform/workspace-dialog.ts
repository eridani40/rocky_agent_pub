/**
 * workspace-dialog —— 跨平台「系统原生选目录 dialog」（v0.0.17 新建）
 * 参考: specs/api/overall/04-agent-session.md §2.6.3（POST pick-directory）
 *
 * 职责：spawn OS 原生选目录 dialog，返选定绝对路径（用户取消 → null）。
 * 系统 dialog 原生支持「新建文件夹」按钮。
 *
 * 平台命令：
 *   - macOS：osascript -e 'choose folder'（AppleScript；原生支持新建文件夹）
 *   - Windows：powershell System.Windows.Forms.FolderBrowserDialog
 *   - Linux：zenity --file-selection --directory（优先）/ kdialog --getexistingdirectory（回退）
 *
 * 返回语义（PickResult）：
 *   - { path: string } 用户选定目录（绝对路径，已去尾随 alias / 引号）
 *   - { path: null } 用户取消（dialog 返非零退出码或空输出）
 *   - { error: string } spawn 失败（如 Linux 无 zenity + kdialog）—— caller 据此返 500
 */
import { spawnSync } from 'node:child_process';

/** pick 结果（caller 据此返 200 path / 200 null / 500） */
export interface PickResult {
  /** 用户选定绝对路径；null = 用户取消 */
  path: string | null;
  /** spawn 失败（命令缺失等）；caller 返 500 */
  error?: string;
}

/**
 * dialog spawn 超时（ms）—— 给用户操作足够时间。
 * 测试环境（NODE_ENV=test）用更短超时避免 60s 阻塞（osascript 在 CI 会真等用户）。
 */
const SPAWN_TIMEOUT_MS =
  process.env.NODE_ENV === 'test' ? 500 : 60_000;

/**
 * 弹出系统原生选目录 dialog。
 *
 * @param currentDir 建议的初始位置（可空 —— dialog 用系统默认位置）
 * @returns PickResult
 */
export function pickDirectory(
  currentDir?: string,
  spawnFn: typeof spawnSync = spawnSync,
): PickResult {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      return pickMac(currentDir, spawnFn);
    }
    if (platform === 'win32') {
      return pickWindows(currentDir, spawnFn);
    }
    return pickLinux(currentDir, spawnFn);
  } catch (e) {
    return { path: null, error: `spawn failed: ${(e as Error).message}` };
  }
}

/** macOS：osascript choose folder。返回形如 `alias Macintosh HD:Users:...` → 转 POSIX path。 */
function pickMac(currentDir: string | undefined, spawnFn: typeof spawnSync): PickResult {
  const defaultLoc = currentDir ? ` default location alias POSIX file "${currentDir}"` : '';
  const script = `POSIX path of (choose folder with prompt "选择工作区目录"${defaultLoc})`;
  const r = spawnFn('osascript', ['-e', script], {
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (r.error) {
    return { path: null, error: `osascript error: ${r.error.message}` };
  }
  // 用户取消 → exit 1 + stderr "User canceled" 等
  if (r.status !== 0) {
    if (/cancel/i.test(r.stderr || '')) return { path: null };
    return { path: null, error: `osascript exited ${r.status}: ${r.stderr}` };
  }
  const path = (r.stdout || '').trim();
  if (!path) return { path: null };
  return { path };
}

/** Windows：powershell FolderBrowserDialog */
function pickWindows(currentDir: string | undefined, spawnFn: typeof spawnSync): PickResult {
  const sel = currentDir ? `$f.SelectedPath='${currentDir}';` : '';
  // 输出 SelectedPath 到 stdout，用户取消时 SelectedPath 仍为初始值，但 ShowDialog() != OK → 输出空
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.FolderBrowserDialog; ${sel} $r=$f.ShowDialog(); if ($r -eq 'OK') { Write-Output $f.SelectedPath }`;
  const r = spawnFn('powershell', ['-NoProfile', '-Command', ps], {
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (r.error) {
    return { path: null, error: `powershell error: ${r.error.message}` };
  }
  if (r.status !== 0) {
    return { path: null, error: `powershell exited ${r.status}: ${r.stderr}` };
  }
  const path = (r.stdout || '').trim();
  if (!path) return { path: null }; // 用户取消（ShowDialog != OK）
  return { path };
}

/** Linux：zenity 优先，kdialog 回退 */
function pickLinux(currentDir: string | undefined, spawnFn: typeof spawnSync): PickResult {
  // 优先 zenity
  const zArgs = ['--file-selection', '--directory', '--title=选择工作区目录'];
  if (currentDir) zArgs.push(`--filename=${currentDir}/`);
  const z = spawnFn('zenity', zArgs, {
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  const zErrno = (z.error as NodeJS.ErrnoException | undefined)?.code;
  if (!z.error || zErrno !== 'ENOENT') {
    // zenity 存在（即使非零退出也可能是用户取消）
    if (z.status === 0) {
      const path = (z.stdout || '').trim();
      return path ? { path } : { path: null };
    }
    // zenity 退出码 1 = 用户取消
    if (z.status === 1) return { path: null };
    // 其他错误 → 回退 kdialog
  }
  // 回退 kdialog
  const kArgs = ['--getexistingdirectory', currentDir || '.'];
  const k = spawnFn('kdialog', kArgs, {
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  const kErrno = (k.error as NodeJS.ErrnoException | undefined)?.code;
  if (k.error && kErrno === 'ENOENT') {
    return {
      path: null,
      error: '需安装 zenity 或 kdialog（Linux 桌面环境标配）',
    };
  }
  if (k.error) {
    return { path: null, error: `kdialog error: ${k.error.message}` };
  }
  if (k.status !== 0) return { path: null }; // 用户取消
  const path = (k.stdout || '').trim();
  return path ? { path } : { path: null };
}
