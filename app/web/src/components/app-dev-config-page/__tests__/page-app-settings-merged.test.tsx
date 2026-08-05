/**
 * @vitest-environment jsdom
 * page-app-settings-merged 单测 — tab 竖排导航树 + page-tab 级保存 + light-only general tab。
 * 参考 specs/ui/components/app-dev-config-page/page-app-settings-merged.md
 *
 * 校验点：
 *   - tab 树 5 通用项（通用/会话/模型/工具/记忆）
 *   - 默认选中通用 tab；通用 tab 只渲染语言 card（无 appearance / theme KV）
 *   - 通用 tab 不显 page-save-bar（语言切即生效）
 *   - 默认收起：无可观测性/整理/插件 tab；点「展开系统配置」展开
 *   - 会话 tab → 会话注入数量/Playground 默认模型/LLM 请求 + page-save-bar
 *   - 模型 tab → 仅供应商 group（自渲染独立 save，无 page-save-bar）
 *   - 收起时若 selectedTab ∈ {可观测性/插件} → 回落到通用
 *
 * vi.mock 用绝对路径（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
// 会话 tab 的 default_models 行复用 chat/ModelPicker（v0.0.230 返工），其 useProviders 直发
// 真实 fetch——注入空桩绕过网络，保 jsdom 确定性（空桩 → picker 显「选择 model」占位即可）
import { __setProvidersCacheForTest, __resetProvidersCacheForTest } from '../../../lib/providers';

beforeAll(async () => {
  await initI18n('zh-CN');
});

const providersPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../providers/section-providers'),
);
const observabilityPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../observability-config/section-observability'),
);
const webSearchPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../section-web-search-config'),
);
const pluginConfigPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../plugin-config-page/page-plugin-config'),
);
const apiClientPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../../lib/api-client'),
);

vi.mock(providersPath, () => ({
  // mock 暴露两按钮模拟 list↔detail 切换（上抛 onViewLevelChange）
  SectionProviders: ({ onViewLevelChange }: { onViewLevelChange?: (l: 'list' | 'detail') => void }) => (
    <div>
      providers
      <button onClick={() => onViewLevelChange?.('detail')} />
      <button onClick={() => onViewLevelChange?.('list')} />
    </div>
  ),
}));
vi.mock(observabilityPath, () => ({
  SectionObservability: () => <div>observability</div>,
}));
vi.mock(webSearchPath, () => ({
  SectionWebSearchConfig: () => <div>web-search</div>,
}));
vi.mock(pluginConfigPath, () => ({
  PagePluginConfig: () => <div>plugin-config</div>,
}));
// mock api-client：覆盖 use-app-settings-config + app-settings-persist 用到的所有函数
vi.mock(apiClientPath, () => ({
  getConfigGroup: vi.fn().mockResolvedValue([]),
  putConfigGroup: vi.fn().mockResolvedValue(undefined),
  req: vi.fn().mockResolvedValue({ value: null }),
  listProviders: vi.fn().mockResolvedValue([]),
}));

import { PageAppSettingsMerged } from '../page-app-settings-merged';

/** 渲染 + 等 GET 回填完成（general tab 只有语言 card） */
async function renderMerged() {
  const result = render(<PageAppSettingsMerged />);
  await screen.findByText('语言').catch(() => {});
  // 给 useEffect 一点喘息时间
  await new Promise((r) => setTimeout(r, 50));
  return result;
}

/** 获取系统配置展开/收起按钮 */
function getSystemToggle() {
  return (
    screen.queryByRole('button', { name: '展开系统配置' }) ??
    screen.getByRole('button', { name: '收起系统配置' })
  );
}

describe('PageAppSettingsMerged — tab 树 + page-tab 级保存', () => {
  beforeEach(() => {
    cleanup();
    __resetProvidersCacheForTest();
    __setProvidersCacheForTest([]);
  });
  afterEach(() => {
    cleanup();
    __resetProvidersCacheForTest();
  });

  it('渲染 tab 树导航', async () => {
    await renderMerged();
    expect(screen.getByRole('button', { name: '通用' })).toBeTruthy();
  });

  it('通用区 5 tab 存在（通用/会话/模型/工具/记忆）', async () => {
    await renderMerged();
    expect(screen.getByRole('button', { name: '通用' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '会话' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '模型' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '工具' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '记忆' })).toBeTruthy();
  });

  it('tab 顺序：会话排第二（在通用后模型前，v0.0.149）', async () => {
    const { container } = await renderMerged();
    const nav = container.querySelector('nav')!;
    const tabs = Array.from(nav.querySelectorAll('button[aria-current], button[data-active]'));
    // 通用区前 3 项应为 通用 → 会话 → 模型
    expect(tabs[0]!.textContent).toContain('通用');
    expect(tabs[1]!.textContent).toContain('会话');
    expect(tabs[2]!.textContent).toContain('模型');
  });

  it('默认选中通用 tab（data-active=true）', async () => {
    await renderMerged();
    expect(screen.getByRole('button', { name: '通用' }).getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('button', { name: '模型' }).getAttribute('data-active')).toBe('false');
  });

  it('默认收起：无可观测性/整理/插件 tab', async () => {
    await renderMerged();
    expect(screen.queryByRole('button', { name: '可观测性' })).toBeNull();
    expect(screen.queryByRole('button', { name: '整理' })).toBeNull();
    expect(screen.queryByRole('button', { name: '插件' })).toBeNull();
  });

  it('点「展开系统配置」→ 可观测性/整理/插件 tab 出现', async () => {
    await renderMerged();
    fireEvent.click(screen.getByRole('button', { name: '展开系统配置' }));
    expect(screen.getByRole('button', { name: '可观测性' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '整理' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '插件' })).toBeTruthy();
  });

  it('切整理 tab（展开后）→ 右栏渲染整理 group（开关 + 时间输入）', async () => {
    await renderMerged();
    fireEvent.click(screen.getByRole('button', { name: '展开系统配置' }));
    fireEvent.click(screen.getByRole('button', { name: '整理' }));
    expect(screen.getByRole('button', { name: '整理' }).getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('heading', { name: '整理' })).toBeTruthy();
    expect(screen.getByRole('switch')).toBeTruthy();
    expect(document.body.querySelector('input[type="time"]')).toBeTruthy();
  });

  it('整理 tab 显示 page-save-bar（KV group 参与 page-tab dirty）', async () => {
    await renderMerged();
    fireEvent.click(screen.getByRole('button', { name: '展开系统配置' }));
    fireEvent.click(screen.getByRole('button', { name: '整理' }));
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
  });

  it('收起时若 selectedTab === 整理 → 回落到通用', async () => {
    await renderMerged();
    fireEvent.click(screen.getByRole('button', { name: '展开系统配置' }));
    fireEvent.click(screen.getByRole('button', { name: '整理' }));
    expect(screen.getByRole('button', { name: '整理' }).getAttribute('data-active')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '收起系统配置' }));
    expect(screen.getByRole('button', { name: '通用' }).getAttribute('data-active')).toBe('true');
  });

  it('系统配置 toggle 的 data-expanded/aria-expanded 反映状态', async () => {
    await renderMerged();
    const toggle = screen.getByRole('button', { name: '展开系统配置' });
    expect(toggle.getAttribute('data-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: '收起系统配置' }).getAttribute('data-expanded')).toBe('true');
  });

  it('语言 card 存在（general tab 只剩语言 card）', async () => {
    await renderMerged();
    expect(screen.getByText('语言')).toBeTruthy();
    // 语言选项卡片
    expect(screen.getByText('中文')).toBeTruthy();
    expect(screen.getByText('English')).toBeTruthy();
  });

  it('appearance group 不存在（light-only，theme KV 已下线）', async () => {
    await renderMerged();
    expect(screen.queryByText('外观')).toBeNull();
    expect(screen.queryByText('theme')).toBeNull();
  });

  it('切会话 tab → 右栏渲染 会话注入数量/Playground 默认模型/LLM 请求 group', async () => {
    await renderMerged();
    fireEvent.click(screen.getByRole('button', { name: '会话' }));
    expect(screen.getByRole('button', { name: '会话' }).getAttribute('data-active')).toBe('true');
    expect(screen.getByText('会话注入数量')).toBeTruthy();
    expect(screen.getByText('Playground 默认模型')).toBeTruthy();
    expect(screen.getByText('LLM 请求')).toBeTruthy();
    // session group 内含 maxSkillInject/maxMemoryInject 两 number input
    expect(screen.getAllByRole('spinbutton').length).toBeGreaterThanOrEqual(2);
  });

  it('会话 tab 默认值 50/50（record 缺失 → 前端兜底）', async () => {
    await renderMerged();
    fireEvent.click(screen.getByRole('button', { name: '会话' }));
    const inputs = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    // 前两个是 session 的 maxSkillInject/maxMemoryInject
    expect(inputs[0]!.value).toBe('50');
    expect(inputs[1]!.value).toBe('50');
  });

  it('会话 tab 显示 page-save-bar（含三个 KV group）', async () => {
    await renderMerged();
    fireEvent.click(screen.getByRole('button', { name: '会话' }));
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
  });

  it('切模型 tab → 右栏仅渲染供应商 group', async () => {
    await renderMerged();
    fireEvent.click(screen.getByRole('button', { name: '模型' }));
    expect(screen.getByRole('button', { name: '模型' }).getAttribute('data-active')).toBe('true');
    expect(screen.getByText('供应商')).toBeTruthy();
    // default_models / llm_request 已迁到会话 tab，模型 tab 不再渲染
    expect(screen.queryByText('Playground 默认模型')).toBeNull();
    expect(screen.queryByText('LLM 请求')).toBeNull();
  });

  it('模型 tab 不显 page-save-bar（providers 自渲染独立 save）', async () => {
    await renderMerged();
    fireEvent.click(screen.getByRole('button', { name: '模型' }));
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });

  it('切工具 tab → 右栏渲染网络搜索 group', async () => {
    await renderMerged();
    fireEvent.click(screen.getByRole('button', { name: '工具' }));
    expect(screen.getByText('网络搜索')).toBeTruthy();
  });

  it('切记忆 tab → 右栏渲染长期记忆 group', async () => {
    await renderMerged();
    fireEvent.click(screen.getByRole('button', { name: '记忆' }));
    expect(screen.getByText('长期记忆')).toBeTruthy();
  });

  it('通用 tab 不显 page-save-bar（无 KV group 参与 dirty，语言切即生效）', async () => {
    await renderMerged();
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });

  it('切可观测性 tab（展开后）→ 右栏渲染可观测性/日志 group', async () => {
    await renderMerged();
    fireEvent.click(screen.getByRole('button', { name: '展开系统配置' }));
    fireEvent.click(screen.getByRole('button', { name: '可观测性' }));
    expect(screen.getByRole('heading', { name: '可观测性' })).toBeTruthy();
    expect(screen.getByText('日志')).toBeTruthy();
  });

  it('收起时若 selectedTab ∈ {可观测性/插件} → 回落到通用', async () => {
    await renderMerged();
    fireEvent.click(screen.getByRole('button', { name: '展开系统配置' }));
    fireEvent.click(screen.getByRole('button', { name: '插件' }));
    expect(screen.getByRole('button', { name: '插件' }).getAttribute('data-active')).toBe('true');
    // 收起 → 回落通用
    fireEvent.click(screen.getByRole('button', { name: '收起系统配置' }));
    expect(screen.getByRole('button', { name: '通用' }).getAttribute('data-active')).toBe('true');
  });

  it('改 session maxSkillInject input → page-save-bar status data-dirty=true', async () => {
    const { container } = await renderMerged();
    fireEvent.click(screen.getByRole('button', { name: '会话' }));
    expect(container.querySelector('[data-dirty]')!.getAttribute('data-dirty')).toBe('false');
    const inputs = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    fireEvent.change(inputs[0]!, { target: { value: '100' } });
    expect(container.querySelector('[data-dirty]')!.getAttribute('data-dirty')).toBe('true');
  });

  it('GET 失败 → merged page 不崩（error 提示渲染）', async () => {
    const { getConfigGroup } = await import('../../../lib/api-client');
    vi.mocked(getConfigGroup).mockRejectedValueOnce(new Error('GET 失败'));
    expect(() => render(<PageAppSettingsMerged />)).not.toThrow();
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeNull();
    });
  });
});
