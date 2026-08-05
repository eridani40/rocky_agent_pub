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
import { render, cleanup, fireEvent } from '@testing-library/react';
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
