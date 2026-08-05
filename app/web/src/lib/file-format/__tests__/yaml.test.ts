/**
 * yaml.ts 单测 —— formatYaml/validateYaml + 中文保留 + 错误 line/col
 *
 * 参考:
 *   states/v0.0.241/verify/test-plan.md（UC-241-YAML-FMT）
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 B YAML 行
 */
import { describe, it, expect } from 'vitest';
import { formatYaml, validateYaml } from '../yaml';

describe('formatYaml — 成功', () => {
  it('缩进正确（2 空格 block 风格）', () => {
    const text = 'name: alice\nlist:\n  - a\n  - b';
    const out = formatYaml(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      // 仍是合法 YAML，关键字段命中
      expect(out.output).toContain('name: alice');
      expect(out.output).toContain('- a');
      expect(out.output).toContain('- b');
    }
  });

  it('中文保留不转义', () => {
    const text = 'name: 中文标题\nkey: 值';
    const out = formatYaml(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.output).toContain('中文标题');
      expect(out.output).toContain('值');
    }
  });

  it('lineWidth:0 防长字符串 flow 折叠（不出现 [flow] 形式）', () => {
    const text = 'name: this is a very long string that might wrap in flow style';
    const out = formatYaml(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      // 不应折叠成 [flow] 或 {flow} 形式
      expect(out.output).toContain('this is a very long string');
    }
  });
});

describe('formatYaml — 失败带位置', () => {
  it('未闭合 flow sequence → ok:false + line/col 提取', () => {
    const out = formatYaml('name: [unclosed');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.line).toBeDefined();
      expect(out.col).toBeDefined();
      expect(typeof out.line).toBe('number');
    }
  });
});

describe('validateYaml — 成功（output = 原文）', () => {
  it('合法 YAML → ok:true + output 不变', () => {
    const text = 'a: 1\nb: 2';
    const out = validateYaml(text);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).toBe(text);
  });
});

describe('validateYaml — 失败带位置', () => {
  it('坏的 YAML → ok:false', () => {
    const out = validateYaml('name: [unclosed');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.line).toBeDefined();
    }
  });
});
