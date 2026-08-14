/**
 * grep 工具（正则检索）
 * 参考: specs/tech/agent/tools/[P0]file_op_tools.md §6
 *
 * 行为：
 *   - pattern 必填（正则）
 *   - path 搜索根（默认 workdir，绝对路径硬约束）
 *   - glob 文件名过滤（如 "*.js"）
 *   - ignoreCase（-i）/ lineNumber（content 模式行号）
 *   - outputMode: files_with_matches（默认）/ content / count
 *   - 无匹配 → 空结果（非错误）
 *   - 非法正则 → isError
 *
 * 实现：优先调系统 `rg`（ripgrep），不可用降级为 JS 正则遍历。
 * 默认不遵循 .gitignore（含隐藏文件）。
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from './types';
import { errorResult, textResult, ToolErrorCode } from './types';
import { globToRegExp } from './file-glob';

/** 最大递归深度（防巨型树） */
const MAX_DEPTH = 20;
/** 默认结果数上限（控 token） */
const DEFAULT_HEAD_LIMIT = 1000;

type OutputMode = 'files_with_matches' | 'content' | 'count';

/**
 * grep 工具实现（单例导出，registry 组装时引用）。
 */
export const fileGrepTool: Tool = {
  definition: {
    name: 'grep',
    description:
      'Search file contents with regex. Output modes: files_with_matches (default) / content / count. Prefers ripgrep.',
    intro: 'Search file contents by regex.',
    inputSchema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        path: { type: 'string', description: 'Search root (absolute path, default workdir)' },
        glob: { type: 'string', description: 'File name filter (e.g. "*.js")' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive (-i)' },
        lineNumber: { type: 'boolean', description: 'Show line numbers in content mode (-n)' },
        outputMode: {
          type: 'string',
          description: 'files_with_matches | content | count (default files_with_matches)',
        },
        headLimit: { type: 'integer', description: 'Max results (default 1000)' },
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
    if (!root || !isAbsolute(root)) {
      return errorResult(`[${ToolErrorCode.PATH_NOT_ABSOLUTE}] path must be absolute: "${root}"`);
    }
    const ignoreCase = input.ignoreCase === true;
    const lineNumber = input.lineNumber === true;
    const outputMode = (input.outputMode as OutputMode) ?? 'files_with_matches';
    const globFilter = input.glob != null ? String(input.glob) : null;
    const headLimit = Number(input.headLimit ?? DEFAULT_HEAD_LIMIT);

    // 预校验正则合法性（两种实现路径都需要）
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignoreCase ? 'g' : 'g');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] invalid regex: ${msg}`);
    }

    // 优先 ripgrep（更快、更准），不可用降级 JS
    if (rgAvailable()) {
      const rgOut = runRipgrep({ root, pattern, ignoreCase, lineNumber, outputMode, glob: globFilter });
      if (rgOut != null) {
        return textResult(rgOut || '(no matches)');
      }
      // rg 启动失败/超时 → 降级
    }

    // 降级：JS 遍历
    const out = await jsGrep({
      root,
      regex,
      lineNumber,
      outputMode,
      globFilter,
      headLimit,
    });
    return textResult(out || '(no matches)');
  },
};

// ============================================================
// ripgrep 实现
// ============================================================

/** rg 探测/调用超时（ms）：rg 卡死时强杀，不拖垮 worker/主线程（P3 崩溃加固） */
const RG_TIMEOUT_MS = 5000;

/** 检测 rg 是否可用（结果缓存；spawn 异常/超时 → 视为不可用，不抛 native） */
let _rgAvailable: boolean | null = null;
function rgAvailable(): boolean {
  if (_rgAvailable !== null) return _rgAvailable;
  try {
    const r = spawnSync('rg', ['--version'], { stdio: 'ignore', timeout: RG_TIMEOUT_MS });
    _rgAvailable = r.status === 0;
  } catch {
    // spawnSync 异常（rg 二进制损坏/环境异常）→ 不可用，降级 JS（不崩进程）
    _rgAvailable = false;
  }
  return _rgAvailable;
}

/** ripgrep 调用参数 */
interface RgOpts {
  root: string;
  pattern: string;
  ignoreCase: boolean;
  lineNumber: boolean;
  outputMode: OutputMode;
  glob: string | null;
}

/** 调 ripgrep，返回 stdout（成功）/ null（启动失败/超时/异常需降级） */
function runRipgrep(o: RgOpts): string | null {
  const args: string[] = [
    '--no-ignore', // 默认不遵循 .gitignore（overall §5.5）
    '--hidden',
    '--color', 'never',
  ];
  if (o.ignoreCase) args.push('-i');
  if (o.outputMode === 'files_with_matches') args.push('-l');
  else if (o.outputMode === 'count') args.push('-c');
  else if (o.lineNumber) args.push('-n'); // content 模式才加行号
  if (o.glob) args.push('-g', o.glob);
  args.push(o.pattern, o.root);

  let r: SpawnSyncReturns<string>;
  try {
    r = spawnSync('rg', args, {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: RG_TIMEOUT_MS,
    });
  } catch {
    // spawnSync 异常（rg 二进制加载失败/损坏/环境异常）→ 降级 JS（不抛 native）
    return null;
  }
  // status=1 是 rg「无匹配」的正常退出码，返回空
  if (r.error) return null; // 启动失败 → 降级
  if (r.signal) return null; // 被信号杀（含 timeout 强杀）→ 降级
  // status 0/1 都算正常，>1 是错误（此处简化：>1 也降级）
  if (r.status !== null && r.status > 1) return null;
  return r.stdout ?? '';
}

// ============================================================
// JS 降级实现
// ============================================================

interface JsOpts {
  root: string;
  regex: RegExp;
  lineNumber: boolean;
  outputMode: OutputMode;
  globFilter: string | null;
  headLimit: number;
}

/** JS 遍历实现 grep（ripgrep 不可用时降级路径）。
 * [v0.0.345] async 化：fs.promises（libuv 线程池，不阻塞 event loop）；
 * headLimit 提前终止语义不变（串行 for...of await 不改变计数顺序）。 */
async function jsGrep(o: JsOpts): Promise<string> {
  const globRe = o.globFilter ? globToRegExp(stripGlobRoot(o.globFilter)) : null;
  const lines: string[] = [];
  let emitted = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || emitted >= o.headLimit) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (emitted >= o.headLimit) return;
      const full = join(dir, ent.name);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      const base = ent.name;
      if (globRe && !globRe.test(base)) continue;

      let body: string;
      try {
        body = await readFile(full, 'utf8');
      } catch {
        continue;
      }
      const bodyLines = body.split('\n');
      const matchedIdx: number[] = [];
      for (let i = 0; i < bodyLines.length; i++) {
        const line = bodyLines[i];
        if (line === undefined) continue;
        o.regex.lastIndex = 0;
        if (o.regex.test(line)) matchedIdx.push(i);
      }
      if (matchedIdx.length === 0) continue;

      if (o.outputMode === 'files_with_matches') {
        lines.push(full);
        emitted++;
      } else if (o.outputMode === 'count') {
        lines.push(`${full}:${matchedIdx.length}`);
        emitted++;
      } else {
        // content
        for (const idx of matchedIdx) {
          if (emitted >= o.headLimit) break;
          const ln = idx + 1;
          lines.push(o.lineNumber ? `${full}:${ln}:${bodyLines[idx]}` : `${full}:${bodyLines[idx]}`);
          emitted++;
        }
      }
    }
  };

  await walk(o.root, 0);
  return lines.join('\n');
}

/** 去掉 glob 可能带的前导路径（如 "src/*.js" → "*.js"，按 basename 匹配） */
function stripGlobRoot(g: string): string {
  const idx = Math.max(g.lastIndexOf('/'), g.lastIndexOf('\\'));
  return idx >= 0 ? g.slice(idx + 1) : g;
}
