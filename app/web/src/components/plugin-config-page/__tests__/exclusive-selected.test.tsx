/**
 * @vitest-environment jsdom
 * v0.0.55 单测 — exclusive EP radio 用 inventory `selected` 字段（修「两红框一 dot」bug）
 * 参考: specs/ui/components/plugin-config-page/component-ext-impl-radio.md（selected 字段契约）
 *       specs/ui/components/plugin-config-page/component-ext-impl-router.md（[v0.0.55] selected 映射）
 *
 * 核心回归（v0.0.55 bug 修复）：
 *   - 旧版 component-ext-impl-router 把 `selected: i.enabled`（按 enabled 瞎猜）
 *     → 多个 enabled=true 时两个 radio 都 border-accent 红框，但 input radio 只一个 checked
 *     → 视觉「两红框一 dot」
 *   - v0.0.55 改 `selected: !!i.selected`（读 inventory 派生字段，单选中语义正确）
 *     → 最多一个红框 + dot 跟随
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentExtImplRouter } from '../component-ext-impl-router';
import type { PluginExtImpl } from '../../../lib/api-client';

afterEach(() => cleanup());

/** 按 implId 文本定位 radio 行（label），再取内部 radio input */
function getRadioInput(implId: string): HTMLInputElement {
  return screen.getByText(implId).closest('label')!.querySelector('input[type=radio]') as HTMLInputElement;
}

/**
 * 构造 exclusive point 的 PluginExtImpl[]（router 直接消费 impl 数组）。
 */
function makeExclusiveImpls(overrides: {
  selectedX?: boolean;
  selectedY?: boolean;
  enabledX?: boolean;
  enabledY?: boolean;
}): PluginExtImpl[] {
  const { selectedX = false, selectedY = false, enabledX = true, enabledY = true } = overrides;
  return [
    {
      pluginId: 'p_excl',
      pointId: 'test_excl',
      implId: 'x',
      type: 'exclusive',
      pluginEnabled: true,
      enabled: enabledX,
      selected: selectedX,
    },
    {
      pluginId: 'p_excl',
      pointId: 'test_excl',
      implId: 'y',
      type: 'exclusive',
      pluginEnabled: true,
      enabled: enabledY,
      selected: selectedY,
    },
  ];
}

describe('ComponentExtImplRouter exclusive — [v0.0.55] radio 用 selected（修「两红框一 dot」）', () => {
  it('selected=true 的 impl 才是 checked radio（不再按 enabled 瞎猜）', () => {
    // x/y 都 enabled=true，但只有 x selected=true（v0.0.55 派生语义）
    const impls = makeExclusiveImpls({ enabledX: true, enabledY: true, selectedX: true, selectedY: false });
    const onSelect = vi.fn();
    render(
      <ComponentExtImplRouter
        pointId="test_excl"
        type="exclusive"
        disabled={false}
        impls={impls}
        onExclusiveSelect={onSelect}
        onToggle={() => {}}
        onReorder={() => {}}
        onConfig={() => {}}
      />,
    );
    // x radio 应 checked（selected=true）
    const radioX = getRadioInput('x');
    const radioY = getRadioInput('y');
    expect(radioX.getAttribute('checked')).not.toBeNull();
    expect(radioY.getAttribute('checked')).toBeNull();
  });

  it('多个 enabled=true 时仍只有 selected 者被 checked（不再「两红框」）', () => {
    // v0.0.54 bug 场景：两个都 enabled=true，旧版会渲染两个 selected → 两红框
    // v0.0.55 修复：后端 inventory 派生 selected 仅一个；前端按 selected 渲染
    const impls = makeExclusiveImpls({
      enabledX: true,
      enabledY: true,
      selectedX: false,
      selectedY: true, // 后端派生 y 为 selected（effective order 最小）
    });
    render(
      <ComponentExtImplRouter
        pointId="test_excl"
        type="exclusive"
        disabled={false}
        impls={impls}
        onExclusiveSelect={() => {}}
        onToggle={() => {}}
        onReorder={() => {}}
        onConfig={() => {}}
      />,
    );
    const radioX = getRadioInput('x');
    const radioY = getRadioInput('y');
    // 仅 y selected → y checked，x 未 checked（修「两红框一 dot」）
    expect(radioY.getAttribute('checked')).not.toBeNull();
    expect(radioX.getAttribute('checked')).toBeNull();
  });

  it('点未选项 → onExclusiveSelect(implId)（父级负责更新 selected）', () => {
    // x selected=true，y selected=false；点 y 应触发 onExclusiveSelect('y')
    const impls = makeExclusiveImpls({ selectedX: true, selectedY: false });
    const onSelect = vi.fn();
    render(
      <ComponentExtImplRouter
        pointId="test_excl"
        type="exclusive"
        disabled={false}
        impls={impls}
        onExclusiveSelect={onSelect}
        onToggle={() => {}}
        onReorder={() => {}}
        onConfig={() => {}}
      />,
    );
    fireEvent.click(getRadioInput('y'));
    expect(onSelect).toHaveBeenCalledWith('y');
  });

  it('fallback：selected 字段缺失时按 false 兜底（兼容旧后端不返 selected）', () => {
    // 旧后端可能不返 selected（缺字段）→ 前端按 false 兜底，不报错
    const impls: PluginExtImpl[] = [
      {
        pluginId: 'p',
        pointId: 'test_excl',
        implId: 'x',
        type: 'exclusive',
        pluginEnabled: true,
        enabled: true,
        // selected 缺失
      },
    ];
    render(
      <ComponentExtImplRouter
        pointId="test_excl"
        type="exclusive"
        disabled={false}
        impls={impls}
        onExclusiveSelect={() => {}}
        onToggle={() => {}}
        onReorder={() => {}}
        onConfig={() => {}}
      />,
    );
    // selected 缺失 → 按 false 兜底，radio 未 checked
    expect(getRadioInput('x').getAttribute('checked')).toBeNull();
  });

  it('[v0.0.179] membership 派生：未列候选 enabled=false + selected=false → radio 非 checked', () => {
    // v0.0.179 新模型契约：exclusive EP active 列表只 1 项（membership 派生），
    //   未列候选（不在 active 列表）inventory 仍序列化进 impls[] 但 enabled=false + selected=false。
    //   前端 radio 按字段值渲染：active 项 checked、未列候选非 checked（验证与新派生规则兼容）。
    const impls: PluginExtImpl[] = [
      {
        pluginId: 'p_excl',
        pointId: 'test_excl',
        implId: 'active',
        type: 'exclusive',
        pluginEnabled: true,
        enabled: true,   // 在 active 列表（membership）
        selected: true,  // active 列表 order 最小者（validator 保证 exclusive 恰好 1 active）
      },
      {
        pluginId: 'p_excl',
        pointId: 'test_excl',
        implId: 'candidate',
        type: 'exclusive',
        pluginEnabled: true,
        enabled: false,  // 未列候选（membership=false，inventory 仍透传以渲染「未选中」状态）
        selected: false,
      },
    ];
    render(
      <ComponentExtImplRouter
        pointId="test_excl"
        type="exclusive"
        disabled={false}
        impls={impls}
        onExclusiveSelect={() => {}}
        onToggle={() => {}}
        onReorder={() => {}}
        onConfig={() => {}}
      />,
    );
    // active 项 selected=true → checked；未列候选 selected=false → 非 checked
    expect(getRadioInput('active').getAttribute('checked')).not.toBeNull();
    expect(getRadioInput('candidate').getAttribute('checked')).toBeNull();
  });
});
