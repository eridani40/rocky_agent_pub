// @vitest-environment jsdom
/**
 * component-cron-freq-picker 单测
 * 参考: specs/ui/components/chat-page/component-cron-freq-picker.md（4 预设映射）
 *       specs/prd/version_logs/v0.0.58/change_log.md §5.2（编辑态 4 预设 + 高级折叠）
 *
 * 覆盖：
 *   - 4 预设 chip 点击 → onChange 收到对应 cron expr
 *   - minutes/hours 输入数字 → 重算 expr
 *   - daily/weekly 时间输入 → 重算 expr
 *   - weekly 周几切换（含周日 = 0/7）
 *   - advanced chip → raw input 显示
 *   - 实时预览渲染（cronstrue 翻译）
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentCronFreqPicker } from '../component-cron-freq-picker';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：cron-freq-picker 内部用 useTranslation 查 chat.cron.freq.*
beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('ComponentCronFreqPicker', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** 预设 chip 按钮（按 i18n 文案） */
  const getChip = (name: string) => screen.getByRole('button', { name });
  /** 数字输入（minutes/hours 预设，同一时刻仅一个 number input） */
  const getNumberInput = () => document.querySelector('input[type="number"]') as HTMLInputElement;
  /** 时间输入（daily/weekly 预设） */
  const getTimeInput = () => document.querySelector('input[type="time"]') as HTMLInputElement;
  /** 高级 raw cron 输入 */
  const getRawInput = () => document.querySelector('input[type="text"]') as HTMLInputElement;
  /** 实时预览容器（caption 文案的父元素） */
  const getPreview = () => screen.getByText(/底层 cron/).parentElement as HTMLElement;
  /**
   * 周几按钮：这些按钮被外层 <label>（文案「周几」）包裹，首个按钮的 accessible name
   * 会被 label 整体文案污染，故用 getByText 精确匹配按钮自身文案。
   */
  const getWeekday = (label: string) => screen.getByText(label, { selector: 'button' });

  it('默认 minutes 预设 → 显示分钟输入 + 4 预设 chip + 高级 chip', () => {
    const onChange = vi.fn();
    render(<ComponentCronFreqPicker value="*/30 * * * *" onChange={onChange} />);
    expect(getNumberInput()).toBeTruthy();
    // 默认 4 chips + 1 高级 chip
    expect(getChip('每 N 分钟')).toBeTruthy();
    expect(getChip('每 N 小时')).toBeTruthy();
    expect(getChip('每天')).toBeTruthy();
    expect(getChip('每周')).toBeTruthy();
    expect(getChip('高级：自定义 cron')).toBeTruthy();
  });

  it('切到 hours 预设 → onChange 收到 0 */N * * *', () => {
    const onChange = vi.fn();
    render(<ComponentCronFreqPicker value="*/30 * * * *" onChange={onChange} />);
    fireEvent.click(getChip('每 N 小时'));
    expect(onChange).toHaveBeenCalledWith('0 */4 * * *');
    expect(getNumberInput()).toBeTruthy();
  });

  it('切到 daily 预设 → onChange 收到 M H * * *', () => {
    const onChange = vi.fn();
    render(<ComponentCronFreqPicker value="*/30 * * * *" onChange={onChange} />);
    fireEvent.click(getChip('每天'));
    expect(onChange).toHaveBeenCalledWith('0 9 * * *');
    expect(getTimeInput()).toBeTruthy();
  });

  it('切到 weekly 预设 → onChange 含 dow + 周几 chips 出现', () => {
    const onChange = vi.fn();
    render(<ComponentCronFreqPicker value="*/30 * * * *" onChange={onChange} />);
    fireEvent.click(getChip('每周'));
    // weekly 默认 weekday=1 → cron 含 dow 1
    expect(onChange).toHaveBeenCalledWith('0 9 * * 1');
    // 周几按钮出现（含周日）
    expect(getWeekday('周一')).toBeTruthy();
    expect(getWeekday('周日')).toBeTruthy();
  });

  it('weekly 周日（weekday=0）→ cron dow=7', () => {
    const onChange = vi.fn();
    render(<ComponentCronFreqPicker value="0 9 * * 1" onChange={onChange} />);
    // 先确保 weekly preset
    fireEvent.click(getChip('每周'));
    onChange.mockClear();
    fireEvent.click(getWeekday('周日'));
    expect(onChange).toHaveBeenCalledWith('0 9 * * 7');
  });

  it('切到 advanced → raw input 出现', () => {
    const onChange = vi.fn();
    render(<ComponentCronFreqPicker value="*/30 * * * *" onChange={onChange} />);
    fireEvent.click(getChip('高级：自定义 cron'));
    expect(getRawInput()).toBeTruthy();
  });

  it('编辑 raw input → onChange 同步', () => {
    const onChange = vi.fn();
    render(<ComponentCronFreqPicker value="*/30 * * * *" onChange={onChange} />);
    fireEvent.click(getChip('高级：自定义 cron'));
    fireEvent.change(getRawInput(), {
      target: { value: '0 9 * * 1-5' },
    });
    expect(onChange).toHaveBeenCalledWith('0 9 * * 1-5');
  });

  it('实时预览渲染', () => {
    render(<ComponentCronFreqPicker value="*/30 * * * *" onChange={() => {}} />);
    const preview = getPreview();
    expect(preview.textContent).toBeTruthy();
    expect(preview.textContent).toContain('30'); // 翻译含「30」
  });

  it('minutes 输入变化 → onChange 收到新 expr', () => {
    const onChange = vi.fn();
    render(<ComponentCronFreqPicker value="*/30 * * * *" onChange={onChange} />);
    fireEvent.change(getNumberInput(), {
      target: { value: '15' },
    });
    expect(onChange).toHaveBeenCalledWith('*/15 * * * *');
  });

  it('初始化为 daily expr → 自动 detect daily 预设', () => {
    render(<ComponentCronFreqPicker value="30 18 * * *" onChange={() => {}} />);
    // daily 预设下 time-input 应回填 18:30
    expect(getTimeInput().value).toBe('18:30');
  });

  it('初始化为 advanced expr → 直接显示 raw input', () => {
    render(
      <ComponentCronFreqPicker
        value="0 9 * * 1-5"
        onChange={() => {}}
      />,
    );
    // 无法识别为任何预设 → advanced
    expect(getRawInput()).toBeTruthy();
  });
});
