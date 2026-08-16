/**
 * @vitest-environment jsdom
 * component-model-routing-plan-editor 单测（v0.0.347 UI v2：7 列行 + 弹层 + 拖拽排序）。
 * 参考 specs/prd/model-routing-demo-v2.html（冻结视觉契约）
 *       specs/tech/version_logs/v0.0.347/change_plan.md 决策⑪~⑮
 *
 * 校验点：
 *   - 条目行渲染 / 添加
 *   - 手柄 dragstart → 目标行 drop → splice 排序 + reindexPriorities（决策⑭）
 *   - ToggleSwitch 翻转（enabled 写回）
 *   - 时钟 icon：active 态 + tooltip fmtHours；点开时间弹层（真 HourGridPicker）
 *   - 弹层草稿 → 确定 → timeCondition 写回 + 弹层关；清除定时 → timeCondition 删除
 *   - 弹层互斥 + 点空白关（草稿丢弃）
 *   - ⋯ 菜单 → 删除 ConfirmModal → 行删除 + reindex
 *   - 熔断区常显（5 参数 + 默认值 hint；空串回默认）
 *   - 本地预检实时显示 + 服务端 400 透传
 *   - status 按 pid+mid 匹配 badge（决策⑰）
 *   - 纯函数迁 lib：validatePlanLocal / reindexPriorities / DEFAULT_CIRCUIT
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useState } from 'react';
import { initI18n } from '../../../i18n';
import { ModelRoutingPlanEditor } from '../component-model-routing-plan-editor';
import { validatePlanLocal, reindexPriorities, DEFAULT_CIRCUIT } from '../model-routing-plan-lib';
import type { ModelRoutingPlan, RoutingItem, ModelRoutingStatus } from '../model-routing-types';
import type { ProviderItem } from '../../../lib/providers';

beforeAll(async () => {
  await initI18n('zh-CN');
});

// mock ModelPicker（绝对路径，避开 bun+jsdom 并发相对路径失效）
const modelPickerPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../chat/ModelPicker'),
);
vi.mock(modelPickerPath, () => ({
  ModelPicker: ({ value, onChange }: { value: { providerId: string; modelId: string } | null; onChange: (s: { providerId: string; modelId: string }) => void }) => (
    <div>
      <span>{value ? `${value.providerId}/${value.modelId}` : '未配置'}</span>
      <button type="button" onClick={() => onChange({ providerId: 'p1', modelId: 'm1' })}>pick</button>
    </div>
  ),
}));

// mock ConfirmModal（简化删除确认交互）
const modalPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../common/component-confirm-modal'));
vi.mock(modalPath, () => ({
  ConfirmModal: ({ title, onOk, onCancel }: { title: string; onOk: () => void; onCancel: () => void }) => (
    <div data-testid="confirm-modal">
      <span>{title}</span>
      <button type="button" onClick={onOk}>ok</button>
      <button type="button" onClick={onCancel}>cancel</button>
    </div>
  ),
}));

/** 构造条目（enabled 缺省 true） */
function item(partial: Partial<RoutingItem> = {}): RoutingItem {
  return { providerId: 'p1', modelId: 'm1', priority: 1, enabled: true, ...partial };
}

function plan(items: RoutingItem[] = [item()], name = '测试方案'): ModelRoutingPlan {
  return { id: 'plan-1', name, items, createdAt: Date.now() };
}

/** 受控 wrapper（onChange 闭环） */
function Controlled({
  initial, serverError, status,
}: { initial: ModelRoutingPlan; serverError?: string | null; status?: ModelRoutingStatus | null }) {
  const [value, setValue] = useState(initial);
  return <ModelRoutingPlanEditor value={value} onChange={setValue} serverError={serverError} status={status} />;
}

/** 行序（ModelPicker mock 显示 pid/mid → 拼接断言顺序） */
const rowTexts = () => screen.getAllByTestId('plan-editor-item').map((el) => el.textContent ?? '');

describe('ModelRoutingPlanEditor — 条目行与拖拽排序', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('渲染条目行 + 添加按钮 + 熔断区常显（决策⑮）', () => {
    render(<Controlled initial={plan([item()])} />);
    expect(screen.getAllByTestId('plan-editor-item')).toHaveLength(1);
    expect(screen.getByTestId('plan-editor-add-item')).toBeTruthy();
    expect(screen.getByTestId('plan-editor-circuit')).toBeTruthy(); // 常显，无折叠开关
    expect(screen.queryByTestId('plan-editor-circuit-toggle')).toBeNull();
  });

  it('添加条目 → 行 +1（priority 顺延）', () => {
    render(<Controlled initial={plan([item({ modelId: 'a' })])} />);
    fireEvent.click(screen.getByTestId('plan-editor-add-item'));
    expect(screen.getAllByTestId('plan-editor-item')).toHaveLength(2);
    expect(screen.getAllByTestId('plan-editor-item')[1]!.textContent).toContain('未配置'); // 新行空 picker
  });

  it('手柄 dragstart 行2(b) → drop 行3(c) → 顺序 a,c,b + reindex（决策⑭）', () => {
    render(
      <Controlled
        initial={plan([
          item({ modelId: 'a', priority: 1 }),
          item({ modelId: 'b', priority: 2 }),
          item({ modelId: 'c', priority: 3 }),
        ])}
      />,
    );
    const rows = screen.getAllByTestId('plan-editor-item');
    const handles = screen.getAllByTestId('plan-editor-item-handle');
    fireEvent.dragStart(handles[1]!); // 抓 b
    fireEvent.dragOver(rows[2]!, { dataTransfer: { dropEffect: 'move' } });
    fireEvent.drop(rows[2]!, { dataTransfer: {} });
    const texts = rowTexts();
    // splice(1,1) 移除 b → [a,c]，splice(2,0,b) → [a,c,b]；序号列重排 1/2/3
    expect(texts[0]).toContain('p1/a');
    expect(texts[1]).toContain('p1/c');
    expect(texts[2]).toContain('p1/b');
  });

  it('drop 到自身 → 无变化', () => {
    render(<Controlled initial={plan([item({ modelId: 'a' }), item({ modelId: 'b' })])} />);
    const rows = screen.getAllByTestId('plan-editor-item');
    fireEvent.dragStart(screen.getAllByTestId('plan-editor-item-handle')[0]!);
    fireEvent.drop(rows[0]!, { dataTransfer: {} });
    expect(rowTexts()[0]).toContain('p1/a');
    expect(rowTexts()[1]).toContain('p1/b');
  });

  it('enabled 开关：ToggleSwitch 点击翻转 → data-enabled false + 行透明', () => {
    render(<Controlled initial={plan([item()])} />);
    const wrapper = screen.getByTestId('plan-editor-enabled');
    expect(wrapper.getAttribute('data-enabled')).toBe('true');
    fireEvent.click(wrapper.querySelector('button')!);
    expect(screen.getByTestId('plan-editor-enabled').getAttribute('data-enabled')).toBe('false');
    expect(screen.getAllByTestId('plan-editor-item')).toHaveLength(1); // 停用保留配置
  });
});

describe('ModelRoutingPlanEditor — 时间弹层（决策⑫）', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('时钟 icon：无时间 data-active=false；有时间 active + tooltip fmtHours', () => {
    render(
      <Controlled
        initial={plan([item({ timeCondition: { hours: [21, 22, 23] } })])}
      />,
    );
    const clock = screen.getByTestId('plan-editor-item-time');
    expect(clock.getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('plan-editor-time-tooltip').textContent).toBe('21:00-24:00');
  });

  it('点时钟开弹层（真 HourGridPicker）→ 拖 1→3 + 确定 → 写回 + 弹层关', () => {
    render(<Controlled initial={plan([item()])} />);
    expect(screen.getByTestId('plan-editor-item-time').getAttribute('data-active')).toBe('false');
    fireEvent.click(screen.getByTestId('plan-editor-item-time'));
    expect(screen.getByTestId('time-popover')).toBeTruthy();
    // 弹层内草稿操作（真组件：mousedown 1 → mouseenter 3 → mouseup）
    fireEvent.mouseDown(screen.getByTestId('hour-cell-1'));
    fireEvent.mouseEnter(screen.getByTestId('hour-cell-3'));
    fireEvent.mouseUp(screen.getByTestId('hour-grid'));
    fireEvent.click(screen.getByTestId('hour-grid-confirm'));
    // 写回：tooltip 出现 + 弹层关
    expect(screen.getByTestId('plan-editor-item-time').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('plan-editor-time-tooltip').textContent).toBe('01:00-04:00');
    expect(screen.queryByTestId('time-popover')).toBeNull();
  });

  it('弹层「清除定时」→ timeCondition 删除（icon 回灰）+ 弹层关', () => {
    render(<Controlled initial={plan([item({ timeCondition: { hours: [2, 3] } })])} />);
    fireEvent.click(screen.getByTestId('plan-editor-item-time'));
    fireEvent.click(screen.getByTestId('hour-grid-clear-time'));
    expect(screen.getByTestId('plan-editor-item-time').getAttribute('data-active')).toBe('false');
    expect(screen.queryByTestId('plan-editor-time-tooltip')).toBeNull();
    expect(screen.queryByTestId('time-popover')).toBeNull();
  });

  it('弹层草稿丢弃：开弹层改草稿后点空白 → 关闭且 value 不变', () => {
    render(<Controlled initial={plan([item({ timeCondition: { hours: [2, 3] } })])} />);
    fireEvent.click(screen.getByTestId('plan-editor-item-time'));
    fireEvent.mouseDown(screen.getByTestId('hour-cell-10')); // 草稿加选（未确定）
    fireEvent.mouseUp(screen.getByTestId('hour-grid'));
    fireEvent.mouseDown(document.body); // 点空白关
    expect(screen.queryByTestId('time-popover')).toBeNull();
    // 基线未写回：tooltip 仍是原时段
    expect(screen.getByTestId('plan-editor-time-tooltip').textContent).toBe('02:00-04:00');
  });
});

describe('ModelRoutingPlanEditor — 删除条目 + 熔断区 + 状态', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('⋯ 菜单 → 删除 → ConfirmModal（demo 文案）→ ok → 行删除 + reindex', () => {
    render(
      <Controlled
        initial={plan([item({ modelId: 'a' }), item({ modelId: 'b' })])}
      />,
    );
    fireEvent.click(screen.getAllByTestId('plan-editor-item-more')[0]!);
    fireEvent.click(screen.getByTestId('plan-editor-item-delete'));
    expect(screen.getByTestId('confirm-modal').textContent).toContain('删除路由条目');
    fireEvent.click(screen.getByTestId('confirm-modal').querySelector('button')!); // ok
    expect(screen.getAllByTestId('plan-editor-item')).toHaveLength(1);
    expect(rowTexts()[0]).toContain('p1/b');
  });

  it('熔断 5 参数默认值 4/2/60/0.6/10 + 默认 hint', () => {
    render(<Controlled initial={plan([item()])} />);
    expect((screen.getByTestId('plan-editor-circuit-failureThreshold') as HTMLInputElement).value).toBe('4');
    expect((screen.getByTestId('plan-editor-circuit-successThreshold') as HTMLInputElement).value).toBe('2');
    expect((screen.getByTestId('plan-editor-circuit-timeoutSeconds') as HTMLInputElement).value).toBe('60');
    expect((screen.getByTestId('plan-editor-circuit-errorRateThreshold') as HTMLInputElement).value).toBe('0.6');
    expect((screen.getByTestId('plan-editor-circuit-minRequests') as HTMLInputElement).value).toBe('10');
  });

  it('熔断输入空串 → 回默认（显示 4）', () => {
    render(<Controlled initial={plan([item()])} />);
    const input = screen.getByTestId('plan-editor-circuit-failureThreshold') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect((screen.getByTestId('plan-editor-circuit-failureThreshold') as HTMLInputElement).value).toBe('4');
  });

  it('serverError 非空 → 透传展示', () => {
    render(<Controlled initial={plan([item()])} serverError="same model cannot have 2 time-condition items" />);
    expect(screen.getByTestId('plan-editor-server-error').textContent).toContain('same model cannot have 2 time-condition items');
  });

  it('本地预检错误实时显示（UC-21 场景）', () => {
    render(
      <Controlled
        initial={plan([item(), item({ timeCondition: { hours: [2] }, priority: 2 })])}
      />,
    );
    expect(screen.getByTestId('plan-editor-validation').textContent).toContain('时间');
  });

  it('status 按 pid+mid 匹配 → badge 渲染；不匹配不渲染（决策⑰）', () => {
    const status: ModelRoutingStatus = {
      planId: 'plan-1',
      items: [{ providerId: 'p1', modelId: 'm1', presentation: 'abnormal', remainingSeconds: 30 }],
    } as unknown as ModelRoutingStatus;
    const { rerender } = render(
      <ModelRoutingPlanEditor
        value={plan([item({ providerId: 'p1', modelId: 'm1' }), item({ providerId: 'p2', modelId: 'x' })])}
        onChange={() => {}}
        status={status}
      />,
    );
    expect(screen.getAllByTestId('circuit-status')).toHaveLength(1); // 仅匹配行
    rerender(
      <ModelRoutingPlanEditor
        value={plan([item({ providerId: 'p1', modelId: 'm1' })])}
        onChange={() => {}}
        status={null}
      />,
    );
    expect(screen.queryByTestId('circuit-status')).toBeNull();
  });
});

describe('lib 纯函数（validatePlanLocal / reindexPriorities / DEFAULT_CIRCUIT）', () => {
  it('UC-22：同模型 2 带时间 → sameModel2Time；UC-23：2 不带 → sameModel2NoTime', () => {
    const twoTime = plan([item({ timeCondition: { hours: [2] }, priority: 1 }), item({ timeCondition: { hours: [5] }, priority: 2 })]);
    expect(validatePlanLocal(twoTime)).toContain('modelRouting.validate.sameModel2Time');
    const twoNoTime = plan([item({ priority: 1 }), item({ priority: 2 })]);
    expect(validatePlanLocal(twoNoTime)).toContain('modelRouting.validate.sameModel2NoTime');
  });

  it('UC-21：带时间在下 → timeAboveUnconditional；合法组合无错', () => {
    const bad = plan([item({ priority: 1 }), item({ timeCondition: { hours: [2] }, priority: 2 })]);
    expect(validatePlanLocal(bad)).toContain('modelRouting.validate.timeAboveUnconditional');
    const ok = plan([item({ timeCondition: { hours: [2] }, priority: 1 }), item({ priority: 2 })]);
    expect(validatePlanLocal(ok)).toEqual([]);
  });

  it('reindexPriorities 按序重算；DEFAULT_CIRCUIT = 4/2/60/0.6/10', () => {
    const re = reindexPriorities([item({ modelId: 'b', priority: 9 }), item({ modelId: 'a', priority: 3 })]);
    expect(re.map((i) => i.priority)).toEqual([1, 2]);
    expect(DEFAULT_CIRCUIT).toEqual({ failureThreshold: 4, successThreshold: 2, timeoutSeconds: 60, errorRateThreshold: 0.6, minRequests: 10 });
  });
});

// ===== [v0.0.349] dangling 存在性预检 + 失效行红描边（决策⑤⑥）=====

/** 测试用 providers fixture（enabled provider + enabled model 命中；disabled 各一） */
const danglingProviders: ProviderItem[] = [
  { id: 'p1', label: '活 provider', models: [{ modelId: 'm1', label: '活模型' }, { modelId: 'm-off', enabled: false }] },
  { id: 'p-off', enabled: false, label: '停用 provider', models: [{ modelId: 'mx' }] },
];

describe('[v0.0.349] validatePlanLocal — dangling 存在性预检（决策⑤）', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('dangling 条目（provider 已删/模型禁用/provider 停用）→ itemModelInvalid', () => {
    const gone = plan([item({ providerId: 'p-gone', modelId: 'm1' })]); // provider 不存在
    expect(validatePlanLocal(gone, danglingProviders)).toContain('modelRouting.validate.itemModelInvalid');
    const modelDisabled = plan([item({ providerId: 'p1', modelId: 'm-off' })]); // 模型停用
    expect(validatePlanLocal(modelDisabled, danglingProviders)).toContain('modelRouting.validate.itemModelInvalid');
    const providerDisabled = plan([item({ providerId: 'p-off', modelId: 'mx' })]); // provider 停用
    expect(validatePlanLocal(providerDisabled, danglingProviders)).toContain('modelRouting.validate.itemModelInvalid');
  });

  it('正常条目（enabled provider 的 enabled model）→ 无 itemModelInvalid；enabled 缺字段视为启用', () => {
    const ok = plan([item({ providerId: 'p1', modelId: 'm1' })]);
    expect(validatePlanLocal(ok, danglingProviders)).not.toContain('modelRouting.validate.itemModelInvalid');
  });

  it('providers 缺省 → 不做存在性检查（向后兼容：失效条目也不出 itemModelInvalid）', () => {
    const dangling = plan([item({ providerId: 'p-gone', modelId: 'm1' })]);
    expect(validatePlanLocal(dangling)).not.toContain('modelRouting.validate.itemModelInvalid');
  });
});

describe('[v0.0.349] ModelRoutingPlanEditor — providers 透传 + 失效行红描边（决策⑥）', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('providers 传入 → dangling 行 data-invalid=true + border-danger；正常行 false', () => {
    render(
      <ModelRoutingPlanEditor
        value={plan([
          item({ providerId: 'p1', modelId: 'm1' }),       // 正常
          item({ providerId: 'p-gone', modelId: 'm2', priority: 2 }), // dangling
        ])}
        onChange={() => {}}
        providers={danglingProviders}
      />,
    );
    const boxes = screen.getAllByTestId('plan-editor-item-model');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.getAttribute('data-invalid')).toBe('false');
    expect(boxes[1]!.getAttribute('data-invalid')).toBe('true');
    expect(boxes[1]!.className).toContain('border-danger');
    expect(boxes[0]!.className).not.toContain('border-danger');
  });

  it('providers 传入 + dangling → 本地预检区实时显 itemModelInvalid 文案（编辑拦保存 UI 面）', () => {
    render(
      <ModelRoutingPlanEditor
        value={plan([item({ providerId: 'p-gone', modelId: 'm1' })])}
        onChange={() => {}}
        providers={danglingProviders}
      />,
    );
    expect(screen.getByTestId('plan-editor-validation').textContent).toContain('失效条目');
  });

  it('providers 缺省 → 行不显红描边（向后兼容）', () => {
    render(
      <ModelRoutingPlanEditor
        value={plan([item({ providerId: 'p-gone', modelId: 'm1' })])}
        onChange={() => {}}
      />,
    );
    const box = screen.getByTestId('plan-editor-item-model');
    expect(box.getAttribute('data-invalid')).toBe('false');
    expect(box.className).not.toContain('border-danger');
  });
});
