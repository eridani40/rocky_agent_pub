/**
 * natural-sort —— 自然序（numeric-aware）字符串/节点比较器
 *
 * 参考: specs/tech/version_logs/v0.0.239/change_plan.md（核心架构决策 + 变更清单行 1-2）
 *       specs/ui/components/chat-page/component-workspace-panel.md §4.X（文件排序产品规则）
 *       specs/prd/version_logs/v0.0.239/change_log.md §1（不变量）+ §2.1（排序规则）
 *
 * 设计背景：workspace 文件树顺序来自后端 readdirSync 的 OS 字节序（macOS 字典序），
 * `100.txt` 会排在 `90.txt` 之前（错）。本比较器实现 VSCode 式自然排序：
 *   - 拆交替「文字段 + 数字段」逐段比较
 *   - 文字段：字符串序（大小写不敏感，文件名 ASCII 为主）
 *   - 数字段：数值序（90 < 100）
 *   - 同值不同格式（'09' vs '9'，值都=9）：按原 digit 字符串兜底（'09' < '9' 因 '0' < '9'）
 *
 * 为何不用 `localeCompare(b, undefined, { numeric:true })`：orchestrator 实测该 API 对
 * `9.txt` vs `09.txt` 返回 0（不兜底）；用户要确定性文字兜底（D 决策基线）。本实现自定义分段。
 */

import type { WsTreeNode } from '../components/chat-page/workspace-types';

/** 单个 chunk：原 text + 是否数字段 */
interface Chunk {
  text: string;
  isDigit: boolean;
}

/** 字符 s[i] 是否为数字 [0-9]（i 越界返 false，避免 undefined 比较） */
function isDigitAt(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  // '0' = 48, '9' = 57；NaN 比较全 false（越界安全）
  return c >= 48 && c <= 57;
}

/**
 * 把字符串拆成交替的「文字段 + 数字段」chunk 序列。
 * 连续数字字符 [0-9] 归为同一数字段；其余连续非数字字符归为同一文字段。
 */
function tokenize(s: string): Chunk[] {
  const chunks: Chunk[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const isDigit = isDigitAt(s, i);
    let j = i + 1;
    while (j < n && isDigitAt(s, j) === isDigit) {
      j++;
    }
    chunks.push({ text: s.slice(i, j), isDigit });
    i = j;
  }
  return chunks;
}

/** comparator 符号归一化：把任意 <0 / >0 收敛成 -1 / 1，便于上层断言 */
function sign(x: number): number {
  return x < 0 ? -1 : x > 0 ? 1 : 0;
}

/**
 * 自然序字符串比较器。
 *
 * 逐段比较两个字符串（文字段字符串序大小写不敏感 / 数字段数值序；同值数字段按原 digit 字符串兜底）。
 * 返回 -1 / 0 / 1，符合 Array.sort comparator 契约。
 *
 * @param a 字符串 a
 * @param b 字符串 b
 * @returns a<b 返 -1，a==b 返 0（含同值不同格式已兜底区分），a>b 返 1
 */
export function compareNaturalNames(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const minLen = Math.min(ta.length, tb.length);
  for (let k = 0; k < minLen; k++) {
    // minLen = min(both lengths)，两下标必然在范围内；提取局部变量避开 noUncheckedIndexedAccess
    const ca: Chunk = ta[k]!;
    const cb: Chunk = tb[k]!;
    if (ca.isDigit && cb.isDigit) {
      // 数字段：先按数值序
      const na = Number(ca.text);
      const nb = Number(cb.text);
      if (na !== nb) return sign(na - nb);
      // 同值不同格式（'09' vs '9'）：按原 digit 字符串序兜底（与 VSCode 一致）
      if (ca.text !== cb.text) return ca.text < cb.text ? -1 : 1;
    } else if (!ca.isDigit && !cb.isDigit) {
      // 文字段：大小写不敏感字符串序
      const la = ca.text.toLowerCase();
      const lb = cb.text.toLowerCase();
      if (la !== lb) return la < lb ? -1 : 1;
    } else {
      // 类型不同（一段文字一段数字）：按原字符串序兜底，避免 locale 抖动
      if (ca.text !== cb.text) return ca.text < cb.text ? -1 : 1;
    }
  }
  // 公共前缀全等：短者在前
  return sign(ta.length - tb.length);
}

/**
 * workspace 节点比较器（reducer ingest 直接喂给 `.sort`）。
 *
 * 规则：
 *   1. 先按节点 type 分组：文件夹（`type === 'dir'`）置顶（dir < file，对齐 VSCode 默认）
 *   2. 同组内按 `compareNaturalNames(a.name, b.name)` 自然序
 *
 * @param a 节点 a
 * @param b 节点 b
 * @returns 符合 Array.sort comparator 契约的 -1 / 0 / 1
 */
export function compareWorkspaceNodes(a: WsTreeNode, b: WsTreeNode): number {
  const aIsDir = a.type === 'dir';
  const bIsDir = b.type === 'dir';
  if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
  return compareNaturalNames(a.name, b.name);
}
