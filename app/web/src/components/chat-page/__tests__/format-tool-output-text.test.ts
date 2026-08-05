/**
 * formatToolOutputText 纯函数单测（v0.0.129 T2）
 * 参考: specs/ui/components/chat-page/_overview.md §4.9（output text JSON pretty；line233 禁整体 JSON 串）
 *
 * 覆盖：
 *   - 纯 JSON object / array → pretty
 *   - 前缀 + JSON（用户给的示例）→ 前缀保留 + pretty
 *   - JSON + 尾文本 → pretty + 尾文本
 *   - 非 JSON 纯文本 → 原样
 *   - 残缺 JSON → 原样不崩（兜底）
 *   - 嵌套对象 → 多层缩进
 *   - 空串 / 非字符串 → 原样
 *   - 字符串字面量内的括号 → 不计深度（防误闭合）
 *   - 转义引号 → 正确处理
 */
import { describe, it, expect } from 'vitest';
import { formatToolOutputText } from '../format-tool-output-text';

describe('formatToolOutputText', () => {
  it('纯 JSON object → pretty 多行缩进', () => {
    const input = `{"type":"agent","sessionId":"01KXCJY0XBJ39QHGY5FK0WV3EM"}`;
    expect(formatToolOutputText(input)).toBe(
      `{
  "type": "agent",
  "sessionId": "01KXCJY0XBJ39QHGY5FK0WV3EM"
}`,
    );
  });

  it('纯 JSON array → pretty', () => {
    expect(formatToolOutputText(`[1,2,3]`)).toBe(`[
  1,
  2,
  3
]`);
  });

  it('前缀 + JSON → 前缀保留 + pretty（用户示例）', () => {
    const out = formatToolOutputText(
      `target {"type":"agent","sessionId":"01KXCJY0XBJ39QHGY5FK0WV3EM"}`,
    );
    expect(out).toBe(
      `target {
  "type": "agent",
  "sessionId": "01KXCJY0XBJ39QHGY5FK0WV3EM"
}`,
    );
  });

  it('JSON + 尾文本 → pretty + 尾文本保留', () => {
    expect(formatToolOutputText(`{"a":1} done`)).toBe(`{
  "a": 1
} done`);
  });

  it('非 JSON 纯文本 → 原样', () => {
    const input = `hello world`;
    expect(formatToolOutputText(input)).toBe(input);
  });

  it('文本含 { 但非 JSON 起始 → 原样（无 JSON 起始符的兜底）', () => {
    // 无 { 或 [ → findJsonStart 返回 -1 → 原样
    expect(formatToolOutputText(`plain text no braces`)).toBe(`plain text no braces`);
  });

  it('残缺 JSON（未闭合）→ 原样不崩', () => {
    const input = `{"a":`;
    expect(formatToolOutputText(input)).toBe(input);
  });

  it('非法 JSON（语法错）→ 原样（JSON.parse 抛 → 兜底）', () => {
    // 闭合了但内部语法错（缺 value）
    const input = `{"a":}`;
    expect(formatToolOutputText(input)).toBe(input);
  });

  it('嵌套对象 → 多层缩进', () => {
    expect(formatToolOutputText(`{"a":{"b":1}}`)).toBe(`{
  "a": {
    "b": 1
  }
}`);
  });

  it('嵌套数组 → 多层缩进', () => {
    expect(formatToolOutputText(`{"a":[1,2]}`)).toBe(`{
  "a": [
    1,
    2
  ]
}`);
  });

  it('空串 → 原样', () => {
    expect(formatToolOutputText('')).toBe('');
  });

  it('字符串字面量内的括号 → 不计深度（防误闭合）', () => {
    // `"}"` 内的 } 不应让 depth 归零；正确闭合在外层 }
    expect(formatToolOutputText(`{"a":"}{"}`)).toBe(`{
  "a": "}{"
}`);
  });

  it('字符串内含转义引号 → 正确处理（不误退出字符串）', () => {
    const input = `{"a":"he said \\"hi\\""}`;
    expect(formatToolOutputText(input)).toBe(`{
  "a": "he said \\"hi\\""
}`);
  });

  it('JSON 含 boolean / null / number → 各类型正确 pretty', () => {
    expect(formatToolOutputText(`{"a":true,"b":null,"c":1.5}`)).toBe(`{
  "a": true,
  "b": null,
  "c": 1.5
}`);
  });

  it('空对象 / 空数组 → 紧凑（JSON.stringify 默认行为）', () => {
    expect(formatToolOutputText(`{}`)).toBe(`{}`);
    expect(formatToolOutputText(`[]`)).toBe(`[]`);
  });

  it('多个 JSON 连续 → 只 pretty 第一个（后续作尾文本保留）', () => {
    // 单 JSON 片段检测策略；连续 JSON 第二个作 tail 原样保留（不递归 pretty）
    const out = formatToolOutputText(`{"a":1}{"b":2}`);
    expect(out).toBe(`{
  "a": 1
}{"b":2}`);
  });

  it('非字符串输入 → 原样返回（运行时兜底）', () => {
    // 类型守护 + 运行时兜底（防御性，TS 已限制但运行时可能传错）
    expect(formatToolOutputText(undefined as unknown as string)).toBe(undefined);
    expect(formatToolOutputText(null as unknown as string)).toBe(null);
  });

  it('前缀含冒号 + 空格 + JSON（常见错误信息形态）→ 前缀保留', () => {
    const out = formatToolOutputText(`Error: {"code":500,"msg":"fail"}`);
    expect(out).toBe(`Error: {
  "code": 500,
  "msg": "fail"
}`);
  });
});
