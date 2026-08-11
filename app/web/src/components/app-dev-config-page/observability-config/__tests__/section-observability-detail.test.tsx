/**
 * @vitest-environment jsdom
 * section-observability-detail 单测（v0.0.90.ui 新增 — 覆盖 SecretInput 接入）
 * [v0.0.316] 适配 draft 攒入模式：onSave → onDraftChange，去 save 按钮断言
 * 参考: specs/ui/components/app-dev-config-page/observability-config/section-observability-detail.md
 *       specs/ui/components/framework/primitive-secret-input.md（SecretInput 四态机）
 *
 * 范围：仅校验 secretKey 字段的 SecretInput 接入（其他字段已有手测/spec 覆盖）。
 *   - secretKey 已保存（明文，len>8）→ mask 展示（首4+*+末4）
 *   - secretKey='***'（旧哨兵/短值）→ mask 后视觉等同 '***'（len=3 全 *）
 *   - click display → 编辑态：field 出现，draft 起始空（编辑 secret = 重输）
 *   - 填新值 + click 提交 → onDraftChange 调用，secretKey 为新值
 *   - Esc cancel → draft 不变（仍为原值 mask）
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SectionObservabilityDetail } from '../section-observability-detail';
import type { ObservabilityConfig } from '../types';
import { initI18n } from '../../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

const baseCfg: ObservabilityConfig = {
  id: 'obs_1',
  name: 'Production Tracing',
  type: 'langfuse',
  baseUrl: 'https://cloud.langfuse.com',
  publicKey: 'pk-lf-xxx',
  secretKey: 'sk-lf-secret',
  enabled: true,
  desc: 'main',
  logPhysical: false,
};

describe('SectionObservabilityDetail — secretKey SecretInput 接入（v0.0.90.ui）', () => {
  afterEach(() => cleanup());

  it('secretKey 已保存 → SecretInput mask 展示（len>8 → 首4+*×1+末4）', () => {
    const { container } = render(
      <SectionObservabilityDetail
        initialData={baseCfg}
        isNew={false}
        onBack={() => {}}
        onDraftChange={() => {}}
      />,
    );
    const root = container.querySelector('[data-mode]')!;
    expect(root.getAttribute('data-mode')).toBe('display');
    expect(root.getAttribute('data-empty')).toBe('false');
    // 'sk-lf-secret' len=12 → 'sk-l' + '*'.repeat(12-8)=4 + 'cret' = 'sk-l****cret'
    expect(screen.getByText('sk-l****cret').textContent).toBe('sk-l****cret');
  });

  it('secretKey="***"（旧哨兵/短值）→ mask 视觉等同 "***"（len=3 全 *）', () => {
    const { container } = render(
      <SectionObservabilityDetail
        initialData={{ ...baseCfg, secretKey: '***' }}
        isNew={false}
        onBack={() => {}}
        onDraftChange={() => {}}
      />,
    );
    expect(screen.getByText('***').textContent).toBe('***');
    expect(container.querySelector('[data-mode]')!.getAttribute('data-empty')).toBe('false');
  });

  it('click display → 编辑态：field 出现 draft 起始空；填值 + 提交 → onDraftChange 调用', () => {
    const onDraftChange = vi.fn();
    render(
      <SectionObservabilityDetail
        initialData={baseCfg}
        isNew={false}
        onBack={() => {}}
        onDraftChange={onDraftChange}
      />,
    );
    // click display 进编辑态
    fireEvent.click(screen.getByText('sk-l****cret'));
    const field = screen.getByPlaceholderText('sk-lf-...') as HTMLInputElement;
    // 编辑 secret = 重输（draft 起始空）
    expect(field.value).toBe('');
    // 填新 secret
    fireEvent.change(field, { target: { value: 'sk-new-secret-key' } });
    // commit
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    // [v0.0.316] onDraftChange 被调用，secretKey 为新值（draft 攒入模式）
    expect(onDraftChange).toHaveBeenCalled();
    const lastCall = onDraftChange.mock.calls[onDraftChange.mock.calls.length - 1]![0] as ObservabilityConfig;
    expect(lastCall.secretKey).toBe('sk-new-secret-key');
  });

  it('Esc cancel → secretKey 不变（display 仍展示原 mask）', () => {
    const { container } = render(
      <SectionObservabilityDetail
        initialData={baseCfg}
        isNew={false}
        onBack={() => {}}
        onDraftChange={() => {}}
      />,
    );
    // 进编辑态
    fireEvent.click(screen.getByText('sk-l****cret'));
    const field = screen.getByPlaceholderText('sk-lf-...') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'sk-tmp-will-cancel' } });
    // Esc cancel
    fireEvent.keyDown(field, { key: 'Escape' });
    // 回到 display 态，mask 仍是原 secretKey 的 mask
    expect(container.querySelector('[data-mode]')!.getAttribute('data-mode')).toBe('display');
    expect(screen.getByText('sk-l****cret').textContent).toBe('sk-l****cret');
  });
});
