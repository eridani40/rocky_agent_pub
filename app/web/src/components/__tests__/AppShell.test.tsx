/**
 * @vitest-environment jsdom
 * AppShell 单测（[v0.0.47] nav 改造：删齿轮子菜单 + 底部三独立入口；[v0.0.210] 业务区加 Academy）
 * 参考: specs/ui/components/framework/nav-rail.md（[v0.0.47] 改造段）
 *       specs/ui/components/app-dev-config-page/page-app-settings-merged.md
 *       specs/ui/overall/12-academy.md（[v0.0.210] Academy 板块）
 *
 * 覆盖：
 *  - 顶部业务区 Playground + Studio + Academy（[v0.0.210] 加 Academy 🎓 教室培养）
 *  - 底部独立入口 SKILLS / 渠道 / 连接器 / 应用设置（删齿轮子菜单）
 *  - 无齿轮子菜单 / theme-toggle（nav 共 7 个按钮）
 *  - currentView 默认 playground → chat-page；切 settings-app → page-app-settings（合并页）；切 academy → page-academy
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AppShell } from '../framework/app-shell/app-shell';
import { useViewStore } from '../../store/view-store';
import { initI18n } from '../../i18n';

// 启动 i18next instance：AppShell 子树多处用 useTranslation
beforeAll(async () => {
  await initI18n('zh-CN');
});

// PageStudio 挂载会 fetch /squad；jsdom 无网络，stub 掉避免噪音（只验路由渲染容器）
beforeEach(() => {
  cleanup();
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"items":[]}', { status: 200 }))));
  useViewStore.getState().setView('playground');
});

describe('AppShell（[v0.0.47] nav 删齿轮子菜单 + 底部三独立入口；[v0.0.210] +Academy）', () => {
  it('渲染 nav brand + 顶部业务区 + 底部独立入口（共 7 个 nav 按钮）', () => {
    render(<AppShell />);
    // brand「R」
    expect(screen.getByText('R')).toBeTruthy();
    for (const name of ['Playground', 'Studio', 'Academy', 'SKILLS', '渠道', '连接器', '应用设置']) {
      expect(screen.getByRole('button', { name }), `missing nav button=${name}`).toBeTruthy();
    }
    // nav 内共 7 个按钮（无齿轮子菜单 / theme-toggle；[v0.0.210] 业务区 +Academy）
    const nav = document.querySelector('nav')!;
    expect(nav.querySelectorAll('button')).toHaveLength(7);
  });

  it('默认主区渲染 chat-page（currentView=playground，Playground 激活）', () => {
    render(<AppShell />);
    // chat-page 特征：会话列表侧边栏
    expect(screen.getByText('会话列表')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Playground' }).getAttribute('data-active')).toBe('true');
  });

  it('点 Studio → 主区切到 page-studio（[v0.0.33.1] Studio view）', () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole('button', { name: 'Studio' }));
    // page-studio 空态特征文案
    expect(screen.getByText('还没有 squad')).toBeTruthy();
    expect(screen.queryByText('会话列表')).toBeNull();
    expect(screen.getByRole('button', { name: 'Studio' }).getAttribute('data-active')).toBe('true');
  });

  it('点 Academy → 主区切到 page-academy（[v0.0.210] Academy 教室培养板块）', () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole('button', { name: 'Academy' }));
    expect(useViewStore.getState().currentView).toBe('academy');
    expect(screen.getByRole('button', { name: 'Academy' }).getAttribute('data-active')).toBe('true');
    // page-academy 特征：classroom-list 空态 hero 文案
    expect(screen.getByText('选一间教室开始，或新建一间')).toBeTruthy();
    expect(screen.queryByText('会话列表')).toBeNull();
  });

  it('点 SKILLS → 主区切到 page-skill', () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole('button', { name: 'SKILLS' }));
    expect(useViewStore.getState().currentView).toBe('skill');
    expect(screen.getByRole('button', { name: 'SKILLS' }).getAttribute('data-active')).toBe('true');
  });

  it('点连接器 → 主区切到 page-connector', () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole('button', { name: '连接器' }));
    expect(useViewStore.getState().currentView).toBe('connector');
    expect(screen.getByRole('button', { name: '连接器' }).getAttribute('data-active')).toBe('true');
  });

  it('点应用设置 → 主区切到合并页 page-app-settings（[v0.0.47] 替代 page-app-config）', () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole('button', { name: '应用设置' }));
    // 合并页特征：tab 树含「通用」tab
    expect(screen.getByRole('button', { name: '通用' })).toBeTruthy();
    expect(useViewStore.getState().currentView).toBe('settings-app');
    expect(screen.getByRole('button', { name: '应用设置' }).getAttribute('data-active')).toBe('true');
  });

  it('非 playground 时点 Playground 切回 chat-page', () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole('button', { name: 'Studio' }));
    expect(screen.queryByText('会话列表')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Playground' }));
    expect(screen.getByText('会话列表')).toBeTruthy();
    expect(useViewStore.getState().currentView).toBe('playground');
  });
});
