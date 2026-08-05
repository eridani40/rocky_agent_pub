/**
 * mention-tag —— mention tag 解析/转义共用 util（单一权威）
 * 参考: specs/tech/mention/message-content.md §3 §5.5 §7 §8（flat 属性 + 正则 + XML 转义）
 *       specs/ui/components/chat-page/chat-composer.md（注入路径反序列化器）
 *
 * INV-2：本模块类型无关（无 if(type===) 分支）——仅按 attrs.icon/label/badge 构 pill。
 */

/** 整段匹配 <mention .../> 自闭合 tag；捕获 tag 内的属性串 */
export const MENTION_RE = /<mention\s+([^>]*?)\s*\/>/g;
/** 在 tag 内体上跑：抽 (key, value) 对（value 已 XML 转义） */
export const ATTR_RE = /(\w+)="([^"]*)"/g;

/** XML 反转义映射（与 escapeAttr 对称） */
const UNESCAPE_MAP: Record<string, string> = {
  '&quot;': '"',
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
};

/** 反转义属性值：把 &quot;/&lt;/&gt;/&amp; 还原为原字符 */
export function unescapeAttr(v: string): string {
  return v.replace(/&(quot|lt|gt|amp);/g, (m) => UNESCAPE_MAP[m] ?? m);
}

/** XML 属性值转义四字符（spec message-content.md §8） */
export function escapeAttr(v: string): string {
  return v.replace(/[&<>"]/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return c;
    }
  });
}

/** 解析 tag 内属性串为 key→value 字典（顺序无关，值已反转义） */
export function parseTagAttrs(tagInner: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(tagInner); m !== null; m = ATTR_RE.exec(tagInner)) {
    attrs[m[1]!] = unescapeAttr(m[2]!);
  }
  return attrs;
}

/** Tiptap/ProseMirror 节点 JSON 形状（schema.nodeFromJSON 输入兼容） */
export interface TiptapNodeJSON {
  type: string;
  content?: TiptapNodeJSON[];
  attrs?: Record<string, unknown>;
  text?: string;
}

/**
 * 把单行字符串切成 inline 节点数组：tag 间文本→text 节点；tag→mention 节点或降级 text。
 * 新格式（含 icon+label）→ mention 节点（attrs 形状对齐 MentionAttrs）；
 * 旧格式（缺 display）→ 整段 tag 字符串作 text 节点（与 MentionRender 降级一致）。
 */
function deserializeLine(line: string): TiptapNodeJSON[] {
  const nodes: TiptapNodeJSON[] = [];
  let lastIndex = 0;
  MENTION_RE.lastIndex = 0;
  for (let m = MENTION_RE.exec(line); m !== null; m = MENTION_RE.exec(line)) {
    if (m.index > lastIndex) {
      nodes.push({ type: 'text', text: line.slice(lastIndex, m.index) });
    }
    const attrs = parseTagAttrs(m[1] ?? '');
    const { icon, label, badge, type, path, kind, id } = attrs;
    if (icon && label) {
      // 新格式（含 display）→ mention 节点；address 字段按存在性写（attrs 形状对齐 MentionAttrs）
      const mentionAttrs: Record<string, unknown> = { type: type ?? '', icon, label };
      if (path) mentionAttrs.path = path;
      if (kind) mentionAttrs.kind = kind;
      if (id) mentionAttrs.id = id;
      if (badge) mentionAttrs.badge = badge;
      nodes.push({ type: 'mention', attrs: mentionAttrs });
    } else {
      // 旧格式（缺 display）→ 整段 tag 字符串作 text 节点
      nodes.push({ type: 'text', text: m[0] });
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < line.length) {
    nodes.push({ type: 'text', text: line.slice(lastIndex) });
  }
  return nodes;
}

/**
 * 反序列化 content 字符串为 paragraph JSON 数组（serializeEditorContent 逆运算）。
 * 按 \n 切行——每行产出一个 paragraph（多行 content → 多 paragraph）；空行 → 无 content 的空 paragraph。
 * 每行内用 MENTION_RE 扫 tag → inline 节点（见 deserializeLine）。
 *
 * 仅注入路径调用；实时手打 `<mention/>` 即时识别显式不做（PRD §3.4 非目标）。
 */
export function deserializeContentToParagraphs(content: string): TiptapNodeJSON[] {
  return content.split('\n').map((line) => ({
    type: 'paragraph',
    content: deserializeLine(line),
  }));
}
