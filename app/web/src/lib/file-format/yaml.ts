/**
 * YAML format/validate 纯函数 —— 已装 `yaml` ^2.9.0
 *
 * 参考:
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 B YAML 行
 *   specs/prd/version_logs/v0.0.241.md §3.2 YAML；UC-241-YAML-FMT
 *
 * 关键点：
 *   - stringify 用 `{ indent: 2, lineWidth: 0 }`（block 风格，防长字符串 flow 折叠）
 *   - 错误的 `err.linePos` 是 [{line,col}, {line,col}]（start/end），取 start
 */
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type { FormatResult } from '../file-format';

/** 从 YAML 异常提取 line/col（linePos[0] = start） */
function extractYamlPosition(err: unknown): { line?: number; col?: number } {
  const lp = (err as { linePos?: Array<{ line: number; col: number }> }).linePos;
  if (Array.isArray(lp) && lp.length > 0 && lp[0]) {
    return { line: lp[0].line, col: lp[0].col };
  }
  return {};
}

/** YAML 格式化：parse → stringify（block 风格，2 空格缩进）。 */
export function formatYaml(text: string): FormatResult {
  try {
    const obj = yamlParse(text);
    return { ok: true, output: yamlStringify(obj, { indent: 2, lineWidth: 0 }) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, ...extractYamlPosition(e) };
  }
}

/** YAML 校验：仅 parse，output 不变。 */
export function validateYaml(text: string): FormatResult {
  try {
    yamlParse(text);
    return { ok: true, output: text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, ...extractYamlPosition(e) };
  }
}
