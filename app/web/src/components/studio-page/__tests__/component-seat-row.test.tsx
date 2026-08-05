/**
 * @vitest-environment jsdom
 * SeatRowView 单测 —— v0.0.170 新增（mate 坐席行，C 紧凑指挥台 roster 行列表）
 * 参考: specs/ui/components/studio-page/component-seat-row.md v1.0
 *
 * ops hover 揭示只断 class/存在性，不断 visibility（jsdom 无布局，opacity 计算不可信）。
 * 定位策略：产品代码 data-testid 已移除，改语义/结构定位（行根 = container 首子；avatar = 首字母 span；
 *   status 列 = 状态文案的父容器；enter/more/menu 按 role+文案；spinner = .animate-spin）。
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { SeatRowView } from '../component-seat-row';
import { mkMember } from './_fixtures';
import type { SeatRow } from '../use-seats-data';

beforeAll(async () => {
  await initI18n('zh-CN');
});
afterEach(() => cleanup());

function mkRow(over: Partial<SeatRow> = {}): SeatRow {
  const member = over.member ?? mkMember({ id: 'm1', name: '张三', role: 'mate', state: 'deployed' });
  return {
    member,
    isLeader: over.isLeader ?? false,
    presence: over.presence ?? 'online',
    isRunning: over.isRunning ?? false,
    statusTextSource: over.statusTextSource ?? { kind: 'fallback' },
  };
}

// —— 语义/结构定位辅助 —— //
/** 行根（SeatRowView 根 div = container 首子） */
const rowRoot = (container: HTMLElement) => container.firstElementChild as HTMLElement;
/** avatar 色块（首字母 span，md 尺寸 h-7 w-7） */
const avatarBox = () => screen.getByText('张');
/** status 列（状态文案 span 的父容器） */
const statusColOf = (text: string) => screen.getByText(text).parentElement as HTMLElement;
/** enter 按钮（文案「进入对话」） */
const enterBtn = () => screen.getByRole('button', { name: '进入对话' });
/** more 按钮（aria-label「更多」） */
const moreBtn = () => screen.getByRole('button', { name: '更多' }) as HTMLButtonElement;
/** running spinner（.animate-spin） */
const spinner = (container: HTMLElement) => container.querySelector('.animate-spin');

describe('SeatRowView — 行结构 + 子元素族', () => {
  it('渲染行根 + avatar/status/enter/more 全族', () => {
    const { container } = render(<SeatRowView row={mkRow()} onEnter={() => {}} />);
    expect(rowRoot(container)).toBeTruthy();
    expect(avatarBox()).toBeTruthy();
    expect(statusColOf('在线待命')).toBeTruthy();
    expect(enterBtn()).toBeTruthy();
    expect(moreBtn()).toBeTruthy();
  });

  it('无 leader badge（leader 不在 mates）', () => {
    render(<SeatRowView row={mkRow()} onEnter={() => {}} />);
    expect(screen.queryByText('LEADER')).toBeNull();
  });

  it('avatar 用 md 尺寸档（28px）+ presence 点', () => {
    render(<SeatRowView row={mkRow({ presence: 'busy' })} onEnter={() => {}} />);
    const avatar = avatarBox();
    expect(avatar.className).toContain('h-7');
    expect(avatar.className).toContain('w-7');
    // presence 点（MemberAvatar 右下覆盖）
    expect(screen.getByLabelText('presence-busy')).toBeTruthy();
  });

  it('who 列 = 名 + `role · state` meta（11.5px muted-2）', () => {
    const m = mkMember({ id: 'm1', name: '张三', role: 'mate', state: 'deployed' });
    const { container } = render(<SeatRowView row={mkRow({ member: m })} onEnter={() => {}} />);
    const row = rowRoot(container);
    expect(row.textContent).toContain('张三');
    expect(row.textContent).toContain('mate · deployed');
  });

  it('status 列 = 脉冲点 + statusText 单行 truncate；currentWork 优先', () => {
    render(
      <SeatRowView
        row={mkRow({ statusTextSource: { kind: 'currentWork', text: 'T-0009 综述' } })}
        onEnter={() => {}}
      />,
    );
    const status = statusColOf('T-0009 综述');
    expect(status.textContent).toContain('T-0009 综述');
    expect(status.querySelector('span.truncate')).toBeTruthy();
    expect(status.querySelector('span.rounded-full')).toBeTruthy();
  });

  it('fallback 时 statusText 走 i18n 且弱化（text-muted-2）；currentWork 时 text-fg-3', () => {
    const { rerender } = render(<SeatRowView row={mkRow({ presence: 'online' })} onEnter={() => {}} />);
    const status = statusColOf('在线待命');
    expect(status.textContent).toContain('在线待命');
    expect(status.className).toContain('text-muted-2');
    rerender(
      <SeatRowView
        row={mkRow({ statusTextSource: { kind: 'currentWork', text: '干活中' } })}
        onEnter={() => {}}
      />,
    );
    expect(statusColOf('干活中').className).toContain('text-fg-3');
  });
});

describe('SeatRowView — ops 列布局稳定（恒渲染只变 opacity）', () => {
  it('ops 列恒渲染：enter/more 按钮始终存在于 DOM', () => {
    render(<SeatRowView row={mkRow()} onEnter={() => {}} onEdit={() => {}} />);
    // 无 hover 状态下按钮已在 DOM（不断 visibility，只断存在性 + class）
    expect(enterBtn()).toBeTruthy();
    expect(moreBtn()).toBeTruthy();
  });

  it('ops 容器 class = opacity-0 + group-hover:opacity-100 + focus-within:opacity-100 + transition-opacity', () => {
    render(<SeatRowView row={mkRow()} onEnter={() => {}} />);
    const ops = enterBtn().parentElement!;
    expect(ops.className).toContain('opacity-0');
    expect(ops.className).toContain('group-hover:opacity-100');
    expect(ops.className).toContain('focus-within:opacity-100');
    expect(ops.className).toContain('transition-opacity');
  });

  it('行根有 group class + hover:bg-bg；无整行 onClick（交互只走按钮）', () => {
    const onEnter = vi.fn();
    const { container } = render(<SeatRowView row={mkRow()} onEnter={onEnter} />);
    const row = rowRoot(container);
    expect(row.className).toContain('group');
    expect(row.className).toContain('hover:bg-bg');
    // 点行根空白处不触发 enter
    fireEvent.click(row);
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('行分隔：border-b border-surface-2 + last:border-b-0（末行无分隔）', () => {
    const { container } = render(<SeatRowView row={mkRow()} onEnter={() => {}} />);
    const row = rowRoot(container);
    expect(row.className).toContain('border-b');
    expect(row.className).toContain('border-surface-2');
    expect(row.className).toContain('last:border-b-0');
  });
});

describe('SeatRowView — offline 降级', () => {
  it('offline → 根 opacity-75 + enter 降 secondary 型（白底灰边）', () => {
    const { container } = render(<SeatRowView row={mkRow({ presence: 'offline' })} onEnter={() => {}} />);
    expect(rowRoot(container).className).toContain('opacity-75');
    const btn = enterBtn();
    expect(btn.className).toContain('border');
    expect(btn.className).toContain('bg-surface');
    expect(btn.className).toContain('text-fg-3');
    expect(btn.getAttribute('style')).toBeNull();
  });

  it('online/busy → 无 opacity 降级 + enter solid（--btn-primary-bg）', () => {
    const { container } = render(<SeatRowView row={mkRow({ presence: 'busy' })} onEnter={() => {}} />);
    expect(rowRoot(container).className).not.toContain('opacity-75');
    expect(enterBtn().getAttribute('style')).toContain('var(--btn-primary-bg)');
  });
});

describe('SeatRowView — 回调 + 菜单', () => {
  it('点 enter → onEnter 回调', () => {
    const onEnter = vi.fn();
    render(<SeatRowView row={mkRow()} onEnter={onEnter} />);
    fireEvent.click(enterBtn());
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('mate deployed + 三 handler 全传 → 菜单渲染「编辑」+「bench」，无 deploy', () => {
    const m = mkMember({ id: 'm1', state: 'deployed', role: 'mate' });
    render(<SeatRowView row={mkRow({ member: m })} onEnter={() => {}} onEdit={() => {}} onBench={() => {}} onDeploy={() => {}} />);
    fireEvent.click(moreBtn());
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '编辑' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '下岗（bench）' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '复岗（deploy）' })).toBeNull();
  });

  it('mate benched + 三 handler 全传 → 菜单渲染「编辑」+「deploy」，无 bench', () => {
    const m = mkMember({ id: 'm3', state: 'benched', role: 'mate' });
    render(<SeatRowView row={mkRow({ member: m })} onEnter={() => {}} onEdit={() => {}} onBench={() => {}} onDeploy={() => {}} />);
    fireEvent.click(moreBtn());
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '编辑' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '复岗（deploy）' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '下岗（bench）' })).toBeNull();
  });

  it('点菜单项 → 回调 + 菜单关闭；菜单 portal body 直下', () => {
    const onBench = vi.fn();
    const m = mkMember({ id: 'm1', state: 'deployed', role: 'mate' });
    render(<SeatRowView row={mkRow({ member: m })} onEnter={() => {}} onBench={onBench} />);
    fireEvent.click(moreBtn());
    const menu = screen.getByRole('menu');
    expect(menu.parentElement).toBe(document.body);
    fireEvent.click(screen.getByRole('menuitem', { name: '下岗（bench）' }));
    expect(onBench).toHaveBeenCalledWith(m);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('三 handler 全未传 → 更多按钮 disabled', () => {
    render(<SeatRowView row={mkRow()} onEnter={() => {}} />);
    expect(moreBtn().disabled).toBe(true);
  });
});

describe('SeatRowView — onContextMenu（右键上抛）', () => {
  it('传 onContextMenu → 右键行根上抛 (sessionId, clientX, clientY)', () => {
    const onContextMenu = vi.fn();
    const m = mkMember({ id: 'm1', sessionId: 'sess-a', state: 'deployed', role: 'mate' });
    const { container } = render(<SeatRowView row={mkRow({ member: m })} onEnter={() => {}} onContextMenu={onContextMenu} />);
    fireEvent.contextMenu(rowRoot(container), { clientX: 88, clientY: 99 });
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu).toHaveBeenCalledWith('sess-a', 88, 99);
  });

  it('缺省 onContextMenu → 右键不上抛（jsdom 下无异常）', () => {
    const { container } = render(<SeatRowView row={mkRow()} onEnter={() => {}} />);
    expect(() =>
      fireEvent.contextMenu(rowRoot(container), { clientX: 1, clientY: 2 }),
    ).not.toThrow();
  });
});

describe('SeatRowView — INV-3 静态脉冲点', () => {
  it('脉冲点无 animate-* class，颜色走 var(--presence-*)', () => {
    render(<SeatRowView row={mkRow({ presence: 'busy' })} onEnter={() => {}} />);
    const status = statusColOf('推理中…');
    const pulse = status.querySelector('span.rounded-full');
    expect(pulse).toBeTruthy();
    expect(pulse?.className).not.toContain('animate-');
    expect(pulse?.getAttribute('style')).toContain('var(--presence-busy)');
  });
});

describe('SeatRowView — running spinner（名字后）', () => {
  it('row.isRunning=true → 渲染 spinner（10×10 + animate-spin）', () => {
    const { container } = render(<SeatRowView row={mkRow({ isRunning: true })} onEnter={() => {}} />);
    const sp = spinner(container);
    expect(sp).toBeTruthy();
    // SpinnerRing size=sm → 10×10 px
    expect(sp?.getAttribute('style')).toContain('width: 10px');
    expect(sp?.getAttribute('style')).toContain('height: 10px');
    // animate-spin 由 SpinnerRing 提供（INV-3 例外：spinner 例外允许 animate-spin）
    expect(sp?.className).toContain('animate-spin');
    expect(sp?.className).toContain('shrink-0');
  });

  it('row.isRunning=false → 不渲染 spinner', () => {
    const { container } = render(<SeatRowView row={mkRow({ isRunning: false })} onEnter={() => {}} />);
    expect(spinner(container)).toBeNull();
  });

  it('spinner 挂在名字 span 后（兄弟节点），名字仍 truncate', () => {
    const { container } = render(<SeatRowView row={mkRow({ isRunning: true })} onEnter={() => {}} />);
    const sp = spinner(container)!;
    // 名字 span（含 text-fg + truncate class）
    const nameSpan = sp.parentElement?.querySelector('span.truncate');
    expect(nameSpan).toBeTruthy();
    expect(nameSpan?.textContent).toBe('张三');
    // 名字 span 在 spinner 之前（顺序：名 → spinner）
    const siblings = sp.parentElement?.children;
    expect(siblings).toBeTruthy();
    expect(siblings!.length).toBeGreaterThanOrEqual(2);
    expect(siblings![0]).toBe(nameSpan);
    expect(Array.from(siblings!).indexOf(sp)).toBeGreaterThan(0);
  });
});
