// @vitest-environment jsdom
/**
 * component-skills-modal 单测（v0.0.205.t2_cons T3）
 * 参考: specs/ui/components/chat-page/component-skills-modal.md（组件契约 + 可见文案）
 *       specs/prd/version_logs/v0.0.205.t2_cons/change_log.md 定案 1（UC-S1~S7）
 *
 * 覆盖：
 *   - 3 tab（会话/团队/全局）渲染 + 默认选中 session（aria-selected）
 *   - tab 切换 → 渲染对应分组卡片（name + desc + 来源徽标）
 *   - 空态：当前 tab 无 skill → icon + muted 文案（playground group tab 空态，UC-S3）
 *   - 只展示无开关：卡片无 toggle/预览/删除按钮（PRD「暂时无需开关」）
 *   - 弹层挂载 → catalog.refetch() 调一次（UC-S7 重开刷新）
 *   - 关闭：关闭按钮 / 遮罩点击 → onClose
 *   - i18n：zh-CN 文案无【资源】兜底标记
 *
 * mock 策略：catalog 直接以 prop 构造（useSkillsCatalog 不 mock——本组件契约是 prop 下传）；
 * IconBox 真实渲染（ hue hash 纯函数无副作用）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import type { SkillEntry } from '../../../lib/api-client';
import type { SkillsCatalog } from '../use-skills-catalog';

beforeAll(async () => {
  await initI18n('zh-CN');
});

import { ComponentSkillsModal } from '../component-skills-modal';

function mkSkill(name: string, scope: SkillEntry['scope'], description = `desc-${name}`): SkillEntry {
  return { name, description, scope, skillDir: `/x/${name}`, enabled: true };
}

function mkCatalog(overrides: Partial<SkillsCatalog> = {}): SkillsCatalog {
  return {
    groups: {
      session: [mkSkill('ws-skill', 'workspace')],
      group: [],
      global: [mkSkill('builtin-skill', 'builtin'), mkSkill('app-skill', 'app')],
    },
    loading: false,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('ComponentSkillsModal — 3 tab 结构', () => {
  it('渲染 会话/团队/全局 三个 tab，默认选中 session（aria-selected）', () => {
    render(<ComponentSkillsModal catalog={mkCatalog()} onClose={vi.fn()} />);
    const sessionTab = screen.getByRole('tab', { name: '会话' });
    const groupTab = screen.getByRole('tab', { name: '团队' });
    const globalTab = screen.getByRole('tab', { name: '全局' });
    expect(sessionTab.getAttribute('aria-selected')).toBe('true');
    expect(groupTab.getAttribute('aria-selected')).toBe('false');
    expect(globalTab.getAttribute('aria-selected')).toBe('false');
  });

  it('默认 session tab 渲染 session 组卡片（name + desc + 来源徽标）', () => {
    render(<ComponentSkillsModal catalog={mkCatalog()} onClose={vi.fn()} />);
    expect(screen.getByText('ws-skill')).toBeTruthy();
    expect(screen.getByText('desc-ws-skill')).toBeTruthy();
    expect(screen.getByText('工作区')).toBeTruthy();
    // global 组卡片不在 session tab 渲染
    expect(screen.queryByText('builtin-skill')).toBeNull();
  });

  it('切到 global tab → 渲染 builtin+app 组卡片（徽标 内置/应用）', () => {
    render(<ComponentSkillsModal catalog={mkCatalog()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '全局' }));
    expect(screen.getByText('builtin-skill')).toBeTruthy();
    expect(screen.getByText('app-skill')).toBeTruthy();
    expect(screen.getByText('内置')).toBeTruthy();
    expect(screen.getByText('应用')).toBeTruthy();
    expect(screen.queryByText('ws-skill')).toBeNull();
  });

  it('切到 group tab（有数据）→ 渲染 group 组卡片（徽标 团队）', () => {
    const catalog = mkCatalog({
      groups: { session: [], group: [mkSkill('team-skill', 'group')], global: [] },
    });
    render(<ComponentSkillsModal catalog={catalog} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '团队' }));
    expect(screen.getByText('team-skill')).toBeTruthy();
    expect(screen.getByText('团队', { selector: 'span' })).toBeTruthy();
  });
});

describe('ComponentSkillsModal — 空态（playground group tab，UC-S3）', () => {
  it('group 组为空 → 空态 icon + muted 文案', () => {
    render(<ComponentSkillsModal catalog={mkCatalog()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '团队' }));
    expect(screen.getByText(/无团队层 skills/)).toBeTruthy();
    expect(screen.queryByText('ws-skill')).toBeNull();
  });

  it('session 组为空 → session 空态文案', () => {
    const catalog = mkCatalog({ groups: { session: [], group: [], global: [] } });
    render(<ComponentSkillsModal catalog={catalog} onClose={vi.fn()} />);
    expect(screen.getByText(/本会话工作区没有 skills/)).toBeTruthy();
  });
});

describe('ComponentSkillsModal — 只展示无开关（PRD 定案 1）', () => {
  it('卡片无 toggle switch / 预览 / 删除按钮', () => {
    render(<ComponentSkillsModal catalog={mkCatalog()} onClose={vi.fn()} />);
    // ToggleSwitch 角色为 switch；预览/删除是操作按钮——只读卡片一律不渲染
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: /预览/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull();
  });
});

describe('ComponentSkillsModal — 挂载刷新 + 关闭', () => {
  it('弹层挂载 → catalog.refetch() 调一次（UC-S7 重开刷新）', () => {
    const catalog = mkCatalog();
    render(<ComponentSkillsModal catalog={catalog} onClose={vi.fn()} />);
    expect(catalog.refetch).toHaveBeenCalledTimes(1);
  });

  it('点关闭按钮 → onClose', () => {
    const onClose = vi.fn();
    render(<ComponentSkillsModal catalog={mkCatalog()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点遮罩 → onClose', () => {
    const onClose = vi.fn();
    const { container: _c } = render(<ComponentSkillsModal catalog={mkCatalog()} onClose={onClose} />);
    // 遮罩 = overlay-root 下 fixed inset-0 根 div（Portal 挂载，不在 render container 内）
    const overlay = document.querySelector('.fixed.inset-0') as HTMLElement;
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ComponentSkillsModal — i18n', () => {
  it('zh-CN 标题/tab/空态文案无【资源】兜底标记', () => {
    render(<ComponentSkillsModal catalog={mkCatalog()} onClose={vi.fn()} />);
    expect(screen.getByText('技能', { selector: 'span' }).textContent).toBe('技能');
    for (const label of ['会话', '团队', '全局']) {
      expect(screen.getByRole('tab', { name: label }).textContent).not.toContain('【资源');
    }
    fireEvent.click(screen.getByRole('tab', { name: '团队' }));
    expect(screen.getByText(/无团队层 skills/).textContent).not.toContain('【资源');
  });

  it('error 通道 → role=alert 展示错误文本', () => {
    const catalog = mkCatalog({ error: 'HTTP 404', groups: { session: [], group: [], global: [] } });
    render(<ComponentSkillsModal catalog={catalog} onClose={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toBe('HTTP 404');
  });
});
