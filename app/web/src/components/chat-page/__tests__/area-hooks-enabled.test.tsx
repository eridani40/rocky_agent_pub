// @vitest-environment jsdom
/**
 * area-hooks enabled 门单测（v0.0.216 C 段：useRunState / useSummary opts.enabled）
 * 参考: specs/tech/app/frontend/[P0]chat_session_assembly.md §2.4（enabled 门设计原则）
 *       specs/tech/version_logs/v0.0.216/change_plan.md C 段（enabled=false 零订阅零网络）
 *
 * 覆盖：
 *   - useRunState enabled=false → 零 SSE 订阅 + 零 GET /session（群聊 capabilities.runState=false 场景）
 *   - useRunState enabled=true（缺省）→ 双订阅（session_panel + agent_loop）+ GET 基线（行为零变化）
 *   - useSummary enabled=false → 零订阅；enabled=true → session_panel 单订阅
 *   - enabled 翻转 false→true → re-init 建订阅（deps=[sessionId, enabled]）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup, waitFor } from '@testing-library/react';

// —— vi.hoisted：SseClient 单例 spy + 绝对路径 mock（memory: test-vitest-mock-absolute-path） —— //
const { sseSpies, chatApiPath, singletonPath, getSessionMock } = vi.hoisted(() => ({
  sseSpies: {
    subscribe: vi.fn(async (..._args: unknown[]) => undefined),
    unsubscribe: vi.fn(async (..._args: unknown[]) => undefined),
  },
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
  singletonPath: require('node:path').resolve(__dirname, '../../../lib/sse-singleton'),
  getSessionMock: vi.fn(),
}));

vi.mock(chatApiPath, () => ({
  getSession: (...args: Parameters<typeof getSessionMock>) => getSessionMock(...args),
  abortSession: vi.fn(async () => ({ ok: true })),
}));

vi.mock(singletonPath, () => {
  let singleton: object | null = null;
  return {
    getSseClient: () => {
      if (!singleton) {
        singleton = {
          subscribe: async (topic: string, group: string, handler: unknown) => {
            await sseSpies.subscribe(topic, group, handler);
            return { topic, group, subId: 'sub', unsubscribe: vi.fn(async () => sseSpies.unsubscribe()) };
          },
        };
      }
      return singleton;
    },
  };
});

import { useRunState } from '../use-run-state';
import { useSummary } from '../use-summary';

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue({ id: 's1', running: false, state: 'idle' });
});

afterEach(() => cleanup());

describe('useRunState enabled 门（群聊零订阅零网络）', () => {
  it('enabled=false → 不 subscribe 不 GET，返 inert 态（sessionRunning=false）', async () => {
    const { result } = renderHook(() => useRunState('s1', { enabled: false }));

    await waitFor(() => expect(result.current.sessionRunning).toBe(false));
    // 静置一拍后仍零副作用（onInit 同步返回，无异步在途）
    await new Promise((r) => setTimeout(r, 20));
    expect(sseSpies.subscribe).not.toHaveBeenCalled();
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(result.current.sessionState).toBeNull();
  });

  it('enabled 缺省（true）→ 双订阅（session_panel + agent_loop）+ GET /session 基线（行为零变化）', async () => {
    getSessionMock.mockResolvedValue({ id: 's1', running: true, state: 'running' });
    const { result } = renderHook(() => useRunState('s1'));

    await waitFor(() => expect(result.current.sessionRunning).toBe(true));
    expect(getSessionMock).toHaveBeenCalledWith('s1');
    await waitFor(() => {
      expect(sseSpies.subscribe).toHaveBeenCalledWith('session_panel', 'session_id:s1', expect.any(Function));
      expect(sseSpies.subscribe).toHaveBeenCalledWith('agent_loop', 'session_id:s1_amt:main', expect.any(Function));
    });
  });

  it('enabled 翻转 false→true → re-init 建订阅（deps=[sessionId, enabled]）', async () => {
    const { rerender } = renderHook(({ enabled }) => useRunState('s1', { enabled }), {
      initialProps: { enabled: false },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(sseSpies.subscribe).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => {
      expect(sseSpies.subscribe).toHaveBeenCalledWith('session_panel', 'session_id:s1', expect.any(Function));
    });
    expect(getSessionMock).toHaveBeenCalledWith('s1');
  });

  it('sessionId 空（enabled=true）→ 不 subscribe 不 GET（inert）', async () => {
    renderHook(() => useRunState(''));
    await new Promise((r) => setTimeout(r, 20));
    expect(sseSpies.subscribe).not.toHaveBeenCalled();
    expect(getSessionMock).not.toHaveBeenCalled();
  });
});

describe('useSummary enabled 门', () => {
  it('enabled=false → 零订阅，summaryTask 恒 null（CompactBtn 按 idle 兜底）', async () => {
    const { result } = renderHook(() => useSummary('s1', { enabled: false }));
    await new Promise((r) => setTimeout(r, 20));
    expect(sseSpies.subscribe).not.toHaveBeenCalled();
    expect(result.current.summaryTask).toBeNull();
  });

  it('enabled 缺省（true）→ session_panel 单订阅（行为零变化，无初始 GET）', async () => {
    renderHook(() => useSummary('s1'));
    await waitFor(() => {
      expect(sseSpies.subscribe).toHaveBeenCalledWith('session_panel', 'session_id:s1', expect.any(Function));
    });
    expect(getSessionMock).not.toHaveBeenCalled();
  });
});
