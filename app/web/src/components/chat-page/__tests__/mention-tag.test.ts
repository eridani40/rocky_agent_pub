/**
 * mention-tag 单测（v0.0.245 中断体验优化）
 * 参考: specs/tech/mention/message-content.md §3 §5.5 §7 §8
 *       specs/prd/version_logs/v0.0.245.interrupt_exp/prd.md §3.4（反序列化器）
 *
 * 覆盖：
 *   - deserializeContentToParagraphs：新格式 pill / 旧格式降级 / XML 反转义 / 多行→多 paragraph / 纯文本
 *   - 5 parsing 原语（MENTION_RE/ATTR_RE/parseTagAttrs/unescapeAttr/escapeAttr）字面平移后行为
 */
import { describe, it, expect } from 'vitest';
import {
  deserializeContentToParagraphs,
  parseTagAttrs,
  unescapeAttr,
  escapeAttr,
  MENTION_RE,
  ATTR_RE,
} from '../mention-tag';

describe('MENTION_RE / ATTR_RE（字面平移自 render/extension）', () => {
  it('MENTION_RE 整段匹配 <mention .../> 自闭合 tag', () => {
    MENTION_RE.lastIndex = 0;
    const m = MENTION_RE.exec('<mention type="file" path="a.ts"/>')!;
    expect(m).not.toBeNull();
    expect(m[0]).toBe('<mention type="file" path="a.ts"/>');
    expect(m[1]).toBe('type="file" path="a.ts"');
  });

  it('MENTION_RE 不匹配非自闭合（如带子节点）', () => {
    MENTION_RE.lastIndex = 0;
    expect(MENTION_RE.exec('<mention>xxx</mention>')).toBeNull();
  });

  it('ATTR_RE 抽 (key, value) 对', () => {
    ATTR_RE.lastIndex = 0;
    const pairs: Array<[string, string]> = [];
    for (let m = ATTR_RE.exec('type="file" path="a.ts"'); m !== null; m = ATTR_RE.exec('type="file" path="a.ts"')) {
      pairs.push([m[1]!, m[2]!]);
    }
    expect(pairs).toEqual([
      ['type', 'file'],
      ['path', 'a.ts'],
    ]);
  });
});

describe('unescapeAttr / escapeAttr（XML 四字符对称）', () => {
  it('unescape: &quot; &lt; &gt; &amp; 还原', () => {
    expect(unescapeAttr('A &amp; B &lt; C &gt; &quot;D&quot;')).toBe('A & B < C > "D"');
  });

  it('escape: & < > " 转义', () => {
    expect(escapeAttr('A & B < C > "D"')).toBe('A &amp; B &lt; C &gt; &quot;D&quot;');
  });

  it('round-trip：escape → unescape 还原', () => {
    const raw = '<weird>&"path"';
    expect(unescapeAttr(escapeAttr(raw))).toBe(raw);
  });
});

describe('parseTagAttrs（属性串 → 字典，顺序无关 + 反转义）', () => {
  it('抽取多属性 + 反转义值', () => {
    const attrs = parseTagAttrs('type="file" path="src/a.ts" icon="file" label="a.ts"');
    expect(attrs).toEqual({
      type: 'file',
      path: 'src/a.ts',
      icon: 'file',
      label: 'a.ts',
    });
  });

  it('属性顺序无关（icon 在前也正常解析）', () => {
    const attrs = parseTagAttrs('icon="file" label="x.ts" type="file"');
    expect(attrs.icon).toBe('file');
    expect(attrs.label).toBe('x.ts');
    expect(attrs.type).toBe('file');
  });

  it('XML 转义值反转义', () => {
    const attrs = parseTagAttrs('label="A &amp; B &lt; C &gt; &quot;D&quot;"');
    expect(attrs.label).toBe('A & B < C > "D"');
  });
});

describe('deserializeContentToParagraphs（注入路径反序列化器）', () => {
  it('纯文本（无 mention）→ 单 paragraph + text 节点', () => {
    const result = deserializeContentToParagraphs('hello world');
    expect(result).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] },
    ]);
  });

  it('新格式 file mention → paragraph 含 mention 节点（attrs 全字段）', () => {
    const content = '看 <mention type="file" path="src/a.ts" icon="file" label="a.ts"/>';
    const result = deserializeContentToParagraphs(content);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('paragraph');
    expect(result[0]!.content).toEqual([
      { type: 'text', text: '看 ' },
      {
        type: 'mention',
        attrs: { type: 'file', path: 'src/a.ts', icon: 'file', label: 'a.ts' },
      },
    ]);
  });

  it('workitem mention（kind+id 拆开）', () => {
    const content = '<mention type="workitem" kind="task" id="T-0001" icon="task" label="接口联调"/>';
    const result = deserializeContentToParagraphs(content);
    expect(result[0]!.content).toEqual([
      {
        type: 'mention',
        attrs: { type: 'workitem', kind: 'task', id: 'T-0001', icon: 'task', label: '接口联调' },
      },
    ]);
  });

  it('member mention with leader badge', () => {
    const content = '<mention type="member" id="01J" icon="member" label="张三" badge="leader"/>';
    const result = deserializeContentToParagraphs(content);
    expect(result[0]!.content).toEqual([
      {
        type: 'mention',
        attrs: { type: 'member', id: '01J', icon: 'member', label: '张三', badge: 'leader' },
      },
    ]);
  });

  it('member mention 无 badge（mate）→ 不输出 badge 字段', () => {
    const content = '<mention type="member" id="01H" icon="member" label="李四"/>';
    const result = deserializeContentToParagraphs(content);
    expect(result[0]!.content).toEqual([
      {
        type: 'mention',
        attrs: { type: 'member', id: '01H', icon: 'member', label: '李四' },
      },
    ]);
  });

  it('旧格式 tag（缺 icon/label）→ 整段 tag 字符串作 text 节点（降级，不渲染 pill）', () => {
    const oldTag = '<mention type="file" path="src/a.ts"/>';
    const result = deserializeContentToParagraphs(`看看 ${oldTag} 这个`);
    expect(result[0]!.content).toEqual([
      { type: 'text', text: '看看 ' },
      { type: 'text', text: oldTag },
      { type: 'text', text: ' 这个' },
    ]);
  });

  it('XML 转义：label 含 & < > " 反转义还原', () => {
    const content = '<mention type="goal" kind="goal" id="G-1" icon="goal" label="A &amp; B &lt; C &gt; &quot;D&quot;"/>';
    const result = deserializeContentToParagraphs(content);
    expect(result[0]!.content).toEqual([
      {
        type: 'mention',
        attrs: {
          type: 'goal',
          kind: 'goal',
          id: 'G-1',
          icon: 'goal',
          label: 'A & B < C > "D"',
        },
      },
    ]);
  });

  it('多行 content → 多 paragraph（每行一个）', () => {
    const content = '排队1\n排队2\n排队3';
    const result = deserializeContentToParagraphs(content);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: '排队1' }] });
    expect(result[1]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: '排队2' }] });
    expect(result[2]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: '排队3' }] });
  });

  it('text + mention + text 混合（同一段顺序保留）', () => {
    const content = '前缀 <mention type="file" path="a.ts" icon="file" label="a.ts"/> 后缀';
    const result = deserializeContentToParagraphs(content);
    expect(result[0]!.content).toEqual([
      { type: 'text', text: '前缀 ' },
      { type: 'mention', attrs: { type: 'file', path: 'a.ts', icon: 'file', label: 'a.ts' } },
      { type: 'text', text: ' 后缀' },
    ]);
  });

  it('混合：新格式产 mention + 旧格式降级 text（同一段不互相干扰）', () => {
    const content =
      '<mention type="file" path="a.ts" icon="file" label="a.ts"/> (新) <mention type="file" path="old.ts"/> (旧)';
    const result = deserializeContentToParagraphs(content);
    const mentionNodes = result[0]!.content!.filter((n) => n.type === 'mention');
    const textNodes = result[0]!.content!.filter((n) => n.type === 'text');
    expect(mentionNodes).toHaveLength(1);
    expect(textNodes.some((n) => n.text === '<mention type="file" path="old.ts"/>')).toBe(true);
  });

  it('空字符串 → 单 paragraph 无 content', () => {
    const result = deserializeContentToParagraphs('');
    expect(result).toEqual([{ type: 'paragraph', content: [] }]);
  });

  it('多 mention 同段（4 type 全覆盖）', () => {
    const content =
      '<mention type="file" path="a.ts" icon="file" label="a.ts"/> ' +
      '<mention type="skill" path="/s" icon="skill" label="s1"/> ' +
      '<mention type="workitem" kind="goal" id="G-1" icon="goal" label="目标"/> ' +
      '<mention type="member" id="m" icon="member" label="张三" badge="leader"/>';
    const result = deserializeContentToParagraphs(content);
    const mentionNodes = result[0]!.content!.filter((n) => n.type === 'mention');
    expect(mentionNodes).toHaveLength(4);
    expect(mentionNodes.map((n) => (n.attrs as { type: string }).type).join(',')).toBe(
      'file,skill,workitem,member',
    );
  });
});
