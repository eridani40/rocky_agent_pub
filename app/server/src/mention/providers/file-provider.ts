/**
 * FileProvider —— workspace 文件搜索 mention provider
 * 参考: specs/tech/mention/provider-interface.md §5
 *
 * 在 ctx.workspaceDir 下递归遍历文件，按文件名/路径包含匹配搜索。
 * 排除 node_modules / .git / 隐藏文件（.* 开头）。
 * 5 秒超时兜底，返回当前已收集结果 + nextCursor。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, basename, dirname, sep } from 'node:path';
import type { MentionProvider, SearchCtx, SearchResult, MentionItem } from '../types';

/** 排除的目录/文件名（与 session-workspace.ts IGNORED_NAMES 一致 + 隐藏文件） */
const IGNORED_NAMES = new Set(['node_modules', '.git']);

/** 默认分页大小 */
const DEFAULT_LIMIT = 20;
/** 搜索超时（毫秒） */
const SEARCH_TIMEOUT_MS = 5000;

/**
 * 文件搜索 provider。
 * 搜索范围 = ctx.workspaceDir 下递归遍历（排除 node_modules/.git/隐藏文件）。
 * 搜索算法 = 文件名包含匹配（大小写不敏感）。无索引，实时遍历。
 */
export class FileProvider implements MentionProvider {
  readonly name = 'file';
  readonly label = 'Files';

  async search(ctx: SearchCtx): Promise<SearchResult> {
    const limit = ctx.limit > 0 ? ctx.limit : DEFAULT_LIMIT;
    const query = ctx.query.toLowerCase();

    // cursor = offset（base64 编码数字）
    const offset = ctx.cursor ? parseInt(atob(ctx.cursor), 10) || 0 : 0;

    // 收集匹配文件（带 5 秒超时兜底）
    const allMatches = await this.collectWithTimeout(ctx.workspaceDir, query);

    // 排序保证稳定分页（跨请求 offset 一致）
    allMatches.sort();

    // 分页切片
    const sliced = allMatches.slice(offset, offset + limit);
    const nextCursor =
      offset + limit < allMatches.length
        ? btoa(String(offset + limit))
        : undefined;

    return {
      items: sliced.map((relPath) => this.toMentionItem(relPath)),
      nextCursor,
    };
  }

  /**
   * 带超时的文件收集（5 秒后返回已收集结果）。
   * 设计：race 一个文件遍历 Promise 和一个 setTimeout Promise，
   * 超时返回空数组（遍历未完成的由下次 cursor 翻页补全）。
   */
  private async collectWithTimeout(
    workspaceDir: string,
    query: string,
  ): Promise<string[]> {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
    }, SEARCH_TIMEOUT_MS);

    const matches: string[] = [];
    try {
      this.collectFiles(workspaceDir, workspaceDir, query, matches, () => timedOut);
    } finally {
      clearTimeout(timer);
    }
    return matches;
  }

  /**
   * 递归收集匹配文件（DFS）。
   * @param dir 当前遍历目录绝对路径
   * @param workspaceDir 根目录（计算相对路径用）
   * @param query 搜索关键词（已小写化）
   * @param matches 结果收集数组（写入相对路径）
   * @param shouldStop 超时检测回调（返回 true 立即中止递归）
   */
  private collectFiles(
    dir: string,
    workspaceDir: string,
    query: string,
    matches: string[],
    shouldStop: () => boolean,
  ): void {
    if (shouldStop()) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // 目录不可读，静默跳过
    }

    for (const name of entries) {
      if (shouldStop()) return;
      if (this.shouldSkip(name)) continue;

      const absPath = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(absPath).isDirectory();
      } catch {
        continue; // stat 失败跳过
      }

      if (isDir) {
        this.collectFiles(absPath, workspaceDir, query, matches, shouldStop);
      } else if (name.toLowerCase().includes(query)) {
        // 文件名包含匹配 → 记录相对路径
        matches.push(relative(workspaceDir, absPath));
      }
    }
  }

  /**
   * 判断是否跳过某文件/目录名。
   * 排除：node_modules / .git / 隐藏文件（.* 开头）。
   */
  private shouldSkip(name: string): boolean {
    return IGNORED_NAMES.has(name) || name.startsWith('.');
  }

  /**
   * 将文件相对路径转换为 MentionItem。
   * path = 相对路径（POSIX 分隔符）；display.label/listView.title = 文件名（同源）。
   */
  private toMentionItem(relPath: string): MentionItem {
    // 统一为 POSIX 路径分隔符（跨平台一致）
    const posixPath = relPath.split(sep).join('/');
    const fileName = basename(posixPath);
    const dirPart = dirname(posixPath);

    return {
      type: 'file',
      path: posixPath,
      display: {
        icon: 'file',
        label: fileName,
      },
      listView: {
        title: fileName,
        subtitle: dirPart === '.' ? undefined : dirPart,
        icon: 'file',
      },
    };
  }
}
