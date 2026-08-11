// @vitest-environment jsdom
/**
 * page-chat M-1 修复单测：PreviewAreaProvider sessionId 与渲染面板对齐（v0.0.320 Task 3 review M-1）
 * 参考: specs/tech/version_logs/v0.0.320/change_plan.md D3/D7/D12（Provider 契约）
 *       specs/ui/components/chat-page/_overview.md §1（三栏接线）
 *
 * 背景（code-reviewer M-1 + leader 验证）：原实现 `<PreviewAreaProvider sessionId={viewedSessionId}>`
 * （viewedSessionId = activeSubId ?? activeSessionId）。subagent 激活时（activeSubId 非 null）：
 * 右侧 SectionWorkspacePanel 仍渲染 parent workspace 树（sessionId=activeSessionId），但 Provider
 * sessionId = subagent → 点文件 openTab → usePreviewTabs readWorkspaceFile(subagent) → 读错 workspace / 404。
 * 修复：Provider sessionId 用 activeSessionId ?? ''（与渲染面板对齐）。
 *
 * 覆盖 acceptanceCriteria：
 *   - 普通会话（activeSubId=null）：Provider sessionId = activeSessionId
 *   - subagent 激活（activeSubId 非 null）：Provider sessionId 仍 = activeSessionId（≠ viewedSessionId）
 *
 * mock 策略：preview-area-provider mock 为桩捕获 sessionId prop（绝对路径，bun resolver 兼容）；
 * chat-api + sse-singleton 复用 page-chat-three-col-layout.test.tsx 模式。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

// —— vi.hoisted 提升捕获槽 + 绝对路径 mock（bun --bun runtime 相对路径 mock 静默失效铁律）—— //
const { providerPath, chatApiPath, singletonPath, captured } = vi.hoisted(() => {
  const providerPath = require('node:path').resolve(__dirname, '../preview-area-provider.tsx');
  const chatApiPath = require('node:path').resolve(__dirname, '../../../lib/chat-api.ts');
  const singletonPath = require('node:path').resolve(__dirname, '../../../lib/sse-singleton');
  const captured: { sessionId: string | null } = { sessionId: null };
  return { providerPath, chatApiPath, singletonPath, captured };
});

// Provider 桩：记录 sessionId prop，children 原样透传（不渲染 DOM，同真实 Provider 透明容器语义）
vi.mock(providerPath, () => ({
  PreviewAreaProvider: ({ sessionId, children }: { sessionId: string; children: ReactNode }) => {
    captured.sessionId = sessionId;
    return <>{children}</>;
  },
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
  watchWorkspaceSet: vi.fn(async () => ({ ok: true })),
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
  captured.sessionId = null;
  useChatStore.getState().setSessions([]);
  useChatStore.getState().setActiveSession(null);
  useChatStore.getState().setActiveSubId(null);
});

afterEach(() => {
  cleanup();
  captured.sessionId = null;
  useChatStore.getState().setSessions([]);
  useChatStore.getState().setActiveSession(null);
  useChatStore.getState().setActiveSubId(null);
});

describe('PageChat M-1 — PreviewAreaProvider sessionId 与渲染面板对齐', () => {
  it('普通会话（activeSubId=null）：Provider sessionId = activeSessionId', async () => {
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
    render(<PageChat />);
    await waitFor(() => expect(captured.sessionId).toBe('sess-A'));
  });

  it('subagent 激活（activeSubId 非 null）：Provider sessionId 仍 = activeSessionId（≠ viewedSessionId）', async () => {
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
    // subagent 激活：viewedSessionId = 'sub-B'，但右栏 workspace 树仍是 parent（sess-A）
    useChatStore.getState().setActiveSubId('sub-B');
    render(<PageChat />);
    await waitFor(() => expect(captured.sessionId).toBe('sess-A'));
    // 修复前会拿到 'sub-B'（viewedSessionId）→ 回归保护
    expect(captured.sessionId).not.toBe('sub-B');
  });
});
