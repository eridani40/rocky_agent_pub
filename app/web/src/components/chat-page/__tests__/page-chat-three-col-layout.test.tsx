// @vitest-environment jsdom
/**
 * page-chat [v0.0.182] 三栏布局接线单测
 * 参考: specs/ui/components/chat-page/_overview.md §1（[v0.0.182] 三栏响应式布局修复）
 *       specs/tech/version_logs/v0.0.182/change_plan.md §3（page 接线模块契约）
 *
 * 覆盖 acceptanceCriteria：
 *   - 外层 scroll 容器（h-full min-h-0 overflow-x-auto 挂 containerRef）
 *   - 内行 flex w-full minWidth=rowMinWidth
 *   - 三栏接线：SectionConvPanel 传 5 可选 props、SectionWorkspacePanel 传 4 可选 props
 *   - rightPresent=false（无 activeSessionId）→ ws-panel 不挂载
 *   - 三栏结构锚点：conv-panel(aside.border-r) / ws-panel(.ws-panel) / chat-page
 *
 * mock 策略：复用 page-chat-model-render.test.tsx 模式（mock chat-api + sse-singleton）。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

const { chatApiPath, singletonPath } = vi.hoisted(() => ({
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
  singletonPath: require('node:path').resolve(__dirname, '../../../lib/sse-singleton'),
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
  listSessions: vi.fn(async () => [] as never[]),
  getSession: vi.fn(async () => null),
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
  watchWorkspaceDir: vi.fn(async () => ({ ok: true })),
  unwatchWorkspaceDir: vi.fn(async () => ({ ok: true })),
}));

vi.mock(singletonPath, () => ({
  getSseClient: () => ({
    subscribe: () => () => {},
    close: () => {},
    setOnConnectionStateChange: () => {},
  }),
}));

import { PageChat } from '../page-chat';
import { useChatStore } from '../../../store/chat-slice';

beforeEach(() => {
  useChatStore.getState().setSessions([]);
  useChatStore.getState().setActiveSession(null);
});

afterEach(() => {
  cleanup();
  useChatStore.getState().setSessions([]);
  useChatStore.getState().setActiveSession(null);
});

describe('PageChat [v0.0.182] 三栏布局接线', () => {
  it('外层 scroll 容器结构：h-full min-h-0 overflow-x-auto（containerRef 挂载）', async () => {
    const { container } = render(<PageChat />);
    // 等挂载完成（listSessions 异步）
    await waitFor(() => expect(container.querySelector('aside.border-r')).toBeTruthy());
    // 外层 = container.firstChild（div.h-full.min-h-0.overflow-x-auto）
    const outer = container.firstElementChild as HTMLElement;
    expect(outer).toBeTruthy();
    expect(outer.className).toContain('h-full');
    expect(outer.className).toContain('min-h-0');
    expect(outer.className).toContain('overflow-x-auto');
  });

  it('内行 flex + minWidth=rowMinWidth（来自 useThreeColLayout）', async () => {
    const { container } = render(<PageChat />);
    await waitFor(() => expect(container.querySelector('aside.border-r')).toBeTruthy());
    const outer = container.firstElementChild as HTMLElement;
    const inner = outer.firstElementChild as HTMLElement;
    expect(inner).toBeTruthy();
    expect(inner.className).toContain('flex');
    expect(inner.className).toContain('w-full');
    // minWidth 来自引擎 rowMinWidth（首帧 available=0 clamp 到 1px，至少 1px 不塌陷）
    expect((inner as HTMLElement).style.minWidth).toMatch(/^\d+px$/);
  });

  it('无 activeSessionId → rightPresent=false → ws-panel 不挂载', async () => {
    const { container } = render(<PageChat />);
    await waitFor(() => expect(container.querySelector('aside.border-r')).toBeTruthy());
    expect(container.querySelector('.ws-panel')).toBeNull();
    expect(container.querySelector('.ws-rail')).toBeNull();
  });

  it('有 activeSessionId → rightPresent=true → ws-panel 挂载', async () => {
    useChatStore.getState().setSessions([
      {
        id: 'sess-A',
        title: '会话A',
        status: 'active',
        unread: false,
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-27T00:00:00.000Z',
      },
    ]);
    useChatStore.getState().setActiveSession('sess-A');
    const { container } = render(<PageChat />);
    await waitFor(() => expect(container.querySelector('.ws-panel')).toBeTruthy());
    expect(container.querySelector('aside.border-r')).toBeTruthy();
  });

  it('左栏拖宽手柄已挂载（playground chat 注入 onConvResize）', async () => {
    const { container } = render(<PageChat />);
    await waitFor(() => expect(container.querySelector('aside.border-r')).toBeTruthy());
    // SectionConvPanel 在 onConvResize 注入时挂 ComponentColResizeHandle（role=separator）
    const handles = screen.getAllByRole('separator');
    expect(handles.length).toBeGreaterThanOrEqual(1);
    // 左栏手柄贴右缘（-right-0.5）
    const convHandle = handles.find((h) => h.className.includes('-right-0.5'));
    expect(convHandle).toBeTruthy();
  });

  it('有 activeSession → 右栏 ws-resize 手柄挂载（ET 锚点）', async () => {
    useChatStore.getState().setSessions([
      {
        id: 'sess-A',
        title: '会话A',
        status: 'active',
        unread: false,
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-27T00:00:00.000Z',
      },
    ]);
    useChatStore.getState().setActiveSession('sess-A');
    const { container } = render(<PageChat />);
    await waitFor(() => expect(container.querySelector('.ws-panel')).toBeTruthy());
    expect(screen.getByLabelText('拖动调节工作区宽度')).toBeTruthy();
  });
});
