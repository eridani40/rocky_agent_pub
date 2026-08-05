/**
 * @vitest-environment node
 * skill-file-view 单测 —— classifySkillFile 扩展名分类
 * 参考: specs/ui/components/academy-page/component-skill-browser-modal.md（右侧按类别分渲染）
 *
 * 覆盖：markdown / text / unknown 三类、大写扩展名、无扩展名、多点文件名、
 * 子目录路径、点开头文件（视为无扩展名）；两级树派生（buildSkillsTree）与
 * 选中项反解（splitSkillSelection）；markdown frontmatter 剥离（元信息不进正文渲染）。
 */
import { describe, it, expect } from 'vitest';
import type { SkillSummary } from '../../../lib/academy-api';
import { buildSkillsTree, classifySkillFile, splitSkillSelection, stripMarkdownFrontmatter } from '../skill-file-view';

describe('classifySkillFile', () => {
  it('.md / .markdown → markdown', () => {
    expect(classifySkillFile('SKILL.md')).toBe('markdown');
    expect(classifySkillFile('README.markdown')).toBe('markdown');
  });

  it('代码/配置扩展名 → text', () => {
    for (const p of ['a.py', 'a.sh', 'a.yaml', 'a.yml', 'a.json', 'a.txt', 'a.ts', 'a.js', 'a.toml', 'a.ini', 'a.csv']) {
      expect(classifySkillFile(p)).toBe('text');
    }
  });

  it('未知扩展名（图片/二进制常见） → unknown', () => {
    expect(classifySkillFile('logo.png')).toBe('unknown');
    expect(classifySkillFile('font.woff2')).toBe('unknown');
  });

  it('大写/混合大小写扩展名 → 与小写同类（不区分大小写）', () => {
    expect(classifySkillFile('SKILL.MD')).toBe('markdown');
    expect(classifySkillFile('conf.YAML')).toBe('text');
    expect(classifySkillFile('IMG.PNG')).toBe('unknown');
  });

  it('无扩展名 → unknown', () => {
    expect(classifySkillFile('LICENSE')).toBe('unknown');
    expect(classifySkillFile('Makefile')).toBe('unknown');
  });

  it('多点文件名 → 取最后一段扩展名', () => {
    expect(classifySkillFile('notes.v2.md')).toBe('markdown');
    expect(classifySkillFile('grid.tpl.yaml')).toBe('text');
    expect(classifySkillFile('archive.tar.gz')).toBe('unknown');
  });

  it('子目录路径 → 只看基名扩展名（目录名含点不干扰）', () => {
    expect(classifySkillFile('references/guide.py')).toBe('text');
    expect(classifySkillFile('v1.2/notes.md')).toBe('markdown');
    expect(classifySkillFile('v1.2/LICENSE')).toBe('unknown');
  });

  it('点开头文件（.gitignore）视为无扩展名 → unknown', () => {
    expect(classifySkillFile('.gitignore')).toBe('unknown');
    expect(classifySkillFile('sub/.env')).toBe('unknown');
  });
});

/** 两个 skill：一个含子目录，一个只有 SKILL.md（同名文件跨 skill 不冲突） */
const SKILLS: SkillSummary[] = [
  {
    name: 'panorama-designer',
    fileCount: 2,
    files: [
      { name: 'SKILL.md', path: 'SKILL.md', type: 'file', hash: 'a1' },
      { name: 'refs', path: 'refs', type: 'dir' },
      { name: 'guide.py', path: 'refs/guide.py', type: 'file', hash: 'b2' },
    ],
  },
  {
    name: 'tone-checker',
    fileCount: 1,
    files: [{ name: 'SKILL.md', path: 'SKILL.md', type: 'file', hash: 'c3' }],
  },
];

describe('buildSkillsTree', () => {
  it('顶层 = 每个 skill 一个 dir 节点（path = skill 名，保持入参顺序）', () => {
    const root = buildSkillsTree(SKILLS);
    expect(root.children.map((c) => c.path)).toEqual(['panorama-designer', 'tone-checker']);
    expect(root.children.every((c) => c.type === 'dir')).toBe(true);
  });

  it('skill 内部子树 path 带 skill 前缀（跨 skill 唯一，同名 SKILL.md 不冲突）', () => {
    const root = buildSkillsTree(SKILLS);
    const first = root.children[0]!;
    // dir 在前、file 在后（复用 buildFileTree 排序）
    expect(first.children.map((c) => c.path)).toEqual([
      'panorama-designer/refs',
      'panorama-designer/SKILL.md',
    ]);
    expect(first.children[0]!.children.map((c) => c.path)).toEqual(['panorama-designer/refs/guide.py']);
    expect(root.children[1]!.children.map((c) => c.path)).toEqual(['tone-checker/SKILL.md']);
  });

  it('三级以上嵌套逐层重建（templates/sub/deep/x.yaml），每层 path 带 skill 前缀', () => {
    const deepSkill: SkillSummary = {
      name: 'deep-nest',
      fileCount: 2,
      files: [
        { name: 'SKILL.md', path: 'SKILL.md', type: 'file', hash: 'd0' },
        { name: 'templates', path: 'templates', type: 'dir' },
        { name: 'sub', path: 'templates/sub', type: 'dir' },
        { name: 'deep', path: 'templates/sub/deep', type: 'dir' },
        { name: 'x.yaml', path: 'templates/sub/deep/x.yaml', type: 'file', hash: 'd1' },
      ],
    };
    const skillNode = buildSkillsTree([deepSkill]).children[0]!;
    // 逐层下钻：templates → sub → deep → x.yaml（两级实现会在此断言处塌掉）
    const templates = skillNode.children.find((c) => c.name === 'templates')!;
    expect(templates.path).toBe('deep-nest/templates');
    const sub = templates.children[0]!;
    expect(sub.path).toBe('deep-nest/templates/sub');
    const deep = sub.children[0]!;
    expect(deep.path).toBe('deep-nest/templates/sub/deep');
    expect(deep.children.map((c) => [c.path, c.type])).toEqual([
      ['deep-nest/templates/sub/deep/x.yaml', 'file'],
    ]);
    // 深层选中项能反解回 skill 名 + 相对 skill 目录的全路径
    expect(splitSkillSelection('deep-nest/templates/sub/deep/x.yaml')).toEqual({
      skillName: 'deep-nest',
      path: 'templates/sub/deep/x.yaml',
    });
  });

  it('空 skills → 空 children', () => {
    expect(buildSkillsTree([]).children).toEqual([]);
  });
});

describe('splitSkillSelection', () => {
  it('反解 skill 名 + 相对 path（含子目录）', () => {
    expect(splitSkillSelection('panorama-designer/SKILL.md')).toEqual({
      skillName: 'panorama-designer',
      path: 'SKILL.md',
    });
    expect(splitSkillSelection('panorama-designer/refs/guide.py')).toEqual({
      skillName: 'panorama-designer',
      path: 'refs/guide.py',
    });
  });

  it('skill 目录本身 / 分隔符在首末位 → null', () => {
    expect(splitSkillSelection('panorama-designer')).toBeNull();
    expect(splitSkillSelection('/SKILL.md')).toBeNull();
    expect(splitSkillSelection('panorama-designer/')).toBeNull();
  });
});

describe('stripMarkdownFrontmatter', () => {
  it('SKILL.md frontmatter 被剥离，正文（含首个 heading）完整保留', () => {
    const src = '---\nname: demo-skill\ndescription: 演示多级目录 skill 的预览渲染\n---\n\n# Demo Skill\n\n正文段落。\n';
    const body = stripMarkdownFrontmatter(src);
    expect(body).toBe('# Demo Skill\n\n正文段落。\n');
    // frontmatter 键值一个字都不留（呈现瑕疵的直接判据）
    expect(body).not.toContain('name:');
    expect(body).not.toContain('description:');
    expect(body).not.toContain('---');
  });

  it('无 frontmatter（正文直接起头）→ 原样返回', () => {
    const src = '# Demo\n\n正文\n';
    expect(stripMarkdownFrontmatter(src)).toBe(src);
  });

  it('正文中间的 `---` 不被误剥（分隔符必须在文件开头）', () => {
    const src = '# Demo\n\n---\n\n后半段\n';
    expect(stripMarkdownFrontmatter(src)).toBe(src);
  });

  it('有起始 `---` 但无闭合 → 原样返回（不吞正文）', () => {
    const src = '---\nname: broken\n\n# 正文还在\n';
    expect(stripMarkdownFrontmatter(src)).toBe(src);
  });

  it('CRLF 行尾同样剥离', () => {
    const src = '---\r\nname: demo\r\n---\r\n\r\n# Demo\r\n';
    expect(stripMarkdownFrontmatter(src)).toBe('# Demo\r\n');
  });

  it('闭合后多个空行被压掉，正文首 block 顶到最前', () => {
    expect(stripMarkdownFrontmatter('---\nname: d\n---\n\n\n\n## 二级\n')).toBe('## 二级\n');
  });

  it('只有 frontmatter（无正文）→ 空串', () => {
    expect(stripMarkdownFrontmatter('---\nname: d\n---\n')).toBe('');
    expect(stripMarkdownFrontmatter('---\nname: d\n---')).toBe('');
  });

  it('空串 / 纯空白 → 原样返回', () => {
    expect(stripMarkdownFrontmatter('')).toBe('');
    expect(stripMarkdownFrontmatter('\n\n')).toBe('\n\n');
  });
});
