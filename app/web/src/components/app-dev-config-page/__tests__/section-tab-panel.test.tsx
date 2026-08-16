/**
 * @vitest-environment jsdom
 * section-tab-panel 单测（v0.0.199）— 可观测性 detail 视图隐藏 tab 内 logs group。
 * 参考 specs/ui/components/app-dev-config-page/page-app-settings-merged.md
 *
 * 修复的 bug：observability tab 进入 detail（新增/编辑配置）后往下滚会看到 tab 内「日志」group。
 * 根因：section-tab-panel 的 case 'observability' 无条件渲染 logs group，不感知 SectionObservability
 *   进入了 detail。修复方式：SectionObservability 通过 onDetailViewChange 同步上报，tab-panel 用
 *   obsInDetail 状态条件渲染 logs/标题。
 *
 * 校验点：
 *   - list 态：渲染「可观测性」标题 + 「日志」group（回归保护）
 *   - detail 态（onDetailViewChange(true)）：「可观测性」标题 + 「日志」group 均不渲染
 *   - 返回 list（onDetailViewChange(false)）：「日志」group 恢复渲染
 *
 * vi.mock 用绝对路径（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { useState, useEffect } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

const observabilityPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../observability-config/section-observability'),
);
const logsConfigPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../section-logs-config'),
);
const providersPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../providers/section-providers'),
);
const modelRoutingPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../section-model-routing-plans'),
);

// [T4-blocking 回归教训] mock 可观测计数器：若 models case list↔detail 分支结构不同构
// （children 同位置节点类型变化），React reconciliation 会卸载重挂 Section——计数器递增。
const providersMockState = vi.hoisted(() => ({ mountCount: 0 }));
const plansMockState = vi.hoisted(() => ({ mountCount: 0 }));

// mock SectionObservability：暴露两个按钮模拟 list↔detail 切换（上抛 onDetailViewChange）
vi.mock(observabilityPath, () => ({
  SectionObservability: ({ onDetailViewChange }: { onDetailViewChange?: (v: boolean) => void }) => (
    <div>
      observability-mock
      <button onClick={() => onDetailViewChange?.(true)}>模拟进详情</button>
      <button onClick={() => onDetailViewChange?.(false)}>模拟返回列表</button>
    </div>
  ),
}));
// mock SectionLogsConfig：logs group 不再走 kvGroups，改由 SectionLogsConfig 自行 GET /config/app?group=logs
vi.mock(logsConfigPath, () => ({
  SectionLogsConfig: () => <div>logs-config-mock</div>,
}));
// [T4-blocking 回归] mock 用**真实 useState** 持内部 view state + 挂载计数器 + 挂载时上抛
// list（同真实 section 机制）：list→detail 切换若触发 reconciliation 重挂，内部 state 归零
// （闪回 list）+ mountCount 递增——两条断言都能拦截。
vi.mock(providersPath, () => ({
  SectionProviders: ({ onViewLevelChange }: { onViewLevelChange?: (l: 'list' | 'detail') => void }) => {
    const [level, setLevel] = useState<'list' | 'detail'>('list');
    useEffect(() => {
      providersMockState.mountCount += 1;
      onViewLevelChange?.('list'); // 挂载初始 list（同真实 section：切 tab 重挂后父级复位）
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <div data-testid="providers-mock">
        <span data-testid="providers-mock-level">{level}</span>
        <button
          type="button"
          data-testid="providers-mock-enter"
          onClick={() => { setLevel('detail'); onViewLevelChange?.('detail'); }}
        >
          进详情
        </button>
      </div>
    );
  },
}));
vi.mock(modelRoutingPath, () => ({
  SectionModelRoutingPlans: ({ onViewLevelChange }: { onViewLevelChange?: (l: 'list' | 'detail') => void }) => {
    const [level, setLevel] = useState<'list' | 'detail'>('list');
    useEffect(() => {
      plansMockState.mountCount += 1;
      onViewLevelChange?.('list');
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <div data-testid="plans-mock">
        <span data-testid="plans-mock-level">{level}</span>
        <button
          type="button"
          data-testid="plans-mock-enter"
          onClick={() => { setLevel('detail'); onViewLevelChange?.('detail'); }}
        >
          进详情
        </button>
      </div>
    );
  },
}));

import { SectionTabPanel } from '../section-tab-panel';
import type { SectionTabPanelProps } from '../section-tab-panel';

/** 构造 observability tab 所需的最小 props（logs 由 SectionLogsConfig 自行 GET，不经 kvGroups） */
function renderObservabilityTab() {
  return render(
    <SectionTabPanel
      selectedTab="observability"
      kvGroups={{}}
      defaultModelsDraft={{}}
      onDefaultModelsChange={() => {}}
      onKeyChange={() => {}}
      consolidationDraft={{ enabled: false, dailyTime: '00:00' }}
    />,
  );
}

/** 构造 models tab 所需最小 props */
function renderModelsTab() {
  const props: SectionTabPanelProps = {
    selectedTab: 'models',
    kvGroups: {},
    defaultModelsDraft: {},
    onDefaultModelsChange: () => {},
    onKeyChange: () => {},
    consolidationDraft: { enabled: false, dailyTime: '00:00' },
  };
  return render(<SectionTabPanel {...props} />);
}

describe('SectionTabPanel — observability tab detail 视图隐藏 logs group（v0.0.199）', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('list 态：渲染「可观测性」标题 + 「日志」group（回归保护）', () => {
    renderObservabilityTab();
    expect(screen.getByRole('heading', { name: '可观测性' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '日志' })).toBeTruthy();
    // logs group 渲染 SectionLogsConfig
    expect(screen.getByText('logs-config-mock')).toBeTruthy();
  });

  it('detail 态（onDetailViewChange(true)）：「可观测性」标题 + 「日志」group 均不渲染（核心 bug 修复）', () => {
    renderObservabilityTab();
    // 进详情
    fireEvent.click(screen.getByRole('button', { name: '模拟进详情' }));
    // 标题 + logs group 都应消失
    expect(screen.queryByRole('heading', { name: '可观测性' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '日志' })).toBeNull();
    expect(screen.queryByText('logs-config-mock')).toBeNull();
    // SectionObservability 本体仍渲染（两种态都渲染）
    expect(screen.getByText('observability-mock')).toBeTruthy();
  });

  it('返回 list（onDetailViewChange(false)）：「日志」group 恢复渲染', () => {
    renderObservabilityTab();
    // 进详情 → 隐藏
    fireEvent.click(screen.getByRole('button', { name: '模拟进详情' }));
    expect(screen.queryByRole('heading', { name: '日志' })).toBeNull();
    // 返回 list → 恢复
    fireEvent.click(screen.getByRole('button', { name: '模拟返回列表' }));
    expect(screen.getByRole('heading', { name: '可观测性' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '日志' })).toBeTruthy();
    expect(screen.getByText('logs-config-mock')).toBeTruthy();
  });

  it('切离 observability tab 后 obsInDetail 重置：切回时 logs/标题不被错误隐藏', () => {
    // 覆盖边界：SectionObservability 仅在 observability case 渲染，切走时 unmount（内部 detail state 丢失）。
    // 若 obsInDetail 不重置，切回时 stale=true 会错误隐藏 list 态的 logs/标题。
    const props: SectionTabPanelProps = {
      selectedTab: 'observability',
      kvGroups: {},
      defaultModelsDraft: {},
      onDefaultModelsChange: () => {},
      onKeyChange: () => {},
      consolidationDraft: { enabled: false, dailyTime: '00:00' },
    };
    const { rerender } = render(<SectionTabPanel {...props} />);
    // 进详情 → obsInDetail=true
    fireEvent.click(screen.getByRole('button', { name: '模拟进详情' }));
    expect(screen.queryByRole('heading', { name: '日志' })).toBeNull();
    // 切到 session tab（SectionObservability unmount）
    rerender(<SectionTabPanel {...props} selectedTab="session" />);
    // 切回 observability tab（SectionObservability 重新 mount = list 态）
    rerender(<SectionTabPanel {...props} selectedTab="observability" />);
    // obsInDetail 应已被 useEffect 重置：list 态正常渲染标题 + logs
    expect(screen.getByRole('heading', { name: '可观测性' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '日志' })).toBeTruthy();
    expect(screen.getByText('logs-config-mock')).toBeTruthy();
  });
});

describe('SectionTabPanel — models tab list↔detail 不重挂（T4-blocking 回归）', () => {
  beforeEach(() => {
    cleanup();
    providersMockState.mountCount = 0;
    plansMockState.mountCount = 0;
  });
  afterEach(() => cleanup());

  it('providers 进 detail：不重挂（mountCount 不变）+ 独占渲染（方案库隐藏）+ detail 态保持不闪回', async () => {
    renderModelsTab();
    expect(screen.getByTestId('providers-mock')).toBeTruthy();
    expect(providersMockState.mountCount).toBe(1);
    // 模拟真实 section 内部进详情：setLevel('detail') + 上抛 detail
    fireEvent.click(screen.getByTestId('providers-mock-enter'));
    // 核心断言 1（闪回拦截）：若 list↔detail 结构不同构触发 reconciliation 重挂，
    // section 内部 state 归零回 list + 挂载 effect 再上抛 list → detail 闪回。
    expect(screen.getByTestId('providers-mock-level').textContent).toBe('detail');
    // 核心断言 2（重挂拦截）：mountCount 仍为 1（同实例，未卸载重挂）
    expect(providersMockState.mountCount).toBe(1);
    // 独占渲染：方案库隐藏、h3 标题隐藏
    expect(screen.queryByTestId('plans-mock')).toBeNull();
    expect(screen.queryByRole('heading', { name: '供应商' })).toBeNull();
    expect(screen.getByTestId('providers-mock')).toBeTruthy();
  });

  it('方案库进 detail：不重挂 + providers group（含标题）隐藏 + detail 态保持', () => {
    renderModelsTab();
    expect(plansMockState.mountCount).toBe(1);
    fireEvent.click(screen.getByTestId('plans-mock-enter'));
    expect(screen.getByTestId('plans-mock-level').textContent).toBe('detail');
    expect(plansMockState.mountCount).toBe(1);
    expect(screen.queryByTestId('providers-mock')).toBeNull();
    expect(screen.queryByRole('heading', { name: '供应商' })).toBeNull();
    expect(screen.getByTestId('plans-mock')).toBeTruthy();
  });
});
