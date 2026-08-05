/**
 * HTML → markdown 提取：readability 主力 + htmlToMarkdown 正则兜底
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §5（路线 B + headless 兜底）
 *       specs/research/v0.0.23-web-fetch.md §B.1（openclaw readability + linkedom）
 *
 * 设计（参考 openclaw web-content-extractor.ts）：
 *   - 主路径：@mozilla/readability + linkedom DOM（服务端无浏览器）
 *   - 兜底：readability 失败 / 内容为空 → htmlToMarkdown 正则（去 script/style/nav）
 *   - 防 DoS：HTML > READABILITY_MAX_HTML_CHARS(1MB) 或嵌套 > 3000 → 放弃 readability
 *     直接 htmlToMarkdown（防恶意深嵌套拖垮 DOM 解析）。
 *
 * 本模块纯函数 + 动态 import（readability/linkedom 仅此处用，避免顶层 side-effect）。
 */
import type { Readability } from '@mozilla/readability';

/** readability 最大允许 HTML 长度（防 DoS） */
export const READABILITY_MAX_HTML_CHARS = 1_000_000;
/** readability 最大允许 DOM 嵌套深度（防恶意深嵌套） */
export const READABILITY_MAX_NESTING = 3000;
/** 兜底正则提取正文时长度上限（防超大 html 拖慢） */
const FALLBACK_MAX_HTML_CHARS = 2_000_000;

/** 内容提取结果 */
export interface ExtractResult {
  /** 标题（readability 提供 / 兜底用 <title> / 无则空） */
  title: string;
  /** 正文 markdown */
  content: string;
}

/**
 * 粗略估计 HTML 嵌套深度（数 < 开标签数，近似值用于 DoS 阈值判定）。
 * 仅作上限告警用，不需精确。
 */
function estimateNesting(html: string): number {
  let depth = 0;
  let max = 0;
  // 仅数 <div> <section> <article> <ul> <ol> <table> <tbody> <tr> <td> 等常见嵌套
  const tagRe = /<(\/)?(div|section|article|ul|ol|li|table|tbody|tr|td|th|span|p|nav|header|footer|main|aside)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[1] === '/') {
      depth = Math.max(0, depth - 1);
    } else {
      depth += 1;
      if (depth > max) max = depth;
    }
    if (max > READABILITY_MAX_NESTING) break;
  }
  return max;
}

/**
 * 用 readability 提取主内容（+ linkedom DOM）。
 * 调用方应先判定 HTML 长度 / 嵌套深度（防 DoS），本函数不重复判定。
 *
 * @param html 原始 HTML 字符串
 * @returns 提取结果；readability 失败 / 无内容返回 null（调用方走兜底）
 */
async function extractWithReadability(html: string): Promise<ExtractResult | null> {
  try {
    // 动态 import：linkedom 较重，仅此处用
    const { parseHTML } = await import('linkedom');
    const { document } = parseHTML(html);
    // 动态 import readability（避免被其他模块顶层加载）
    const readabilityMod = await import('@mozilla/readability');
    const ReadabilityCtor = (readabilityMod as { Readability: typeof Readability }).Readability;
    const reader = new ReadabilityCtor(document, { charThreshold: 0 });
    const article = reader.parse();
    if (!article || (!article.textContent && !article.content)) return null;
    const content =
      (article.textContent && article.textContent.trim().length > 0)
        ? article.textContent.trim()
        : htmlToMarkdown(article.content ?? '');
    return { title: article.title ?? '', content };
  } catch {
    return null;
  }
}

/**
 * HTML → markdown 正则兜底（去 script/style/nav/header/footer/aside + 标签转文本）。
 * 质量 < readability，但 readability 不可用 / 内容非文章页时保底。
 *
 * @param html 原始 HTML
 * @returns 简化 markdown 文本
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  let s = html.length > FALLBACK_MAX_HTML_CHARS ? html.slice(0, FALLBACK_MAX_HTML_CHARS) : html;
  // 去 script / style / noscript / template（含内容）
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<template[\s\S]*?<\/template>/gi, '');
  // 去导航 / 页眉页脚 / 侧栏（保留主内容）
  s = s.replace(/<(nav|header|footer|aside|form|svg)[\s\S]*?<\/\1>/gi, '');
  // <h1-6> → markdown 标题
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => {
    return `\n${'#'.repeat(Number(level))} ${stripTags(inner).trim()}\n`;
  });
  // <a href="x">t</a> → [t](x)
  s = s.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
    return `[${stripTags(inner).trim()}](${href})`;
  });
  // <li> → - 项
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => `- ${stripTags(inner).trim()}\n`);
  // <p> / <br> → 换行
  s = s.replace(/<p[^>]*>/gi, '\n').replace(/<\/p>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // <code> / <pre> 保留
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  // 去剩余标签
  s = stripTags(s);
  // 解码常见 HTML 实体
  s = decodeEntities(s);
  // 折叠多余空白
  s = s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
  return s;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * 提取 HTML 主内容（readability 优先 + htmlToMarkdown 兜底，含 DoS 防护）。
 * 调用方：fetch-content route B（静态 fetch 后）+ headless 渲染后。
 *
 * @param html 原始 / 渲染后 HTML
 * @returns { title, content }；title 可能空
 */
export async function extractMainContent(html: string): Promise<ExtractResult> {
  if (!html || html.trim().length === 0) return { title: '', content: '' };
  // DoS 防护：HTML 超长 / 深嵌套 → 跳 readability 直接正则
  const tooLong = html.length > READABILITY_MAX_HTML_CHARS;
  const tooDeep = estimateNesting(html) > READABILITY_MAX_NESTING;
  if (!tooLong && !tooDeep) {
    const result = await extractWithReadability(html);
    if (result && result.content.trim().length > 0) return result;
  }
  // 兜底：正则 + 提取 <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch && titleMatch[1] ? decodeEntities(stripTags(titleMatch[1]).trim()) : '';
  return { title, content: htmlToMarkdown(html) };
}
