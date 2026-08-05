// @vitest-environment jsdom
/**
 * page-chat SSE 单例 mount/unmount 行为单测（v0.0.88 T4）
 * 参考: specs/tech/app/frontend/[P0]sse_client_singleton.md §5 R1（迁移：删 sharedSse → getSseClient 单例）
 *       specs/tech/app/frontend/[P0]sse_client_singleton.md §1 S1/S3（全局唯一 + 组件不碰连接）
 *
 * 覆盖 T4 关键不变量：
 *   - mount page-chat 时 session_meta `_all` 订阅经 getSseClient 单例（不再 new SseClient）
 *   - cleanup 调句柄 unsubscribe（不 destroy 单例）
 *   - refreshChildren 兜底链路保留（subagent meta → refreshChildren 调用）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

// —— vi.hoisted：单例 SseClient spy + chat-api + sse-singleton mock —— //
const { singletonSpies, chatApiPath, singletonPath, sseClientPath } = vi.hoisted(() => ({
  singletonSpies: {
    getCalls: 0,
    destroyCalls: 0,
    subscribe: vi.fn(async (..._args: unknown[]) => undefined),
    unsubscribe: vi.fn(async (..._args: unknown[]) => undefined),
    connect: vi.fn(async () => undefined),
  },
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
  singletonPath: require('node:path').resolve(__dirname, '../../../lib/sse-singleton'),
  sseClientPath: require('node:path').resolve(__dirname, '../../../lib/sse-client'),
}));

vi.mock(chatApiPath, () => ({
  // [v0.0.216] SectionChatSession → useChatChrome → getSessionChrome（playground 全开 chrome 桩）
  getSessionChrome: vi.fn(async (id: string) => ({
    sessionId: id,
    kind: 'playground',
    readOnly: false,
    title: 'T',
    titled: false,
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
  })),
  listSessions: vi.fn(async () => [
    {
      id: 'sess-A',
      title: '会话A',
      status: 'active',
      unread: false,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-27T00:00:00.000Z',
    },
  ]),
  getSession: vi.fn(async (id: string) => ({
    id,
    title: 'T',
    status: 'active',
    state: 'idle',
    running: false,
    currentRunId: null,
    providerId: undefined,
    modelId: undefined,
    unread: false,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
  })),
  getMessages: vi.fn(async () => ({ items: [] as never[], hasMore: false })),
  getSessionUsage: vi.fn(async () => null),
  createSession: vi.fn(async () => ({ id: 'new' })),
  deleteSession: vi.fn(async () => undefined),
  postMessage: vi.fn(async () => ({ runId: 'r' })),
  abortSession: vi.fn(async () => ({ ok: true })),
  cancelEnqueue: vi.fn(async () => ({ ok: true })),
  postCompact: vi.fn(async () => ({ ok: true })),
  postClear: vi.fn(async () => ({ ok: true })),
  updateSession: vi.fn(async () => ({}) as never),
  markSessionRead: vi.fn(async () => ({ ok: true, session: { unread: false } })),
  listChildren: vi.fn(async () => ({ running: [], terminated: [] })),
  getWorkspaceTree: vi.fn(async () => ({ workspaceDir: '', tree: [] })),
}));

vi.mock(sseClientPath, () => ({
  // 让真实 SseClient 类可被 import（page-chat/use-session-run-state 不直接 import 此模块；
  // 仅 sse-singleton 内部 import，但 sse-singleton 已被 mock，故这里只需占位）
  SseClient: vi.fn().mockImplementation(() => {
    throw new Error('should not call real SseClient ctor');
  }),
}));

vi.mock(singletonPath, () => {
  // 模拟 lazy 单例：首次 getSseClient 创建 fake，后续返回同一实例
  let singleton: object | null = null;
  return {
    getSseClient: () => {
      singletonSpies.getCalls++;
      if (!singleton) {
        singleton = {
          connect: singletonSpies.connect,
          subscribe: async (topic: string, group: string, handler: (f: unknown) => void) => {
            await singletonSpies.subscribe(topic, group, handler);
            const subId = `sub-${singletonSpies.getCalls}-${topic}`;
            return {
              subId,
              topic,
              group,
              unsubscribe: async () => {
                await singletonSpies.unsubscribe(subId);
              },
            };
          },
          unsubscribe: singletonSpies.unsubscribe,
          destroy: () => {
            singletonSpies.destroyCalls++;
          },
          isConnected: () => false,
        };
      }
      return singleton;
    },
    _resetSseSingletonForTest: () => {
      singleton = null;
    },
  };
});

import { PageChat } from '../page-chat';
import { useChatStore } from '../../../store/chat-slice';
import type { Session } from '../types';
import type { SessionMetaUpdateEvent } from '../../../store/chat-slice';

function mkSession(id: string): Session {
  return {
    id,
    title: id,
    status: 'active',
    unread: false,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
  };
}

beforeEach(() => {
  singletonSpies.getCalls = 0;
  singletonSpies.destroyCalls = 0;
  singletonSpies.subscribe.mockClear();
  singletonSpies.unsubscribe.mockClear();
  singletonSpies.connect.mockClear();
  useChatStore.getState().setSessions([mkSession('sess-A')]);
});

afterEach(() => {
  cleanup();
});

describe('PageChat SSE 单例 mount/unmount（v0.0.88 T4）', () => {
  it('mount：经 getSseClient 单例订阅 session_meta `_all`（不 new SseClient）', async () => {
    render(<PageChat />);
    // 等 listSessions resolve + mount effect 触发
    await vi.waitFor(() => {
      expect(singletonSpies.subscribe).toHaveBeenCalledWith(
        'session_meta',
        '_all',
        expect.any(Function),
      );
    });
    // getSseClient 被调（至少一次：page-chat mount effect + useSessionRunState effect）
    expect(singletonSpies.getCalls).toBeGreaterThan(0);
  });

  it('unmount：句柄 unsubscribe 被调（不 destroy 单例）', async () => {
    const { unmount } = render(<PageChat />);
    await vi.waitFor(() => {
      expect(singletonSpies.subscribe).toHaveBeenCalledWith('session_meta', '_all', expect.any(Function));
    });
    // 等一个 microtask 让 page-chat mount effect 的 .then(h => metaHandleRef.current = h) resolve
    // （subscribe Promise 返回句柄后 page-chat 才把句柄存 ref，否则 cleanup no-op）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    unmount();
    // cleanup 调句柄 unsubscribe（spec §1 S3：组件不 destroy 单例）
    await vi.waitFor(() => {
      expect(singletonSpies.unsubscribe).toHaveBeenCalled();
    });
    // 关键不变量：cleanup 不 destroy 单例（连接归 app 级，跨 page 复用）
    expect(singletonSpies.destroyCalls).toBe(0);
  });

  it('refreshChildren 兜底链路保留：subagent meta → refreshChildren 被调', async () => {
    // 监听 listChildren（refreshChildren 内部调用）
    const chatApi = await import('../../../lib/chat-api');
    const listChildrenSpy = vi.mocked(chatApi.listChildren);
    listChildrenSpy.mockClear();

    render(<PageChat />);
    await screen.findByText('会话A');

    // 取 session_meta `_all` 的 handler
    await vi.waitFor(() => {
      expect(singletonSpies.subscribe).toHaveBeenCalledWith('session_meta', '_all', expect.any(Function));
    });
    const metaCall = singletonSpies.subscribe.mock.calls.find(
      (c) => c[0] === 'session_meta' && c[1] === '_all',
    );
    expect(metaCall).toBeTruthy();
    const handler = metaCall![2] as (frame: { data: SessionMetaUpdateEvent }) => void;

    // 模拟后端推送 subagent meta 事件（subagent derivation + parentSessionId 触发 refreshChildren）
    // [v0.0.56] Session.type → Session.derivation（'main' | 'subagent'），mount handler 现判
    //   evt.data?.derivation === 'subagent'（use-page-chat-mount.ts:87）。旧 mock 用 type 致 stale。
    const subagentEvent: SessionMetaUpdateEvent = {
      id: 'evt-1',
      type: 'session_meta_update',
      sessionId: 'sess-sub-1',
      createdAt: 't1',
      data: {
        id: 'sess-sub-1',
        derivation: 'subagent',
        parentSessionId: 'sess-A',
        title: 'sub agent',
        status: 'active',
        createdAt: 't1',
        updatedAt: 't1',
      } as Session,
    };

    listChildrenSpy.mockClear();
    // 用 act 包裹：handler 内会触发 React 状态更新（applySessionMetaEvent + refreshChildren 异步）
    act(() => {
      handler({ data: subagentEvent });
    });

    // subagent meta → refreshChildren('sess-A') → listChildren('sess-A')
    await vi.waitFor(() => {
      expect(listChildrenSpy).toHaveBeenCalledWith('sess-A');
    });
  });
});
