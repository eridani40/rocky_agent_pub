/**
 * format-tool-output-text —— 工具 output 文本中的 JSON 片段 pretty 多行缩进展示
 * 参考: specs/ui/components/chat-page/_overview.md §4.9（output text 块；line233 禁整体
 *   JSON 串/灰底代码框——只在 value cell 内 mono + whitespace-pre-wrap 多行）
 *
 * 职责：纯函数，把 text 中嵌入的 JSON 片段检测并 pretty 多行缩进，
 *   保留 JSON 前的非 JSON 前缀（如 `target `）和 JSON 后的尾文本。
 *   用于 output text 块（tool_result content）+ input arguments 的 string 值（detect 片段并 pretty）；
 *   input 的 object/array 值则直接用 `JSON.stringify(v, null, 2)`，不走本函数。
 *
 * 检测策略（启发式 + 兜底原样返回，绝不破坏展示）：
 *   1. 纯 JSON（首字符是 {/[ 且整段 parse 成功）→ 整体 pretty
 *   2. 前缀 + JSON（找首个 {/[ 起 parse 子串成功）→ 前缀 + pretty
 *   3. JSON + 尾文本（JSON 后还有非空字符）→ pretty + 尾文本（原样保留）
 *   4. 非 JSON / parse 失败 / 残缺括号 → 原样返回
 *
 * 边界处理：
 *   - 字符串字面量内的括号不计入深度（避免 `"}` 误闭合）
 *   - 转义字符（`\"`、`\\`）正确跳过
 *   - 嵌套同型括号正确计数（异型如 `[` 内的 `{` 不影响 outer 深度）
 */

/**
 * 把 text 中首个 JSON 片段（{...} 或 [...]）pretty 多行缩进；前后非 JSON 文本保留。
 * 失败兜底：原样返回（不抛、不破坏展示）。
 *
 * @param text tool_result content 的 text 块原文（可能含 JSON / 纯文本 / 混合）
 * @returns pretty 后的文本（失败兜底原样）
 */
export function formatToolOutputText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;

  const startIdx = findJsonStart(text);
  if (startIdx === -1) return text; // 无 JSON 起始符 → 原样

  const prefix = text.slice(0, startIdx);
  const rest = text.slice(startIdx);

  const endIdx = findJsonEnd(rest);
  if (endIdx === -1) return text; // 残缺未闭合 → 原样（避免错误截断）

  const jsonStr = rest.slice(0, endIdx + 1);
  const tail = rest.slice(endIdx + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return text; // parse 失败（非法 JSON）→ 原样
  }

  const pretty = JSON.stringify(parsed, null, 2);
  return prefix + pretty + tail;
}

/** 找首个 { 或 [ 位置（无则 -1） */
function findJsonStart(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{' || ch === '[') return i;
  }
  return -1;
}

/**
 * 从 rest[0] 起（必须是 { 或 [）扫描平衡闭合位置，返回 rest 内闭合 index；残缺返回 -1。
 * 处理：字符串字面量内的括号不计、`\` 转义下一字符、嵌套同型括号计数。
 */
function findJsonEnd(rest: string): number {
  if (rest.length === 0) return -1;
  const open = rest[0];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (inString) {
      if (ch === '\\') {
        i++; // 跳过被转义字符（避免内嵌 " 误退出字符串）
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1; // 残缺（未闭合）
}
