/**
 * @vitest-environment jsdom
 * mention 序列化 ↔ 渲染对称 round-trip 单测（v0.0.86 mention 报文重构核心回归点）
 * 参考: specs/tech/mention/message-content.md §5 §7 §8
 *
 * v0.0.86 不变量：
 *   - INV-1：整个报文入 message（serialize 输出 == render 输入）
 *   - 对称性：serialize 转义 ↔ render 反转义（含 " < > & 四字符）
 *   - 旧 tag 降级：v0.0.45/v0.0.68 两属性 tag 缺 display → renderer 降级纯文本不 crash
 *   - INV-2：renderer 类型无关（无 if(type===) 分支）
 *
 * 覆盖：
 *   - serialize 后 render 还原 MentionPill + 属性完整
 *   - XML 特殊字符在 label 中：round-trip 不变形（serialize 转义 → render 反转义还原）
 *   - 4 type 全覆盖（file/skill/workitem/member）
 *   - 旧 tag 降级：缺 display → 不 crash、不渲染 pill、整段 tag 字符串当纯文本
 *   - 空 badge 字符串：serialize 不输出 badge 属性
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { serializeEditorContent } from '../chat-composer-extension';
import type { MentionAttrs } from '../chat-composer-extension';
import { MentionRender } from '../component-mention-render';

afterEach(() => cleanup());

/** 构造简易 Tiptap document（只含一个 paragraph） */
function makeDoc(content: Array<{ type: string; text?: string; attrs?: MentionAttrs }>) {
  return { content: [{ type: 'paragraph', content }] } as never;
}

/** 渲染 MentionRender 并取所有 pill DOM（通过 data-mention-icon 属性定位） */
function renderGetPills(text: string): HTMLElement[] {
  const { container } = render(<MentionRender text={text} />);
  return Array.from(container.querySelectorAll('[data-mention-icon]'));
}

describe('mention serialize ↔ render 对称 round-trip（v0.0.86 INV-1 + 对称性）', () => {
  it('file：serialize → render 还原 pill（icon+label 完整）', () => {
    const attrs: MentionAttrs = {
      type: 'file',
      path: 'src/utils/helper.ts',
      icon: 'file',
      label: 'helper.ts',
    };
    const text = serializeEditorContent(
      makeDoc([{ type: 'mention', attrs }]),
    );
    const pills = renderGetPills(text);
    expect(pills.length).toBe(1);
    expect(pills[0]!.getAttribute('data-mention-icon')).toBe('file');
    expect(pills[0]!.getAttribute('data-mention-label')).toBe('helper.ts');
    expect(pills[0]!.getAttribute('data-mention-badge')).toBeNull();
    // 视觉显示 @ 前缀
    expect(pills[0]!.textContent).toContain('@helper.ts');
  });

  it('workitem：kind+id 拆开 serialize → render 还原（icon=kind）', () => {
    const attrs: MentionAttrs = {
      type: 'workitem',
      kind: 'task',
      id: 'T-0001',
      icon: 'task',
      label: '接口联调',
    };
    const text = serializeEditorContent(makeDoc([{ type: 'mention', attrs }]));
    expect(text).toBe(
      '<mention type="workitem" kind="task" id="T-0001" icon="task" label="接口联调"/>',
    );
    const pills = renderGetPills(text);
    expect(pills.length).toBe(1);
    expect(pills[0]!.getAttribute('data-mention-icon')).toBe('task');
    expect(pills[0]!.getAttribute('data-mention-label')).toBe('接口联调');
  });

  it('member with leader badge：serialize 输出 badge，render 还原皇冠', () => {
    const attrs: MentionAttrs = {
      type: 'member',
      id: '01J',
      icon: 'member',
      label: '张三',
      badge: 'leader',
    };
    const text = serializeEditorContent(makeDoc([{ type: 'mention', attrs }]));
    expect(text).toBe(
      '<mention type="member" id="01J" icon="member" label="张三" badge="leader"/>',
    );
    const pills = renderGetPills(text);
    expect(pills.length).toBe(1);
    expect(pills[0]!.getAttribute('data-mention-icon')).toBe('member');
    expect(pills[0]!.getAttribute('data-mention-label')).toBe('张三');
    expect(pills[0]!.getAttribute('data-mention-badge')).toBe('leader');
  });

  it('XML 转义对称：label 含 "<>& 四字符 round-trip 不变形', () => {
    const rawLabel = 'A & B < C > "D"';
    const attrs: MentionAttrs = {
      type: 'workitem',
      kind: 'goal',
      id: 'G-1',
      icon: 'goal',
      label: rawLabel,
    };
    const text = serializeEditorContent(makeDoc([{ type: 'mention', attrs }]));
    // 序列化时 label 转义
    expect(text).toContain('label="A &amp; B &lt; C &gt; &quot;D&quot;"');
    // render 反转义还原
    const pills = renderGetPills(text);
    expect(pills.length).toBe(1);
    expect(pills[0]!.getAttribute('data-mention-label')).toBe(rawLabel);
  });

  it('XML 转义对称：path 含特殊字符 round-trip 不变形', () => {
    const rawPath = 'src/<weird>/a&b.ts';
    const attrs: MentionAttrs = {
      type: 'file',
      path: rawPath,
      icon: 'file',
      label: 'a&b.ts',
    };
    const text = serializeEditorContent(makeDoc([{ type: 'mention', attrs }]));
    const pills = renderGetPills(text);
    expect(pills.length).toBe(1);
    expect(pills[0]!.getAttribute('data-mention-label')).toBe('a&b.ts');
  });

  it('属性顺序无关：renderer 兼容非 type 开头的 tag', () => {
    // 手动构造 icon 在前的 tag（render 应正常解析）
    const text = '<mention icon="file" label="x.ts" type="file" path="x.ts"/>';
    const pills = renderGetPills(text);
    expect(pills.length).toBe(1);
    expect(pills[0]!.getAttribute('data-mention-icon')).toBe('file');
    expect(pills[0]!.getAttribute('data-mention-label')).toBe('x.ts');
  });

  it('text + mention 混合：round-trip 后片段顺序完整', () => {
    const doc = makeDoc([
      { type: 'text', text: '前缀 ' },
      { type: 'mention', attrs: { type: 'file', path: 'a.ts', icon: 'file', label: 'a.ts' } },
      { type: 'text', text: ' 后缀' },
    ]);
    const text = serializeEditorContent(doc);
    const { container } = render(<MentionRender text={text} />);
    // 完整文本顺序保留
    expect(container.textContent).toContain('前缀');
    expect(container.textContent).toContain('@a.ts');
    expect(container.textContent).toContain('后缀');
  });

  it('多 mention 混合：4 type 同一段 round-trip 全部还原', () => {
    const doc = makeDoc([
      { type: 'mention', attrs: { type: 'file', path: 'a.ts', icon: 'file', label: 'a.ts' } },
      { type: 'text', text: ' ' },
      {
        type: 'mention',
        attrs: { type: 'skill', path: '/s', icon: 'skill', label: 's1' },
      },
      { type: 'text', text: ' ' },
      {
        type: 'mention',
        attrs: { type: 'workitem', kind: 'goal', id: 'G-1', icon: 'goal', label: '目标' },
      },
      { type: 'text', text: ' ' },
      {
        type: 'mention',
        attrs: { type: 'member', id: 'm', icon: 'member', label: '张三', badge: 'leader' },
      },
    ]);
    const text = serializeEditorContent(doc);
    const pills = renderGetPills(text);
    expect(pills.length).toBe(4);
    expect(pills.map((p) => p.getAttribute('data-mention-icon')).join(',')).toBe(
      'file,skill,goal,member',
    );
  });
});

describe('旧 tag 降级（v0.0.86 INV：旧消息缺 display 不 crash）', () => {
  it('v0.0.45/v0.0.68 两属性 tag 缺 display → 降级纯文本（不渲染 pill）', () => {
    const oldTag = '<mention type="file" path="src/a.ts"/>';
    const { container } = render(<MentionRender text={`看看 ${oldTag} 这个`} />);
    // 不渲染 pill（降级为纯文本）
    expect(container.querySelectorAll('[data-mention-icon]').length).toBe(0);
    // 整段 tag 字符串作为纯文本原样显示（用户能看到原始 tag 文本）
    expect(container.textContent).toContain(oldTag);
  });

  it('混合：新 tag 渲染 pill + 旧 tag 降级纯文本（同一段不互相干扰）', () => {
    const mixed =
      '<mention type="file" path="a.ts" icon="file" label="a.ts"/> (新) <mention type="file" path="old.ts"/> (旧)';
    const { container } = render(<MentionRender text={mixed} />);
    // 仅新 tag 渲染 pill
    const pills = container.querySelectorAll('[data-mention-icon]');
    expect(pills.length).toBe(1);
    expect(pills[0]!.getAttribute('data-mention-icon')).toBe('file');
    // 旧 tag 字符串作为纯文本显示
    expect(container.textContent).toContain('<mention type="file" path="old.ts"/>');
  });

  it('无 mention tag 的纯文本 → 原样输出（不渲染任何 pill）', () => {
    const { container } = render(<MentionRender text="就是普通文本，没有 mention" />);
    expect(container.querySelectorAll('[data-mention-icon]').length).toBe(0);
    expect(container.textContent).toBe('就是普通文本，没有 mention');
  });
});

describe('多行文本换行保留（v0.0.281 输入框多行 bug）', () => {
  /** 取容器内所有带 whitespace-pre-wrap 的文本 span */
  function textSpans(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll('span.whitespace-pre-wrap')) as HTMLElement[];
  }

  it('纯多行文本：所有文本 span 带 whitespace-pre-wrap（CSS 保留 \n，不折叠）', () => {
    const { container } = render(<MentionRender text={'1. a\n2. b\n3. c'} />);
    // 无 mention → 末尾剩余文本 span（唯一出口）
    const spans = textSpans(container);
    expect(spans.length).toBe(1);
    expect(spans[0]!.textContent).toBe('1. a\n2. b\n3. c');
  });

  it('mention 混合场景：text+pill+text 的前置/末尾文本 span 都保留换行', () => {
    const text =
      '第1行\n第2行 <mention type="file" path="a.ts" icon="file" label="a.ts"/> 第3行\n第4行';
    const { container } = render(<MentionRender text={text} />);
    // pill 正常渲染（1 个）
    expect(container.querySelectorAll('[data-mention-icon]').length).toBe(1);
    // 前置文本 span（mention 前）带 whitespace-pre-wrap 且保留 \n
    const spans = textSpans(container);
    expect(spans.length).toBe(2); // 前置 + 末尾
    expect(spans[0]!.textContent).toBe('第1行\n第2行 ');
    expect(spans[1]!.textContent).toBe(' 第3行\n第4行');
  });

  it('旧 tag 降级 span 也保留换行（同语义：降级纯文本不折叠）', () => {
    const oldTag = '<mention type="file" path="src/a.ts"/>';
    const { container } = render(<MentionRender text={`前\n${oldTag}\n后`} />);
    // 前置 + 降级 + 末尾三个文本出口全带 whitespace-pre-wrap
    const spans = textSpans(container);
    expect(spans.length).toBe(3);
    expect(spans[0]!.textContent).toBe('前\n');
    expect(spans[1]!.textContent).toBe(oldTag);
    expect(spans[2]!.textContent).toBe('\n后');
  });

  it('mention pill 不受影响：pill 元素无 whitespace-pre-wrap（原样保留）', () => {
    const text = '<mention type="file" path="a.ts" icon="file" label="a.ts"/>';
    const { container } = render(<MentionRender text={text} />);
    const pill = container.querySelector('[data-mention-icon]') as HTMLElement;
    expect(pill).toBeTruthy();
    expect(pill.className).not.toContain('whitespace-pre-wrap');
  });
});
