/**
 * @vitest-environment jsdom
 * component-message-stream 策略注入单测（v0.0.39 参数化内核）
 * 参考: specs/ui/components/chat-page/_overview.md §4.6（三区布局）
 *       specs/ui/components/studio-page/squad-chat-page.md「渲染策略契约」
 *
 * 覆盖：
 *   - playground 零回归：不传策略 → 默认 Rocky/U 头像 + 消息行 DOM id（msg-{id}）
 *   - resolveActor 注入（squad 传 MemberAvatar → 渲 member/user 头像）
 *   - 群聊 messageFilter 白名单（内核层：assistant answer 不渲染）
 *   - reminder block 默认滤（内核层：reminder text 不渲染）
 *   - 群聊 a2a 角色名前缀行
 *
 * 定位策略（产品 testid 已删，改走语义锚点）：
 *   - 消息行：DOM id=`msg-{messageId}`（user/assistant 共用，side 由 self-end class 区分）
 *   - spinner：产品保留 data-phase 属性（thinking/answering/tool_calling/...）
 *   - 头像：默认 agent=img[alt=Rocky]；色块头像=首字母文案；按行 scope 用 within
 *   - tool-batch：标题文案「工具调用」
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { ComponentMessageStream } from '../component-message-stream';
import { MemberAvatar } from '../../common/member-avatar';
import { groupMessageFilter, resolveGroupActor } from '../chat-actor-strategy';
import type { Message } from '../types';
import { initI18n } from '../../../i18n';

// [v0.0.62 i18n] 启动 i18next instance：内嵌 ComponentLoadingStatus 文案走 chat.loading.*
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

// —— 语义定位 helper —— //

/** 消息行容器：DOM id=`msg-{messageId}`（找不到抛错） */
function getRow(messageId: string): HTMLElement {
  const el = document.getElementById(`msg-${messageId}`);
  if (!el) throw new Error(`message row msg-${messageId} not found`);
  return el;
}
/** 消息行容器（不存在返回 null） */
function queryRow(messageId: string): HTMLElement | null {
  return document.getElementById(`msg-${messageId}`);
}
/** 消息流滚动容器（chat-messages 锚点） */
function getStreamContainer(): Element | null {
  return document.querySelector('[class*="overflow-y-auto"]');
}
/** on-message spinner 容器（产品保留 data-phase 属性；找不到抛错） */
function getSpinner(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-phase]');
  if (!el) throw new Error('spinner not found');
  return el;
}
/** spinner 容器（不存在返回 null） */
function querySpinner(): HTMLElement | null {
  return document.querySelector('[data-phase]');
}
/** 指定 phase 的 spinner（不存在返回 null） */
function querySpinnerPhase(phase: string): HTMLElement | null {
  return document.querySelector(`[data-phase="${phase}"]`);
}

const userMsg = (id: string, text: string): Message => ({
  id,
  sessionId: 'S1',
  role: 'user',
  content: [{ type: 'text', text }],
  createdAt: '2026-06-29T00:00:00Z',
  sender: { source: 'user' },
});

const assistantMsg = (id: string, text: string): Message => ({
  id,
  sessionId: 'S1',
  role: 'assistant',
  content: [{ type: 'text', text }],
  createdAt: '2026-06-29T00:00:01Z',
});

const a2aInboxMsg = (id: string, name: string, type: 'leader' | 'mate'): Message => ({
  id,
  sessionId: 'S1',
  role: 'user',
  content: [{ type: 'text', text: id + '-a2a' }],
  createdAt: '2026-06-29T00:00:02Z',
  sender: { source: 'agent', agent: { ref: { type, name, sessionId: 'sx' }, needReply: false } },
});

describe('playground 零回归（不传策略 = 默认）', () => {
  it('默认渲染滚动容器 + 行 DOM id（msg-u1/msg-a1）', () => {
    render(
      <ComponentMessageStream
        messages={[userMsg('u1', 'hi'), assistantMsg('a1', 'reply')]}
        runActive={false}
        sessionRunning={false}
        lastRunFinish={null}
      />,
    );
    expect(getStreamContainer()).toBeTruthy();
    expect(getRow('u1')).toBeTruthy();
    expect(getRow('a1')).toBeTruthy();
  });

  it('默认 agent 头像 = Rocky icon（img src 含 rocky-icon）', () => {
    render(<ComponentMessageStream messages={[assistantMsg('a1', 'reply')]} />);
    const img = screen.getByAltText('Rocky') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.src).toContain('rocky-icon');
  });

  it('默认 user 头像 = U 色块（无 img，文本 U）', () => {
    render(<ComponentMessageStream messages={[userMsg('u1', 'hi')]} />);
    const av = screen.getByText('U');
    expect(av.tagName).not.toBe('IMG');
    expect(av.textContent).toBe('U');
  });

  it('runActive/sessionRunning/lastRunFinish 不传 = 不报错、不渲染 run-finish', () => {
    render(<ComponentMessageStream messages={[userMsg('u1', 'hi')]} />);
    expect(getStreamContainer()).toBeTruthy();
    // run-finish 不渲染（无 lastRunFinish）
    expect(screen.queryByText(/no_tool_call|error/i)).toBeNull();
  });
});

describe('resolveActor 注入（squad MemberAvatar 替换默认）', () => {
  it('传 resolveActor → user 行用 MemberAvatar(user)（非 Rocky img）', () => {
    const resolve = (m: Message) => {
      if (m.sender?.source === 'user') {
        return { avatar: <MemberAvatar name="you" role="user" /> };
      }
      return { avatar: <MemberAvatar name="bob" role="mate" /> };
    };
    render(
      <ComponentMessageStream
        messages={[userMsg('u1', 'hi')]}
        resolveActor={resolve}
       
      />,
    );
    // user 行 MemberAvatar(user) 渲染（[v0.0.165] 用中性灰 --fg-2 regulation 无前缀 token）
    const av = screen.getByText('Y'); // 'you' 首字母
    expect(av.textContent).toBe('Y');
    expect((av as HTMLElement).style.background).toBe('var(--fg-2)');
  });

  it('群聊策略（resolveGroupActor + groupMessageFilter）：a2a 渲 MemberAvatar + 前缀行，assistant mute', () => {
    const msgs: Message[] = [
      userMsg('u1', 'hi'),
      a2aInboxMsg('a1', 'captain', 'leader'),
      assistantMsg('as1', 'loop'), // 应 mute
    ];
    render(
      <ComponentMessageStream
        messages={msgs}
        resolveActor={resolveGroupActor}
        messageFilter={groupMessageFilter}
       
      />,
    );
    // user + a2a 渲染
    expect(getRow('u1')).toBeTruthy();
    expect(getRow('a1')).toBeTruthy();
    // a2a 角色名前缀行
    expect(screen.getByText('captain:').textContent).toContain('captain:');
    // [v0.0.165] a2a MemberAvatar(leader) 走 hash-by-id 8 色 palette（详见 lib/hue-hash）；leader/mate 不再固定色
    const av = within(getRow('a1')).getByText('C'); // captain 首字母
    expect((av as HTMLElement).style.background).toMatch(/^var\(--hue-(rose|orange|amber|green|teal|blue|violet|pink)\)$/);
    expect(av.textContent).toBe('C');
    // assistant answer 被 mute
    expect(queryRow('as1')).toBeNull();
    expect(screen.queryByText('loop')).toBeNull();
  });
});

describe('reminder block 默认滤（内核层）', () => {
  it('user message 内 reminder text block 不渲染（普通 text 正常）', () => {
    const m: Message = {
      id: 'u1',
      sessionId: 'S1',
      role: 'user',
      content: [
        { type: 'text', text: '可见文本' },
        { type: 'text', text: '[system_reminder] 隐藏', isSystemReminder: true },
      ],
      createdAt: 't',
      sender: { source: 'user' },
    };
    render(<ComponentMessageStream messages={[m]} />);
    expect(screen.getByText('可见文本')).toBeTruthy();
    expect(screen.queryByText('[system_reminder] 隐藏')).toBeNull();
  });
});

describe('tool-batch 复用（单聊全展示有工具）', () => {
  it('assistant tool_call 进 tool-batch 胶囊（不传 messageFilter = 全展示）', () => {
    const m: Message = {
      id: 'a1',
      sessionId: 'S1',
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'c1', name: 'bash', arguments: { cmd: 'ls' } }],
      createdAt: 't',
    };
    render(<ComponentMessageStream messages={[m]} />);
    expect(screen.getByText('工具调用')).toBeTruthy();
  });

  it('群聊 messageFilter mute assistant → tool-batch 不渲染', () => {
    const m: Message = {
      id: 'a1',
      sessionId: 'S1',
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'c1', name: 'bash', arguments: {} }],
      createdAt: 't',
    };
    render(
      <ComponentMessageStream
        messages={[m]}
        messageFilter={groupMessageFilter}
       
      />,
    );
    expect(screen.queryByText('工具调用')).toBeNull();
  });
});

// ============================================================
// [v0.0.42 fix Bug1] on-message spinner thinking 阶段单独可见
// 用户原话：「气泡的状态，永远有内容，没有 thinking，只有工具和回答」
// 要查：run_start 后、首条 assistant content 前，spinner 应以 thinking 单独可见
// ============================================================
describe('[v0.0.42 fix Bug1] on-message spinner thinking 阶段（run_start 后、content 前单独可见）', () => {
  it('runActive=true + loadingPhase=thinking + 无 messages → spinner 显 thinking 单独可见（无内容气泡）', () => {
    render(
      <ComponentMessageStream
        messages={[]}
        runActive={true}
        loadingPhase="thinking"
      />,
    );
    // spinner 渲染 + thinking 阶段
    const spinner = getSpinner();
    expect(spinner).toBeTruthy();
    expect(spinner.getAttribute('data-phase')).toBe('thinking');
    expect(querySpinnerPhase('thinking')).toBeTruthy();
    expect(getSpinner().textContent).toContain('思考中');
    // 无任何消息行（无 user/assistant bubble）—— thinking 单独可见
    expect(queryRow('u1')).toBeNull();
    expect(queryRow('a1')).toBeNull();
  });

  it('runActive=true + loadingPhase=null（run_start 刚到、事件未细化）→ 兜底 thinking 可见', () => {
    // 场景：run_start SSE 到达 → runActive=true 但 loadingPhase 可能是 null（兜底）
    // spinner 应兜底 thinking（spec §4.10: phase={loadingPhase ?? 'thinking'}）
    render(
      <ComponentMessageStream
        messages={[]}
        runActive={true}
        loadingPhase={null}
      />,
    );
    const spinner = getSpinner();
    expect(spinner.getAttribute('data-phase')).toBe('thinking');
    expect(querySpinnerPhase('thinking')).toBeTruthy();
  });

  it('runActive=true + 仅有 user message（无 assistant content）→ spinner 仍显 thinking', () => {
    // 场景：run_start → message_start(user) 已到 → message_start(assistant) 未到
    // 此时 loadingPhase 仍是 thinking（message_start role=user 不改 phase，见 reducer line 141-144）
    render(
      <ComponentMessageStream
        messages={[userMsg('u1', 'hi')]}
        runActive={true}
        loadingPhase="thinking"
      />,
    );
    // user 气泡渲染
    expect(getRow('u1')).toBeTruthy();
    // assistant 气泡不存在（content 未到）
    expect(queryRow('a1')).toBeNull();
    // spinner 显 thinking（首条 assistant content 前的独立 thinking 阶段）
    const spinner = getSpinner();
    expect(spinner.getAttribute('data-phase')).toBe('thinking');
    expect(getSpinner().textContent).toContain('思考中');
  });

  it('runActive=true + assistant answer 已到 → spinner 切 answering（thinking 已结束，正常流转）', () => {
    // 对照：thinking 不是永远——assistant content 到后切 answering（reducer: message_start role=assistant → answering）
    render(
      <ComponentMessageStream
        messages={[userMsg('u1', 'hi'), assistantMsg('a1', 'reply')]}
        runActive={true}
        loadingPhase="answering"
      />,
    );
    const spinner = getSpinner();
    expect(spinner.getAttribute('data-phase')).toBe('answering');
    expect(querySpinnerPhase('thinking')).toBeNull();
    expect(querySpinnerPhase('answering')).toBeTruthy();
  });

  it('runActive=false → spinner 不渲染（run 未进行）', () => {
    render(
      <ComponentMessageStream
        messages={[userMsg('u1', 'hi')]}
        runActive={false}
        loadingPhase={null}
      />,
    );
    expect(querySpinner()).toBeNull();
  });

  it('runActive=true + loadingPhase=tool_calling → spinner 显「调用工具…」（阶段流转交叉验证）', () => {
    render(
      <ComponentMessageStream
        messages={[userMsg('u1', 'hi')]}
        runActive={true}
        loadingPhase="tool_calling"
      />,
    );
    const spinner = getSpinner();
    expect(spinner.getAttribute('data-phase')).toBe('tool_calling');
    expect(getSpinner().textContent).toContain('调用工具');
  });
});

// ============================================================
// [v0.0.96.ui_fix F2] 气泡双源兜底：spinner 可见性 = runActive || sessionRunning
// 根因：runActive 仅来自 agent_loop SSE run_start/run_end 派生；切会话/SSE 重连时 sticky
// replay 失效 → runActive 留 false → 气泡丢。sessionRunning 来自 useRunState GET /session
// REST（独立于 SSE sticky），作兜底门控 spinner。
// 4 组合验证（T/T, T/F, F/T, F/F），核心：F/T 时 spinner 仍渲染（切会话兜底）。
// ============================================================
describe('[v0.0.96.ui_fix F2] spinner 双源门控：runActive || sessionRunning', () => {
  it('F/T: runActive=false + sessionRunning=true → spinner 仍渲染（切会话兜底，核心）', () => {
    // 场景：用户切会话进来，GET /session state.running=true（run 进行中），
    // 但 sticky replay 未重放 run_start → runActive=false。sessionRunning 兜底驱动 spinner。
    render(
      <ComponentMessageStream
        messages={[userMsg('u1', 'hi')]}
        runActive={false}
        sessionRunning={true}
        loadingPhase={null} // 仅 sessionRunning 触发 → loadingPhase=null 兜底 thinking
      />,
    );
    const spinner = getSpinner();
    expect(spinner).toBeTruthy();
    // 仅 sessionRunning 触发：loadingPhase=null 兜底 thinking（不误报生成回答）
    expect(spinner.getAttribute('data-phase')).toBe('thinking');
    expect(getSpinner().textContent).toContain('思考中');
  });

  it('T/F: runActive=true + sessionRunning=false → spinner 渲染（runActive 单源场景，playground 不传 sessionRunning）', () => {
    render(
      <ComponentMessageStream
        messages={[userMsg('u1', 'hi')]}
        runActive={true}
        sessionRunning={false}
        loadingPhase="answering"
      />,
    );
    const spinner = getSpinner();
    expect(spinner).toBeTruthy();
    expect(spinner.getAttribute('data-phase')).toBe('answering');
  });

  it('T/T: runActive=true + sessionRunning=true → spinner 渲染且不重复（仅一个 spinner）', () => {
    // 场景：正常 run 进行中，SSE sticky + GET /session 同时确认 running（双源都 true）
    // 期望：spinner 只渲染一次（union 门控，非两份并列）
    render(
      <ComponentMessageStream
        messages={[userMsg('u1', 'hi')]}
        runActive={true}
        sessionRunning={true}
        loadingPhase="answering"
      />,
    );
    const spinners = Array.from(document.querySelectorAll('[data-phase]'));
    expect(spinners.length).toBe(1); // 不重复
    expect(spinners[0]!.getAttribute('data-phase')).toBe('answering');
  });

  it('F/F: runActive=false + sessionRunning=false → spinner 不渲染（run 完全结束）', () => {
    render(
      <ComponentMessageStream
        messages={[userMsg('u1', 'hi')]}
        runActive={false}
        sessionRunning={false}
        loadingPhase={null}
      />,
    );
    expect(querySpinner()).toBeNull();
  });
});
