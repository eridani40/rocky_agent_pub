/**
 * @vitest-environment jsdom
 * SeatCard 单测 —— v0.0.170 修订（重写为队长 mini 卡，C 紧凑指挥台左列）
 * 参考: specs/ui/components/studio-page/component-seat-card.md v1.4
 *       memory: dropdown-close-listener-defer-register（setTimeout 0 延迟挂关闭监听）
 *
 * 菜单行为断言不缩水（机械只换宿主 use-seat-menu，从卡片内部 state 抽出）：
 *   三 handler 组合 / portal body / 延迟监听 / 卸载清理 全保留。
 * 定位策略：产品代码 data-testid 已移除，改语义/结构定位（卡根 = container 首子；badge = 「LEADER」文案；
 *   status 行 = 状态文案的父容器；enter/groupchat/more/menu 按 role+文案；spinner = .animate-spin）。
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { SeatCard } from '../component-seat-card';
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
    isLeader: over.isLeader ?? (member.role === 'leader'),
    presence: over.presence ?? 'online',
    isRunning: over.isRunning ?? false,
    statusTextSource: over.statusTextSource ?? { kind: 'fallback' },
  };
}

// —— 语义/结构定位辅助 —— //
/** 卡根（SeatCard 根 div = container 首子） */
const cardRoot = (container: HTMLElement) => container.firstElementChild as HTMLElement;
/** status/meta 行（状态文案 span 的父容器；文案 = `${statusText} · ${state}`） */
const statusRowOf = (re: RegExp) => screen.getByText(re).parentElement as HTMLElement;
/** enter 按钮（文案「进入对话」） */
const enterBtn = () => screen.getByRole('button', { name: '进入对话' });
/** 群聊按钮（文案「群聊」） */
const groupChatBtn = () => screen.getByRole('button', { name: '群聊' });
/** more 按钮（aria-label「更多」） */
const moreBtn = () => screen.getByRole('button', { name: '更多' }) as HTMLButtonElement;
/** running spinner（.animate-spin） */
const spinner = (container: HTMLElement) => container.querySelector('.animate-spin');

describe('SeatCard — mini 卡结构（v0.0.170）', () => {
  it('渲染卡根 + seclabel「队长」+ 名字', () => {
    const leader = mkMember({ id: 'lead1', name: 'Rocky', role: 'leader' });
    const { container } = render(<SeatCard row={mkRow({ member: leader, isLeader: true })} onEnter={() => {}} />);
    const card = cardRoot(container);
    expect(card.textContent).toContain('队长');
    expect(card.textContent).toContain('Rocky');
  });

  it('白卡基线：rounded-xl + border-border + bg-surface；无旧强 highlight（border-t-2/shadow-sm/border-strong 全废）', () => {
    const leader = mkMember({ id: 'lead1', name: 'Rocky', role: 'leader' });
    const { container } = render(<SeatCard row={mkRow({ member: leader, isLeader: true })} onEnter={() => {}} />);
    const card = cardRoot(container);
    expect(card.className).toContain('rounded-xl');
    expect(card.className).toContain('border-border');
    expect(card.className).toContain('bg-surface');
    // 旧 leader 强 highlight 全废
    expect(card.className).not.toContain('border-t-2');
    expect(card.className).not.toContain('shadow-sm');
    expect(card.className).not.toContain('border-strong');
  });

  it('leader 行内 amber badge（名后 inline；旧描边形式废）', () => {
    const leader = mkMember({ id: 'lead1', name: 'Rocky', role: 'leader' });
    render(<SeatCard row={mkRow({ member: leader, isLeader: true })} onEnter={() => {}} />);
    const badge = screen.getByText('LEADER');
    expect(badge.textContent).toContain('LEADER');
    expect(badge.getAttribute('style')).toContain('var(--hue-amber-bg)');
    expect(badge.getAttribute('style')).toContain('var(--hue-amber)');
  });

  it('无 leader → 无 badge', () => {
    render(<SeatCard row={mkRow()} onEnter={() => {}} />);
    expect(screen.queryByText('LEADER')).toBeNull();
  });

  it('avatar 用 lg 尺寸档（48px）', () => {
    render(<SeatCard row={mkRow()} onEnter={() => {}} />);
    // avatar 色块 = 首字母 span（张三 → 张），lg 档 h-12 w-12
    const avatar = screen.getByText('张');
    expect(avatar.className).toContain('h-12');
    expect(avatar.className).toContain('w-12');
  });

  it('meta 行 = status 容器：脉冲点 + statusText · state 单行 truncate', () => {
    const m = mkMember({ id: 'm1', role: 'mate', state: 'deployed' });
    render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} />);
    const status = statusRowOf(/在线待命/);
    expect(status.textContent).toContain('deployed');
    const text = status.querySelector('span.truncate')!;
    expect(text).toBeTruthy();
    expect(status.querySelector('span.rounded-full')).toBeTruthy();
  });

  it('enter 按钮 flex-1 solid（--btn-primary-bg）', () => {
    render(<SeatCard row={mkRow()} onEnter={() => {}} />);
    const btn = enterBtn();
    expect(btn.className).toContain('flex-1');
    expect(btn.getAttribute('style')).toContain('var(--btn-primary-bg)');
  });
});

describe('SeatCard — presence 三态视觉降级', () => {
  it('online：无 opacity 降级', () => {
    const { container } = render(<SeatCard row={mkRow({ presence: 'online' })} onEnter={() => {}} />);
    expect(cardRoot(container).className).not.toContain('opacity-75');
  });
  it('busy：无 opacity 降级', () => {
    const { container } = render(<SeatCard row={mkRow({ presence: 'busy' })} onEnter={() => {}} />);
    expect(cardRoot(container).className).not.toContain('opacity-75');
  });
  it('offline：opacity-75 整卡 + enter 按钮降 secondary 型', () => {
    const { container } = render(<SeatCard row={mkRow({ presence: 'offline' })} onEnter={() => {}} />);
    expect(cardRoot(container).className).toContain('opacity-75');
    const btn = enterBtn();
    expect(btn.className).toContain('border');
    expect(btn.className).toContain('bg-surface');
    expect(btn.className).toContain('text-fg-3');
    expect(btn.getAttribute('style')).toBeNull();
  });
});

describe('SeatCard — 状态文案 / enter 回调', () => {
  it('currentWork.text 有值 → 直接展示', () => {
    render(
      <SeatCard
        row={mkRow({ statusTextSource: { kind: 'currentWork', text: '正在推进 KR' } })}
        onEnter={() => {}}
      />,
    );
    expect(statusRowOf(/正在推进 KR/).textContent).toContain('正在推进 KR');
  });
  it('fallback + presence=online → 「在线待命」（i18n）', () => {
    render(<SeatCard row={mkRow({ presence: 'online' })} onEnter={() => {}} />);
    expect(statusRowOf(/在线待命/).textContent).toContain('在线待命');
  });
  it('onEnter 触发 → 回调收到调用', () => {
    const onEnter = vi.fn();
    render(<SeatCard row={mkRow()} onEnter={onEnter} />);
    fireEvent.click(enterBtn());
    expect(onEnter).toHaveBeenCalledTimes(1);
  });
});

describe('SeatCard — 更多按钮 disabled 门槛（无菜单动作可用）', () => {
  it('三 handler 全未传 → 更多按钮 disabled', () => {
    render(<SeatCard row={mkRow()} onEnter={() => {}} />);
    expect(moreBtn().disabled).toBe(true);
  });

  it('mate benched + 只传 onEdit → 更多按钮可点（有 edit 一项也算可用）', () => {
    const m = mkMember({ id: 'm3', state: 'benched', role: 'mate' });
    render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} onEdit={() => {}} />);
    expect(moreBtn().disabled).toBe(false);
  });
});

describe('SeatCard — 菜单弹层 + 菜单项按 role/state 组合渲染', () => {
  it('mate + deployed + 三 handler 全传 → 菜单渲染「编辑」+「bench」，无 deploy', () => {
    const m = mkMember({ id: 'm1', state: 'deployed', role: 'mate' });
    render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} onEdit={() => {}} onBench={() => {}} onDeploy={() => {}} />);
    fireEvent.click(moreBtn());
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '编辑' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '下岗（bench）' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '复岗（deploy）' })).toBeNull();
  });

  it('菜单 portal 到 document.body 直下（脱离卡片祖先 transform 劫持）', () => {
    const m = mkMember({ id: 'm1', state: 'deployed', role: 'mate' });
    const { container } = render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} onEdit={() => {}} />);
    fireEvent.click(moreBtn());
    const menu = screen.getByRole('menu');
    expect(menu.parentElement).toBe(document.body);
    // 菜单不在卡片 DOM 子树内（portal 脱离）
    expect(cardRoot(container).contains(menu)).toBe(false);
  });

  it('mate + benched + 三 handler 全传 → 菜单渲染「编辑」+「deploy」，无 bench', () => {
    const m = mkMember({ id: 'm3', state: 'benched', role: 'mate', benchReason: '临时' });
    render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} onEdit={() => {}} onBench={() => {}} onDeploy={() => {}} />);
    fireEvent.click(moreBtn());
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '编辑' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '复岗（deploy）' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '下岗（bench）' })).toBeNull();
  });

  it('leader + deployed → 菜单**无 bench 项**（硬规则，UI 双层拒），有编辑', () => {
    const leader = mkMember({ id: 'lead1', name: 'Rocky', role: 'leader', state: 'deployed' });
    render(<SeatCard
      row={mkRow({ member: leader, isLeader: true })}
      onEnter={() => {}}
      onEdit={() => {}}
      onBench={() => {}}  // 即使传了 bench handler，leader 菜单也不渲染 bench 项
      onDeploy={() => {}}
    />);
    fireEvent.click(moreBtn());
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '编辑' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '下岗（bench）' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '复岗（deploy）' })).toBeNull();
  });

  it('点菜单「编辑」→ onEdit(member) + 菜单关闭', () => {
    const onEdit = vi.fn();
    const m = mkMember({ id: 'm1', state: 'deployed', role: 'mate' });
    render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} onEdit={onEdit} onBench={() => {}} />);
    fireEvent.click(moreBtn());
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑' }));
    expect(onEdit).toHaveBeenCalledWith(m);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('点菜单「bench」→ onBench(member) + 菜单关闭', () => {
    const onBench = vi.fn();
    const m = mkMember({ id: 'm1', state: 'deployed', role: 'mate' });
    render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} onBench={onBench} />);
    fireEvent.click(moreBtn());
    fireEvent.click(screen.getByRole('menuitem', { name: '下岗（bench）' }));
    expect(onBench).toHaveBeenCalledWith(m);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('点菜单「deploy」→ onDeploy(memberId) + 菜单关闭', () => {
    const onDeploy = vi.fn();
    const m = mkMember({ id: 'm3', state: 'benched', role: 'mate' });
    render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} onDeploy={onDeploy} />);
    fireEvent.click(moreBtn());
    fireEvent.click(screen.getByRole('menuitem', { name: '复岗（deploy）' }));
    expect(onDeploy).toHaveBeenCalledWith('m3');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('SeatCard — 菜单关闭监听（setTimeout 0 延迟注册）', () => {
  it('打开菜单的同一次 click 冒泡到 window 时监听未挂 → 菜单不被误关（延迟注册防同次冒泡关闭 bug）', () => {
    vi.useFakeTimers();
    try {
      const m = mkMember({ id: 'm1', state: 'deployed', role: 'mate' });
      render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} onEdit={() => {}} />);
      fireEvent.click(moreBtn());
      expect(screen.getByRole('menu')).toBeTruthy();
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(screen.getByRole('menu')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('setTimeout tick 之后 → window click 触发菜单关闭', () => {
    vi.useFakeTimers();
    try {
      const m = mkMember({ id: 'm1', state: 'deployed', role: 'mate' });
      render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} onEdit={() => {}} />);
      fireEvent.click(moreBtn());
      expect(screen.getByRole('menu')).toBeTruthy();
      act(() => {
        vi.runAllTimers();
        window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('portal 后：点菜单容器（非菜单项）→ stopPropagation 阻止 window 关闭；菜单保持开', () => {
    vi.useFakeTimers();
    try {
      const m = mkMember({ id: 'm1', state: 'deployed', role: 'mate' });
      render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} onEdit={() => {}} />);
      fireEvent.click(moreBtn());
      const menu = screen.getByRole('menu');
      act(() => { vi.runAllTimers(); });
      act(() => { fireEvent.click(menu); });
      expect(screen.queryByRole('menu')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('portal 后：点菜单项 → 回调 + 菜单关闭（onClose 与 window listener 幂等）', () => {
    vi.useFakeTimers();
    try {
      const onEdit = vi.fn();
      const m = mkMember({ id: 'm1', state: 'deployed', role: 'mate' });
      render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} onEdit={onEdit} />);
      fireEvent.click(moreBtn());
      act(() => { vi.runAllTimers(); });
      act(() => { fireEvent.click(screen.getByRole('menuitem', { name: '编辑' })); });
      expect(onEdit).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('卸载组件 → 菜单从 body 清理干净（无 DOM 泄漏）', () => {
    const m = mkMember({ id: 'm1', state: 'deployed', role: 'mate' });
    const { unmount } = render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} onEdit={() => {}} />);
    fireEvent.click(moreBtn());
    expect(screen.getByRole('menu')).toBeTruthy();
    unmount();
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });
});

describe('SeatCard — onContextMenu（右键上抛复制 Session ID）', () => {
  it('传 onContextMenu → 右键触发上抛 (sessionId, clientX, clientY) + preventDefault', () => {
    const onContextMenu = vi.fn();
    const m = mkMember({ id: 'm1', sessionId: 'sess-a', state: 'deployed', role: 'mate' });
    const { container } = render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} onContextMenu={onContextMenu} />);
    fireEvent.contextMenu(cardRoot(container), { clientX: 120, clientY: 180 });
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu).toHaveBeenCalledWith('sess-a', 120, 180);
  });

  it('缺省 onContextMenu → 右键不上抛（浏览器默认菜单，jsdom 下无异常）', () => {
    const m = mkMember({ id: 'm1', sessionId: 'sess-a' });
    const { container } = render(<SeatCard row={mkRow({ member: m })} onEnter={() => {}} />);
    expect(() =>
      fireEvent.contextMenu(cardRoot(container), { clientX: 10, clientY: 20 }),
    ).not.toThrow();
  });
});

describe('SeatCard — 群聊按钮（v0.0.194 从 TeamEntryRow 挪入队长卡）', () => {
  it('传 onOpenGroupChat → 渲染群聊按钮：flex-1 + 灰色 outline（border-border-2 / bg-surface / text-fg-3）+ 文案「群聊」', () => {
    render(<SeatCard row={mkRow()} onEnter={() => {}} onOpenGroupChat={() => {}} />);
    const btn = groupChatBtn();
    expect(btn.className).toContain('flex-1');
    expect(btn.className).toContain('border-border-2');
    expect(btn.className).toContain('bg-surface');
    expect(btn.className).toContain('text-fg-3');
    expect(btn.textContent).toContain('群聊');
    // 灰色 outline：无 enter 的主色 solid style
    expect(btn.getAttribute('style')).toBeNull();
  });

  it('缺省 onOpenGroupChat → 不渲染群聊按钮', () => {
    render(<SeatCard row={mkRow()} onEnter={() => {}} />);
    expect(screen.queryByRole('button', { name: '群聊' })).toBeNull();
  });

  it('点击群聊按钮 → onOpenGroupChat 回调', () => {
    const onOpenGroupChat = vi.fn();
    render(<SeatCard row={mkRow()} onEnter={() => {}} onOpenGroupChat={onOpenGroupChat} />);
    fireEvent.click(groupChatBtn());
    expect(onOpenGroupChat).toHaveBeenCalledTimes(1);
  });

  it('布局：enter / groupchat 各 flex-1（占一半），more 保持 w-8 icon', () => {
    render(<SeatCard row={mkRow()} onEnter={() => {}} onOpenGroupChat={() => {}} />);
    const enter = enterBtn();
    const group = groupChatBtn();
    const more = moreBtn();
    expect(enter.className).toContain('flex-1');
    expect(group.className).toContain('flex-1');
    expect(more.className).toContain('w-8');
    expect(more.className).not.toContain('flex-1');
    // 顺序：enter → groupchat → more（同一操作行容器内）
    const siblings = Array.from(enter.parentElement!.children);
    expect(siblings.indexOf(enter)).toBeLessThan(siblings.indexOf(group));
    expect(siblings.indexOf(group)).toBeLessThan(siblings.indexOf(more));
  });

  it('offline 时群聊按钮保持灰色 outline 不变（本就灰色无需再降级）', () => {
    render(<SeatCard row={mkRow({ presence: 'offline' })} onEnter={() => {}} onOpenGroupChat={() => {}} />);
    const btn = groupChatBtn();
    expect(btn.className).toContain('border-border-2');
    expect(btn.className).toContain('bg-surface');
    expect(btn.getAttribute('style')).toBeNull();
  });

  it('群聊按钮右键 → onGroupChatContextMenu(x, y) + 不冒泡到根卡 onContextMenu（stopPropagation）', () => {
    const onGroupChatContextMenu = vi.fn();
    const onContextMenu = vi.fn();
    render(
      <SeatCard
        row={mkRow()}
        onEnter={() => {}}
        onOpenGroupChat={() => {}}
        onGroupChatContextMenu={onGroupChatContextMenu}
        onContextMenu={onContextMenu}
      />,
    );
    fireEvent.contextMenu(groupChatBtn(), { clientX: 50, clientY: 60 });
    expect(onGroupChatContextMenu).toHaveBeenCalledTimes(1);
    expect(onGroupChatContextMenu).toHaveBeenCalledWith(50, 60);
    // stopPropagation：根卡 leader 右键 handler 不被触发（防双重弹层）
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it('群聊按钮传 onOpenGroupChat 但未传 onGroupChatContextMenu → 右键不上抛（jsdom 下无异常）', () => {
    render(<SeatCard row={mkRow()} onEnter={() => {}} onOpenGroupChat={() => {}} />);
    expect(() =>
      fireEvent.contextMenu(groupChatBtn(), { clientX: 10, clientY: 20 }),
    ).not.toThrow();
  });
});

describe('SeatCard — INV-3 静态脉冲点（无 @keyframes）', () => {
  it('脉冲点用 CSS box-shadow，无 animate-* class', () => {
    render(<SeatCard row={mkRow({ presence: 'busy' })} onEnter={() => {}} />);
    const status = statusRowOf(/推理中…/);
    const pulse = status.querySelector('span.rounded-full');
    expect(pulse).toBeTruthy();
    expect(pulse?.className).not.toContain('animate-');
    expect(pulse?.getAttribute('style')).toContain('var(--presence-busy)');
  });
});

describe('SeatCard — running spinner（名字后）', () => {
  it('row.isRunning=true → 渲染 spinner（size=sm 10px）', () => {
    const { container } = render(<SeatCard row={mkRow({ isRunning: true })} onEnter={() => {}} />);
    const sp = spinner(container);
    expect(sp).toBeTruthy();
    expect(sp?.getAttribute('style')).toContain('width: 10px');
    expect(sp?.getAttribute('style')).toContain('height: 10px');
    expect(sp?.className).toContain('animate-spin');
    expect(sp?.className).toContain('shrink-0');
  });

  it('row.isRunning=false → 不渲染 spinner', () => {
    const { container } = render(<SeatCard row={mkRow({ isRunning: false })} onEnter={() => {}} />);
    expect(spinner(container)).toBeNull();
  });

  it('spinner 在名字行最末（顺序：名 → leader badge → spinner）', () => {
    const leader = mkMember({ id: 'lead1', name: 'Rocky', role: 'leader' });
    const { container } = render(<SeatCard row={mkRow({ member: leader, isLeader: true, isRunning: true })} onEnter={() => {}} />);
    const sp = spinner(container)!;
    const badge = screen.getByText('LEADER');
    // spinner 与 badge 都在名字 span 的父 flex items-center 容器里
    expect(sp.parentElement).toBe(badge.parentElement);
    const siblings = Array.from(sp.parentElement!.children);
    const nameIdx = siblings.findIndex((n) => n.tagName === 'SPAN' && n.textContent === 'Rocky');
    const spinnerIdx = siblings.indexOf(sp);
    const badgeIdx = siblings.indexOf(badge);
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(badgeIdx).toBeGreaterThan(nameIdx);
    expect(spinnerIdx).toBeGreaterThan(badgeIdx);
  });
});
