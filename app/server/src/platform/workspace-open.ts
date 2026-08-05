/**
 * workspace-open —— 跨平台「用系统默认应用打开文件/文件夹」（v0.0.17 新建）
 * 参考: specs/api/overall/04-agent-session.md §2.6.2（POST /session/:id/workspace/open）
 *       specs/tech/agent/session/[P0]session_workspace.md §6（安全：路径白名单 caller 负责）
 *
 * 职责：封装 spawn 系统命令打开文件/文件夹。caller（handler）已完成路径白名单校验，
 * 本模块只负责按平台 spawn 正确命令。
 *
 * 平台分支：
 *   - macOS（darwin）：
 *       file   → `open <absPath>`
 *       folder → `open <absPath>`（open 自动选 Finder / 默认应用）
 *   - Windows（win32）：
 *       file   → `cmd /c start "" <absPath>`（start 命令打开默认程序）
 *       folder → `explorer <absPath>`
 *   - Linux / 其他：
 *       file/folder → `xdg-open <absPath>`
 *
 * 返回语义（OpenResult）：
 *   - { ok: true } spawn 成功（exit 0 或异步派生无错）
 *   - { ok: false, error } spawn 失败（命令不存在 / 非零退出码）
 *
 * 选型说明：用 spawnSync（同步阻塞 + encoding utf8 + timeout 兜底）。理由：
 *   - 打开文件是「用户点一下」的即时操作，同步快速返回体验更好。
 *   - 避免异步 spawn 在 server 进程残留孤儿进程 handle 干扰 vitest。
 *   - 失败（如 Linux 无 xdg-open）能立即捕获 stderr 给前端友好错误。
 */
import { spawnSync } from 'node:child_process';

/** kind 合法集合（spec §2.6.2） */
export type OpenKind = 'file' | 'folder';

/** 打开操作结果（caller 据此返 200 / 500） */
export interface OpenResult {
  ok: boolean;
  /** 失败原因（ok=false 时填，前端展示） */
  error?: string;
}

/** spawn 超时（ms）—— 兜底防某些命令卡死（如 win 上 start 阻塞） */
const SPAWN_TIMEOUT_MS = 5000;

/**
 * 用系统默认应用打开文件 / 文件夹。
 *
 * @param kind  'file' | 'folder'
 * @param absPath 绝对路径（caller 已校验白名单）
 * @returns OpenResult
 */
export function openWithSystemApp(kind: OpenKind, absPath: string, spawnFn: typeof spawnSync = spawnSync): OpenResult {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      // mac：file / folder 都用 `open`（系统自动选默认应用 / Finder）
      const r = spawnFn('open', [absPath], {
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
      });
      return toResult(r);
    }
    if (platform === 'win32') {
      // Windows：file 用 start（无阻塞）；folder 用 explorer
      if (kind === 'folder') {
        const r = spawnFn('explorer', [absPath], {
          encoding: 'utf8',
          timeout: SPAWN_TIMEOUT_MS,
        });
        return toResult(r);
      }
      // file：`start "" <path>` —— 空标题参避免路径含空格被当标题
      const r = spawnFn('cmd', ['/c', 'start', '', absPath], {
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
        shell: false,
      });
      return toResult(r);
    }
    // linux / 其他：xdg-open（file + folder 通用）
    const r = spawnFn('xdg-open', [absPath], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    const result = toResult(r);
    if (!result.ok) {
      return {
        ok: false,
        error: 'xdg-open failed (需安装 xdg-open；Linux 桌面环境标配)',
      };
    }
    return result;
  } catch (e) {
    return { ok: false, error: `spawn failed: ${(e as Error).message}` };
  }
}

/** spawnSync 结果 → OpenResult（非零退出或 spawn error 视作失败） */
function toResult(
  r: ReturnType<typeof spawnSync>,
): OpenResult {
  if (r.error) {
    // 命令不存在（ENOENT）等
    return { ok: false, error: `spawn error: ${r.error.message}` };
  }
  if (r.status !== 0) {
    return {
      ok: false,
      error: `command exited ${r.status}${r.stderr ? `: ${r.stderr}` : ''}`,
    };
  }
  return { ok: true };
}
