/**
 * @vitest-environment jsdom
 * component-new-squad-modal 单测（字段渲染 + 提交 body 对齐 POST /squad 契约）
 * 参考: specs/ui/overall/06-studio.md §6；11a §1.1
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { NewSquadModal } from '../component-new-squad-modal';

// [v0.0.62 i18n] 启动 i18next：modal 字段 label/placeholder 走 studio.newSquadModal.*
beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('NewSquadModal', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** mock GET /provider → providers（ModelPicker 经 useProviders 实时拉，v0.0.36） */
  function mockProviders() {
    const providers = [{ id: 'pA', label: 'Provider A', models: [{ modelId: 'a-1', label: 'A-1' }] }];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: providers }),
    }) as unknown as typeof fetch;
    return providers;
  }

  /** 经 ModelPicker 选模型：展开下拉（trigger button）→ 点 option（显示「provider / model」） */
  async function pickModel(label: string) {
    fireEvent.click(screen.getByRole('button', { name: '选择 model' }));
    fireEvent.click(await screen.findByText(label));
  }

  const submitBtn = () => screen.getByRole('button', { name: '创建' }) as HTMLButtonElement;

  it('渲染 wizard 字段（name/model/leader.name；leader.systemprompt 已删）', () => {
    render(<NewSquadModal onClose={() => {}} onCreate={async () => {}} />);
    expect(screen.getByText('新建 squad')).toBeTruthy();
    expect(screen.getByPlaceholderText('如：Gamma 小队')).toBeTruthy(); // name
    expect(screen.getByRole('button', { name: '选择 model' })).toBeTruthy(); // model picker
    expect(screen.getByDisplayValue('Rocky')).toBeTruthy(); // leader.name
    expect(submitBtn()).toBeTruthy(); // submit
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy(); // cancel
    // systemPrompt 输入框已删除（phantom 字段清理）—— 仅剩 desc 一个 textarea
    expect(document.querySelectorAll('textarea').length).toBe(1);
  });

  it('必填未齐时提交 disabled；选模型+填齐后提交调 onCreate（body 含 leader）', async () => {
    mockProviders();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<NewSquadModal onClose={() => {}} onCreate={onCreate} />);
    const submit = submitBtn();
    // modelSel=null（删硬编码默认）+ 缺 name → disabled
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('如：Gamma 小队'), { target: { value: 'Gamma 小队' } });
    // 仍缺模型 → disabled
    expect(submit.disabled).toBe(true);
    await pickModel('Provider A / A-1');
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Gamma 小队',
        modelDefault: 'a-1',
        leader: { name: 'Rocky' },
      }),
    );
  });

  it('点取消调 onClose', () => {
    const onClose = vi.fn();
    render(<NewSquadModal onClose={onClose} onCreate={async () => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalled();
  });
});
