// @vitest-environment jsdom
/**
 * component-member-roster-list 单测 —— v0.0.288 统一成员列表组件 + v0.0.292 Leader 反色高亮
 * 参考: specs/ui/components/studio-page/component-member-roster-list.md
 *       specs/prd/v0.0.292-squad-home-fixes/PRD.md §D2（Leader 反色重设计）
 *
 * 覆盖：
 *   - showBenched=false → 渲染 running+idle 不渲染 benched 区
 *   - showBenched=true → 渲染三分区（running/idle/benched）
 *   - benched 行灰度 class（opacity-[0.55]+grayscale+text-muted-2）比 idle 行更灰
 *   - hover chat icon + 防套娃（currentMemberId 行不渲染 icon）
 *   - 空态 emptyMembers
 *   - PanelRowView 直接构造 variant 三态验证
 *   - [v0.0.292] Leader 行反色高亮（bg-fg-2 + text-surface + badge 强化 + 覆盖灰度）
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import type { SessionState } from '../../chat-page/types';
import type { PanelRow } from '../squad-status-utils';
import { mkMember } from './_fixtures';
import { MemberRosterList, PanelRowView } from '../component-member-roster-list';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

/** 构造 PanelRow 测试数据 */
function mkRow(over: Partial<PanelRow> & { id?: string }): PanelRow {
  return {
    member: mkMember({ id: over.id ?? 'm1', name: '张三', role: 'mate', ...(over.member ?? {}) }),
    isLeader: over.isLeader ?? false,
    presence: over.presence ?? 'online',
    statusTextSource: over.statusTextSource ?? { kind: 'fallback' },
  };
}

/** 从 DOM button 元素提取 className */
function rowClass(memberId: string): string {
  const el = screen.getByTestId(`squad-status-row-${memberId}`);
  return el.className;
}

describe('MemberRosterList — showBenched 渲染控制', () => {
  it('showBenched=false → 渲染 running+idle，不渲染 benched 区', () => {
    const rows = {
      running: [mkRow({ id: 'r1' })],
      idle: [mkRow({ id: 'i1' })],
      benched: [mkRow({ id: 'b1' })],
    };
    render(
      <MemberRosterList rows={rows} onEnterChat={vi.fn()} showBenched={false} />,
    );
    expect(screen.getByText('running · 1')).toBeTruthy();
    expect(screen.getByText('idle · 1')).toBeTruthy();
    // benched 行不渲染
    expect(screen.queryByText('benched · 1')).toBeNull();
    expect(screen.queryByTestId('squad-status-row-b1')).toBeNull();
  });

  it('showBenched=true → 渲染三分区', () => {
    const rows = {
      running: [mkRow({ id: 'r1' })],
      idle: [mkRow({ id: 'i1' })],
      benched: [mkRow({ id: 'b1' })],
    };
    render(
      <MemberRosterList rows={rows} onEnterChat={vi.fn()} showBenched={true} />,
    );
    expect(screen.getByText('running · 1')).toBeTruthy();
    expect(screen.getByText('idle · 1')).toBeTruthy();
    expect(screen.getByText('benched · 1')).toBeTruthy();
    expect(screen.getByTestId('squad-status-row-b1')).toBeTruthy();
  });

  it('某区无成员 → 不渲染该区标题', () => {
    const rows = {
      running: [mkRow({ id: 'r1' })],
      idle: [],
      benched: [],
    };
    render(
      <MemberRosterList rows={rows} onEnterChat={vi.fn()} showBenched={true} />,
    );
    expect(screen.getByText('running · 1')).toBeTruthy();
    expect(screen.queryByText('idle · 0')).toBeNull();
    expect(screen.queryByText('benched · 0')).toBeNull();
  });

  it('空态 → emptyMembers 文案', () => {
    const rows = { running: [], idle: [], benched: [] };
    const { container } = render(
      <MemberRosterList rows={rows} onEnterChat={vi.fn()} showBenched={true} />,
    );
    // emptyMembers 文案（i18n zh-CN seats.emptyMembers）
    expect(container.textContent).toBeTruthy();
    expect(screen.queryByText(/running|idle|benched/)).toBeNull();
  });
});

describe('MemberRosterList — 行 variant 灰度', () => {
  it('benched 行比 idle 更灰（opacity-[0.55] < opacity-[0.85] + grayscale）', () => {
    const rows = {
      running: [mkRow({ id: 'r1' })],
      idle: [mkRow({ id: 'i1' })],
      benched: [mkRow({ id: 'b1' })],
    };
    render(
      <MemberRosterList rows={rows} onEnterChat={vi.fn()} showBenched={true} />,
    );
    const benchedClass = rowClass('b1');
    const idleClass = rowClass('i1');
    // benched 行根 opacity-[0.55]（比 idle 的 opacity-[0.85] 更低）
    expect(benchedClass).toContain('opacity-[0.55]');
    expect(idleClass).toContain('opacity-[0.85]');
    // benched avatar 有 grayscale
    const benchedBtn = screen.getByTestId('squad-status-row-b1');
    const benchedAvatarWrap = benchedBtn.querySelector('span');
    expect(benchedAvatarWrap?.className).toContain('grayscale');
    // benched title text-muted-2（比 idle 的 text-fg-2 更淡）
    expect(benchedBtn.textContent).toContain('张三');
  });
});

describe('MemberRosterList — 行交互', () => {
  it('点击行 → onEnterChat(memberId)', () => {
    const onEnterChat = vi.fn();
    const rows = {
      running: [mkRow({ id: 'r1' })],
      idle: [],
      benched: [],
    };
    render(
      <MemberRosterList rows={rows} onEnterChat={onEnterChat} showBenched={false} />,
    );
    screen.getByTestId('squad-status-row-r1').click();
    expect(onEnterChat).toHaveBeenCalledWith('r1');
  });

  it('防套娃：currentMemberId 行不渲染 chat icon', () => {
    const rows = {
      running: [mkRow({ id: 'r1' }), mkRow({ id: 'r2' })],
      idle: [],
      benched: [],
    };
    const { container } = render(
      <MemberRosterList
        rows={rows}
        onEnterChat={vi.fn()}
        showBenched={false}
        currentMemberId="r1"
      />,
    );
    // 两行都渲染（行内容保留）
    expect(screen.getByTestId('squad-status-row-r1')).toBeTruthy();
    expect(screen.getByTestId('squad-status-row-r2')).toBeTruthy();
    // r1（防套娃行）的 hover icon span 不渲染——检查 r1 行内有无 aria-hidden 的 chat icon
    const r1Btn = screen.getByTestId('squad-status-row-r1');
    const r2Btn = screen.getByTestId('squad-status-row-r2');
    // r2 有 aria-hidden 的 chat icon span；r1 没有
    const r1Icons = r1Btn.querySelectorAll('[aria-hidden]');
    const r2Icons = r2Btn.querySelectorAll('[aria-hidden]');
    expect(r2Icons.length).toBeGreaterThan(r1Icons.length);
  });
});

describe('PanelRowView — variant 三态直接验证', () => {
  it('variant=running → 行根无 opacity 弱化', () => {
    render(
      <PanelRowView row={mkRow({ id: 'run1' })} onEnterChat={vi.fn()} variant="running" />,
    );
    const cls = rowClass('run1');
    expect(cls).not.toContain('opacity-[0.85]');
    expect(cls).not.toContain('opacity-[0.55]');
  });

  it('variant=idle → 行根 opacity-[0.85]', () => {
    render(
      <PanelRowView row={mkRow({ id: 'idle1' })} onEnterChat={vi.fn()} variant="idle" />,
    );
    expect(rowClass('idle1')).toContain('opacity-[0.85]');
  });

  it('variant=benched → 行根 opacity-[0.55] + avatar grayscale', () => {
    render(
      <PanelRowView row={mkRow({ id: 'bench1' })} onEnterChat={vi.fn()} variant="benched" />,
    );
    expect(rowClass('bench1')).toContain('opacity-[0.55]');
    const btn = screen.getByTestId('squad-status-row-bench1');
    const avatarWrap = btn.querySelector('span');
    expect(avatarWrap?.className).toContain('grayscale');
    expect(avatarWrap?.className).toContain('opacity-50');
  });
});

describe('PanelRowView — Leader 行反色高亮（v0.0.292）', () => {
  it('Leader 行 className 含 bg-fg-2 + hover:bg-fg-2/90（同 user 气泡色系，恒显）', () => {
    const row = mkRow({ id: 'lead1', isLeader: true, member: mkMember({ id: 'lead1', name: 'Rocky', role: 'leader' }) });
    render(<PanelRowView row={row} onEnterChat={vi.fn()} variant="running" />);
    const cls = rowClass('lead1');
    expect(cls).toContain('bg-fg-2');
    expect(cls).toContain('hover:bg-fg-2/90');
    // 不含 mate 专属 hover:bg-surface-2
    expect(cls).not.toContain('hover:bg-surface-2');
  });

  it('Leader 行名字 className 含 text-surface（反色白字）', () => {
    const row = mkRow({ id: 'lead1', isLeader: true, member: mkMember({ id: 'lead1', name: 'Rocky', role: 'leader' }) });
    const { container } = render(<PanelRowView row={row} onEnterChat={vi.fn()} variant="running" />);
    const btn = container.querySelector('[data-testid="squad-status-row-lead1"]');
    const nameSpan = btn?.querySelector('.text-surface');
    expect(nameSpan).toBeTruthy();
    expect(nameSpan?.textContent).toContain('Rocky');
  });

  it('Leader badge 强化：text-[10.5px] + font-semibold + bg-white/15 + text-white/80', () => {
    const row = mkRow({ id: 'lead1', isLeader: true, member: mkMember({ id: 'lead1', name: 'Rocky', role: 'leader' }) });
    const { container } = render(<PanelRowView row={row} onEnterChat={vi.fn()} variant="running" />);
    const btn = container.querySelector('[data-testid="squad-status-row-lead1"]');
    const badge = btn?.querySelector('.font-mono');
    expect(badge?.className).toContain('text-[10.5px]');
    expect(badge?.className).toContain('font-semibold');
    expect(badge?.className).toContain('bg-white/15');
    expect(badge?.className).toContain('text-white/80');
  });

  it('Leader 行覆盖 idle 灰度（variant=idle 仍反色 bg-fg-2，不含 opacity-[0.85]）', () => {
    const row = mkRow({ id: 'lead1', isLeader: true, member: mkMember({ id: 'lead1', name: 'Rocky', role: 'leader' }) });
    render(<PanelRowView row={row} onEnterChat={vi.fn()} variant="idle" />);
    const cls = rowClass('lead1');
    expect(cls).toContain('bg-fg-2');
    expect(cls).not.toContain('opacity-[0.85]');
  });

  it('Leader 行覆盖 benched 灰度（variant=benched 仍反色 bg-fg-2，不含 opacity-[0.55]）', () => {
    const row = mkRow({ id: 'lead1', isLeader: true, member: mkMember({ id: 'lead1', name: 'Rocky', role: 'leader' }) });
    render(<PanelRowView row={row} onEnterChat={vi.fn()} variant="benched" />);
    const cls = rowClass('lead1');
    expect(cls).toContain('bg-fg-2');
    expect(cls).not.toContain('opacity-[0.55]');
  });

  it('Leader 行 hover chat icon 用 text-white/70', () => {
    const row = mkRow({ id: 'lead1', isLeader: true, member: mkMember({ id: 'lead1', name: 'Rocky', role: 'leader' }) });
    const { container } = render(<PanelRowView row={row} onEnterChat={vi.fn()} variant="running" />);
    const btn = container.querySelector('[data-testid="squad-status-row-lead1"]');
    // chat icon span = 有 aria-hidden 且含 opacity-0（hover icon 的特征）；排除 SpinnerRing
    const chatIcon = Array.from(btn?.querySelectorAll('[aria-hidden]') ?? []).find((el) =>
      el.className.includes('opacity-0') && el.className.includes('text-white'),
    );
    expect(chatIcon).toBeTruthy();
    expect(chatIcon?.className).toContain('text-white/70');
  });

  it('Leader 行 presence 文字用 text-white/60', () => {
    const row = mkRow({ id: 'lead1', isLeader: true, member: mkMember({ id: 'lead1', name: 'Rocky', role: 'leader' }) });
    const { container } = render(<PanelRowView row={row} onEnterChat={vi.fn()} variant="running" />);
    const btn = container.querySelector('[data-testid="squad-status-row-lead1"]');
    const presenceSpan = btn?.querySelector('.text-white\\/60');
    expect(presenceSpan).toBeTruthy();
  });

  it('Mate 行不反色（不含 bg-fg-2，含 hover:bg-surface-2）', () => {
    const row = mkRow({ id: 'm1', isLeader: false });
    render(<PanelRowView row={row} onEnterChat={vi.fn()} variant="running" />);
    const cls = rowClass('m1');
    expect(cls).not.toContain('bg-fg-2');
    expect(cls).toContain('hover:bg-surface-2');
  });

  it('Mate badge 不含 leader 强化样式（text-[10px] + 无 font-semibold + 无 bg-white/15）', () => {
    const row = mkRow({ id: 'm1', isLeader: false });
    const { container } = render(<PanelRowView row={row} onEnterChat={vi.fn()} variant="running" />);
    const btn = container.querySelector('[data-testid="squad-status-row-m1"]');
    const badge = btn?.querySelector('.font-mono');
    expect(badge?.className).toContain('text-[10px]');
    expect(badge?.className).not.toContain('font-semibold');
    expect(badge?.className).not.toContain('bg-white/15');
  });
});
