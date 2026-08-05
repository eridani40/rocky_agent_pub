/**
 * TSV format/validate —— 复用 csv.ts 的 helper（分隔符 `\t`）
 *
 * 参考:
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 B TSV 行
 *   specs/prd/version_logs/v0.0.241.md §3.2 TSV
 *
 * DRY：parse/format/validate 算法与 CSV 完全一致，仅分隔符不同。
 */
import { parseCsvRows, formatRows, findRowMismatch } from './csv';
import type { FormatResult } from '../file-format';

/** TSV 格式化：parse（`\t`） → 列对齐。 */
export function formatTsv(text: string): FormatResult {
  try {
    const rows = parseCsvRows(text, '\t');
    return { ok: true, output: formatRows(rows, '\t') };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/** TSV 校验：parse（`\t`） → 首行字段数对比；output 为原文本。 */
export function validateTsv(text: string): FormatResult {
  try {
    const rows = parseCsvRows(text, '\t');
    const mismatch = findRowMismatch(rows);
    if (mismatch) {
      return { ok: false, error: mismatch.msg, line: mismatch.line };
    }
    return { ok: true, output: text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
