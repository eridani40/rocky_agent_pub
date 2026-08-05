/**
 * @vitest-environment jsdom
 * component-skill-item 单测：内置技能只读性 UI 体现
 * 参考: specs/ui/components/skill-page/component-skill-item.md（决策 — 内置技能只读性 UI 体现）
 *
 * 内置技能（scope === 'builtin'）后端语义：进化 400 / 删除 403 / 启停 OK。
 * 卡片对 builtin：evolvable toggle + 删除按钮 disabled 灰化 + hover 提示；enabled toggle 保持可用。
 * 非 builtin（app/workspace）三操作全可用（回归）。
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ComponentSkillItem } from '../component-skill-item';
import type { SkillEntry } from '../../../lib/api-client';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});
afterEach(() => cleanup());

/** 构造一个 skill 条目（默认 app scope） */
function mkSkill(over: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name: 's1',
    description: 'desc',
    scope: 'app',
    skillDir: '/x',
    enabled: true,
    evolvable: false,
    ...over,
  };
}

/** 渲染卡片，返回四个操作回调 mock */
function renderItem(skill: SkillEntry) {
  const onToggle = vi.fn();
  const onToggleEvolvable = vi.fn();
  const onPreview = vi.fn();
  const onDelete = vi.fn();
  render(
    <ComponentSkillItem
      skill={skill}
      onToggle={onToggle}
      onToggleEvolvable={onToggleEvolvable}
      onPreview={onPreview}
      onDelete={onDelete}
    />,
  );
  return { onToggle, onToggleEvolvable, onPreview, onDelete };
}

describe('ComponentSkillItem — 内置技能只读性', () => {
  it('builtin：evolvable toggle disabled + title 含「不可进化」，点击不触发 onToggleEvolvable', () => {
    const { onToggleEvolvable } = renderItem(mkSkill({ name: 'bi', scope: 'builtin' }));
    const ev = screen.getByRole('switch', { name: 'bi 自进化 开 / 关' });
    // disabled 由原生属性 + aria-disabled 体现（供 ET dom 断言）
    expect(ev.hasAttribute('disabled')).toBe(true);
    expect(ev.getAttribute('aria-disabled')).toBe('true');
    // title 兜底挂在 tooltip trigger 上（PrimitiveTooltip 对纯文本 content 自动设 title）
    const titled = ev.closest('[title]');
    expect(titled).not.toBeNull();
    expect(titled!.getAttribute('title')).toContain('不可进化');
    // hover 被拒开关 → 拒绝理由浮层出现在其旁（单行短文案，卡片静态外观不变）
    fireEvent.mouseEnter(titled!);
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('内置 Skill 不可进化');
    // 点击不触发（native disabled + primitive 守卫双保险）
    fireEvent.click(ev);
    expect(onToggleEvolvable).not.toHaveBeenCalled();
  });

  it('builtin：删除按钮 disabled + title 含「不可删除」，点击不触发 onDelete', () => {
    const { onDelete } = renderItem(mkSkill({ name: 'bi', scope: 'builtin' }));
    const del = screen.getByRole('button', { name: '删除 bi' });
    expect(del.hasAttribute('disabled')).toBe(true);
    expect(del.getAttribute('title')).toContain('不可删除');
    fireEvent.click(del);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('builtin：enabled toggle 仍可用，点击触发 onToggle', () => {
    const { onToggle } = renderItem(mkSkill({ name: 'bi', scope: 'builtin', enabled: true }));
    const en = screen.getByRole('switch', { name: 'bi 启用 / 禁用' });
    expect(en.hasAttribute('disabled')).toBe(false);
    fireEvent.click(en);
    expect(onToggle).toHaveBeenCalledWith('bi');
  });

  it('app（非 builtin）：evolvable/delete/enable 全可用（回归）', () => {
    const { onToggle, onToggleEvolvable, onDelete } = renderItem(mkSkill({ name: 'ap', scope: 'app' }));
    const ev = screen.getByRole('switch', { name: 'ap 自进化 开 / 关' });
    const del = screen.getByRole('button', { name: '删除 ap' });
    const en = screen.getByRole('switch', { name: 'ap 启用 / 禁用' });
    expect(ev.hasAttribute('disabled')).toBe(false);
    expect(del.hasAttribute('disabled')).toBe(false);
    // 非 builtin evolvable 无 title 包裹（不显示只读提示）
    expect(ev.closest('[title]')).toBeNull();
    // 删除按钮 title 为普通「删除」，非只读提示
    expect(del.getAttribute('title')).not.toContain('不可删除');
    fireEvent.click(ev);
    fireEvent.click(en);
    fireEvent.click(del);
    expect(onToggleEvolvable).toHaveBeenCalledWith('ap');
    expect(onToggle).toHaveBeenCalledWith('ap');
    expect(onDelete).toHaveBeenCalled();
  });

  it('workspace（非 builtin）：evolvable/delete 可用（回归）', () => {
    renderItem(mkSkill({ name: 'ws', scope: 'workspace' }));
    expect(screen.getByRole('switch', { name: 'ws 自进化 开 / 关' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: '删除 ws' }).hasAttribute('disabled')).toBe(false);
  });
});

describe('ComponentSkillItem — 来源徽标 [v0.0.167]', () => {
  it('有 marketRef（市场安装）→ 来源 badge 显示「市场」', () => {
    renderItem(mkSkill({ name: 'mk', marketRef: 'owner/skill', marketSource: 'skills_sh' }));
    expect(screen.getByText('市场').textContent).toBe('市场');
  });

  it('无 marketRef（本地/拖拽/builtin）→ 来源 badge 显示「本地」', () => {
    renderItem(mkSkill({ name: 'lc' }));
    expect(screen.getByText('本地').textContent).toBe('本地');
  });
});
