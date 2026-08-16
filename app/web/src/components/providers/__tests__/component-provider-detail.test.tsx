/**
 * @vitest-environment jsdom
 * [v0.0.349] component-provider-detail 单测 — 删除入口（SaveBar 尾部 danger 按钮 + ConfirmModal）
 * 参考: specs/ui/components/providers/section-providers.md（删除入口段）
 *       specs/tech/version_logs/v0.0.349/change_plan.md 决策①②③
 *
 * 校验点：
 *   - 已存 provider（provider 非 null + onDeleted 存在）→ SaveBar 右侧渲染删除按钮
 *   - 新建态（provider=null）→ 不渲染删除入口
 *   - onDeleted 缺省（向后兼容）→ 不渲染删除入口
 *   - 点删除 → ConfirmModal（警示文案）→ 确认 → onDeleted 触发
 *   - 取消 → onDeleted 不触发
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentProviderDetail } from '../component-provider-detail';
import type { ProtocolMeta, ProviderInstance } from '../../../lib/api-client';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

// mock ConfirmModal（简化确认交互；绝对路径，避开 bun+jsdom 相对路径 vi.mock 静默失效）
const modalPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../common/component-confirm-modal'));
vi.mock(modalPath, () => ({
  ConfirmModal: ({ title, body, onOk, onCancel }: { title: string; body: string; onOk: () => void; onCancel: () => void }) => (
    <div data-testid="confirm-modal">
      <span>{title}</span>
      <span>{body}</span>
      <button type="button" onClick={onOk}>ok</button>
      <button type="button" onClick={onCancel}>cancel</button>
    </div>
  ),
}));

const protocols: ProtocolMeta[] = [
  { id: 'anthropic_messages', label: 'Anthropic Messages 风格', path: '/v1/messages' },
];

const savedProvider: ProviderInstance = {
  id: 'p-1',
  name: 'anthropic_compatible',
  protocolId: 'anthropic_messages',
  label: '测试提供商',
  baseUrl: 'https://api.example.com',
  credentials: { key: '***' },
  enabled: true,
  models: [],
};

describe('[v0.0.349] ComponentProviderDetail — 删除入口（决策①②③）', () => {
  afterEach(() => cleanup());

  it('已存 provider + onDeleted → SaveBar 右侧渲染删除按钮（danger）', () => {
    render(
      <ComponentProviderDetail
        provider={savedProvider}
        protocolOptions={protocols}
        onBack={() => {}}
        onSaved={() => {}}
        onDeleted={() => {}}
      />,
    );
    const btn = screen.getByTestId('provider-detail-delete');
    expect(btn.textContent).toBe('删除');
    expect(btn.className).toContain('text-danger'); // danger 配色（照抄既有 danger 先例）
  });

  it('新建态（provider=null）→ 不渲染删除入口', () => {
    render(
      <ComponentProviderDetail
        provider={null}
        protocolOptions={protocols}
        onBack={() => {}}
        onSaved={() => {}}
        onDeleted={() => {}}
      />,
    );
    expect(screen.queryByTestId('provider-detail-delete')).toBeNull();
  });

  it('onDeleted 缺省（向后兼容）→ 不渲染删除入口', () => {
    render(
      <ComponentProviderDetail
        provider={savedProvider}
        protocolOptions={protocols}
        onBack={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(screen.queryByTestId('provider-detail-delete')).toBeNull();
  });

  it('点删除 → ConfirmModal 警示文案 → 确认 → onDeleted 触发一次', () => {
    const onDeleted = vi.fn();
    render(
      <ComponentProviderDetail
        provider={savedProvider}
        protocolOptions={protocols}
        onBack={() => {}}
        onSaved={() => {}}
        onDeleted={onDeleted}
      />,
    );
    fireEvent.click(screen.getByTestId('provider-detail-delete'));
    const modal = screen.getByTestId('confirm-modal');
    expect(modal.textContent).toContain('删除提供商');
    expect(modal.textContent).toContain('方案'); // 通用警示：方案条目将失效
    fireEvent.click(screen.getByText('ok'));
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('confirm-modal')).toBeNull(); // 弹层关闭
  });

  it('取消 → onDeleted 不触发，弹层关闭', () => {
    const onDeleted = vi.fn();
    render(
      <ComponentProviderDetail
        provider={savedProvider}
        protocolOptions={protocols}
        onBack={() => {}}
        onSaved={() => {}}
        onDeleted={onDeleted}
      />,
    );
    fireEvent.click(screen.getByTestId('provider-detail-delete'));
    fireEvent.click(screen.getByText('cancel'));
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-modal')).toBeNull();
  });
});
