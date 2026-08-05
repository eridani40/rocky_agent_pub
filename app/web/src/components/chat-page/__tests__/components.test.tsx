// @vitest-environment jsdom
/**
 * chat-page 组件渲染单测（折叠/展开 + finish reason 各态）
 * 参考: specs/ui/components/chat-page/_overview.md §4.8/§4.9/§4.13
 *
 * 定位策略（产品 testid 已删，改走语义锚点）：
 *   - tool-batch：标题文案「工具调用」；toggle=标题父级 clickable div
 *   - tool-call-item：工具名文案（bash）；toggle=名字父级 head；args=最近 rounded-xl 内 pl-5 body
 *   - run-finish：非 error 原因 span=div.flex 第二子；error icon=role=img；reason=span.truncate
 *   - spinner：产品保留 data-phase 属性
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentToolBatch } from '../component-tool-batch';
import { ComponentToolCallItem } from '../component-tool-call-item';
import { ComponentRunFinish } from '../component-run-finish';
import { ComponentMessageStream } from '../component-message-stream';
import { ComponentLoadingStatus } from '../component-loading-status';
import { PrimitiveMarkdownView } from '../../common/primitive-markdown-view';
import type { ViewElement, RunFinish, Message } from '../types';
import { initI18n } from '../../../i18n';

// [v0.0.59 i18n] 启动 i18next instance（zh-CN），让 ErrorRow 内 useTranslation('error') 能查 locale 表
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

// —— 语义定位 helper —— //

/** tool-batch 折叠胶囊 toggle：标题「工具调用」的父级 clickable div（含进度文案） */
function getToolBatchToggle(): HTMLElement {
  return screen.getByText('工具调用').parentElement as HTMLElement;
}
/** tool-call-item head toggle：工具名文案的父级 clickable div（含 status pill） */
function getToolCallToggle(name = 'bash'): HTMLElement {
  return screen.getByText(name).parentElement as HTMLElement;
}
/** tool-call-item 行容器：工具名文案的最近 rounded-xl 祖先 */
function getToolCallItem(name = 'bash'): HTMLElement {
  return screen.getByText(name).closest('.rounded-xl') as HTMLElement;
}
/** run-finish 非 error 形态：分隔线行中间的原因 span（div.flex 的第二个子元素） */
function getReasonSpan(container: HTMLElement): HTMLElement {
  return container.querySelector('div.flex')!.children[1] as HTMLElement;
}
/** on-message spinner 指定 phase 节点（产品保留 data-phase 属性） */
function getSpinnerPhase(phase: string): HTMLElement | null {
  return document.querySelector(`[data-phase="${phase}"]`);
}

const call = (overrides: Partial<Extract<ViewElement, { kind: 'tool-call-item' }>> = {}): Extract<ViewElement, { kind: 'tool-call-item' }> => ({
  kind: 'tool-call-item',
  key: 'k-' + Math.random(),
  messageId: 'm1',
  toolCallId: 'tc1',
  name: 'bash',
  arguments: { command: 'ls' },
  ...overrides,
});

describe('ComponentToolBatch', () => {
  it('折叠态默认显示进度 done/total', () => {
    const calls = [
      call({ toolCallId: 'c1', result: { content: [], isError: false } }),
      call({ toolCallId: 'c2' }),
    ];
    render(<ComponentToolBatch calls={calls} runActive={true} />);
    expect(screen.getByText('工具调用')).toBeTruthy();
    expect(getToolBatchToggle().textContent).toContain('1/2');
  });

  it('点击 toggle 展开 → 包裹各 tool-call-item', () => {
    const calls = [call({ toolCallId: 'c1' }), call({ toolCallId: 'c2' })];
    render(<ComponentToolBatch calls={calls} runActive={false} />);
    fireEvent.click(getToolBatchToggle());
    // 展开后两个 tool-call-item（均以工具名 bash 渲染）
    expect(screen.getAllByText('bash').length).toBe(2);
  });
});

describe('ComponentToolCallItem', () => {
  it('status done（有 result 非错）', () => {
    render(
      <ComponentToolCallItem
        call={call({ result: { content: [{ type: 'text', text: 'ok' }], isError: false } })}
      />,
    );
    expect(getToolCallItem()).toBeTruthy();
    expect(getToolCallToggle().textContent).toContain('done');
  });

  it('展开显示参数 KV（禁 JSON）', () => {
    render(<ComponentToolCallItem call={call({ arguments: { path: '/tmp/x' } })} />);
    fireEvent.click(getToolCallToggle());
    // 展开 body（pl-5）含参数 key/value
    const args = getToolCallItem().querySelector('[class*="pl-5"]') as HTMLElement;
    expect(args.textContent).toContain('path');
    expect(args.textContent).toContain('/tmp/x');
  });
});

describe('ComponentRunFinish', () => {
  it('no_tool_call → 克制态 ✓ 已完成', () => {
    const { container } = render(<ComponentRunFinish finish={{ stopReason: 'no_tool_call' } as RunFinish} />);
    expect(getReasonSpan(container).textContent).toContain('已完成');
    // 非 error 形态：无 ⚠️ icon
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('[v0.0.25] error → ⚠️ icon + displayReason + code pill（无红框卡片节点）', () => {
    const { container } = render(
      <ComponentRunFinish
        finish={{
          stopReason: 'error',
          error: {
            category: 'RATE_LIMITED',
            displayReason: '模型限流',
            detail: '429 retry-after 30',
            code: 'RATE_LIMIT',
          },
        }}
      />,
    );
    expect(screen.getByRole('img')).not.toBeNull();
    // [v0.0.59 i18n] displayReason 走 locale 查表：RATE_LIMITED → error.llm.rateLimited
    expect(container.querySelector('span.truncate')!.textContent).toBe('模型限流，请稍后重试');
    expect(screen.getByText('RATE_LIMIT').textContent).toContain('RATE_LIMIT');
    // [v0.0.25] 卡片形态废除：error 以 inline 行渲染，detail 仅 tooltip（不占可见描述节点）
    expect(screen.queryByText('429 retry-after 30')).toBeNull();
    expect(container.querySelectorAll('span.truncate').length).toBe(1);
  });

  it('max_iterations → gold 警告', () => {
    const { container } = render(<ComponentRunFinish finish={{ stopReason: 'max_iterations' }} />);
    expect(getReasonSpan(container).textContent).toContain('迭代');
  });
});

// [v0.0.25] MessageStream run-finish 守卫改 sessionRunning 门控（§4.13 line 225 / §2 rule7a）：
// sessionRunning 权威源 = session_panel（含 interrupting/interrupted 中间态更准），
// 比 runActive（agent_loop run_start/run_stop）更准——避免 interrupting 短暂窗口内 finish 与 abort-btn 叠加。
// store reducer 在 run_start 不清空 lastRunFinish（保留上一个 run 的 stop reason），故靠 sessionRunning 守卫。
// 参考: specs/ui/components/chat-page/_overview.md §4.13
describe('ComponentMessageStream run-finish guard (sessionRunning 门控)', () => {
  // 一个最小 messages（user 文本即可），run-finish 渲染与 messages 内容无关
  const messages: Message[] = [
    {
      id: 'm1',
      sessionId: 's1',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      createdAt: '2026-06-20T00:00:00Z',
    },
  ];
  const finish: RunFinish = { stopReason: 'no_tool_call' };

  it('sessionRunning=true 时即便 lastRunFinish 非空也不渲染 run-finish', () => {
    render(
      <ComponentMessageStream messages={messages} runActive={true} sessionRunning={true} lastRunFinish={finish} />,
    );
    // no_tool_call 原因文案「✓ 已完成」不出现
    expect(screen.queryByText(/已完成/)).toBeNull();
  });

  it('sessionRunning=false 且 lastRunFinish 非空时渲染 run-finish', () => {
    render(
      <ComponentMessageStream messages={messages} runActive={false} sessionRunning={false} lastRunFinish={finish} />,
    );
    expect(screen.getByText(/已完成/)).toBeTruthy();
    expect(screen.getByText(/已完成/).textContent).toContain('已完成');
  });
});

describe('ComponentLoadingStatus', () => {
  // [v0.0.42] 改版：浮动胶囊 → on-message spinner；data-phase 标记阶段
  it('phase=null 兜底 thinking（data-phase=thinking，spinner 仍转）', () => {
    render(<ComponentLoadingStatus phase={null} />);
    expect(getSpinnerPhase('thinking')).toBeTruthy();
  });

  it('phase=thinking 显示对应阶段', () => {
    render(<ComponentLoadingStatus phase="thinking" />);
    expect(getSpinnerPhase('thinking')).toBeTruthy();
    expect(getSpinnerPhase('thinking')!.textContent).toContain('思考中');
  });
});

describe('PrimitiveMarkdownView', () => {
  it('加粗 + 行内代码 + 列表 + 代码块', () => {
    const src = [
      '正文 **加粗** 与 `code`',
      '',
      '- 项 1',
      '- 项 2',
      '',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n');
    const { container } = render(<PrimitiveMarkdownView source={src} />);
    expect(container.querySelector('strong')?.textContent).toBe('加粗');
    expect(container.querySelectorAll('code').length).toBeGreaterThan(0);
    expect(container.querySelector('ul')?.querySelectorAll('li').length).toBe(2);
    expect(container.querySelector('pre')?.textContent).toContain('const x = 1;');
  });
});
