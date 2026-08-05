/**
 * primitive-markdown-gfm-table —— GFM 表格解析（纯函数 helper）
 * 参考: specs/prd/version_logs/v0.0.63.ui_opt.md §3.2（F2 表格需求 + UC-3.2.1/2/3）
 *
 * 从 primitive-markdown-view.tsx 拆出（保持主文件 ≤300 行）。
 * 全部纯函数 + 闭合正则，无副作用，可直接单测。
 */

// 表头行：首尾 |，中间任意（至少 1 列）
export const TABLE_HEADER_RE = /^\s*\|.*\|\s*$/;
// 分隔行：首尾 |，中间仅 : | - 空白（每段 --- / :--- / ---: / :---:）
export const TABLE_SEPARATOR_RE = /^\s*\|[\s:|-]+\|\s*$/;

/** 切分表格行为单元格（去首尾 |，按 | 切） */
export function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  return trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
}

/** 校验分隔单元格：--- / :--- / ---: / :---: （≥3 个 - + 可选前后冒号） */
export function isValidSeparatorCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell.trim());
}

/** 解析对齐标记 → textAlign 值（默认 left） */
export function parseAlignment(cell: string): 'left' | 'right' | 'center' {
  const s = cell.trim();
  const left = s.startsWith(':');
  const right = s.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

/** GFM 表格解析结果。null = 非合法表格（调用方按段落渲染）。 */
export interface GfmTable {
  headerCells: string[];
  alignments: Array<'left' | 'right' | 'center'>;
  dataRows: string[][];
  nextIdx: number;
}

/**
 * 尝试解析 GFM 表格。3 段匹配：(1) 表头 + (2) 分隔行 + (3) 0..N 数据行。
 * 校验：表头/分隔行列数一致；分隔单元格全合法（--- ≥3）。
 * 返回 null → 非合法表格，调用方按段落渲染（UC-3.2.3 不崩）。
 */
export function tryParseGfmTable(lines: string[], startIdx: number): GfmTable | null {
  const headerLine = lines[startIdx];
  const sepLine = lines[startIdx + 1];
  if (headerLine === undefined || sepLine === undefined) return null;
  if (!TABLE_HEADER_RE.test(headerLine)) return null;
  if (!TABLE_SEPARATOR_RE.test(sepLine)) return null;

  const headerCells = splitTableRow(headerLine);
  const sepCells = splitTableRow(sepLine);
  // 列数一致 + 每段合法（≥3 个 -）
  if (sepCells.length !== headerCells.length) return null;
  if (!sepCells.every(isValidSeparatorCell)) return null;
  const alignments = sepCells.map(parseAlignment);

  // 收集数据行（遇非表头形式即停）
  const dataRows: string[][] = [];
  let j = startIdx + 2;
  while (j < lines.length) {
    const ln = lines[j];
    if (ln === undefined || !TABLE_HEADER_RE.test(ln)) break;
    const cells = splitTableRow(ln);
    // 列数宽容：少补空 / 多截断（不崩）
    while (cells.length < headerCells.length) cells.push('');
    if (cells.length > headerCells.length) cells.length = headerCells.length;
    dataRows.push(cells);
    j++;
  }
  return { headerCells, alignments, dataRows, nextIdx: j };
}

/** 段落 break 用：当前行 + 下一行是否构成**合法**表格起始（防段落吃掉表头）。
 *  必须校验分隔单元格合法性 + 表头/分隔行列数一致——否则非法表格（如 `| - |`）
 *  会让段落 break 后无法推进 i，导致无限循环（F2 bug 修复）。 */
export function isTableStartHere(lines: string[], idx: number): boolean {
  const cur = lines[idx];
  const nxt = lines[idx + 1];
  if (cur === undefined || nxt === undefined) return false;
  if (!TABLE_HEADER_RE.test(cur) || !TABLE_SEPARATOR_RE.test(nxt)) return false;
  const sepCells = splitTableRow(nxt);
  if (!sepCells.every(isValidSeparatorCell)) return false;
  return splitTableRow(cur).length === sepCells.length;
}
