/**
 * @vitest-environment jsdom
 * section-session-config 单测（v0.0.149 新增）
 * 参考: specs/ui/components/app-dev-config-page/section-session-config.md
 *
 * 校验点：
 *   - group 标题渲染
 *   - 两个 number input 存在（maxSkillInject / maxMemoryInject）
 *   - 受控 value 反映 sessionDraft
 *   - 改 input → onSessionChange(key, number)
 *   - 默认值 50 反映到 input.value
 *   - 仅渲染 2 个 number input（不暴露其他 session 子字段）
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

import { SectionSessionConfig } from '../section-session-config';

describe('SectionSessionConfig', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  const defaultProps = {
    sessionDraft: { maxSkillInject: 50, maxMemoryInject: 50 },
    onSessionChange: vi.fn(),
  };

  /** 按渲染顺序取两个 number input：[0]=maxSkillInject, [1]=maxMemoryInject */
  function getInputs(): [HTMLInputElement, HTMLInputElement] {
    const all = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    return [all[0]!, all[1]!];
  }

  it('渲染 group 标题', () => {
    render(<SectionSessionConfig {...defaultProps} />);
    expect(screen.getByText('会话注入数量')).toBeTruthy();
  });

  it('渲染 maxSkillInject + maxMemoryInject 两个 number input', () => {
    render(<SectionSessionConfig {...defaultProps} />);
    const [skill, memory] = getInputs();
    expect(skill).toBeTruthy();
    expect(memory).toBeTruthy();
  });

  it('受控 value 反映 sessionDraft（30/80）', () => {
    render(
      <SectionSessionConfig
        {...defaultProps}
        sessionDraft={{ maxSkillInject: 30, maxMemoryInject: 80 }}
      />,
    );
    const [skillInput, memoryInput] = getInputs();
    expect(skillInput.value).toBe('30');
    expect(memoryInput.value).toBe('80');
  });

  it('改 maxSkillInject input → onSessionChange("maxSkillInject", number)', () => {
    const onSessionChange = vi.fn();
    render(<SectionSessionConfig {...defaultProps} onSessionChange={onSessionChange} />);
    const [input] = getInputs();
    fireEvent.change(input, { target: { value: '100' } });
    expect(onSessionChange).toHaveBeenCalledWith('maxSkillInject', 100);
  });

  it('改 maxMemoryInject input → onSessionChange("maxMemoryInject", number)', () => {
    const onSessionChange = vi.fn();
    render(<SectionSessionConfig {...defaultProps} onSessionChange={onSessionChange} />);
    const [, input] = getInputs();
    fireEvent.change(input, { target: { value: '25' } });
    expect(onSessionChange).toHaveBeenCalledWith('maxMemoryInject', 25);
  });

  it('空串 input → onSessionChange(key, 0)（number 归一化）', () => {
    const onSessionChange = vi.fn();
    render(<SectionSessionConfig {...defaultProps} onSessionChange={onSessionChange} />);
    const [input] = getInputs();
    fireEvent.change(input, { target: { value: '' } });
    expect(onSessionChange).toHaveBeenCalledWith('maxSkillInject', 0);
  });

  it('默认值 50/50 反映到 input.value', () => {
    render(<SectionSessionConfig {...defaultProps} />);
    const [skillInput, memoryInput] = getInputs();
    expect(skillInput.value).toBe('50');
    expect(memoryInput.value).toBe('50');
  });

  it('仅渲染 2 个 number input（不暴露其他 session 子字段）', () => {
    render(<SectionSessionConfig {...defaultProps} />);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(2);
  });
});
