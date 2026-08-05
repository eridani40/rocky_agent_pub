/**
 * @vitest-environment jsdom
 * component-skill-diff-list 单测 —— skills 段两级 diff 渲染（skill 目录 × 目录内文件）
 * 参考: specs/ui/components/academy-page/component-skill-diff-list.md
 *
 * 覆盖：
 * - 四态目录 badge（整体新增 / 已移除 / 文件修改 / 不变）+ 默认展开规则（仅 unchanged 折叠）
 * - 文件级 badge（新增文件 / 删除文件 / 修改 / 二进制变更 / 不变）
 * - 有内容的 modified 文件默认展开并出行级 diff（复用 diff-viewer 的 cmp-cols 原语）
 * - binary 文件只显「二进制变更」+ 字节变化，**不出任何行级 diff**（不进 computeLineDiff）
 * - 取不到内容的变更文件降级为「只有 badge、无行级 diff」
 * 同时守住 component-diff-viewer ↔ component-skill-diff-list 的循环引用在运行期可解析。
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentSkillDiffList } from '../component-skill-diff-list';
import { ComponentDiffViewer, type SkillDirDiff } from '../component-diff-viewer';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

const LABELS = { baseLabel: 'base · v1.0', candLabel: '候选 · v2.0' };

describe('ComponentSkillDiffList', () => {
  it('四态目录 badge 齐全，unchanged 目录默认折叠、其余默认展开', () => {
    const dirs: SkillDirDiff[] = [
      { skillName: 'a-new', changeKind: 'added', files: [{ path: 'SKILL.md', changeKind: 'added', candContent: 'hello' }] },
      { skillName: 'b-mod', changeKind: 'modified', files: [{ path: 'references/x.py', changeKind: 'modified' }] },
      { skillName: 'c-gone', changeKind: 'removed', files: [{ path: 'SKILL.md', changeKind: 'removed', baseContent: 'bye' }] },
      { skillName: 'd-same', changeKind: 'unchanged', files: [{ path: 'SKILL.md', changeKind: 'unchanged' }] },
    ];
    render(<ComponentSkillDiffList dirs={dirs} {...LABELS} />);
    expect(screen.getByText('整体新增')).toBeTruthy();
    expect(screen.getByText('已移除')).toBeTruthy();
    expect(screen.getByText('文件修改')).toBeTruthy();
    expect(screen.getByText('未变')).toBeTruthy();
    // 展开的三个目录露出文件行；折叠的 d-same 不渲染其文件行
    expect(screen.getAllByText('SKILL.md')).toHaveLength(2);
    expect(screen.getByText('references/x.py')).toBeTruthy();
    // 折叠目录仍可点开
    fireEvent.click(screen.getByText('🧩 d-same'));
    expect(screen.getAllByText('SKILL.md')).toHaveLength(3);
  });

  it('modified 文件有两侧内容 → 默认展开行级 diff（cmp-col-tag 出现）', () => {
    const dirs: SkillDirDiff[] = [
      {
        skillName: 'audit',
        changeKind: 'modified',
        files: [{ path: 'SKILL.md', changeKind: 'modified', baseContent: 'line one\nline two', candContent: 'line one\nline TWO' }],
      },
    ];
    render(<ComponentSkillDiffList dirs={dirs} {...LABELS} />);
    expect(screen.getByText('修改')).toBeTruthy();
    expect(screen.getByText('base · v1.0')).toBeTruthy();
    expect(screen.getByText('候选 · v2.0')).toBeTruthy();
    expect(screen.getByText('line two')).toBeTruthy();
    expect(screen.getByText('line TWO')).toBeTruthy();
  });

  it('binary 文件只显「二进制变更」+ 字节变化，无行级 diff', () => {
    const dirs: SkillDirDiff[] = [
      {
        skillName: 'img',
        changeKind: 'modified',
        files: [{ path: 'logo.png', changeKind: 'modified', binary: true, baseSize: 900, candSize: 2048 }],
      },
    ];
    render(<ComponentSkillDiffList dirs={dirs} {...LABELS} />);
    expect(screen.getByText('二进制变更')).toBeTruthy();
    expect(screen.getByText('900 B → 2.0 KB')).toBeTruthy();
    // 行级 diff 的 cmp-col-tag 必须完全不出现
    expect(screen.queryByText('base · v1.0')).toBeNull();
  });

  it('变更文件取不到内容 → 只显 badge，降级为无行级 diff', () => {
    const dirs: SkillDirDiff[] = [
      { skillName: 's', changeKind: 'modified', files: [{ path: 'SKILL.md', changeKind: 'modified' }] },
    ];
    render(<ComponentSkillDiffList dirs={dirs} {...LABELS} />);
    expect(screen.getByText('修改')).toBeTruthy();
    expect(screen.queryByText('base · v1.0')).toBeNull();
  });

  it('新增/删除文件 badge + 空 dirs 显空态', () => {
    const dirs: SkillDirDiff[] = [
      {
        skillName: 's',
        changeKind: 'modified',
        files: [
          { path: 'a.md', changeKind: 'added', candContent: 'new file' },
          { path: 'b.md', changeKind: 'removed', baseContent: 'old file' },
          { path: 'c.md', changeKind: 'unchanged' },
        ],
      },
    ];
    render(<ComponentSkillDiffList dirs={dirs} {...LABELS} />);
    expect(screen.getByText('新增文件')).toBeTruthy();
    expect(screen.getByText('删除文件')).toBeTruthy();
    expect(screen.getByText('不变')).toBeTruthy();
    cleanup();
    render(<ComponentSkillDiffList dirs={[]} {...LABELS} />);
    expect(screen.getByText('该版本还没有 skill')).toBeTruthy();
  });

  it('经 ComponentDiffViewer 的 skills 分支渲染（两模块互相引用在运行期可解析）', () => {
    render(
      <ComponentDiffViewer
        items={[
          {
            kind: 'skills',
            icon: '🧩',
            name: 'Skills',
            summary: 'skill 文件对比 · 整体新增 1',
            defaultOpen: true,
            skills: { skills: [{ skillName: 'fresh', changeKind: 'added', files: [{ path: 'SKILL.md', changeKind: 'added', candContent: 'x' }] }] },
          },
        ]}
        {...LABELS}
      />,
    );
    expect(screen.getByText('🧩 fresh')).toBeTruthy();
    expect(screen.getByText('整体新增')).toBeTruthy();
    expect(screen.getByText('新增文件')).toBeTruthy();
  });
});
