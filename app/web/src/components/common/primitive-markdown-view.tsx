/**
 * primitive-markdown-view —— 最小 markdown 渲染（克制风格，无依赖）
 * 参考: specs/ui/components/chat-page/_overview.md §4.7（answer markdown 最小子集）
 *       v0.0.253: `<a>` onClick 接入 link-target 分发
 *       v0.0.286: block 级图片独立行 `![alt](url)` 渲染（三源分流见 primitive-markdown-image.tsx）
 *
 * 支持 block：段落/代码块/列表/标题/引用/GFM 表格/独立行图片
 * 支持 inline：加粗/行内代码/链接（renderInline 不改——inline 嵌图不做）
 */
import { tryParseGfmTable, isTableStartHere } from './primitive-markdown-gfm-table';
import { isDangerousScheme, openLinkTarget, type OpenLinkTargetOpts } from '../../lib/link-target';
import { useChatLinkHandler } from '../chat-page/chat-link-handler-context';
import { MarkdownImage } from './primitive-markdown-image';

/** block 级独立行图片正则：整行只有 `![alt](url)`（trim 后首尾锚定） */
const BLOCK_IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

interface MarkdownViewProps {
  /** markdown 源文本 */
  source: string;
  /** 附加 className */
  className?: string;
  /** [v0.0.286] 文件所在目录（relative 图片 resolve 基准；chat 气泡无此值 → 相对图降级 alt） */
  baseDir?: string;
  /** [v0.0.286] 会话 ID（relative 图片走 readWorkspaceFileBinary HTTP） */
  sessionId?: string;
}

/** 行内格式：`code`→<code>、[text](url)→<a>、**bold**→<strong>。外层优先，内层不跨级。 */
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

/** 最小 markdown 渲染器。按行扫描产出：代码块/列表/GFM 表格/独立行图片/段落。 */
export function PrimitiveMarkdownView({ source, className, baseDir, sessionId }: MarkdownViewProps) {
  const handler = useChatLinkHandler();
  const linkOpts: OpenLinkTargetOpts | null = handler ? { onLocalViewer: handler.onLocalViewer, sessionId: handler.sessionId } : null;

  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let keyIdx = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;

    // frontmatter 检测（仅 i===0 且首行 trim 后 === '---' 时触发）
    if (i === 0 && line.trim() === '---') {
      // 从第 2 行开始收集，直到下一个 trim 后 === '---' 的行（闭合）
      let closeIdx = -1;
      for (let j = 1; j < lines.length; j++) {
        if (lines[j] !== undefined && lines[j]!.trim() === '---') {
          closeIdx = j;
          break;
        }
      }
      if (closeIdx !== -1) {
        // 闭合成功 → 提取 frontmatter 内容（纯文本，不做 YAML 解析）
        const fmContent = lines.slice(1, closeIdx).join('\n');
        blocks.push(
          <div
            key={`md-fm-${keyIdx++}`}
            className="font-mono text-[12px] text-fg-2 bg-bg-warm rounded-md px-3 py-2 my-2 border border-border whitespace-pre-wrap"
          >
            {fmContent}
          </div>,
        );
        i = closeIdx + 1; // 跳过闭合 ---
        continue;
      }
      // 未闭合 → 不识别为 frontmatter，i 不跳过，继续走正常流程
    }

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
      let prevNum: number | null = null; // [v0.0.306] 前一项编号，用于连续检测
      while (i < lines.length) {
        const ln = lines[i];
        if (!ln || !/^\s*\d+\.\s+/.test(ln)) {
          // [v0.0.319] 松散列表（loose list）：空行分隔的列表项仍属同一 <ol>
          // 遇空行时 peek 跳过连续空行，下一非空行是列表项 → 消费空行继续收集；否则断开
          if (ln !== undefined && ln.trim() === '') {
            let j = i;
            while (j < lines.length && lines[j] !== undefined && lines[j]!.trim() === '') j++;
            const next = lines[j];
            if (next !== undefined && /^\s*\d+\.\s+/.test(next)) {
              i = j;
              continue;
            }
          }
          break;
        }
        // [v0.0.306] 编号重置检测：再次出现 `1.`（非首项）→ 断开当前 <ol>，外层循环开新 <ol>
        const n = parseInt(ln.match(/^\s*(\d+)\.\s+/)![1]!, 10);
        if (items.length > 0 && n === 1) break;
        // [v0.0.306] 编号跳变检测：非连续编号（非 1）→ 断开当前 <ol>，该行交外层循环处理
        if (prevNum !== null && n !== prevNum + 1) break;
        items.push(ln.replace(/^\s*\d+\.\s+/, ''));
        prevNum = n;
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

    // block 级独立行图片 ![alt](url)（v0.0.286：仅独立行，inline 嵌图不做）
    const imgMatch = line.trim().match(BLOCK_IMAGE_RE);
    if (imgMatch) {
      blocks.push(
        <div key={`md-img-${keyIdx++}`} className="my-1.5">
          <MarkdownImage src={imgMatch[2] ?? ''} alt={imgMatch[1] ?? ''} baseDir={baseDir} sessionId={sessionId} />
        </div>,
      );
      i++;
      continue;
    }

    // 段落（连续非空非特殊行）
    const para: string[] = [];
    while (i < lines.length) {
      const ln = lines[i];
      if (
        !ln || ln.trim() === '' || ln.trim().startsWith('```') ||
        /^\s*[-*]\s+/.test(ln) || /^\s*\d+\.\s+/.test(ln) ||
        /^(#{1,3})\s+.+$/.test(ln) || /^\s*>\s?/.test(ln) ||
        BLOCK_IMAGE_RE.test(ln.trim()) || isTableStartHere(lines, i)
      ) {
        break;
      }
      para.push(ln);
      i++;
    }
    // v0.0.314: 段落内多行换行保留——逐行 renderInline（保留行内格式），
    // whitespace-pre-wrap + 行间 '\n' 渲染换行
    blocks.push(
      <p key={`md-${keyIdx++}`} className="my-0.5 break-words whitespace-pre-wrap">
        {para.map((line, j) => (
          <span key={`md-pl-${keyIdx}-${j}`}>
            {renderInline(line, `p${keyIdx}-${j}`, linkOpts)}
            {j < para.length - 1 && '\n'}
          </span>
        ))}
      </p>,
    );
  }

  return <div className={className ? `${className} break-words min-w-0` : 'break-words min-w-0'}>{blocks}</div>;
}

export default PrimitiveMarkdownView;
