/**
 * read 工具（读文件，cat -n 风格）
 * 参考: specs/tech/agent/tools/[P0]file_op_tools.md §2
 *
 * 行为：
 *   - filePath 必须绝对路径（相对 → isError）
 *   - 文本输出 cat -n 格式（行号 + tab + 内容），行号从 1
 *   - 支持 offset（起始行，从 1）/ limit（行数上限，默认 2000）
 *   - 目录 → isError（read 不能列目录）
 *   - 不存在 → isError
 *   - 空文件 → 提示而非内容
 *   - 仅支持文本（图片/PDF/notebook 留后续版本）
 *
 * 成功后写入 ctx.readSet，供 write/edit 的「先 read」校验使用。
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from './types';
import { errorResult, textResult, ToolErrorCode } from './types';

/** 默认读取行数上限（对齐 file_op_tools §2） */
const DEFAULT_LIMIT = 2000;

/**
 * read 工具实现（单例导出，registry 组装时引用）。
 */
export const fileReadTool: Tool = {
  definition: {
    name: 'read',
    description:
      'Read a text file. Output is cat -n style (line number + tab + content). Supports offset/limit for pagination.',
    intro: 'Read a text file.',
    inputSchema: {
      type: 'object',
      required: ['filePath'],
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the file' },
        offset: { type: 'integer', description: 'Starting line number (1-based), default 1' },
        limit: { type: 'integer', description: `Max lines to read, default ${DEFAULT_LIMIT}` },
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

    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      return errorResult(`[${ToolErrorCode.NOT_FOUND}] file not found: ${filePath}`);
    }
    // 目录 → 不支持（read 不列目录）
    if (stat.isDirectory()) {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] path is a directory (read cannot list): ${filePath}`);
    }

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] failed to read file: ${msg}`);
    }

    // 空文件 → 提示而非 cat -n 空输出
    if (raw.length === 0) {
      ctx.readSet?.add(filePath);
      return textResult(`<file is empty: ${filePath}>`);
    }

    // 切行 → cat -n 格式
    const lines = raw.split('\n');
    // 末尾换行会产出空串尾元素，保留原内容语义（cat -n 也保留）
    const offset = Math.max(1, Number(input.offset ?? 1));
    const limit = Number(input.limit ?? DEFAULT_LIMIT);
    const startIdx = offset - 1; // 转 0-based

    // offset 越界保护：startIdx ≥ lines.length 时 slice 返 []，textResult('') 会发出
    // 空 text content block → 撞 Anthropic 400 "text content is empty"。
    // 报给 LLM 的「实际行数」按内容行计（尾换行产生的尾空串不算）。
    if (startIdx >= lines.length) {
      const contentLineCount = lines.length - (raw.endsWith('\n') ? 1 : 0);
      return errorResult(
        `[${ToolErrorCode.INVALID_INPUT}] offset ${offset} out of range (file has ${contentLineCount} line${contentLineCount === 1 ? '' : 's'}): ${filePath}`,
      );
    }

    const slice = lines.slice(startIdx, startIdx + limit);

    // cat -n：行号右对齐若干位 + tab + 内容；这里用简版「行号 + tab」
    const numbered = slice
      .map((line, i) => `${startIdx + i + 1}\t${line}`)
      .join('\n');

    // 成功 → 记入 readSet（write/edit 的先 read 校验依赖）
    ctx.readSet?.add(filePath);

    return textResult(numbered);
  },
};
