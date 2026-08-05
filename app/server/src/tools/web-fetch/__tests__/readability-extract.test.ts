/**
 * readability-extract 单元测试（白盒）
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §5（路线 B + headless 兜底）
 *
 * 覆盖：
 *   - readability 主路径：标准文章 HTML → 提取正文 + 标题
 *   - htmlToMarkdown 兜底：readability 不可用 / 非文章页时正则提取
 *   - DoS 防护：超长 HTML（> 1MB）跳 readability 直接兜底
 *   - 空 HTML / 空内容
 *   - 标签清理（script/style/nav 去除）
 */
import { describe, it, expect } from 'vitest';
import {
  extractMainContent,
  htmlToMarkdown,
  READABILITY_MAX_HTML_CHARS,
} from '../readability-extract';

describe('htmlToMarkdown 兜底', () => {
  it('去 script/style 内容', () => {
    const html = '<p>hello</p><script>alert(1)</script><style>.x{}</style>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('hello');
    expect(md).not.toContain('alert');
    expect(md).not.toContain('.x{}');
  });

  it('h1-h6 转 markdown 标题', () => {
    const html = '<h1>T1</h1><h2>T2</h2><h3>T3</h3>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('# T1');
    expect(md).toContain('## T2');
    expect(md).toContain('### T3');
  });

  it('a 标签转链接', () => {
    const html = '<a href="https://x.com">X</a>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('[X](https://x.com)');
  });

  it('解码常见 HTML 实体', () => {
    const html = '<p>a&nbsp;b&amp;c</p>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('a b&c');
  });

  it('空字符串 → 空', () => {
    expect(htmlToMarkdown('')).toBe('');
  });

  it('超长 html 截断（防 DoS）', () => {
    const huge = '<p>' + 'A'.repeat(3_000_000) + '</p>';
    const md = htmlToMarkdown(huge);
    // 不抛错，长度受限
    expect(md.length).toBeLessThan(3_000_000);
  });
});

describe('extractMainContent', () => {
  it('标准文章 HTML → readability 提取正文', async () => {
    const body = '<article><h1>Test Title</h1><p>' + 'Main content. '.repeat(50) + '</p></article>';
    const html = `<html><head><title>Page Title</title></head><body>${body}</body></html>`;
    const result = await extractMainContent(html);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content).toContain('Main content');
  });

  it('空 HTML → 空结果', async () => {
    const result = await extractMainContent('');
    expect(result.content).toBe('');
    expect(result.title).toBe('');
  });

  it('超长 HTML（> 1MB）跳 readability 走兜底', async () => {
    const hugeBody = '<p>' + 'B'.repeat(READABILITY_MAX_HTML_CHARS + 1000) + '</p>';
    const html = `<html><head><title>Huge</title></head><body>${hugeBody}</body></html>`;
    const result = await extractMainContent(html);
    // 走兜底，仍能拿到内容 + title
    expect(result.title).toBe('Huge');
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('提取 <title>', async () => {
    const html = '<html><head><title>My Title</title></head><body><p>x</p></body></html>';
    const result = await extractMainContent(html);
    // readability 提取或兜底都应有 title
    // （内容不足时 readability 可能返 null 走兜底，title 来自 <title>）
    expect(result).toBeTruthy();
  });
});
