/**
 * @vitest-environment jsdom
 * [v0.0.53] component-provider-fields 单测 — protocol 单选 + 拼接地址动态展示
 * [v0.0.90.ui] apiKey 改 primitive-secret-input：新增 mask 展示 + commit 流转断言
 * 参考: specs/ui/components/providers/component-provider-fields.md（spec）
 *       specs/ui/components/framework/primitive-secret-input.md（SecretInput 四态机）
 *
 * 校验点：
 *   - 含 protocol 单选（复用 KeyChoiceCards → 非 native <select>）
 *   - 含拼接地址展示（mono read-only）
 *   - 拼接地址 = baseUrl + selectedProtocol.path，随 baseUrl 输入与 protocol 选择实时变化
 *   - protocol 选择 change → 上抛 onChange({ protocolId: value })
 *   - [v0.0.90.ui] apiKey = SecretInput：data-mode/data-empty；
 *     已保存值走 mask 展示；click display → 编辑态 field；click commit → onCommit 上抛
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentProviderFields, type ProviderDraftFields } from '../component-provider-fields';
import type { ProtocolMeta } from '../../../lib/api-client';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('en');
});

const protocols: ProtocolMeta[] = [
  { id: 'anthropic_messages', label: 'Anthropic Messages 风格', path: '/v1/messages' },
];

const baseDraft: ProviderDraftFields = {
  label: 'P',
  baseUrl: 'https://api.anthropic.com',
  apiKey: '***',
  enabled: true,
  protocolId: 'anthropic_messages',
};

describe('[v0.0.53] ComponentProviderFields — protocol + 拼接地址', () => {
  afterEach(() => cleanup());

  it('含 protocol 单选控件（选项卡片按钮，非原生 <select>）', () => {
    const { container } = render(<ComponentProviderFields draft={baseDraft} onChange={() => {}} protocolOptions={protocols} />);
    // _conventions.md §10 硬规则：禁原生 select；KeyChoiceCards 渲染按钮卡片（aria-pressed 标记选中）
    // [v0.0.350] 类型卡插顶部后首卡锚失效 → 收敛到 protocol testid 容器内查询
    const card = container.querySelector('[data-testid="provider-field-protocol"] button[aria-pressed]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.tagName).not.toBe('SELECT');
    expect(card.textContent).toContain('anthropic_messages');
  });

  it('含拼接地址展示 = baseUrl + selectedProtocol.path', () => {
    render(<ComponentProviderFields draft={baseDraft} onChange={() => {}} protocolOptions={protocols} />);
    expect(screen.getByText('https://api.anthropic.com/v1/messages').textContent).toContain('https://api.anthropic.com/v1/messages');
  });

  it('改 baseUrl → 拼接地址实时变（derived，无本地状态）', () => {
    const { rerender } = render(<ComponentProviderFields draft={baseDraft} onChange={() => {}} protocolOptions={protocols} />);
    expect(screen.getByText('https://api.anthropic.com/v1/messages')).toBeTruthy();
    // 模拟父级更新 draft.baseUrl
    rerender(<ComponentProviderFields draft={{ ...baseDraft, baseUrl: 'https://test-realtime.example.com' }} onChange={() => {}} protocolOptions={protocols} />);
    expect(screen.getByText('https://test-realtime.example.com/v1/messages')).toBeTruthy();
  });

  it('baseUrl 空 + protocol 已选 → 拼接地址展示 path 部分', () => {
    const empty: ProviderDraftFields = { ...baseDraft, baseUrl: '' };
    render(<ComponentProviderFields draft={empty} onChange={() => {}} protocolOptions={protocols} />);
    // 空态：previewUrl = '' + '/v1/messages' = '/v1/messages'
    expect(screen.getByText('/v1/messages').textContent).toContain('/v1/messages');
  });

  it('protocol 下拉切换 → onChange 上抛 { protocolId }', () => {
    const onChange = vi.fn();
    const { container } = render(<ComponentProviderFields draft={baseDraft} onChange={onChange} protocolOptions={protocols} />);
    // KeyChoiceCards 渲染按钮卡片（aria-pressed 标记选中）
    // [v0.0.350] 类型卡插顶部后首卡锚失效 → 收敛到 protocol testid 容器内查询
    fireEvent.click(container.querySelector('[data-testid="provider-field-protocol"] button[aria-pressed]')!);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ protocolId: 'anthropic_messages' }));
  });

  it('protocol label 通过 sr-only span 暴露（前端 choice cards 显示 id，sr-only 含 label）', () => {
    render(<ComponentProviderFields draft={baseDraft} onChange={() => {}} protocolOptions={protocols} />);
    expect(screen.getByText('Anthropic Messages 风格').textContent).toContain('Anthropic Messages 风格');
  });

  // [v0.0.90.ui] apiKey = SecretInput：mask 展示 + commit 流转（替换旧 <input type="password">）
  it('apiKey 是 SecretInput：data-mode="display" + data-empty="false" + mask 展示', () => {
    const { container } = render(<ComponentProviderFields draft={baseDraft} onChange={() => {}} protocolOptions={protocols} />);
    const root = container.querySelector('[data-mode]')!;
    expect(root.getAttribute('data-mode')).toBe('display');
    expect(root.getAttribute('data-empty')).toBe('false');
    // mask('***') len=3 → '***'
    expect(screen.getByText('***').textContent).toBe('***');
  });

  it('apiKey commit：click display → 填 field → click commit → onChange({ apiKey: next })', () => {
    const onChange = vi.fn();
    render(<ComponentProviderFields draft={baseDraft} onChange={onChange} protocolOptions={protocols} />);
    // 进编辑态
    fireEvent.click(screen.getByText('***'));
    const field = screen.getByPlaceholderText('sk-...') as HTMLInputElement;
    // 编辑态 draft 起始为空（spec：编辑 secret = 重输）
    expect(field.value).toBe('');
    // 填新 key
    fireEvent.change(field, { target: { value: 'sk-newkey-12345' } });
    // 提交（en locale：commit aria-label = Commit）
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-newkey-12345' }));
  });

  it('apiKey 空（draft.apiKey=""）→ data-empty="true"，display 走 placeholder', () => {
    const empty: ProviderDraftFields = { ...baseDraft, apiKey: '' };
    const { container } = render(<ComponentProviderFields draft={empty} onChange={() => {}} protocolOptions={protocols} />);
    const root = container.querySelector('[data-mode]')!;
    expect(root.getAttribute('data-empty')).toBe('true');
    // edit 按钮在空态下不渲染（SecretInput spec：空态用 click display 进入编辑）
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});
