/**
 * @vitest-environment jsdom
 * SeatStats 单测 —— v0.0.170 修订（2×2 无缝格，图标下线）
 * 参考: specs/ui/components/studio-page/component-seat-stats.md v1.1
 *       specs/prd/version_logs/v0.0.165.ui_upgrade/change_log.md §6.4（降级规则）
 *
 * 定位策略：产品代码 data-testid 已移除，改按 label 文案定位单格（cell = label 的父容器），
 *   数字位 = cell 首子元素。
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { SeatStats } from '../component-seat-stats';

beforeAll(async () => {
  await initI18n('zh-CN');
});
afterEach(() => cleanup());

/** 按 label 文案定位单格容器（label div 的父元素） */
function cellOf(label: string): HTMLElement {
  return screen.getByText(label).parentElement as HTMLElement;
}

/** 单格的数字位（cell 首子元素，含数字 + 可选后缀） */
function numOf(label: string): HTMLElement {
  return cellOf(label).firstElementChild as HTMLElement;
}

describe('SeatStats — 4 格统计 + null 降级', () => {
  it('全字段有值 → 4 格数字全展示', () => {
    const { container } = render(
      <SeatStats onlineCount={4} totalCount={6} inProgressCount={2} todayMsgCount={18} tokenUsed={248000} />
    );
    expect(container.firstElementChild).toBeTruthy();
    expect(numOf('成员在线').textContent).toContain('4');
    expect(numOf('成员在线').textContent).toContain('/6');
    expect(numOf('进行中任务').textContent).toContain('2');
    expect(numOf('今日消息').textContent).toContain('18');
    // 248000 → 248k
    expect(numOf('已用 token').textContent).toContain('248k');
  });

  it('todayMsgCount=null → 「—」不隐藏格 + 弱化 dim（muted-2）', () => {
    render(<SeatStats onlineCount={4} totalCount={6} inProgressCount={0} todayMsgCount={null} tokenUsed={100} />);
    expect(cellOf('今日消息')).toBeTruthy();
    const num = numOf('今日消息');
    expect(num.textContent).toContain('—');
    expect(num.className).toContain('text-muted-2');
  });

  it('tokenUsed=null（未配 budget）→ 「—」不隐藏格 + 弱化 dim', () => {
    render(<SeatStats onlineCount={4} totalCount={6} inProgressCount={0} todayMsgCount={5} tokenUsed={null} />);
    expect(cellOf('已用 token')).toBeTruthy();
    const num = numOf('已用 token');
    expect(num.textContent).toContain('—');
    expect(num.className).toContain('text-muted-2');
  });

  it('非 null 数字不弱化（text-fg）', () => {
    render(<SeatStats onlineCount={4} totalCount={6} inProgressCount={0} todayMsgCount={5} tokenUsed={100} />);
    expect(numOf('今日消息').className).toContain('text-fg');
  });

  it('两 null 同时降级 → 布局稳定（两格都在）', () => {
    render(<SeatStats onlineCount={0} totalCount={0} inProgressCount={0} todayMsgCount={null} tokenUsed={null} />);
    // 全 4 格都渲染，不因 null 隐藏
    expect(cellOf('成员在线')).toBeTruthy();
    expect(cellOf('进行中任务')).toBeTruthy();
    expect(cellOf('今日消息')).toBeTruthy();
    expect(cellOf('已用 token')).toBeTruthy();
  });

  it('数字缩写：<1000 原样，≥1000 k 后缀（1 位小数 <100k，整数 ≥100k）', () => {
    const { rerender } = render(
      <SeatStats onlineCount={999} totalCount={999} inProgressCount={0} todayMsgCount={999} tokenUsed={999} />
    );
    // 999 保原样（不 k）
    expect(numOf('今日消息').textContent).toContain('999');
    rerender(
      <SeatStats onlineCount={0} totalCount={0} inProgressCount={0} todayMsgCount={12345} tokenUsed={12345} />
    );
    // 12345 → 12.3k
    expect(numOf('今日消息').textContent).toContain('12.3k');
    rerender(
      <SeatStats onlineCount={0} totalCount={0} inProgressCount={0} todayMsgCount={123456} tokenUsed={123456} />
    );
    // 123456 → 123k（≥100k 整数）
    expect(numOf('今日消息').textContent).toContain('123k');
  });

  it('v0.0.170 容器 = 2×2 无缝格（grid-cols-2 gap-px 缝色底 + rounded-xl overflow-hidden）；无图标', () => {
    const { container } = render(<SeatStats onlineCount={1} totalCount={1} inProgressCount={0} todayMsgCount={0} tokenUsed={0} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('grid');
    expect(root.className).toContain('grid-cols-2');
    expect(root.className).toContain('gap-px');
    expect(root.className).toContain('bg-border');
    expect(root.className).toContain('rounded-xl');
    expect(root.className).toContain('overflow-hidden');
    // 图标下线：无任何 svg 图标
    expect(container.querySelector('svg')).toBeNull();
  });
});
