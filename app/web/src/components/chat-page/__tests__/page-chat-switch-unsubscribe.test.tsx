// @vitest-environment jsdom
/**
 * page-chat openSession 切会话退订旧 session 单测（v0.0.27 BUG-fix / v0.0.88 单例重构）
 * 参考: specs/tech/app/frontend/[P0]sse_channel.md §9（切会话：unsubscribe 旧 sid 句柄 + subscribe 新 sid）
 *       specs/tech/app/frontend/[P0]sse_client_singleton.md §5 R1/R2 + §6（句柄 cleanup）
 *
 * 覆盖验收点（v0.0.88 改造后语义）：
 *   - 从 A 切到 B 时，旧 session 的 agent_loop + session_panel 订阅句柄 unsubscribe 被调（句柄新签名）
 *   - 从 A 切到 B 时，page-chat session_meta `_all` 句柄不被切会话触发 unsubscribe（mount scope，跨 session 复用）
 *   - 切到 B 后 B 的 subscribe 仍发生（agent_loop + session_panel 带 B 的 sid）
 *   - 切回 A 时 A 能重新 subscribe
 *   - 不破坏 Task3：切会话仍触发 markSessionRead(B)
 *   - cleanup 失败不阻塞 UI
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { initI18n } from '../../../i18n';

// [v0.0.62 i18n] 启动 i18next instance：PageChat → SectionChatSession → ChatComposer 用 useTranslation('common')
beforeAll(async () => {
  await initI18n('zh-CN');
});

// —— vi.hoisted：SseClient 实例方法 spy + 绝对路径 mock —— //
// 注意：bun --bun runtime 下 vitest 的 vi.mock 对相对路径在 jsdom 环境不生效
// （bun resolver 与 vitest mock 拦截器的兼容问题），必须用绝对路径。
// 全量套件高并发下相对路径 mock 偶发失效 → markSessionRead/unsubscribe 走真实实现
// → spy 0 调用 → 断言失败。改绝对路径根治（对齐 page-skill/page-connector 既有模式）。
const { markSessionReadMock, sseSpies, handles, chatApiPath, singletonPath } = vi.hoisted(() => ({
  markSessionReadMock: vi.fn<(id: string, base?: string) => Promise<{ ok: true; session: { unread: boolean } }>>(),
  // 单例 SseClient 共享 spy；句柄 unsubscribe 内部调 sseSpies.unsubscribe(subId)
  sseSpies: {
    connect: vi.fn(async () => undefined),
    // subscribe 形参宽松（topic, group, handler）；subscribe mock 内部 push 句柄到 handles
    subscribe: vi.fn(async (..._args: unknown[]) => undefined),
    unsubscribe: vi.fn(async (..._args: unknown[]) => undefined),
    destroy: vi.fn(),
    isConnected: () => false,
  },
  // 记录每次 subscribe 返回的句柄（验证 cleanup 调句柄 unsubscribe）
  handles: [] as Array<{
    topic: string;
    group: string;
    subId: string;
    unsubscribe: ReturnType<typeof vi.fn>;
  }>,
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
  singletonPath: require('node:path').resolve(__dirname, '../../../lib/sse-singleton'),
}));

// —— mock chat-api：sessions 列表含 A 和 B 两条 —— //
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
    {
      id: 'sess-B',
      title: '会话B',
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
  markSessionRead: (...args: Parameters<typeof markSessionReadMock>) => markSessionReadMock(...args),
  // [v0.0.139] SectionWorkspacePanel 挂载即 watch 根（use-workspace-watch.ts），mock 必须补齐
  // 否则「No export defined on mock」——本文件渲染 PageChat 会连带挂载 workspace 面板。
  watchWorkspaceDir: vi.fn(async () => ({ ok: true })),
  unwatchWorkspaceDir: vi.fn(async () => ({ ok: true })),
}));

// —— mock sse-singleton：返回同一 spy 实例（无论 getSseClient 调多少次） —— //
// subscribe 返回 SubscribeHandle 句柄，handle.unsubscribe 内部调 sseSpies.unsubscribe(subId)
vi.mock(singletonPath, () => {
  let subIdCounter = 0;
  let singleton: object | null = null;
  return {
    getSseClient: () => {
      if (!singleton) {
        singleton = {
          connect: sseSpies.connect,
          subscribe: async (topic: string, group: string, handler: (f: unknown) => void) => {
            sseSpies.subscribe(topic, group, handler);
            const subId = `sub-${++subIdCounter}`;
            const handleSpy = vi.fn(async () => {
              await sseSpies.unsubscribe(subId);
            });
            const handle = { topic, group, subId, unsubscribe: handleSpy };
            handles.push(handle);
            return handle;
          },
          unsubscribe: sseSpies.unsubscribe,
          destroy: sseSpies.destroy,
          isConnected: sseSpies.isConnected,
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

function mkSession(id: string): Session {
  return {
    id,
    title: id === 'sess-A' ? '会话A' : '会话B',
    status: 'active',
    unread: false,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
  };
}

beforeEach(() => {
  markSessionReadMock.mockReset();
  markSessionReadMock.mockResolvedValue({ ok: true, session: { unread: false } });
  sseSpies.subscribe.mockClear();
  sseSpies.unsubscribe.mockClear();
  handles.length = 0;
  useChatStore.getState().setSessions([mkSession('sess-A'), mkSession('sess-B')]);
});

/** 通过标题定位 conv-item 行容器（点行 div 而非 title span，避免 active 态点 title 进编辑态） */
async function findConvItem(title: string): Promise<HTMLElement> {
  const el = await screen.findByText(title, { selector: `[title="${title}"]` });
  return el.closest('div.cursor-pointer') as HTMLElement;
}

afterEach(() => {
  cleanup();
});

describe('PageChat openSession 切会话 unsubscribe 旧 session（v0.0.27 BUG-fix / v0.0.88 句柄）', () => {
  it('A → B：旧 session（A）的 agent_loop + session_panel 句柄 unsubscribe 被调', async () => {
    render(<PageChat />);
    // 先开 A
    const itemA = await findConvItem('会话A');
    fireEvent.click(itemA);
    await vi.waitFor(() => {
      expect(useChatStore.getState().activeSessionId).toBe('sess-A');
    });
    // 等 A 的 agent_loop + session_panel 句柄都登记（v0.0.216 SectionChatSession 内置
    //   5 area-hooks → sess-A 订阅句柄多于 2；断言语义 = 两个 topic 都已建立）
    await vi.waitFor(() => {
      const aHandles = handles.filter(
        (h) => h.group === 'session_id:sess-A' || h.group === 'session_id:sess-A_amt:main',
      );
      expect(aHandles.some((h) => h.topic === 'agent_loop')).toBe(true);
      expect(aHandles.some((h) => h.topic === 'session_panel')).toBe(true);
    });
    const aHandlesBefore = handles.map((h) => h);

    // 切到 B
    const itemB = await findConvItem('会话B');
    fireEvent.click(itemB);
    await vi.waitFor(() => {
      expect(useChatStore.getState().activeSessionId).toBe('sess-B');
    });

    // 旧 session（A）的 agent_loop + session_panel 句柄 cleanup 调 unsubscribe
    // 全量套件并发下 cleanup 触发有时序抖动，需 waitFor（不削弱断言强度）
    await vi.waitFor(() => {
      const agentA = aHandlesBefore.find((h) => h.topic === 'agent_loop' && h.group === 'session_id:sess-A_amt:main');
      const panelA = aHandlesBefore.find((h) => h.topic === 'session_panel' && h.group === 'session_id:sess-A');
      expect(agentA?.unsubscribe).toHaveBeenCalled();
      expect(panelA?.unsubscribe).toHaveBeenCalled();
    });
  });

  it('A → B：切到 B 后 B 的 subscribe 仍发生（agent_loop + session_panel 带 B sid）', async () => {
    render(<PageChat />);
    const itemA = await findConvItem('会话A');
    fireEvent.click(itemA);
    await vi.waitFor(() => expect(useChatStore.getState().activeSessionId).toBe('sess-A'));
    sseSpies.subscribe.mockClear();

    const itemB = await findConvItem('会话B');
    fireEvent.click(itemB);
    await vi.waitFor(() => expect(useChatStore.getState().activeSessionId).toBe('sess-B'));

    // B 的两个 subscribe 都要发生（句柄新签名：subscribe(topic, group, handler) → 返回 SubscribeHandle）
    await vi.waitFor(() => {
      expect(sseSpies.subscribe).toHaveBeenCalledWith('agent_loop', 'session_id:sess-B_amt:main', expect.any(Function));
      expect(sseSpies.subscribe).toHaveBeenCalledWith('session_panel', 'session_id:sess-B', expect.any(Function));
    });
  });

  it('A → B → A：切回 A 时 A 能重新 subscribe', async () => {
    render(<PageChat />);
    const itemA = await findConvItem('会话A');
    fireEvent.click(itemA);
    await vi.waitFor(() => expect(useChatStore.getState().activeSessionId).toBe('sess-A'));

    const itemB = await findConvItem('会话B');
    fireEvent.click(itemB);
    await vi.waitFor(() => expect(useChatStore.getState().activeSessionId).toBe('sess-B'));
    sseSpies.subscribe.mockClear();

    // 切回 A：应重新 subscribe A 的两个 topic
    const itemA2 = await findConvItem('会话A');
    fireEvent.click(itemA2);
    await vi.waitFor(() => expect(useChatStore.getState().activeSessionId).toBe('sess-A'));
    await vi.waitFor(() => {
      expect(sseSpies.subscribe).toHaveBeenCalledWith('session_panel', 'session_id:sess-A', expect.any(Function));
      expect(sseSpies.subscribe).toHaveBeenCalledWith('agent_loop', 'session_id:sess-A_amt:main', expect.any(Function));
    });
  });

  it('不破坏 Task3 markSessionRead：切到 B 仍 POST /session/B/read', async () => {
    render(<PageChat />);
    const itemA = await findConvItem('会话A');
    fireEvent.click(itemA);
    await vi.waitFor(() => expect(useChatStore.getState().activeSessionId).toBe('sess-A'));
    markSessionReadMock.mockClear();

    const itemB = await findConvItem('会话B');
    fireEvent.click(itemB);
    await vi.waitFor(() => expect(useChatStore.getState().activeSessionId).toBe('sess-B'));

    // markSessionRead fire-and-forget 在全量套件并发下触发有抖动，需 waitFor
    await vi.waitFor(
      () => {
        expect(markSessionReadMock).toHaveBeenCalledWith('sess-B');
      },
      { timeout: 2000, interval: 20 },
    );
  });

  it('cleanup 失败不阻塞 UI：active 仍切换且不冒泡未捕获拒绝', async () => {
    // 句柄 unsubscribe 失败模拟：让 SseClient.unsubscribe reject
    sseSpies.unsubscribe.mockRejectedValueOnce(new Error('net 500'));
    const rejHandler = vi.fn();
    process.on('unhandledRejection', rejHandler);

    render(<PageChat />);
    const itemA = await findConvItem('会话A');
    fireEvent.click(itemA);
    await vi.waitFor(() => expect(useChatStore.getState().activeSessionId).toBe('sess-A'));

    const itemB = await findConvItem('会话B');
    fireEvent.click(itemB);
    await vi.waitFor(() => expect(useChatStore.getState().activeSessionId).toBe('sess-B'));

    // 句柄 cleanup 用 .catch(() => {}) 兜住，不应冒泡未捕获拒绝
    await vi.waitFor(() => {
      expect(rejHandler).not.toHaveBeenCalled();
    });
    process.off('unhandledRejection', rejHandler);
  });
});

/**
 * v0.0.90 BUG-fix：切顶层会话后清空 activeSubId（防右侧内容卡死）
 * 参考: reqs/[working] v0.0.90.session_switch_freeze/req.md
 *       specs/ui/components/chat-page/_overview.md §5 交互5/8
 *
 * 根因：activeSubId 点 subagent 时被 set，但顶层列表 onSelect 不清 null →
 *   viewedSessionId = activeSubId ?? activeSessionId 因 ?? 短路 → 引擎 [sessionId]
 *   effect 不重触发 → 右侧消息流卡死在旧 subagent。
 *
 * 修复：顶层列表 onSelect 回调里先 setActiveSubId(null) 再 openSession(id)。
 *   覆盖四条路径中的 subagent → 顶层（本 bug 修复点）。
 */
describe('PageChat 切顶层会话清空 activeSubId（v0.0.90 BUG-fix）', () => {
  it('subagent → 顶层：点顶层 conv-item 后 activeSubId 复位 null + activeSessionId 切到新顶层', async () => {
    // 预置：模拟用户刚点过 subagent 只读页（activeSubId = 'sub-X'）
    useChatStore.getState().setActiveSubId('sub-X');
    expect(useChatStore.getState().activeSubId).toBe('sub-X');

    render(<PageChat />);
    // 等列表渲染
    const itemA = await findConvItem('会话A');

    // 点顶层会话 A（模拟 subagent→顶层切换 —— 本 bug 触发路径）
    fireEvent.click(itemA);

    // 断言：activeSubId 被清 null（修复核心）+ activeSessionId 切到 A
    await vi.waitFor(() => {
      const st = useChatStore.getState();
      expect(st.activeSubId).toBe(null);
      expect(st.activeSessionId).toBe('sess-A');
    });
  });

  it('subagent → 顶层 → 顶层：activeSubId 保持 null，反复切顶层会话不残留', async () => {
    useChatStore.getState().setActiveSubId('sub-X');

    render(<PageChat />);
    const itemA = await findConvItem('会话A');
    fireEvent.click(itemA);
    await vi.waitFor(() => expect(useChatStore.getState().activeSessionId).toBe('sess-A'));
    await vi.waitFor(() => expect(useChatStore.getState().activeSubId).toBe(null));

    // 切到 B（顶层→顶层，activeSubId 应继续保持 null）
    const itemB = await findConvItem('会话B');
    fireEvent.click(itemB);
    await vi.waitFor(() => expect(useChatStore.getState().activeSessionId).toBe('sess-B'));
    expect(useChatStore.getState().activeSubId).toBe(null);
  });

  it('subagent 只读页下 handleCreate（新建会话）：activeSubId 清 null + activeSessionId 切到新会话', async () => {
    // 预置：模拟刚点过 subagent 只读页（activeSubId = 'sub-X'）
    useChatStore.getState().setActiveSubId('sub-X');
    expect(useChatStore.getState().activeSubId).toBe('sub-X');

    render(<PageChat />);
    const newBtn = await screen.findByRole('button', { name: '新建会话' });

    // 点新建按钮 —— handleCreate 走 openSession(newId)，方案 B 内清 activeSubId
    fireEvent.click(newBtn);

    // 断言：activeSubId 清 null + activeSessionId 切到新会话 'new'
    await vi.waitFor(() => {
      const st = useChatStore.getState();
      expect(st.activeSubId).toBe(null);
      expect(st.activeSessionId).toBe('new');
    });
  });

  it('subagent 只读页下 handleDelete（删当前 active 顶层会话）：activeSubId 同步清 null', async () => {
    // 预置：activeSessionId 是顶层 A + activeSubId 是 sub-X（模拟用户在 subagent 只读页删当前 parent）
    useChatStore.getState().setSessions([mkSession('sess-A'), mkSession('sess-B')]);
    useChatStore.getState().setActiveSession('sess-A');
    useChatStore.getState().setActiveSubId('sub-X');

    render(<PageChat />);
    // 等 conv-item-A 渲染（删除按钮按 hover-only opacity，但 fireEvent 仍可触发 click）
    const itemA = await findConvItem('会话A');
    // 找 A 行的删除按钮（按文案「删除」）；bb2d5b30 起点删除先弹二次确认 modal
    const deleteBtn = screen.getAllByText('删除')[0]!;
    fireEvent.click(deleteBtn);
    // 阻止 conv-item 行 onClick 被同步触发（实际组件已 stopPropagation，这里仅断言结果）
    void itemA;

    // 点确认 modal 内「删除」确认按钮才真删（bb2d5b30 二次确认）
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('删除'));

    // 断言：删当前 active → activeSessionId=null + activeSubId 同步清 null（防引擎卡在 subagent）
    await vi.waitFor(() => {
      const st = useChatStore.getState();
      expect(st.activeSessionId).toBe(null);
      expect(st.activeSubId).toBe(null);
    });
  });
});
