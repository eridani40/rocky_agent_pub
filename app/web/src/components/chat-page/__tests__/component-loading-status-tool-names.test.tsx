/**
 * @vitest-environment jsdom
 * component-loading-status toolNames 渲染单测
 * 参考: specs/ui/components/chat-page/_overview.md §4.10（追加「运行工具: X」文案）
 *
 * 覆盖：
 *   - phase=tool_executing + toolNames 非空 → 文案含「运行工具」+ tool 名（i18n loading.toolExecutingNamed）
 *   - phase=tool_executing + toolNames 为空/未传 → 不渲染该段（向后兼容旧回放）
 *   - phase≠tool_executing（如 thinking）即便传 toolNames 也不渲染（仅 tool_executing 阶段生效）
 *   - data-phase 属性保持不变（ET case 依赖，MUST 约束）
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ComponentLoadingStatus } from '../component-loading-status';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

describe('component-loading-status → toolNames 追加文案', () => {
  it('phase=tool_executing + toolNames=["bash"] → 文案含「运行工具」+ bash', () => {
    const { container } = render(<ComponentLoadingStatus phase="tool_executing" toolNames={['bash']} />);
    const spinner = container.querySelector('[data-phase]')!;
    expect(spinner.textContent).toContain('运行工具');
    expect(spinner.textContent).toContain('bash');
  });

  it('多 tool 名 join 显示', () => {
    const { container } = render(<ComponentLoadingStatus phase="tool_executing" toolNames={['bash', 'web_fetch']} />);
    const spinner = container.querySelector('[data-phase]')!;
    expect(spinner.textContent).toContain('bash, web_fetch');
  });

  it('phase=tool_executing + toolNames 未传 → 不渲染「运行工具」段（向后兼容）', () => {
    const { container } = render(<ComponentLoadingStatus phase="tool_executing" />);
    const spinner = container.querySelector('[data-phase]')!;
    expect(spinner.textContent).not.toContain('运行工具');
    // 仍保留基础阶段文案
    expect(spinner.textContent).toContain('执行中');
  });

  it('phase=tool_executing + toolNames=[]（空数组）→ 不渲染「运行工具」段', () => {
    const { container } = render(<ComponentLoadingStatus phase="tool_executing" toolNames={[]} />);
    const spinner = container.querySelector('[data-phase]')!;
    expect(spinner.textContent).not.toContain('运行工具');
  });

  it('phase=thinking + toolNames 非空 → 不渲染「运行工具」段（仅 tool_executing 阶段生效）', () => {
    const { container } = render(<ComponentLoadingStatus phase="thinking" toolNames={['bash']} />);
    const spinner = container.querySelector('[data-phase]')!;
    expect(spinner.textContent).not.toContain('运行工具');
    expect(spinner.textContent).toContain('思考中');
  });

  it('data-phase 属性保持不变（ET case 依赖，MUST 约束）', () => {
    const { container } = render(<ComponentLoadingStatus phase="tool_executing" toolNames={['bash']} />);
    const spinner = container.querySelector('[data-phase]')!;
    expect(spinner.getAttribute('data-phase')).toBe('tool_executing');
  });
});
