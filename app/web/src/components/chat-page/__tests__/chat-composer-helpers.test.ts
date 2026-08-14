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
import { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Fragment, Slice } from '@tiptap/pm/model';
import { ReplaceAroundStep } from '@tiptap/pm/transform';
import {
  injectInitialContent,
  injectMentions,
  restoreDraftContent,
  getInsertedText,
  scanMentionQuery,
  detectMentionTrigger,
} from '../chat-composer-helpers';
import { MentionNode } from '../chat-composer-extension';
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

/** 构造真实 schema 的 Editor（StarterKit + MentionNode，与 composer 同款 extensions） */
function makeRealEditor(initialHTML = '<p></p>'): Editor {
  return new Editor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        horizontalRule: false,
      }),
      MentionNode,
    ],
    content: initialHTML,
  });
}

describe('getInsertedText（v0.0.346 插入文本提取，纯函数）', () => {
  it('ReplaceStep：提取 slice 文本（插入 @ 字符）', () => {
    const editor = makeRealEditor('<p></p>');
    try {
      const tr = editor.state.tr.insertText('@');
      expect(getInsertedText(tr)).toBe('@');
    } finally {
      editor.destroy();
    }
  });

  it('多步拼接：多次插入累积（@ 后追加 he）', () => {
    const editor = makeRealEditor('<p></p>');
    try {
      const tr1 = editor.state.tr.insertText('@');
      const tr2 = tr1.insertText('he');
      expect(getInsertedText(tr2)).toBe('@he');
    } finally {
      editor.destroy();
    }
  });

  it('替换已有选区（删除旧文本插新）→ 提取插入文本', () => {
    const editor = makeRealEditor('<p>hello</p>');
    try {
      // 选中 1..5（ello）替换为 @x → slice 文本 = @x
      editor.chain().setTextSelection({ from: 1, to: 5 }).run();
      const tr = editor.state.tr.replaceWith(1, 5, editor.state.schema.text('@x'));
      expect(getInsertedText(tr)).toBe('@x');
    } finally {
      editor.destroy();
    }
  });

  it('ReplaceAroundStep：提取 slice 文本（gap 保留场景）', () => {
    const editor = makeRealEditor('<p>ab</p>');
    try {
      // 构造 ReplaceAroundStep：wrap 结构文本 around gap
      const slice = new Slice(Fragment.from(editor.state.schema.text('@')), 0, 0);
      const step = new ReplaceAroundStep(0, 0, 2, 2, slice, 0);
      const tr = editor.state.tr;
      // 直接 push step（构造语义即可，不要求 apply 成功）
      (tr as unknown as { steps: unknown[] }).steps.push(step);
      expect(getInsertedText(tr as never)).toBe('@');
    } finally {
      editor.destroy();
    }
  });

  it('非 Replace 类 step（如 AddMarkStep）不贡献文本 → 返回空串', () => {
    const editor = makeRealEditor('<p>hello</p>');
    try {
      const tr = editor.state.tr;
      // 用真实 AddMarkStep：给 1..3 加 bold mark（Tiptap StarterKit 的 mark 名为 bold）
      editor.chain().setTextSelection({ from: 1, to: 3 }).run();
      const boldType = editor.schema.marks.bold;
      expect(boldType).toBeTruthy();
      tr.addMark(1, 3, boldType!.create());
      expect(getInsertedText(tr as never)).toBe('');
    } finally {
      editor.destroy();
    }
  });
});

describe('scanMentionQuery（v0.0.346 纯扫描，唯一扫描实现）', () => {
  it('无 @ → null', () => {
    const editor = makeRealEditor('<p>hello world</p>');
    try {
      editor.chain().setTextSelection(6).run(); // 光标在 hello 后
      expect(scanMentionQuery(editor as never)).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  it('@ 在末尾（无 query）→ 空串', () => {
    const editor = makeRealEditor('<p>@</p>');
    try {
      editor.chain().setTextSelection(2).run(); // 光标在 @ 后
      expect(scanMentionQuery(editor as never)).toBe('');
    } finally {
      editor.destroy();
    }
  });

  it('@he → query=he', () => {
    const editor = makeRealEditor('<p>@he</p>');
    try {
      editor.chain().setTextSelection(4).run(); // 光标在 @he 后
      expect(scanMentionQuery(editor as never)).toBe('he');
    } finally {
      editor.destroy();
    }
  });

  it('@ 被空格中断 → null（空格后的 @ 不算）', () => {
    const editor = makeRealEditor('<p>@he world</p>');
    try {
      editor.chain().setTextSelection(9).run(); // 光标在 world 后
      // 最近的是空格后无 @ → null
      expect(scanMentionQuery(editor as never)).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  it('@ 后带空格再输字符 → 空格中断（query 为空格后内容，非 @ 后）', () => {
    const editor = makeRealEditor('<p>@he wo</p>');
    try {
      editor.chain().setTextSelection(7).run(); // 光标在 wo 后
      // @he 后是空格 → @(\S*)$ 不匹配（空格中断）→ null
      expect(scanMentionQuery(editor as never)).toBeNull();
    } finally {
      editor.destroy();
    }
  });
});

describe('detectMentionTrigger（v0.0.346 插入文本门控）', () => {
  it('insertedText 含 @ → 返回 scanMentionQuery(ed)（触发/重触发）', () => {
    const editor = makeRealEditor('<p>@he</p>');
    try {
      editor.chain().setTextSelection(4).run();
      expect(detectMentionTrigger(editor as never, '@')).toBe('he');
      expect(detectMentionTrigger(editor as never, '@he')).toBe('he');
    } finally {
      editor.destroy();
    }
  });

  it('insertedText 含 @ 且 @ 在末尾 → 空串（触发，query 空）', () => {
    const editor = makeRealEditor('<p>@</p>');
    try {
      editor.chain().setTextSelection(2).run();
      expect(detectMentionTrigger(editor as never, '@')).toBe('');
    } finally {
      editor.destroy();
    }
  });

  it('insertedText 不含 @ → null（不触发：取消后输 1/2/3 不弹、删除回 @ 不弹、选中后输入不弹）', () => {
    const editor = makeRealEditor('<p>@123</p>');
    try {
      editor.chain().setTextSelection(5).run();
      expect(detectMentionTrigger(editor as never, '123')).toBeNull();
      expect(detectMentionTrigger(editor as never, '1')).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  it('insertedText 不含 @ 但 doc 有 @ → 仍 null（插入文本门控只管本次插入）', () => {
    const editor = makeRealEditor('<p>@he world</p>');
    try {
      editor.chain().setTextSelection(9).run();
      // doc 里有 @he，但本次插入的是 'world'（不含 @）→ 不触发
      expect(detectMentionTrigger(editor as never, 'world')).toBeNull();
    } finally {
      editor.destroy();
    }
  });
});
