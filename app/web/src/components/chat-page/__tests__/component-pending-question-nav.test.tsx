// @vitest-environment jsdom
/**
 * component-pending-question-nav / 提问卡导航交互 单测（竖向序号 tab 导航）
 * 参考: specs/ui/components/chat-page/component-pending-question-card.md
 *
 * 通过 ComponentPendingQuestionCard 整体渲染验证（导航为卡片内部组件，多题才渲染）：
 * 点击 / 键盘 focus-follows 切换 active 题；状态圆点随已答翻转；底栏「已答 X/N」随作答更新；
 * 单选题选中普通项（新选中）自动前进到下一道未答题（按 questions 顺序第一个未答、排除当前题），
 * 多选 / 再点切掉 / 选「其他」不自动跳。
 * 导航 tab 只放序号 Q01（两位 padStart）+ 状态圆点，不渲染题目标题；
 * active 项 bg-surface text-accent（与内容区连通），非 active 透明底 text-muted。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentPendingQuestionCard } from '../component-pending-question-card';
import { initI18n } from '../../../i18n';
import type { PendingToolCallView, PendingQuestion } from '../types';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

/** 构造 need_feedback pending；questions 可定制（默认 q1=single / q2=multi） */
function makePending(questions?: PendingQuestion[]): PendingToolCallView {
  return {
    sessionId: 's1',
    runId: 'r1',
    toolCallId: 'tc1',
    toolName: 'ask-question',
    handleType: 'direct_result',
    subState: 'need_feedback',
    data: {
      prompt: '请回答',
      questions: questions ?? [
        { id: 'q1', title: '首选编程语言', type: 'single', options: [{ key: 'python', label: 'Python' }] },
        { id: 'q2', title: '项目用途', type: 'multi', options: [{ key: 'web', label: 'Web' }] },
      ],
    },
    resultMessageId: 'm1',
    resultBlockIndex: 0,
    status: 'pending',
  };
}

/** 三道单选题（验自动前进的顺序语义） */
function threeSingleQuestions(): PendingQuestion[] {
  return [1, 2, 3].map((n) => ({
    id: `q${n}`,
    title: `题目${n}`,
    type: 'single' as const,
    options: [{ key: `opt${n}`, label: `选项${n}` }],
  }));
}

function getNav(qId: string): HTMLElement {
  return screen.getByTestId(`pending-q-nav-${qId}`);
}

function getOption(label: string): HTMLElement {
  return screen.getByText(label).closest('label') as HTMLElement;
}

describe('PendingQuestionNav · 序号与样式', () => {
  it('tab 序号 = Q01/Q02 两位 padStart（font-mono 等宽），不渲染题目标题', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    expect(getNav('q1').textContent).toContain('Q01');
    expect(getNav('q2').textContent).toContain('Q02');
    // 导航内无题目标题（标题在内容区题干完整渲染，导航不重复）
    expect(getNav('q1').textContent).not.toContain('首选编程语言');
    expect(getNav('q2').textContent).not.toContain('项目用途');
  });

  it('active tab = bg-surface text-accent（与内容区连通）；非 active = 透明底 text-muted，切换后互换', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    // 默认 active = q1
    expect(getNav('q1').className).toContain('bg-surface');
    expect(getNav('q1').className).toContain('text-accent');
    expect(getNav('q2').className).toContain('text-muted');
    expect(getNav('q2').className).not.toContain('text-accent');
    fireEvent.click(getNav('q2'));
    expect(getNav('q2').className).toContain('bg-surface');
    expect(getNav('q2').className).toContain('text-accent');
    expect(getNav('q1').className).toContain('text-muted');
    expect(getNav('q1').className).not.toContain('text-accent');
  });
});

describe('PendingQuestionNav · 切换', () => {
  it('点击导航项切换 active 题（q2 选项出现、q1 选项移出 DOM）', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    expect(getOption('Python')).toBeTruthy();
    fireEvent.click(getNav('q2'));
    expect(getOption('Web')).toBeTruthy();
    expect(screen.queryByText('Python')).toBeNull();
  });

  it('键盘 focus-follows：focus 落到 Q2 导航项 → q2 选项出现', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    fireEvent.focus(getNav('q2'));
    expect(getOption('Web')).toBeTruthy();
    expect(screen.queryByText('Python')).toBeNull();
  });

  it('导航项是原生可聚焦 button 且不设 tabIndex=-1（键盘 Tab 可达）', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    const nav = getNav('q1');
    expect(nav.tagName).toBe('BUTTON');
    expect(nav.getAttribute('tabindex')).not.toBe('-1');
  });

  it('切走再切回 → 已答状态保留；导航状态圆点由未答(accent)翻转为已答(sage)', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    expect(getNav('q1').querySelector('span')!.className).toContain('bg-accent');
    fireEvent.click(getOption('Python')); // 选中后自动前进到 q2
    expect(getNav('q1').querySelector('span')!.className).toContain('bg-[var(--color-sage)]');
    fireEvent.click(getNav('q1')); // 切回
    const py = getOption('Python').querySelector('input') as HTMLInputElement;
    expect(py.checked).toBe(true);
  });
});

describe('PendingQuestionNav · 单选选中自动前进', () => {
  it('q1 单选选中普通项 → 自动切到 q2（q2 选项出现、q1 选项移出 DOM）', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    fireEvent.click(getOption('Python'));
    expect(getOption('Web')).toBeTruthy();
    expect(screen.queryByText('Python')).toBeNull();
  });

  it('前进目标 = 按 questions 顺序第一个未答题（先答 q3 → 跳回首题 q1，而非停留附近）', () => {
    render(<ComponentPendingQuestionCard pending={makePending(threeSingleQuestions())} onSubmit={vi.fn()} />);
    fireEvent.click(getNav('q3')); // 手动切到 q3
    fireEvent.click(getOption('选项3')); // 答 q3 → 第一个未答是 q1
    expect(getOption('选项1')).toBeTruthy();
    expect(screen.queryByText('选项3')).toBeNull();
  });

  it('无未答题时不跳（全答完停留当前题）', () => {
    const twoSingle = threeSingleQuestions().slice(0, 2);
    render(<ComponentPendingQuestionCard pending={makePending(twoSingle)} onSubmit={vi.fn()} />);
    fireEvent.click(getOption('选项1')); // 答 q1 → 跳到 q2
    fireEvent.click(getOption('选项2')); // 答 q2 → 全答完，停留 q2
    expect(getOption('选项2')).toBeTruthy();
  });

  it('再点同项切掉（取消选中）不自动跳', () => {
    const twoSingle = threeSingleQuestions().slice(0, 2);
    render(<ComponentPendingQuestionCard pending={makePending(twoSingle)} onSubmit={vi.fn()} />);
    fireEvent.click(getOption('选项1')); // 选中 → 跳到 q2
    fireEvent.click(getNav('q1')); // 切回 q1
    fireEvent.click(getOption('选项1')); // 再点切掉 → 停留 q1
    expect(getOption('选项1')).toBeTruthy();
    expect(screen.queryByText('选项2')).toBeNull();
  });

  it('多选题选任何项都不自动跳', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    fireEvent.click(getNav('q2'));
    fireEvent.click(getOption('Web'));
    expect(getOption('Web')).toBeTruthy(); // 停留 q2
  });

  it('选「其他」（toggleOther）不自动跳（用户要输入文本）', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByText('其他').closest('label') as HTMLElement); // q1 选「其他」
    expect(getOption('Python')).toBeTruthy(); // 停留 q1
    expect(screen.getByPlaceholderText('请输入其他答案')).toBeTruthy();
  });
});

describe('PendingQuestionNav · 进度文案', () => {
  it('「已答 X/N」随作答更新（0/2 → 1/2 → 2/2）', () => {
    render(<ComponentPendingQuestionCard pending={makePending()} onSubmit={vi.fn()} />);
    expect(screen.getByText('已答 0/2')).toBeTruthy();
    fireEvent.click(getOption('Python')); // 答 q1 → 跳到 q2
    expect(screen.getByText('已答 1/2')).toBeTruthy();
    fireEvent.click(getOption('Web')); // 答 q2（多选不跳）
    expect(screen.getByText('已答 2/2')).toBeTruthy();
  });
});
