// @vitest-environment jsdom
/**
 * page-chat openSession 触发 POST /session/:id/read 单测（v0.0.27）
 * 参考: specs/ui/components/chat-page/_overview.md §5 交互6/7（进入会话 GET + POST /read）
 *       specs/api/overall/04-agent-session.md §2.3.1（POST /read 契约）
 *
 * 覆盖 acceptanceCriteria：
 *   - 进入会话（onSelect）触发 POST /session/:id/read 调用（URL 含 sid）
 *   - POST /read 响应 unread=false 后本地 sessions 对应项更新为 false
 *   - POST /read 失败不阻塞 UI（active 切换 + 消息加载不受影响）
 *
 * 策略：mock chat-api 模块，断言 markSessionRead 被调 + 失败时不影响 setActiveSession/setMessages。
 * SSE 单例用 mock SseClient 隔离。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { initI18n } from '../../../i18n';

// [v0.0.62 i18n] 启动 i18next instance：PageChat → SectionChatSession → ChatComposer 用 useTranslation('common')
beforeAll(async () => {
  await initI18n('zh-CN');
});

// —— vi.hoisted 提升 spy + 绝对路径 mock —— //
// 注意：bun --bun runtime 下 vitest 的 vi.mock 对相对路径在 jsdom 环境不生效
// （bun resolver 与 vitest mock 拦截器的兼容问题），必须用绝对路径。
// 全量套件高并发下相对路径 mock 偶发失效 → markSessionRead 走真实 fetch 报
// "URL is invalid" → spy 0 调用 → 断言失败。改绝对路径根治。
const { markSessionReadMock, chatApiPath, singletonPath } = vi.hoisted(() => ({
  markSessionReadMock: vi.fn<(id: string, base?: string) => Promise<{ ok: true; session: { unread: boolean } }>>(),
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
  singletonPath: require('node:path').resolve(__dirname, '../../../lib/sse-singleton'),
}));

// —— mock chat-api：listSessions 返回预置目标会话，markSessionRead 为 spy —— //
// 工厂内用函数包装引用 hoisted spy（避免工厂顶层执行时引用未初始化变量）
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
      id: 'sess-target',
      title: '目标会话',
      status: 'active',
      unread: true,
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
    unread: true,
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
  markSessionRead: (...args: Parameters<typeof markSessionReadMock>) => markSessionReadMock(...args),
  // [v0.0.139] SectionWorkspacePanel 挂载即 watch 根（use-workspace-watch.ts），mock 必须补齐
  watchWorkspaceDir: vi.fn(async () => ({ ok: true })),
  unwatchWorkspaceDir: vi.fn(async () => ({ ok: true })),
}));

// —— mock sse-singleton：隔离 SSE 单例（v0.0.88 page-chat 用 getSseClient 单例） —— //
vi.mock(singletonPath, () => {
  let singleton: object | null = null;
  return {
    getSseClient: () => {
      if (!singleton) {
        singleton = {
          connect: vi.fn(async () => undefined),
          subscribe: vi.fn(async () => ({
            subId: 'sub-test',
            topic: '',
            group: '',
            unsubscribe: vi.fn(async () => undefined),
          })),
          unsubscribe: vi.fn(async () => undefined),
          destroy: vi.fn(),
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

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-target',
    title: '目标会话',
    status: 'active',
    unread: true,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  markSessionReadMock.mockReset();
  // 预置 sessions 列表（含一条 unread=true 的目标会话）
  useChatStore.getState().setSessions([mkSession({ id: 'sess-target', unread: true })]);
});

afterEach(() => {
  cleanup();
});

describe('PageChat openSession 触发 POST /session/:id/read（v0.0.27）', () => {
  it('点击 conv-item → markSessionRead 被调 + sid 正确', async () => {
    markSessionReadMock.mockResolvedValue({ ok: true, session: { unread: false } });
    render(<PageChat />);
    // 等初始 listSessions resolve + 渲染（listSessions mock 返 []，故预置 store 中的 session 显示）
    const item = (await screen.findByText('目标会话', { selector: '[title="目标会话"]' })).closest('div.cursor-pointer') as HTMLElement;
    fireEvent.click(item);
    // markSessionRead 应被以正确 sid 调用
    await vi.waitFor(() => {
      expect(markSessionReadMock).toHaveBeenCalled();
      expect(markSessionReadMock.mock.calls[0]![0]).toBe('sess-target');
    });
  });

  it('POST /read 成功 → 本地 sessions 对应项 unread=false', async () => {
    markSessionReadMock.mockResolvedValue({ ok: true, session: { unread: false } });
    render(<PageChat />);
    const item = (await screen.findByText('目标会话', { selector: '[title="目标会话"]' })).closest('div.cursor-pointer') as HTMLElement;
    fireEvent.click(item);
    await vi.waitFor(() => {
      const s = useChatStore.getState().sessions.find((it) => it.id === 'sess-target');
      expect(s?.unread).toBe(false);
    });
  });

  it('POST /read 失败不阻塞 UI：active 仍切换 + 不抛异常', async () => {
    markSessionReadMock.mockRejectedValue(new Error('network 500'));
    // 安装 unhandledrejection 守卫（拒绝被 .catch 兜住，不应冒泡）
    const rejHandler = vi.fn();
    process.on('unhandledRejection', rejHandler);

    render(<PageChat />);
    const item = (await screen.findByText('目标会话', { selector: '[title="目标会话"]' })).closest('div.cursor-pointer') as HTMLElement;
    fireEvent.click(item);
    // active 应成功切换（markSessionRead 失败不阻塞）
    await vi.waitFor(() => {
      expect(useChatStore.getState().activeSessionId).toBe('sess-target');
    });
    // markSessionRead 确实被调（只是失败了）—— 全量套件并发下 fire-and-forget 触发有抖动，需 waitFor
    await vi.waitFor(() => {
      expect(markSessionReadMock).toHaveBeenCalled();
    });
    // 切换后 unread 仍为 true（POST 失败未清，UI 不崩）
    await vi.waitFor(() => {
      const s = useChatStore.getState().sessions.find((it) => it.id === 'sess-target');
      expect(s?.unread).toBe(true);
    });

    process.off('unhandledRejection', rejHandler);
  });
});
