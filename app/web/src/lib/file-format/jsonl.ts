/**
 * JSONL format/validate 纯函数 —— 逐行 JSON.parse/stringify
 *
 * 参考:
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 B JSONL 行
 *   specs/prd/version_logs/v0.0.241.md §3.2 JSONL；UC-241-JSONL-LINE（行级报错）
 *
 * 约定：
 *   - 按 `\n` 切行；空行跳过（不报错，允许文件末尾空行）
 *   - 每行紧凑输出 `JSON.stringify(obj)`（无缩进，保「一行一对象」语义）
 *   - 失败报 `line: i+1`（1-indexed）
 */
import type { FormatResult } from '../file-format';

/** 把文本切成非空行（保留行号信息：返回 [{line, text}, ...]，line 1-indexed） */
function splitLines(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '') continue; // 空行跳过
    out.push({ line: i + 1, text: raw });
  }
  return out;
}

/**
 * JSONL 格式化：逐行 parse + 紧凑 stringify + `\n` 拼接。
 * 失败报 line = 出错行号（1-indexed）。
 */
export function formatJsonl(text: string): FormatResult {
  const lines = splitLines(text);
  const out: string[] = [];
  for (const { line, text: raw } of lines) {
    try {
      const obj = JSON.parse(raw);
      out.push(JSON.stringify(obj));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `第 ${line} 行: ${msg}`, line };
    }
  }
  return { ok: true, output: out.join('\n') };
}

/** JSONL 校验：逐行 parse，不重写输出（output = 原文）。 */
export function validateJsonl(text: string): FormatResult {
  const lines = splitLines(text);
  for (const { line, text: raw } of lines) {
    try {
      JSON.parse(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `第 ${line} 行: ${msg}`, line };
    }
  }
  return { ok: true, output: text };
}
