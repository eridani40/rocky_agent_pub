// @vitest-environment jsdom
/**
 * component-usage-ring + component-usage-panel 单测（v0.0.16 §4.2 / §4.7 + v0.0.326 trigger 重构）
 * 参考: specs/ui/components/chat-page/component-usage-panel.md §4.2（圆环配色阈值）/ §4.7（表格行可见规则）
 *       specs/tech/version_logs/v0.0.326/change_plan.md（D1-D4）
 *
 * 覆盖：
 *   - usageRingColor 三段配色（<0.5 var(--success) / <0.8 var(--warning) / ≥0.8 var(--danger)）
 *   - ComponentUsageRing 默认 size=36（v0.0.326 起，原 28）
 *   - ComponentUsagePanel trigger：整环 onClick toggle + 环内百分比叠层（text-fg-2）+ 无 fmtK 文字/tooltip/chevron
 *   - 展开浮层 head 右侧 CompactBtn/ClearBtn（props 透传 + size='sm' + disabled 绑 summaryTask）
 *   - cum-row 行可见规则：current 始终展示；forked/sub total=0 隐藏；total 末尾必有
 */
import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { usageRingColor, ComponentUsageRing } from '../component-usage-ring';
import { ComponentUsagePanel, CompactBtn, ClearBtn } from '../component-usage-panel';
import type { SessionUsageView, SummaryTaskStatus } from '../types';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：usage 文案走 chat.usage.*
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

describe('usageRingColor 三段配色阈值（§4.2，走 success/warning/danger 语义 token）', () => {
  it('pct<0.5 → success 语义色', () => {
    expect(usageRingColor(0)).toBe('var(--success)');
    expect(usageRingColor(0.49)).toBe('var(--success)');
  });
  it('pct 0.5-0.8 → warning 语义色', () => {
    expect(usageRingColor(0.5)).toBe('var(--warning)');
    expect(usageRingColor(0.79)).toBe('var(--warning)');
  });
  it('pct>=0.8 → danger 语义色', () => {
    expect(usageRingColor(0.8)).toBe('var(--danger)');
    expect(usageRingColor(1)).toBe('var(--danger)');
  });
});

describe('ComponentUsageRing SVG（§4.2）', () => {
  it('渲染 SVG 圆环 + 默认 36×36 stroke4（v0.0.326 起，原 28×28）', () => {
    const { container } = render(<ComponentUsageRing used={10} total={100} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('width')).toBe('36');
    expect(svg.getAttribute('height')).toBe('36');
    // 2 个 circle（底环 + 填充环）
    expect(container.querySelectorAll('circle').length).toBe(2);
  });

  it('展开态大号 52×52 stroke6（size/stroke props）', () => {
    const { container } = render(<ComponentUsageRing used={10} total={100} size={52} stroke={6} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('52');
    expect(svg.getAttribute('height')).toBe('52');
  });

  it('total=0 → pct=0，不崩（渲染成功即可，dasharray 由 SVG 计算）', () => {
    const { container } = render(<ComponentUsageRing used={0} total={0} />);
    // 第二个 circle 是填充环；pct=0 → dasharray 形如 "0 {c}"（c=2π*r，r=(size-stroke)/2）
    expect(container.querySelectorAll('circle').length).toBe(2);
    const fillCircle = container.querySelectorAll('circle')[1]!;
    const dash = fillCircle.getAttribute('strokeDasharray');
    // dash 可能为 "0 75.x" 或 null（React 对 0 前缀的处理差异），核心是不崩
    expect(dash === null || dash.startsWith('0')).toBe(true);
  });
});

/** 构造 SessionUsageView（三分区 + cacheRate） */
function mkUsage(opts: {
  curIn?: number;
  curOut?: number;
  forkedIn?: number;
  forkedOut?: number;
  subIn?: number;
  subOut?: number;
  used?: number;
  total?: number;
}): SessionUsageView {
  const curIn = opts.curIn ?? 1000;
  const curOut = opts.curOut ?? 500;
  const forkedIn = opts.forkedIn ?? 0;
  const forkedOut = opts.forkedOut ?? 0;
  const subIn = opts.subIn ?? 0;
  const subOut = opts.subOut ?? 0;
  const totalIn = curIn + forkedIn + subIn;
  const totalOut = curOut + forkedOut + subOut;
  return {
    current: { input_total_tokens: curIn, output_total_tokens: curOut, total_tokens: curIn + curOut },
    forked: forkedIn + forkedOut > 0 ? { input_total_tokens: forkedIn, output_total_tokens: forkedOut, total_tokens: forkedIn + forkedOut } : {},
    sub: subIn + subOut > 0 ? { input_total_tokens: subIn, output_total_tokens: subOut, total_tokens: subIn + subOut } : {},
    total: { input_total_tokens: totalIn, output_total_tokens: totalOut, total_tokens: totalIn + totalOut },
    ratio: 1,
    contextWindowUsage: {
      systemTokens: Math.round((opts.used ?? 1000) * 0.2),
      messageTokens: Math.round((opts.used ?? 1000) * 0.6),
      toolTokens: Math.round((opts.used ?? 1000) * 0.2),
      totalTokens: opts.used ?? 1000,
      maxOutputTokens: 20000,
      tokenLimit: opts.total ?? 200000,
      remainingTokens: Math.max(0, (opts.total ?? 200000) - (opts.used ?? 1000) - 20000),
    },
    currentCacheRate: 0.5,
    subCacheRate: 0,
    forkedCacheRate: 0,
    totalCacheRate: 0.5,
  };
}

/** 点击 trigger（整环可点，aria-label = 点击查看用量详情）展开/收起 */
function clickTrigger() {
  fireEvent.click(screen.getByRole('button', { name: '点击查看用量详情' }));
}

describe('ComponentUsagePanel 收起态 trigger（v0.0.326 重构：整环可点 + 百分比叠层）', () => {
  it('渲染圆环 + 环内百分比整数（text-fg-2 统一色）', () => {
    const { container } = render(<ComponentUsagePanel usage={mkUsage({ used: 46000, total: 200000 })} />);
    const trigger = screen.getByRole('button', { name: '点击查看用量详情' });
    expect(trigger).toBeTruthy();
    // 环 size=36
    const svg = trigger.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('36');
    // 环内百分比 absolute span（Math.round(46000/200000*100)=23）
    const pctSpan = trigger.querySelector('span.absolute')!;
    expect(pctSpan.textContent).toBe('23%');
    expect(pctSpan.className).toContain('text-fg-2');
    expect(pctSpan.className).toContain('pointer-events-none');
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('trigger 有 cursor-pointer + hover bg + title（可点击感官）', () => {
    render(<ComponentUsagePanel usage={mkUsage({})} />);
    const trigger = screen.getByRole('button', { name: '点击查看用量详情' });
    expect(trigger.className).toContain('cursor-pointer');
    expect(trigger.className).toContain('hover:bg-bg-warm');
    expect(trigger.getAttribute('title')).toBe('点击查看用量详情');
  });

  it('无 fmtK 文字（23k/200k 删除）+ 无 chevron 展开按钮', () => {
    const { container } = render(<ComponentUsagePanel usage={mkUsage({ used: 23000, total: 200000 })} />);
    // 无「23k/200k」fmtK 文字
    expect(container.textContent).not.toContain('23k');
    expect(container.textContent).not.toContain('200k');
    // 唯一 button role = trigger（chevron btn 已删，无 chat.usage.toggle action-key）
    expect(container.querySelector('[data-action-key="chat.usage.toggle"]')).toBeNull();
  });
});

describe('ComponentUsagePanel 展开态（§3.2 / §4.6-§4.7 + v0.0.326 head 按钮）', () => {
  it('点 trigger → panel 浮出，含标题 + 3 段进度 + 3 图例 + 累积消耗表格', () => {
    const { container } = render(<ComponentUsagePanel usage={mkUsage({ used: 23000, total: 200000 })} />);
    // 初始收起：panel 不存在
    expect(screen.queryByText('Token 用量')).toBeNull();
    clickTrigger();
    // 展开后 panel + 子组件齐全
    expect(screen.getByText('Token 用量')).toBeTruthy();
    // 3 图例
    expect(screen.getByText('系统')).toBeTruthy();
    expect(screen.getByText('消息')).toBeTruthy();
    expect(screen.getByText('工具')).toBeTruthy();
    expect(screen.queryByText('输出预留')).toBeNull();
    // 累积消耗表格标题
    expect(screen.getAllByText('累积消耗').length).toBeGreaterThan(0);
    // 3 分段进度条（h-2 容器内 3 个 div）
    const stack = container.querySelector('.h-2')!;
    expect(stack).toBeTruthy();
    expect(stack.children.length).toBe(3);
  });

  it('cum-row-current 始终展示（即使 input/output=0）', () => {
    render(<ComponentUsagePanel usage={mkUsage({ curIn: 0, curOut: 0, used: 0 })} />);
    clickTrigger();
    expect(screen.getByText('会话')).toBeTruthy();
  });

  it('cum-row-total 末尾必有', () => {
    render(<ComponentUsagePanel usage={mkUsage({})} />);
    clickTrigger();
    expect(screen.getAllByText('合计').length).toBeGreaterThan(0);
  });

  it('panel 定位：top-full + right-[96px] 左下展开、让开右侧 float-menu（v0.0.328 修复 326）', () => {
    const { container } = render(<ComponentUsagePanel usage={mkUsage({})} />);
    clickTrigger();
    // 展开浮层（w-[300px] 容器）必须带 right-[96px] 偏移，避开 chat 右缘 float-menu 竖排并留视觉缓冲；
    // 不得回退为 right-0（right-0 时 panel 右缘贴环右缘，300px 宽会盖住 float-menu 列）。
    const panel = container.querySelector('.w-\\[300px\\]')!;
    expect(panel).toBeTruthy();
    expect(panel.className).toContain('top-full');
    expect(panel.className).toContain('right-[96px]');
    expect(panel.className).not.toContain('right-0');
  });

  it('forked/sub total=0 时隐藏（§4.7 行可见规则）', () => {
    render(<ComponentUsagePanel usage={mkUsage({ forkedIn: 0, forkedOut: 0, subIn: 0, subOut: 0 })} />);
    clickTrigger();
    expect(screen.queryByText('整理')).toBeNull();
    expect(screen.queryByText('子Agent')).toBeNull();
  });

  it('forked total>0 时展示整理行', () => {
    render(<ComponentUsagePanel usage={mkUsage({ forkedIn: 100, forkedOut: 50 })} />);
    clickTrigger();
    expect(screen.getByText('整理')).toBeTruthy();
  });

  it('sub total>0 时展示子Agent行', () => {
    render(<ComponentUsagePanel usage={mkUsage({ subIn: 200, subOut: 100 })} />);
    clickTrigger();
    expect(screen.getByText('子Agent')).toBeTruthy();
  });

  it('占用率文案含「已占用」和「剩余」', () => {
    render(<ComponentUsagePanel usage={mkUsage({ used: 50000, total: 200000 })} />);
    clickTrigger();
    const pct = screen.getByText(/已占用/);
    expect(pct.textContent).toContain('剩余');
  });

  it('free = tokenLimit - totalTokens（不含 estimatedOutput 扣减）', () => {
    // used=50000, total=200000, maxOutput=20000 → free = 200000-50000 = 150000
    render(<ComponentUsagePanel usage={mkUsage({ used: 50000, total: 200000 })} />);
    clickTrigger();
    const pct = screen.getByText(/已占用/);
    // free 文案展示 fmtNum(150000) —— 含 "150,000"
    expect(pct.textContent).toContain('150,000');
    // 不含 "130,000"（旧扣 maxOutput 的口径）
    expect(pct.textContent).not.toContain('130,000');
  });

  it('再点 trigger → panel 关闭（toggle）', () => {
    render(<ComponentUsagePanel usage={mkUsage({})} />);
    clickTrigger();
    expect(screen.getByText('Token 用量')).toBeTruthy();
    clickTrigger();
    expect(screen.queryByText('Token 用量')).toBeNull();
  });

  it('head 右侧 CompactBtn/ClearBtn 按 props 渲染 + 回调触发 + size=sm', () => {
    const onCompact = vi.fn();
    const onClear = vi.fn();
    const { container } = render(
      <ComponentUsagePanel usage={mkUsage({})} onCompact={onCompact} onClear={onClear} summaryTask={null} sessionBusy={false} />,
    );
    clickTrigger();
    // head 内按钮（action-key 不变）
    const compactBtn = container.querySelector('[data-action-key="chat.session.compact"]')! as HTMLButtonElement;
    const clearBtn = container.querySelector('[data-action-key="chat.session.clear"]')! as HTMLButtonElement;
    expect(compactBtn).toBeTruthy();
    expect(clearBtn).toBeTruthy();
    // size='sm' → h-7 w-7
    expect(compactBtn.className).toContain('h-7');
    expect(compactBtn.className).toContain('w-7');
    expect(clearBtn.className).toContain('h-7');
    fireEvent.click(compactBtn);
    fireEvent.click(clearBtn);
    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('onCompact/onClear 不传 → head 无按钮（props 门控）', () => {
    const { container } = render(<ComponentUsagePanel usage={mkUsage({})} />);
    clickTrigger();
    expect(container.querySelector('[data-action-key="chat.session.compact"]')).toBeNull();
    expect(container.querySelector('[data-action-key="chat.session.clear"]')).toBeNull();
  });

  it('summaryTask=running → 面板内 CompactBtn disabled + spinner', () => {
    const st: SummaryTaskStatus = { status: 'running', runId: 'r1', startedAt: '2026-06-22T00:00:00.000Z', error: null };
    const { container } = render(
      <ComponentUsagePanel usage={mkUsage({})} onCompact={vi.fn()} summaryTask={st} sessionBusy={false} />,
    );
    clickTrigger();
    const compactBtn = container.querySelector('[data-action-key="chat.session.compact"]')! as HTMLButtonElement;
    expect(compactBtn.disabled).toBe(true);
    expect(compactBtn.querySelector('.animate-spin')).toBeTruthy();
  });
});

describe('CompactBtn 四态（§3.3）', () => {
  it('summaryTask=null → 可点（按 idle 兜底）', () => {
    const onClick = vi.fn();
    render(<CompactBtn summaryTask={null} sessionBusy={false} onClick={onClick} />);
    const btn = screen.getByRole('button', { name: '压缩上下文 (Compact)' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('summaryTask.status=running → disabled + 不响应点击', () => {
    const onClick = vi.fn();
    const st: SummaryTaskStatus = { status: 'running', runId: 'r1', startedAt: '2026-06-22T00:00:00.000Z', error: null };
    render(<CompactBtn summaryTask={st} sessionBusy={false} onClick={onClick} />);
    const btn = screen.getByRole('button', { name: '压缩上下文 (Compact)' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('sessionBusy=true（session.state=running/interrupting）→ 仍可点（任何 session.state 都能 compact）', () => {
    const onClick = vi.fn();
    render(<CompactBtn summaryTask={null} sessionBusy={true} onClick={onClick} />);
    const btn = screen.getByRole('button', { name: '压缩上下文 (Compact)' }) as HTMLButtonElement;
    // disabled 只看 summaryTask.running；session running/interrupting 不再 block compact
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('summaryTask.status=done/failed → 可点（恢复正常）', () => {
    const onClick = vi.fn();
    const done: SummaryTaskStatus = { status: 'done', runId: null, startedAt: null, error: null };
    const { rerender } = render(<CompactBtn summaryTask={done} sessionBusy={false} onClick={onClick} />);
    expect((screen.getByRole('button', { name: '压缩上下文 (Compact)' }) as HTMLButtonElement).disabled).toBe(false);
    const failed: SummaryTaskStatus = { status: 'failed', runId: null, startedAt: null, error: 'timeout' };
    rerender(<CompactBtn summaryTask={failed} sessionBusy={false} onClick={onClick} />);
    expect((screen.getByRole('button', { name: '压缩上下文 (Compact)' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('ClearBtn（§3.4）', () => {
  it('默认可点，点击触发 onClick', () => {
    const onClick = vi.fn();
    render(<ClearBtn onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: '清空会话 (Clear)' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
