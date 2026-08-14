/**
 * FileProvider —— workspace 文件搜索 mention provider（适配层）
 * 参考: specs/tech/mention/provider-interface.md §5
 *       specs/tech/version_logs/v0.0.346/change_plan.md（file-provider 行）
 *
 * v0.0.346 起收敛为 workspace-search-core 的适配层：
 *   - search() 调 searchWorkspace(ctx.workspaceDir, ctx.query)——与工作区搜索共用同一
 *     遍历/排除/上限（IGNORED_NAMES 仅 node_modules/.git，单一源在 session-workspace.ts）
 *   - 合并 files+dirs 按 relPath 排序 → 按 limit/cursor 切片分页 → toMentionItem 映射
 *   - truncated 透传（files+dirs ≥ 100 早停）
 *   - 目录命中返回 type='file' 条目（path=目录相对路径；display.icon 保持 'file'，
 *     label/title=目录名，subtitle=dirname）——MentionItem 仅加 isDir 可选字段
 *   - 追加问题 4（v0.0.346-2）：isDir 标记（目录 true / 文件缺省）+ listView.icon
 *     folder/file 区分 + 根路径 subtitle='/' 始终展示
 *   - 5s 超时移除（100 早停保障）；点开头目录/文件不再排除（仅 IGNORED_NAMES）
 */
import { basename, dirname, sep } from 'node:path';
import { searchWorkspace } from '../../search/workspace-search-core';
import type { MentionProvider, SearchCtx, SearchResult, MentionItem } from '../types';

/** 默认分页大小 */
const DEFAULT_LIMIT = 20;

/**
 * 文件搜索 provider（适配层）。
 * 搜索范围 = ctx.workspaceDir 下递归遍历（排除 node_modules/.git，点开头不再排除）。
 * 搜索算法 = 与工作区搜索一致（basename 或完整相对路径包含匹配，大小写不敏感）。
 * 命中集合 = 文件 + 目录；目录条目不递归其下层，type 仍 'file'（选中/插入/pill 走既有路径）。
 */
export class FileProvider implements MentionProvider {
  readonly name = 'file';
  readonly label = 'Files';

  async search(ctx: SearchCtx): Promise<SearchResult> {
    const limit = ctx.limit > 0 ? ctx.limit : DEFAULT_LIMIT;

    // cursor = offset（base64 编码数字）
    const offset = ctx.cursor ? parseInt(atob(ctx.cursor), 10) || 0 : 0;

    // 适配层：与工作区搜索共用 searchWorkspace（同一遍历/排除/100 上限）
    const { files, dirs, truncated } = searchWorkspace(ctx.workspaceDir, ctx.query);

    // 合并 files+dirs 按 relPath 排序（dirs 在前，排序稳定保证跨请求 offset 一致）；
    // 保留 dir 标记（并行数组），排序/分页后逐条 toMentionItem(relPath, isDir)
    const allMatches: Array<{ relPath: string; isDir: boolean }> = [
      ...dirs.map((relPath) => ({ relPath, isDir: true })),
      ...files.map((relPath) => ({ relPath, isDir: false })),
    ].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

    // 分页切片
    const sliced = allMatches.slice(offset, offset + limit);
    const nextCursor =
      offset + limit < allMatches.length
        ? btoa(String(offset + limit))
        : undefined;

    return {
      items: sliced.map((m) => this.toMentionItem(m.relPath, m.isDir)),
      nextCursor,
      // truncated 透传（仅 true 时携带；false/undefined 由 handler 缺省省略）
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /**
   * 将文件/目录相对路径转换为 MentionItem。
   * 目录条目：type='file'，isDir=true，display.icon='file'（pill 不区分），
   * display.label=basename（目录名），listView.title=basename，subtitle=dirname，
   * listView.icon='folder'；文件条目：isDir 缺省，listView.icon='file'。
   * 根路径（dirname='.'）subtitle='/' 始终展示。
   */
  private toMentionItem(relPath: string, isDir = false): MentionItem {
    // 统一为 POSIX 路径分隔符（跨平台一致）
    const posixPath = relPath.split(sep).join('/');
    const name = basename(posixPath);
    const dirPart = dirname(posixPath);

    return {
      type: 'file',
      path: posixPath,
      // 目录条目 isDir:true；文件条目缺省（向后兼容，member/skill/workitem 不设）
      ...(isDir ? { isDir: true } : {}),
      display: {
        icon: 'file',
        label: name,
      },
      listView: {
        title: name,
        // 根路径 '/' 始终展示；非根 = dirname
        subtitle: dirPart === '.' ? '/' : dirPart,
        // 目录 folder / 文件 file（前端 popover 据此区分 icon）
        icon: isDir ? 'folder' : 'file',
      },
    };
  }
}
