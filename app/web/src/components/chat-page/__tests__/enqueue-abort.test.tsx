// @vitest-environment jsdom
/**
 * [v0.0.12] enqueue-view + abort-btn 单测
 * 参考: specs/ui/components/chat-page/_overview.md §4.11a / §4.11b / §5-2b / §5-3
 *       specs/ui/components/chat-page/_components.md component-enqueue-view / component-abort-btn
 *
 * 覆盖：
 *   - reducer enqueue 三事件（message_enqueued 建 / enqueued_message_processed|canceled 幂等移除）
 *   - abort-btn running 时显示 + 点击 disabled 防连点
 *   - enqueue-view 可见条件（running && items 非空）
 *   - 对话区无乐观插入（发消息不产生 local-<ts>）
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { applyAgentEventToMessages, type AgentEvent } from '../../../store/chat-slice';
import type { RunContext } from '../../../store/chat-slice-reducer';
import { ComponentEnqueueView } from '../component-enqueue-view';
import { ComponentAbortBtn } from '../component-abort-btn';
import type { Message } from '../types';
import { initI18n } from '../../../i18n';

// [v0.0.62 i18n] 启动 i18next instance：enqueue-view / abort-btn 内部用 useTranslation 查 chat.enqueue.* + chat.abort.* + common.action.*
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

const baseState = {
  loadingPhase: null as null | string,
  runActive: false,
  lastRunFinish: null as null | { stopReason: string; error?: { message: string; code: string } },
  enqueueItems: [] as { enqueueId: string; content: string }[],
};

function reduce(events: AgentEvent[]) {
  // v0.0.95：reducer 纯化——runCtx 改值传递（出入参）；不再用 ctxRef mutate。
  let runCtx: RunContext | null = null;
  let state = { ...baseState, messages: [] as Message[] };
  for (const e of events) {
    const r = applyAgentEventToMessages(state.messages, runCtx, e, state as never);
    state = r as typeof state;
    runCtx = r.runCtx;
  }
  return state;
}

describe('reducer enqueue 三事件', () => {
  it('message_enqueued 建项（running 时排队）', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'message_enqueued', enqueueId: 'eq1', content: '第二条' },
    ]);
    expect(s.enqueueItems).toEqual([{ enqueueId: 'eq1', content: '第二条' }]);
  });

  it('同 enqueueId message_enqueued 幂等（不重复入列）', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'message_enqueued', enqueueId: 'eq1', content: 'A' },
      { type: 'message_enqueued', enqueueId: 'eq1', content: 'A' },
    ]);
    expect(s.enqueueItems).toHaveLength(1);
  });

  it('enqueued_message_processed 按 enqueueId 移除', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'message_enqueued', enqueueId: 'eq1', content: 'A' },
      { type: 'message_enqueued', enqueueId: 'eq2', content: 'B' },
      { type: 'enqueued_message_processed', enqueueId: 'eq1' },
    ]);
    expect(s.enqueueItems).toEqual([{ enqueueId: 'eq2', content: 'B' }]);
  });

  it('enqueued_message_canceled 按 enqueueId 移除', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'message_enqueued', enqueueId: 'eq1', content: 'A' },
      { type: 'enqueued_message_canceled', enqueueId: 'eq1' },
    ]);
    expect(s.enqueueItems).toHaveLength(0);
  });

  it('processed / canceled 二者幂等（已移除再收到无操作）', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'message_enqueued', enqueueId: 'eq1', content: 'A' },
      { type: 'enqueued_message_processed', enqueueId: 'eq1' },
      { type: 'enqueued_message_canceled', enqueueId: 'eq1' },
    ]);
    expect(s.enqueueItems).toHaveLength(0);
  });
});

// [v0.0.97] cancel 不再乐观移除（移项靠 SSE enqueued_message_canceled）；reducer 三事件测试仍有效。
// 本文件其余测试（纯 reducer enqueue 三事件 + ComponentEnqueueView/AbortBtn 渲染）仍有效。

describe('ComponentEnqueueView 可见条件', () => {
  it('running=true 且 items 非空时渲染', () => {
    render(
      <ComponentEnqueueView
        items={[{ enqueueId: 'eq1', content: 'A' }]}
        running={true}
      />,
    );
    expect(screen.getByText(/队列中/)).toBeTruthy();
    expect(screen.getByText('A').closest('[data-open]')).toBeTruthy();
    expect(screen.getByText('A').textContent).toBe('A');
    expect(screen.getByRole('button', { name: '移出队列' })).toBeTruthy();
  });

  it('running=false 时不渲染（即使 items 非空）', () => {
    const { container } = render(
      <ComponentEnqueueView items={[{ enqueueId: 'eq1', content: 'A' }]} running={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('items 为空时不渲染（即使 running=true）', () => {
    const { container } = render(<ComponentEnqueueView items={[]} running={true} />);
    expect(container.firstChild).toBeNull();
  });

  it('[v0.0.97] 点击 cancel → onCancel POST + x 转圈（data-canceling=true，禁点防重复）', () => {
    let canceled = '';
    render(
      <ComponentEnqueueView
        items={[{ enqueueId: 'eq1', content: 'A' }]}
        running={true}
        onCancel={(id) => (canceled = id)}
      />,
    );
    const btn = screen.getByRole('button', { name: '移出队列' });
    // 初始：x 图标，data-canceling=false
    expect(btn.getAttribute('data-canceling')).toBe('false');
    fireEvent.click(btn);
    // onCancel 触发（fire-and-forget POST），无 onRemove（移项靠 SSE）
    expect(canceled).toBe('eq1');
    // x 立即转圈：data-canceling=true + disabled（防重复 POST）
    expect(btn.getAttribute('data-canceling')).toBe('true');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ComponentAbortBtn', () => {
  it('running 时渲染（父级控制可见）', () => {
    render(<ComponentAbortBtn sessionId="S1" />);
    expect(screen.getByRole('button', { name: '中断' })).toBeTruthy();
  });

  it('点击触发 onAbort + 立即 disabled（防连点）', () => {
    let count = 0;
    render(<ComponentAbortBtn sessionId="S1" onAbort={() => count++} />);
    const btn = screen.getByRole('button', { name: '中断' }) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(count).toBe(1);
    // 立即 disabled，再点不触发
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(count).toBe(1);
  });
});

// BUG-007（v0.0.12）：真 LLM content block `{type,text}` 崩 React 回归
// 根因：后端 message_enqueued.content 是 ContentBlock[]（与 Message.content 同构），
//   真 user message = [{type:'text',text:'...'}]；前端 reducer 误判为 string 直存，
//   enqueue-view 把该对象/数组当 React child 渲染 → "Objects are not valid as a React child"。
// 修：reducer contentBlocksToPreviewText 拍平为字符串；enqueue-view 再兜底 toTextPreview。
describe('BUG-007 — 真 LLM content block 不再崩 React', () => {
  it('reducer: message_enqueued.content=ContentBlock[] 拍平为预览字符串', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      {
        type: 'message_enqueued',
        enqueueId: 'eq1',
        content: [{ type: 'text', text: '帮我创建文件' }],
      },
    ]);
    expect(s.enqueueItems).toEqual([{ enqueueId: 'eq1', content: '帮我创建文件' }]);
  });

  it('reducer: content 多 text block 拼接 + 非 text block 忽略', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      {
        type: 'message_enqueued',
        enqueueId: 'eq1',
        content: [
          { type: 'text', text: '第一步' },
          { type: 'tool_call', id: 'x', name: 'bash', arguments: {} },
          { type: 'text', text: '第二步' },
        ],
      },
    ]);
    expect(s.enqueueItems[0]!.content).toBe('第一步第二步');
  });

  it('reducer: content=string（mock 旧路径）向后兼容', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'message_enqueued', enqueueId: 'eq1', content: '纯字符串路径' },
    ]);
    expect(s.enqueueItems[0]!.content).toBe('纯字符串路径');
  });

  it('enqueue-view: 即使 items 直接喂 ContentBlock[]，组件也兜底为文本（不崩 React）', () => {
    // 模拟意外路径：store 没走 reducer 标准化（如本地硬塞），组件层仍应渲染字符串而非崩树
    render(
      <ComponentEnqueueView
        // 故意用 any 绕类型检查，模拟 BUG-007 现场
        items={[
          {
            enqueueId: 'eq1',
            content: [{ type: 'text', text: '你好 Rocky' }] as unknown as string,
          },
        ]}
        running={true}
      />,
    );
    const span = screen.getByText('你好 Rocky');
    expect(span.textContent).toBe('你好 Rocky');
  });
});

describe('BUG-006 根治（v0.0.12）—— 对话区无乐观插入', () => {
  it('run_start 不创建消息（仅状态切换）', () => {
    const s = reduce([{ type: 'run_start', runId: 'R1', sessionId: 'S1' }]);
    expect(s.messages).toHaveLength(0);
    expect(s.runActive).toBe(true);
  });

  it('message_start(role=user) 用真身 ULID 入列（不依赖 local-* 启发式去重）', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'message_start', messageId: '01KVK5WTW75N3Z12AB', sessionId: 'S1', role: 'user' },
    ]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.id).toBe('01KVK5WTW75N3Z12AB');
    // 关键断言：id 不含 'local-' 前缀（无乐观插入）
    expect(s.messages[0]!.id.startsWith('local-')).toBe(false);
  });
});
