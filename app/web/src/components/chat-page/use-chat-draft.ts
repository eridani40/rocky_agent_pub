/**
 * use-chat-draft —— 输入草稿缓存接线 hook（v0.0.267 T2）
 * 参考: specs/tech/version_logs/v0.0.267/change_plan.md（useChatDraft 行）
 *       specs/prd/version_logs/v0.0.267.input_draft_cache/prd.md §2.3/§2.5/§3.2/§3.3（草稿优先 / 实时写 / 发送清除）
 *
 * 职责：
 *   - mount 恢复：editor ready + store.drafts[sessionId] 有值 → restoreDraftContent（**草稿 > prefill**：
 *     恢复后置 injectedRef，跳过 initialContent）；无草稿 → 走既有 injectInitialContent（ref-guard /
 *     empty check / queueMicrotask 语义与 ChatComposer 现状等价）。
 *   - 返回 saveDraft(ed)（serializeEditorContent 写缓存）+ clearDraft()（发送后清除）。
 *
 * 全部 getState 读/写、不订阅 store → 输入零 re-render（决策②③；zustand 订阅者按 selector
 * 引用 Object.is 比较，drafts 变化不影响未订阅组件）。
 */
import { useCallback, useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/react';
import { serializeEditorContent, type MentionAttrs } from './chat-composer-extension';
import { injectInitialContent, restoreDraftContent } from './chat-composer-helpers';
import { useChatStore } from '../../store/chat-slice';

/** editor 最小形状（saveDraft 入参；Tiptap Editor 满足） */
export interface DraftEditorLike {
  getJSON(): unknown;
}

/**
 * 输入草稿 hook：接管 mount 注入（草稿优先于 prefill）+ 提供 saveDraft/clearDraft actions。
 * store 参数用于测试注入独立实例（createChatSliceStore()），生产默认 useChatStore 单例。
 */
export function useChatDraft(
  editor: Editor | null,
  sessionId: string,
  initialContent: MentionAttrs[] | string | undefined,
  store: typeof useChatStore = useChatStore,
): { saveDraft: (ed: DraftEditorLike) => void; clearDraft: () => void } {
  const injectedRef = useRef(false);

  // mount 恢复：草稿优先于 prefill（决策② PRD §2.5）；无草稿走既有 initialContent 注入。
  // queueMicrotask 推迟出 commit phase（守 memory tiptap-effect-flushsync-lifecycle）。
  useEffect(() => {
    if (!editor || injectedRef.current) return;
    const draft = store.getState().drafts[sessionId];
    if (draft) {
      injectedRef.current = true;
      queueMicrotask(() => restoreDraftContent(editor, draft));
      return;
    }
    // 无草稿 → 既有 initialContent 注入（ref-guard/empty check 语义与 ChatComposer 现状等价）
    if (!initialContent || initialContent.length === 0) return;
    injectedRef.current = true;
    queueMicrotask(() => injectInitialContent(editor, initialContent));
  }, [editor, sessionId, initialContent, store]);

  /** 编辑即写缓存（onUpdate 调用）：serializeEditorContent 输出与发送通道同构，空内容 = 清除 */
  const saveDraft = useCallback(
    (ed: DraftEditorLike) => {
      const doc = ed.getJSON();
      const content = serializeEditorContent(doc as Parameters<typeof serializeEditorContent>[0]);
      store.getState().saveDraft(sessionId, content);
    },
    [sessionId, store],
  );

  /** 发送后显式清草稿（PRD §3.4；幂等，无草稿 no-op） */
  const clearDraft = useCallback(() => {
    store.getState().clearDraft(sessionId);
  }, [sessionId, store]);

  return { saveDraft, clearDraft };
}
