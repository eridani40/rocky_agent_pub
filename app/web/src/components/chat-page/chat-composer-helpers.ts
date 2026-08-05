/**
 * chat-composer-helpers —— ChatComposer 抽出的纯/弱耦合工具（为文件行数收敛）
 * 参考: specs/ui/components/chat-page/chat-composer.md
 *
 * 组件侧负责 ref guard 与 queueMicrotask 推迟；helpers 仅做无副作用的纯计算 / editor 命令封装。
 */
import type { MentionAttrs } from './chat-composer-extension';

/** editor 入参最小形状（detectMentionTrigger 用） */
interface EditorLike {
  state: {
    selection: { from: number };
    doc: { textBetween(from: number, to: number, blockSeparator?: string): string };
  };
}

/** editor chain 形状（insertMention for pill / insertContent for text node） */
interface Chain {
  insertMention: (attrs: MentionAttrs) => Chain;
  insertContent: (content: string) => Chain;
  focus: () => Chain;
  run: () => unknown;
}

/** mount-time 注入用 editor 入参最小形状 */
interface ChainableEditor {
  chain(): Chain;
}

/**
 * 扫光标前 50 字符，找最近的未被空格中断的 @ 符号。
 * 返回 @ 之后的 query 文本（空串表示 @ 是末尾）；无 @ 返回 null。
 */
export function detectMentionTrigger(ed: EditorLike): string | null {
  const { state } = ed;
  const { from } = state.selection;
  const textBefore = state.doc.textBetween(Math.max(0, from - 50), from, '\0');
  const atMatch = textBefore.match(/@(\S*)$/);
  return atMatch ? (atMatch[1] ?? '') : null;
}

/**
 * mount-time 初始内容注入 dispatcher：
 *   - string → chain().focus().insertContent(text).run()，注成真实可编辑 text node
 *     （业务全景「更多」tab 引导 → 跳 leader 单聊预填「帮我搭建一个看板，展示…」模板）
 *   - MentionAttrs[] → 顺序 insertMention 后 run（既有 pill 注入回路）
 *
 * 责任边界：本函数仅做 typeof 分派 + editor 命令封装；
 *   ref guard / empty check / queueMicrotask 推迟由 composer 负责（守 memory tiptap-effect-flushsync-lifecycle）。
 */
export function injectInitialContent(editor: ChainableEditor, initial: MentionAttrs[] | string): void {
  if (typeof initial === 'string') {
    editor.chain().focus().insertContent(initial).run();
    return;
  }
  const chain = editor.chain();
  for (const attrs of initial) {
    chain.insertMention(attrs);
  }
  chain.run();
}

/** 向后兼容包装：委托 injectInitialContent（mention 数组分支，签名沿用）。 */
export function injectMentions(editor: ChainableEditor, items: MentionAttrs[]): void {
  injectInitialContent(editor, items);
}

