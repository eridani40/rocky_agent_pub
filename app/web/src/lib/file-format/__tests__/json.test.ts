/**
 * json.ts 单测 —— formatJson/validateJson + extractJsonPosition 纯 helper
 *
 * 参考:
 *   states/v0.0.241/verify/test-plan.md（UC-241-JSON-FULL）
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 B JSON 行
 *
 * 注意：Bun 测试运行时的 JSON.parse SyntaxError message 不含 position（V8 才有），
 * 所以集成测试只断言 ok:false + error 非空；extractJsonPosition 用模拟的 V8 message
 * 直接验证提取逻辑（运行时无关）。
 */
import { describe, it, expect } from 'vitest';
import { formatJson, validateJson, extractJsonPosition } from '../json';

describe('formatJson — 成功', () => {
  it('紧凑 JSON → 2 空格缩进 pretty', () => {
    const out = formatJson('{"a":1,"b":2}');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.output).toBe('{\n  "a": 1,\n  "b": 2\n}');
    }
  });

  it('嵌套对象缩进正确', () => {
    const out = formatJson('{"x":{"y":[1,2]}}');
    expect(out.ok).toBe(true);
    if (out.ok) {
      const expected = ['{', '  "x": {', '    "y": [', '      1,', '      2', '    ]', '  }', '}'].join('\n');
      expect(out.output).toBe(expected);
    }
  });

  it('中文保留不转义（V8 默认行为）', () => {
    const out = formatJson('{"name":"中文","desc":"测试"}');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.output).toContain('"name": "中文"');
      expect(out.output).toContain('"desc": "测试"');
      // 不应出现 \u 转义
      expect(out.output).not.toContain('\\u');
    }
  });

  it('已是 pretty 格式 → 幂等（再 format 不变）', () => {
    const pretty = '{\n  "a": 1\n}';
    const out = formatJson(pretty);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).toBe(pretty);
  });
});

describe('formatJson — 失败', () => {
  it('非法 JSON → ok:false + error 非空', () => {
    const out = formatJson('{a:}');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBeTruthy();
      expect(typeof out.error).toBe('string');
    }
  });

  it('空字符串 → 失败', () => {
    const out = formatJson('');
    expect(out.ok).toBe(false);
  });

  it('尾随逗号 → 失败', () => {
    const out = formatJson('{"a":1,}');
    expect(out.ok).toBe(false);
  });
});

describe('validateJson — 成功（output = 原文不改写）', () => {
  it('合法 JSON → ok:true + output 与输入一致', () => {
    const text = '{"a":1}';
    const out = validateJson(text);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).toBe(text);
  });

  it('合法 pretty JSON → output 不变', () => {
    const text = '{\n  "a": 1\n}';
    const out = validateJson(text);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).toBe(text);
  });
});

describe('validateJson — 失败', () => {
  it('非法 JSON → ok:false（不抛异常）', () => {
    const out = validateJson('{bad}');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBeTruthy();
  });
});

describe('extractJsonPosition — 纯 helper（V8 message 格式）', () => {
  it('V8 "at position N" 格式 → 算 line/col（1-indexed）', () => {
    // text = '{\n  "b":,}' —— position 8 是 ','，在第 2 行第 7 列（1-indexed）
    const text = '{\n  "b":,}';
    const result = extractJsonPosition('Unexpected token , in JSON at position 8', text);
    expect(result.line).toBe(2);
    expect(result.col).toBe(7);
  });

  it('单行错误 → line:1', () => {
    // text = '{"a":,}' —— position 5 是 ','，第 1 行第 6 列
    const text = '{"a":,}';
    const result = extractJsonPosition('Unexpected token , in JSON at position 5', text);
    expect(result.line).toBe(1);
    expect(result.col).toBe(6);
  });

  it('V8 "at line N column C" 格式 → 直接提取', () => {
    const result = extractJsonPosition('Unexpected token } in JSON at line 3 column 5', '{}');
    expect(result.line).toBe(3);
    expect(result.col).toBe(5);
  });

  it('Bun message（无 position）→ 返回空对象', () => {
    const result = extractJsonPosition("JSON Parse error: Unexpected token ','", '{}');
    expect(result.line).toBeUndefined();
    expect(result.col).toBeUndefined();
  });
});
