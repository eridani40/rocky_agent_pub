/**
 * @vitest-environment jsdom
 * buildInterruptTransaction 单测（v0.0.245 中断体验优化）
 * 参考: specs/prd/version_logs/v0.0.245.interrupt_exp/prd.md §3.2/§3.3（注入规格 + 焦点位置不变语义）
 *       specs/tech/version_logs/v0.0.245/change_plan.md（UC-F2 位置数学）
 *
 * 覆盖：
 *   - items.length===0 → 返 null（caller 跳过 dispatch）
 *   - tr.insert(0, nodes)：插入 doc 内容开头，原内容下移
 *   - **UC-F2 位置数学**：newFrom == oldFrom + insertedSize（mapping 干净平移，无 associativity 歧义）
 *   - 多 item flatMap → 多 paragraph 顺序插入
 *   - mention 反序列化：注入内容含 <mention/> → PM mention 节点（schema.nodeFromJSON）
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { buildInterruptTransaction, MentionNode } from '../chat-composer-extension';

/** 构造真实 schema 的 Editor（StarterKit + MentionNode，与 composer 同款 extensions） */
function makeEditor(initialHTML: string): Editor {
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

afterEach(() => {
  // Editor 实例清理（避免 jsdom 残留）
});

describe('buildInterruptTransaction', () => {
  it('items.length===0 → 返 null', () => {
    const editor = makeEditor('<p>hello</p>');
    try {
      const result = buildInterruptTransaction(editor.state, []);
      expect(result).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  it('tr.insert(0)：注入内容插 doc 开头，原内容下移', () => {
    const editor = makeEditor('<p>原内容</p>');
    try {
      const oldDocSize = editor.state.doc.nodeSize;
      const result = buildInterruptTransaction(editor.state, [{ content: '排队1' }]);
      expect(result).not.toBeNull();
      // 新 doc 比原 doc 大（注入内容存在）
      expect(result!.tr.doc.nodeSize).toBeGreaterThan(oldDocSize);
      // 新 doc 第一个 paragraph 是注入的「排队1」
      const firstChild = result!.tr.doc.firstChild;
      expect(firstChild?.textContent).toBe('排队1');
      // 第二个 paragraph 是原内容
      const secondChild = result!.tr.doc.child(1);
      expect(secondChild?.textContent).toBe('原内容');
    } finally {
      editor.destroy();
    }
  });

  it('UC-F2 位置数学：newFrom == oldFrom + insertedSize（焦点在输入区，selection 干净平移）', () => {
    const editor = makeEditor('<p>hello</p>');
    try {
      // selection 落在 "hello" 中间（position 3 = 'e' 与 'l' 之间）
      editor.chain().setTextSelection(3).run();
      const oldFrom = editor.state.selection.from;
      expect(oldFrom).toBe(3);

      const result = buildInterruptTransaction(editor.state, [{ content: '排队1' }]);
      expect(result).not.toBeNull();

      // insertedSize = 新 doc 大小 - 原 doc 大小（只 insert 无其他改动，差值即插入节点总 size）
      const insertedSize = result!.tr.doc.nodeSize - editor.state.doc.nodeSize;
      // 断言干净平移：newFrom == oldFrom + insertedSize
      expect(result!.newFrom).toBe(oldFrom + insertedSize);
      // insertedSize > 0（确实插入了内容）
      expect(insertedSize).toBeGreaterThan(0);
    } finally {
      editor.destroy();
    }
  });

  it('UC-F2 多 item：selection 平移量 = 多 paragraph 累计 insertedSize', () => {
    const editor = makeEditor('<p>原内容</p>');
    try {
      editor.chain().setTextSelection(2).run(); // 原内容中间
      const oldFrom = editor.state.selection.from;
      const oldTo = editor.state.selection.to;

      const result = buildInterruptTransaction(editor.state, [
        { content: '排队1' },
        { content: '排队2' },
      ]);
      expect(result).not.toBeNull();

      const insertedSize = result!.tr.doc.nodeSize - editor.state.doc.nodeSize;
      expect(result!.newFrom).toBe(oldFrom + insertedSize);
      expect(result!.newTo).toBe(oldTo + insertedSize);
      // 两条排队各占独立 paragraph，顺序保留
      expect(result!.tr.doc.firstChild?.textContent).toBe('排队1');
      expect(result!.tr.doc.child(1)?.textContent).toBe('排队2');
      expect(result!.tr.doc.child(2)?.textContent).toBe('原内容');
    } finally {
      editor.destroy();
    }
  });

  it('注入内容含 mention → 反序列化为 PM mention 节点（保留 pill）', () => {
    const editor = makeEditor('<p>原内容</p>');
    try {
      const content = '看 <mention type="file" path="src/a.ts" icon="file" label="a.ts"/>';
      const result = buildInterruptTransaction(editor.state, [{ content }]);
      expect(result).not.toBeNull();
      // 第一个 paragraph 内应含一个 mention 节点
      const firstP = result!.tr.doc.firstChild;
      let mentionCount = 0;
      firstP?.forEach((child: { type: { name: string }; attrs: Record<string, unknown> }) => {
        if (child.type.name === 'mention') {
          mentionCount++;
          expect(child.attrs.type).toBe('file');
          expect(child.attrs.path).toBe('src/a.ts');
          expect(child.attrs.icon).toBe('file');
          expect(child.attrs.label).toBe('a.ts');
        }
      });
      expect(mentionCount).toBe(1);
    } finally {
      editor.destroy();
    }
  });

  it('多行 content → 多 paragraph（每行一个，顺序保留）', () => {
    const editor = makeEditor('<p>原内容</p>');
    try {
      const result = buildInterruptTransaction(editor.state, [{ content: '行1\n行2\n行3' }]);
      expect(result).not.toBeNull();
      expect(result!.tr.doc.firstChild?.textContent).toBe('行1');
      expect(result!.tr.doc.child(1)?.textContent).toBe('行2');
      expect(result!.tr.doc.child(2)?.textContent).toBe('行3');
      expect(result!.tr.doc.child(3)?.textContent).toBe('原内容');
    } finally {
      editor.destroy();
    }
  });

  it('返回的 tr 未 dispatch（caller 负责 dispatch）—— 原 editor 内容未变', () => {
    const editor = makeEditor('<p>原内容</p>');
    try {
      const beforeJSON = JSON.stringify(editor.state.doc.toJSON());
      buildInterruptTransaction(editor.state, [{ content: '排队1' }]);
      // 原 editor.state.doc 未被改动（tr 是新构造的，未 dispatch）
      const afterJSON = JSON.stringify(editor.state.doc.toJSON());
      expect(afterJSON).toBe(beforeJSON);
    } finally {
      editor.destroy();
    }
  });
});
