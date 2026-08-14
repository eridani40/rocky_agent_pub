/**
 * workspace-search-core —— 工作区搜索核心（v0.0.346）
 * 参考: specs/tech/version_logs/v0.0.346/change_plan.md（search-core 行）
 *       specs/api/overall/04-agent-session.md §2.6.8（workspace 搜索端点契约）
 *
 * 从 session-workspace-search.ts walkSearch 提取的公共纯函数模块：
 *   - session-workspace-search.ts（工作区搜索端点）与 mention/file-provider（@ 搜索）共用
 *   - IGNORED_NAMES（node_modules/.git）从 session-workspace.ts 导入（单一源，不重复定义）
 *   - 同步 DFS（readdirSync/statSync/lstatSync），与旧 walkSearch 行为逐字节一致：
 *     pathMode（q 含 `/` → relChild 完整相对路径匹配，否则 basename）、目录命中推 dirs 不递归
 *     其下层、files+dirs ≥ limit 早停 truncated:true、symlink 目录不递归
 *   - 安全面与现状一致：symlink 目录不跟随出 workspace（防越权/循环）；目录不可读 / lstat /
 *     stat 失败跳过该分支（权限/竞态删）
 *   - 不引入点开头排除（排除仅 IGNORED_NAMES）
 */
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { IGNORED_NAMES } from '../handlers/session-workspace';

/** 搜索上限（files+dirs 合计；v0.0.324 从 200 降至 100，单一上限源两调用方共用） */
export const SEARCH_LIMIT = 100;

/** searchWorkspace 选项：relRoot = 搜索起点相对前缀（默认 '' = 根），limit = 上限（默认 SEARCH_LIMIT） */
export interface WorkspaceSearchOptions {
  relRoot?: string;
  limit?: number;
}

/** searchWorkspace 结果：files/dirs 为相对 rootDir 的 POSIX 路径；truncated = 是否达上限早停 */
export interface WorkspaceSearchResult {
  files: string[];
  dirs: string[];
  truncated: boolean;
}

/**
 * 递归搜索目录（当前目录绝对路径 + 相对 rootDir 的 POSIX 路径前缀）。
 * pathMode=true（q 含 `/`）→ 匹配完整相对路径 relChild（子串、大小写不敏感）；
 * pathMode=false（q 不含 `/`）→ 匹配 basename name。
 * 返回 true = 已达上限需停止；false = 可继续。
 */
function walkSearch(
  absDir: string,
  relDir: string,
  qLower: string,
  pathMode: boolean,
  files: string[],
  dirs: string[],
  limit: number,
): boolean {
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return false; // 目录不可读（权限/竞态删）→ 跳过该分支
  }
  for (const name of entries) {
    if (IGNORED_NAMES.has(name)) continue; // node_modules/.git 不遍历不返回（与 tree/watch 一致）
    const absChild = join(absDir, name);
    const relChild = relDir ? `${relDir}/${name}` : name;

    let isSymlink = false;
    try {
      isSymlink = lstatSync(absChild).isSymbolicLink();
    } catch {
      continue; // lstat 失败（权限/竞态删）跳过
    }
    let isDir = false;
    try {
      isDir = statSync(absChild).isDirectory();
    } catch {
      continue; // stat 失败（broken symlink 目标不存在/权限）跳过
    }

    // 匹配目标：pathMode 匹配完整相对路径，否则匹配 basename
    const matchTarget = pathMode ? relChild.toLowerCase() : name.toLowerCase();

    // 目录命中 → dirs 推入 + **不递归其下层**（API change_log §1.3：前端拿到 dir 后展示该目录
    //   展开内容，后端只返 dir 路径本身）
    if (isDir) {
      if (matchTarget.includes(qLower)) {
        dirs.push(relChild);
        if (files.length + dirs.length >= limit) return true;
        continue;
      }
      // 目录未命中 → 递归其下层（普通目录）；symlink→dir 一律不递归——目标可能出 workspace 或
      //   指向祖先（循环），保守跳过（防越权/循环，比 API 文档约束更严）
      if (!isSymlink) {
        if (walkSearch(absChild, relChild, qLower, pathMode, files, dirs, limit)) return true;
      }
      continue;
    }

    // 文件命中 → files 推入（symlink→file 可列入）
    if (matchTarget.includes(qLower)) {
      files.push(relChild);
      if (files.length + dirs.length >= limit) return true;
    }
  }
  return false;
}

/**
 * 搜索工作区（同步 DFS，阻塞调用方——由调用方保证在合适上下文执行）。
 * relRoot 非空时从 rootDir/relRoot 开始遍历，返回路径仍相对 rootDir（带 relRoot 前缀）。
 * q 为空串 → 全部条目匹配（与旧 walkSearch 语义一致，调用方自行校验非空）。
 */
export function searchWorkspace(
  rootDir: string,
  q: string,
  opts?: WorkspaceSearchOptions,
): WorkspaceSearchResult {
  const relRoot = opts?.relRoot ?? '';
  const limit = opts?.limit ?? SEARCH_LIMIT;
  const files: string[] = [];
  const dirs: string[] = [];
  const absStart = relRoot ? join(rootDir, relRoot) : rootDir;
  const truncated = walkSearch(
    absStart, relRoot, q.toLowerCase(), q.includes('/'), files, dirs, limit,
  );
  return { files, dirs, truncated };
}
