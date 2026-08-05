/**
 * primitive-markdown-view —— 最小 markdown 渲染（克制风格，无依赖）
 * 参考: specs/ui/components/chat-page/_overview.md §4.7（answer markdown 最小子集）
 *       设计稿: reqs/v0.0.8/easy-opc-chat-v9a.html（克制风格）
 *       v0.0.253: `<a>` onClick 接入 link-target 分发（http→系统浏览器 / local-12 格式→内置 viewer / local-其它→系统应用）
 *
 * 支持子集：
 *   - block：段落 / 代码块(```...```) / 无序列表(- x) / 有序列表(1. x) /
 *            标题(#/##/###) / 引用块(>) / GFM 表格
 *   - inline：加粗(**x**) / 行内代码(`x`) / 链接([text](url))
 *
 * 不引入第三方库（保持克制 + 零依赖）。解析为 React 元素数组，按行扫描。
 * 行内格式（加粗/代码/链接）用正则切分替换为 <strong>/<code>/<a>。
 */
import { tryParseGfmTable, isTableStartHere } from './primitive-markdown-gfm-table';
import { isDangerousScheme, openLinkTarget, type OpenLinkTargetOpts } from '../../lib/link-target';
import { useChatLinkHandler } from '../chat-page/chat-link-handler-context';

interface MarkdownViewProps {
  /** markdown 源文本 */
  source: string;
  /** 附加 className */
  className?: string;
}

/** 行内格式：`code` → <code>、[text](url) → <a>、**bold** → <strong>。
 *  切分层级：代码 → 链接 → 加粗（外层优先，内层不再跨级处理）。
 *  v0.0.253: `<a>` 加 onClick → preventDefault + openLinkTarget 分发；opts 来自 useChatLinkHandler（无 Provider 系统打开降级）。 */
function renderInline(text: string, keyBase: string, linkOpts: OpenLinkTargetOpts | null): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // 一级切分：行内代码 `...`（代码内不再处理其他格式，保留原行为）
  const codeParts = text.split(/(`[^`]+`)/g);
  codeParts.forEach((part, i) => {
    if (!part) return;
    if (part.startsWith('`') && part.endsWith('`')) {
      nodes.push(
        <code
          key={`${keyBase}-c${i}`}
          className="font-mono text-[12.5px] px-1 py-0.5 rounded bg-bg-warm text-fg-2"
        >
          {part.slice(1, -1)}
        </code>,
      );
      return;
    }
    // 二级切分：链接 [text](url)；其余段走 **bold**
    const linkParts = part.split(/(\[[^\]]+\]\([^)\s]+\))/g);
    linkParts.forEach((lp, j) => {
      if (!lp) return;
      const lm = lp.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      if (lm) {
        const linkText = lm[1] ?? '';
        const url = lm[2] ?? '';
        if (!isDangerousScheme(url)) {
          nodes.push(
            <a
              key={`${keyBase}-a${i}-${j}`}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline underline-offset-2 cursor-pointer break-all"
              onClick={(e) => {
                e.preventDefault();
                openLinkTarget(url, linkOpts ?? undefined);
              }}
            >
              {linkText}
            </a>,
          );
        } else {
          // 危险协议（javascript:/vbscript:/data:）→ 降级为纯文本，丢弃 href
          nodes.push(linkText);
        }
      } else {
        // 处理 **bold**（bold 内不容纳其他格式）
        const boldParts = lp.split(/(\*\*[^*]+\*\*)/g);
        boldParts.forEach((bp, k) => {
          if (!bp) return;
          if (bp.startsWith('**') && bp.endsWith('**')) {
            nodes.push(
              <strong key={`${keyBase}-b${i}-${j}-${k}`} className="font-semibold">
                {bp.slice(2, -2)}
              </strong>,
            );
          } else {
            nodes.push(bp);
          }
        });
      }
    });
  });
  return nodes;
}

// ===== GFM 表格识别（block 级别）=====
// 实现移到 ./primitive-markdown-gfm-table（纯函数 helper，保持本文件 ≤300 行）

/**
 * 最小 markdown 渲染器。按行扫描产出：代码块 / 列表项 / GFM 表格 / 段落。
 */
export function PrimitiveMarkdownView({ source, className }: MarkdownViewProps) {
  // v0.0.253: 取 chat 链接处理回调（无 Provider = 其它消费方 → null → 链接走系统打开降级）
  const handler = useChatLinkHandler();
  const linkOpts: OpenLinkTargetOpts | null = handler ? { onLocalViewer: handler.onLocalViewer } : null;

  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let keyIdx = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;

    // 代码块 ```
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const ln = lines[i];
        if (!ln || ln.trim().startsWith('```')) break;
        codeLines.push(ln);
        i++;
      }
      i++; // 跳过闭合 ```
      blocks.push(
        <pre
          key={`md-${keyIdx++}`}
          className="font-mono text-[12.5px] bg-bg-warm border border-border rounded-lg px-3 py-2.5 my-1.5 overflow-x-auto text-fg-2 whitespace-pre-wrap"
        >
          <code data-lang={lang || undefined}>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // 标题 #/##/###（仅 1-3 级，更深的 # 不识别为标题，按段落渲染）
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const hashes = headingMatch[1] ?? '';
      const content = headingMatch[2] ?? '';
      const level = hashes.length;
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3';
      const sizeCls = level === 1 ? 'text-[16px]' : level === 2 ? 'text-[14.5px]' : 'text-[13.5px]';
      blocks.push(
        <Tag
          key={`md-${keyIdx++}`}
          className={`font-bold mt-2 mb-1 text-fg ${sizeCls}`}
        >
          {renderInline(content, `h${keyIdx}`, linkOpts)}
        </Tag>,
      );
      i++;
      continue;
    }

    // 无序列表项 - 或 *
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const ln = lines[i];
        if (!ln || !/^\s*[-*]\s+/.test(ln)) break;
        items.push(ln.replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={`md-${keyIdx++}`} className="list-disc pl-5 my-1 space-y-0.5">
          {items.map((it, j) => (
            <li key={`md-li-${keyIdx}-${j}`}>{renderInline(it, `li${keyIdx}-${j}`, linkOpts)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // 有序列表项 1. 2. 3.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const ln = lines[i];
        if (!ln || !/^\s*\d+\.\s+/.test(ln)) break;
        items.push(ln.replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={`md-${keyIdx++}`} className="list-decimal pl-5 my-1 space-y-0.5">
          {items.map((it, j) => (
            <li key={`md-oli-${keyIdx}-${j}`}>{renderInline(it, `oli${keyIdx}-${j}`, linkOpts)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // 引用块 >（逐行剥离 > 前缀，组段渲染；多行连续 > 视为一段或多段）
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const ln = lines[i];
        if (!ln || !/^\s*>\s?/.test(ln)) break;
        quoteLines.push(ln.replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote
          key={`md-${keyIdx++}`}
          className="border-l-2 border-border pl-3 my-1.5 text-fg-2"
        >
          {quoteLines.map((q, j) => (
            <p key={`md-bq-${keyIdx}-${j}`} className="my-0.5 break-words">
              {renderInline(q, `bq${keyIdx}-${j}`, linkOpts)}
            </p>
          ))}
        </blockquote>,
      );
      continue;
    }

    // GFM 表格：表头 + 分隔行 + 0..N 数据行（block 级别）
    const table = tryParseGfmTable(lines, i);
    if (table) {
      const { headerCells, alignments, dataRows, nextIdx } = table;
      blocks.push(
        <div key={`md-${keyIdx++}`} className="my-1.5 overflow-x-auto">
          <table className="border border-border rounded-md border-collapse text-[12.5px] w-full">
            <thead>
              <tr>
                {headerCells.map((cell, j) => (
                  <th
                    key={`th-${keyIdx}-${j}`}
                    style={{ textAlign: alignments[j] ?? 'left' }}
                    className="bg-bg-warm px-3 py-1.5 font-semibold text-fg-2 border-b border-border"
                  >
                    {renderInline(cell.trim(), `th${keyIdx}-${j}`, linkOpts)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dataRows.map((row, r) => (
                <tr key={`tr-${keyIdx}-${r}`}>
                  {row.map((cell, j) => (
                    <td
                      key={`td-${keyIdx}-${r}-${j}`}
                      style={{ textAlign: alignments[j] ?? 'left' }}
                      className="px-3 py-1.5 border-t border-border text-fg-2"
                    >
                      {renderInline(cell.trim(), `td${keyIdx}-${r}-${j}`, linkOpts)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = nextIdx;
      continue;
    }

    // 空行
    if (line.trim() === '') {
      i++;
      continue;
    }

    // 段落（连续非空非特殊行）
    const para: string[] = [];
    while (i < lines.length) {
      const ln = lines[i];
      if (
        !ln ||
        ln.trim() === '' ||
        ln.trim().startsWith('```') ||
        /^\s*[-*]\s+/.test(ln) ||
        /^\s*\d+\.\s+/.test(ln) ||
        // 与外层 heading 判定严格对称：要求 heading 有非空内容才 break（否则 "### " 空 heading 会撞外层死循环）。
        /^(#{1,3})\s+.+$/.test(ln) ||
        /^\s*>\s?/.test(ln) ||
        // 表格起始：当前行是表头 + 下一行是分隔行 → 段落 break，让表格分支接管
        isTableStartHere(lines, i)
      ) {
        break;
      }
      para.push(ln);
      i++;
    }
    blocks.push(
      <p key={`md-${keyIdx++}`} className="my-0.5 break-words">
        {renderInline(para.join(' '), `p${keyIdx}`, linkOpts)}
      </p>,
    );
  }

  return <div className={className ? `${className} break-words min-w-0` : 'break-words min-w-0'}>{blocks}</div>;
}

export default PrimitiveMarkdownView;
