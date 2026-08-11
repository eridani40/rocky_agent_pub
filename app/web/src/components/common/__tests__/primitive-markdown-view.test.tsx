// @vitest-environment jsdom
/**
 * primitive-markdown-view 单测（v0.0.63 F2：GFM 表格支持）
 * 参考: specs/prd/version_logs/v0.0.63.ui_opt.md §3.2（F2 表格需求 + UC-3.2.1/2/3）
 *       specs/tech/version_logs/v0.0.63.ui_opt/change_log.md §3（表格分支实现要点）
 *
 * 覆盖（P2 关键路径）：
 *   - 合法 GFM 表格（表头 + 分隔行 + 数据行）→ 渲染 <table>/<thead>/<tbody>，单元格文案正确
 *   - 对齐标记 :--- / ---: / :---: → th/td 内联 style.textAlign = left/right/center
 *   - 非法表格（缺分隔行 / 分隔单元格 < 3 个 -）→ 不崩，按段落渲染（无 <table>）
 *   - 段落 + 表格相邻：段落 break 不吃表格表头（表头不被并入段落文本）
 *   - 表格单元格内行内格式（**bold** / `code`）正常生效（复用 renderInline）
 *   - 仅表头 + 分隔行（0 数据行）→ 渲染空 <tbody>，不崩
 *   - 现有 block（代码块 / 列表 / 段落）回归不破坏
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { PrimitiveMarkdownView } from '../primitive-markdown-view';

afterEach(() => cleanup());

// v0.0.253 链接点击分发测试：mock window.rockyShell 验证点击路由到对应打开方式
function mockRockyShell() {
  const api = {
    openExternal: vi.fn(async () => ({ ok: true })),
    openPath: vi.fn(async () => ({ ok: true })),
    readFileText: vi.fn(async () => ({ ok: true, content: '' })),
  };
  (window as unknown as { rockyShell: unknown }).rockyShell = api;
  return api;
}
beforeEach(() => mockRockyShell());
afterEach(() => {
  delete (window as unknown as { rockyShell?: unknown }).rockyShell;
});

describe('PrimitiveMarkdownView — GFM 表格（F2）', () => {
  it('合法 GFM 表格：渲染 <table>/<thead>/<tbody>，表头 + 数据行文案正确', () => {
    const md = '| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 香蕉 | 5 |';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    const thead = container.querySelector('thead');
    const tbody = container.querySelector('tbody');
    expect(thead).not.toBeNull();
    expect(tbody).not.toBeNull();

    // 表头单元格
    const headerTexts = Array.from(thead!.querySelectorAll('th')).map((th) => th.textContent);
    expect(headerTexts).toEqual(['名称', '数量']);

    // 数据行
    const rows = Array.from(tbody!.querySelectorAll('tr'));
    expect(rows.length).toBe(2);
    expect(rows[0]).toBeTruthy();
    expect(rows[1]).toBeTruthy();
    const row0 = Array.from(rows[0]!.querySelectorAll('td')).map((td) => td.textContent);
    const row1 = Array.from(rows[1]!.querySelectorAll('td')).map((td) => td.textContent);
    expect(row0).toEqual(['苹果', '3']);
    expect(row1).toEqual(['香蕉', '5']);
  });

  it('对齐标记 :--- / ---: / :---: → th/td style.textAlign = left/right/center', () => {
    const md = '| 左 | 右 | 中 | 默认 |\n| :--- | ---: | :---: | --- |\n| a | b | c | d |';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const ths = Array.from(container.querySelectorAll('thead th'));
    expect(ths.length).toBe(4);
    expect((ths[0] as HTMLElement).style.textAlign).toBe('left');
    expect((ths[1] as HTMLElement).style.textAlign).toBe('right');
    expect((ths[2] as HTMLElement).style.textAlign).toBe('center');
    expect((ths[3] as HTMLElement).style.textAlign).toBe('left'); // 默认 left

    // 数据行同样生效
    const tds = Array.from(container.querySelectorAll('tbody tr:first-child td'));
    expect(tds.length).toBe(4);
    expect((tds[0] as HTMLElement).style.textAlign).toBe('left');
    expect((tds[1] as HTMLElement).style.textAlign).toBe('right');
    expect((tds[2] as HTMLElement).style.textAlign).toBe('center');
    expect((tds[3] as HTMLElement).style.textAlign).toBe('left');
  });

  it('非法表格（缺分隔行）→ 不崩，按段落渲染（无 <table>）', () => {
    // 表头 + 直接数据行（无 |---| 分隔行）→ 段落
    const md = '| 名称 | 数量 |\n| 苹果 | 3 |';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    expect(container.querySelector('table')).toBeNull();
    // 段落里仍含 | 字符（不强制成表格）
    const paragraphs = Array.from(container.querySelectorAll('p'));
    expect(paragraphs.length).toBeGreaterThanOrEqual(1);
    const combined = paragraphs.map((p) => p.textContent).join('\n');
    expect(combined).toContain('名称');
    expect(combined).toContain('苹果');
  });

  it('非法表格（分隔单元格 < 3 个 -）→ 按段落渲染', () => {
    // 分隔行 | - | - | 每段只有 1 个 -，不满足 GFM ≥3
    const md = '| a | b |\n| - | - |\n| 1 | 2 |';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    expect(container.querySelector('table')).toBeNull();
  });

  it('段落 + 表格相邻：段落 break 不吃表格表头（表头不被并入段落）', () => {
    const md = '这是段落。\n| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    // 表格存在（段落未吞掉表头行）
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    const ths = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(ths).toEqual(['名称', '数量']);

    // 段落保留「这是段落。」，不含表格字符
    const p = container.querySelector('p');
    expect(p?.textContent).toContain('这是段落');
    expect(p?.textContent).not.toContain('数量');
  });

  it('表格单元格内行内格式（**bold** / `code`）生效', () => {
    const md = '| 名称 | 备注 |\n| --- | --- |\n| **加粗** | `代码` |';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const tbody = container.querySelector('tbody');
    const tr = tbody?.querySelector('tr');
    expect(tr).not.toBeNull();

    const strong = tr?.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe('加粗');

    const code = tr?.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe('代码');
  });

  it('仅表头 + 分隔行（0 数据行）→ 渲染空 <tbody>，不崩', () => {
    const md = '| a | b |\n| --- | --- |';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('thead th').length).toBe(2);
    expect(container.querySelectorAll('tbody tr').length).toBe(0);
  });

  it('数据行列数不一致：少补空 / 多截断，不崩', () => {
    // 第 1 行少 1 列，第 2 行多 1 列
    const md = '| a | b | c |\n| --- | --- | --- |\n| 仅一列 | \n| 太 | 多 | 列 | extra |';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0]).toBeTruthy();
    expect(rows[1]).toBeTruthy();
    // 第 1 行：补空 → 3 个 td（最后一个空）
    const r0 = Array.from(rows[0]!.querySelectorAll('td'));
    expect(r0.length).toBe(3);
    expect(r0[0]!).toBeTruthy();
    expect(r0[2]!).toBeTruthy();
    expect(r0[0]!.textContent).toBe('仅一列');
    expect(r0[2]!.textContent).toBe('');
    // 第 2 行：截断 → 3 个 td（extra 丢弃）
    const r1 = Array.from(rows[1]!.querySelectorAll('td'));
    expect(r1.length).toBe(3);
    expect(r1[2]!).toBeTruthy();
    expect(r1[2]!.textContent).toBe('列');
  });
});

describe('PrimitiveMarkdownView — 现有 block 回归（F2 不破坏）', () => {
  it('代码块 + 列表 + 段落 仍正常渲染', () => {
    const md = '```\ncode line\n```\n\n- 列表项 1\n- 列表项 2\n\n普通段落。';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.querySelector('pre code')?.textContent).toContain('code line');
    expect(container.querySelectorAll('ul li').length).toBe(2);
    const ps = Array.from(container.querySelectorAll('p'));
    expect(ps.some((p) => p.textContent?.includes('普通段落'))).toBe(true);
  });
});

// ===== v0.0.145 扩展：link / heading / ordered-list / blockquote =====
describe('PrimitiveMarkdownView — 链接 [text](url)（v0.0.145）', () => {
  it('渲染 <a>，target=_blank rel=noreferrer，文案与 href 正确', () => {
    const md = '详见 [飞书文档](https://open.feishu.cn/) 了解详情';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('https://open.feishu.cn/');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toBe('noreferrer');
    expect(anchor?.textContent).toBe('飞书文档');
  });

  it('链接 + 段落混排：链接前后文本保留为段落的一部分', () => {
    const md = '前文 [link](https://example.com) 后文';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const p = container.querySelector('p');
    expect(p?.textContent).toContain('前文');
    expect(p?.textContent).toContain('后文');
    const anchor = p?.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://example.com');
  });

  it('链接与加粗共存：彼此不互相破坏', () => {
    const md = '**加粗** 与 [链接](https://x.com) 共存';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    expect(container.querySelector('strong')?.textContent).toBe('加粗');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://x.com');
  });

  it('行内代码内的 [text](url) 原样输出（代码内不解析链接）', () => {
    const md = '代码 `[not](link)` 内不解析';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    expect(container.querySelector('a')).toBeNull();
    const code = container.querySelector('code');
    expect(code?.textContent).toBe('[not](link)');
  });

  it('XSS 防御：javascript:/vbscript:/data: URL 降级为纯文本，不产 <a>', () => {
    const md = '[bad1](javascript:alert(1)) [bad2](vbscript:foo) [bad3](data:text/html,<script>)';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    expect(container.querySelector('a')).toBeNull();
    // 危险 URL 被丢弃，标签文案保留为纯文本
    const text = container.textContent ?? '';
    expect(text).toContain('bad1');
    expect(text).toContain('bad2');
    expect(text).toContain('bad3');
  });

  it('合法协议（https/http/mailto）仍渲染为 <a>', () => {
    const md = '[a](https://x.com) [b](http://y.com) [c](mailto:z@w.com)';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const anchors = Array.from(container.querySelectorAll('a'));
    expect(anchors.length).toBe(3);
    expect(anchors[0]?.getAttribute('href')).toBe('https://x.com');
    expect(anchors[1]?.getAttribute('href')).toBe('http://y.com');
    expect(anchors[2]?.getAttribute('href')).toBe('mailto:z@w.com');
  });

  // ===== v0.0.253: 链接点击分发（onClick → openLinkTarget）=====
  it('v0.0.253 点击 http 链接 → preventDefault + window.rockyShell.openExternal', () => {
    const api = mockRockyShell();
    const md = '[文档](https://example.com/docs)';
    const { container } = render(<PrimitiveMarkdownView source={md} />);
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();

    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    const preventSpy = vi.spyOn(clickEvent, 'preventDefault');
    fireEvent(anchor!, clickEvent);

    expect(preventSpy).toHaveBeenCalled();
    expect(api.openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('v0.0.253 点击 12 格式本地链接（无 Provider）→ openPath 降级（其它消费方场景）', () => {
    const api = mockRockyShell();
    const md = '[cfg](config.yaml)';
    const { container } = render(<PrimitiveMarkdownView source={md} />);
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();

    fireEvent(anchor!, new MouseEvent('click', { bubbles: true, cancelable: true }));
    // primitive-markdown-view 单独渲染无 ChatLinkHandlerContext → onLocalViewer 不挂 → local 12 格式降级走 openPath
    expect(api.openPath).toHaveBeenCalledWith('config.yaml');
  });

  it('v0.0.253 点击非 12 格式本地链接（图片）→ openPath', () => {
    const api = mockRockyShell();
    const md = '[shot](/abs/shot.png)';
    const { container } = render(<PrimitiveMarkdownView source={md} />);
    fireEvent(container.querySelector('a')!, new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(api.openPath).toHaveBeenCalledWith('/abs/shot.png');
  });
});

describe('PrimitiveMarkdownView — 标题 #/##/###（v0.0.145）', () => {
  it('# 渲染为 <h1>，## → <h2>，### → <h3>，文案正确', () => {
    const md = '# H1 标题\n## H2 标题\n### H3 标题';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const h1 = container.querySelector('h1');
    const h2 = container.querySelector('h2');
    const h3 = container.querySelector('h3');
    expect(h1?.textContent).toBe('H1 标题');
    expect(h2?.textContent).toBe('H2 标题');
    expect(h3?.textContent).toBe('H3 标题');
  });

  it('# 后必须有空格才识别（#无空格不识别为标题，按段落渲染）', () => {
    const md = '#无空格不是标题';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('p')?.textContent).toContain('#无空格不是标题');
  });

  it('#### h4 不识别（仅支持 1-3 级）→ 按段落渲染', () => {
    const md = '#### 四级不识别';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    expect(container.querySelector('h4')).toBeNull();
    expect(container.querySelector('p')?.textContent).toContain('#### 四级不识别');
  });

  it('标题内行内格式生效（**bold**）', () => {
    const md = '# **加粗标题**';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const h1 = container.querySelector('h1');
    expect(h1?.querySelector('strong')?.textContent).toBe('加粗标题');
  });

  it('段落 + 标题相邻：段落 break，标题不被并入段落', () => {
    const md = '这是段落。\n# 标题';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const p = container.querySelector('p');
    expect(p?.textContent).toBe('这是段落。');
    expect(container.querySelector('h1')?.textContent).toBe('标题');
  });
});

describe('PrimitiveMarkdownView — 有序列表 1.（v0.0.145）', () => {
  it('1. 2. 3. 渲染为 <ol> + <li>，文案正确', () => {
    const md = '1. 第一\n2. 第二\n3. 第三';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const ol = container.querySelector('ol');
    expect(ol).not.toBeNull();
    const items = Array.from(ol!.querySelectorAll('li')).map((li) => li.textContent);
    expect(items).toEqual(['第一', '第二', '第三']);
  });

  it('有序列表项内行内格式生效（**bold** / `code`）', () => {
    const md = '1. **加粗** 项\n2. `代码` 项';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const items = Array.from(container.querySelectorAll('ol li'));
    expect(items[0]?.querySelector('strong')?.textContent).toBe('加粗');
    expect(items[1]?.querySelector('code')?.textContent).toBe('代码');
  });

  it('有序列表与无序列表互不混淆', () => {
    const md = '- 无序\n1. 有序';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    expect(container.querySelectorAll('ul li').length).toBe(1);
    expect(container.querySelectorAll('ol li').length).toBe(1);
  });

  // ===== v0.0.306：编号重置 / 编号跳变边界识别（PRD §3.2 判定示例表）=====
  it('编号重置：`1. a\\n2. b\\n1. c\\n2. d`（无空行）→ 2 个 <ol> 各 2 个 <li>', () => {
    const md = '1. a\n2. b\n1. c\n2. d';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const ols = container.querySelectorAll('ol');
    expect(ols.length).toBe(2);
    expect(Array.from(ols[0]!.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['a', 'b']);
    expect(Array.from(ols[1]!.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['c', 'd']);
  });

  it('段落后 `1.` 不再续接：`1. a\\n2. b\\n\\n段落\\n\\n1. c\\n2. d` → 2 个 <ol>', () => {
    const md = '1. a\n2. b\n\n段落\n\n1. c\n2. d';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const ols = container.querySelectorAll('ol');
    expect(ols.length).toBe(2);
    expect(Array.from(ols[0]!.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['a', 'b']);
    expect(Array.from(ols[1]!.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['c', 'd']);
    // 中间段落保留
    const ps = Array.from(container.querySelectorAll('p'));
    expect(ps.some((p) => p.textContent === '段落')).toBe(true);
  });

  it('编号跳变：`1. a\\n3. b\\n4. c` → 断开（`3.` 起独立 <ol>）', () => {
    const md = '1. a\n3. b\n4. c';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    // 1. a 单独一个 ol；3. b / 4. c 连续 → 第二个 ol
    const ols = container.querySelectorAll('ol');
    expect(ols.length).toBe(2);
    expect(Array.from(ols[0]!.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['a']);
    expect(Array.from(ols[1]!.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['b', 'c']);
  });

  it('从非 1 编号开始：`2. a\\n3. b` → 保持 1 个 ol（不强制断开）', () => {
    const md = '2. a\n3. b';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const ols = container.querySelectorAll('ol');
    expect(ols.length).toBe(1);
    expect(Array.from(ols[0]!.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['a', 'b']);
  });

  // ===== v0.0.319：松散列表（loose list）空行分隔的列表项合并到同一 <ol> =====
  it('空行分隔：`1. a\\n\\n2. b\\n\\n3. c` → 1 个 <ol> 3 个 <li>（空行分隔合并）', () => {
    const md = '1. a\n\n2. b\n\n3. c';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const ols = container.querySelectorAll('ol');
    expect(ols.length).toBe(1);
    expect(Array.from(ols[0]!.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['a', 'b', 'c']);
  });

  it('空行后非列表项断开：`1. a\\n\\n2. b\\n\\n段落` → 1 个 <ol> 2 个 <li> + 段落', () => {
    const md = '1. a\n\n2. b\n\n段落';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const ols = container.querySelectorAll('ol');
    expect(ols.length).toBe(1);
    expect(Array.from(ols[0]!.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['a', 'b']);
    const ps = Array.from(container.querySelectorAll('p'));
    expect(ps.some((p) => p.textContent === '段落')).toBe(true);
  });

  it('回归：编号重置不受空行合并影响 `1. a\\n2. b\\n1. c` 仍 2 个 <ol>', () => {
    const md = '1. a\n2. b\n1. c';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const ols = container.querySelectorAll('ol');
    expect(ols.length).toBe(2);
    expect(Array.from(ols[0]!.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['a', 'b']);
    expect(Array.from(ols[1]!.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['c']);
  });
});

describe('PrimitiveMarkdownView — 引用块 >（v0.0.145）', () => {
  it('> 渲染为 <blockquote>，文案正确', () => {
    const md = '> 这是一段引用';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const bq = container.querySelector('blockquote');
    expect(bq).not.toBeNull();
    expect(bq?.textContent).toContain('这是一段引用');
  });

  it('引用块内行内格式生效（**bold** / [link]）', () => {
    const md = '> **注意：** 详见 [文档](https://x.com)';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const bq = container.querySelector('blockquote');
    expect(bq?.querySelector('strong')?.textContent).toBe('注意：');
    expect(bq?.querySelector('a')?.getAttribute('href')).toBe('https://x.com');
  });

  it('多行连续 > 合并到一个 <blockquote>', () => {
    const md = '> 第一行\n> 第二行\n> 第三行';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const bqs = container.querySelectorAll('blockquote');
    expect(bqs.length).toBe(1);
    const paras = bqs[0]!.querySelectorAll('p');
    expect(paras.length).toBe(3);
  });

  it('引用块前段落不被吞（段落 break）', () => {
    const md = '正文段落。\n> 引用内容';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const p = container.querySelector('p');
    expect(p?.textContent).toBe('正文段落。');
    expect(container.querySelector('blockquote')?.textContent).toContain('引用内容');
  });
});

// 空 heading（"### " 井号+空格无内容）回归：外/内 heading 正则须对称，否则段落分支死循环 OOM。
describe('PrimitiveMarkdownView — 空 heading 不死循环', () => {
  it('"### "（井号+空格无内容）不认作 heading，按段落渲染，无死循环', () => {
    const md = '### ';
    const { container } = render(<PrimitiveMarkdownView source={md} />);
    expect(container.querySelector('h3')).toBeNull();
    expect(container.textContent).toContain('###');
    // 未死循环的验证：blocks 数组不会无限扩张，段落数量有限
    expect(container.querySelectorAll('p').length).toBeLessThanOrEqual(2);
  });

  it('"### " + 后续内容行 → 合成段落文本，不死循环', () => {
    const md = '### \n继续内容';
    const { container } = render(<PrimitiveMarkdownView source={md} />);
    expect(container.querySelector('h3')).toBeNull();
    const p = container.querySelector('p');
    expect(p?.textContent).toContain('继续内容');
  });

  it('各级空 heading "# " / "## " / "### " 都不死循环', () => {
    const md = '# \n## \n### ';
    const { container } = render(<PrimitiveMarkdownView source={md} />);
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('h2')).toBeNull();
    expect(container.querySelector('h3')).toBeNull();
    // 3 行输入最多产生 3 个段落，不无限扩张
    expect(container.querySelectorAll('p').length).toBeLessThanOrEqual(3);
  });

  it('正常 "### 标题" 仍渲染 <h3>（不回归）', () => {
    const md = '### 标题';
    const { container } = render(<PrimitiveMarkdownView source={md} />);
    expect(container.querySelector('h3')?.textContent).toBe('标题');
  });

  it('尾部空 heading "文本\\n### " 混排：段落 + 空 heading 段落文本，不死循环', () => {
    const md = '正文段落\n### ';
    const { container } = render(<PrimitiveMarkdownView source={md} />);
    // 无 h3
    expect(container.querySelector('h3')).toBeNull();
    // 段落有限
    expect(container.querySelectorAll('p').length).toBeLessThanOrEqual(2);
  });
});

describe('PrimitiveMarkdownView — 飞书文档综合片段（v0.0.145 回归）', () => {
  it('飞书 md 片段：标题 + 有序列表 + 引用块 + 链接 + 加粗 混合渲染', () => {
    const md = [
      '# 在飞书开放平台创建机器人',
      '',
      '## 步骤 1：创建机器人',
      '',
      '1. 登录 [飞书开放平台](https://open.feishu.cn/)。',
      '2. 点击 **创建企业自建应用**。',
      '',
      '> **注意：** 应用需经管理员审批。',
    ].join('\n');
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    expect(container.querySelector('h1')?.textContent).toBe('在飞书开放平台创建机器人');
    expect(container.querySelector('h2')?.textContent).toBe('步骤 1：创建机器人');
    const olItems = Array.from(container.querySelectorAll('ol li')).map((li) => li.textContent);
    expect(olItems).toEqual(['登录 飞书开放平台。', '点击 创建企业自建应用。']);
    const bq = container.querySelector('blockquote');
    expect(bq?.querySelector('strong')?.textContent).toBe('注意：');
    expect(bq?.textContent).toContain('应用需经管理员审批');
    // 链接
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://open.feishu.cn/');
    expect(anchor?.getAttribute('target')).toBe('_blank');
  });
});

describe('PrimitiveMarkdownView — block 级图片渲染（v0.0.286）', () => {
  beforeEach(() => {
    // mock rockyShell.readFileBinary（block 图片分支用）
    (window as unknown as { rockyShell: unknown }).rockyShell = {
      readFileBinary: vi.fn(async () => ({ ok: true, content: 'aGVsbG8=' })),
    };
  });
  afterEach(() => {
    delete (window as unknown as { rockyShell?: unknown }).rockyShell;
  });

  it('独立行 web 图片 → 渲染 MarkdownImage loaded', async () => {
    const md = '![示例图](https://example.com/test.png)';
    const { container } = render(<PrimitiveMarkdownView source={md} />);
    // web 图片同步直渲
    const img = container.querySelector('[data-testid="md-image-loaded"]') as HTMLImageElement | null;
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('https://example.com/test.png');
    expect(img?.getAttribute('alt')).toBe('示例图');
  });

  it('独立行 data:image/ 图片 → 直渲', () => {
    const md = '![inline](data:image/png;base64,iVBOR)';
    const { container } = render(<PrimitiveMarkdownView source={md} />);
    const img = container.querySelector('[data-testid="md-image-loaded"]') as HTMLImageElement | null;
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,iVBOR');
  });

  it('独立行危险协议 javascript: → 降级 error', async () => {
    // URL 不含 ) 以匹配 BLOCK_IMAGE_RE（含 ) 的 URL 走段落路径，不是图片）
    const md = '![xss](javascript:alert)';
    const { container } = render(<PrimitiveMarkdownView source={md} />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="md-image-error"]')).toBeTruthy();
    });
  });

  it('图片 + 段落混合：图片不侵入段落', () => {
    const md = [
      '这是一段文字。',
      '',
      '![图](https://example.com/a.png)',
      '',
      '另一段文字。',
    ].join('\n');
    const { container } = render(<PrimitiveMarkdownView source={md} />);
    // 两段文字
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs.length).toBe(2);
    // 图片独立 block
    const img = container.querySelector('[data-testid="md-image-loaded"]');
    expect(img).toBeTruthy();
  });

  it('无 baseDir + 相对路径图 → 降级 error（chat 气泡场景）', () => {
    const md = '![相对图](img/local.png)';
    const { container } = render(<PrimitiveMarkdownView source={md} />);
    // 无 baseDir → relative 无 resolvedPath → error 降级
    const error = container.querySelector('[data-testid="md-image-error"]');
    expect(error).toBeTruthy();
  });

  it('有 baseDir + absolute 路径图 → readFileBinary IPC 调用', async () => {
    const api = (window as unknown as { rockyShell: { readFileBinary: ReturnType<typeof vi.fn> } }).rockyShell;
    const md = '![本地图](/abs/path/local.png)';
    render(<PrimitiveMarkdownView source={md} />);
    // 等 effect → readFileBinary
    await new Promise((r) => setTimeout(r, 50));
    expect(api.readFileBinary).toHaveBeenCalledWith('/abs/path/local.png');
  });

  it('inline 文本中嵌入 ![alt](url) 不渲染为图片（仅 block 级）', () => {
    const md = '这是行内 ![小图](https://example.com/inline.png) 文字';
    const { container } = render(<PrimitiveMarkdownView source={md} />);
    // 整行不是独立图片行 → 走段落 renderInline → 无 md-image-loaded
    const img = container.querySelector('[data-testid="md-image-loaded"]');
    expect(img).toBeFalsy();
    // 段落正常渲染
    const p = container.querySelector('p');
    expect(p).toBeTruthy();
  });
});

// ===== v0.0.313: frontmatter 渲染（首行 --- ... --- → 灰色 metadata 块）=====
describe('PrimitiveMarkdownView — frontmatter 渲染（v0.0.313）', () => {
  it('合法 frontmatter → 渲染为灰色 metadata <div> + 正文标题正常', () => {
    const md = '---\nname: test-doc\ntitle: 测试文档\n---\n# Title';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    // frontmatter 内容块（font-mono + whitespace-pre-wrap）
    const fmDiv = container.querySelector('.font-mono.whitespace-pre-wrap');
    expect(fmDiv).not.toBeNull();
    expect(fmDiv?.textContent).toContain('name: test-doc');
    expect(fmDiv?.textContent).toContain('title: 测试文档');
    // --- 分隔符不出现在渲染输出中
    expect(fmDiv?.textContent).not.toMatch(/^---$/);

    // 正文标题正常渲染
    const h1 = container.querySelector('h1');
    expect(h1?.textContent).toBe('Title');
  });

  it('无 frontmatter（首行不是 ---）→ 不触发，纯正文正常渲染', () => {
    const md = '# Title\n\n正文段落。';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    // 无 frontmatter metadata div（font-mono + whitespace-pre-wrap 组合仅 frontmatter 用）
    // 验证标题正常
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    // 段落正常
    const p = container.querySelector('p');
    expect(p?.textContent).toContain('正文段落');
    // 不应出现 frontmatter 样式的纯文本块（非 pre/code 场景）
    const fmDivs = Array.from(container.querySelectorAll('div')).filter(
      (d) => d.classList.contains('whitespace-pre-wrap') && !d.querySelector('pre') && d.textContent?.includes(':'),
    );
    // 没有 frontmatter 特征块
    expect(fmDivs.length).toBe(0);
  });

  it('未闭合 frontmatter（只有开头 --- 无结尾 ---）→ 不识别为 frontmatter，回退原逻辑', () => {
    const md = '---\nname: x';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    // 没有闭合 --- → 不识别为 frontmatter → 走段落渲染
    // --- 会被当作普通段落文本
    const text = container.textContent ?? '';
    expect(text).toContain('---');
    expect(text).toContain('name: x');
    // 没有独立的 frontmatter metadata div（不含 pre）
    const fmDivs = Array.from(container.querySelectorAll('div')).filter(
      (d) => d.classList.contains('whitespace-pre-wrap') && !d.querySelector('pre'),
    );
    expect(fmDivs.length).toBe(0);
  });

  it('正文中有 --- 分隔线不误判（非首行 --- 正常渲染为段落/文本）', () => {
    const md = '# Title\n\n---\n\ntext after divider';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    // 标题正常
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    // --- 分隔线后的文本正常渲染
    const text = container.textContent ?? '';
    expect(text).toContain('text after divider');
    // 没有独立的 frontmatter metadata div（不含 pre）
    const fmDivs = Array.from(container.querySelectorAll('div')).filter(
      (d) => d.classList.contains('whitespace-pre-wrap') && !d.querySelector('pre'),
    );
    expect(fmDivs.length).toBe(0);
  });
});

// ===== v0.0.314: 段落多行换行保留（para.join(' ') → 逐行 renderInline + \n）=====
describe('PrimitiveMarkdownView — 段落多行换行保留（v0.0.314）', () => {
  it('多行纯文本段落：渲染为单个 <p>，每行作为独立 <span>，行间有换行文本节点', () => {
    const md = '第一行\n第二行\n第三行';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const p = container.querySelector('p');
    expect(p).toBeTruthy();
    // whitespace-pre-wrap 让换行符在 HTML 中渲染
    expect(p?.className).toContain('whitespace-pre-wrap');

    // 每行内容保留（不挤成一行空格连接）
    const text = p?.textContent ?? '';
    expect(text).toContain('第一行');
    expect(text).toContain('第二行');
    expect(text).toContain('第三行');
    // 不应出现 "第一行 第二行"（空格连接的旧行为）
    expect(text).not.toContain('第一行 第二行');
    // 换行符保留在 DOM 中（whitespace-pre-wrap 下渲染为换行）
    expect(text).toContain('\n');
  });

  it('多行段落 + 行内格式：每行单独 renderInline，加粗/代码/链接不丢失', () => {
    const md = '**加粗**行\n`代码`行\n[链接](https://x.com)行';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const p = container.querySelector('p');
    expect(p).toBeTruthy();
    // 三行各自的行内格式都保留
    expect(p?.querySelector('strong')?.textContent).toBe('加粗');
    expect(p?.querySelector('code')?.textContent).toBe('代码');
    expect(p?.querySelector('a')?.getAttribute('href')).toBe('https://x.com');
    // 换行符保留
    expect(p?.textContent).toContain('\n');
  });

  it('单行段落仍正常渲染（不回归）', () => {
    const md = '这是单行段落。';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const p = container.querySelector('p');
    expect(p).toBeTruthy();
    expect(p?.textContent).toBe('这是单行段落。');
    // 单行段落不应有多余换行符
    expect(p?.textContent).not.toContain('\n');
  });

  it('两段落间用空行分隔：各段落内多行换行各自保留', () => {
    const md = '段落一行 A\n段落一行 B\n\n段落二行 C\n段落二行 D';
    const { container } = render(<PrimitiveMarkdownView source={md} />);

    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs.length).toBe(2);
    // 段落一内两行各自保留
    const t1 = paragraphs[0]!.textContent ?? '';
    expect(t1).toContain('段落一行 A');
    expect(t1).toContain('段落一行 B');
    expect(t1).toContain('\n');
    // 段落二内两行各自保留
    const t2 = paragraphs[1]!.textContent ?? '';
    expect(t2).toContain('段落二行 C');
    expect(t2).toContain('段落二行 D');
    expect(t2).toContain('\n');
  });
});
