/**
 * glob 工具（gitignore 风格文件名匹配）
 * 参考: specs/tech/agent/tools/[P0]file_op_tools.md §5
 *
 * 行为：
 *   - pattern 必填（gitignore 风格，如双星 .ts、src 双星 .js）
 *   - path 搜索根（默认 workdir）；相对 → isError（与 file 工具一致，绝对路径硬约束）
 *   - 按 mtime 倒序排序（最近优先）
 *   - 无匹配 → 空列表（非错误）
 *   - 默认不遵循 .gitignore（含隐藏文件）
 *
 * 不引入 minimatch：用「pattern → RegExp」自实现子集
 *   （支持 双星 / 单星 / 问号 / 普通字符；不支持字符类留后续）。
 */
import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from './types';
import { errorResult, textResult, ToolErrorCode } from './types';

/** 最大递归深度（防 symlink 循环 / 巨型树） */
const MAX_DEPTH = 20;

/**
 * glob 工具实现（单例导出，registry 组装时引用）。
 */
export const fileGlobTool: Tool = {
  definition: {
    name: 'glob',
    description:
      'Find files by gitignore-style pattern (e.g. **/*.ts). Returns paths sorted by mtime (recent first).',
    intro: 'Find files by name pattern.',
    inputSchema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Gitignore-style glob pattern (e.g. **/*.ts)' },
        path: { type: 'string', description: 'Search root (absolute path, default workdir)' },
      },
    },
  },
  // [v0.0.130.hang] per-tool 默认超时：只读快工具，10s（见 change_plan.md 模块 A）
  defaultTimeoutMs: 10000,

  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    const pattern = String(input.pattern ?? '');
    if (!pattern) {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] pattern is required`);
    }
    const root = input.path != null ? String(input.path) : ctx.workdir;
    // 硬约束：搜索根绝对路径（与 file 工具一致）
    if (!root || !isAbsolute(root)) {
      return errorResult(`[${ToolErrorCode.PATH_NOT_ABSOLUTE}] path must be absolute: "${root}"`);
    }

    let rootStat;
    try {
      rootStat = await stat(root);
    } catch {
      return errorResult(`[${ToolErrorCode.NOT_FOUND}] search root not found: ${root}`);
    }
    if (!rootStat.isDirectory()) {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] search root is not a directory: ${root}`);
    }

    // pattern → RegExp（** / * / ?）
    let regex: RegExp;
    try {
      regex = globToRegExp(pattern);
    } catch {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] invalid glob pattern: ${pattern}`);
    }

    // 收集文件
    const matches: { path: string; mtime: number }[] = [];
    await walk(root, regex, root, matches, 0);

    if (matches.length === 0) {
      return textResult('(no matches)');
    }

    // mtime 倒序
    matches.sort((a, b) => b.mtime - a.mtime);
    const out = matches.map((m) => m.path).join('\n');
    return textResult(out);
  },
};

/**
 * 递归遍历目录，收集相对路径匹配 regex 的文件。
 * 默认不遵循 .gitignore（含点开头文件），对齐 overall §5.5。
 * [v0.0.345] async 化：fs.promises（libuv 线程池，不阻塞 event loop）。
 */
async function walk(
  dir: string,
  regex: RegExp,
  root: string,
  out: { path: string; mtime: number }[],
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 无权限/不存在 → 跳过
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    const rel = relative(root, full);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      await walk(full, regex, root, out, depth + 1);
    } else if (st.isFile()) {
      // 同时匹配相对路径正反斜杠风格（posix）
      if (regex.test(rel.replace(/\\/g, '/'))) {
        out.push({ path: full, mtime: st.mtimeMs });
      }
    }
  }
}

/**
 * 把 gitignore 风格 pattern 转为 RegExp。
 * 支持：双星（跨目录任意）、单星（单层任意，不含斜杠）、问号（单字符）、其他字符字面量。
 * @param pattern 如双星 斜杠 单星 .ts 或 src 双星 斜杠 单星 .js
 */
export function globToRegExp(pattern: string): RegExp {
  let rx = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string | undefined;
    if (c === undefined) break;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** 跨任意层
        rx += '.*';
        i++; // 消费第二个 *
        // 吞掉紧跟的 /
        if (pattern[i + 1] === '/') i++;
      } else {
        // * 单层（不含路径分隔）
        rx += '[^/]*';
      }
    } else if (c === '?') {
      rx += '[^/]';
    } else if ('.+^$(){}|[]\\'.includes(c)) {
      rx += '\\' + c;
    } else {
      rx += c;
    }
  }
  return new RegExp('^(?:' + rx + ')$');
}
