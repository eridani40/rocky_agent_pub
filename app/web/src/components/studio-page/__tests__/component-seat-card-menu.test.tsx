/**
 * @vitest-environment jsdom
 * SeatCardMenu 单测 —— 菜单 flip-up 翻转判定 + 弹层定位渲染
 * 参考: specs/ui/components/studio-page/component-seat-card-menu.md v1.2
 *       specs/ui/components/studio-page/component-seat-card.md v1.3
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { SeatCard } from '../component-seat-card';
import { deriveMenuOpenUp, estimateMenuHeight } from '../component-seat-card-menu';
import { mkMember } from './_fixtures';
import type { SeatRow } from '../use-seats-data';

beforeAll(async () => {
  await initI18n('zh-CN');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mkRow(over: Partial<SeatRow> = {}): SeatRow {
  const member = over.member ?? mkMember({ id: 'm1', name: '张三', role: 'mate', state: 'deployed' });
  return {
    member,
    isLeader: over.isLeader ?? (member.role === 'leader'),
    presence: over.presence ?? 'online',
    isRunning: over.isRunning ?? false,
    statusTextSource: over.statusTextSource ?? { kind: 'fallback' },
  };
}

describe('estimateMenuHeight —— 菜单高度估算（每项 29px + 容器 py-1 共 8px，封顶 95px）', () => {
  it('1 项 → 29 + 8 = 37px', () => {
    expect(estimateMenuHeight(1)).toBe(37);
  });
  it('2 项 → 58 + 8 = 66px', () => {
    expect(estimateMenuHeight(2)).toBe(66);
  });
  it('3 项 → 87 + 8 = 95px（恰达封顶）', () => {
    expect(estimateMenuHeight(3)).toBe(95);
  });
  it('4 项及以上 → 封顶 95px（菜单项至多 3 个，防估算漂移）', () => {
    expect(estimateMenuHeight(4)).toBe(95);
    expect(estimateMenuHeight(10)).toBe(95);
  });
  it('0 项 → 仅容器 8px', () => {
    expect(estimateMenuHeight(0)).toBe(8);
  });
});

describe('deriveMenuOpenUp —— flip-up 翻转判定（按钮底 + 4 + 估算高 > 视口高 - 8 → 向上展开）', () => {
  it('视口中部按钮：底部空间充足 → openUp=false（向下展开）', () => {
    // 100 + 4 + 66 = 170 < 800 - 8
    expect(deriveMenuOpenUp(100, 2, 800)).toBe(false);
  });
  it('视口底部按钮：底部空间不足 → openUp=true（向上展开）', () => {
    // 760 + 4 + 66 = 830 > 800 - 8
    expect(deriveMenuOpenUp(760, 2, 800)).toBe(true);
  });
  it('边界：恰贴视口底余量（不超出）→ openUp=false', () => {
    // 722 + 4 + 66 = 792 = 800 - 8，非严格大于 → 不翻转
    expect(deriveMenuOpenUp(722, 2, 800)).toBe(false);
  });
  it('边界：超出余量 1px → openUp=true', () => {
    // 723 + 4 + 66 = 793 > 792
    expect(deriveMenuOpenUp(723, 2, 800)).toBe(true);
  });
  it('项数越多估算越高，翻转门槛随之提前', () => {
    // 3 项 95px：701 + 4 + 95 = 800 > 792 → 翻转；同位置 1 项 37px 不翻转
    expect(deriveMenuOpenUp(701, 3, 800)).toBe(true);
    expect(deriveMenuOpenUp(701, 1, 800)).toBe(false);
  });
});

describe('SeatCardMenu —— 弹层定位渲染（父级 openMenu 计算 anchor + openUp）', () => {
  /** mock 触发按钮 rect 到指定位置 */
  function mockRect(rect: Partial<DOMRect>): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: 32, height: 32,
      top: 0, right: 32, bottom: 32, left: 0,
      ...rect,
    } as DOMRect);
  }

  it('底部空间充足 → 向下展开：top = 按钮底 + 4，transform 仅左移 100%', () => {
    mockRect({ top: 100, bottom: 132, right: 400 });
    const m = mkMember({ id: 'm1', state: 'deployed', role: 'mate' });
    render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} onEdit={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    const menu = screen.getByRole('menu') as HTMLElement;
    expect(menu.style.top).toBe('136px'); // 132 + 4
    expect(menu.style.left).toBe('400px');
    expect(menu.style.transform).toBe('translateX(-100%)');
  });

  it('视口底部按钮 → flip-up 向上展开：top = 按钮顶 - 4，transform 左移 + 上移 100%', () => {
    // 视口高 768（jsdom 缺省）：1 项估算 37px，740 + 4 + 37 = 781 > 760 → 翻转
    mockRect({ top: 708, bottom: 740, right: 400 });
    const m = mkMember({ id: 'm1', state: 'deployed', role: 'mate' });
    render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} onEdit={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    const menu = screen.getByRole('menu') as HTMLElement;
    expect(menu.style.top).toBe('704px'); // 708 - 4
    expect(menu.style.left).toBe('400px');
    expect(menu.style.transform).toBe('translate(-100%, -100%)');
  });

  it('菜单项数按 avail 计数参与翻转判定（mate deployed + edit/bench = 2 项）', () => {
    // 2 项估算 66px：700 + 4 + 66 = 770 > 760 → 翻转；若误按 1 项算（37px）则不翻转
    mockRect({ top: 668, bottom: 700, right: 400 });
    const m = mkMember({ id: 'm1', state: 'deployed', role: 'mate' });
    render(
      <SeatCard row={mkRow({ member: m })} onEnter={() => {}} onEdit={() => {}} onBench={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    const menu = screen.getByRole('menu') as HTMLElement;
    expect(menu.style.transform).toBe('translate(-100%, -100%)');
  });
});
