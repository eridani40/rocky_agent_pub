/**
 * @vitest-environment jsdom
 * use-chat-draft hook 单测（v0.0.267 T2 接线层）
 * 参考: specs/tech/version_logs/v0.0.267/change_plan.md（useChatDraft 行）
 *       specs/prd/version_logs/v0.0.267.input_draft_cache/prd.md §2.3/§2.5/§3.2/§3.3
 *
 * 覆盖：
 *   - 有草稿 → mount 恢复（含 mention pill 保真：deserialize → insertContent）
 *   - 无草稿 + initialContent → prefill 注入（回归）
 *   - 草稿优先：有草稿时 initialContent（prefill）不注入
 *   - 恢复后 saveDraft 回写同值幂等（store 不重复 set）
 *   - saveDraft / clearDraft action 语义
 *
 * 用 createChatSliceStore() 独立实例注入（不污染 useChatStore 单例）。
 * jsdom + Tiptap 真实 editor（对齐 component-chat-composer.test.tsx 模式）。
 */
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { useEffect, useRef, useState } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { MentionNode, type MentionAttrs } from '../chat-composer-extension';
import { useChatDraft, type DraftEditorLike } from '../use-chat-draft';
import { createChatSliceStore } from '../../../store/chat-slice';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

/** hook 宿主：真实 Tiptap editor + useChatDraft；onReady 暴露 api 与 editor 供断言 */
function Host({
  sessionId,
  initialContent,
  onReady,
}: {
  sessionId: string;
  initialContent?: MentionAttrs[] | string;
  onReady: (api: { saveDraft: (ed: DraftEditorLike) => void; clearDraft: () => void }, editor: ReturnType<typeof useEditor>) => void;
}) {
  const editor = useEditor({ extensions: [StarterKit.configure({ heading: false, codeBlock: false, blockquote: false }), MentionNode] });
  const api = useChatDraft(editor, sessionId, initialContent, storeRef.current);
  const calledRef = useRef(false);
  useEffect(() => {
    if (editor && !calledRef.current) {
      calledRef.current = true;
      onReady(api, editor);
    }
  });
  return <EditorContent editor={editor} />;
}

/** 每用例独立 store（不碰 useChatStore 单例） */
const storeRef: { current: ReturnType<typeof createChatSliceStore> } = { current: createChatSliceStore() };

beforeEach(() => {
  storeRef.current = createChatSliceStore();
});

/** 等待 .ProseMirror 出现 */
async function waitForEditor(container: HTMLElement): Promise<HTMLElement | null> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const el = container.querySelector<HTMLElement>('.ProseMirror');
    if (el) return el;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/** 等待 container 内 pill 数量达到 expected */
async function waitForPills(container: HTMLElement, expected: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const n = container.querySelectorAll('[data-mention-icon]').length;
    if (n >= expected) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 等待 editor 元素内出现指定文本 */
async function waitForText(editorEl: HTMLElement, expected: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((editorEl.textContent ?? '').includes(expected)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('useChatDraft（v0.0.267 接线）', () => {
  it('有草稿 → mount 恢复（含 mention pill 保真）', async () => {
    storeRef.current.getState().saveDraft(
      's1',
      '草稿文本\n<mention type="member" id="m1" icon="member" label="张三"/> 你好',
    );
    const { container } = render(
      <Host sessionId="s1" onReady={() => {}} />,
    );
    const editorEl = await waitForEditor(container);
    expect(editorEl).not.toBeNull();
    await waitForText(editorEl!, '草稿文本');
    await waitForPills(container, 1);
    // pill 属性保真（deserialize → insertContent 后 MentionNodeView 渲染）
    const pill = container.querySelector('[data-mention-icon]');
    expect(pill?.getAttribute('data-mention-icon')).toBe('member');
    expect(pill?.getAttribute('data-mention-label')).toBe('张三');
  });

  it('无草稿 + initialContent → prefill 注入（回归）', async () => {
    let readyApi: ReturnType<typeof useChatDraft> | null = null;
    const { container } = render(
      <Host
        sessionId="s1"
        initialContent={[{ type: 'member', id: 'm2', icon: 'member', label: '李四' }]}
        onReady={(api) => { readyApi = api; }}
      />,
    );
    const editorEl = await waitForEditor(container);
    await waitForPills(container, 1);
    const pill = container.querySelector('[data-mention-icon]');
    expect(pill?.getAttribute('data-mention-icon')).toBe('member');
    expect(pill?.getAttribute('data-mention-label')).toBe('李四');
    // 无草稿 → store 不产生 drafts key
    expect(storeRef.current.getState().drafts['s1']).toBeUndefined();
  });

  it('草稿优先：有草稿时 initialContent（prefill）不注入', async () => {
    storeRef.current.getState().saveDraft('s1', '草稿优先文本');
    const { container } = render(
      <Host
        sessionId="s1"
        initialContent={[{ type: 'member', id: 'm2', icon: 'member', label: '李四' }]}
        onReady={() => {}}
      />,
    );
    const editorEl = await waitForEditor(container);
    await waitForText(editorEl!, '草稿优先文本');
    // 草稿恢复后 prefill 不注入 → 无 pill（initialContent 被跳过）
    expect(container.querySelectorAll('[data-mention-icon]').length).toBe(0);
  });

  it('saveDraft action：serializeEditorContent 写缓存（含 pill）', async () => {
    let readyApi: { saveDraft: (ed: DraftEditorLike) => void; clearDraft: () => void } | null = null;
    let readyEditor: ReturnType<typeof useEditor> | null = null;
    const { container } = render(
      <Host sessionId="s1" onReady={(api, ed) => { readyApi = api; readyEditor = ed; }} />,
    );
    const editorEl = await waitForEditor(container);
    expect(editorEl).not.toBeNull();
    // 等 onReady 已触发（editor 就绪）
    const deadline = Date.now() + 5000;
    while (!readyApi && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(readyApi).not.toBeNull();
    // editor 写入内容（命令式，不触发 onUpdate；hook 的 saveDraft 直接 serialize 写 store）
    act(() => {
      readyEditor!.chain().focus().insertContent('缓存文本').run();
    });
    act(() => {
      readyApi!.saveDraft(readyEditor!);
    });
    expect(storeRef.current.getState().drafts['s1']).toBe('缓存文本');
  });

  it('恢复后 saveDraft 回写同值幂等（store 不重复 set）', async () => {
    storeRef.current.getState().saveDraft('s1', '同值草稿');
    let readyApi: { saveDraft: (ed: DraftEditorLike) => void; clearDraft: () => void } | null = null;
    let readyEditor: ReturnType<typeof useEditor> | null = null;
    const { container } = render(
      <Host sessionId="s1" onReady={(api, ed) => { readyApi = api; readyEditor = ed; }} />,
    );
    const editorEl = await waitForEditor(container);
    await waitForText(editorEl!, '同值草稿');
    const deadline = Date.now() + 5000;
    while (!readyApi && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    // 恢复后 editor 内容 == 草稿；saveDraft 回写同值 → store 不重复 set
    const spy = vi.fn();
    const unsub = storeRef.current.subscribe(spy);
    act(() => {
      readyApi!.saveDraft(readyEditor!);
    });
    expect(spy).not.toHaveBeenCalled();
    unsub();
  });

  it('clearDraft action：清除 store drafts key', async () => {
    storeRef.current.getState().saveDraft('s1', '待清除');
    let readyApi: { saveDraft: (ed: DraftEditorLike) => void; clearDraft: () => void } | null = null;
    const { container } = render(
      <Host sessionId="s1" onReady={(api) => { readyApi = api; }} />,
    );
    const editorEl = await waitForEditor(container);
    expect(editorEl).not.toBeNull();
    const deadline = Date.now() + 5000;
    while (!readyApi && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(storeRef.current.getState().drafts['s1']).toBe('待清除');
    act(() => {
      readyApi!.clearDraft();
    });
    expect(storeRef.current.getState().drafts['s1']).toBeUndefined();
  });

  it('saveDraft 空内容 → 自动清除（PRD §2.2 空草稿不写）', async () => {
    let readyApi: { saveDraft: (ed: DraftEditorLike) => void; clearDraft: () => void } | null = null;
    let readyEditor: ReturnType<typeof useEditor> | null = null;
    const { container } = render(
      <Host sessionId="s1" onReady={(api, ed) => { readyApi = api; readyEditor = ed; }} />,
    );
    const editorEl = await waitForEditor(container);
    expect(editorEl).not.toBeNull();
    const deadline = Date.now() + 5000;
    while (!readyApi && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    // 先写内容再清空（serialize 空串 → saveDraft 空 → 删 key）
    act(() => {
      readyEditor!.chain().focus().insertContent('abc').run();
      readyApi!.saveDraft(readyEditor!);
    });
    expect(storeRef.current.getState().drafts['s1']).toBe('abc');
    act(() => {
      readyEditor!.commands.clearContent();
      readyApi!.saveDraft(readyEditor!);
    });
    expect(storeRef.current.getState().drafts['s1']).toBeUndefined();
  });
});
