/**
 * TOML format/validate 纯函数 —— `smol-toml` ^1.x
 *
 * 参考:
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 B TOML 行；§0.2 库选型
 *   specs/prd/version_logs/v0.0.241.md §3.2 TOML
 *
 * 实际 API（已 probe 确认 smol-toml 1.7.1）：
 *   - `import * as TOML` → `TOML.parse(text)` / `TOML.stringify(obj)`
 *   - `TOML.TomlError` 有 `.line` 和 `.column`（1-indexed）
 *
 * 已 probe 验证：stringify 后中文 `中文` 保留不转义。
 */
import * as TOML from 'smol-toml';
import type { FormatResult } from '../file-format';

/** 从 TOML 异常提取 line/col */
function extractTomlPosition(err: unknown): { line?: number; col?: number } {
  const e = err as { line?: number; column?: number };
  return {
    line: typeof e.line === 'number' ? e.line : undefined,
    col: typeof e.column === 'number' ? e.column : undefined,
  };
}

/** TOML 格式化：parse → stringify。 */
export function formatToml(text: string): FormatResult {
  try {
    const obj = TOML.parse(text);
    return { ok: true, output: TOML.stringify(obj) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, ...extractTomlPosition(e) };
  }
}

/** TOML 校验：仅 parse，output 不变。 */
export function validateToml(text: string): FormatResult {
  try {
    TOML.parse(text);
    return { ok: true, output: text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, ...extractTomlPosition(e) };
  }
}
