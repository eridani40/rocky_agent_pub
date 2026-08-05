/**
 * jsonl.ts 单测 —— 逐行 format/validate + 行号反馈
 *
 * 参考:
 *   states/v0.0.241/verify/test-plan.md（UC-241-JSONL-LINE 行级报错）
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 B JSONL 行
 */
import { describe, it, expect } from 'vitest';
import { formatJsonl, validateJsonl } from '../jsonl';

describe('formatJsonl — 成功', () => {
  it('每行紧凑 stringify + \\n 拼接', () => {
    const text = '{"a":1}\n{"a":2}\n{"a":3}';
    const out = formatJsonl(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      // 已经紧凑时幂等
      expect(out.output).toBe('{"a":1}\n{"a":2}\n{"a":3}');
    }
  });

  it('带额外空格的合法 JSONL → 紧凑输出', () => {
    // 注意：JSONL 严格要求「一行一 JSON」，pretty 多行 JSON 不是合法 JSONL
    const text = '{"a": 1}\n{"b": 2}';
    const out = formatJsonl(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.output).toBe('{"a":1}\n{"b":2}');
    }
  });

  it('空行跳过（不报错）', () => {
    const text = '{"a":1}\n\n\n{"b":2}\n';
    const out = formatJsonl(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.output).toBe('{"a":1}\n{"b":2}');
    }
  });

  it('单行 JSONL', () => {
    const out = formatJsonl('{"only":true}');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).toBe('{"only":true}');
  });
});

describe('formatJsonl — 失败带行号', () => {
  it('UC-241-JSONL-LINE：第 2 行坏 → line:2', () => {
    const text = '{"a":1}\n{bad}\n{"a":3}';
    const out = formatJsonl(text);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.line).toBe(2);
      expect(out.error).toContain('第 2 行');
    }
  });

  it('第 3 行坏 → line:3', () => {
    const text = '{"a":1}\n{"b":2}\n{"c":,}';
    const out = formatJsonl(text);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.line).toBe(3);
  });
});

describe('validateJsonl — 成功（output = 原文）', () => {
  it('合法 JSONL → ok:true + output 不变', () => {
    const text = '{"a":1}\n{"b":2}';
    const out = validateJsonl(text);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).toBe(text);
  });

  it('带空行的合法 JSONL → ok', () => {
    const out = validateJsonl('{"a":1}\n\n{"b":2}');
    expect(out.ok).toBe(true);
  });
});

describe('validateJsonl — 失败带行号', () => {
  it('改坏第 2 行 → line:2', () => {
    const out = validateJsonl('{"a":1}\n{broken}');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.line).toBe(2);
      expect(out.error).toContain('第 2 行');
    }
  });
});
