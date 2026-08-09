/**
 * @vitest-environment jsdom
 * component-manage-tab 单测（v0.0.279 新增 effortDefault 下拉渲染/交互/dirty/save patch）
 * 参考: specs/ui/overall/06-studio.md §3.2（管理 tab 元信息编辑）
 *       specs/tech/version_logs/v0.0.279/change_plan.md（ui-studio 行）
 *
 * 覆盖（task.json T2 acceptanceCriteria）：
 *   ① 下拉渲染 4 档 + 初始值 = detail.effortDefault
 *   ② 选档后 save → onSaveMeta patch 含 effortDefault
 *   ③ dirty 判定（改档可 save / 改回 detail 值不可 save）
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { ManageTab } from '../component-manage-tab';
import { mkDetail } from './_fixtures';

beforeAll(async () => {
  await initI18n('zh-CN');
});

// mock 危险操作区（ManageTab 自身逻辑无关，避免 ModalShell 依赖）
vi.mock('../component-squad-delete', () => ({
  SquadDeleteSection: () => <div data-testid="squad-delete-mock" />,
}));

describe('ManageTab effortDefault', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** mock GET /provider → providers（ModelPicker 经 useProviders 挂载即拉，v0.0.36） */
  function mockProviders() {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{ id: 'pA', label: 'Provider A', models: [{ modelId: 'a-1', label: 'A-1' }] }],
      }),
    }) as unknown as typeof fetch;
  }

  /** save 按钮（zh-CN manageTab.save） */
  const saveBtn = () => screen.getByRole('button', { name: '保存元信息' }) as HTMLButtonElement;

  it('渲染 effortDefault 下拉（4 档 + 初始值 = detail.effortDefault）', async () => {
    mockProviders();
    const detail = mkDetail({ effortDefault: 'low' });
    render(<ManageTab detail={detail} onSaveMeta={vi.fn()} onDelete={vi.fn().mockResolvedValue(true)} />);
    // label（zh-CN manageTab.effortDefaultLabel）
    expect(screen.getByText('默认推理强度')).toBeTruthy();
    // trigger 显示当前档 label（low → 低）
    expect(screen.getByRole('button', { name: '低' })).toBeTruthy();
    // 点开 → 4 档平铺（default/low/high/max）
    fireEvent.click(screen.getByRole('button', { name: '低' }));
    expect(screen.getByRole('option', { name: '默认' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '低' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '高' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '超高' })).toBeTruthy();
  });

  it('选档后 save → PATCH body 含 effortDefault', async () => {
    mockProviders();
    const detail = mkDetail({ effortDefault: 'default' });
    const onSaveMeta = vi.fn().mockResolvedValue(undefined);
    render(<ManageTab detail={detail} onSaveMeta={onSaveMeta} onDelete={vi.fn().mockResolvedValue(true)} />);
    // 初始 default（无 dirty）→ save disabled
    expect(saveBtn().disabled).toBe(true);
    // 选「高」
    fireEvent.click(screen.getByRole('button', { name: '默认' }));
    fireEvent.click(screen.getByRole('option', { name: '高' }));
    expect(saveBtn().disabled).toBe(false);
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSaveMeta).toHaveBeenCalledTimes(1));
    expect(onSaveMeta).toHaveBeenCalledWith(expect.objectContaining({ effortDefault: 'high' }));
  });

  it('dirty 判定：改档可 save；改回 detail 值不可 save', async () => {
    mockProviders();
    const detail = mkDetail({ effortDefault: 'default' });
    const onSaveMeta = vi.fn().mockResolvedValue(undefined);
    render(<ManageTab detail={detail} onSaveMeta={onSaveMeta} onDelete={vi.fn().mockResolvedValue(true)} />);
    // 改「max」→ dirty
    fireEvent.click(screen.getByRole('button', { name: '默认' }));
    fireEvent.click(screen.getByRole('option', { name: '超高' }));
    expect(saveBtn().disabled).toBe(false);
    // 改回「默认」→ 不 dirty
    fireEvent.click(screen.getByRole('button', { name: '超高' }));
    fireEvent.click(screen.getByRole('option', { name: '默认' }));
    expect(saveBtn().disabled).toBe(true);
  });
});
