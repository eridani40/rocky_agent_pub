/**
 * @vitest-environment jsdom
 * component-training-create-modal 单测 —— 发起训练弹层
 * 参考: specs/ui/components/academy-page/component-training-create-modal.md
 *       specs/ui/components/_conventions.md §13（L3 modal 不变式：Portal + pointer-events-auto）
 *
 * 覆盖：
 * - 防回归（核心）：Portal 根 div className 必须含 pointer-events-auto。
 *   overlay-root 是 pointer-events:none 且可继承，漏写则整棵子树不接事件、按钮全不可点。
 *   jsdom 不做 hit-testing，只断 click 抓不到此类 bug，必须直接断 className。
 * - 模式卡切换（simple/multi）+ 无评估能力时 multi 禁用。
 * - 取消/提交回调。
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ComponentTrainingCreateModal, toCreateTaskBody } from '../component-training-create-modal';
import type { DatasetEntity, GraderEntity } from '../../../lib/academy-api';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

const datasets = [
  { id: 'ds1', name: '数据集A', items: [{}, {}] },
  { id: 'ds2', name: '数据集B', items: [{}] },
] as unknown as DatasetEntity[];
const graders = [{ id: 'g1', name: '评估器A', type: 'llm-judge' }] as unknown as GraderEntity[];

/** 渲染弹层（各 case 按需覆盖 props） */
function renderModal(overrides: Partial<Parameters<typeof ComponentTrainingCreateModal>[0]> = {}) {
  const onCancel = vi.fn();
  const onSubmit = vi.fn(() => Promise.resolve());
  render(
    <ComponentTrainingCreateModal
      open={true}
      student={{ id: 's1', name: '小红书文案' }}
      formalVersions={[
        { id: 'v1', label: '2.0' },
        { id: 'v0', label: '0.0' },
        { id: 'v2', label: '1.0' },
      ]}
      defaultBaseVersionId="v1"
      datasets={datasets}
      graders={graders}
      hasEvaluationCapability={true}
      nextTaskSeq={3}
      onCancel={onCancel}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { onCancel, onSubmit };
}

/** Portal 根 div（挂在 overlay-root 下，不在 render container 内） */
function overlayRootDiv(): HTMLElement {
  const el = document.querySelector('#overlay-root > div') as HTMLElement;
  expect(el).toBeTruthy();
  return el;
}

describe('ComponentTrainingCreateModal — L3 modal 不变式（防回归）', () => {
  it('Portal 根 div className 含 pointer-events-auto（缺失 → 全弹层按钮不可点）', () => {
    renderModal();
    const root = overlayRootDiv();
    expect(root.className).toContain('pointer-events-auto');
    expect(root.className).toContain('fixed');
    expect(root.className).toContain('z-[var(--z-modal)]');
  });
});

describe('ComponentTrainingCreateModal — 模式与交互', () => {
  it('open=false → 不渲染', () => {
    renderModal({ open: false });
    expect(document.querySelector('#overlay-root > div')).toBeNull();
  });

  it('有评估能力 → 默认选中「多轮模式」，数据集/评估器 picker 可见', () => {
    renderModal();
    expect(screen.getByRole('button', { name: /多轮模式/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('数据集A')).toBeTruthy();
    expect(screen.getByText('评估器A')).toBeTruthy();
  });

  it('点「简单模式」卡 → 切换选中，数据集 picker 收起', () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /简单模式/ }));
    expect(screen.getByRole('button', { name: /简单模式/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('数据集A')).toBeNull();
  });

  it('无评估能力 → 多轮卡 aria-disabled 且点击不切换，默认落 simple', () => {
    renderModal({ hasEvaluationCapability: false });
    const multi = screen.getByRole('button', { name: /多轮模式/ });
    expect(multi.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(multi);
    expect(screen.getByRole('button', { name: /简单模式/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('点「取消」/ head ✕ / 遮罩 → onCancel', () => {
    const { onCancel } = renderModal();
    const footCancel = screen.getAllByRole('button', { name: '取消' }).find((b) => b.textContent === '取消')!;
    fireEvent.click(footCancel);
    const headClose = screen.getAllByRole('button', { name: '取消' }).find((b) => b.textContent === '✕')!;
    fireEvent.click(headClose);
    fireEvent.click(overlayRootDiv());
    expect(onCancel).toHaveBeenCalledTimes(3);
  });

  it('directive 为空 → 提交按钮 disabled；填写后可提交并上抛 baseVersionId + 配置', async () => {
    const { onSubmit } = renderModal();
    const submit = screen.getByRole('button', { name: /发起训练 →/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // 弹层内除 directive textarea 外还有 maxTurns/earlyStop 只读 input（同属 textbox role），直接取 textarea
    fireEvent.change(document.querySelector('textarea')!, { target: { value: '提升口语化' } });
    expect(submit.disabled).toBe(false);
    // submit 是 async（onSubmit 后 setSubmitting(false)），包 act 等状态落定
    await act(async () => { fireEvent.click(submit); });
    // v0.0.219：onSubmit 现上抛选中 baseVersionId（默认 v1）+ 配置
    expect(onSubmit).toHaveBeenCalledWith('v1', {
      mode: 'multi', directive: '提升口语化', datasetId: 'ds1', graderId: 'g1', maxTurns: 5,
    });
  });

  it('baseline picker 可 cycle 切换 formal（点 baseline row 切到下一个 formal，提交上抛新 id）', async () => {
    const { onSubmit } = renderModal();
    // 默认 baseline = v1（label 2.0）；baseline row 是第一个 PickerRow（🌳 icon）
    const baselineRow = document.querySelector('.flex.gap-3 [role="button"]') as HTMLElement;
    expect(baselineRow).toBeTruthy();
    // 断言初始 baseline 文案含 v2.0
    expect(baselineRow.textContent).toContain('v2.0');
    fireEvent.click(baselineRow);
    // cycle 后 baseline 应切到下一个 formal（v0，label 0.0）
    expect(baselineRow.textContent).toContain('v0.0');
    // 填 directive + 提交 → 上抛切后的 baseline id（v0）
    fireEvent.change(document.querySelector('textarea')!, { target: { value: '练一下' } });
    const submit = screen.getByRole('button', { name: /发起训练 →/ }) as HTMLButtonElement;
    await act(async () => { fireEvent.click(submit); });
    expect(onSubmit).toHaveBeenCalledWith('v0', expect.objectContaining({ directive: '练一下' }));
  });
});

describe('toCreateTaskBody — 表单配置 → API body', () => {
  it('multi ⇒ optimizeStyle=training 且带数据集/评估器/maxTurns', () => {
    expect(toCreateTaskBody('v1', { mode: 'multi', directive: 'd', datasetId: 'ds1', graderId: 'g1', maxTurns: 4 }))
      .toEqual({ baseVersionId: 'v1', mode: 'multi', optimizeStyle: 'training', directive: 'd', datasetId: 'ds1', graderId: 'g1', maxTurns: 4 });
  });

  it('simple ⇒ optimizeStyle=learning 且不带评估字段', () => {
    expect(toCreateTaskBody('v1', { mode: 'simple', directive: 'd', datasetId: 'ds1', graderId: 'g1', maxTurns: 4 }))
      .toEqual({ baseVersionId: 'v1', mode: 'simple', optimizeStyle: 'learning', directive: 'd' });
  });
});
