/**
 * xml.ts 单测 —— formatXml（宽容）+ validateXml（严格 XMLValidator）+ 中文保留 + 属性保留
 *
 * 参考:
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 B XML 行；§0.2 库选型
 *   specs/prd/version_logs/v0.0.241.md §3.2 XML
 *
 * 注意：fast-xml-parser 的 XMLParser 是「宽容」解析（`<unclosed>` 当自闭合）；
 * format 接受略微不规范的输入以尽量产出，validate 用 XMLValidator 严格校验。
 */
import { describe, it, expect } from 'vitest';
import { formatXml, validateXml } from '../xml';

describe('formatXml — 成功', () => {
  it('单行 XML → 2 空格缩进 pretty', () => {
    const out = formatXml('<root><child>text</child></root>');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.output).toContain('<root>');
      expect(out.output).toContain('  <child>text</child>');
      expect(out.output).toContain('</root>');
    }
  });

  it('嵌套 XML 缩进', () => {
    const out = formatXml('<a><b><c>1</c></b></a>');
    expect(out.ok).toBe(true);
    if (out.ok) {
      const lines = out.output.split('\n');
      expect(lines.some((l) => l.includes('<c>1</c>') && l.startsWith('    '))).toBe(true);
    }
  });

  it('中文内容保留不转义', () => {
    const out = formatXml('<root><child>文本</child></root>');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.output).toContain('文本');
      expect(out.output).not.toContain('&#'); // 不应实体转义
    }
  });

  it('属性保留（ignoreAttributes:false）', () => {
    const out = formatXml('<root attr="v"><child/></root>');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.output).toContain('attr="v"');
    }
  });
});

describe('formatXml — 宽容解析（不严格）', () => {
  it('XMLParser 宽容：未闭合标签被当自闭合（不报错）', () => {
    // format 是「尽量产出」，不做严格校验；validate 才识别未闭合
    const out = formatXml('<unclosed>');
    expect(out.ok).toBe(true);
  });
});

describe('validateXml — 成功（output = 原文）', () => {
  it('合法 XML → ok:true + output 不变', () => {
    const text = '<root><child>text</child></root>';
    const out = validateXml(text);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).toBe(text);
  });

  it('自闭合 + 属性 → ok', () => {
    const out = validateXml('<root attr="v"><child/></root>');
    expect(out.ok).toBe(true);
  });
});

describe('validateXml — 失败带 line/col（XMLValidator 严格）', () => {
  it('未闭合标签 → ok:false + line/col', () => {
    const out = validateXml('<unclosed>');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBeTruthy();
      expect(out.line).toBeDefined();
      expect(out.col).toBeDefined();
    }
  });

  it('错配闭合标签 → ok:false', () => {
    const out = validateXml('<a><b></a></b>');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.line).toBeDefined();
    }
  });

  it('非 XML 字符 → ok:false', () => {
    const out = validateXml('{not xml}');
    expect(out.ok).toBe(false);
  });
});
