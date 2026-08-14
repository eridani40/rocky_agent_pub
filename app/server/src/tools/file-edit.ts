/**
 * edit 工具（精确字符串替换）
 * 参考: specs/tech/agent/tools/[P0]file_op_tools.md §4
 *       specs/tech/persistence/[P1]file_write_lock.md §5（加锁 + 崩溃原子 + 锁内重判）
 *
 * 行为：
 *   - filePath 必须绝对路径（相对 → isError）
 *   - 先 read 后 edit（未 read → isError）
 *   - oldString/newString 必填；oldString===newString → isError
 *   - replaceAll=false（默认）：oldString 须唯一，多处 → isError
 *   - replaceAll=true：替换所有出现
 *   - oldString 未找到 → isError
 *   - 成功后写回文件 + 记入 readSet
 *
 * 行号前缀剥离：read 输出 cat -n（行号+tab+内容），
 * 但 edit 的 oldString 应匹配真实文件内容（不带行号）。本工具直接读真实文件内容做匹配，
 * 即 oldString 传真实内容即可（不要求 LLM 手动剥离）。
 *
 * 并发原子（spec §5）：
 *   - **read-modify-write 整段入锁**：readFile → countOccurrences → 唯一性判定 → replace → atomicWriteAsync
 *     全部在同一 withFileLock 闭包内，否则 read 与 write 之间可能被另一 edit 插写改了计数（C8/C9）。
 *   - **occurrences 锁内重判（C9）**：把「统计 + 唯一性/未找到判定」移入锁闭包，防 read 时唯一、
 *     read 到 write 之间被另一 edit 插入第二次出现导致 replace 走非预期分支。
 *   - atomicWriteAsync 替换裸 writeFile，补崩溃原子（tmp→fsync→rename，fs.promises 真异步）。
 *   - 快速失败校验（绝对路径/oldString===newString/readSet）仍在锁外（不必持锁）。
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { atomicWriteAsync } from '../persistence/fs-io';
import { withFileLock } from '../persistence/file-lock';
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from './types';
import { errorResult, textResult, ToolErrorCode } from './types';

/**
 * edit 工具实现（单例导出，registry 组装时引用）。
 */
export const fileEditTool: Tool = {
  definition: {
    name: 'edit',
    description:
      'Precise string replacement in a file. Requires prior read. oldString must be unique unless replaceAll=true.',
    intro: 'Precise string replacement in a file.',
    inputSchema: {
      type: 'object',
      required: ['filePath', 'oldString', 'newString'],
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the file' },
        oldString: { type: 'string', description: 'Exact string to match (real file content, no line-number prefix)' },
        newString: { type: 'string', description: 'Replacement string (must differ from oldString)' },
        replaceAll: { type: 'boolean', description: 'Replace all occurrences (default false)' },
      },
    },
  },
  // [v0.0.130.hang] per-tool 默认超时：只读快工具，10s（见 change_plan.md 模块 A）
  defaultTimeoutMs: 10000,

  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    const filePath = String(input.filePath ?? '');
    // 硬约束：绝对路径
    if (!filePath || !isAbsolute(filePath)) {
      return errorResult(`[${ToolErrorCode.PATH_NOT_ABSOLUTE}] filePath must be absolute: "${filePath}"`);
    }
    const oldString = input.oldString;
    const newString = input.newString;
    if (typeof oldString !== 'string' || typeof newString !== 'string') {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] oldString/newString must be string`);
    }
    if (oldString === newString) {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] oldString must differ from newString`);
    }
    const replaceAll = input.replaceAll === true;

    // 先 read 后 edit
    let existingStat: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      existingStat = await stat(filePath);
    } catch {
      existingStat = undefined; // ENOENT → 不存在
    }
    if (!existingStat) {
      return errorResult(`[${ToolErrorCode.NOT_FOUND}] file not found: ${filePath}`);
    }
    if (existingStat.isDirectory()) {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] path is a directory: ${filePath}`);
    }
    if (!ctx.readSet?.has(filePath)) {
      return errorResult(
        `[${ToolErrorCode.NOT_READ}] File has not been read yet (must read before edit): ${filePath}`,
      );
    }

    // read-modify-write 整段入锁，occurrences 锁内重判（spec §5 / C8 / C9）
    // 闭包返回 discriminated union，避免用异常做控制流
    type LockedResult =
      | { kind: 'ok'; replacedCount: number }
      | { kind: 'err'; result: ToolRunResult };

    let locked: LockedResult;
    try {
      locked = await withFileLock(filePath, async (): Promise<LockedResult> => {
        // 读真实文件内容（非 cat -n 版本，直接匹配）
        let body: string;
        try {
          body = await readFile(filePath, 'utf8');
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { kind: 'err', result: errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] failed to read file: ${msg}`) };
        }
        // 锁内重判 occurrences（防 read 与 write 之间被另一 edit 插写改了计数）
        const occurrences = countOccurrences(body, oldString);
        if (occurrences === 0) {
          return {
            kind: 'err',
            result: errorResult(`[${ToolErrorCode.STRING_NOT_FOUND}] String to replace not found in ${filePath}`),
          };
        }
        if (!replaceAll && occurrences > 1) {
          return {
            kind: 'err',
            result: errorResult(
              `[${ToolErrorCode.MULTIPLE_MATCHES}] Found ${occurrences} matches (use replaceAll=true or narrow oldString): ${filePath}`,
            ),
          };
        }
        // 执行替换 + 原子写
        const next = replaceAll ? body.split(oldString).join(newString) : body.replace(oldString, newString);
        try {
          await atomicWriteAsync(filePath, next);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { kind: 'err', result: errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] failed to write file: ${msg}`) };
        }
        return { kind: 'ok', replacedCount: replaceAll ? occurrences : 1 };
      });
    } catch (e) {
      // 锁本身不会 reject（内部错误已包装为 err）；防御性兜底
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] edit failed: ${msg}`);
    }

    if (locked.kind === 'err') return locked.result;

    // 内容已变，刷新 readSet（下次 edit/write 仍需最新内容）
    ctx.readSet?.add(filePath);
    return textResult(`replaced ${locked.replacedCount} occurrence(s) in ${filePath}`);
  },
};

/**
 * 统计 substr 在 str 中非重叠出现次数。
 * 用 split 而非正则（避免 oldString 含正则元字符）。
 */
function countOccurrences(str: string, substr: string): number {
  if (substr.length === 0) return 0;
  return str.split(substr).length - 1;
}
