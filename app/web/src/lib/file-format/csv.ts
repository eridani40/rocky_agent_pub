/**
 * CSV format/validate + 共享 helper（TSV 也复用本文件的 helper）
 *
 * 参考:
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 B CSV 行
 *   specs/prd/version_logs/v0.0.241.md §3.2 CSV；UC-241-CSV-FMT（列对齐 + 行列校验）
 *
 * 约定：
 *   - RFC 4180：`"..."` 引号包裹 + `""` 转义 + 分隔符（`,`）
 *   - 支持字段内换行（引号包裹的多行字段）
 *   - 列对齐：每列按最长（escape 后）字段宽度 padEnd，join 用分隔符
 *   - 失败行号 1-indexed（首行字段数 K 对比，不一致报「第 N 行字段数为 M，与首行 K 不符」）
 *
 * TSV 复用：tsv.ts 调用 `parseCsvRows(text, '\t')` + `formatRows` + `findRowMismatch`（同算法不同分隔符）。
 */
import type { FormatResult } from '../file-format';

/**
 * RFC 4180 CSV 字段解析器。按行返回字段数组。
 *
 * @param text 原始文本
 * @param delim 分隔符（CSV 用 `,`，TSV 用 `\t`）
 * @returns string[][] —— 每行一个 string[]（字段列表）；空文本返回 []
 */
export function parseCsvRows(text: string, delim: string): string[][] {
  // 统一换行：\r\n / \r → \n
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldTouched = false; // 本字段是否已被「触碰」（出现非分隔符字符或引号）

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (inQuotes) {
      if (ch === '"') {
        // 双引号转义
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      fieldTouched = true;
      continue;
    }
    if (ch === delim) {
      current.push(field);
      field = '';
      fieldTouched = false;
      continue;
    }
    if (ch === '\n') {
      current.push(field);
      rows.push(current);
      current = [];
      field = '';
      fieldTouched = false;
      continue;
    }
    field += ch;
    fieldTouched = true;
  }
  // 末行无尾换行：若有内容/字段被触碰，补一行
  if (fieldTouched || field !== '' || current.length > 0) {
    current.push(field);
    rows.push(current);
  }
  return rows;
}

/** 字段按需重新加引号（含分隔符/引号/换行 → 用 `"..."` 包裹并 `""` 转义） */
function escapeCell(cell: string, delim: string): string {
  if (cell.includes(delim) || cell.includes('"') || cell.includes('\n')) {
    return '"' + cell.replace(/"/g, '""') + '"';
  }
  return cell;
}

/**
 * 列对齐：每列按最长（escape 后）字段宽度 padEnd，join 分隔符。
 * 不改变字段数（仅空格填充）；含特殊字符的字段会被重新加引号（RFC 4180 安全）。
 * 末列右侧无对齐目标，trimEnd 去掉 pad 引入的尾部空白（防 git diff/trailing whitespace 噪音）。
 */
export function formatRows(rows: string[][], delim: string): string {
  if (rows.length === 0) return '';
  const escaped = rows.map((r) => r.map((c) => escapeCell(c, delim)));
  const maxCols = escaped.reduce((m, r) => Math.max(m, r.length), 0);
  const widths: number[] = [];
  for (let c = 0; c < maxCols; c++) {
    widths[c] = escaped.reduce((m, r) => Math.max(m, r[c]?.length ?? 0), 0);
  }
  return escaped
    .map((row) =>
      row.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join(delim).trimEnd(),
    )
    .join('\n');
}

/** 行字段数不一致信息（首行 K 对比）；一致返 null */
export function findRowMismatch(
  rows: string[][],
): { line: number; msg: string } | null {
  if (rows.length <= 1) return null;
  const k = rows[0]!.length;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.length !== k) {
      return {
        line: i + 1,
        msg: `第 ${i + 1} 行字段数为 ${row.length}，与首行 ${k} 不符`,
      };
    }
  }
  return null;
}

/** CSV 格式化：parse → 列对齐。 */
export function formatCsv(text: string): FormatResult {
  try {
    const rows = parseCsvRows(text, ',');
    return { ok: true, output: formatRows(rows, ',') };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/** CSV 校验：parse → 首行字段数对比；output 为原文本（不改写）。 */
export function validateCsv(text: string): FormatResult {
  try {
    const rows = parseCsvRows(text, ',');
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
