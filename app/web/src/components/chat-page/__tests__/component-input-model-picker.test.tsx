// @vitest-environment jsdom
/**
 * component-input-model-picker 单测（v0.0.89 新增；v0.0.91.ui_fix trigger 纯图标 + in-flow；
 *   v0.0.91.ui_fix r2 hover/click 合并菜单 + 21px + 前缩略）
 * 参考: specs/ui/components/chat-page/component-input-model-picker.md
 *       specs/ui/version_logs/v0.0.91/change_log.md（T1 + r2）
 *
 * 覆盖：
 *   - trigger 纯图标（不内联模型名）+ BrainIcon SVG 存在
 *   - 根容器 in-flow + relative（v0.0.91.ui_fix：shrink-0；r2：relative 让 absolute 浮层基于根定位）
 *   - trigger 三态（default+defaultA / default+无defaultA / 具体 modelB）—— aria-label
 *   - 菜单双场景（场景 A 配了 defaultA 顶部「a(默认)」+ 完整列表 a 重复；场景 B 仅完整列表）
 *   - 选「a(默认)」→ onChange({providerId:'',modelId:'default'})（保留字）
 *   - 选列表里 a → onChange({providerId, modelId})（固定）
 *   - 菜单展开 testid：model-picker-menu / model-picker-default-item / model-picker-item-{pid}-{mid}
 *   - disabled 时 trigger 不响应点击
 *   - [r2] trigger 21px（class 含 h-[21px] w-[21px]）
 *   - [r2] hover → model-picker-preview 单条菜单（当前模型 / 未配置）
 *   - [r2] click 时 preview 不渲染（与 menu 互斥）
 *   - [r2] 菜单项前缩略 class（[direction:rtl] + ellipsis）
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import {
  __setProvidersCacheForTest,
  __resetProvidersCacheForTest,
  type ProviderItem,
} from '../../../lib/providers';
import { InputModelPicker } from '../component-input-model-picker';
import { initI18n } from '../../../i18n';
import type { ModelSelection } from '../../../lib/providers';

// 初始化真实 i18n resources（zh-CN）—— picker 标题走 t() 需加载 chat ns
beforeAll(async () => {
  await initI18n('zh-CN');
});

// 桩 fetch（default_models.chat 拉取）
const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input.toString();
  if (url.includes('/config/app?group=default_models')) {
    // 测试默认不配 default_models.chat（场景 B）；具体测试用例可在 it 内 override __setProvidersCacheForTest
    return new Response(JSON.stringify({ value: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('not found', { status: 404 });
});

beforeEach(() => {
  fetchSpy.mockClear();
});
afterEach(() => {
  cleanup();
  __resetProvidersCacheForTest();
});

const FAKE_PROVIDERS: ProviderItem[] = [
  {
    id: 'pid_openai',
    label: 'OpenAI',
    models: [
      { modelId: 'gpt-4o', label: 'GPT-4o' },
      { modelId: 'gpt-4o-mini', label: 'GPT-4o mini' },
    ],
  },
  {
    id: 'pid_anthropic',
    label: 'Anthropic',
    models: [{ modelId: 'claude-sonnet', label: 'Claude Sonnet' }],
  },
];

/** trigger 按钮（aria-haspopup=listbox，纯图标） */
function getTrigger(): HTMLButtonElement {
  return document.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement;
}

/** 顶部「a（默认）」项按钮（label span 含 （默认）；非常规 option） */
function getDefaultItem(): HTMLElement | null {
  const span = screen.queryByText(/（默认）/);
  return span ? (span.closest('button') as HTMLElement) : null;
}

/** 常规列表项按钮（role=option，label 为 「provider / model」） */
function getOption(label: string): HTMLElement | null {
  const span = screen.queryByText(label, { exact: true });
  return span ? (span.closest('button[role="option"]') as HTMLElement) : null;
}

describe('InputModelPicker — trigger 纯图标 + in-flow（v0.0.91.ui_fix）', () => {
  beforeEach(() => __setProvidersCacheForTest(FAKE_PROVIDERS));

  it('trigger 内不渲染模型名文本（纯 BrainIcon，模型名仅 tooltip 显）', async () => {
    render(
      <InputModelPicker
        model={{ providerId: 'pid_anthropic', modelId: 'claude-sonnet' }}
        defaultModel={null}
        onChange={() => {}}
      />,
    );
    await waitFor(() => {
      const trigger = getTrigger() as HTMLButtonElement;
      // trigger 内不应出现模型名 / provider 名（纯图标）
      expect(trigger.textContent).not.toContain('Claude');
      expect(trigger.textContent).not.toContain('Anthropic');
      // aria-label（tooltip 文本）仍含模型名 —— 模型名仅 hover tooltip 显
      expect(trigger.getAttribute('aria-label')).toContain('Claude Sonnet');
    });
  });

  it('trigger 内含 BrainIcon SVG（纯图标 trigger）', async () => {
    render(
      <InputModelPicker
        model={null}
        defaultModel={null}
        onChange={() => {}}
      />,
    );
    await waitFor(() => {
      const trigger = getTrigger() as HTMLButtonElement;
      const svg = trigger.querySelector('svg');
      expect(svg).toBeTruthy();
    });
  });

  it('根容器 in-flow（shrink-0，非 absolute）—— 不再占排版让位 hack', async () => {
    const { container } = render(
      <InputModelPicker
        model={null}
        defaultModel={null}
        onChange={() => {}}
      />,
    );
    await waitFor(() => {
      const trigger = getTrigger() as HTMLButtonElement;
      // trigger button 存在即够；根容器 = container.firstChild（PrimitiveTooltip 包了 3 层 span）
      expect(trigger).toBeTruthy();
    });
    // 根容器 = render container 的第一个子节点（InputModelPicker 渲染单一根 div）
    const root = container.firstChild as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.className).toContain('shrink-0');
    expect(root.className).not.toContain('absolute');
    // 不应保留旧 left-3 bottom-2 让位 hack
    expect(root.className).not.toContain('left-3');
    expect(root.className).not.toContain('bottom-2');
  });
});

describe('InputModelPicker — trigger 三态（tooltip / aria-label）', () => {
  beforeEach(() => __setProvidersCacheForTest(FAKE_PROVIDERS));

  it('modelId="default" + 有 defaultA → aria-label 含「(默认)」', async () => {
    const defaultA: ModelSelection = { providerId: 'pid_openai', modelId: 'gpt-4o' };
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModel={defaultA}
        onChange={() => {}}
      />,
    );
    await waitFor(() => {
      const trigger = getTrigger() as HTMLButtonElement;
      expect(trigger.getAttribute('aria-label')).toContain('默认');
      // v0.0.91.ui_fix：trigger 不内联模型名（仅 tooltip）—— textContent 不应含 'GPT-4o'
      expect(trigger.textContent).not.toContain('GPT-4o');
    });
  });

  it('modelId="default" + 无 defaultA → aria-label 含「未配置」', async () => {
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModel={null}
        onChange={() => {}}
      />,
    );
    await waitFor(() => {
      const trigger = getTrigger() as HTMLButtonElement;
      expect(trigger.getAttribute('aria-label')).toContain('未配置');
    });
  });

  it('具体 modelB → aria-label 含 model label（不含「默认」字样）', async () => {
    render(
      <InputModelPicker
        model={{ providerId: 'pid_anthropic', modelId: 'claude-sonnet' }}
        defaultModel={null}
        onChange={() => {}}
      />,
    );
    await waitFor(() => {
      const trigger = getTrigger() as HTMLButtonElement;
      expect(trigger.getAttribute('aria-label')).toContain('Claude Sonnet');
      expect(trigger.getAttribute('aria-label')).not.toContain('默认');
    });
  });
});

describe('InputModelPicker — 菜单双场景', () => {
  beforeEach(() => __setProvidersCacheForTest(FAKE_PROVIDERS));

  it('场景 A：配了 defaultA → 菜单含 model-picker-default-item + 完整列表（a 在列表里重复）', async () => {
    const defaultA: ModelSelection = { providerId: 'pid_openai', modelId: 'gpt-4o' };
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModel={defaultA}
        onChange={() => {}}
      />,
    );
    fireEvent.click(getTrigger());
    const menu = await screen.findByRole('listbox');
    expect(menu).toBeTruthy();
    // 顶部「a(默认)」项
    const defaultItem = getDefaultItem()!;
    expect(defaultItem.textContent).toContain('GPT-4o');
    expect(defaultItem.textContent).toContain('默认');
    // 完整列表 a (gpt-4o) 仍在列表里（重复）
    const gpt4oItem = getOption('OpenAI / GPT-4o')!;
    expect(gpt4oItem).toBeTruthy();
    // 其他 model 也在
    expect(getOption('OpenAI / GPT-4o mini')!).toBeTruthy();
    expect(getOption('Anthropic / Claude Sonnet')!).toBeTruthy();
  });

  it('场景 B：未配 defaultA → 菜单无 model-picker-default-item，仅完整列表', async () => {
    render(
      <InputModelPicker
        model={null}
        defaultModel={null}
        onChange={() => {}}
      />,
    );
    fireEvent.click(getTrigger());
    const menu = await screen.findByRole('listbox');
    expect(menu).toBeTruthy();
    // 无顶部「a(默认)」项
    expect(getDefaultItem()).toBeNull();
    // 完整列表仍在
    expect(getOption('OpenAI / GPT-4o')!).toBeTruthy();
  });

  it('选「a(默认)」→ onChange 上抛 {providerId:"", modelId:"default"}（保留字）', async () => {
    const onChange = vi.fn();
    const defaultA: ModelSelection = { providerId: 'pid_openai', modelId: 'gpt-4o' };
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModel={defaultA}
        onChange={onChange}
      />,
    );
    fireEvent.click(getTrigger());
    const defaultItem = (await screen.findByText(/（默认）/)).closest('button') as HTMLElement;
    fireEvent.click(defaultItem);
    expect(onChange).toHaveBeenCalledWith({ providerId: '', modelId: 'default' });
  });

  it('选列表里 a → onChange 上抛具体 ModelRef（固定 a，不跟随默认）', async () => {
    const onChange = vi.fn();
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModel={{ providerId: 'pid_openai', modelId: 'gpt-4o' }}
        onChange={onChange}
      />,
    );
    fireEvent.click(getTrigger());
    const item = (await screen.findByText('Anthropic / Claude Sonnet', { exact: true })).closest('button[role="option"]') as HTMLElement;
    fireEvent.click(item);
    expect(onChange).toHaveBeenCalledWith({ providerId: 'pid_anthropic', modelId: 'claude-sonnet' });
  });

  it('disabled=true → 点击不展开菜单', async () => {
    render(
      <InputModelPicker
        model={null}
        defaultModel={null}
        disabled={true}
        onChange={() => {}}
      />,
    );
    const trigger = getTrigger() as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    // 菜单不应展开（disabled button 不触发 onClick）
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

// ============================================================
// [v0.0.91.ui_fix r2] hover 预览菜单 + click 完整菜单合并 + 21px + 前缩略
// 参考: specs/ui/components/chat-page/component-input-model-picker.md §1/§5/§9
// ============================================================
describe('InputModelPicker — r2 trigger 21px + 根容器 relative', () => {
  beforeEach(() => __setProvidersCacheForTest(FAKE_PROVIDERS));

  it('trigger className 含 h-[21px] w-[21px]（r2 21px 尺寸 token）', async () => {
    render(
      <InputModelPicker model={null} defaultModel={null} onChange={() => {}} />,
    );
    await waitFor(() => {
      const trigger = getTrigger() as HTMLButtonElement;
      expect(trigger.className).toContain('h-[21px]');
      expect(trigger.className).toContain('w-[21px]');
      // 不应保留旧 h-7 w-7
      expect(trigger.className).not.toContain('h-7');
      expect(trigger.className).not.toContain('w-7');
    });
  });

  it('根容器 relative + shrink-0（让 absolute 浮层基于根定位；按钮行内 in-flow）', async () => {
    const { container } = render(
      <InputModelPicker model={null} defaultModel={null} onChange={() => {}} />,
    );
    await waitFor(() => {
      const root = container.firstChild as HTMLElement;
      expect(root.className).toContain('relative');
      expect(root.className).toContain('shrink-0');
    });
  });

  it('trigger 内含 BrainIcon SVG（r2 size=12，纯图标 trigger，无 PrimitiveTooltip 文本）', async () => {
    const { container } = render(
      <InputModelPicker model={null} defaultModel={null} onChange={() => {}} />,
    );
    await waitFor(() => {
      const trigger = getTrigger() as HTMLButtonElement;
      const svg = trigger.querySelector('svg');
      expect(svg).toBeTruthy();
    });
    // r2 删 PrimitiveTooltip：根容器外不应再有 primitive-tooltip 包裹层
    expect(container.querySelector('.primitive-tooltip')).toBeNull();
  });
});

describe('InputModelPicker — r2 hover 预览菜单（model-picker-preview）', () => {
  beforeEach(() => __setProvidersCacheForTest(FAKE_PROVIDERS));

  it('未 click + 鼠标移入 → 渲染 model-picker-preview（单条，内容=当前模型 selected 高亮）', async () => {
    render(
      <InputModelPicker
        model={{ providerId: 'pid_anthropic', modelId: 'claude-sonnet' }}
        defaultModel={null}
        onChange={() => {}}
      />,
    );
    const root = getTrigger().parentElement as HTMLElement;
    // 鼠标移入根容器（hover 监听挂在根容器）
    fireEvent.mouseEnter(root);
    const preview = await screen.findByRole('listbox');
    expect(preview).toBeTruthy();
    // 单条内容 = 当前模型名
    expect(preview.textContent).toContain('Claude Sonnet');
    // [v0.0.165] selected 高亮 = text-fg + font-medium（银灰体系：accent 已灌黑 = text-fg 同视觉）
    const item = preview.firstElementChild as HTMLElement;
    expect(item.className).toContain('text-fg');
    expect(item.className).toContain('font-medium');
  });

  it('hover 预览：model=default + 配了 defaultA → 内容含「（默认）」+ selected 高亮', async () => {
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModel={{ providerId: 'pid_openai', modelId: 'gpt-4o' }}
        onChange={() => {}}
      />,
    );
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.mouseEnter(root);
    const preview = await screen.findByRole('listbox');
    expect(preview.textContent).toContain('GPT-4o');
    expect(preview.textContent).toContain('默认');
  });

  it('hover 预览：model=default + 无 defaultA → 内容=「未配置」（muted 态）', async () => {
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModel={null}
        onChange={() => {}}
      />,
    );
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.mouseEnter(root);
    const preview = await screen.findByRole('listbox');
    expect(preview.textContent).toContain('未配置');
    const item = preview.firstElementChild as HTMLElement;
    expect(item.className).toContain('text-muted');
  });

  it('hover 预览：model=null → 内容=「未配置」（muted 态）', async () => {
    render(
      <InputModelPicker model={null} defaultModel={null} onChange={() => {}}
      />,
    );
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.mouseEnter(root);
    const preview = await screen.findByRole('listbox');
    expect(preview.textContent).toContain('未配置');
  });

  it('鼠标移出 → preview 消失', async () => {
    render(
      <InputModelPicker model={null} defaultModel={null} onChange={() => {}}
      />,
    );
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.mouseEnter(root);
    expect(await screen.findByRole('listbox')).toBeTruthy();
    fireEvent.mouseLeave(root);
    // r2 预览是 controlled by hovered state，mouseLeave 后立即消失
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull();
    });
  });

  it('click 展开后 preview 不渲染（与 menu 互斥）', async () => {
    render(
      <InputModelPicker model={null} defaultModel={null} onChange={() => {}}
      />,
    );
    const root = getTrigger().parentElement as HTMLElement;
    // 先 click 展开 menu
    fireEvent.click(getTrigger());
    expect(await screen.findByRole('listbox')).toBeTruthy();
    // 再 hover（mouseenter）—— preview 不应渲染（与 menu 互斥）；listbox 总数仍为 1（仅 menu）
    fireEvent.mouseEnter(root);
    expect(screen.getAllByRole('listbox')).toHaveLength(1);
  });

  it('[v0.0.165] preview 与 menu 共用相同视觉基础 token（银灰白卡：bg-surface + border + rounded-lg + shadow-lg）', async () => {
    render(<InputModelPicker model={null} defaultModel={null} onChange={() => {}} />);
    // 先测 preview className
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.mouseEnter(root);
    const preview = await screen.findByRole('listbox');
    // preview 视觉基线：白卡（regulation 02 §7）
    expect(preview.className).toContain('bg-surface');
    expect(preview.className).toContain('border-border');
    expect(preview.className).toContain('rounded-lg');
    expect(preview.className).toContain('shadow-lg');
    expect(preview.className).toContain('w-[300px]');
    // 关闭 hover 后再 click 展开 menu
    fireEvent.mouseLeave(root);
    fireEvent.click(getTrigger());
    const menu = await screen.findByRole('listbox');
    // menu 同白卡视觉（走 ModelPickerPanel primitive，与 preview 视觉基础一致）
    expect(menu.className).toContain('bg-surface');
    expect(menu.className).toContain('border-border');
    expect(menu.className).toContain('rounded-lg');
    expect(menu.className).toContain('shadow-lg');
    expect(menu.className).toContain('w-[300px]');
    // menu 定位在 preview 外层 wrapper（absolute bottom-full right-0 mb-1）
    const menuWrapper = menu.parentElement as HTMLElement;
    expect(menuWrapper.className).toContain('bottom-full');
    expect(menuWrapper.className).toContain('right-0');
  });
});

describe('[v0.0.165] InputModelPicker — 菜单固定 300px 白卡 + 列表项左对齐（regulation 02 §7）', () => {
  beforeEach(() => __setProvidersCacheForTest(FAKE_PROVIDERS));

  it('click 菜单容器固定 300px 宽（regulation 02 §7 白卡；替代 v0.0.91 r2.2 w-max 自适应）', async () => {
    render(<InputModelPicker model={null} defaultModel={null} onChange={() => {}} />);
    fireEvent.click(getTrigger());
    const menu = await screen.findByRole('listbox');
    expect(menu.className).toContain('w-[300px]');
    // 不再是 w-max 自适应
    expect(menu.className).not.toContain('w-max');
  });

  it('click 菜单列表项左对齐 text-left + w-full 整行可点（保留原语义）', async () => {
    render(<InputModelPicker model={null} defaultModel={null} onChange={() => {}} />);
    fireEvent.click(getTrigger());
    const item = (await screen.findByText('Anthropic / Claude Sonnet', { exact: true })).closest('button[role="option"]') as HTMLElement;
    expect(item.className).toContain('text-left');
    expect(item.className).toContain('w-full');
    // 不再有 RTL 前缩略
    expect(item.className).not.toContain('[direction:rtl]');
    // item 内容：IconBox + modelLabel（label 挂在内部 span 上 truncate 处理，item 本身无 truncate）
    expect(item.textContent).toContain('Claude Sonnet');
    // label 内部 span 有 truncate 类（保长名尾缩略）
    const labelSpan = Array.from(item.querySelectorAll('span')).find((s) =>
      s.className.includes('truncate'),
    );
    expect(labelSpan).toBeTruthy();
  });

  it('click 菜单顶部「a(默认)」项同样左对齐', async () => {
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModel={{ providerId: 'pid_openai', modelId: 'gpt-4o' }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(getTrigger());
    const defaultItem = (await screen.findByText(/（默认）/)).closest('button') as HTMLElement;
    expect(defaultItem.className).toContain('text-left');
    expect(defaultItem.className).not.toContain('[direction:rtl]');
  });

  // [v0.0.165 用户裁决] 模型选择统一 = 只统一样式，不统一选项构成：
  // session/chat 里选对话模型的列表必须**保留「默认模型」项**（且该模型在下方模型列表中重复出现一次）——正确行为。
  it('[v0.0.165] session picker 保留「默认模型」项 + 该模型在完整列表中重复出现一次（用户裁决）', async () => {
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModel={{ providerId: 'pid_openai', modelId: 'gpt-4o' }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(getTrigger());
    // 顶部默认项存在
    const defaultItem = (await screen.findByText(/（默认）/)).closest('button') as HTMLElement;
    expect(defaultItem.textContent).toContain('GPT-4o');
    expect(defaultItem.textContent).toContain('默认');
    // 完整列表中同一模型（gpt-4o）**仍然出现**——不为统一而去重
    expect(getOption('OpenAI / GPT-4o')!).toBeTruthy();
    expect(getOption('OpenAI / GPT-4o mini')!).toBeTruthy();
    expect(getOption('Anthropic / Claude Sonnet')!).toBeTruthy();
  });
});

// ============================================================
// [v0.0.113 ④] defaultModelId 纯 modelId 反查 provider（studio hover 显实际生效默认）
// 参考: specs/ui/components/chat-page/component-input-model-picker.md §7 §10
// 根因：studio 存盘 squad.modelDefault 是纯 modelId（无 `/`）；parseModelRef 只认斜杠格式 → 恒 null → 恒「未配置」。
//   修法：picker 加 defaultModelId prop，对纯 modelId 调 findProviderIdByModelId 反查 provider。
// ============================================================
describe('InputModelPicker — ④ defaultModelId 纯 modelId 反查（studio hover 默认）', () => {
  beforeEach(() => __setProvidersCacheForTest(FAKE_PROVIDERS));

  it('纯 modelId 命中 provider → effectiveDefault 非空 → hover 预览显「{模型}（默认）」非「未配置」', async () => {
    // studio 场景：member.model 空 → model=保留字 default；squad.modelDefault=纯 modelId "gpt-4o"（无 `/`）
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModelId="gpt-4o"
        onChange={() => {}}
      />,
    );
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.mouseEnter(root);
    const preview = await screen.findByRole('listbox');
    // 核心断言：反查 provider 命中 → 展示实际生效默认模型 +「（默认）」，不再误显「未配置」
    expect(preview.textContent).toContain('GPT-4o');
    expect(preview.textContent).toContain('（默认）');
    expect(preview.textContent).not.toContain('未配置');
    // [v0.0.165] selected 高亮 = text-fg + font-medium（银灰体系）
    const item = preview.firstElementChild as HTMLElement;
    expect(item.className).toContain('text-fg');
    expect(item.className).toContain('font-medium');
  });

  it('纯 modelId 命中 → aria-label 含「默认」（trigger 非未配置态）', async () => {
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModelId="claude-sonnet"
        onChange={() => {}}
      />,
    );
    await waitFor(() => {
      const trigger = getTrigger() as HTMLButtonElement;
      expect(trigger.getAttribute('aria-label')).toContain('默认');
      expect(trigger.getAttribute('aria-label')).not.toContain('未配置');
    });
  });

  it('纯 modelId 未命中任一 provider（disabled/删）→ null → hover 预览显「未配置」', async () => {
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModelId="ghost-model-not-in-any-provider"
        onChange={() => {}}
      />,
    );
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.mouseEnter(root);
    const preview = await screen.findByRole('listbox');
    expect(preview.textContent).toContain('未配置');
    const item = preview.firstElementChild as HTMLElement;
    expect(item.className).toContain('text-muted');
  });

  it('defaultModelId 空串 → null → hover 预览显「未配置」（不反查）', async () => {
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModelId=""
        onChange={() => {}}
      />,
    );
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.mouseEnter(root);
    const preview = await screen.findByRole('listbox');
    expect(preview.textContent).toContain('未配置');
  });

  it('优先级 defaultModelId > defaultModel：两者同传时以 defaultModelId 反查结果为准', async () => {
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModelId="gpt-4o"
        defaultModel={{ providerId: 'pid_anthropic', modelId: 'claude-sonnet' }}
        onChange={() => {}}
      />,
    );
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.mouseEnter(root);
    const preview = await screen.findByRole('listbox');
    // defaultModelId（gpt-4o）胜出，不用 defaultModel（claude-sonnet）
    expect(preview.textContent).toContain('GPT-4o');
    expect(preview.textContent).not.toContain('Claude');
  });

  // [v0.0.155] defaultModelProviderId 复合精确（消除同名 model 跨 provider 歧义）
  it('[v0.0.155] defaultModelProviderId 复合：精确命中 provider + 同名歧义消除', async () => {
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModelId="gpt-4o"
        defaultModelProviderId="pid_openai"
        onChange={() => {}}
      />,
    );
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.mouseEnter(root);
    const preview = await screen.findByRole('listbox');
    // 复合精确命中 pid_openai provider → 显示「OpenAI / GPT-4o」+「（默认）」
    expect(preview.textContent).toContain('OpenAI');
    expect(preview.textContent).toContain('GPT-4o');
  });

  it('[v0.0.155] defaultModelProviderId 不命中 provider → fallback 反查（back-compat 救存量）', async () => {
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModelId="gpt-4o"
        defaultModelProviderId="nonexistent_provider"
        onChange={() => {}}
      />,
    );
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.mouseEnter(root);
    const preview = await screen.findByRole('listbox');
    // provider 不命中 → fallback findProviderIdByModelId 反查 → 仍命中（gpt-4o 在 pid_openai）
    expect(preview.textContent).toContain('GPT-4o');
  });

  it('传 defaultModelId 时不走内部自拉（不 fetch /config/app default_models）', async () => {
    fetchSpy.mockClear();
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModelId="gpt-4o"
        onChange={() => {}}
      />,
    );
    await waitFor(() => {
      expect(getTrigger()).toBeTruthy();
    });
    // self-fetch 守卫：defaultModelId !== undefined → 不发 GET /config/app default_models
    const configCalls = fetchSpy.mock.calls.filter((c) => {
      const url = typeof c[0] === 'string' ? c[0] : String(c[0]);
      return url.includes('/config/app?group=default_models');
    });
    expect(configCalls.length).toBe(0);
  });

  it('click 菜单：命中的默认项在顶部显示（model-picker-default-item 含反查模型名）', async () => {
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModelId="gpt-4o"
        onChange={() => {}}
      />,
    );
    fireEvent.click(getTrigger());
    const defaultItem = (await screen.findByText(/（默认）/)).closest('button') as HTMLElement;
    expect(defaultItem.textContent).toContain('GPT-4o');
    expect(defaultItem.textContent).toContain('默认');
  });
});

// ============================================================
// [v0.0.148 picker UI 统一] click 菜单顶部加题目行（统一 UI）
// 参考: specs/ui/components/chat-page/component-input-model-picker.md（pickerTitle）
// ============================================================
describe('InputModelPicker — click 菜单题目行（picker UI 统一）', () => {
  beforeEach(() => __setProvidersCacheForTest(FAKE_PROVIDERS));

  it('click 菜单顶部渲染题目行 model-picker-menu-title（文案=模型选择）', async () => {
    render(<InputModelPicker model={null} defaultModel={null} onChange={() => {}} />);
    fireEvent.click(getTrigger());
    const title = await screen.findByRole('heading', { name: '模型选择' });
    expect(title).toBeTruthy();
    expect(title.textContent).toContain('模型选择');
  });

  it('题目行在选项上方（DOM 顺序：title 在 default-item / list-item 之前）', async () => {
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModel={{ providerId: 'pid_openai', modelId: 'gpt-4o' }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(getTrigger());
    await screen.findByRole('listbox');
    const title = screen.getByRole('heading', { name: '模型选择' });
    const defaultItem = getDefaultItem()!;
    // 题目行 DOM 顺序在默认项之前（options 在题目下方）
    expect(title.compareDocumentPosition(defaultItem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('未 click 展开时题目行不渲染（题目仅 click 菜单）', () => {
    render(<InputModelPicker model={null} defaultModel={null} onChange={() => {}} />);
    expect(screen.queryByRole('heading', { name: '模型选择' })).toBeNull();
  });
});

describe('InputModelPicker — 方案维度默认（v0.0.357：hasDefaultRoute = hasDefault || hasPlan）', () => {
  beforeEach(() => __setProvidersCacheForTest(FAKE_PROVIDERS));
  const PLAN = { planId: 'plan-1', planName: '方案 甲' };

  it('方案态 hover 预览显「方案 · 名（默认）」（isReservedDefault && !hasDefault && hasPlan）', async () => {
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModel={null}
        defaultPlan={PLAN}
        onChange={() => {}}
      />,
    );
    // trigger aria-label = previewLabel（方案态）
    await waitFor(() => {
      expect(getTrigger().getAttribute('aria-label')).toBe('方案 · 方案 甲（默认）');
    });
    // hover 出预览单条，显方案态 label（非「未配置」）
    fireEvent.mouseEnter(getTrigger().parentElement!);
    await screen.findByRole('listbox');
    expect(screen.getByText('方案 · 方案 甲（默认）')).toBeTruthy();
    expect(screen.queryByText('未配置')).toBeNull();
  });

  it('方案态菜单顶部有默认项（label=方案 · 名（默认），hasDefaultRoute 条件）', async () => {
    render(
      <InputModelPicker
        model={{ providerId: '', modelId: 'default' }}
        defaultModel={null}
        defaultPlan={PLAN}
        onChange={() => {}}
      />,
    );
    fireEvent.click(getTrigger());
    await screen.findByRole('listbox');
    // 菜单顶部默认项（方案态 label）
    expect(screen.getByText('方案 · 方案 甲（默认）')).toBeTruthy();
    // 全量列表仍在
    expect(getOption('OpenAI / GPT-4o')).toBeTruthy();
  });

  it('方案态点默认项 → onChange({providerId:\'\',modelId:\'default\'})（复用保留字写回）', async () => {
    const onChange = vi.fn();
    render(
      <InputModelPicker
        model={{ providerId: 'pid_openai', modelId: 'gpt-4o' }}
        defaultModel={null}
        defaultPlan={PLAN}
        onChange={onChange}
      />,
    );
    fireEvent.click(getTrigger());
    await screen.findByRole('listbox');
    fireEvent.click(screen.getByText('方案 · 方案 甲（默认）'));
    expect(onChange).toHaveBeenCalledWith({ providerId: '', modelId: 'default' });
  });
});
