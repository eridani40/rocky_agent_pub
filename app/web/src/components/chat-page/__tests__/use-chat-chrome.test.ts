/**
 * @vitest-environment jsdom
 * use-chat-chrome 单测 —— 统一 chrome hook（GET /session/:id/chrome 一跳）
 * 参考: specs/tech/app/frontend/[P0]chat_session_assembly.md §3（拆解行）
 *       specs/api/overall/04a-session-chrome.md（接口契约）
 *
 * 覆盖：
 * - onInit：getSessionChrome 回填 chrome（loading→填充）
 * - injected 注入：零网络（getSessionChrome 不被调）+ chrome=注入值
 * - sessionId 空 → 不发请求 + error 填（消费方渲空态）
 * - getSessionChrome 抛错 → chrome=null + error 填
 * - setEffort/setApprovalMode：乐观写本地 + updateSession fire-and-forget（不新增 GET）
 * - setModel：具体 model 复合 body；保留字 'default' → {modelId:'default'} 不带 providerId + sessionModel=null
 * - deps 变（sessionId 切换）→ re-init 重拉（旧 model 无残留：useLifecycle 切 generation 先置 null）
 * - 不订 SSE（GET-once，无订阅副作用）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup, waitFor, act } from '@testing-library/react';

// 绝对路径 mock（memory: test-vitest-mock-absolute-path）
const { chatApiPath, getSessionChromeMock, updateSessionMock } = vi.hoisted(() => ({
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
  getSessionChromeMock: vi.fn(),
  updateSessionMock: vi.fn(),
}));

vi.mock(chatApiPath, () => ({
  getSessionChrome: (...args: Parameters<typeof getSessionChromeMock>) => getSessionChromeMock(...args),
  updateSession: (...args: Parameters<typeof updateSessionMock>) => updateSessionMock(...args),
}));

import { useChatChrome } from '../use-chat-chrome';
import type { SessionChromeView } from '../../../lib/chat-api';

/** playground 全开 chrome 夹具 */
function mkChrome(over: Partial<SessionChromeView> = {}): SessionChromeView {
  return {
    sessionId: 's1',
    kind: 'playground',
    readOnly: false,
    title: 'T',
    titled: true,
    tag: '',
    sessionModel: null,
    defaultModel: null,
    effort: null,
    approvalMode: null,
    members: [],
    memberId: null,
    capabilities: {
      runState: true, hitl: true, enqueue: true, effortPicker: true, approvalPicker: true,
      usage: true, compact: true, clear: true, minimap: true, floatMenu: true, cron: true,
      groupRender: false,
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateSessionMock.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
});

describe('useChatChrome', () => {
  it('onInit：getSessionChrome 回填 chrome + loading 收敛', async () => {
    getSessionChromeMock.mockResolvedValue(mkChrome({ effort: 'high', approvalMode: 'greenlight' }));

    const { result } = renderHook(() => useChatChrome('s1'));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.chrome).not.toBeNull());
    expect(result.current.loading).toBe(false);
    expect(result.current.chrome!.effort).toBe('high');
    expect(result.current.chrome!.approvalMode).toBe('greenlight');
    expect(getSessionChromeMock).toHaveBeenCalledWith('s1');
    expect(getSessionChromeMock).toHaveBeenCalledTimes(1);
  });

  it('injected 注入：零网络（getSessionChrome 不被调）+ chrome=注入值（防双拉）', async () => {
    const injected = mkChrome({ kind: 'studio_member', memberId: 'm1', tag: 'Alpha · leader' });

    const { result } = renderHook(() => useChatChrome('s1', { injected }));

    await waitFor(() => expect(result.current.chrome).not.toBeNull());
    expect(result.current.chrome).toBe(injected);
    expect(getSessionChromeMock).not.toHaveBeenCalled();
  });

  it('sessionId 空 → 不发请求 + error 填（消费方渲空态兜底）', async () => {
    const { result } = renderHook(() => useChatChrome(null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.chrome).toBeNull();
    expect(result.current.error).toBeInstanceOf(Error);
    expect(getSessionChromeMock).not.toHaveBeenCalled();
  });

  it('getSessionChrome 抛错 → chrome=null + error 填', async () => {
    const err = new Error('session not found');
    getSessionChromeMock.mockRejectedValue(err);

    const { result } = renderHook(() => useChatChrome('s-404'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.chrome).toBeNull();
    expect(result.current.error).toBe(err);
  });

  it('setEffort：乐观写本地（同步生效）+ updateSession 调用 + 不新增 GET', async () => {
    getSessionChromeMock.mockResolvedValue(mkChrome());
    const { result } = renderHook(() => useChatChrome('s1'));
    await waitFor(() => expect(result.current.chrome).not.toBeNull());

    act(() => result.current.setEffort('max'));

    expect(result.current.chrome!.effort).toBe('max');
    expect(updateSessionMock).toHaveBeenCalledWith('s1', { effort: 'max' });
    expect(getSessionChromeMock).toHaveBeenCalledTimes(1);
  });

  it('setApprovalMode：乐观写本地 + updateSession 调用', async () => {
    getSessionChromeMock.mockResolvedValue(mkChrome());
    const { result } = renderHook(() => useChatChrome('s1'));
    await waitFor(() => expect(result.current.chrome).not.toBeNull());

    act(() => result.current.setApprovalMode('greenlight'));

    expect(result.current.chrome!.approvalMode).toBe('greenlight');
    expect(updateSessionMock).toHaveBeenCalledWith('s1', { approvalMode: 'greenlight' });
  });

  it('setModel 具体 model → sessionModel 乐观复合写 + updateSession({providerId, modelId})', async () => {
    getSessionChromeMock.mockResolvedValue(mkChrome());
    const { result } = renderHook(() => useChatChrome('s1'));
    await waitFor(() => expect(result.current.chrome).not.toBeNull());

    act(() => result.current.setModel({ providerId: 'prov-1', modelId: 'gpt-4' }));

    expect(result.current.chrome!.sessionModel).toEqual({ providerId: 'prov-1', modelId: 'gpt-4' });
    expect(updateSessionMock).toHaveBeenCalledWith('s1', { providerId: 'prov-1', modelId: 'gpt-4' });
  });

  it('setModel 保留字 default → sessionModel=null + updateSession({modelId:"default"}) 不带 providerId', async () => {
    getSessionChromeMock.mockResolvedValue(
      mkChrome({ sessionModel: { providerId: 'prov-1', modelId: 'gpt-4' } }),
    );
    const { result } = renderHook(() => useChatChrome('s1'));
    await waitFor(() => expect(result.current.chrome).not.toBeNull());

    act(() => result.current.setModel({ providerId: '', modelId: 'default' }));

    expect(result.current.chrome!.sessionModel).toBeNull();
    expect(updateSessionMock).toHaveBeenCalledWith('s1', { modelId: 'default' });
  });

  it('deps 变（sessionId 切换）→ re-init 重拉，旧 chrome 不残留（切换瞬间 ctx 置 null）', async () => {
    getSessionChromeMock.mockResolvedValueOnce(mkChrome({ sessionId: 'sA', title: 'A' }));

    const { result, rerender } = renderHook(({ sid }) => useChatChrome(sid), {
      initialProps: { sid: 'sA' },
    });
    await waitFor(() => expect(result.current.chrome?.title).toBe('A'));

    getSessionChromeMock.mockResolvedValueOnce(mkChrome({ sessionId: 'sB', title: 'B' }));
    rerender({ sid: 'sB' });

    await waitFor(() => expect(result.current.chrome?.title).toBe('B'));
    expect(getSessionChromeMock).toHaveBeenCalledTimes(2);
    expect(getSessionChromeMock).toHaveBeenLastCalledWith('sB');
  });

  it('chrome 未到位（loading）时 setter 安全（null ctx 跳写不抛）+ fire-and-forget 仍发 PUT', async () => {
    getSessionChromeMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useChatChrome('s-pending'));
    expect(result.current.chrome).toBeNull();

    expect(() => act(() => result.current.setEffort('low'))).not.toThrow();
    expect(result.current.chrome).toBeNull();
    expect(updateSessionMock).toHaveBeenCalledWith('s-pending', { effort: 'low' });
  });
});
