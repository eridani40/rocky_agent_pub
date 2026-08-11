/**
 * @vitest-environment jsdom
 * component-squad-delete 单测（队名匹配校验 + 确认后 loading/弹层保持/遮罩失效 + 成功才关 + 失败可重试）
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { SquadDeleteSection } from '../component-squad-delete';

// 启动 i18next：弹层文案走 studio.deleteSquad.* / common.action.cancel
beforeAll(async () => {
  await initI18n('zh-CN');
});

const SQUAD_NAME = 'Alpha 小队';

describe('SquadDeleteSection', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** 打开弹层（点危险操作区的「解散团队」入口按钮） */
  const openModal = () => {
    fireEvent.click(screen.getByRole('button', { name: '解散团队' }));
  };

  /** 输入队名匹配（启用确认按钮） */
  const typeMatched = () => {
    fireEvent.change(screen.getByPlaceholderText(SQUAD_NAME), { target: { value: SQUAD_NAME } });
  };

  it('未输入匹配队名时确认按钮 disabled（防误删）', () => {
    render(<SquadDeleteSection squadName={SQUAD_NAME} onDelete={async () => true} />);
    openModal();
    const confirm = screen.getByRole('button', { name: '确认解散' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    // 点 disabled 按钮 → 不触发 onDelete（matched 校验在 confirm 内）
    fireEvent.click(confirm);
    // 弹层仍在（未关）
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('点击确认后弹层保持打开：按钮切 loading 文案 + spinner、cancel disabled、X 不关闭', async () => {
    // 永不 resolve 的 Promise：hold 在 submitting 态供断言
    const onDelete = vi.fn(() => new Promise<boolean>(() => {}));
    render(<SquadDeleteSection squadName={SQUAD_NAME} onDelete={onDelete} />);
    openModal();
    typeMatched();
    fireEvent.click(screen.getByRole('button', { name: '确认解散' }));

    // 等待按钮文案切到 loading 态（i18n key deleteSquad.confirming = "解散中…"）
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '解散中…' })).toBeTruthy();
    });

    // 弹层仍在 DOM（未关）
    expect(screen.getByRole('dialog')).toBeTruthy();
    // onDelete 已被调用一次
    expect(onDelete).toHaveBeenCalledTimes(1);

    // loading 态：确认按钮 disabled
    const confirmingBtn = screen.getByRole('button', { name: '解散中…' }) as HTMLButtonElement;
    expect(confirmingBtn.disabled).toBe(true);
    // cancel 按钮 disabled
    const cancelBtn = screen.getByRole('button', { name: '取消' }) as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(true);

    // 点 X 关闭按钮（aria-label="关闭"）→ close() submitting 守卫拦截，弹层保持
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    // 点 cancel（虽然 disabled 仍 fire event 验证 submitting 守卫）→ 弹层保持
    fireEvent.click(cancelBtn);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('onDelete resolve true（成功）→ 弹层关闭（从 DOM 消失）', async () => {
    let resolveDelete!: (ok: boolean) => void;
    const onDelete = vi.fn(
      () => new Promise<boolean>((r) => { resolveDelete = r; }),
    );
    render(<SquadDeleteSection squadName={SQUAD_NAME} onDelete={onDelete} />);
    openModal();
    typeMatched();
    fireEvent.click(screen.getByRole('button', { name: '确认解散' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalled());

    // 成功 → 弹层关闭
    resolveDelete(true);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('onDelete resolve false（失败）→ 弹层保持打开、loading 复位（可再点确认重试）', async () => {
    let resolveDelete!: (ok: boolean) => void;
    const onDelete = vi.fn(
      () => new Promise<boolean>((r) => { resolveDelete = r; }),
    );
    render(<SquadDeleteSection squadName={SQUAD_NAME} onDelete={onDelete} />);
    openModal();
    typeMatched();
    fireEvent.click(screen.getByRole('button', { name: '确认解散' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalled());

    // 失败 → 弹层保持 + loading 复位
    resolveDelete(false);
    await waitFor(() => {
      // 按钮文案回到「确认解散」（loading 复位）
      expect(screen.getByRole('button', { name: '确认解散' })).toBeTruthy();
    });
    expect(screen.getByRole('dialog')).toBeTruthy();

    // 确认按钮回到 enabled（可重试）
    const confirmBtn = screen.getByRole('button', { name: '确认解散' }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);

    // 再次点确认 → onDelete 第二次被调（重试）
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(2));
  });
});

// v0.0.315: confirmLabel 去掉 uppercase，含 squadName 须保持原始大小写
describe('SquadDeleteSection — 大小写保持（v0.0.315）', () => {
  afterEach(() => cleanup());

  it('confirmLabel 含大小写队名时不被 uppercase 改变', () => {
    const name = 'MyTeam';
    render(<SquadDeleteSection squadName={name} onDelete={async () => true} />);
    fireEvent.click(screen.getByRole('button', { name: '解散团队' }));

    // label 不含 uppercase class（className 里没有 'uppercase'）
    const labels = document.querySelectorAll('label');
    const confirmLabels = Array.from(labels).filter((l) => l.textContent?.includes('MyTeam'));
    expect(confirmLabels.length).toBeGreaterThanOrEqual(1);
    const cls = confirmLabels[0]!.className;
    expect(cls).not.toContain('uppercase');

    // 文本中 squadName 保持原始大小写 'MyTeam'（不被 CSS 大写化——UT 检 DOM textContent）
    expect(confirmLabels[0]!.textContent).toContain('MyTeam');
  });

  it('modal title 含大小写队名时保持原始大小写（ModalShell title 无 uppercase）', () => {
    const name = 'MyTeam';
    render(<SquadDeleteSection squadName={name} onDelete={async () => true} />);
    fireEvent.click(screen.getByRole('button', { name: '解散团队' }));

    // title 区域不含 uppercase
    const dialog = screen.getByRole('dialog');
    const titleEl = dialog.querySelector('.text-\\[15px\\]');
    expect(titleEl).toBeTruthy();
    expect(titleEl!.className).not.toContain('uppercase');
  });
});
