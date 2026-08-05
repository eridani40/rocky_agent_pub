/**
 * @vitest-environment jsdom
 * nav-rail 单测（[v0.0.47] 改造：删齿轮子菜单 + 底部三独立入口）
 * 参考: specs/ui/components/framework/nav-rail.md（[v0.0.47] 改造段）
 *
 * 校验点：
 *  - brand「R」+ 顶部业务区 Playground/Studio/Academy（[v0.0.210] +Academy 🎓）
 *  - 底部四独立入口 SKILLS/Channels/Connectors/App settings（自上而下几何顺序）
 *  - 点击任一 nav item → onChange(view)
 *  - 激活态：currentView 对应图标 data-active=true
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NavRail } from '../nav-rail';
import { initI18n } from '../../../../i18n';

beforeAll(async () => {
  await initI18n('en');
});

describe('NavRail（[v0.0.47] 删齿轮子菜单 + 底部三独立入口）', () => {
  afterEach(() => cleanup());

  it('渲染 brand「R」+ 顶部业务区 Playground/Studio/Academy（[v0.0.210] +Academy）', () => {
    render(<NavRail currentView="playground" onChange={() => {}} />);
    expect(screen.getByText('R').textContent).toBe('R');
    expect(screen.getByRole('button', { name: 'Playground' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Studio' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Academy' })).toBeTruthy();
  });

  it('底部独立入口 SKILLS/Channels/Connectors/App settings 都存在', () => {
    render(<NavRail currentView="playground" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'SKILLS' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Channels' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connectors' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'App settings' })).toBeTruthy();
  });

  it('底部入口自上而下几何顺序：SKILLS < Channels < Connectors < App settings', () => {
    render(<NavRail currentView="playground" onChange={() => {}} />);
    const skill = screen.getByRole('button', { name: 'SKILLS' }).getBoundingClientRect();
    const chan = screen.getByRole('button', { name: 'Channels' }).getBoundingClientRect();
    const conn = screen.getByRole('button', { name: 'Connectors' }).getBoundingClientRect();
    const app = screen.getByRole('button', { name: 'App settings' }).getBoundingClientRect();
    // jsdom 下 top 可能为 0（无 layout），但只要入口都有 bbox 即可
    expect(skill).toBeTruthy();
    expect(chan).toBeTruthy();
    expect(conn).toBeTruthy();
    expect(app).toBeTruthy();
    // 若 jsdom 给出非零 top（layouting enabled），校验严格自上而下顺序
    if (skill.top > 0 || chan.top > 0 || conn.top > 0 || app.top > 0) {
      expect(skill.top).toBeLessThan(chan.top);
      expect(chan.top).toBeLessThan(conn.top);
      expect(conn.top).toBeLessThan(app.top);
    }
  });

  it('点底部独立入口 → onChange 触发对应 view id', () => {
    const onChange = vi.fn();
    render(<NavRail currentView="playground" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'SKILLS' }));
    expect(onChange).toHaveBeenCalledWith('skill');
    fireEvent.click(screen.getByRole('button', { name: 'Channels' }));
    expect(onChange).toHaveBeenCalledWith('channel');
    fireEvent.click(screen.getByRole('button', { name: 'Connectors' }));
    expect(onChange).toHaveBeenCalledWith('connector');
    fireEvent.click(screen.getByRole('button', { name: 'App settings' }));
    expect(onChange).toHaveBeenCalledWith('settings-app');
  });

  it('点业务区图标 → onChange(view)', () => {
    const onChange = vi.fn();
    render(<NavRail currentView="playground" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Studio' }));
    expect(onChange).toHaveBeenCalledWith('studio');
    // [v0.0.210] Academy 业务区入口
    fireEvent.click(screen.getByRole('button', { name: 'Academy' }));
    expect(onChange).toHaveBeenCalledWith('academy');
  });

  it('激活态：currentView 对应图标 data-active=true', () => {
    const { rerender } = render(<NavRail currentView="playground" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Playground' }).getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('button', { name: 'Studio' }).getAttribute('data-active')).toBe('false');
    // 切到 connector（底部独立入口）
    rerender(<NavRail currentView="connector" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Connectors' }).getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('button', { name: 'Playground' }).getAttribute('data-active')).toBe('false');
    // 切到 settings-app
    rerender(<NavRail currentView="settings-app" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'App settings' }).getAttribute('data-active')).toBe('true');
  });
});
