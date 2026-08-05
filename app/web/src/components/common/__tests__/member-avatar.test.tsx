/**
 * @vitest-environment jsdom
 * member-avatar 单测 —— v0.0.165 银灰体系：hash-by-id 8 色 + presence + 尺寸档
 * 参考: specs/ui/components/common/member-avatar.md（视觉基线 + Props 契约）
 *       specs/ui/regulation/01-tokens.md §1.7 / 02-components.md §3
 *       specs/tech/version_logs/v0.0.165/change_plan.md §4
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemberAvatar } from '../member-avatar';
import { HUE_PALETTE, hashHueName } from '../../../lib/hue-hash';

afterEach(() => cleanup());

describe('MemberAvatar bgColor（v0.0.165 hash-by-id 8 色 palette）', () => {
  it('leader：走 hash palette（同 id 恒返同色）', () => {
    render(<MemberAvatar name="captain" id="mem-001" role="leader" />);
    const av = screen.getByText('C');
    // hash 派生 palette 名之一
    const expectedName = hashHueName('mem-001');
    expect((av as HTMLElement).style.background).toBe(`var(--hue-${expectedName})`);
    expect(HUE_PALETTE.includes(expectedName)).toBe(true);
    expect(av.textContent).toBe('C');
    // 白字 + font-sans（INV-4 无 font-serif）
    expect(av.className).toContain('text-white');
    expect(av.className).toContain('font-sans');
    expect(av.className).not.toContain('font-serif');
  });

  it('mate：走 hash palette（不再固定 gold）', () => {
    render(<MemberAvatar name="worker" id="mem-002" role="mate" />);
    const av = screen.getByText('W');
    const expectedName = hashHueName('mem-002');
    expect((av as HTMLElement).style.background).toBe(`var(--hue-${expectedName})`);
    expect(av.className).toContain('text-white');
  });

  it('id 缺省 → fallback name 参与 hash（back-compat）', () => {
    render(<MemberAvatar name="alice" role="leader" />);
    const av = screen.getByText('A');
    const expectedName = hashHueName('alice');
    expect((av as HTMLElement).style.background).toBe(`var(--hue-${expectedName})`);
  });

  it('同 id 恒返同色（hash 稳定性）', () => {
    const { unmount } = render(<MemberAvatar name="x" id="stable-id" role="leader" />);
    const bg1 = (screen.getByText('X') as HTMLElement).style.background;
    unmount();
    render(<MemberAvatar name="y" id="stable-id" role="mate" />);
    const bg2 = (screen.getByText('Y') as HTMLElement).style.background;
    // 同 id → 同 hue（虽然 name/role 不同，只要都是 leader/mate 走 hash）
    expect(bg2).toBe(bg1);
  });

  it('8 个不同 id 至少覆盖 5+ hue 桶（分布 sanity）', () => {
    const ids = ['id-1', 'id-2', 'id-3', 'id-4', 'id-5', 'id-6', 'id-7', 'id-8'];
    const bgs = new Set<string>();
    for (const id of ids) {
      const { unmount } = render(<MemberAvatar name="n" id={id} role="leader" />);
      bgs.add((screen.getByText('N') as HTMLElement).style.background);
      unmount();
    }
    expect(bgs.size).toBeGreaterThanOrEqual(5);
  });

  it('user：中性灰 fg-2 + 深底浅字（不 hash）', () => {
    render(<MemberAvatar name="alice" role="user" />);
    const av = screen.getByText('A');
    expect((av as HTMLElement).style.background).toBe('var(--fg-2)');
    expect(av.className).toContain('text-surface');
    expect(av.textContent).toBe('A');
  });

  it('squad：brand-grad 三色渐变（regulation 01 §1.8，不 hash）', () => {
    render(<MemberAvatar name="Alpha 小队" role="squad" />);
    const av = screen.getByText('A');
    expect((av as HTMLElement).style.background).toBe('var(--brand-grad)');
    expect(av.className).toContain('text-white');
    expect(av.textContent).toBe('A');
  });

  it('squad 空名兜底：# (channel 语义)', () => {
    render(<MemberAvatar name="" role="squad" />);
    expect(screen.getByText('#').textContent).toBe('#');
  });
});

describe('MemberAvatar 首字母', () => {
  it('trim + upper：「  bob」→ B', () => {
    render(<MemberAvatar name="  bob" role="leader" />);
    expect(screen.getByText('B').textContent).toBe('B');
  });

  it('空名按 role 兜底：user→U / mate→A / squad→#', () => {
    render(<MemberAvatar name="" role="user" />);
    expect(screen.getByText('U').textContent).toBe('U');
    cleanup();
    render(<MemberAvatar name="   " role="mate" />);
    expect(screen.getByText('A').textContent).toBe('A');
    cleanup();
    render(<MemberAvatar name="" role="squad" />);
    expect(screen.getByText('#').textContent).toBe('#');
  });
});

describe('MemberAvatar size 档（regulation 02 §3）', () => {
  it('sm：inline span，14×14 (h-3.5)，无外层列、无名字 label', () => {
    const { container } = render(
      <MemberAvatar name="captain" role="leader" size="sm" showName={false} />,
    );
    const av = screen.getByText('C');
    expect(av.tagName).toBe('SPAN');
    expect(av.className).toContain('h-3.5');
    expect(av.className).toContain('w-3.5');
    expect(container.querySelector('.w-9')).toBeNull();
  });

  it('md（默认）：28×28（h-7）+ 外层 w-9 列 + 名字 label', () => {
    const { container } = render(<MemberAvatar name="alice" role="leader" />);
    const av = screen.getByText('A');
    expect(av.className).toContain('h-7');
    expect(av.className).toContain('w-7');
    expect(container.querySelector('.w-9')).toBeTruthy();
    expect(screen.getByText('alice')).toBeTruthy();
  });

  it('lg：48×48（h-12）+ rounded-lg（regulation 02 §3）', () => {
    render(<MemberAvatar name="captain" role="leader" size="lg" />);
    const av = screen.getByText('C');
    expect(av.className).toContain('h-12');
    expect(av.className).toContain('w-12');
    expect(av.className).toContain('rounded-lg');
  });

  it('xl：64×64（h-16）+ rounded-xl（大头像）', () => {
    render(<MemberAvatar name="captain" role="leader" size="xl" />);
    const av = screen.getByText('C');
    expect(av.className).toContain('h-16');
    expect(av.className).toContain('w-16');
    expect(av.className).toContain('rounded-xl');
  });

  it('showName=false：不渲名字 label', () => {
    render(<MemberAvatar name="captain" role="leader" showName={false} />);
    expect(screen.queryByText('captain')).toBeNull();
  });
});

describe('MemberAvatar presence 点（v0.0.165 新增）', () => {
  it('showPresence=online：右下渲染 presence 点 + 白描边 + presence-online 底', () => {
    render(<MemberAvatar name="alice" role="leader" showPresence="online" />);
    const dot = screen.getByLabelText('presence-online');
    expect(dot.tagName).toBe('SPAN');
    // 10×10 + rounded-full + absolute 定位
    expect(dot.className).toContain('h-2.5');
    expect(dot.className).toContain('w-2.5');
    expect(dot.className).toContain('rounded-full');
    expect(dot.className).toContain('absolute');
    // presence 色 + surface 描边
    expect((dot as HTMLElement).style.background).toBe('var(--presence-online)');
    expect((dot as HTMLElement).style.borderColor).toBe('var(--surface)');
  });

  it('showPresence=busy：presence-busy 底', () => {
    render(<MemberAvatar name="a" role="leader" showPresence="busy" />);
    expect((screen.getByLabelText('presence-busy') as HTMLElement).style.background).toBe('var(--presence-busy)');
  });

  it('showPresence=offline：presence-offline 底', () => {
    render(<MemberAvatar name="a" role="leader" showPresence="offline" />);
    expect((screen.getByLabelText('presence-offline') as HTMLElement).style.background).toBe('var(--presence-offline)');
  });

  it('showPresence=undefined：不渲染 presence 节点（back-compat）', () => {
    render(<MemberAvatar name="a" role="leader" />);
    expect(screen.queryByLabelText('presence-online')).toBeNull();
    expect(screen.queryByLabelText('presence-busy')).toBeNull();
    expect(screen.queryByLabelText('presence-offline')).toBeNull();
  });

  it('size=sm 时忽略 showPresence（顶栏 inline 头像太小）', () => {
    render(<MemberAvatar name="a" role="leader" size="sm" showName={false} showPresence="online" />);
    expect(screen.queryByLabelText('presence-online')).toBeNull();
  });
});
