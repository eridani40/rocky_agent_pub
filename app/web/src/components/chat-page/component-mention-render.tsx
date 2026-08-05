/**
 * component-mention-render —— 内联 mention tag 渲染（text + pill 混合）
 * 参考: specs/tech/mention/message-content.md §5.5 §8（泛化正则 + XML 反转义）
 *       specs/ui/components/chat-page/mention-pill.md（pill 契约）
 *
 * INV-2：renderer 类型无关（无 if(type===) 分支）。
 *   - 正则泛化：整段匹配 <mention .../> + 扫全部 k="v" 属性（顺序无关）
 *   - 反转义属性值（&quot;→" 等），与 serializeEditorContent 对称
 *   - 解析取 display.icon/label/badge → MentionPill；旧 tag（无 display）降级纯文本不 crash
 */
import { MentionPill } from './primitive-mention-pill';
import { MENTION_RE, parseTagAttrs } from './mention-tag';

/**
 * 把字符串按 mention tag 切成 [text, pill, text, pill, ...] 片段。
 * 类型无关（INV-2）：仅按 attrs.icon/label/badge 渲染 pill，无 type 分支。
 * 旧 tag（缺 display）→ 降级为纯文本显示整段 tag 字符串（不 crash、不渲染 pill）。
 */
export function MentionRender({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let idx = 0;
  MENTION_RE.lastIndex = 0;
  for (let m = MENTION_RE.exec(text); m !== null; m = MENTION_RE.exec(text)) {
    if (m.index > lastIndex) {
      parts.push(<span key={`t${idx++}`}>{text.slice(lastIndex, m.index)}</span>);
    }
    const attrs = parseTagAttrs(m[1] ?? '');
    const { icon, label, badge } = attrs;
    if (icon && label) {
      // 新 tag（含 display）→ pill
      parts.push(
        <MentionPill key={`p${idx++}`} icon={icon} label={label} badge={badge} />,
      );
    } else {
      // 旧 tag（缺 display）→ 降级纯文本，整段 tag 字符串原样显示
      parts.push(<span key={`p${idx++}`}>{m[0]}</span>);
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(<span key={`t${idx++}`}>{text.slice(lastIndex)}</span>);
  }
  return <>{parts}</>;
}

export default MentionRender;
