/**
 * @vitest-environment jsdom
 * component-schema-config-modal 单测 + page-plugin-config 集成（2 tab 切换 + GET inventory）
 * 参考: specs/ui/components/plugin-config-page/{component-schema-config-modal,page-plugin-config}.md
 *
 * [v0.0.67] 配置只读化：PUT 端点已删，page handler 全 noop。本文件回归：
 *   - schema modal 自身渲染/编辑/保存回调契约（modal 仍可用，但生产中齿轮入口已隐藏）
 *   - page 2 tab 切换、GET /config/plugin 取 inventory、
 *   - v0.0.67 新增：plugin toggle disabled（不写 PUT），readonly banner 渲染
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ComponentSchemaConfigModal } from '../component-schema-config-modal';
import { PagePluginConfig } from '../page-plugin-config';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：modal 内 close 按钮 aria-label 走 useTranslation('common')
beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('ComponentSchemaConfigModal', () => {
  afterEach(() => cleanup());

  /**
   * [v0.0.71 D7] configSchema = JSON Schema 形状（替代旧 schemaConfig map）。
   * 控件路由：按 properties.<key>.type 分发；enum 字段 = `type:'string' + enum:[...]`。
   */
  const configSchema = {
    type: 'object',
    properties: {
      apiKey: { type: 'string', description: 'API Key' },
      model: { type: 'string', enum: ['claude-sonnet-4-6', 'claude-haiku-4-5'], default: 'claude-sonnet-4-6' },
      retries: { type: 'number', default: 3 },
      verbose: { type: 'boolean', default: false },
    },
  };
  const value = { apiKey: 'sk-xxx', model: 'claude-sonnet-4-6' };

  it('open=false 不渲染', () => {
    const { container } = render(
      <ComponentSchemaConfigModal
        implId="impl_a"
        configSchema={configSchema}
        value={value}
        open={false}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(() => screen.getByText('配置 · impl_a')).toThrow();
  });

  it('open=true 渲染弹层 + 按 type 渲染对应控件', () => {
    render(
      <ComponentSchemaConfigModal
        implId="impl_a"
        configSchema={configSchema}
        value={value}
        open={true}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    expect(screen.getByText('配置 · impl_a')).toBeTruthy();
    // string → input（唯一 textbox）
    expect(screen.getByRole('textbox')).toBeTruthy();
    // enum → 选项卡片组（按钮，非原生 select；见 _conventions §10）
    expect(screen.getByRole('button', { name: 'claude-sonnet-4-6' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'claude-haiku-4-5' })).toBeTruthy();
    // number → input[type=number]
    const numEl = screen.getByRole('spinbutton');
    expect(numEl.tagName).toBe('INPUT');
    expect(numEl.getAttribute('type')).toBe('number');
    // boolean → switch
    expect(screen.getByRole('switch')).toBeTruthy();
  });

  it('保存按钮点击 → onSave(draft) + onClose', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(
      <ComponentSchemaConfigModal
        implId="impl_a"
        configSchema={configSchema}
        value={value}
        open={true}
        onClose={onClose}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-xxx', model: 'claude-sonnet-4-6' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('× 关闭按钮 → onClose（不保存）', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(
      <ComponentSchemaConfigModal
        implId="impl_a"
        configSchema={configSchema}
        value={value}
        open={true}
        onClose={onClose}
        onSave={onSave}
      />,
    );
    // × 按钮（aria-label 关闭）
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('编辑 draft 改 apiKey 后保存 → onSave 收到新值', () => {
    const onSave = vi.fn();
    render(
      <ComponentSchemaConfigModal
        implId="impl_a"
        configSchema={configSchema}
        value={value}
        open={true}
        onClose={() => {}}
        onSave={onSave}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-new' }));
  });

  it('[v0.0.71 D4] readOnly=true 时隐藏保存按钮（onSave 不可触发）', () => {
    const onSave = vi.fn();
    render(
      <ComponentSchemaConfigModal
        implId="impl_a"
        configSchema={configSchema}
        value={value}
        open={true}
        onClose={() => {}}
        onSave={onSave}
        readOnly
      />,
    );
    // 保存按钮不渲染
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
    // 字段控件 disabled（fieldset disabled 浏览器原生隔绝）
    const numEl = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(numEl.disabled).toBe(true);
  });
});

describe('PagePluginConfig（2 tab + GET inventory；v0.0.67 只读化）', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** 构造 fetch mock（按 url 子串路由） */
  function mockFetch(routes: Array<{ match: string; handler: (url: string, init?: RequestInit) => unknown }>) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      for (const r of routes) {
        if (url.includes(r.match)) {
          const body = await r.handler(url, init);
          return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
        }
      }
      return { ok: false, status: 404, text: async () => '{"error":"NF"}' } as unknown as Response;
    });
  }

  /**
   * inventory 嵌套形状：groups[].points[].impls[]。
   */
  const inventory = () => ({
    tree: {
      plugins: [
        { pluginId: 'plugin_a', label: 'A', description: 'desc A', enabled: true },
        { pluginId: 'plugin_b', label: 'B', description: 'desc B', enabled: true },
      ],
      groups: [
        {
          groupId: 'provider',
          points: [
            {
              pointId: 'llm_provider',
              activated: true,
              impls: [
                { pluginId: 'plugin_a', pointId: 'llm_provider', implId: 'impl_a', type: 'exclusive' as const, pluginEnabled: true, enabled: true },
                { pluginId: 'plugin_b', pointId: 'llm_provider', implId: 'impl_b', type: 'exclusive' as const, pluginEnabled: true, enabled: false },
              ],
            },
          ],
        },
      ],
    },
  });

  it('渲染双 tab（插件/扩展点），默认插件 tab', async () => {
    global.fetch = mockFetch([{ match: '/config/plugin', handler: () => inventory() }]) as unknown as typeof fetch;
    render(<PagePluginConfig />);
    await waitFor(() => expect(screen.getByRole('tab', { name: '插件' })).toBeTruthy());
    expect(screen.getByRole('tab', { name: '插件' }).getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('tab', { name: '扩展点' }).getAttribute('data-active')).toBe('false');
  });

  it('挂载时 GET /config/plugin，插件 tab 渲染两个独立 plugin-item', async () => {
    global.fetch = mockFetch([{ match: '/config/plugin', handler: () => inventory() }]) as unknown as typeof fetch;
    render(<PagePluginConfig />);
    // label 在 logo 首字母 + 名称 span 各出现一次
    await waitFor(() => expect(screen.getAllByText('A').length).toBeGreaterThan(0));
    expect(screen.getAllByText('B').length).toBeGreaterThan(0);
  });

  it('点扩展点 tab 切换 → 渲染 ext-point-area', async () => {
    global.fetch = mockFetch([{ match: '/config/plugin', handler: () => inventory() }]) as unknown as typeof fetch;
    render(<PagePluginConfig />);
    await waitFor(() => expect(screen.getAllByText('A').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('tab', { name: '扩展点' }));
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '扩展点' }).getAttribute('data-active')).toBe('true');
      // EP 标题渲染
      expect(screen.getByText('llm_provider')).toBeTruthy();
    });
  });

  it('扩展点 tab 渲染 exclusive 类型的 radio 项', async () => {
    global.fetch = mockFetch([{ match: '/config/plugin', handler: () => inventory() }]) as unknown as typeof fetch;
    render(<PagePluginConfig />);
    await waitFor(() => expect(screen.getAllByText('A').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('tab', { name: '扩展点' }));
    await waitFor(() => expect(screen.getAllByRole('radio', { hidden: true }).length).toBeGreaterThan(0));
  });

  it('[v0.0.67] 渲染顶部只读 banner', async () => {
    global.fetch = mockFetch([{ match: '/config/plugin', handler: () => inventory() }]) as unknown as typeof fetch;
    render(<PagePluginConfig />);
    await waitFor(() => expect(screen.getByText(/界面只读/)).toBeTruthy());
    expect(screen.getByText(/界面只读/).textContent).toContain('只读');
  });

  it('[v0.0.67] plugin toggle 已 disabled（点击不触发 PUT，不切换 data-enabled）', async () => {
    const fetchSpy = mockFetch([{ match: '/config/plugin', handler: () => inventory() }]);
    global.fetch = fetchSpy as unknown as typeof fetch;
    render(<PagePluginConfig />);
    await waitFor(() => expect(screen.getByRole('switch', { name: '切换插件 A 启用' })).toBeTruthy());

    const toggleA = screen.getByRole('switch', { name: '切换插件 A 启用' });
    expect(toggleA.getAttribute('disabled')).not.toBeNull();
    fireEvent.click(toggleA);
    // v0.0.67 noop：不写 PUT，data-enabled 保持 true
    expect(toggleA.getAttribute('data-enabled')).toBe('true');
    // 没有 PUT 调用（fetch 只用于 GET inventory）
    const putCalls = fetchSpy.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
  });
});
