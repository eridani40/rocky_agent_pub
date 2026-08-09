/**
 * chat-composer-extension —— Tiptap mention inline node extension
 * 参考: specs/ui/components/chat-page/chat-composer.md（pill 节点）
 *       specs/tech/mention/message-content.md（tag flat 属性 + XML 转义）
 *
 * MentionAttrs 含 address + display 全字段（全部持久化进 message tag）；
 * MentionNodeView 用 attrs.icon/label/badge 直传 MentionPill；
 * serializeEditorContent 输出 flat 全属性 tag（顺序 type→address→display + XML 转义 + 空 badge 省略）。
 *
 * atom: true（整颗删除，不可部分编辑）；inline: true。
 */
import { mergeAttributes, Node } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { MentionPill } from './primitive-mention-pill';
import { escapeAttr, deserializeContentToParagraphs } from './mention-tag';
import type { MentionItem } from './component-mention-popover';

/**
 * mention node 的 attrs 结构（address + display 全字段）。
 *   - address：按 type 不同字段不同（file/skill=path；workitem=kind+id；member=id）
 *   - display：icon/label/badge 三字段，pill 渲染唯一依据
 */
export interface MentionAttrs {
  /** 类型（'file' | 'skill' | 'workitem' | 'member'，开放枚举） */
  type: string;
  // ─── Address（按 type 不同字段不同） ───
  /** file/skill 路径 */
  path?: string;
  /** workitem kind ∈ {goal, kr, requirement, task} */
  kind?: string;
  /** workitem ID（G-0001 等）/ member ID（ULID） */
  id?: string;
  // ─── Display（pill 渲染依据，必传） ───
  /** glyph key（Glyph registry） */
  icon: string;
  /** 主文本（不含 @ 前缀） */
  label: string;
  /** 徽标 key（'leader' 或省略） */
  badge?: string;
}

/**
 * mention node view（Tiptap NodeView 渲染为 MentionPill）。
 * atom 节点不支持 onRemove 交互删除（由编辑器 Backspace/Delete 整颗删除）。
 */
function MentionNodeView({ node }: { node: { attrs: MentionAttrs } }) {
  const { icon, label, badge } = node.attrs;
  return (
    <NodeViewWrapper as="span" className="inline">
      <MentionPill icon={icon} label={label} badge={badge} />
    </NodeViewWrapper>
  );
}

/**
 * Tiptap mention inline node extension。
 * 插入方式：editor.chain().focus().insertMention(attrs).run()
 */
export const MentionNode = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      type: { default: 'file' },
      path: { default: '' },
      kind: { default: '' },
      id: { default: '' },
      icon: { default: '' },
      label: { default: '' },
      badge: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-mention-node]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-mention-node': '' }),
      `@${(HTMLAttributes.label as string) ?? ''}`,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionNodeView as never);
  },

  addCommands() {
    return {
      insertMention:
        (attrs: MentionAttrs) =>
        ({ chain }) => {
          return chain()
            .insertContent({
              type: this.name,
              attrs,
            })
            .insertContent(' ')
            .run();
        },
    };
  },
});

/**
 * 序列化单个 mention node 为 flat 全属性 tag 字符串。
 * 顺序固定：type → address（path/kind/id）→ display（icon/label/badge）。
 * 空 badge 省略；空 address 字段省略。
 */
function serializeMention(attrs: MentionAttrs): string {
  const parts: string[] = [`type="${escapeAttr(attrs.type)}"`];
  // address（按存在性输出，零值省略）
  if (attrs.path) parts.push(`path="${escapeAttr(attrs.path)}"`);
  if (attrs.kind) parts.push(`kind="${escapeAttr(attrs.kind)}"`);
  if (attrs.id) parts.push(`id="${escapeAttr(attrs.id)}"`);
  // display（icon/label 必写；badge 空省略）
  parts.push(`icon="${escapeAttr(attrs.icon)}"`);
  parts.push(`label="${escapeAttr(attrs.label)}"`);
  if (attrs.badge) parts.push(`badge="${escapeAttr(attrs.badge)}"`);
  return `<mention ${parts.join(' ')}/>`;
}

/**
 * 将 Tiptap editor document 序列化为纯字符串。
 * text 段 → 原样；mention node → flat 全属性 tag（XML 转义、空 badge 省略）；
 * hardBreak node → '\n'（手动回车 Shift/Cmd+Enter 产生，v0.0.284 修复换行丢失）。
 * 段落之间用 `\n` 分隔（编辑器通常单段落，这里兼容多段）。
 */
export function serializeEditorContent(
  doc: { content?: Array<{ type: string; content?: Array<{ type: string; text?: string; attrs?: MentionAttrs }> }> },
): string {
  const paragraphs: string[] = [];
  for (const block of doc.content ?? []) {
    if (block.type !== 'paragraph') continue;
    let line = '';
    for (const node of block.content ?? []) {
      if (node.type === 'hardBreak') {
        // 手动回车（Shift/Cmd/Ctrl+Enter）→ setHardBreak 产生的节点，序列化为 \n
        line += '\n';
      } else if (node.type === 'text' && node.text) {
        line += node.text;
      } else if (node.type === 'mention' && node.attrs) {
        line += serializeMention(node.attrs);
      }
    }
    paragraphs.push(line);
  }
  return paragraphs.join('\n');
}

/**
 * 构造中断注入 ProseMirror transaction（纯函数，不调 view.dispatch / editor.commands）。
 * 把 items.flatMap(deserializeContentToParagraphs) 反序列化为 paragraph PM Node[]，
 * 用 `tr.insert(0, nodes)` 插入 doc 内容开头；原内容位置严格 > 0 → mapping 干净平移。
 *
 * 返回 `{ tr, newFrom, newTo }`（newFrom/newTo = 原 selection 经 tr.mapping.map 平移到新 doc 位置），
 * 由 caller applyInterrupt 负责分发 + 焦点管理；items.length===0 返 null（caller 跳过 dispatch）。
 *
 * 参考 PRD §3.2/§3.3/§7.2（注入规格 + 焦点位置不变语义）；
 * ProseMirror 位置数学：插入点 0 在原内容之前，mapping 无 associativity 歧义。
 */
export function buildInterruptTransaction(
  state: EditorState,
  items: { content: string }[],
): { tr: Transaction; newFrom: number; newTo: number } | null {
  if (items.length === 0) return null;
  const paragraphs = items.flatMap((it) => deserializeContentToParagraphs(it.content));
  const nodes = paragraphs.map((p) => state.schema.nodeFromJSON(p));
  const tr = state.tr;
  tr.insert(0, nodes);
  return {
    tr,
    newFrom: tr.mapping.map(state.selection.from),
    newTo: tr.mapping.map(state.selection.to),
  };
}

/**
 * provider 元数据映射（name → label）。
 * workitem/member 由 resolver 派生 → popover 显示对应 tab；
 *   `filter((name) => !!PROVIDER_LABELS[name])` 防御未识别 name。
 */
export const PROVIDER_LABELS: Record<string, string> = {
  file: 'Files',
  skill: 'Skills',
  workitem: 'WorkItems',
  member: 'Members',
};

/**
 * 按 type 构 address 字段切片。
 *   - file/skill → path
 *   - workitem   → kind + id
 *   - member     → id
 * 这是 INV-2 允许的「按 type 构造」分支（不是渲染分支；renderer 仍零 type 分支）。
 */
export function addressAttrsFromItem(item: MentionItem): Pick<MentionAttrs, 'path' | 'kind' | 'id'> {
  if (item.type === 'file' || item.type === 'skill') {
    return item.path ? { path: item.path } : {};
  }
  if (item.type === 'workitem') return { kind: item.kind, id: item.id };
  if (item.type === 'member') return { id: item.id };
  return {};
}

// 给 Tiptap 的 command 扩展类型声明
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mention: {
      insertMention: (attrs: MentionAttrs) => ReturnType;
    };
  }
}
