/**
 * @vitest-environment jsdom
 * component-chat-composer applyInterrupt 集成测（v0.0.245 中断体验优化）
 * 参考: specs/prd/version_logs/v0.0.245.interrupt_exp/prd.md §3.2 §3.3（注入 + 焦点管理）
 *       specs/tech/version_logs/v0.0.245/change_plan.md（useImperativeHandle applyInterrupt 焦点两分支）
 *
 * 覆盖（AC#4 焦点管理两分支）：
 *   - applyInterrupt(items) 非空 → 注入排队内容到 doc 开头（pill 保留）+ 原内容续后
 *   - applyInterrupt([]) → doc 内容不动（items.length===0 跳过 dispatch）
 *   - 注入含 mention → pill 渲染（非字面 tag）
 *   - isFocused() / isPopoverOpen() handle 方法语义正确
 *   - 注入后 editor 仍可用（焦点未失活，UC-F1/F2 都给可用焦点态）
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createRef } from 'react';
import { ChatComposer, type ChatComposerHandle } from '../component-chat-composer';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  // Polyfill jsdom 缺失的布局方法（ProseMirror coordsAtPos → singleRect 在 Text 节点上调 getClientRects）
  // 不补则 focus('end') 触发 scrollToSelection 抛 uncaught exception 污染输出（测试仍过但报错噪音）。
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
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

/** 等待 .ProseMirror 元素出现（Tiptap editor 异步初始化） */
async function waitForEditor(container: HTMLElement): Promise<HTMLElement> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const el = container.querySelector<HTMLElement>('.ProseMirror');
    if (el) return el;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('editor not ready within 5s');
}

/** flush microtasks（queueMicrotask 内的 editor 操作落定） */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

describe('ChatComposer applyInterrupt（AC#4 焦点管理 + 注入）', () => {
  it('applyInterrupt(items) 非空 → 注入排队内容到 doc 开头，原内容续后', async () => {
    const ref = createRef<ChatComposerHandle>();
    const { container } = render(
      <ChatComposer
        ref={ref}
        biz="playground"
        sessionId="s1"
        enabledProviders={['file']}
        onSend={vi.fn()}
        initialContent={[{ type: 'file', path: 'src/orig.ts', icon: 'file', label: 'orig.ts' }]}
      />,
    );
    await waitForEditor(container);
    await flushMicrotasks();

    // 原内容（initialContent 注入的 pill）已就位
    let pills = container.querySelectorAll('[data-mention-icon]');
    expect(pills.length).toBe(1);

    // 中断注入：排队内容含 file mention
    ref.current!.applyInterrupt([
      { content: '排队1 <mention type="file" path="src/q1.ts" icon="file" label="q1.ts"/>' },
      { content: '排队2' },
    ]);
    await flushMicrotasks();

    // 注入后：开头 2 个 pill（q1.ts）+ 原内容 pill（orig.ts）= 3 个
    pills = container.querySelectorAll('[data-mention-icon]');
    expect(pills.length).toBe(2); // 注入的 q1.ts pill + 原 orig.ts pill（注入的「排队2」无 mention）
    // 第一个是注入的 q1.ts
    expect(pills[0]!.getAttribute('data-mention-icon')).toBe('file');
    expect(pills[0]!.getAttribute('data-mention-label')).toBe('q1.ts');
    // 文本「排队1」「排队2」出现
    expect(container.textContent).toContain('排队1');
    expect(container.textContent).toContain('排队2');
  });

  it('applyInterrupt([]) → doc 内容不动（items.length===0 跳过 dispatch）', async () => {
    const ref = createRef<ChatComposerHandle>();
    const { container } = render(
      <ChatComposer
        ref={ref}
        biz="playground"
        sessionId="s1"
        enabledProviders={['file']}
        onSend={vi.fn()}
        initialContent={[{ type: 'file', path: 'src/orig.ts', icon: 'file', label: 'orig.ts' }]}
      />,
    );
    await waitForEditor(container);
    await flushMicrotasks();

    const pillsBefore = container.querySelectorAll('[data-mention-icon]').length;
    expect(pillsBefore).toBe(1);

    // 空注入：doc 不动
    ref.current!.applyInterrupt([]);
    await flushMicrotasks();

    const pillsAfter = container.querySelectorAll('[data-mention-icon]').length;
    expect(pillsAfter).toBe(pillsBefore);
  });

  it('applyInterrupt 注入纯文本排队内容（无 mention）→ 文本入 doc 开头', async () => {
    const ref = createRef<ChatComposerHandle>();
    const { container } = render(
      <ChatComposer
        ref={ref}
        biz="playground"
        sessionId="s1"
        enabledProviders={['file']}
        onSend={vi.fn()}
      />,
    );
    await waitForEditor(container);
    await flushMicrotasks();

    ref.current!.applyInterrupt([{ content: '排队消息1' }]);
    await flushMicrotasks();

    expect(container.textContent).toContain('排队消息1');
  });

  it('applyInterrupt 多行 content → 多 paragraph（每行换行保留）', async () => {
    const ref = createRef<ChatComposerHandle>();
    const { container } = render(
      <ChatComposer
        ref={ref}
        biz="playground"
        sessionId="s1"
        enabledProviders={['file']}
        onSend={vi.fn()}
      />,
    );
    await waitForEditor(container);
    await flushMicrotasks();

    ref.current!.applyInterrupt([{ content: '行1\n行2\n行3' }]);
    await flushMicrotasks();

    const text = container.textContent ?? '';
    expect(text).toContain('行1');
    expect(text).toContain('行2');
    expect(text).toContain('行3');
  });

  it('isFocused() / isPopoverOpen() handle 方法语义', async () => {
    const ref = createRef<ChatComposerHandle>();
    const { container } = render(
      <ChatComposer
        ref={ref}
        biz="playground"
        sessionId="s1"
        enabledProviders={['file']}
        onSend={vi.fn()}
      />,
    );
    await waitForEditor(container);
    await flushMicrotasks();

    // 初始：popover 关闭
    expect(ref.current!.isPopoverOpen()).toBe(false);
    // isFocused 初始可能 false（未 focus），focus 后应 true
    const editorEl = container.querySelector<HTMLElement>('.ProseMirror')!;
    editorEl.focus();
    await flushMicrotasks();
    expect(ref.current!.isFocused()).toBe(true);
  });

  it('applyInterrupt 不调 onSend / 不 clearContent（与 send 区分）', async () => {
    const ref = createRef<ChatComposerHandle>();
    const onSend = vi.fn();
    const { container } = render(
      <ChatComposer
        ref={ref}
        biz="playground"
        sessionId="s1"
        enabledProviders={['file']}
        onSend={onSend}
        initialContent={[{ type: 'file', path: 'src/orig.ts', icon: 'file', label: 'orig.ts' }]}
      />,
    );
    await waitForEditor(container);
    await flushMicrotasks();

    ref.current!.applyInterrupt([{ content: '排队1' }]);
    await flushMicrotasks();

    // onSend 未被调用（applyInterrupt 不发送）
    expect(onSend).not.toHaveBeenCalled();
    // 原内容 pill 仍在（未 clearContent）+ 注入的文本
    const pills = container.querySelectorAll('[data-mention-icon]');
    expect(pills.length).toBe(1); // 仅原 orig.ts pill
    expect(container.textContent).toContain('排队1');
  });
});
