/**
 * @vitest-environment jsdom
 * component-skill-browser-modal 单测 —— 版本 Skills 浏览/编辑弹层
 * 参考: specs/ui/components/academy-page/component-skill-browser-modal.md
 *       specs/ui/components/_conventions.md §13（L3 modal 不变式：Portal + pointer-events-auto）
 *
 * 覆盖：
 * - 防回归（核心）：Portal 根 div className 必须含 pointer-events-auto（overlay-root 为
 *   pointer-events:none 且可继承，漏写则整棵子树不接事件；jsdom 无 hit-testing，必须断 className）。
 * - 两级树：顶层 skill 目录 → 目录内文件/子目录。
 * - 右侧按类别分渲染：.md → markdown（heading）/ .py → mono <pre> / binary → 不可预览
 *   / 未知扩展名 → 不支持预览。
 * - readOnly（process 版本）不渲染编辑与保存；formal 保存回调携带 {skillName,path,content}。
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ComponentSkillBrowserModal } from '../component-skill-browser-modal';
import type { SkillSummary, VersionSkillFileContent } from '../../../lib/academy-api';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

/** 两个 skill：一个含子目录 + 二进制图片 + yaml，一个只有 SKILL.md */
const SKILLS: SkillSummary[] = [
  {
    name: 'panorama-designer',
    description: '全景图排版方法论',
    fileCount: 5,
    files: [
      { name: 'SKILL.md', path: 'SKILL.md', type: 'file', size: 120, hash: 'aaaaaaaaaaaa' },
      { name: 'refs', path: 'refs', type: 'dir' },
      { name: 'guide.py', path: 'refs/guide.py', type: 'file', size: 30, hash: 'bbbbbbbbbbbb' },
      { name: 'logo.png', path: 'logo.png', type: 'file', size: 900, hash: 'cccccccccccc' },
      { name: 'LICENSE', path: 'LICENSE', type: 'file', size: 10, hash: 'dddddddddddd' },
      { name: 'config.yaml', path: 'config.yaml', type: 'file', size: 40, hash: 'ffffffffffff' },
    ],
  },
  {
    name: 'tone-checker',
    fileCount: 1,
    files: [{ name: 'SKILL.md', path: 'SKILL.md', type: 'file', size: 60, hash: 'eeeeeeeeeeee' }],
  },
];

/** SKILL.md 真实形态：YAML frontmatter（元信息）+ 正文 */
const SKILL_MD = '---\nname: demo-skill\ndescription: 演示多级目录 skill 的预览渲染\n---\n\n# 全景图\n\n正文\n';
/** yaml 文件：内容里的 `---`（文档分隔）属正文字符，宽泛文本分支必须原样保留 */
const CONFIG_YAML = '---\nkey: value\n---\nother: 1\n';

/** 按 path 返回内容（logo.png 走后端 binary 标记） */
const FILES: Record<string, VersionSkillFileContent> = {
  'SKILL.md': { path: 'SKILL.md', content: SKILL_MD, truncated: false, binary: false },
  'refs/guide.py': { path: 'refs/guide.py', content: 'print("hi")', truncated: false, binary: false },
  'logo.png': { path: 'logo.png', content: '', truncated: false, binary: true },
  'config.yaml': { path: 'config.yaml', content: CONFIG_YAML, truncated: false, binary: false },
  LICENSE: { path: 'LICENSE', content: 'MIT', truncated: false, binary: false },
};

function renderModal(overrides: Partial<Parameters<typeof ComponentSkillBrowserModal>[0]> = {}) {
  const onClose = vi.fn();
  const onSaveFile = vi.fn(() => Promise.resolve());
  const onFetchFile = vi.fn((_skill: string, path: string) =>
    Promise.resolve(FILES[path] ?? { path, content: '', truncated: false, binary: false }),
  );
  render(
    <ComponentSkillBrowserModal
      open
      skills={SKILLS}
      studentName="小红书文案"
      versionLabel="v2.0"
      onFetchFile={onFetchFile}
      onSaveFile={onSaveFile}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onClose, onSaveFile, onFetchFile };
}

/** Portal 根 div（挂在 overlay-root 下，不在 render container 内） */
function overlayRootDiv(): HTMLElement {
  const el = document.querySelector('#overlay-root > div') as HTMLElement;
  expect(el).toBeTruthy();
  return el;
}

/** 点树里某个节点（文件/目录名文本） */
function clickNode(name: string) {
  fireEvent.click(screen.getByText(name));
}

describe('ComponentSkillBrowserModal — L3 modal 不变式（防回归）', () => {
  it('Portal 根 div className 含 pointer-events-auto（缺失 → 全弹层按钮不可点）', () => {
    renderModal();
    const root = overlayRootDiv();
    expect(root.className).toContain('pointer-events-auto');
    expect(root.className).toContain('fixed');
    expect(root.className).toContain('z-[var(--z-modal)]');
  });

  it('open=false → 不渲染', () => {
    renderModal({ open: false });
    expect(document.querySelector('#overlay-root > div')).toBeNull();
  });
});

describe('ComponentSkillBrowserModal — 两级树', () => {
  it('顶层是 skill 目录，展开后可见目录内文件与子目录', () => {
    renderModal();
    // 两个 skill 目录都在顶层
    expect(screen.getByText('panorama-designer')).toBeTruthy();
    expect(screen.getByText('tone-checker')).toBeTruthy();
    // panorama-designer 内部文件/子目录（默认全展开）
    expect(screen.getByText('refs')).toBeTruthy();
    expect(screen.getByText('guide.py')).toBeTruthy();
    expect(screen.getByText('logo.png')).toBeTruthy();
    // 同名 SKILL.md 两份（两个 skill 各一）→ 树节点 path 带 skill 前缀不互相覆盖
    expect(screen.getAllByText('SKILL.md')).toHaveLength(2);
  });

  it('空 skills → 空态文案', () => {
    renderModal({ skills: [] });
    expect(screen.getByText('该版本还没有 skill')).toBeTruthy();
  });
});

describe('ComponentSkillBrowserModal — 右侧按类别分渲染', () => {
  it('选 .md → markdown 渲染（heading），fetch 收到 skill 名 + 相对 path', async () => {
    const { onFetchFile } = renderModal();
    clickNode('tone-checker');            // 折叠掉第二个 skill 避免同名歧义
    clickNode('SKILL.md');                // 剩下 panorama-designer 的 SKILL.md
    await waitFor(() => expect(screen.getByRole('heading', { name: '全景图' })).toBeTruthy());
    expect(onFetchFile).toHaveBeenCalledWith('panorama-designer', 'SKILL.md');
  });

  it('选 .py → mono <pre> 原文（不走 markdown）', async () => {
    renderModal();
    clickNode('guide.py');
    await waitFor(() => {
      const pre = document.querySelector('pre');
      expect(pre).toBeTruthy();
      expect(pre!.textContent).toContain('print("hi")');
    });
  });

  it('binary 文件（后端标记）→ 显「二进制文件，不可预览」', async () => {
    renderModal();
    clickNode('logo.png');
    await waitFor(() => expect(screen.getByText('二进制文件，不可预览')).toBeTruthy());
  });

  it('无扩展名文件 → 显「该文件类型不支持预览」', async () => {
    renderModal();
    clickNode('LICENSE');
    await waitFor(() => expect(screen.getByText('该文件类型不支持预览')).toBeTruthy());
  });
});

describe('ComponentSkillBrowserModal — markdown frontmatter 剥离（元信息不当正文）', () => {
  /** 选中 panorama-designer 的 SKILL.md（先折叠 tone-checker 避免同名歧义） */
  async function selectSkillMd() {
    clickNode('tone-checker');
    clickNode('SKILL.md');
    await waitFor(() => expect(screen.getByRole('heading', { name: '全景图' })).toBeTruthy());
  }

  it('SKILL.md 的 YAML frontmatter 不出现在正文渲染结果里，正文 heading 仍正常渲染', async () => {
    renderModal();
    await selectSkillMd();
    // 正文内容面板（右侧 markdown 容器）= heading 的最近块级祖先所在区域
    const body = screen.getByRole('heading', { name: '全景图' }).parentElement!;
    const text = body.textContent ?? '';
    expect(text).toContain('全景图');
    expect(text).toContain('正文');
    // frontmatter 的键、值、分隔符一个都不该渲染出来（呈现瑕疵的直接判据）
    expect(text).not.toContain('name:');
    expect(text).not.toContain('demo-skill');
    expect(text).not.toContain('description:');
    expect(text).not.toContain('演示多级目录 skill 的预览渲染');
    expect(text).not.toContain('---');
    // 也不应退化成 <pre>（md 分支不是纯文本分支）
    expect(body.querySelector('pre')).toBeNull();
  });

  it('.yaml 文件走宽泛文本分支 → 内容里的 `---` 等字符原样保留（不剥离）', async () => {
    renderModal();
    clickNode('config.yaml');
    await waitFor(() => expect(document.querySelector('pre')).toBeTruthy());
    const pre = document.querySelector('pre')!;
    expect(pre.textContent).toContain('---');
    expect(pre.textContent).toContain('key: value');
    expect(pre.textContent).toContain('other: 1');
  });

  it('编辑态 textarea 仍是含 frontmatter 的文件原文（保存不丢元信息）', async () => {
    const { onSaveFile } = renderModal();
    await selectSkillMd();
    fireEvent.click(screen.getByRole('button', { name: '✏️ 编辑' }));
    const ta = document.querySelector('textarea')! as HTMLTextAreaElement;
    expect(ta.value).toBe(SKILL_MD);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSaveFile).toHaveBeenCalledWith({
      skillName: 'panorama-designer',
      path: 'SKILL.md',
      content: SKILL_MD,
    });
  });
});

describe('ComponentSkillBrowserModal — 编辑保存 / 只读', () => {
  it('readOnly=true → 无编辑切换与保存按钮，且显只读提示', async () => {
    renderModal({ readOnly: true });
    clickNode('guide.py');
    await waitFor(() => expect(document.querySelector('pre')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '✏️ 编辑' })).toBeNull();
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
    expect(screen.getByText('过程版本只读，不可编辑')).toBeTruthy();
  });

  it('formal 编辑保存 → onSaveFile 收到 {skillName,path,content}，保存后回 view', async () => {
    const { onSaveFile } = renderModal();
    clickNode('guide.py');
    await waitFor(() => expect(document.querySelector('pre')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '✏️ 编辑' }));
    fireEvent.change(document.querySelector('textarea')!, { target: { value: 'print("改后")' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSaveFile).toHaveBeenCalledWith({
      skillName: 'panorama-designer',
      path: 'refs/guide.py',
      content: 'print("改后")',
    });
    await waitFor(() => expect(document.querySelector('textarea')).toBeNull());
    expect(screen.getByText('已保存')).toBeTruthy();
  });

  it('binary 文件不给编辑面（即使 formal）', async () => {
    renderModal();
    clickNode('logo.png');
    await waitFor(() => expect(screen.getByText('二进制文件，不可预览')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '✏️ 编辑' })).toBeNull();
  });

  it('点遮罩 / head ✕ → onClose', async () => {
    const { onClose } = renderModal();
    fireEvent.click(overlayRootDiv());
    expect(onClose).toHaveBeenCalledTimes(1);
    // head ✕ 与 foot「关闭」可访问名同为「关闭」，按 textContent 区分
    const headClose = screen.getAllByRole('button', { name: '关闭' }).find((b) => b.textContent === '✕')!;
    fireEvent.click(headClose);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
