/**
 * @vitest-environment jsdom
 * section-default-models-and-request 单测（v0.0.89 新增）
 * 参考: specs/ui/components/app-dev-config-page/section-default-models-and-request.md
 *
 * 校验点：
 *   - 两个 group 标题渲染（Playground 默认模型 / LLM 请求）
 *   - chat 模型行存在（v0.0.158 起 summary 列已删）
 *   - stall_tool_s / max_attempts 两个 number input 存在
 *   - 改 chat picker → onDefaultModelsChange('chat', value)
 *   - 改 stall input → onLlmRequestChange('stall_tool_s', number)
 *   - 请求设置仅暴露 2 个 number key（不暴露 degradation/length/fallback_chain）
 *
 * v0.0.230 验收返工：chat 行复用统一 chat/ModelPicker（真实渲染，providers 走
 *   __setProvidersCacheForTest 注入桩）——trigger/选项均 `provider / model` 风格、无搜索；
 *   清除交互是外层 x 按钮（ModelPicker 本体不含清除）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { __setProvidersCacheForTest, __resetProvidersCacheForTest } from '../../../lib/providers';

beforeAll(async () => {
  await initI18n('zh-CN');
});

import { SectionDefaultModelsAndRequest } from '../section-default-models-and-request';

/** 测试桩 providers（ModelPicker 用；经 __setProvidersCacheForTest 注入绕过真实 fetch） */
const PROVIDER_STUB = [
  { id: 'p1', label: 'MiniMax', models: [{ modelId: 'glm-5.2', label: 'glm-5.2' }] },
];

describe('SectionDefaultModelsAndRequest', () => {
  beforeEach(() => {
    cleanup();
    __resetProvidersCacheForTest();
    __setProvidersCacheForTest(PROVIDER_STUB);
  });
  afterEach(() => {
    cleanup();
    __resetProvidersCacheForTest();
  });

  const defaultProps = {
    defaultModelsDraft: { chat: undefined },
    onDefaultModelsChange: vi.fn(),
    llmRequestDraft: { stall_tool_s: 120, max_attempts: 3 },
    onLlmRequestChange: vi.fn(),
  };

  /** 按渲染顺序取两个 number input：[0]=stall_tool_s(120), [1]=max_attempts(3) */
  function getInputs(): [HTMLInputElement, HTMLInputElement] {
    const all = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    return [all[0]!, all[1]!];
  }

  it('渲染两个 group 标题（Playground 默认模型 / LLM 请求）', () => {
    render(<SectionDefaultModelsAndRequest {...defaultProps} />);
    expect(screen.getByText('Playground 默认模型')).toBeTruthy();
    expect(screen.getByText('LLM 请求')).toBeTruthy();
  });

  it('[v0.0.158] 渲染 chat 模型行（summary 列已删，不应出现）', () => {
    render(<SectionDefaultModelsAndRequest {...defaultProps} />);
    expect(screen.getByText('默认会话模型')).toBeTruthy();
    expect(screen.queryByText('默认压缩模型')).toBeNull();
  });

  it('渲染 stall_tool_s + max_attempts 两个 number input', () => {
    render(<SectionDefaultModelsAndRequest {...defaultProps} />);
    const [stall, retry] = getInputs();
    expect(stall).toBeTruthy();
    expect(retry).toBeTruthy();
  });

  it('改 stall input → onLlmRequestChange("stall_tool_s", number)', () => {
    const onLlmRequestChange = vi.fn();
    render(<SectionDefaultModelsAndRequest {...defaultProps} onLlmRequestChange={onLlmRequestChange} />);
    const [input] = getInputs();
    fireEvent.change(input, { target: { value: '200' } });
    expect(onLlmRequestChange).toHaveBeenCalledWith('stall_tool_s', 200);
  });

  it('改 max_attempts input → onLlmRequestChange("max_attempts", number)', () => {
    const onLlmRequestChange = vi.fn();
    render(<SectionDefaultModelsAndRequest {...defaultProps} onLlmRequestChange={onLlmRequestChange} />);
    const [, input] = getInputs();
    fireEvent.change(input, { target: { value: '5' } });
    expect(onLlmRequestChange).toHaveBeenCalledWith('max_attempts', 5);
  });

  it('未配 chat → trigger 显「选择 model」占位', () => {
    render(<SectionDefaultModelsAndRequest {...defaultProps} />);
    expect(screen.getByRole('button', { name: '选择 model' })).toBeTruthy();
  });

  it('[v0.0.230 返工] 已配 chat → trigger 显 provider / model（复用 ModelPicker 风格）', () => {
    render(
      <SectionDefaultModelsAndRequest {...defaultProps} defaultModelsDraft={{ chat: 'glm-5.2' }} />,
    );
    expect(screen.getByRole('button', { name: /MiniMax \/ glm-5\.2/ })).toBeTruthy();
  });

  it('[v0.0.230 返工] 打开 picker → 选项显 provider / model 且无搜索框', () => {
    render(<SectionDefaultModelsAndRequest {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: '选择 model' }));
    expect(screen.getByRole('option', { name: /MiniMax \/ glm-5\.2/ })).toBeTruthy();
    // 用户要求：复用 squad 同款 ModelPicker——无搜索（与 KeyModelPicker 的 searchable 面板区分）
    expect(screen.queryByPlaceholderText('搜索模型...')).toBeNull();
  });

  it('[v0.0.230 返工] 点 chat picker 选项 → onDefaultModelsChange("chat", "glm-5.2")（只存 modelId）', () => {
    const onDefaultModelsChange = vi.fn();
    render(<SectionDefaultModelsAndRequest {...defaultProps} onDefaultModelsChange={onDefaultModelsChange} />);
    fireEvent.click(screen.getByRole('button', { name: '选择 model' }));
    fireEvent.click(screen.getByRole('option', { name: /MiniMax \/ glm-5\.2/ }));
    expect(onDefaultModelsChange).toHaveBeenCalledWith('chat', 'glm-5.2');
  });

  it('[v0.0.158] 点外层 x 清除 → onDefaultModelsChange("chat", undefined)', () => {
    const onDefaultModelsChange = vi.fn();
    render(
      <SectionDefaultModelsAndRequest
        {...defaultProps}
        defaultModelsDraft={{ chat: 'glm-5.2' }}
        onDefaultModelsChange={onDefaultModelsChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    expect(onDefaultModelsChange).toHaveBeenCalledWith('chat', undefined);
  });

  it('[v0.0.230 返工] 未配 chat → x 清除按钮不可见但占位（布局稳定，visibility 隐藏）', () => {
    render(<SectionDefaultModelsAndRequest {...defaultProps} />);
    // visibility:hidden 不进 a11y tree，getByRole 需 hidden:true 才能取到（断言的正是「占位但不可见」）
    const clearBtn = screen.getByRole('button', { name: '清除', hidden: true });
    expect(clearBtn.className).toContain('invisible');
  });

  it('[v0.0.230 返工] chat 反查不到 provider（被删/停用）→ 显「选择 model」占位但 x 仍可清除', () => {
    render(
      <SectionDefaultModelsAndRequest {...defaultProps} defaultModelsDraft={{ chat: 'ghost-model' }} />,
    );
    expect(screen.getByRole('button', { name: '选择 model' })).toBeTruthy();
    const clearBtn = screen.getByRole('button', { name: '清除' });
    expect(clearBtn.className).not.toContain('invisible');
  });

  it('请求设置仅暴露 2 个 number input（不暴露 degradation/length/fallback_chain）', () => {
    render(<SectionDefaultModelsAndRequest {...defaultProps} />);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(2);
  });

  it('stall_tool_s 默认值 120 显示', () => {
    render(<SectionDefaultModelsAndRequest {...defaultProps} />);
    const [input] = getInputs();
    expect(input.value).toBe('120');
  });
});
