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
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ChatComposer } from '../component-chat-composer';
import { initI18n } from '../../../i18n';

// [v0.0.62 i18n] 启动 i18next：placeholder 走 common.composer.placeholder
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

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
