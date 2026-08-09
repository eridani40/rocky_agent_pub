/**
 * @vitest-environment jsdom
 * chat-composer-helpers 单测 —— injectInitialContent dispatcher 两分支
 * 参考: specs/tech/version_logs/v0.0.248/change_plan.md
 *       memory bottom-up-layer-verify（方法级隔离 UT）
 *
 * 覆盖：
 *   - string 分支：editor.chain().focus().insertContent(text).run() 被调（注成真实 text node）
 *   - array 分支：顺序 insertMention(attrs) 后 run（与旧 injectMentions 行为一致）
 *   - 空输入安全：空数组 → chain.run() 仍调（无 insertMention）；空串 → chain().focus().insertContent('').run()
 *   - 向后兼容：injectMentions(editor, items) 委托 injectInitialContent 走 array 分支
 */
import { describe, it, expect, vi } from 'vitest';
import { injectInitialContent, injectMentions, restoreDraftContent } from '../chat-composer-helpers';
import type { MentionAttrs } from '../chat-composer-extension';
import type { TiptapNodeJSON } from '../mention-tag';

/** 构造 mock chain：每个方法记录调用 + 返回自身以支持链式 */
function makeChain() {
  const calls: string[] = [];
  const insertContents: Array<string | TiptapNodeJSON[]> = [];
  const chain = {
    insertMention: vi.fn((attrs: MentionAttrs) => {
      calls.push(`insertMention:${attrs.type}:${attrs.label}`);
      return chain;
    }),
    insertContent: vi.fn((content: string | TiptapNodeJSON[]) => {
      insertContents.push(content);
      calls.push(`insertContent:${typeof content === 'string' ? content : `array(${content.length})`}`);
      return chain;
    }),
    focus: vi.fn(() => {
      calls.push('focus');
      return chain;
    }),
    run: vi.fn(() => {
      calls.push('run');
    }),
  };
  return { chain, calls, insertContents };
}

/** 构造 mock editor：chain() 返回上面那个 chain */
function makeEditor() {
  const { chain, calls, insertContents } = makeChain();
  return { editor: { chain: () => chain }, chain, calls, insertContents };
}

describe('injectInitialContent（dispatcher）', () => {
  it('string 分支：调 chain().focus().insertContent(text).run()（注成真实 text node）', () => {
    const { editor, calls } = makeEditor();
    injectInitialContent(editor, '帮我搭建一个看板，展示…');
    expect(calls).toEqual(['focus', 'insertContent:帮我搭建一个看板，展示…', 'run']);
  });

  it('string 空串：仍走 string 分支（守卫在 composer，helper 不做 empty check）', () => {
    const { editor, calls } = makeEditor();
    injectInitialContent(editor, '');
    expect(calls).toEqual(['focus', 'insertContent:', 'run']);
  });

  it('array 分支：顺序 insertMention(attrs) 后 run（与旧 injectMentions 行为一致）', () => {
    const { editor, calls } = makeEditor();
    const items: MentionAttrs[] = [
      { type: 'workitem', kind: 'task', id: 'T-1', icon: 'task', label: '接口联调' },
      { type: 'member', id: 'm1', icon: 'member', label: '张三' },
    ];
    injectInitialContent(editor, items);
    // array 分支不调 focus / insertContent，仅 insertMention × N + run
    expect(calls).toEqual([
      'insertMention:workitem:接口联调',
      'insertMention:member:张三',
      'run',
    ]);
  });

  it('array 空数组：for-loop 不执行，仅 chain.run() 被调', () => {
    const { editor, calls } = makeEditor();
    injectInitialContent(editor, []);
    expect(calls).toEqual(['run']);
  });
});

describe('injectMentions（向后兼容委托）', () => {
  it('委托 injectInitialContent 走 array 分支（保持旧行为）', () => {
    const { editor, calls } = makeEditor();
    const items: MentionAttrs[] = [
      { type: 'member', id: 'leader1', icon: 'member', label: 'Rocky', badge: 'leader' },
    ];
    injectMentions(editor, items);
    expect(calls).toEqual(['insertMention:member:Rocky', 'run']);
  });
});

describe('restoreDraftContent（v0.0.267 草稿恢复 dispatcher）', () => {
  it('调 chain().focus().insertContent(paragraphs).run()（mention 保真反序列化）', () => {
    const { editor, calls, insertContents } = makeEditor();
    restoreDraftContent(
      editor,
      '第一行\n<mention type="member" id="m1" icon="member" label="张三"/> 你好',
    );
    // 顺序：focus → insertContent(paragraphs 数组) → run
    expect(calls[0]).toBe('focus');
    expect(calls[1]).toContain('insertContent:array(');
    expect(calls[2]).toBe('run');
    // paragraphs 为反序列化数组（mention 保真：deserializeContentToParagraphs 输出两段）
    const paragraphs = insertContents[0] as TiptapNodeJSON[];
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.type).toBe('paragraph');
    expect(paragraphs[0]!.content?.[0]!.type).toBe('text');
    expect(paragraphs[1]!.content?.[0]!.type).toBe('mention');
    expect(paragraphs[1]!.content?.[0]!.attrs).toMatchObject({
      type: 'member',
      id: 'm1',
      icon: 'member',
      label: '张三',
    });
  });

  it('纯函数无状态：多次调用不残留（同一 editor 可重复恢复）', () => {
    const { editor, insertContents } = makeEditor();
    restoreDraftContent(editor, '一次');
    restoreDraftContent(editor, '二次');
    expect(insertContents).toHaveLength(2);
    expect((insertContents[0] as TiptapNodeJSON[])[0]!.content?.[0]!.text).toBe('一次');
    expect((insertContents[1] as TiptapNodeJSON[])[0]!.content?.[0]!.text).toBe('二次');
  });
});
