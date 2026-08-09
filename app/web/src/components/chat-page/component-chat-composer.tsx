/**
 * component-chat-composer —— pill-aware 输入区共享组件（Tiptap 编辑器 + @ 触发 MentionPopover）
 * 参考: specs/ui/components/chat-page/chat-composer.md
 *       specs/tech/mention/message-content.md
 *
 * 替代各 chat 页独立 textarea（统一装配层 SectionChatSession 经 ComponentChatSessionInput 消费）。
 * 发送时产出**字符串**（mention 以 <mention type="..." path="..."/> 内联标签嵌入）。
 *
 * 边界：不做消息渲染（→ ComponentMessageStream）；不做 run 态 UI（→ ComponentRunStateBar）。
 */
import { useCallback, useState, useEffect, useRef, forwardRef, useImperativeHandle, type KeyboardEvent } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { useTranslation } from 'react-i18next';
import type { BizType, Role } from '@app/shared';
import { MentionNode, serializeEditorContent, PROVIDER_LABELS, addressAttrsFromItem, buildInterruptTransaction } from './chat-composer-extension';
import type { MentionAttrs } from './chat-composer-extension';
import { MentionPopover, type MentionItem, type MentionProviderMeta } from './component-mention-popover';
import { resolveEnterAction } from './chat-composer-keys';
import { detectMentionTrigger } from './chat-composer-helpers';
import { processImagePaste } from './paste-image-handler';
import { useChatDraft } from './use-chat-draft';

/** ChatComposer Props */
export interface ChatComposerProps {
  /** 业务分区 */
  biz: BizType;
  /** 会话角色 */
  sessionRole?: Role;
  /** 当前会话 ULID（search API 用） */
  sessionId: string;
  /** 启用的 mention provider 列表 */
  enabledProviders: string[];
  /** 发送回调（含 mention 内联标签的纯字符串） */
  onSend: (content: string) => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** placeholder 文本 */
  placeholder?: string;
  /**
   * 初始内容（mount 时一次性注入）：mention 数组 → pill；string → 可编辑 text node（模板填空）。
   * 受控语义：仅在 editor 首次就绪时注入一次（ref guard），不监听后续变更；用户随后可自由编辑/删除/发送。
   */
  initialContent?: MentionAttrs[] | string;
}

/**
 * ChatComposer 命令式句柄（供外部 send 按钮触发）。
 * 外部 send 按钮通过 ref 调 `send()`，等价于按 Enter（序列化编辑器内容 + 调 onSend + 清空）。
 */
export interface ChatComposerHandle {
  /** 触发发送（等价 Enter）；空内容时 no-op（与 handleSubmit 同款守护） */
  send: () => void;
  /** @ popover 是否打开（triggerRef 当前态，不 stale） */
  isPopoverOpen: () => boolean;
  /** editor 是否持有焦点（Tiptap 内置 isFocused，ESC 焦点门控用） */
  isFocused: () => boolean;
  /**
   * 中断注入：把 items 的 content 反序列化为 paragraph（保留 mention pill）插入 doc 开头，
   * 后接原内容；按原焦点位置做焦点管理（wasFocused→selection 平移位置不变 / !wasFocused→焦点末尾）。
   * 不调 onSend / 不 clearContent（与 send 区分）；items.length===0 跳过注入仅走焦点分支。
   */
  applyInterrupt: (items: { content: string }[]) => void;
}

/** @ 触发状态 */
interface MentionTrigger {
  /** @ 后到光标间的查询文本 */
  query: string;
}

/**
 * 共享 pill-aware 输入区组件。
 * 内含 Tiptap 编辑器 + @ 触发 MentionPopover 浮层 + pill 节点渲染。
 *
 * forwardRef 暴露 `send()` 命令式句柄，供外部 send 按钮触发
 * （外部 send 按钮与停止按钮分立左右两侧，需通过 ref 调编辑器内部 handleSubmit）。
 */
export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer({
  biz,
  sessionId,
  sessionRole: _sessionRole,
  enabledProviders,
  onSend,
  disabled = false,
  placeholder,
  initialContent,
}, ref) {
  const { t } = useTranslation(['common', 'chat']);
  const resolvedPlaceholder = placeholder ?? t('common:composer.placeholder');
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  // triggerRef inline 同步 trigger 最新态（无 effect 链），isPopoverOpen 读它取最新不 stale
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;

  // provider 列表（tab 来源）
  const providers: MentionProviderMeta[] = enabledProviders
    .filter((name): name is string => !!PROVIDER_LABELS[name])
    .map((name) => ({ name, label: PROVIDER_LABELS[name]! }));

  // Tiptap editor 初始化
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // 简化：不需要 heading / code-block / blockquote
        heading: false,
        codeBlock: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        horizontalRule: false,
      }),
      Placeholder.configure({ placeholder: resolvedPlaceholder }),
      MentionNode,
    ],
    editorProps: {
      attributes: {
        class: 'outline-none w-full',
      },
      handleKeyDown: (_view, event) => {
        // Enter 动作判定抽到纯函数 resolveEnterAction（chat-composer-keys.ts，UT 覆盖）
        const action = resolveEnterAction(event);
        if (action === 'send') {
          event.preventDefault();
          handleSubmit();
          return true;
        }
        if (action === 'newline') {
          // Shift/Cmd/Ctrl+Enter → setHardBreak（Tiptap 默认 Cmd+Enter 无 hardBreak 绑定）
          event.preventDefault();
          editor?.commands.setHardBreak();
          return true;
        }
        return false; // 'ignore'：IME/非 Enter → 交 Tiptap 默认
      },
      // 粘贴图片拦截：同步短路层（判有无 image item）→ preventDefault +
      // 异步 processImagePaste（落盘 + 插 pill）。非 image 走 Tiptap 默认（返 false）。
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        const hasImage = Array.from(items).some(
          (it) => it.kind === 'file' && it.type.startsWith('image/'),
        );
        if (!hasImage) return false;
        event.preventDefault();
        if (editor) {
          void processImagePaste(editor, sessionId, event.clipboardData);
        }
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => {
      // 检测 @ 触发：检查当前光标前是否有 @ 且未被空格中断
      detectTrigger(ed);
      // [v0.0.267] 编辑即写草稿缓存（空内容由 saveDraft 自动清除）
      saveDraft(ed);
    },
    editable: !disabled,
  });

  // disabled 变更时同步 editor 可编辑态。queueMicrotask 推迟出 commit phase，避免 @tiptap/react
  // 内部 flushSync 的 lifecycle 警告（语义不变）。
  useEffect(() => {
    if (!editor) return;
    queueMicrotask(() => {
      editor.setEditable(!disabled);
    });
  }, [editor, disabled]);

  // [v0.0.267] 输入草稿缓存：接管 mount 注入（草稿 > prefill）+ saveDraft/clearDraft actions。
  // 原 initialContent effect（ref guard + empty check + queueMicrotask 注入）移入 useChatDraft。
  const { saveDraft, clearDraft } = useChatDraft(editor, sessionId, initialContent);

  /** 检测 @ 触发（核心扫描抽到 detectMentionTrigger 纯函数；本处负责 setTrigger）。 */
  const detectTrigger = useCallback((ed: NonNullable<typeof editor>) => {
    const query = detectMentionTrigger(ed);
    setTrigger(query === null ? null : { query });
  }, []);

  /** 发送消息（序列化 editor → 字符串） */
  const handleSubmit = useCallback(() => {
    if (!editor) return;
    const doc = editor.getJSON();
    const content = serializeEditorContent(doc as Parameters<typeof serializeEditorContent>[0]);
    if (!content.trim()) return;
    onSend(content);
    editor.commands.clearContent();
    setTrigger(null);
    // [v0.0.267] 发送后显式清草稿（不赌 clearContent 是否触发 onUpdate 的框架行为）
    clearDraft();
  }, [editor, onSend, clearDraft]);

  // 暴露命令式句柄：send + applyInterrupt（中断注入+焦点）+ isPopoverOpen/isFocused（焦点门控查询）
  useImperativeHandle(ref, () => ({
    send: handleSubmit,
    isPopoverOpen: () => triggerRef.current !== null,
    isFocused: () => !!editor?.isFocused,
    applyInterrupt: (items: { content: string }[]) => {
      if (!editor) return;
      // 焦点 + selection 必须在 mutation 前捕获（buildInterruptTransaction 内 tr.insert 不读焦点）
      const wasFocused = editor.isFocused;
      const result = buildInterruptTransaction(editor.state, items);
      if (result) {
        const { tr, newFrom, newTo } = result;
        // wasFocused → selection 经 mapping 平移到原内容新位置（位置不变）；不 blur
        if (wasFocused) tr.setSelection(TextSelection.create(tr.doc, newFrom, newTo));
        editor.view.dispatch(tr);
      }
      // !wasFocused → 仍 dispatch 注入（result null 时跳过）+ 焦点 + 光标到末尾（UC-F3 时仅走此分支）
      // Tiptap v3.x setTextSelection 仅 number|Range，用 focus('end')（FocusPosition 含 'end'）
      if (!wasFocused) editor.chain().focus('end').run();
    },
  }), [handleSubmit, editor]);

  /** MentionPopover 选中回调：透传整条 item 零推导，按 type 构 address + display 三字段必传 */
  const handleSelect = useCallback(
    (item: MentionItem) => {
      if (!editor) return;
      // 删除 @ 触发文本（@ 后到光标间的所有字符）
      const { state } = editor;
      const { from } = state.selection;
      const textBefore = state.doc.textBetween(Math.max(0, from - 50), from, '\0');
      const atMatch = textBefore.match(/@(\S*)$/);
      if (atMatch) {
        const atPos = from - atMatch[0].length;
        const attrs: MentionAttrs = {
          type: item.type,
          ...addressAttrsFromItem(item),
          icon: item.display.icon,
          label: item.display.label,
          ...(item.display.badge ? { badge: item.display.badge } : {}),
        };
        editor
          .chain()
          .focus()
          .deleteRange({ from: atPos, to: from })
          .insertMention(attrs)
          .run();
      }
      setTrigger(null);
    },
    [editor],
  );

  /** 关闭 MentionPopover */
  const handleClose = useCallback(() => {
    setTrigger(null);
    editor?.commands.focus();
  }, [editor]);

  /** 外部键盘事件（捕获 Esc 关闭 popover） */
  const handleKeyDown = (e: KeyboardEvent) => {
    if (trigger && e.key === 'Escape') {
      e.preventDefault();
      handleClose();
    }
  };

  return (
    <div

      data-biz-type={biz}
      className="relative"
      onKeyDown={handleKeyDown}
    >
      {/* @ 触发时渲染 MentionPopover 浮层 */}
      {trigger && providers.length > 0 && (
        <MentionPopover
          providers={providers}
          query={trigger.query}
          onSelect={handleSelect}
          onClose={handleClose}
          sessionId={sessionId}
        />
      )}

      {/* Tiptap 编辑器 */}
      {/* 输入框高度：默认 3 行（min-h-[60px] ≈ 13.5px × 1.5 × 3），
          最大 6 行（max-h-[120px] ≈ 13.5px × 1.5 × 6）；超过 6 行内部滚动（不无限撑高）。
          min-h 应用到内层 .tiptap 元素（ProseMirror 编辑器），保证空编辑器也显示 3 行高度
          （仅外层 min-h 会让编辑器只占 1 行 + 下方留白，视觉错位）。 */}
      <div data-action-key="chat.composer.input">
        <EditorContent
          editor={editor}
          className="max-h-[120px] overflow-y-auto text-[13.5px] leading-[1.5] text-fg [&_.tiptap]:outline-none [&_.tiptap]:min-h-[60px] [&_.tiptap_p]:m-0 [&_.is-editor-empty:first-child::before]:text-muted [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:h-0 [&_.is-editor-empty:first-child::before]:pointer-events-none"
        />
      </div>
    </div>
  );
});

ChatComposer.displayName = 'ChatComposer';

export default ChatComposer;
