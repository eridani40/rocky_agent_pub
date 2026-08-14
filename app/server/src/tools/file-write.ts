/**
 * write 工具（新建文件 / 全量重写）
 * 参考: specs/tech/agent/tools/[P0]file_op_tools.md §3
 *       specs/tech/persistence/[P1]file_write_lock.md §5（加锁 + 崩溃原子）
 *
 * 行为：
 *   - filePath 必须绝对路径（相对 → isError）
 *   - 覆盖已存在文件前须先 read（防盲改）：文件已存在且不在 ctx.readSet → isError
 *   - 新建文件无此约束
 *   - 覆盖语义：已存在则整体覆盖（非追加/合并）
 *   - 父目录不存在 → 自动 mkdir -p（recursive）：新建文件时若父目录缺失自动建链
 *     （已存在目录 no-op，对既有调用方兼容）
 *   - 成功后写入 ctx.readSet（新内容已「读过」语义）
 *
 * 并发原子（spec §5）：
 *   - 写动作包进 withFileLock(filePath, async () => atomicWriteAsync(...))，同 path 并发写 FIFO 串行。
 *   - atomicWriteAsync 替换裸 writeFile，补崩溃原子（tmp→fsync→rename，fs.promises 真异步）。
 */
import { mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { atomicWriteAsync } from '../persistence/fs-io';
import { withFileLock } from '../persistence/file-lock';
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from './types';
import { errorResult, textResult, ToolErrorCode } from './types';

/**
 * write 工具实现（单例导出，registry 组装时引用）。
 */
export const fileWriteTool: Tool = {
  definition: {
    name: 'write',
    description:
      'Create a new file or fully overwrite an existing one. Overwriting an existing file requires a prior read.',
    intro: 'Create a new file or fully overwrite an existing one.',
    inputSchema: {
      type: 'object',
      required: ['filePath', 'content'],
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the file' },
        content: { type: 'string', description: 'Full file content (not a diff)' },
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
    const content = input.content;
    if (typeof content !== 'string') {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] content must be string`);
    }

    // 已存在校验：覆盖前须先 read
    let existingStat: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      existingStat = await stat(filePath);
    } catch {
      existingStat = undefined; // ENOENT → 视为不存在（新建路径）
    }
    if (existingStat) {
      if (existingStat.isDirectory()) {
        return errorResult(`[${ToolErrorCode.INVALID_INPUT}] path is a directory: ${filePath}`);
      }
      // 不在 readSet → 防盲改
      if (!ctx.readSet?.has(filePath)) {
        return errorResult(
          `[${ToolErrorCode.NOT_READ}] File has not been read yet (must read before overwrite): ${filePath}`,
        );
      }
    } else {
      // 新建文件：父目录不存在 → 自动 mkdir -p（见顶部行为说明）
      const parent = dirname(filePath);
      try {
        await stat(parent);
      } catch {
        // 父目录不存在 → 递归建链
        try {
          await mkdir(parent, { recursive: true });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] failed to create parent dir ${parent}: ${msg}`);
        }
      }
    }

    try {
      // 写动作入锁（同 path 并发 FIFO 串行）+ 原子写（崩溃原子）
      await withFileLock(filePath, async () => {
        await atomicWriteAsync(filePath, content);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] failed to write file: ${msg}`);
    }

    // 写入即「已知最新内容」，记入 readSet（后续 edit/write 可直接覆盖）
    ctx.readSet?.add(filePath);

    return textResult(`wrote ${content.length} bytes to ${filePath}`);
  },
};
