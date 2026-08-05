/**
 * chat-composer-keys —— ChatComposer Enter 键动作判定（纯函数，UT 覆盖）
 * 参考: specs/ui/components/chat-page/chat-composer.md §发送 / §状态-交互
 */

/** Enter 键的动作判定结果：调用方按返回值分发（send→handleSubmit / newline→setHardBreak / ignore→不处理） */
export type EnterAction = 'send' | 'newline' | 'ignore';

/**
 * 判定 Enter 键应执行的动作（Tiptap editorProps.handleKeyDown 或 React onKeyDown 均可复用）。
 * 语义契约：Enter+无修饰键+非 IME → send；Enter+shift/meta/ctrl → newline；IME 组词中 / 非 Enter → ignore。
 * 详见 spec §发送 + §状态-交互。
 */
export function resolveEnterAction(event: KeyboardEvent): EnterAction {
  if (event.key !== 'Enter') return 'ignore';
  // IME 组词中（isComposing 或 keyCode 229）→ 交 IME 引擎，不发送不换行
  if (event.isComposing || event.keyCode === 229) return 'ignore';
  if (event.shiftKey || event.metaKey || event.ctrlKey) return 'newline';
  return 'send';
}
