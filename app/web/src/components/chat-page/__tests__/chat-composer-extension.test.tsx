/**
 * @vitest-environment jsdom
 * chat-composer-extension 单测（v0.0.86 mention 报文重构）
 * 参考: specs/tech/mention/message-content.md §3 §8（flat 全属性 tag + XML 转义）
 *
 * v0.0.86 变更：
 *   - serializeEditorContent 输出 flat 全属性 tag：type → address → display 固定顺序
 *   - XML 转义四字符（" < > &）；空 badge 省略；空 address 字段省略
 *
 * 覆盖 serializeEditorContent：编辑器 doc → flat 全属性 mention tag 字符串。
 */
import { describe, it, expect } from 'vitest';
import { serializeEditorContent } from '../chat-composer-extension';
import type { MentionAttrs } from '../chat-composer-extension';

/** 构造简易 Tiptap document（只含一个 paragraph） */
function makeDoc(content: Array<{ type: string; text?: string; attrs?: MentionAttrs }>) {
  return { content: [{ type: 'paragraph', content }] } as never;
}

describe('serializeEditorContent（v0.0.86 flat 全属性）', () => {
  it('纯文本 → 原字符串', () => {
    const doc = makeDoc([{ type: 'text', text: 'hello world' }]);
    expect(serializeEditorContent(doc)).toBe('hello world');
  });

  it('file mention → 4 属性 flat tag（type+path+icon+label）', () => {
    const doc = makeDoc([
      {
        type: 'mention',
        attrs: { type: 'file', path: 'src/helper.ts', icon: 'file', label: 'helper.ts' },
      },
    ]);
    expect(serializeEditorContent(doc)).toBe(
      '<mention type="file" path="src/helper.ts" icon="file" label="helper.ts"/>',
    );
  });

  it('skill mention → 4 属性 flat tag', () => {
    const doc = makeDoc([
      {
        type: 'mention',
        attrs: {
          type: 'skill',
          path: '/Users/x/.qoder/skills/drama-writer',
          icon: 'skill',
          label: 'drama-writer',
        },
      },
    ]);
    expect(serializeEditorContent(doc)).toBe(
      '<mention type="skill" path="/Users/x/.qoder/skills/drama-writer" icon="skill" label="drama-writer"/>',
    );
  });

  it('workitem mention → kind+id 拆开（无 path），icon=kind', () => {
    const doc = makeDoc([
      {
        type: 'mention',
        attrs: { type: 'workitem', kind: 'task', id: 'T-0001', icon: 'task', label: '接口联调' },
      },
    ]);
    expect(serializeEditorContent(doc)).toBe(
      '<mention type="workitem" kind="task" id="T-0001" icon="task" label="接口联调"/>',
    );
  });

  it('member mention with leader badge → 含 badge 属性', () => {
    const doc = makeDoc([
      {
        type: 'mention',
        attrs: {
          type: 'member',
          id: '01J1234567890ABCDEF',
          icon: 'member',
          label: '张三',
          badge: 'leader',
        },
      },
    ]);
    expect(serializeEditorContent(doc)).toBe(
      '<mention type="member" id="01J1234567890ABCDEF" icon="member" label="张三" badge="leader"/>',
    );
  });

  it('member mention 无 badge（mate）→ 不输出 badge 属性（不写 badge=""）', () => {
    const doc = makeDoc([
      {
        type: 'mention',
        attrs: { type: 'member', id: '01HXYZ', icon: 'member', label: '李四' },
      },
    ]);
    expect(serializeEditorContent(doc)).toBe(
      '<mention type="member" id="01HXYZ" icon="member" label="李四"/>',
    );
  });

  it('XML 转义：label 含 " < > & 全转义', () => {
    const doc = makeDoc([
      {
        type: 'mention',
        attrs: {
          type: 'workitem',
          kind: 'goal',
          id: 'G-1',
          icon: 'goal',
          label: 'A & B < C > "D"',
        },
      },
    ]);
    expect(serializeEditorContent(doc)).toBe(
      '<mention type="workitem" kind="goal" id="G-1" icon="goal" label="A &amp; B &lt; C &gt; &quot;D&quot;"/>',
    );
  });

  it('text + mention 混合 → 内联字符串', () => {
    const doc = makeDoc([
      { type: 'text', text: '请帮我看看 ' },
      {
        type: 'mention',
        attrs: { type: 'file', path: 'src/helper.ts', icon: 'file', label: 'helper.ts' },
      },
      { type: 'text', text: ' 这个文件' },
    ]);
    expect(serializeEditorContent(doc)).toBe(
      '请帮我看看 <mention type="file" path="src/helper.ts" icon="file" label="helper.ts"/> 这个文件',
    );
  });

  it('空文档 → 空串', () => {
    expect(serializeEditorContent({ content: [] })).toBe('');
  });

  it('空 paragraph → 空串', () => {
    expect(serializeEditorContent({ content: [{ type: 'paragraph' }] })).toBe('');
  });
});

/**
 * v0.0.284 hardBreak 序列化（手动回车换行保留）
 * Shift/Cmd/Ctrl+Enter → setHardBreak → hardBreak 节点 → 序列化为 '\n'
 */
describe('serializeEditorContent — v0.0.284 hardBreak 换行保留', () => {
  it('单个 hardBreak → 段内 \n', () => {
    const doc = makeDoc([
      { type: 'text', text: '第一行' },
      { type: 'hardBreak' },
      { type: 'text', text: '第二行' },
    ]);
    expect(serializeEditorContent(doc)).toBe('第一行\n第二行');
  });

  it('多个连续 hardBreak → 多个 \n', () => {
    const doc = makeDoc([
      { type: 'text', text: 'A' },
      { type: 'hardBreak' },
      { type: 'hardBreak' },
      { type: 'text', text: 'B' },
    ]);
    expect(serializeEditorContent(doc)).toBe('A\n\nB');
  });

  it('hardBreak 与 mention 混合 → 顺序保留 + \n', () => {
    const doc = makeDoc([
      { type: 'text', text: '看看 ' },
      { type: 'mention', attrs: { type: 'file', path: 'src/x.ts', icon: 'file', label: 'x.ts' } },
      { type: 'hardBreak' },
      { type: 'text', text: '这个文件' },
    ]);
    expect(serializeEditorContent(doc)).toBe(
      '看看 <mention type="file" path="src/x.ts" icon="file" label="x.ts"/>\n这个文件',
    );
  });

  it('hardBreak 在段首/段尾 → \n 保留（首尾不 trim）', () => {
    const doc = makeDoc([
      { type: 'hardBreak' },
      { type: 'text', text: '内容' },
      { type: 'hardBreak' },
    ]);
    expect(serializeEditorContent(doc)).toBe('\n内容\n');
  });
});
