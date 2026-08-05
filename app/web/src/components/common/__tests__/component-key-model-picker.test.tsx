/**
 * @vitest-environment jsdom
 * component-key-model-picker 单测（v0.0.89 新增）
 * 参考: specs/ui/components/common/component-key-model-picker.md
 *
 * 校验点：
 *   - 渲染 trigger button（aria-haspopup=listbox）
 *   - 未配（value undefined）显「未配置」+ x 清除按钮 invisible+disabled 占位
 *   - 已配且命中 enabled provider 显 `${providerLabel} / ${modelLabel}` + x 清除按钮
 *   - 已配但 providers 未加载/被删（降级路径）显纯 modelId + x 清除按钮
 *   - 点 x → onChange(undefined)
 *   - 点 trigger → 菜单展开（role=listbox）
 *   - 菜单按 enabled provider 分组渲染项
 *   - 无 enabled provider → 菜单显空状态
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

// mock api-client 的 listProviders（绝对路径，避免 bun+jsdom 并发下相对路径 vi.mock 静默失效）
const apiClientPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../../lib/api-client'),
);
vi.mock(apiClientPath, () => ({
  listProviders: vi.fn(),
}));

import { KeyModelPicker } from '../component-key-model-picker';
import { listProviders } from '../../../lib/api-client';

describe('KeyModelPicker', () => {
  beforeEach(() => {
    cleanup();
    vi.mocked(listProviders).mockResolvedValue([]);
  });
  afterEach(() => cleanup());

  it('渲染 trigger button（aria-haspopup=listbox）', () => {
    render(<KeyModelPicker value={undefined} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '未配置' })).toBeTruthy();
  });

  it('未配（value undefined）显「未配置」+ x 清除按钮 invisible+disabled 占位（尺寸恒定，_conventions §11）', () => {
    render(<KeyModelPicker value={undefined} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '未配置' }).textContent).toContain('未配置');
    // 清空按钮始终渲染占位（visibility 隐藏 + disabled），避免 trigger 尺寸随有值/无值变化
    const clear = screen.getByRole('button', { name: '清除' });
    expect(clear).toBeTruthy();
    expect(clear.className).toContain('invisible');
    expect((clear as HTMLButtonElement).disabled).toBe(true);
  });

  // 降级路径：value 已配但 providers 未加载/被删（beforeEach mock [] → currentItem=null）
  // → 显纯 modelId 文本（无 IconBox）；x 清除按钮可点
  it('降级路径（providers 未加载/被删 → 纯 modelId）显 modelId + x 清除按钮', () => {
    render(<KeyModelPicker value="glm-5.2" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'glm-5.2' }).textContent).toContain('glm-5.2');
    expect(screen.getByRole('button', { name: '清除' })).toBeTruthy();
  });

  // [v0.0.230] trigger 展示对齐：value 命中 enabled provider 的 model → 显 `${providerLabel} / ${modelLabel}`
  // （对齐 formatModelDisplay 口径，与 ModelPicker / InputModelPicker 一致）
  it('已配且命中 enabled provider → trigger 显 `${providerLabel} / ${modelLabel}`', async () => {
    vi.mocked(listProviders).mockResolvedValue([
      {
        id: 'p1',
        name: 'anthropic_compatible',
        protocolId: 'anthropic_compatible' as never,
        label: '我的 OpenAI',
        baseUrl: '',
        credentials: { key: '' },
        enabled: true,
        models: [
          { modelId: 'gpt-4o', label: 'GPT-4o', contextWindow: 128000, maxOutputTokens: 16384, enabled: true },
        ],
      },
    ]);
    render(<KeyModelPicker value="gpt-4o" onChange={() => {}} />);
    // listProviders 异步 resolve 后 currentItem 命中 → trigger 刷新为 provider / model
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /我的 OpenAI \/ GPT-4o/ }).textContent).toContain('我的 OpenAI / GPT-4o');
    });
    expect(screen.getByRole('button', { name: '清除' })).toBeTruthy();
  });

  it('点 x → onChange(undefined)', () => {
    const onChange = vi.fn();
    render(<KeyModelPicker value="glm-5.2" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('点 trigger → 菜单展开（role=listbox）', async () => {
    render(<KeyModelPicker value={undefined} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '未配置' }));
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeTruthy();
    });
  });

  it('无 enabled provider → 菜单显空状态文案', async () => {
    vi.mocked(listProviders).mockResolvedValue([]);
    render(<KeyModelPicker value={undefined} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '未配置' }));
    await waitFor(() => {
      const menu = screen.queryByRole('listbox');
      expect(menu).toBeTruthy();
      expect(menu?.textContent).toContain('无可用');
    });
  });

  it('enabled provider × enabled model → 菜单渲染分组项', async () => {
    vi.mocked(listProviders).mockResolvedValue([
      {
        id: 'p1',
        name: 'anthropic_compatible',
        protocolId: 'anthropic_compatible' as never,
        label: '我的 OpenAI',
        baseUrl: '',
        credentials: { key: '' },
        enabled: true,
        models: [
          { modelId: 'gpt-4o', label: 'GPT-4o', contextWindow: 128000, maxOutputTokens: 16384, enabled: true },
          { modelId: 'gpt-4o-mini', label: 'GPT-4o-mini', contextWindow: 128000, maxOutputTokens: 16384, enabled: false },
        ],
      },
    ]);
    render(<KeyModelPicker value={undefined} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '未配置' }));
    await waitFor(() => {
      // 仅 enabled model 渲染（gpt-4o-mini disabled 不显示）
      expect(screen.queryByRole('option', { name: /GPT-4o/ })).toBeTruthy();
      expect(screen.queryByRole('option', { name: /GPT-4o-mini/ })).toBeNull();
    });
  });

  it('disabled provider 不进菜单', async () => {
    vi.mocked(listProviders).mockResolvedValue([
      {
        id: 'p1',
        name: 'anthropic_compatible',
        protocolId: 'anthropic_compatible' as never,
        label: 'disabled provider',
        baseUrl: '',
        credentials: { key: '' },
        enabled: false,
        models: [
          { modelId: 'm1', label: 'M1', contextWindow: 0, maxOutputTokens: 0, enabled: true },
        ],
      },
    ]);
    render(<KeyModelPicker value={undefined} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '未配置' }));
    await waitFor(() => {
      expect(screen.queryByRole('option', { name: /M1/ })).toBeNull();
    });
  });

  // [v0.0.165 用户裁决] 模型选择统一 = 只统一样式，不统一选项构成：
  // KeyModelPicker 是**配置默认**的地方，列表里不应含「默认模型」项（那是 InputModelPicker/chat 的语义）。
  it('[v0.0.165] 菜单不含 "默认模型" 项（配置页本身在定义默认，不应把「默认」列进选项）', async () => {
    vi.mocked(listProviders).mockResolvedValue([
      {
        id: 'p1',
        name: 'anthropic_compatible',
        protocolId: 'anthropic_compatible' as never,
        label: 'OpenAI',
        baseUrl: '',
        credentials: { key: '' },
        enabled: true,
        models: [
          { modelId: 'gpt-4o', label: 'GPT-4o', contextWindow: 128000, maxOutputTokens: 16384, enabled: true },
        ],
      },
    ]);
    render(<KeyModelPicker value={undefined} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '未配置' }));
    await waitFor(() => {
      const menu = screen.getByRole('listbox');
      expect(menu).toBeTruthy();
      // 断言 menu 文本不含「默认」（避免任何形式的默认项）
      expect(menu.textContent).not.toContain('默认');
    });
  });

  // [v0.0.165] 搜索框（新 primitive 提供能力）+ 本地过滤
  it('[v0.0.165] 菜单顶部渲染搜索框 + 本地过滤', async () => {
    vi.mocked(listProviders).mockResolvedValue([
      {
        id: 'p1',
        name: 'anthropic_compatible',
        protocolId: 'anthropic_compatible' as never,
        label: 'OpenAI',
        baseUrl: '',
        credentials: { key: '' },
        enabled: true,
        models: [
          { modelId: 'gpt-4o', label: 'GPT-4o', contextWindow: 128000, maxOutputTokens: 16384, enabled: true },
          { modelId: 'claude-sonnet', label: 'Claude Sonnet', contextWindow: 128000, maxOutputTokens: 16384, enabled: true },
        ],
      },
    ]);
    render(<KeyModelPicker value={undefined} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '未配置' }));
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('搜索模型...')).toBeTruthy();
    });
    // 搜索过滤
    fireEvent.change(screen.getByPlaceholderText('搜索模型...'), { target: { value: 'claude' } });
    await waitFor(() => {
      expect(screen.queryByRole('option', { name: /Claude Sonnet/ })).toBeTruthy();
      expect(screen.queryByRole('option', { name: /GPT-4o/ })).toBeNull();
    });
  });
});
