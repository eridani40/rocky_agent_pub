/**
 * session-workspace-path —— workspace 路径白名单校验（v0.0.263 从 session-workspace.ts 迁出 + 链式授权）
 * 参考: specs/tech/agent/session/[P0]session_workspace.md §6（路径白名单安全校验契约）
 *       specs/tech/version_logs/v0.0.263/change_plan.md 行 1（链式授权解析）
 *
 * 授权模型（v0.0.263）：workspace 内存在的 symlink = 用户放置 = 用户显式意图 = 授权。
 *   step2 从 realRoot 出发**逐段** resolve：每段 lstatSync 判 symlink → realpathSync 授权该
 *   symlink 目标为继续解析的根。无 symlink 段时与旧 realpathSync(abs) 等价（普通路径零行为
 *   变化）。不经过 symlink 段的越界（../、绝对路径、~）仍被 step1 前缀检查拒绝（威胁模型保持）。
 *   4 处调用点（tree/open/watch/file）共用本函数 → 授权模型自动统一，零额外接线。
 */
import { lstatSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** 白名单校验结果（区分明确越界 vs realpath 失败，供 caller 选 400/404/200） */
export type WhitelistResult =
  | { ok: true; realAbs: string } // 合法（链式解析结果，可能已授权到 workspace 外 symlink 目标）
  | { ok: false; reason: 'traversal' } // 明确越界（字符串前缀或 realpath 越界）→ 400
  | { ok: false; reason: 'not_found' }; // realpath 失败（不存在/无权限/broken symlink）→ 404（tree/open）或静默 200（watch/unwatch）

/**
 * 路径白名单校验（spec §6 安全校验 MANDATORY）：
 *   - step 1 字符串前缀：resolve(realRoot, rel) 必须在 realRoot 内（挡 ../ 和绝对路径注入）
 *   - step 2 链式授权解析：从 realRoot 出发逐段 resolve，每段 lstatSync 判 symlink——
 *     symlink 段 realpath 其目标并作为继续解析的根（workspace 内存在的 symlink = 用户放置 = 授权）；
 *     无 symlink 段时与旧 realpathSync(abs) 等价。lstatSync/realpathSync 失败（不存在/broken）→ not_found。
 * caller 必须先 realpath workspaceDir 再传入（realRoot）。export 供 session-workspace-watch.ts / -file.ts 复用。
 */
export function whitelistResolve(realRoot: string, rel?: string): WhitelistResult {
  const abs = rel ? resolve(realRoot, rel) : resolve(realRoot);
  const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  // step 1: 字符串前缀校验（快速挡 ../ + 绝对路径注入）
  if (abs !== realRoot && !abs.startsWith(rootWithSep)) {
    return { ok: false, reason: 'traversal' };
  }
  // step 2: 链式授权解析（逐段 resolve + symlink 段 realpath 授权）
  let cur = realRoot;
  // abs 相对 realRoot 的剩余段（step1 已保证 abs 在 realRoot 内：无 '..'、无绝对段、无 '.'）
  const rest = abs === realRoot ? '' : abs.slice(rootWithSep.length);
  if (rest) {
    for (const seg of rest.split(/[\\/]/)) {
      cur = resolve(cur, seg);
      let isLink = false;
      try {
        isLink = lstatSync(cur).isSymbolicLink();
      } catch {
        return { ok: false, reason: 'not_found' };
      }
      if (isLink) {
        try {
          cur = realpathSync(cur);
        } catch {
          return { ok: false, reason: 'not_found' }; // broken symlink（目标不存在）
        }
      }
    }
  }
  return { ok: true, realAbs: cur };
}
