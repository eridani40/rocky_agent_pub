// @vitest-environment jsdom
/**
 * useRunState area-hook 单测（v0.0.94.component_refactor T2）
 * 参考: specs/tech/app/frontend/[P0]chat_area_hooks.md §4.2（run_end GET 校正归此 / 多订阅 from.topic switch）
 *       specs/tech/app/frontend/[P0]sse_client_singleton.md §7（状态自愈 D6 卡 running）
 *
 * 覆盖：
 *   - 初始 GET /session 拉基线（running + state）
 *   - session_panel session_status_update → sessionRunning/sessionState（五态机）
 *   - agent_loop run_start 不覆盖 sessionRunning（权威源是 session_panel，不回退）
 *   - 多订阅 from.topic switch：session_panel 收 status_update / agent_loop 收 run_end
 *   - [D6] run_end 后 sessionRunning 仍 true 且非 interrupting → GET /session 校正
 *   - [D6] run_end 在 interrupting 态 → 不触发 GET 校正（等 session_status_update）
 *   - GET 校正失败 catch 不阻塞 UI
 *   - abort() → abortSession
 *   - 切 session：cleanup unsubscribe（不 destroy 单例）
 *
 * mock 策略（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效）：vi.hoisted + 绝对路径 mock
 *   sse-singleton（FakeSseClient 捕获 subscribe handler + 句柄）+ chat-api（getSession/abortSession）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { SessionState } from '../../../store/session-slice-reducer';

const sse = vi.hoisted(() => ({
  // 每主题存 handler + group（useLifecycle handleFrame 读 frame.topic/group 分流，须完整 SseFrame）
  handlers: {} as Record<string, { handler: (f: { data: unknown; topic: string; group: string }) => void; group: string }>,
  instances: 0,
  destroyed: 0,
  unsub: [] as string[],
  topics: [] as string[],
}));
const apiMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  abortSession: vi.fn(),
}));
const singletonPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/sse-singleton'));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'));

vi.mock(singletonPath, () => {
  // FakeSseClient 模拟 Bun 精简 API（无 destroy 必须—spec §1 S3：组件不 destroy 单例）
  let subIdCounter = 0;
  class FakeSseClient {
    constructor() {
      sse.instances++;
    }
    async connect() {
      /* no-op */
    }
    async subscribe(topic: string, group: string, handler: (f: { data: unknown; topic: string; group: string }) => void) {
      sse.handlers[topic] = { handler, group };
      sse.topics.push(topic);
      const subId = `sub-${++subIdCounter}-${topic}`;
      return {
        subId,
        topic,
        group,
        unsubscribe: async () => {
          sse.unsub.push(topic);
        },
      };
    }
    async unsubscribe(handle: { subId?: string } | string) {
      const subId = typeof handle === 'string' ? handle : handle?.subId;
      if (subId) sse.unsub.push(subId);
    }
    destroy() {
      sse.destroyed++;
    }
  }
  let singleton: FakeSseClient | null = null;
  return {
    getSseClient: () => {
      if (!singleton) singleton = new FakeSseClient();
      return singleton;
    },
    _resetSseSingletonForTest: () => {
      if (singleton) singleton.destroy();
      singleton = null;
    },
  };
});
vi.mock(apiPath, () => apiMocks);

import { useRunState } from '../use-run-state';
import type { AgentEvent } from '../../../store/chat-slice-reducer';
import type { SessionEvent } from '../../../store/session-slice-reducer';

/** 推一帧 agent_loop */
function pushAgent(evt: AgentEvent): void {
  const h = sse.handlers['agent_loop'];
  act(() => h?.handler({ data: evt, topic: 'agent_loop', group: h.group }));
}
/** 推一帧 session_panel */
function pushPanel(evt: SessionEvent): void {
  const h = sse.handlers['session_panel'];
  act(() => h?.handler({ data: evt, topic: 'session_panel', group: h.group }));
}
/** 排空 hook 挂载后异步副作用（connect→GET→subscribe），全部 act 内结算 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  sse.handlers = {};
  sse.instances = 0;
  sse.destroyed = 0;
  sse.unsub = [];
  sse.topics = [];
  apiMocks.getSession.mockReset().mockResolvedValue({ running: false, state: 'idle' });
  apiMocks.abortSession.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('useRunState — 初始 GET /session', () => {
  it('mount 拉 running=true/state=running 写 sessionRunning/sessionState', async () => {
    apiMocks.getSession.mockResolvedValue({ running: true, state: 'running' });
    const { result } = renderHook(() => useRunState('s1'));
    await settle();
    expect(apiMocks.getSession).toHaveBeenCalledWith('s1');
    expect(result.current.sessionRunning).toBe(true);
    expect(result.current.sessionState).toBe('running');
  });

  it('GET 失败 → sessionRunning=false 兜底（SSE 仍可推 status_update）', async () => {
    apiMocks.getSession.mockRejectedValue(new Error('net'));
    const { result } = renderHook(() => useRunState('s1'));
    await settle();
    expect(result.current.sessionRunning).toBe(false);
    expect(result.current.sessionState).toBeNull();
  });
});

describe('useRunState — session_panel session_status_update 五态机', () => {
  it('running→interrupting→interrupted 驱动 sessionRunning true→true→false', async () => {
    const { result } = renderHook(() => useRunState('s1'));
    await settle();
    pushPanel({ type: 'session_status_update', sessionId: 's1', createdAt: 't1', data: { state: 'running', running: true, currentRunId: 'r1' } });
    expect(result.current.sessionRunning).toBe(true);
    expect(result.current.sessionState).toBe('running');
    pushPanel({ type: 'session_status_update', sessionId: 's1', createdAt: 't2', data: { state: 'interrupting', running: true, currentRunId: 'r1' } });
    expect(result.current.sessionRunning).toBe(true);
    expect(result.current.sessionState).toBe('interrupting');
    pushPanel({ type: 'session_status_update', sessionId: 's1', createdAt: 't3', data: { state: 'interrupted', running: false, currentRunId: null } });
    expect(result.current.sessionRunning).toBe(false);
    expect(result.current.sessionState).toBe('interrupted');
  });
});

describe('useRunState — agent_loop run_start 不覆盖 sessionRunning', () => {
  it('session_panel 设 false 后 agent_loop run_start 不回退 sessionRunning', async () => {
    const { result } = renderHook(() => useRunState('s1'));
    await settle();
    pushPanel({ type: 'session_status_update', sessionId: 's1', createdAt: 't1', data: { state: 'interrupted', running: false, currentRunId: null } });
    expect(result.current.sessionRunning).toBe(false);
    pushAgent({ type: 'run_start', runId: 'r1', sessionId: 's1' });
    // 关键：agent_loop run_start 不覆盖 sessionRunning（权威源是 session_panel）
    expect(result.current.sessionRunning).toBe(false);
  });
});

describe('useRunState — [D6] run_end GET 校正', () => {
  it('run_end 后 sessionRunning 仍 true 且非 interrupting → GET /session 校正为 idle', async () => {
    apiMocks.getSession.mockReset();
    apiMocks.getSession.mockResolvedValueOnce({ running: true, state: 'running' }); // mount GET
    apiMocks.getSession.mockResolvedValueOnce({ running: false, state: 'idle' }); // 校正 GET

    const { result } = renderHook(() => useRunState('s1'));
    await settle();
    expect(result.current.sessionRunning).toBe(true);

    pushAgent({ type: 'run_end', runId: 'r1', sessionId: 's1', stopReason: 'no_tool_call' });
    await settle();

    // 关键：GET 触发并校正（GET 为权威源）
    expect(apiMocks.getSession).toHaveBeenCalledTimes(2);
    expect(result.current.sessionRunning).toBe(false);
    expect(result.current.sessionState).toBe('idle');
  });

  it('run_end 在 interrupting 态 → 不触发 GET 校正（abort 收尾中）', async () => {
    apiMocks.getSession.mockReset().mockResolvedValue({ running: true, state: 'interrupting' });
    const { result } = renderHook(() => useRunState('s1'));
    await settle();
    pushPanel({ type: 'session_status_update', sessionId: 's1', createdAt: 't1', data: { state: 'interrupting', running: true, currentRunId: 'r1' } });
    expect(result.current.sessionState).toBe('interrupting');

    const callsBefore = apiMocks.getSession.mock.calls.length;
    pushAgent({ type: 'run_end', runId: 'r1', sessionId: 's1', stopReason: 'no_tool_call' });
    await settle();
    expect(apiMocks.getSession.mock.calls.length).toBe(callsBefore);
  });

  it('run_end 时 sessionRunning 已 false → 不触发 GET 校正', async () => {
    apiMocks.getSession.mockReset().mockResolvedValue({ running: false, state: 'idle' });
    const { result } = renderHook(() => useRunState('s1'));
    await settle();
    expect(result.current.sessionRunning).toBe(false);
    const callsBefore = apiMocks.getSession.mock.calls.length;
    pushAgent({ type: 'run_end', runId: 'r1', sessionId: 's1', stopReason: 'no_tool_call' });
    await settle();
    expect(apiMocks.getSession.mock.calls.length).toBe(callsBefore);
  });

  it('GET 校正失败 catch 不阻塞 UI（sessionRunning 维持原态等 session_panel 兜底）', async () => {
    apiMocks.getSession.mockReset();
    apiMocks.getSession.mockResolvedValueOnce({ running: true, state: 'running' });
    apiMocks.getSession.mockRejectedValueOnce(new Error('net down'));
    const { result } = renderHook(() => useRunState('s1'));
    await settle();
    expect(result.current.sessionRunning).toBe(true);
    pushAgent({ type: 'run_end', runId: 'r1', sessionId: 's1', stopReason: 'no_tool_call' });
    await settle();
    // GET 失败被 catch，sessionRunning 维持 true（兜底等 session_panel 推送）
    expect(result.current.sessionRunning).toBe(true);
  });
});

describe('useRunState — abort + 切 session cleanup', () => {
  it('abort() → abortSession(sessionId)', async () => {
    const { result } = renderHook(() => useRunState('s1'));
    await settle();
    act(() => result.current.abort());
    expect(apiMocks.abortSession).toHaveBeenCalledWith('s1');
  });

  it('切 session：cleanup 调句柄 unsubscribe 两 topic（不 destroy 单例）', async () => {
    const { unmount } = renderHook(() => useRunState('s1'));
    await settle();
    expect(sse.handlers['session_panel']).toBeTruthy();
    expect(sse.handlers['agent_loop']).toBeTruthy();
    unmount();
    expect(sse.unsub).toContain('agent_loop');
    expect(sse.unsub).toContain('session_panel');
    // 关键不变量：cleanup 不 destroy 单例
    expect(sse.destroyed).toBe(0);
  });
});
