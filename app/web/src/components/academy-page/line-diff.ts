/**
 * line-diff —— 最小行级 diff（LCS，component-diff-viewer 专用）
 * 参考: 视觉基线沿用早期 training-result demo 的 `.diff-add / .diff-del`（行级 add sage 底 / del danger 底线划）
 *
 * 输入两侧文本，输出左（base）/ 右（cand）两侧渲染行：
 *   - 左：same（共有行）+ del（仅 base 有，线划）
 *   - 右：same + add（仅 cand 有，sage 底）
 * LCS O(n*m) 对 AGENTS.md / SKILL.md 量级（<< 500 行）足够。
 */

/** 单侧渲染行 */
export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

/** 双侧 diff 结果 */
export interface SideDiff {
  left: DiffLine[];
  right: DiffLine[];
  /** add/del 行数（summary 文案用） */
  addCount: number;
  delCount: number;
}

/** 文本 → 行数组；空串视为 0 行（''.split('\n') 会得 [''] 单空行，非调用者意图） */
function toLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/** 计算两文本的行级 diff（LCS 回溯） */
export function computeLineDiff(baseText: string, candText: string): SideDiff {
  const a = toLines(baseText);
  const b = toLines(candText);
  const n = a.length;
  const m = b.length;
  // LCS DP 表（(n+1)×(m+1)）
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  // 回溯生成双侧行
  const left: DiffLine[] = [];
  const right: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let addCount = 0;
  let delCount = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      left.push({ type: 'same', text: a[i]! });
      right.push({ type: 'same', text: b[j]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      left.push({ type: 'del', text: a[i]! });
      delCount++;
      i++;
    } else {
      right.push({ type: 'add', text: b[j]! });
      addCount++;
      j++;
    }
  }
  while (i < n) { left.push({ type: 'del', text: a[i]! }); delCount++; i++; }
  while (j < m) { right.push({ type: 'add', text: b[j]! }); addCount++; j++; }
  return { left, right, addCount, delCount };
}
