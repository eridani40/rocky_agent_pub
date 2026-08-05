/**
 * @vitest-environment jsdom
 * component-token-stats-controls 单测 —— 控制条 state 管理（含 model 筛选下拉）
 * 参考: specs/ui/components/studio-page/component-token-stats.md
 *       specs/ui/components/_conventions.md §10（禁原生 select）/ §11（尺寸恒定）
 *
 * 覆盖 T2 UT 范围（test-plan §新 UT）：
 *   - 4 chip 组受控切换（粒度/类型/视图，回调触发）
 *   - 范围下拉选项（团队 + 全 member + leader 标识）
 *   - model 筛选下拉：defaultModel 有/无时的显隐 + 选项
 *   - 单日粒度下日期 input 显隐（尺寸恒定：用条件渲染但 flex 项占位）
 *   - 禁原生 select（_conventions §10）
 *
 * 定位策略：产品代码 data-testid 已移除，改语义定位（chip = button 文案；下拉触发 = 当前值文案；
 *   下拉列表项 = 选项文案 button；日期 = input[type=date]）。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { TokenStatsControls } from '../component-token-stats-controls';
import type { Member } from '../squad-types';
import type { AvailableModel, Granularity, KindFilter, ViewMode } from '../component-token-stats-types';

beforeAll(async () => { await initI18n('zh-CN'); });
afterEach(() => cleanup());

function mkMember(over: Partial<Member> = {}): Member {
  return {
    id: 'm1', squadId: 's1', sessionId: 'sess-m1', name: 'Alice', role: 'mate',
    tools: [], skillConfig: { mode: 'inherit', overrides: {} },
    state: 'deployed', version: 1, createdAt: '', updatedAt: '',
    ...over,
  };
}

interface Props {
  granularity?: Granularity;
  scope?: string;
  members?: Member[];
  kind?: KindFilter;
  view?: ViewMode;
  selectedDate?: string;
  modelSelection?: string;
  availableModels?: AvailableModel[];
}

function renderControls(props: Props = {}, handlers: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const members = props.members ?? [
    mkMember({ id: 'leader1', name: 'Atlas', role: 'leader' }),
    mkMember({ id: 'm1', name: 'Nova', role: 'mate' }),
  ];
  render(
    <TokenStatsControls
      granularity={props.granularity ?? 'day'}
      scope={props.scope ?? '__team__'}
      members={members}
      kind={props.kind ?? 'total'}
      view={props.view ?? 'timeline'}
      selectedDate={props.selectedDate ?? '2026-07-05'}
      modelSelection={props.modelSelection ?? '__all__'}
      availableModels={props.availableModels}
      onGranularity={handlers.onGranularity ?? vi.fn()}
      onScope={handlers.onScope ?? vi.fn()}
      onKind={handlers.onKind ?? vi.fn()}
      onView={handlers.onView ?? vi.fn()}
      onSelectedDate={handlers.onSelectedDate ?? vi.fn()}
      onModelSelection={handlers.onModelSelection ?? vi.fn()}
    />,
  );
}

// —— 语义定位辅助 —— //
/** 范围下拉触发按钮（当前值文案，缺省「整个团队」） */
const scopeTrigger = () => screen.getByRole('button', { name: /整个团队/ });
/** model 下拉触发按钮（当前值文案，缺省「全部模型」） */
const modelTrigger = () => screen.getByRole('button', { name: /全部模型/ });
/** 范围下拉列表显隐信号：member 选项「Nova」仅在列表展开时渲染 */
const scopeListPresent = () => screen.queryByRole('button', { name: 'Nova' });
/** 日期 input（仅 hour 粒度渲染） */
const dateInput = () => document.querySelector('input[type="date"]');

describe('TokenStatsControls —— 控制条 state 管理', () => {
  it('渲染 4 chip 组（粒度/范围/类型/视图）+ 日期缺省隐（day 粒度）', () => {
    renderControls();
    // 粒度 chip 组（跨天/单日）
    expect(screen.getByRole('button', { name: '跨天' })).toBeTruthy();
    // 范围下拉触发
    expect(scopeTrigger()).toBeTruthy();
    // 类型 chip 组（总览）
    expect(screen.getByRole('button', { name: '总览' })).toBeTruthy();
    // 视图 chip 组（时间轴）
    expect(screen.getByRole('button', { name: '时间轴' })).toBeTruthy();
    // day 粒度 → 日期 input 不渲染
    expect(dateInput()).toBeNull();
  });

  it('chip 组受控：点击 → 回调触发', () => {
    const onGranularity = vi.fn();
    const onKind = vi.fn();
    const onView = vi.fn();
    renderControls({}, { onGranularity, onKind, onView });
    fireEvent.click(screen.getByRole('button', { name: '单日' }));
    expect(onGranularity).toHaveBeenCalledWith('hour');
    fireEvent.click(screen.getByRole('button', { name: '输入' }));
    expect(onKind).toHaveBeenCalledWith('input');
    fireEvent.click(screen.getByRole('button', { name: '日历' }));
    expect(onView).toHaveBeenCalledWith('calendar');
  });

  it('单日粒度 → 日期 input 渲染', () => {
    renderControls({ granularity: 'hour' });
    expect(dateInput()).toBeTruthy();
  });

  it('范围下拉打开 → 列表含「整个团队」+ 全 member（leader 标「队长」）', () => {
    renderControls();
    fireEvent.click(scopeTrigger());
    // 列表展开：member 选项出现
    expect(screen.getByRole('button', { name: 'Nova' })).toBeTruthy();
    // leader 选项（Atlas + 队长 hint）
    const leaderOpt = screen.getByRole('button', { name: /Atlas/ });
    expect(leaderOpt).toBeTruthy();
    expect(leaderOpt.textContent).toContain('队长');
    // 「整个团队」选项 = 触发按钮 + 列表选项两个同名 button
    expect(screen.getAllByRole('button', { name: /整个团队/ }).length).toBe(2);
  });

  it('范围选项点击 → onScope 回调', () => {
    const onScope = vi.fn();
    renderControls({}, { onScope });
    fireEvent.click(scopeTrigger());
    fireEvent.click(screen.getByRole('button', { name: 'Nova' }));
    expect(onScope).toHaveBeenCalledWith('m1');
  });

  it('回归：真实鼠标序列 mousedown(item)→click 不丢选中（outside-close 不得误关列表）', async () => {
    // 真实浏览器事件序：mousedown → (React 处理) → mouseup → click。
    // 若 outside-close 只认触发按钮（列表是其兄弟节点），mousedown 命中 window 监听 →
    // setOpen(false) → click 派发前列表已卸载 → item onClick 永不触发（v0.0.194 验收 bug）。
    // 正确行为：列表在 wrap 容器内，mousedown 不触发关闭，click 正常选中。
    const onScope = vi.fn();
    renderControls({}, { onScope });
    fireEvent.click(scopeTrigger());
    // outside-close 监听 setTimeout(0) 延迟注册，等一拍再模拟后续事件
    await new Promise((r) => setTimeout(r, 0));
    const item = screen.getByRole('button', { name: 'Nova' });
    fireEvent.mouseDown(item);
    // mousedown 后列表必须仍在（未被 outside-close 关掉）
    expect(scopeListPresent()).toBeTruthy();
    fireEvent.click(item);
    expect(onScope).toHaveBeenCalledWith('m1');
    // 选中后列表关闭
    expect(scopeListPresent()).toBeNull();
  });

  it('outside-close：mousedown 容器外 → 列表关闭', async () => {
    renderControls();
    fireEvent.click(scopeTrigger());
    expect(scopeListPresent()).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.mouseDown(document.body);
    expect(scopeListPresent()).toBeNull();
  });

  it('禁原生 select（_conventions §10）—— 全控件无 <select>', () => {
    renderControls({ granularity: 'hour' }); // 含日期 input 但不是 select
    expect(document.querySelectorAll('select').length).toBe(0);
  });
});

describe('TokenStatsControls —— model 筛选下拉（availableModels 数据源）', () => {
  it('无 availableModels → model 下拉不渲染', () => {
    renderControls(); // availableModels undefined
    expect(screen.queryByRole('button', { name: /全部模型/ })).toBeNull();
  });

  it('空 availableModels → model 下拉不渲染（仅「全部」时隐藏）', () => {
    renderControls({ availableModels: [] });
    expect(screen.queryByRole('button', { name: /全部模型/ })).toBeNull();
  });

  it('有 availableModels → model 下拉渲染 + 选项含「全部」+ 每个 distinct model', () => {
    renderControls({
      availableModels: [
        { providerId: 'p1', modelId: 'claude-sonnet', label: 'p1/claude-sonnet' },
        { providerId: 'p2', modelId: 'gpt-4', label: 'p2/gpt-4' },
      ],
    });
    expect(modelTrigger()).toBeTruthy();
    fireEvent.click(modelTrigger());
    // 「全部模型」选项 = 触发 + 列表选项两个同名 button
    expect(screen.getAllByRole('button', { name: /全部模型/ }).length).toBe(2);
    expect(screen.getByRole('button', { name: 'p1/claude-sonnet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'p2/gpt-4' })).toBeTruthy();
  });

  it('availableModels 含 __unknown__ → 选项 label 显「未知模型」', () => {
    renderControls({
      availableModels: [{ providerId: '__unknown__', modelId: '__unknown__', label: '未知模型' }],
    });
    fireEvent.click(modelTrigger());
    // 下拉列表渲染（含 __unknown__ 条目）
    expect(screen.getByRole('button', { name: '未知模型' })).toBeTruthy();
  });

  it('model 下拉点击 → onModelSelection 回调（__all__ 或 provider/model 格式）', () => {
    const onModelSelection = vi.fn();
    renderControls(
      { availableModels: [{ providerId: 'p1', modelId: 'sonnet', label: 'p1/sonnet' }] },
      { onModelSelection },
    );
    fireEvent.click(modelTrigger());
    fireEvent.click(screen.getByRole('button', { name: 'p1/sonnet' }));
    expect(onModelSelection).toHaveBeenCalledWith('p1/sonnet');
  });

  it('model 维度是筛选维度（不影响堆积）—— kind chip 仍是 5 类', () => {
    renderControls({ availableModels: [{ providerId: 'p1', modelId: 'sonnet', label: 'p1/sonnet' }] });
    expect(screen.getByRole('button', { name: '总览' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '输入' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '输出' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '缓存' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '缓存率' })).toBeTruthy();
  });
});

describe('TokenStatsControls —— 类型 chip 覆盖（序列化渲染口径）', () => {
  it('cacheRate chip 渲染（验证口径切换可触发，为后续 % 单位渲染铺路）', () => {
    const onKind = vi.fn();
    renderControls({}, { onKind });
    fireEvent.click(screen.getByRole('button', { name: '缓存率' }));
    expect(onKind).toHaveBeenCalledWith('cacheRate');
  });
});
