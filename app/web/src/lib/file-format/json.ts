/**
 * JSON format/validate 纯函数 —— 原生 JSON.parse/stringify，零依赖
 *
 * 参考:
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 B JSON 行
 *   specs/prd/version_logs/v0.0.241.md §3.2 JSON
 *
 * 关键约束：
 *   - V8（Chromium 浏览器运行时）默认不转义非 ASCII（中文保留），无需 replacer
 *   - JSONL/CSV 行号由调用方控制（1-indexed 切行），JSON 解析错误本身尽力提取 position
 *   - Bun 测试运行时的 SyntaxError message 不含 position（与 V8 不同），所以 line/col 提取
 *     仅在 V8/Chromium 下生效；提取逻辑用纯 helper 暴露便于 UT 直接验证
 */
import type { FormatResult } from '../file-format';

/**
 * 从 V8 JSON SyntaxError message 提取字符偏移 position，并换算为 line/col（1-indexed）。
 *
 * V8 message 形如：`Unexpected token } in JSON at position 23`。
 * Bun 的 message 形如：`JSON Parse error: Unexpected token ','`（无 position）—— 返回 undefined。
 *
 * 单独导出便于 UT 直接验证提取逻辑（不依赖运行时的 SyntaxError 格式差异）。
 *
 * @param errorMessage catch 到的 SyntaxError.message
 * @param text 原始被解析的文本（用于按 position 数 \n 算行号）
 */
export function extractJsonPosition(
  errorMessage: string,
  text: string,
): { line?: number; col?: number } {
  // V8: "at position N" 或 "at line N column C"（V8 也用 column 形式，两种都兼容）
  const posMatch = /at position (\d+)/.exec(errorMessage);
  if (posMatch) {
    const pos = Number(posMatch[1]);
    if (Number.isFinite(pos) && pos >= 0) {
      return posToLineCol(text, pos);
    }
  }
  const colMatch = /at line (\d+) column (\d+)/.exec(errorMessage);
  if (colMatch) {
    return { line: Number(colMatch[1]), col: Number(colMatch[2]) };
  }
  return {};
}

/** 字符偏移（0-indexed）→ {line, col}（均 1-indexed） */
function posToLineCol(text: string, pos: number): { line: number; col: number } {
  const before = text.slice(0, pos);
  const lines = before.split('\n');
  return {
    line: lines.length,
    col: lines[lines.length - 1]!.length + 1,
  };
}

/**
 * JSON 格式化：parse → stringify(obj, null, 2)（2 空格缩进）。
 * V8 默认保留中文（不转义非 ASCII）。
 */
export function formatJson(text: string): FormatResult {
  try {
    const obj = JSON.parse(text);
    return { ok: true, output: JSON.stringify(obj, null, 2) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, ...extractJsonPosition(msg, text) };
  }
}

/** JSON 校验：仅 parse 验证合法性，output 不变（不修改文本）。 */
export function validateJson(text: string): FormatResult {
  try {
    JSON.parse(text);
    return { ok: true, output: text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, ...extractJsonPosition(msg, text) };
  }
}
