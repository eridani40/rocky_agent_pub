/**
 * @vitest-environment jsdom
 * component-model-or-plan-picker 单测（v0.0.347 T6 新增）
 * 参考: specs/ui/components/common/component-model-or-plan-picker.md
 *       specs/tech/version_logs/v0.0.347/change_plan.md 决策㉕
 *
 * 校验点（纯 UI，互斥写入语义由消费方/hook 层负责，不在本组件测试范围）：
 *   describe 1 面板两组渲染 + 选择 + 高亮：
 *   - 两组标题恒显（模型/方案）
 *   - 模型行 provider / model 风格（复刻 ModelPicker）；方案行显示方案名
 *   - 点模型行 → onPickModel 复合 ModelSelection；点方案行 → onPickPlan(planId)
 *   - 选中高亮（模型比 providerId+modelId；方案比 planId；aria-selected）
 *   - 方案空 → 组标题保留 + 「暂无方案」空态（不隐藏组标题）
 *   - 搜索 → 两组同时过滤
 *   describe 2 trigger 显示：
 *   - 未选 → placeholder「选择模型或方案」
 *   - 模型 → formatModelDisplay「provider / model」
 *   - 方案 → 「方案 · <名>」；planName 缺 → plans 反查；反查不到 → planId 兜底
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { __setProvidersCacheForTest, __resetProvidersCacheForTest } from '../../../lib/providers';

beforeAll(async () => {
  await initI18n('zh-CN');
});

import { ModelOrPlanPicker, type ModelOrPlanValue } from '../component-model-or-plan-picker';

/** 测试桩 providers（经 __setProvidersCacheForTest 注入绕过真实 fetch） */
const PROVIDER_STUB = [
  { id: 'p1', label: 'MiniMax', models: [{ modelId: 'glm-5.2', label: 'glm-5.2' }] },
  { id: 'p2', label: 'DeepSeek', models: [{ modelId: 'ds-v4', label: 'ds-v4' }] },
];

const PLANS = [
  { id: 'plan-a', name: '白天主力' },
  { id: 'plan-b', name: '夜间降级' },
];

const defaultProps = {
  value: null as ModelOrPlanValue | null,
  plans: PLANS,
  onPickModel: vi.fn(),
  onPickPlan: vi.fn(),
};

/** 打开面板（点 trigger） */
function open() {
  fireEvent.click(screen.getByRole('button', { name: '选择模型或方案' }));
}

describe('ModelOrPlanPicker 面板两组渲染 + 选择 + 高亮', () => {
  beforeEach(() => {
    cleanup();
    __resetProvidersCacheForTest();
    __setProvidersCacheForTest(PROVIDER_STUB);
  });
  afterEach(() => {
    cleanup();
    __resetProvidersCacheForTest();
  });

  it('打开 → 两组标题恒显（模型/方案）', () => {
    render(<ModelOrPlanPicker {...defaultProps} />);
    open();
    expect(screen.getByText('模型')).toBeTruthy();
    expect(screen.getByText('方案')).toBeTruthy();
  });

  it('模型行 provider / model 风格 + 方案行显示方案名', () => {
    render(<ModelOrPlanPicker {...defaultProps} />);
    open();
    expect(screen.getByRole('option', { name: /MiniMax \/ glm-5\.2/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: '白天主力' })).toBeTruthy();
  });

  it('点模型行 → onPickModel 复合 ModelSelection', () => {
    const onPickModel = vi.fn();
    render(<ModelOrPlanPicker {...defaultProps} onPickModel={onPickModel} />);
    open();
    fireEvent.click(screen.getByRole('option', { name: /MiniMax \/ glm-5\.2/ }));
    expect(onPickModel).toHaveBeenCalledWith({ providerId: 'p1', modelId: 'glm-5.2' });
  });

  it('点方案行 → onPickPlan(planId)', () => {
    const onPickPlan = vi.fn();
    render(<ModelOrPlanPicker {...defaultProps} onPickPlan={onPickPlan} />);
    open();
    fireEvent.click(screen.getByRole('option', { name: '夜间降级' }));
    expect(onPickPlan).toHaveBeenCalledWith('plan-b');
  });

  it('选中高亮：value=模型 → 对应行 aria-selected（方案行不高亮）', () => {
    render(
      <ModelOrPlanPicker
        {...defaultProps}
        value={{ kind: 'model', selection: { providerId: 'p1', modelId: 'glm-5.2' } }}
      />,
    );
    // 带 value 时 trigger 显模型名（非 placeholder）——按显示名打开
    fireEvent.click(screen.getByRole('button', { name: /MiniMax \/ glm-5\.2/ }));
    const modelRow = screen.getByRole('option', { name: /MiniMax \/ glm-5\.2/ });
    const planRow = screen.getByRole('option', { name: '白天主力' });
    expect(modelRow.getAttribute('aria-selected')).toBe('true');
    expect(planRow.getAttribute('aria-selected')).not.toBe('true');
  });

  it('选中高亮：value=方案 → 对应行 aria-selected（模型行不高亮）', () => {
    render(
      <ModelOrPlanPicker
        {...defaultProps}
        value={{ kind: 'plan', planId: 'plan-a', planName: '白天主力' }}
      />,
    );
    // 带 value 时 trigger 显「方案 · <名>」——按显示名打开
    fireEvent.click(screen.getByRole('button', { name: '方案 · 白天主力' }));
    const planRow = screen.getByRole('option', { name: '白天主力' });
    const modelRow = screen.getByRole('option', { name: /MiniMax \/ glm-5\.2/ });
    expect(planRow.getAttribute('aria-selected')).toBe('true');
    expect(modelRow.getAttribute('aria-selected')).not.toBe('true');
  });

  it('方案空 → 组标题保留 + 「暂无方案」空态', () => {
    render(<ModelOrPlanPicker {...defaultProps} plans={[]} />);
    open();
    expect(screen.getByText('方案')).toBeTruthy();
    expect(screen.getByText('暂无方案')).toBeTruthy();
  });

  it('搜索 → 两组同时过滤（模型按 label；方案按 name）', () => {
    render(<ModelOrPlanPicker {...defaultProps} />);
    open();
    const search = document.querySelector('[data-action-key="common.model-or-plan.search"]') as HTMLInputElement;
    expect(search).toBeTruthy();
    fireEvent.change(search, { target: { value: 'glm' } });
    expect(screen.getByRole('option', { name: /MiniMax \/ glm-5\.2/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: '白天主力' })).toBeNull();
    fireEvent.change(search, { target: { value: '夜间' } });
    expect(screen.queryByRole('option', { name: /MiniMax \/ glm-5\.2/ })).toBeNull();
    expect(screen.getByRole('option', { name: '夜间降级' })).toBeTruthy();
  });

  it('点外部收起面板', () => {
    render(<ModelOrPlanPicker {...defaultProps} />);
    open();
    expect(screen.getByText('模型')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('模型')).toBeNull();
  });
});

describe('ModelOrPlanPicker trigger 显示', () => {
  beforeEach(() => {
    cleanup();
    __resetProvidersCacheForTest();
    __setProvidersCacheForTest(PROVIDER_STUB);
  });
  afterEach(() => {
    cleanup();
    __resetProvidersCacheForTest();
  });

  it('未选 → placeholder「选择模型或方案」', () => {
    render(<ModelOrPlanPicker {...defaultProps} />);
    expect(screen.getByRole('button', { name: '选择模型或方案' })).toBeTruthy();
  });

  it('value=模型 → trigger 显 provider / model（formatModelDisplay）', () => {
    render(
      <ModelOrPlanPicker
        {...defaultProps}
        value={{ kind: 'model', selection: { providerId: 'p1', modelId: 'glm-5.2' } }}
      />,
    );
    expect(screen.getByRole('button', { name: /MiniMax \/ glm-5\.2/ })).toBeTruthy();
  });

  it('value=方案 → trigger 显「方案 · <名>」', () => {
    render(
      <ModelOrPlanPicker
        {...defaultProps}
        value={{ kind: 'plan', planId: 'plan-a', planName: '白天主力' }}
      />,
    );
    expect(screen.getByRole('button', { name: '方案 · 白天主力' })).toBeTruthy();
  });

  it('value=方案但 planName 空 → 从 plans 反查补齐', () => {
    render(
      <ModelOrPlanPicker {...defaultProps} value={{ kind: 'plan', planId: 'plan-b', planName: '' }} />,
    );
    expect(screen.getByRole('button', { name: '方案 · 夜间降级' })).toBeTruthy();
  });

  it('value=方案 planName 空 + plans 反查不到 → planId 兜底', () => {
    render(
      <ModelOrPlanPicker {...defaultProps} value={{ kind: 'plan', planId: 'ghost', planName: '' }} />,
    );
    expect(screen.getByRole('button', { name: '方案 · ghost' })).toBeTruthy();
  });

  it('ns=studio → 同构 keys 生效（placeholder 显 studio 文案）', () => {
    render(<ModelOrPlanPicker {...defaultProps} ns="studio" />);
    expect(screen.getByRole('button', { name: '选择模型或方案' })).toBeTruthy();
  });
});
