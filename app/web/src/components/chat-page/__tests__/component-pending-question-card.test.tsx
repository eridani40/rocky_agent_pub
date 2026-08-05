// @vitest-environment jsdom
/**
 * component-pending-question-card 单测（竖向步骤导航提问卡）
 * 参考: specs/ui/components/chat-page/component-pending-question-card.md
 *
 * 多问题 = 左侧竖向步骤导航 —— 一次只有 active 题在 DOM。
 * 断言某题选项前须先切到该题导航项（default active = 首题 Q1）。
 * 「其他」恒定渲染为每题末位选项（不再消费 allowOther 字段）。
 * 提交按钮用 aria-disabled（非原生 disabled），未答完 hover 弹提示。
 * 导航点击/focus-follows 切换、单选自动前进、状态圆点、进度文案更新
 * 见 component-pending-question-nav.test.tsx。
 *
 * 覆盖：
 *   - 渲染：容器 / 多题渲染导航 / 单题不渲染导航 / 仅 active 题选项 / 提交按钮
 *   - 「其他」恒定渲染（allowOther 缺省/false 均渲染 + 选中展开输入框）
 *   - 单选（radio）互斥 / 多选（checkbox）增删
 *   - 提交 aria-disabled 'true'→'false' + 未答完 hover 弹提示
 *   - 提交 payload（FeedbackAnswer.selections，含「其他：<text>」）
 *   - need_approval 不渲染；切换 pending（key=toolCallId）重置
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentPendingQuestionCard } from '../component-pending-question-card';
import { initI18n } from '../../../i18n';
import type { PendingToolCallView, FeedbackData } from '../types';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

/** 构造 need_feedback pending（q1=single / q2=multi；两题均不给 allowOther —— 「其他」恒定渲染不依赖它） */
function makePending(overrides: Partial<PendingToolCallView> = {}): PendingToolCallView {
  return {
    sessionId: 's1',
    runId: 'r1',
    toolCallId: 'tc1',
    toolName: 'ask-question',
    handleType: 'direct_result',
    subState: 'need_feedback',
    data: {
      prompt: '请回答',
      questions: [
        {
          id: 'q1',
          title: '首选编程语言',
          type: 'single',
          options: [
            { key: 'python', label: 'Python' },
            { key: 'javascript', label: 'JavaScript' },
          ],
        },
        {
          id: 'q2',
          title: '项目用途',
          type: 'multi',
          options: [
            { key: 'web', label: 'Web' },
            { key: 'data', label: 'Data' },
          ],
        },
      ],
    },
    resultMessageId: 'm1',
    resultBlockIndex: 0,
    status: 'pending',
    ...overrides,
  };
}

/** 切到指定题的导航项（active 题才渲染其选项区块） */
function switchNav(qId: string) {
  fireEvent.click(screen.getByTestId(`pending-q-nav-${qId}`));
}

/** 选项 label（按选项文案定位，active 题内唯一） */
function getOption(label: string): HTMLElement {
  return screen.getByText(label).closest('label') as HTMLElement;
}

/** 「其他」选项 label */
function getOtherToggle(): HTMLElement {
  return screen.getByText('其他').closest('label') as HTMLElement;
}

/** 读提交按钮 aria-disabled（用 aria-disabled 而非原生 disabled） */
function submitAriaDisabled(): string | null {
  return screen.getByRole('button', { name: '提交' }).getAttribute('aria-disabled');
}

describe('ComponentPendingQuestionCard · 渲染契约', () => {
  it('多题：渲染容器 + 左侧竖向导航（每题一项）+ 仅 active 题选项 + 进度 + 提交按钮', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    expect(screen.getByText('请回答')).toBeTruthy();
    // 每题一个导航项（导航列常驻，两题都在 DOM）
    expect(screen.getByTestId('pending-q-nav-q1')).toBeTruthy();
    expect(screen.getByTestId('pending-q-nav-q2')).toBeTruthy();
    // active 题（q1，默认首题）区块标题 + 选项在 DOM
    expect(screen.getByText('首选编程语言', { selector: '.font-medium' })).toBeTruthy();
    expect(getOption('Python')).toBeTruthy();
    expect(getOption('JavaScript')).toBeTruthy();
    expect(getOtherToggle()).toBeTruthy();
    // 非 active 题（q2）选项不在 DOM
    expect(screen.queryByText('Web')).toBeNull();
    // 进度文案 + 提交按钮
    expect(screen.getByText('已答 0/2')).toBeTruthy();
    expect(screen.getByRole('button', { name: '提交' })).toBeTruthy();
  });

  it('单题：不渲染导航列，内容区独占', () => {
    const pending = makePending();
    const data = pending.data as FeedbackData;
    data.questions = [data.questions[0]!];
    render(<ComponentPendingQuestionCard pending={pending} onSubmit={vi.fn()} />);
    expect(screen.queryByTestId('pending-q-nav-q1')).toBeNull();
    // 内容区仍渲染该题选项 + 进度文案按单题计数
    expect(getOption('Python')).toBeTruthy();
    expect(screen.getByText('已答 0/1')).toBeTruthy();
  });

  it('未答完时提交按钮 aria-disabled=true（全答完才可提交）', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    expect(submitAriaDisabled()).toBe('true');
  });

  it('无 prompt 时渲染 awaitInput hint（pulse dot + 等待文案）', () => {
    const pending = makePending();
    pending.data = { ...pending.data, prompt: undefined };
    render(<ComponentPendingQuestionCard pending={pending} onSubmit={vi.fn()} />);
    expect(screen.getByText('等待你的回答')).toBeTruthy();
  });
});

describe('ComponentPendingQuestionCard · 「其他」恒定渲染', () => {
  it('allowOther 缺省（fixture 两题均未给）也渲染「其他」为末位选项', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    expect(getOtherToggle()).toBeTruthy(); // q1
    switchNav('q2');
    expect(getOtherToggle()).toBeTruthy(); // q2
  });

  it('allowOther=false 也渲染「其他」，选中展开输入框', () => {
    const pending = makePending();
    (pending.data as FeedbackData).questions[0]!.allowOther = false;
    render(<ComponentPendingQuestionCard pending={pending} onSubmit={vi.fn()} />);
    expect(screen.queryByPlaceholderText('请输入其他答案')).toBeNull();
    fireEvent.click(getOtherToggle());
    expect(screen.getByPlaceholderText('请输入其他答案')).toBeTruthy();
  });

  it('输入文本同步输入框值；toggle off → 输入框消失 + 清理 selection（q2 多选）', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    switchNav('q2');
    fireEvent.click(getOtherToggle());
    const input = screen.getByPlaceholderText('请输入其他答案') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '因为需要灵活' } });
    expect(input.value).toBe('因为需要灵活');
    fireEvent.click(getOtherToggle());
    expect(screen.queryByPlaceholderText('请输入其他答案')).toBeNull();
  });
});

describe('ComponentPendingQuestionCard · 单选（radio）', () => {
  it('单选再点同 option 切掉（允许空答；提交要求至少 1 项）', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    fireEvent.click(getOption('Python')); // 选中后自动前进到 q2（见 nav 测试）
    switchNav('q1'); // 切回 q1 再点同项切掉
    fireEvent.click(getOption('Python'));
    const radio = getOption('Python').querySelector('input[type="radio"]') as HTMLInputElement;
    expect(radio.checked).toBe(false);
  });

  it('单选题「其他」是 radio（非 checkbox）——与普通单选项同组视觉', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    const otherToggle = getOtherToggle();
    expect(otherToggle.querySelector('input[type="radio"]')).toBeTruthy();
    expect(otherToggle.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('单选排他①：选普通项 → 关掉已展开的「其他」（互斥）', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    fireEvent.click(getOtherToggle());
    fireEvent.change(screen.getByPlaceholderText('请输入其他答案'), { target: { value: 'Rust' } });
    fireEvent.click(getOption('Python')); // 选普通项关「其他」+ 自动前进到 q2
    expect(screen.queryByPlaceholderText('请输入其他答案')).toBeNull();
    switchNav('q1'); // 切回验证普通项选中保留
    const py = getOption('Python').querySelector('input') as HTMLInputElement;
    expect(py.checked).toBe(true);
  });

  it('单选排他②：选「其他」→ 清掉已选普通项（整题只留其他）', () => {
    const onSubmit = vi.fn();
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={onSubmit} />);
    fireEvent.click(getOption('Python')); // 选中后自动前进到 q2
    switchNav('q1');
    fireEvent.click(getOtherToggle());
    const py = getOption('Python').querySelector('input') as HTMLInputElement;
    expect(py.checked).toBe(false);
    fireEvent.change(screen.getByPlaceholderText('请输入其他答案'), { target: { value: 'Rust' } });
    switchNav('q2');
    fireEvent.click(getOption('Web'));
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    const [, , payload] = onSubmit.mock.calls[0]!;
    expect(payload.selections.q1).toEqual(['其他：Rust']);
    expect(payload.selections.q1).not.toContain('python');
  });
});

describe('ComponentPendingQuestionCard · 多选（checkbox）', () => {
  it('点 q2-web + q2-data 增选（checkbox 增删；先切 q2）', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    switchNav('q2');
    fireEvent.click(getOption('Web'));
    fireEvent.click(getOption('Data'));
    const webInput = getOption('Web').querySelector('input[type="checkbox"]') as HTMLInputElement;
    const dataInput = getOption('Data').querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(webInput.checked).toBe(true);
    expect(dataInput.checked).toBe(true);
    fireEvent.click(getOption('Web'));
    expect(webInput.checked).toBe(false);
    expect(dataInput.checked).toBe(true);
  });
});

describe('ComponentPendingQuestionCard · 提交（aria-disabled → enabled → onSubmit）', () => {
  it('q1 单选 + q2 多选后 → submit 转可提交；点 submit → onSubmit 调用含 FeedbackAnswer', () => {
    const onSubmit = vi.fn();
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={onSubmit} />);
    expect(submitAriaDisabled()).toBe('true');
    fireEvent.click(getOption('Python')); // q1 选中后自动前进到 q2
    fireEvent.click(getOption('Web')); // q2 多选
    expect(submitAriaDisabled()).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [toolCallId, handleType, payload] = onSubmit.mock.calls[0]!;
    expect(toolCallId).toBe('tc1');
    expect(handleType).toBe('direct_result');
    expect(payload.selections.q1).toEqual(['python']);
    expect(payload.selections.q2).toEqual(['web']);
  });

  it('未答完 hover 提交按钮 → 弹「请回答完问题再提交」提示', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    // 未答完时 submit 包在 PrimitiveTooltip 里，button.parentElement = trigger 承接 hover
    const trigger = screen.getByRole('button', { name: '提交' }).parentElement as HTMLElement;
    fireEvent.mouseEnter(trigger);
    expect(screen.getByText('请回答完问题再提交')).toBeTruthy();
  });

  it('提交含「其他：<text>」（选中「其他」+ 输入）', () => {
    const onSubmit = vi.fn();
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={onSubmit} />);
    fireEvent.click(getOption('Python')); // q1 选中后自动前进到 q2
    fireEvent.click(getOtherToggle()); // q2 多选选「其他」，不自动跳
    fireEvent.change(screen.getByPlaceholderText('请输入其他答案'), { target: { value: '需要灵活' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    const [, , payload] = onSubmit.mock.calls[0]!;
    expect(payload.selections.q2).toContain('其他：需要灵活');
  });
});

describe('ComponentPendingQuestionCard · 防御 + 切换重置', () => {
  it('need_approval 不渲染（本版只交 need_feedback）', () => {
    const pending = makePending({ subState: 'need_approval', data: { dummy: true } });
    const { container } = render(<ComponentPendingQuestionCard pending={pending} onSubmit={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('切换不同 toolCallId 的 pending → selections + activeQuestion 重置（key=toolCallId）', () => {
    const { rerender } = render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    fireEvent.click(getOption('Python')); // 答 q1 并自动前进到 q2
    expect(getOption('Web')).toBeTruthy();
    // 切换 pending（新 toolCallId）→ remount：activeQuestion 回首题 q1、selections 清空
    rerender(<ComponentPendingQuestionCard pending={makePending({ toolCallId: 'tc2' })} onSubmit={vi.fn()} />);
    const radio = getOption('Python').querySelector('input') as HTMLInputElement;
    expect(radio.checked).toBe(false);
    // active 回到 q1（q2 选项不在 DOM）
    expect(screen.queryByText('Web')).toBeNull();
  });
});
