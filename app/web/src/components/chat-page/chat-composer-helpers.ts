/**
 * chat-composer-helpers —— ChatComposer 抽出的纯/弱耦合工具（为文件行数收敛）
 * 参考: specs/ui/components/chat-page/chat-composer.md
 *
 * 组件侧负责 ref guard 与 queueMicrotask 推迟；helpers 仅做无副作用的纯计算 / editor 命令封装。
 */
import type { Transaction } from '@tiptap/pm/state';
import { ReplaceStep, ReplaceAroundStep } from '@tiptap/pm/transform';
import type { MentionAttrs } from './chat-composer-extension';
import { deserializeContentToParagraphs, type TiptapNodeJSON } from './mention-tag';

/** editor 入参最小形状（detectMentionTrigger 用） */
interface EditorLike {
  state: {
    selection: { from: number };
    doc: { textBetween(from: number, to: number, blockSeparator?: string): string };
  };
}

/** editor chain 形状（insertMention for pill / insertContent for text node / TiptapNodeJSON[] for 草稿恢复） */
interface Chain {
  insertMention: (attrs: MentionAttrs) => Chain;
  insertContent: (content: string | TiptapNodeJSON[]) => Chain;
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
 * 纯函数无副作用；是 @ 扫描的唯一实现（detectMentionTrigger 含 @ 分支与
 * detectTrigger 面板开着分支共用，不重复实现正则）。
 * 参考: specs/tech/version_logs/v0.0.346/change_plan.md（触发修复机制）
 */
export function scanMentionQuery(ed: EditorLike): string | null {
  const { state } = ed;
  const { from } = state.selection;
  const textBefore = state.doc.textBetween(Math.max(0, from - 50), from, '\0');
  const atMatch = textBefore.match(/@(\S*)$/);
  return atMatch ? (atMatch[1] ?? '') : null;
}

/**
 * 从 ProseMirror transaction 提取本次插入的文本（纯函数，无副作用）。
 * 遍历 tr.steps，收集 ReplaceStep / ReplaceAroundStep 的 slice 文本拼接。
 * 参考: chat-composer-extension.tsx L158 事务先例 + specs/tech/version_logs/v0.0.346/change_plan.md
 */
export function getInsertedText(tr: Transaction): string {
  let inserted = '';
  for (const step of tr.steps) {
    if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
      inserted += step.slice.content.textBetween(0, step.slice.content.size, '\0');
    }
  }
  return inserted;
}

/**
 * 检测 @ 触发（插入文本门控）：insertedText 含 @ → 返回 scanMentionQuery(ed)
 * （触发/重触发）；不含 @ → 返回 null（不触发）。
 * 与组件侧面板状态门控（detectTrigger 函数式 setTrigger）构成双层门控：
 *   插入文本决定「能否触发」，面板状态决定「要不要关闭」——两者缺一不可。
 */
export function detectMentionTrigger(ed: EditorLike, insertedText: string): string | null {
  if (!insertedText.includes('@')) return null;
  return scanMentionQuery(ed);
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

/**
 * 草稿恢复专用 dispatcher：deserializeContentToParagraphs（mention pill 保真）→ insertContent。
 * 与 injectInitialContent 并列（职责 = editor 命令封装）；ref guard / queueMicrotask 推迟由 useChatDraft 负责。
 * MUST 走 deserializeContentToParagraphs（mention 保真，非 string 分支纯 text 注入）；
 * 不解析实时手打 `<mention/>`（沿用 mention-tag.ts 注入路径语义）；纯函数无状态。
 */
export function restoreDraftContent(editor: ChainableEditor, content: string): void {
  const paragraphs = deserializeContentToParagraphs(content);
  editor.chain().focus().insertContent(paragraphs).run();
}

