/**
 * @vitest-environment jsdom
 * primitive-mention-pill 单测（v0.0.86 mention 报文重构）
 * 参考: specs/ui/components/chat-page/mention-pill.md（v0.0.86 重写后权威源）
 *
 * v0.0.86 变更：
 *   - Props: type → icon/label/badge（type-agnostic，INV-2）
 *   - data-mention-type → data-mention-icon；data-mention-label 现为裸名（不含 @）
 *   - 新增 Glyph registry（7 key 内联 SVG）+ Badge registry（leader 皇冠）
 *
 * 覆盖：
 *   - 渲染 label 文本（@ 前缀由组件加，data-mention-label 存裸名）
 *   - data-mention-icon/label/badge 三 data 属性
 *   - Glyph registry 7 key 全可解析（皆有 svg）
 *   - Glyph 未注册 key fallback @ 符号（不 crash）
 *   - badge=leader 渲染皇冠；未注册 badge 不渲染
 *   - onRemove 存在时 data-removable 标记
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MentionPill, Glyph } from '../primitive-mention-pill';

afterEach(() => cleanup());

describe('MentionPill（v0.0.86 icon/label/badge）', () => {
  it('渲染 @ 前缀 + 裸名 data-mention-label', () => {
    render(<MentionPill icon="skill" label="drama-script-writer" />);
    const pill = document.querySelector('[data-mention-icon]')!;
    expect(pill).toBeTruthy();
    // 视觉显示 @ 前缀
    expect(pill.textContent).toContain('@drama-script-writer');
    // data-mention-icon 替代旧 data-mention-type
    expect(pill.getAttribute('data-mention-icon')).toBe('skill');
    // data-mention-label 存裸名（不含 @）
    expect(pill.getAttribute('data-mention-label')).toBe('drama-script-writer');
  });

  it('Glyph registry 7 key 全可解析（皆有 svg）', () => {
    const keys = ['file', 'skill', 'member', 'goal', 'kr', 'requirement', 'task'];
    for (const k of keys) {
      const { container } = render(<Glyph name={k} />);
      const svg = container.querySelector('svg');
      expect(svg, `glyph "${k}" 应渲染 svg`).toBeTruthy();
      cleanup();
    }
  });

  it('Glyph 未注册 key fallback @ 符号（不 crash、不抛错）', () => {
    const { container } = render(<Glyph name="unknown-key" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toBe('@');
  });

  it('file 类型渲染 file icon', () => {
    render(<MentionPill icon="file" label="helper.ts" />);
    const pill = document.querySelector('[data-mention-icon]')!;
    expect(pill.querySelector('svg')).toBeTruthy();
    expect(pill.getAttribute('data-mention-icon')).toBe('file');
  });

  it('workitem goal 类型渲染 goal icon（验证 workitem glyph 已注册）', () => {
    render(<MentionPill icon="goal" label="提升DAU" />);
    const pill = document.querySelector('[data-mention-icon]')!;
    expect(pill.querySelector('svg')).toBeTruthy();
    expect(pill.getAttribute('data-mention-icon')).toBe('goal');
  });

  it('badge=leader 渲染皇冠 + data-mention-badge', () => {
    render(<MentionPill icon="member" label="张三" badge="leader" />);
    const pill = document.querySelector('[data-mention-icon]')!;
    expect(pill.getAttribute('data-mention-badge')).toBe('leader');
    // badge 也渲染为 svg（皇冠）
    const svgs = pill.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(2);
  });

  it('无 badge → 不渲染皇冠 + 无 data-mention-badge 属性', () => {
    render(<MentionPill icon="member" label="李四" />);
    const pill = document.querySelector('[data-mention-icon]')!;
    expect(pill.getAttribute('data-mention-badge')).toBeNull();
    // 仅一个 svg（glyph），无 badge svg
    expect(pill.querySelectorAll('svg').length).toBe(1);
  });

  it('onRemove 存在时标记 data-removable', () => {
    render(<MentionPill icon="skill" label="test" onRemove={() => {}} />);
    const pill = document.querySelector('[data-mention-icon]')!;
    expect(pill.getAttribute('data-removable')).toBe('true');
  });

  it('无 onRemove 时不标记 data-removable', () => {
    render(<MentionPill icon="skill" label="test" />);
    const pill = document.querySelector('[data-mention-icon]')!;
    expect(pill.getAttribute('data-removable')).toBeNull();
  });
});
