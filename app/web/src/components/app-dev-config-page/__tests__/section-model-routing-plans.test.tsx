/**
 * @vitest-environment jsdom
 * section-model-routing-plans 单测（v0.0.347 UI v2：两层结构 + 快照回滚 + 挂载徽章）。
 * 参考 specs/prd/model-routing-demo-v2.html（冻结视觉契约：plan-card / detail-header）
 *       specs/tech/version_logs/v0.0.347/change_plan.md 决策⑨/⑩/⑯/⑰
 *       BUG-002（ET-4 blocking）：rename input 必须受控（{planId, value}），Enter 提交读输入值
 *
 * 校验点：
 *   - 卡片列表渲染（名称 / N 个模型 / 模型名 · join / 挂载徽章）
 *   - 挂载徽章：listPlanMounts 聚合 → 「已挂载到 X」；无挂载 → 未挂载
 *   - 点卡片 → 进详情（detail-title + editor）；← / 取消 → 回列表
 *   - 取消 = 快照回滚（structuredClone；编辑草稿不落盘）
 *   - 新建 → 进详情 isNew；取消 → 幽灵方案移除
 *   - 保存 → saveModelRoutingPlan PUT → 回列表 + reload
 *   - ⋯ 菜单 rename（BUG-002 受控回归）/ copy / delete ConfirmModal
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { SectionModelRoutingPlans } from '../section-model-routing-plans';
import type { ModelRoutingPlan, RoutingItem } from '../model-routing-types';

beforeAll(async () => {
  await initI18n('zh-CN');
});

// mock model-routing-api（绝对路径；MEMORY: bun+jsdom 相对路径 vi.mock 静默失效）
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../model-routing-api'));
const listMock = vi.fn();
const saveMock = vi.fn();
const deleteMock = vi.fn();
const statusMock = vi.fn();
const mountsMock = vi.fn();
vi.mock(apiPath, () => ({
  listModelRoutingPlans: (...args: unknown[]) => listMock(...args),
  saveModelRoutingPlan: (...args: unknown[]) => saveMock(...args),
  deleteModelRoutingPlan: (...args: unknown[]) => deleteMock(...args),
  getModelRoutingStatus: (...args: unknown[]) => statusMock(...args),
  listPlanMounts: (...args: unknown[]) => mountsMock(...args),
  defaultPlanName: (n: number) => `方案 ${n + 1}`,
  copyPlanName: (n: string) => `${n} 副本`,
}));

// mock ModelRoutingPlanEditor（「edit」按钮模拟用户改 draft → onChange）
const editorPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../component-model-routing-plan-editor'));
vi.mock(editorPath, () => ({
  ModelRoutingPlanEditor: ({ value, onChange }: { value: ModelRoutingPlan; onChange: (p: ModelRoutingPlan) => void }) => (
    <div data-testid="mock-editor">
      <button type="button" onClick={() => onChange({ ...value, name: '草稿改名' })}>edit</button>
    </div>
  ),
}));

// mock ConfirmModal（简化删除确认）
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

function item(modelId: string): RoutingItem {
  return { providerId: 'p1', modelId, priority: 1, enabled: true };
}
/** 构造方案 */
function plan(id = 'plan-1', name = '方案 1', items: RoutingItem[] = [item('m1'), item('m2')]): ModelRoutingPlan {
  return { id, name, items, createdAt: 1000 };
}

describe('SectionModelRoutingPlans — 卡片列表（外层）', () => {
  beforeEach(() => {
    cleanup();
    listMock.mockReset().mockResolvedValue([plan()]);
    saveMock.mockReset().mockResolvedValue({ ok: true });
    deleteMock.mockReset().mockResolvedValue({ detached: [] });
    statusMock.mockReset().mockRejectedValue(new Error('no status'));
    mountsMock.mockReset().mockResolvedValue({});
  });
  afterEach(() => cleanup());

  it('渲染卡片：名称 + N 个模型 + 模型名 join + 未挂载徽章', async () => {
    render(<SectionModelRoutingPlans />);
    const card = await screen.findByTestId('plan-card');
    expect(card.textContent).toContain('方案 1');
    expect(card.textContent).toContain('2 个模型');
    expect(card.textContent).toContain('m1 · m2');
    expect(screen.getByTestId('plan-mount-badge').textContent).toBe('未挂载');
  });

  it('挂载徽章：listPlanMounts 聚合 → 已挂载到 Squad A、Playground', async () => {
    mountsMock.mockResolvedValue({ 'plan-1': ['Squad A', 'Playground'] });
    render(<SectionModelRoutingPlans />);
    await screen.findByTestId('plan-card');
    expect(screen.getByTestId('plan-mount-badge').textContent).toBe('已挂载到 Squad A、Playground');
  });

  it('挂载聚合失败 → 降级未挂载不阻断', async () => {
    mountsMock.mockRejectedValue(new Error('net'));
    render(<SectionModelRoutingPlans />);
    await screen.findByTestId('plan-card');
    expect(screen.getByTestId('plan-mount-badge').textContent).toBe('未挂载');
  });
});

describe('SectionModelRoutingPlans — 两层切换与快照回滚（决策⑨）', () => {
  beforeEach(() => {
    cleanup();
    listMock.mockReset().mockResolvedValue([plan()]);
    saveMock.mockReset().mockResolvedValue({ ok: true });
    deleteMock.mockReset().mockResolvedValue({ detached: [] });
    statusMock.mockReset().mockRejectedValue(new Error('no status'));
    mountsMock.mockReset().mockResolvedValue({});
  });
  afterEach(() => cleanup());

  it('点卡片 → 进详情（detail-title 含方案名 + editor）；← 回列表', async () => {
    render(<SectionModelRoutingPlans />);
    fireEvent.click(await screen.findByTestId('plan-card'));
    expect(screen.getByTestId('detail-title').textContent).toContain('方案 1');
    expect(screen.getByTestId('mock-editor')).toBeTruthy();
    fireEvent.click(screen.getByTestId('detail-back'));
    await screen.findByTestId('plan-card');
    expect(screen.queryByTestId('mock-editor')).toBeNull();
  });

  it('SaveBar 取消 = 重置回快照留详情页；面包屑回退 = 回滚退列表（T4 provider 语义）', async () => {
    render(<SectionModelRoutingPlans />);
    fireEvent.click(await screen.findByTestId('plan-card'));
    fireEvent.click(screen.getByTestId('mock-editor').querySelector('button')!); // 草稿改名 → dirty
    expect(screen.getByTestId('detail-title').textContent).toContain('草稿改名');
    fireEvent.click(screen.getByTestId('plan-editor-cancel')); // SaveBar 取消 = 重置（留详情页）
    expect(screen.getByTestId('detail-title').textContent).toContain('方案 1'); // 重置回原名
    expect(screen.getByTestId('mock-editor')).toBeTruthy(); // 仍在详情
    fireEvent.click(screen.getByTestId('detail-back')); // 面包屑 = 回滚退列表
    const card = await screen.findByTestId('plan-card');
    expect(card.textContent).toContain('方案 1'); // 回滚，草稿不落盘
    expect(card.textContent).not.toContain('草稿改名');
  });

  it('新建 → 进详情（isNew）；面包屑回退 → 幽灵方案移除（空态）', async () => {
    listMock.mockResolvedValue([]);
    render(<SectionModelRoutingPlans />);
    await screen.findByText(/还没有模型组合方案/);
    fireEvent.click(screen.getByTestId('plan-create'));
    expect(screen.getByTestId('detail-title').textContent).toContain('方案 1');
    fireEvent.click(screen.getByTestId('detail-back'));
    await screen.findByText(/还没有模型组合方案/); // 空态恢复（未保存方案不残留）
  });

  it('viewLevel 上抛（T4）：进 detail → detail；回列表 → list（父级 tab 据此独占渲染）', async () => {
    const levels: string[] = [];
    render(<SectionModelRoutingPlans onViewLevelChange={(l) => levels.push(l)} />);
    fireEvent.click(await screen.findByTestId('plan-card'));
    await screen.findByTestId('mock-editor');
    fireEvent.click(screen.getByTestId('detail-back'));
    await screen.findByTestId('plan-card');
    expect(levels).toContain('detail');
    expect(levels[levels.length - 1]).toBe('list');
  });

  it('保存 → PUT（reindex 后 items）→ 回列表', async () => {
    render(<SectionModelRoutingPlans />);
    fireEvent.click(await screen.findByTestId('plan-card'));
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const saved = saveMock.mock.calls[0]![0] as ModelRoutingPlan;
    expect(saved.id).toBe('plan-1');
    await screen.findByTestId('plan-card');
    expect(screen.queryByTestId('mock-editor')).toBeNull();
  });
});

describe('SectionModelRoutingPlans — ⋯ 菜单（rename BUG-002 回归 / copy / delete）', () => {
  beforeEach(() => {
    cleanup();
    listMock.mockReset().mockResolvedValue([plan()]);
    saveMock.mockReset().mockResolvedValue({ ok: true });
    deleteMock.mockReset().mockResolvedValue({ detached: [] });
    statusMock.mockReset().mockRejectedValue(new Error('no status'));
    mountsMock.mockReset().mockResolvedValue({});
  });
  afterEach(() => cleanup());

  it('rename：⋯ 菜单 → input 受控回显原名 → 新名 Enter → PUT 带新名', async () => {
    render(<SectionModelRoutingPlans />);
    await screen.findByTestId('plan-card');
    fireEvent.click(screen.getByTestId('plan-card-menu'));
    expect(screen.getByTestId('plan-menu')).toBeTruthy();
    fireEvent.click(screen.getByTestId('plan-rename'));
    const input = screen.getByTestId('plan-rename-input') as HTMLInputElement;
    expect(input.value).toBe('方案 1'); // BUG-002：受控回显
    fireEvent.change(input, { target: { value: '新方案名' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const saved = saveMock.mock.calls[0]![0] as ModelRoutingPlan;
    expect(saved.name).toBe('新方案名');
    expect(saved.id).toBe('plan-1');
  });

  it('rename：空白 / 同名 Enter → 不 PUT', async () => {
    render(<SectionModelRoutingPlans />);
    await screen.findByTestId('plan-card');
    fireEvent.click(screen.getByTestId('plan-card-menu'));
    fireEvent.click(screen.getByTestId('plan-rename'));
    const input = screen.getByTestId('plan-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByTestId('plan-rename-input')).toBeNull());
    fireEvent.click(screen.getByTestId('plan-card-menu'));
    fireEvent.click(screen.getByTestId('plan-rename'));
    fireEvent.change(screen.getByTestId('plan-rename-input'), { target: { value: '方案 1' } });
    fireEvent.keyDown(screen.getByTestId('plan-rename-input'), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByTestId('plan-rename-input')).toBeNull());
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('copy：⋯ → 复制 → PUT 新 id + 「副本」名 → reload', async () => {
    render(<SectionModelRoutingPlans />);
    await screen.findByTestId('plan-card');
    fireEvent.click(screen.getByTestId('plan-card-menu'));
    fireEvent.click(screen.getByTestId('plan-copy'));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const saved = saveMock.mock.calls[0]![0] as ModelRoutingPlan;
    expect(saved.id).not.toBe('plan-1');
    expect(saved.name).toBe('方案 1 副本');
  });

  it('delete：⋯ → 删除 → ConfirmModal → ok → DELETE 调用', async () => {
    render(<SectionModelRoutingPlans />);
    await screen.findByTestId('plan-card');
    fireEvent.click(screen.getByTestId('plan-card-menu'));
    fireEvent.click(screen.getByTestId('plan-delete'));
    expect(screen.getByTestId('confirm-modal')).toBeTruthy();
    fireEvent.click(screen.getByTestId('confirm-modal').querySelector('button')!); // ok
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('plan-1'));
  });
});

// ===== [v0.0.349] dangling 存在性预检拦保存（决策⑤ section 集成面）=====

import { __setProvidersCacheForTest, __resetProvidersCacheForTest } from '../../../lib/providers';

describe('[v0.0.349] SectionModelRoutingPlans — dangling 预检拦保存（providers 透传）', () => {
  beforeEach(() => {
    cleanup();
    listMock.mockReset().mockResolvedValue([plan()]);
    saveMock.mockReset().mockResolvedValue({ ok: true });
    deleteMock.mockReset().mockResolvedValue({ detached: [] });
    statusMock.mockReset().mockRejectedValue(new Error('no status'));
    mountsMock.mockReset().mockResolvedValue({});
  });
  afterEach(() => {
    cleanup();
    __resetProvidersCacheForTest();
  });

  it('providers 加载后条目 dangling → 保存被拦不 PUT（留在详情）', async () => {
    // 桩注入：仅 p-other 存在 → fixture 方案条目（p1/m1、p1/m2）全 dangling
    __setProvidersCacheForTest([{ id: 'p-other', label: '其他', models: [{ modelId: 'm1' }] }]);
    render(<SectionModelRoutingPlans />);
    fireEvent.click(await screen.findByTestId('plan-card'));
    await screen.findByTestId('mock-editor');
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    // 本地预检拦保存：不发 PUT，仍留详情页
    expect(saveMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-editor')).toBeTruthy();
  });

  it('providers 命中（enabled provider 的 enabled model）→ 正常保存不误拦', async () => {
    __setProvidersCacheForTest([{ id: 'p1', label: '活', models: [{ modelId: 'm1' }, { modelId: 'm2' }] }]);
    render(<SectionModelRoutingPlans />);
    fireEvent.click(await screen.findByTestId('plan-card'));
    await screen.findByTestId('mock-editor');
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    await screen.findByTestId('plan-card'); // 保存成功回列表
  });

  it('providers 未加载/拉取失败（无桩）→ 降级跳过存在性检查不误拦（服务端 PUT 校验兜底）', async () => {
    render(<SectionModelRoutingPlans />);
    fireEvent.click(await screen.findByTestId('plan-card'));
    await screen.findByTestId('mock-editor');
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
  });
});

// ===== [v0.0.349 BUG-004] 删除 detached 上抛 onPlanDeleted（page 侧清本地挂载态的数据源）=====

describe('[v0.0.349 BUG-004] SectionModelRoutingPlans — 删除 detached 上抛', () => {
  beforeEach(() => {
    cleanup();
    listMock.mockReset().mockResolvedValue([plan()]);
    saveMock.mockReset().mockResolvedValue({ ok: true });
    statusMock.mockReset().mockRejectedValue(new Error('no status'));
    mountsMock.mockReset().mockResolvedValue({});
  });
  afterEach(() => {
    cleanup();
    __resetProvidersCacheForTest();
  });

  it('delete detached=["playground"] → onPlanDeleted(["playground"], planId) 上抛', async () => {
    deleteMock.mockReset().mockResolvedValue({ detached: ['playground'] });
    const onPlanDeleted = vi.fn();
    render(<SectionModelRoutingPlans onPlanDeleted={onPlanDeleted} />);
    await screen.findByTestId('plan-card');
    fireEvent.click(screen.getByTestId('plan-card-menu'));
    fireEvent.click(screen.getByTestId('plan-delete'));
    fireEvent.click(screen.getByTestId('confirm-modal').querySelector('button')!); // ok
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('plan-1'));
    // [BUG-004] 删除已解绑挂载点必须上抛（含 'playground' 时 page 清 mountDraft，否则 trigger 残显 planId）
    expect(onPlanDeleted).toHaveBeenCalledWith(['playground'], 'plan-1');
  });

  it('detached 仅 squad（不含 playground）→ 同样上抛完整列表（page 侧决定是否清）', async () => {
    deleteMock.mockReset().mockResolvedValue({ detached: ['squad:abc'] });
    const onPlanDeleted = vi.fn();
    render(<SectionModelRoutingPlans onPlanDeleted={onPlanDeleted} />);
    await screen.findByTestId('plan-card');
    fireEvent.click(screen.getByTestId('plan-card-menu'));
    fireEvent.click(screen.getByTestId('plan-delete'));
    fireEvent.click(screen.getByTestId('confirm-modal').querySelector('button')!);
    await waitFor(() => expect(onPlanDeleted).toHaveBeenCalledWith(['squad:abc'], 'plan-1'));
  });
});
