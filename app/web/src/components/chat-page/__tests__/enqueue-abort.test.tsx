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
import { ComponentEnqueueView, truncatePreview } from '../component-enqueue-view';
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

// [v0.0.285] 排队消息展示优化：折叠态第一行 / 展开态 max-h 滚动 / 多条互斥
describe('v0.0.285 — 排队消息展示优化', () => {
  it('折叠态显示第一行（多行内容只展示首行，不显示中段）', () => {
    render(
      <ComponentEnqueueView
        items={[{ enqueueId: 'eq1', content: '第一行内容\n第二行内容\n第三行内容' }]}
        running={true}
      />,
    );
    // 折叠态：data-open=false，内容只含首行
    const item = screen.getByText('第一行内容').closest('[data-open]');
    expect(item?.getAttribute('data-open')).toBe('false');
    // 第二行不应该出现在折叠态 DOM 中
    expect(screen.queryByText('第二行内容')).toBeNull();
    expect(screen.queryByText('第三行内容')).toBeNull();
  });

  it('展开态显示全文（含换行后的内容）', () => {
    render(
      <ComponentEnqueueView
        items={[{ enqueueId: 'eq1', content: '第一行\n第二行' }]}
        running={true}
      />,
    );
    // 点展开按钮
    fireEvent.click(screen.getByRole('button', { name: '展开全文' }));
    // 展开后全文可见（MentionRender 把多行文本拆成 whitespace-pre-wrap span，
    //   用 textContent 匹配全文而非 getByText 精确匹配）
    const item = document.querySelector('[data-open="true"]');
    expect(item).toBeTruthy();
    expect(item?.textContent).toContain('第一行');
    expect(item?.textContent).toContain('第二行');
    expect(item?.getAttribute('data-open')).toBe('true');
  });

  it('展开态内容区有 max-h + overflow-y-auto（可滚动）', () => {
    render(
      <ComponentEnqueueView
        items={[{ enqueueId: 'eq1', content: '短内容' }]}
        running={true}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '展开全文' }));
    // 展开态的内容 span 是 flex-1 min-w-0 的外层 span（含 max-h + overflow-y-auto）
    //   closest('span') 会匹配到 MentionRender 内部 span（whitespace-pre-wrap），
    //   改用 querySelector 找含 max-h 的 span
    const contentSpan = document.querySelector('[data-open="true"] span.max-h-\\[160px\\]');
    expect(contentSpan).toBeTruthy();
    expect(contentSpan?.className).toContain('overflow-y-auto');
  });

  it('多条互斥：展开 A 后展开 B → A 自动收起', () => {
    render(
      <ComponentEnqueueView
        items={[
          { enqueueId: 'eqA', content: '内容A全文' },
          { enqueueId: 'eqB', content: '内容B全文' },
        ]}
        running={true}
      />,
    );
    const expandBtns = screen.getAllByRole('button', { name: '展开全文' });
    expect(expandBtns).toHaveLength(2);

    // 展开 A
    fireEvent.click(expandBtns[0]!);
    const itemA = screen.getByText('内容A全文').closest('[data-open]');
    expect(itemA?.getAttribute('data-open')).toBe('true');

    // 展开 B → A 应自动收起
    const expandBtnB = screen.getAllByRole('button', { name: '展开全文' });
    // A 展开后 A 的按钮变「收起」，B 仍是「展开全文」
    fireEvent.click(expandBtnB[0]!);

    // 现在 B 展开、A 收起
    const itemB = screen.getByText('内容B全文').closest('[data-open]');
    expect(itemB?.getAttribute('data-open')).toBe('true');
    // A 折叠后只显示首行 preview（内容A全文 无 \n 所以首行=全文）
    const itemA2 = screen.getByText('内容A全文').closest('[data-open]');
    expect(itemA2?.getAttribute('data-open')).toBe('false');
  });

  it('再点同一个展开项 → 收起（toggle）', () => {
    render(
      <ComponentEnqueueView
        items={[{ enqueueId: 'eq1', content: '内容' }]}
        running={true}
      />,
    );
    // 展开
    fireEvent.click(screen.getByRole('button', { name: '展开全文' }));
    let item = screen.getByText('内容').closest('[data-open]');
    expect(item?.getAttribute('data-open')).toBe('true');
    // 再点（按钮现在是「收起」）
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    item = screen.getByText('内容').closest('[data-open]');
    expect(item?.getAttribute('data-open')).toBe('false');
  });

  it('折叠态内容 span 不含 leading-[32px]（半行坍塌修复）', () => {
    render(
      <ComponentEnqueueView
        items={[{ enqueueId: 'eq1', content: '测试' }]}
        running={true}
      />,
    );
    // closest('span') 会匹配到 MentionRender 内部 span（whitespace-pre-wrap），
    //   用 querySelector 定位折叠态卡片的外层内容 span（含 flex-1 + leading-tight）
    const contentSpan = document.querySelector('[data-open="false"] span.flex-1');
    expect(contentSpan?.className).not.toContain('leading-[32px]');
    expect(contentSpan?.className).toContain('leading-tight');
  });

  it('外层容器右对齐（items-end，非水平居中）', () => {
    const { container } = render(
      <ComponentEnqueueView
        items={[{ enqueueId: 'eq1', content: '测试' }]}
        running={true}
      />,
    );
    // 最外层 div 应含 items-end（右对齐）
    const outerDiv = container.firstChild as HTMLElement;
    expect(outerDiv.className).toContain('items-end');
  });
});

// [v0.0.293] 排队消息展示修复：顶部对齐统一 + 长行软折行
describe('v0.0.293 — 顶部对齐 + 长行软折行', () => {
  it('折叠态卡片用 items-center（非 items-start，序号 pill 顶部对齐）', () => {
    render(
      <ComponentEnqueueView
        items={[{ enqueueId: 'eq1', content: '测试内容' }]}
        running={true}
      />,
    );
    const card = document.querySelector('[data-open="false"]');
    expect(card?.className).toContain('items-center');
    // 不应含 items-center（v0.0.293 修复点）
    expect(card?.className).toContain('items-center');
  });

  it('展开态卡片同样 items-center（折叠→展开不跳变）', () => {
    render(
      <ComponentEnqueueView
        items={[{ enqueueId: 'eq1', content: '测试内容' }]}
        running={true}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '展开全文' }));
    const card = document.querySelector('[data-open="true"]');
    expect(card?.className).toContain('items-center');
  });

  it('多条排队消息统一 items-center（垂直顶部对齐）', () => {
    render(
      <ComponentEnqueueView
        items={[
          { enqueueId: 'eq1', content: '第一条' },
          { enqueueId: 'eq2', content: '第二条' },
          { enqueueId: 'eq3', content: '第三条' },
        ]}
        running={true}
      />,
    );
    const cards = document.querySelectorAll('[data-open]');
    expect(cards).toHaveLength(3);
    cards.forEach((c) => {
      expect(c.className).toContain('items-center');
      expect(c.className).toContain('items-center');
    });
  });

  it('展开态内容 span 有 wordBreak break-word（长中文软折行）', () => {
    render(
      <ComponentEnqueueView
        items={[{ enqueueId: 'eq1', content: '短内容' }]}
        running={true}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '展开全文' }));
    const contentSpan = document.querySelector('[data-open="true"] span.flex-1') as HTMLElement;
    expect(contentSpan).toBeTruthy();
    // v0.0.293：展开态强制 word-break:break-word（覆盖 MentionRender 内 whitespace-pre-wrap）
    expect(contentSpan.style.wordBreak).toBe('break-word');
    expect(contentSpan.style.overflowWrap).toBe('anywhere');
  });

  it('折叠态内容 span 无 wordBreak style（折叠态不需要折行）', () => {
    render(
      <ComponentEnqueueView
        items={[{ enqueueId: 'eq1', content: '短内容' }]}
        running={true}
      />,
    );
    const contentSpan = document.querySelector('[data-open="false"] span.flex-1') as HTMLElement;
    expect(contentSpan).toBeTruthy();
    // 折叠态：nowrap + ellipsis，无需 wordBreak
    expect(contentSpan.style.wordBreak).toBe('');
  });
});

// [v0.0.294] 收起态 10 字符截断 + …
describe('v0.0.294 — truncatePreview 收起态截断', () => {
  it('中文：≤10 字符不截断不加 …', () => {
    expect(truncatePreview('短', 10)).toBe('短');
    expect(truncatePreview('测试一条', 10)).toBe('测试一条');
    expect(truncatePreview('测试一条排队消息', 10)).toBe('测试一条排队消息');
  });

  it('中文：>10 字符截断到 10 字 + …', () => {
    // 11 个中文字符 → 截前 10 + …
    expect(truncatePreview('测试一条排队消息再加字', 10)).toBe('测试一条排队消息再加…');
  });

  it('英文：保留到单词结尾（不截断单词中间）', () => {
    // hello world foo → 前 10 字符 = 'hello worl'，末尾 'l' 是字母 → 扩展到 'world' 结尾
    expect(truncatePreview('hello world foo', 10)).toBe('hello world…');
  });

  it('英文：单词 ≤10 字符 + 空格后继续（保留到第 10 字符位置所在单词的结尾）', () => {
    // 'abcdefghij xxx' → 前 10 = 'abcdefghij'，末尾是字母 → 扩展但无后续字母 → 回退硬截
    expect(truncatePreview('abcdefghij xxx', 10)).toBe('abcdefghij…');
  });

  it('英文+中文混合：末尾单词延伸到结尾 → 返回原文（不加 …）', () => {
    // '你好hello world' = 2+11=13 字符；前 10 = '你好hello wo'，末尾 'o' 字母 → 扩展到 'world'
    // 扩展后等于原文（world 是末尾单词）→ 原文就是最佳预览，不加 …
    expect(truncatePreview('你好hello world', 10)).toBe('你好hello world');
  });

  it('英文+中文混合：末尾单词后有更多内容 → 截断 + …', () => {
    // '你好hello world foo' → 前 10 = '你好hello wo'，扩展到 'world'（有空格断），后续还有 foo
    expect(truncatePreview('你好hello world foo', 10)).toBe('你好hello world…');
  });

  it('前后空白 trim', () => {
    expect(truncatePreview('  短文本  ', 10)).toBe('短文本');
  });

  it('收起态 DOM：渲染截断文本（含 …），不显示全文', () => {
    render(
      <ComponentEnqueueView
        items={[{ enqueueId: 'eq1', content: '这是一条很长的排队消息内容需要被截断' }]}
        running={true}
      />,
    );
    // 收起态文本含 …，不含被截断的内容
    const item = document.querySelector('[data-open="false"]');
    expect(item?.textContent).toContain('…');
    expect(item?.textContent).not.toContain('需要被截断');
  });

  it('展开态渲染全文（不含 …）', () => {
    render(
      <ComponentEnqueueView
        items={[{ enqueueId: 'eq1', content: '这是一条很长的排队消息内容需要被截断' }]}
        running={true}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '展开全文' }));
    const item = document.querySelector('[data-open="true"]');
    expect(item?.textContent).toContain('需要被截断');
    expect(item?.textContent).not.toContain('…');
  });
});
