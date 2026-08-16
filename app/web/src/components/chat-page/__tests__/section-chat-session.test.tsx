// @vitest-environment jsdom
/**
 * SectionChatSession 单测 —— capabilities 门控渲染 + readOnly 等价 + 空态门控
 * 参考: specs/ui/components/chat-page/section-chat-session.md（门控矩阵/Props 契约）
 *       specs/tech/app/frontend/[P0]chat_session_assembly.md §2（设计原则 1/3）
 *       （迁移自 section-chat-detail-idle/readonly + model-picker-width 旧断言，语义逐条保留）
 *
 * 覆盖：
 *   - sessionId=null → 空态（emptyStateSlot）+ 无 input-bar + 不拉 chrome
 *   - playground 全开：input-bar/usage/compact/clear/composer 全在
 *   - readOnly（chrome.readOnly=true）：写操作全隐（composer/picker/clear），保留
 *     usage+compact+badge+model-tag（max-w-[180px]）；readOnly prop ∪ chrome.readOnly 等价
 *   - capabilities 门控：usage/compact/clear/floatMenu 关 → 对应元素不渲染
 *   - 群聊形态：hideCron + 窄输入区（输入区细项见 component-chat-session-input 测试）
 *   - chrome error → 空态兜底不抛
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

// —— vi.hoisted：绝对路径 mock + 可变 chrome 夹具 —— //
const { chatApiPath, singletonPath, composerPath, chromeHolder, getSessionChromeMock } = vi.hoisted(() => ({
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
  singletonPath: require('node:path').resolve(__dirname, '../../../lib/sse-singleton'),
  composerPath: require('node:path').resolve(__dirname, '../component-chat-composer'),
  // 每个 it 通过 chromeHolder.value 定制返回的 chrome
  chromeHolder: { value: null as unknown },
  getSessionChromeMock: vi.fn(),
}));

vi.mock(chatApiPath, () => ({
  getSessionChrome: (...args: unknown[]) => {
    getSessionChromeMock(...args);
    if (chromeHolder.value instanceof Error) return Promise.reject(chromeHolder.value);
    return Promise.resolve(chromeHolder.value);
  },
  getSession: vi.fn(async (id: string) => ({ id, running: false, state: 'idle' })),
  getMessages: vi.fn(async () => ({ items: [], hasMore: false })),
  getInbox: vi.fn(async () => ({ items: [] })),
  getPendingToolCall: vi.fn(async () => null),
  getSessionUsage: vi.fn(async () => null),
  postMessage: vi.fn(async () => ({ runId: 'r' })),
  postCompact: vi.fn(async () => ({ ok: true })),
  postClear: vi.fn(async () => ({ ok: true })),
  cancelEnqueue: vi.fn(async () => ({ ok: true })),
  abortSession: vi.fn(async () => ({ ok: true })),
  updateSession: vi.fn(async () => ({})),
}));

// mock sse-singleton（隔离订阅；本测只验渲染门控）
vi.mock(singletonPath, () => ({
  getSseClient: () => ({
    subscribe: async (topic: string, group: string) => ({
      topic,
      group,
      subId: 'sub',
      unsubscribe: vi.fn(async () => undefined),
    }),
  }),
}));

// 桩 ChatComposer（避免 @tiptap 重渲染；保留 contenteditable 锚点语义）
vi.mock(composerPath, () => ({
  ChatComposer: function MockChatComposer() {
    return <div contentEditable="true">mock-editor</div>;
  },
}));

import { SectionChatSession } from '../section-chat-session';
import type { SessionChromeView } from '../../../lib/chat-api';
import {
  __setProvidersCacheForTest,
  __resetProvidersCacheForTest,
} from '../../../lib/providers';

/** chrome 夹具（capabilities/readOnly 可覆盖） */
function mkChrome(over: Partial<SessionChromeView> = {}): SessionChromeView {
  return {
    sessionId: 's1',
    kind: 'playground',
    readOnly: false,
    title: 'explorer',
    titled: true,
    tag: '',
    sessionModel: { providerId: '01HZPROVIDERMOCK', modelId: 'glm-mock-1' },
    defaultModel: null,
    defaultRoutingPlan: null,
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
  chromeHolder.value = mkChrome();
  __setProvidersCacheForTest([
    { id: '01HZPROVIDERMOCK', label: 'Mock Provider', models: [{ modelId: 'glm-mock-1', label: 'GLM Mock' }] },
  ]);
});
afterEach(() => {
  cleanup();
  __resetProvidersCacheForTest();
});

/** 等 chrome loading 收敛（topbar title 出现） */
async function waitLoaded(title = 'explorer') {
  await waitFor(() => expect(screen.queryByText(title)).not.toBeNull());
}

describe('SectionChatSession — sessionId=null 空态门控', () => {
  it('sessionId=null → 渲 emptyStateSlot + 无 input-bar + 不拉 chrome', async () => {
    render(<SectionChatSession sessionId={null} emptyStateSlot={<div>welcome-hero</div>} />);
    expect(screen.getByText('welcome-hero')).toBeTruthy();
    expect(document.querySelector('[class*="focus-within"]')).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(getSessionChromeMock).not.toHaveBeenCalled();
  });

  it('sessionId=null 无 emptyStateSlot → 缺省通用空文案', () => {
    render(<SectionChatSession sessionId={null} />);
    expect(screen.getByText('在下方输入消息开始对话')).toBeTruthy();
  });
});

describe('SectionChatSession — playground 全开（capabilities 全 true）', () => {
  it('input-bar + composer + usage + compact + clear 全渲染；空消息渲 emptyStateSlot', async () => {
    render(<SectionChatSession sessionId="s1" emptyStateSlot={<div>hero</div>} />);
    await waitLoaded();
    expect(document.querySelector('[class*="focus-within"]')).toBeTruthy();
    expect(document.querySelector('[contenteditable="true"]')).toBeTruthy();
    // v0.0.326：topbar 右端只留 usage 环 trigger；Compact/Clear 移入展开面板 head
    expect(screen.queryByRole('button', { name: '点击查看用量详情' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '点击查看用量详情' }));
    expect(screen.queryByRole('button', { name: '压缩上下文 (Compact)' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: '清空会话 (Clear)' })).not.toBeNull();
    expect(screen.getByText('hero')).toBeTruthy();
    // 非 readOnly：badge 不渲染
    expect(screen.queryByText(/子AGENT/)).toBeNull();
  });
});

describe('SectionChatSession — readOnly 等价（chrome.readOnly / prop 双入口）', () => {
  it('chrome.readOnly=true（subagent）→ 写操作全隐 + 保留 usage/compact/badge/model-tag', async () => {
    chromeHolder.value = mkChrome({ readOnly: true });
    const { container } = render(<SectionChatSession sessionId="s1" />);
    await waitLoaded();
    // 隐藏清单：composer / input-bar / clear / picker
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    expect(container.querySelector('[class*="focus-within"]')).toBeNull();
    expect(screen.queryByRole('button', { name: '清空会话 (Clear)' })).toBeNull();
    expect(container.querySelector('button[aria-haspopup="listbox"]')).toBeNull();
    // 保留清单：usage trigger + compact（面板内）+ badge + model-tag（max-w-[180px]，旧 model-picker-width 断言随迁）
    // v0.0.326：readOnly 时 onClear=null → 面板内不渲 ClearBtn；onCompact 保留
    expect(screen.queryByRole('button', { name: '点击查看用量详情' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '点击查看用量详情' }));
    expect(screen.queryByRole('button', { name: '压缩上下文 (Compact)' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: '清空会话 (Clear)' })).toBeNull();
    const badge = screen.queryByText(/子AGENT/);
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('只读');
    const tag = container.querySelector('span[class*="max-w-[180px]"]') as HTMLElement;
    expect(tag).not.toBeNull();
    expect(tag.getAttribute('title')).toContain('glm-mock-1');
  });

  it('readOnly prop=true（chrome.readOnly=false）→ 同等只读效果（prop ∪ chrome）', async () => {
    render(<SectionChatSession sessionId="s1" readOnly />);
    await waitLoaded();
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    expect(screen.queryByText(/子AGENT/)).not.toBeNull();
    expect(screen.queryByRole('button', { name: '清空会话 (Clear)' })).toBeNull();
    // v0.0.326：compact 在展开面板内（readOnly 保留）
    fireEvent.click(screen.getByRole('button', { name: '点击查看用量详情' }));
    expect(screen.queryByRole('button', { name: '压缩上下文 (Compact)' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: '清空会话 (Clear)' })).toBeNull();
  });
});

describe('SectionChatSession — capabilities 逐项门控', () => {
  it('usage/compact/clear 全关 → topbar 右侧三件套不渲染', async () => {
    const chrome = mkChrome();
    chrome.capabilities = { ...chrome.capabilities, usage: false, compact: false, clear: false };
    chromeHolder.value = chrome;
    render(<SectionChatSession sessionId="s1" />);
    await waitLoaded();
    expect(screen.queryByRole('button', { name: '展开用量' })).toBeNull();
    expect(screen.queryByRole('button', { name: '压缩上下文 (Compact)' })).toBeNull();
    expect(screen.queryByRole('button', { name: '清空会话 (Clear)' })).toBeNull();
  });

  it('群聊形态（studio_group caps）→ 窄输入区 + 无两 picker + 无 stop（细项见 input 测试）', async () => {
    const chrome = mkChrome({ kind: 'studio_group', tag: 'Alpha · 群聊', title: 'Alpha' });
    chrome.capabilities = {
      ...chrome.capabilities,
      runState: false, enqueue: false, effortPicker: false, approvalPicker: false, cron: false,
      groupRender: true,
    };
    chromeHolder.value = chrome;
    render(<SectionChatSession sessionId="s1" />);
    await waitLoaded('Alpha');
    const inputBar = document.querySelector('[class*="focus-within"]') as HTMLElement;
    expect(inputBar).toBeTruthy();
    expect(inputBar.className).toContain('max-w-[760px]');
    expect(document.querySelector('[data-action-key="chat.effort.open"]')).toBeNull();
    expect(document.querySelector('[data-action-key="chat.approval-mode.open"]')).toBeNull();
    expect(screen.queryByRole('button', { name: '中断' })).toBeNull();
    // tag 渲染（缺省 topbarLeft）
    expect(screen.getByText('Alpha · 群聊')).toBeTruthy();
  });

  it('topbarLeft render-prop 注入 → 覆盖缺省身份 header', async () => {
    render(
      <SectionChatSession sessionId="s1" topbarLeft={(c) => <div>custom-{c.kind}</div>} />,
    );
    await waitFor(() => expect(screen.queryByText('custom-playground')).not.toBeNull());
    // 缺省 title 不再渲染（被 render-prop 覆盖）
    expect(screen.queryByText('explorer')).toBeNull();
  });
});

describe('SectionChatSession — chrome error 兜底', () => {
  it('getSessionChrome 抛错 → 空态兜底 + 无 input-bar（不抛不白屏）', async () => {
    chromeHolder.value = new Error('session not found');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<SectionChatSession sessionId="s-404" emptyStateSlot={<div>fallback</div>} />);
    await waitFor(() => expect(screen.queryByText('fallback')).not.toBeNull());
    expect(document.querySelector('[class*="focus-within"]')).toBeNull();
    warnSpy.mockRestore();
  });
});
