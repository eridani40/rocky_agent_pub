/**
 * @vitest-environment jsdom
 * component-chat-composer 单测（v0.0.86 mention 报文重构 client 侧）
 * 参考: specs/ui/components/chat-page/chat-composer.md
 *       specs/tech/mention/message-content.md（display flat 属性）
 *       specs/ui/components/chat-page/mention-pill.md（v0.0.86 新 pill 契约）
 *       specs/tech/version_logs/v0.0.147.flushsync/change_plan.md（microtask 延迟）
 *
 * v0.0.86 变更：
 *   - initialContent shape：MentionAttrs 含 display 三字段（icon/label/badge?）
 *   - data-mention-type → data-mention-icon（type 不再透传 DOM）
 *   - data-mention-label 现为裸名（不含 @ 前缀，前缀由 pill 加）
 *
 * v0.0.147.flushsync 变更：
 *   - 两处 useEffect 内 editor 操作（setEditable / chain.run）推迟到 queueMicrotask，
 *     移出 React commit phase 以消除 @tiptap/react 库内部 flushSync 触发的 lifecycle 警告。
 *   - 测试需异步等待 microtask 落定后再断言（pill 注入 / contenteditable 同步）。
 *
 * 覆盖：
 *   - PROVIDER_LABELS 扩 4 项（file/skill/workitem/member）→ enabledProviders filter 不丢
 *   - initialContent mount-time 注入为 pill（v0.0.86 新 attrs 形状，异步 microtask 注入）
 *   - initialContent 缺省 → 编辑器空，不调 insertMention
 *   - initialContent 仅在 editor 首次就绪时注入一次（ref guard 防重复）
 *   - disabled 变更 → editor 可编辑态同步（v0.0.147.flushsync 新增，异步 microtask 同步）
 */
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { createRef } from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { ChatComposer, type ChatComposerHandle } from '../component-chat-composer';
import { initI18n } from '../../../i18n';
import { useChatStore } from '../../../store/chat-slice';

// [v0.0.62 i18n] 启动 i18next：placeholder 走 common.composer.placeholder
// Polyfill jsdom 缺失的布局方法（ProseMirror coordsAtPos → singleRect 在 Text 节点上调 getClientRects）
beforeAll(async () => {
  const fakeRects = () =>
    [{ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }] as never;
  const fakeRect = () =>
    ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => {} }) as never;
  const TextProto = Text.prototype as unknown as { getClientRects?: unknown; getBoundingClientRect?: unknown };
  if (typeof TextProto.getClientRects !== 'function') TextProto.getClientRects = fakeRects;
  if (typeof TextProto.getBoundingClientRect !== 'function') TextProto.getBoundingClientRect = fakeRect;
  const RangeProto = Range.prototype as unknown as { getClientRects?: unknown; getBoundingClientRect?: unknown };
  if (typeof RangeProto.getClientRects !== 'function') RangeProto.getClientRects = fakeRects;
  if (typeof RangeProto.getBoundingClientRect !== 'function') RangeProto.getBoundingClientRect = fakeRect;
  // [v0.0.346] MentionPopover 挂载后 focusIndex 可见性 effect 调 scrollIntoView（jsdom 缺失）
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = () => {};
  }
  await initI18n('zh-CN');
});

// [v0.0.267] 草稿集成用例隔离：每用例清空单例 drafts（ChatComposer 真实读写 useChatStore 单例）
beforeEach(() => {
  useChatStore.setState({ drafts: {} });
  // [v0.0.346] MentionPopover doSearch 走 fetch；mock 返回空结果（双层门控用例关注面板开关，不关注结果）
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], nextCursor: null }),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ChatComposer（v0.0.86 display 字段重构）', () => {
  it('mount：enabledProviders 含 workitem/member 时不丢（PROVIDER_LABELS 扩 4 项）', () => {
    const { container } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file', 'skill', 'workitem', 'member']}
        onSend={() => {}}
      />,
    );
    expect(container.querySelector('[data-biz-type]')).toBeTruthy();
  });

  it('initialContent mount-time 注入为 pill（workitem/member 含 display 字段）', async () => {
    const { container } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file', 'skill', 'workitem', 'member']}
        onSend={() => {}}
        initialContent={[
          { type: 'workitem', kind: 'task', id: 'T-0001', icon: 'task', label: '接口联调' },
          { type: 'member', id: 'm1', icon: 'member', label: '张三' },
        ]}
      />,
    );
    await waitForPills(container, 2);
    const pills = container.querySelectorAll('[data-mention-icon]');
    expect(pills.length).toBe(2);
    // 第一颗：workitem，data-mention-icon=task，label=裸名「接口联调」
    expect(pills[0]!.getAttribute('data-mention-icon')).toBe('task');
    expect(pills[0]!.getAttribute('data-mention-label')).toBe('接口联调');
    // 第二颗：member，data-mention-icon=member，label=裸名「张三」
    expect(pills[1]!.getAttribute('data-mention-icon')).toBe('member');
    expect(pills[1]!.getAttribute('data-mention-label')).toBe('张三');
  });

  it('initialContent 缺省 → 编辑器空，不渲染 pill', async () => {
    const { container } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file', 'skill']}
        onSend={() => {}}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    const pills = container.querySelectorAll('[data-mention-icon]');
    expect(pills.length).toBe(0);
  });

  it('initialContent=[] 空数组 → 等价缺省，不注入', async () => {
    const { container } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file', 'skill']}
        onSend={() => {}}
        initialContent={[]}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    const pills = container.querySelectorAll('[data-mention-icon]');
    expect(pills.length).toBe(0);
  });

  it('initialContent 仅在 editor 首次就绪时注入一次（ref guard 防重复）', async () => {
    const initialContent = [
      { type: 'workitem', kind: 'task', id: 'T-0002', icon: 'task', label: '另一个任务' },
    ];
    const { container, rerender } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file', 'skill']}
        onSend={() => {}}
        initialContent={initialContent}
      />,
    );
    await waitForPills(container, 1);
    rerender(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file', 'skill']}
        onSend={() => {}}
        initialContent={initialContent}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    const pills = container.querySelectorAll('[data-mention-icon]');
    expect(pills.length).toBe(1);
  });

  it('initialContent 多类型混合 → 全部按顺序注入（file/skill/workitem/member）', async () => {
    const { container } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file', 'skill', 'workitem', 'member']}
        onSend={() => {}}
        initialContent={[
          { type: 'file', path: 'src/a.ts', icon: 'file', label: 'a.ts' },
          { type: 'skill', path: '/skills/foo', icon: 'skill', label: 'foo' },
          { type: 'workitem', kind: 'goal', id: 'G-0001', icon: 'goal', label: '提升DAU' },
          { type: 'member', id: 'm2', icon: 'member', label: '李四', badge: 'leader' },
        ]}
      />,
    );
    await waitForPills(container, 4);
    const pills = container.querySelectorAll('[data-mention-icon]');
    expect(pills.length).toBe(4);
    expect(pills[0]!.getAttribute('data-mention-icon')).toBe('file');
    expect(pills[1]!.getAttribute('data-mention-icon')).toBe('skill');
    expect(pills[2]!.getAttribute('data-mention-icon')).toBe('goal');
    expect(pills[3]!.getAttribute('data-mention-icon')).toBe('member');
    // 第 4 颗 member leader 有 badge
    expect(pills[3]!.getAttribute('data-mention-badge')).toBe('leader');
  });

  it('initialContent=string → 注成可编辑 text node（业务全景引导模板）', async () => {
    const { container } = render(
      <ChatComposer
        biz="studio"
        sessionRole="leader"
        sessionId="s1"
        enabledProviders={['file', 'skill']}
        onSend={() => {}}
        initialContent="帮我搭建一个看板，展示…"
      />,
    );
    const editorEl = await waitForEditor(container);
    expect(editorEl).not.toBeNull();
    // 等待 queueMicrotask 内 injectInitialContent 落定（text node 注入）
    await waitForText(editorEl!, '帮我搭建一个看板，展示…');
    // 预填是真实 text node（contenteditable 可编辑，非只读 placeholder）
    expect(editorEl!.getAttribute('contenteditable')).toBe('true');
    expect(editorEl!.textContent).toContain('帮我搭建一个看板，展示…');
    // 不渲染任何 mention pill（纯文本分支）
    expect(container.querySelectorAll('[data-mention-icon]').length).toBe(0);
  });

  it('initialContent=string ref-guard 防重注入（rerender 不重复文本）', async () => {
    const { container, rerender } = render(
      <ChatComposer
        biz="studio"
        sessionRole="leader"
        sessionId="s1"
        enabledProviders={['file']}
        onSend={() => {}}
        initialContent="帮我搭建一个看板，展示…"
      />,
    );
    const editorEl = await waitForEditor(container);
    await waitForText(editorEl!, '帮我搭建一个看板，展示…');
    rerender(
      <ChatComposer
        biz="studio"
        sessionRole="leader"
        sessionId="s1"
        enabledProviders={['file']}
        onSend={() => {}}
        initialContent="帮我搭建一个看板，展示…"
      />,
    );
    await flushMicrotasks();
    // 文本仅出现一次（ref guard 防第二次 effect 重注入）
    const occurrences = (editorEl!.textContent ?? '').match(/帮我搭建一个看板/g)?.length ?? 0;
    expect(occurrences).toBe(1);
  });
});

/**
 * 等待 container 内 pill 数量达到 expected（轮询 200ms×25 = 5s 上限）。
 * Tiptap editor 在 jsdom 下 useEditor 异步初始化，pill 注入 effect 在 editor 就绪后触发。
 * v0.0.147.flushsync 起 pill 注入在 queueMicrotask 内执行，轮询仍能稳定捕获（macro task > micro task）。
 */
async function waitForPills(container: HTMLElement, expected: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const n = container.querySelectorAll('[data-mention-icon]').length;
    if (n >= expected) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * 刷新微任务队列：让 queueMicrotask 内的 editor 操作落定。
 * v0.0.147.flushsync 两处 effect（setEditable / chain.run）都延后到 microtask；
 * 用 setTimeout(0)（macrotask）作为 barrier 保证挂起的 microtasks 都跑完。
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 等待 .ProseMirror 元素出现（Tiptap editor 异步初始化）。
 * 返回该元素或 null。
 */
async function waitForEditor(container: HTMLElement): Promise<HTMLElement | null> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const el = container.querySelector<HTMLElement>('.ProseMirror');
    if (el) return el;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/**
 * 等待 editor 元素内出现指定文本（string initialContent 注入回路）。
 * queueMicrotask 内 injectInitialContent → insertContent 注成 text node，轮询 5s 上限。
 */
async function waitForText(editorEl: HTMLElement, expected: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((editorEl.textContent ?? '').includes(expected)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('ChatComposer（v0.0.147.flushsync disabled 同步 editor 可编辑态）', () => {
  // ProseMirror 编辑器 contenteditable 属性反映 editor.isEditable；
  // setEditable 现走 queueMicrotask（移出 commit phase），断言前需 flushMicrotasks。
  it('disabled=true → editor contenteditable=false', async () => {
    const { container } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file']}
        onSend={() => {}}
        disabled={true}
      />,
    );
    await waitForEditor(container);
    await flushMicrotasks();
    const editorEl = container.querySelector<HTMLElement>('.ProseMirror');
    expect(editorEl).not.toBeNull();
    expect(editorEl!.getAttribute('contenteditable')).toBe('false');
  });

  it('disabled 缺省（false）→ editor contenteditable=true', async () => {
    const { container } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file']}
        onSend={() => {}}
      />,
    );
    await waitForEditor(container);
    await flushMicrotasks();
    const editorEl = container.querySelector<HTMLElement>('.ProseMirror');
    expect(editorEl).not.toBeNull();
    expect(editorEl!.getAttribute('contenteditable')).toBe('true');
  });

  it('rerender：disabled false → true → false，contenteditable 随之同步', async () => {
    const { container, rerender } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file']}
        onSend={() => {}}
      />,
    );
    await waitForEditor(container);
    await flushMicrotasks();
    let editorEl = container.querySelector<HTMLElement>('.ProseMirror');
    expect(editorEl!.getAttribute('contenteditable')).toBe('true');

    // false → true：rerender 后 effect 重跑，setEditable 走 microtask
    rerender(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file']}
        onSend={() => {}}
        disabled={true}
      />,
    );
    await flushMicrotasks();
    editorEl = container.querySelector<HTMLElement>('.ProseMirror');
    expect(editorEl!.getAttribute('contenteditable')).toBe('false');

    // true → false：rerender 回可编辑
    rerender(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file']}
        onSend={() => {}}
        disabled={false}
      />,
    );
    await flushMicrotasks();
    editorEl = container.querySelector<HTMLElement>('.ProseMirror');
    expect(editorEl!.getAttribute('contenteditable')).toBe('true');
  });
});

describe('ChatComposer（v0.0.267 输入草稿缓存）', () => {
  it('mount 有草稿 → 编辑器恢复内容（草稿优先于 prefill）', async () => {
    useChatStore.getState().saveDraft('s1', '恢复的草稿文本');
    const { container } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file']}
        onSend={() => {}}
        initialContent={[{ type: 'member', id: 'm9', icon: 'member', label: 'prefill' }]}
      />,
    );
    const editorEl = await waitForEditor(container);
    await waitForText(editorEl!, '恢复的草稿文本');
    // 草稿优先：prefill 不注入 → 无 pill
    expect(container.querySelectorAll('[data-mention-icon]').length).toBe(0);
  });

  it('输入 → onUpdate 实时写 drafts[sessionId]（编辑即写缓存）', async () => {
    const { container } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file']}
        onSend={() => {}}
      />,
    );
    const editorEl = await waitForEditor(container);
    expect(editorEl).not.toBeNull();
    // 模拟 ProseMirror 输入：改 DOM 文本 + input 事件 → mutation observer 同步 doc → onUpdate → saveDraft
    editorEl!.textContent = '输入的草稿';
    fireEvent.input(editorEl!);
    await flushMicrotasks();
    expect(useChatStore.getState().drafts['s1']).toBe('输入的草稿');
  });

  it('发送 → clearDraft（草稿清除）', async () => {
    useChatStore.getState().saveDraft('s1', '待发送草稿');
    const onSend = vi.fn();
    const ref = createRef<ChatComposerHandle>();
    const { container } = render(
      <ChatComposer
        ref={ref}
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file']}
        onSend={onSend}
      />,
    );
    const editorEl = await waitForEditor(container);
    await waitForText(editorEl!, '待发送草稿');
    expect(useChatStore.getState().drafts['s1']).toBe('待发送草稿');
    // 通过 ref send() 触发 handleSubmit（等价 Enter）
    act(() => {
      ref.current?.send();
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().drafts['s1']).toBeUndefined();
  });

  it('无草稿 + prefill → prefill 注入（草稿语境回归）', async () => {
    const { container } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file', 'skill', 'workitem', 'member']}
        onSend={() => {}}
        initialContent={[{ type: 'workitem', kind: 'task', id: 'T-0001', icon: 'task', label: '接口联调' }]}
      />,
    );
    await waitForPills(container, 1);
    const pill = container.querySelector('[data-mention-icon]');
    expect(pill?.getAttribute('data-mention-icon')).toBe('task');
    expect(pill?.getAttribute('data-mention-label')).toBe('接口联调');
    // prefill 注入触发 onUpdate → 实时写缓存（change_plan 风险点 4：内容等价保存，预期行为）
    // 用户切走再切回会恢复该 prefill 内容（= 草稿语义）
    expect(useChatStore.getState().drafts['s1']).toContain('接口联调');
  });
});

/**
 * v0.0.346 双层门控组件级测试。
 * 输入模拟：.ProseMirror 元素上 Tiptap 挂 editor 属性，editor.view.dispatch(tr.insertText())
 * 走真实 ProseMirror 输入路径（selection 自动跟随 → onUpdate → detectTrigger）。
 * 参考: specs/tech/version_logs/v0.0.346/change_plan.md（触发修复机制：插入文本门控 + 面板状态门控）
 */
type TiptapEditorLike = {
  view: {
    dispatch: (tr: unknown) => void;
    state: { tr: { insertText: (t: string) => unknown; scrollIntoView: () => unknown } };
  };
};

/** 从 .ProseMirror 元素取 Tiptap editor 引用 */
function getTiptapEditor(container: HTMLElement): TiptapEditorLike {
  const el = container.querySelector<HTMLElement>('.ProseMirror');
  expect(el).not.toBeNull();
  const editor = (el as unknown as { editor?: TiptapEditorLike }).editor;
  expect(editor).toBeTruthy();
  return editor!;
}

/** 模拟真实输入：dispatch insertText（selection 自动跟随光标末尾） */
function typeText(container: HTMLElement, text: string): void {
  const editor = getTiptapEditor(container);
  act(() => {
    editor.view.dispatch((editor.view.state.tr.insertText(text) as unknown as { scrollIntoView: () => unknown }).scrollIntoView());
  });
}

/** 读 popover search input 当前 query；面板未开 → null */
function popoverQuery(container: HTMLElement): string | null {
  const input = container.querySelector<HTMLInputElement>('[data-action-key="chat.mention.search"]');
  return input ? input.value : null;
}

/** 等待 popover 出现/消失（轮询 3s 上限；debounce 200ms + React 渲染） */
async function waitForPopover(container: HTMLElement, open: boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const present = !!container.querySelector('[data-action-key="chat.mention.search"]');
    if (present === open) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('ChatComposer（v0.0.346 @ 触发双层门控）', () => {
  it('UC-4：输入 @ → 面板弹出（query 空）；@ 后输 he → 面板保持 + query 实时更新', async () => {
    const { container } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file', 'skill', 'workitem', 'member']}
        onSend={() => {}}
      />,
    );
    await waitForEditor(container);
    // 输入 @ → 触发（插入文本含 @）
    typeText(container, '@');
    await waitForPopover(container, true);
    expect(popoverQuery(container)).toBe('');
    // @ 后输 he → 插入文本不含 @ 但面板开着 → 保留面板仅刷新 query（UC-4）
    typeText(container, 'he');
    await waitForPopover(container, true);
    expect(popoverQuery(container)).toBe('he');
    // 再输 w → query 继续实时更新
    typeText(container, 'w');
    await waitForPopover(container, true);
    expect(popoverQuery(container)).toBe('hew');
  });

  it('UC-1/2：面板关着输非 @（123）→ 不弹（插入文本门控 null + 面板状态 null）', async () => {
    const { container } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file', 'skill', 'workitem', 'member']}
        onSend={() => {}}
      />,
    );
    await waitForEditor(container);
    // 无 @ 场景直接输 1/2/3 → 面板不弹（@123 正常显示）
    typeText(container, '1');
    await new Promise((r) => setTimeout(r, 80));
    expect(popoverQuery(container)).toBeNull();
    typeText(container, '23');
    await new Promise((r) => setTimeout(r, 80));
    expect(popoverQuery(container)).toBeNull();
    expect(container.querySelector('.ProseMirror')?.textContent).toBe('123');
  });

  it('UC-3：取消（Esc）后输 123 不重弹；再输新 @ → 面板重弹', async () => {
    const { container } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file', 'skill', 'workitem', 'member']}
        onSend={() => {}}
      />,
    );
    await waitForEditor(container);
    // 输入 @ → 面板弹
    typeText(container, '@');
    await waitForPopover(container, true);
    // Esc 取消（composer 根 handleKeyDown → handleClose → setTrigger(null)）
    act(() => {
      fireEvent.keyDown(container.firstChild as Element, { key: 'Escape' });
    });
    await waitForPopover(container, false);
    // 取消后输 123 → 插入文本不含 @ + 面板已关 → 不重弹（@123 正常显示）
    typeText(container, '123');
    await new Promise((r) => setTimeout(r, 80));
    expect(popoverQuery(container)).toBeNull();
    expect(container.querySelector('.ProseMirror')?.textContent).toBe('@123');
    // 再输新 @ → 插入文本含 @ → 面板重弹（UC-3）
    typeText(container, '@');
    await waitForPopover(container, true);
  });

  it('UC-5：选中 pill 后输入非 @ → 面板不弹（与取消同语义）', async () => {
    // 本用例需要 popover 有结果可选中：re-stub fetch 返回一个 member item
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [
            {
              type: 'member',
              id: 'm1',
              display: { icon: 'member', label: '张三' },
              listView: { title: '张三', subtitle: 'member' },
            },
          ],
          nextCursor: null,
        }),
      }),
    );
    const { container } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file', 'skill', 'workitem', 'member']}
        onSend={() => {}}
      />,
    );
    await waitForEditor(container);
    // 输入 @ → 面板弹
    typeText(container, '@');
    await waitForPopover(container, true);
    // 等搜索完成（debounce 200ms + fetch）→ 出现可选中项
    const deadline = Date.now() + 3000;
    let selectBtn: Element | null = null;
    while (Date.now() < deadline) {
      selectBtn = container.querySelector('[data-action-key="chat.mention.select"]');
      if (selectBtn) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(selectBtn).not.toBeNull();
    // 点击选中 → handleSelect 插入 pill + setTrigger(null) → 面板关
    act(() => {
      fireEvent.click(selectBtn!);
    });
    await waitForPopover(container, false);
    expect(container.querySelectorAll('[data-mention-icon]').length).toBe(1);
    // 选中后输非 @ → 插入文本门控 null + 面板已关 null → 不弹（UC-5）
    typeText(container, 'x');
    await new Promise((r) => setTimeout(r, 80));
    expect(popoverQuery(container)).toBeNull();
  });

  it('超限提示：服务端 truncated:true 且 items>0 → 列表底部渲染 i18n 文案（不阻塞加载更多）', async () => {
    // re-stub fetch：返回 truncated:true + 1 条 item（模拟 100 早停截断）
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [
            {
              type: 'file',
              path: 'src/a.ts',
              display: { icon: 'file', label: 'a.ts' },
              listView: { title: 'a.ts', subtitle: 'src' },
            },
          ],
          nextCursor: 'cursor-2',
          truncated: true,
        }),
      }),
    );
    const { container } = render(
      <ChatComposer
        biz="studio"
        sessionRole="squad"
        sessionId="s1"
        enabledProviders={['file', 'skill', 'workitem', 'member']}
        onSend={() => {}}
      />,
    );
    await waitForEditor(container);
    // 输入 @ → 面板弹 + 搜索（truncated:true）
    typeText(container, '@');
    await waitForPopover(container, true);
    // 等搜索完成 → 超限提示出现（zh-CN 文案逐字）
    const deadline = Date.now() + 3000;
    let tooMany: Element | null = null;
    while (Date.now() < deadline) {
      tooMany = container.querySelector('[data-action-key="chat.mention.search-too-many"]');
      if (tooMany) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(tooMany).not.toBeNull();
    expect(tooMany!.textContent).toContain('结果超过 100 条，请细化输入');
    // 结果项仍在（超限提示不阻塞结果渲染）
    expect(container.querySelectorAll('[data-action-key="chat.mention.select"]').length).toBe(1);
  });
});
