/**
 * @vitest-environment jsdom
 * component-studio-chat-router 单测（v0.0.216 统一装配层改造）
 * 参考: specs/ui/components/studio-page/section-studio-chat.md（薄壳契约）
 *       specs/api/overall/04a-session-chrome.md（chrome shape / capabilities）
 *
 * 覆盖：
 * ① onBack 传入 → SectionStudioChat 收到 onBack（透传契约，群/单同路径）
 * ② onBack 缺省 → 收到 undefined onBack（下游自决不渲染 back）
 * ③ chrome 经 prop 下传（防双拉：stub 收到的 chrome 与 hook 返回同一引用）
 * ④ workspaceSemantic 派生：groupRender→team / 对端 leader→team / mate→personal
 * ⑤ chrome loading → 渲占位（不 mount SectionStudioChat）
 * ⑥ 三栏布局外壳（外层 scroll 容器 + min-w-0 + hook 在 early return 前）
 *
 * 隔离策略：mock useChatChrome + mock SectionStudioChat/SectionRightTabs 为断言桩。
 * vi.mock 路径用 __dirname 绝对派生（MEMORY test-vitest-mock-absolute-path）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import type { SessionChromeView } from '../../../lib/chat-api';

// ─── mock 路径（绝对）───────────────────────────────────────────────────────
const chromeHookPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../chat-page/use-chat-chrome'),
);
const studioChatPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../section-studio-chat'));
const rightTabsPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../section-right-tabs'));

// chrome 可控态：默认 loading=false + studio_member（mate 对端）；测试按需覆盖
const chromeState = vi.hoisted(() => ({
  current: {
    loading: false as boolean,
    chrome: null as Record<string, unknown> | null,
  },
}));
vi.mock(chromeHookPath, () => ({
  useChatChrome: () => ({
    chrome: chromeState.current.chrome,
    loading: chromeState.current.loading,
    error: null,
    setEffort: vi.fn(),
    setApprovalMode: vi.fn(),
    setModel: vi.fn(),
  }),
}));

// Stub SectionStudioChat：把 onBack/chrome 引用暴露到 DOM 便于断言
const receivedChrome = vi.hoisted(() => ({ current: null as unknown }));
vi.mock(studioChatPath, () => ({
  SectionStudioChat: (props: { onBack?: () => void; sessionId: string; chrome: unknown }) => {
    receivedChrome.current = props.chrome;
    return (
      <div
        data-has-back={String(typeof props.onBack === 'function')}
        onClick={() => props.onBack?.()}
      >
        studio-chat-{props.sessionId}
      </div>
    );
  },
}));
// Stub SectionRightTabs：暴露 workspaceSemantic 便于派生断言
vi.mock(rightTabsPath, () => ({
  SectionRightTabs: (props: { workspaceSemantic: string }) => (
    <div data-ws-semantic={props.workspaceSemantic} data-testid="right-tabs-stub" />
  ),
}));

// 延后 import：mock 生效后再 import 被测组件
import { StudioChatRouter } from '../component-studio-chat-router';
import type { ChatNode } from '../chat-node';

/** studio chrome 夹具（memberId 有值=单聊；over 覆盖群聊/leader 形态） */
function mkChrome(over: Partial<SessionChromeView> = {}): Record<string, unknown> {
  return {
    sessionId: 'sess-m1',
    kind: 'studio_member',
    readOnly: false,
    title: 'Alice',
    titled: true,
    tag: 'Squad A · mate',
    sessionModel: null,
    defaultModel: null,
    effort: null,
    approvalMode: null,
    members: [
      { id: 'm-lead', name: 'Bob', role: 'leader' },
      { id: 'm1', name: 'Alice', role: 'mate' },
    ],
    memberId: 'm1',
    capabilities: {
      runState: true, hitl: true, enqueue: true, effortPicker: true, approvalPicker: true,
      usage: true, compact: true, clear: true, minimap: true, floatMenu: true, cron: true,
      groupRender: false,
    },
    ...over,
  };
}

beforeAll(async () => {
  await initI18n('zh-CN');
});
beforeEach(() => {
  cleanup();
  chromeState.current.loading = false;
  chromeState.current.chrome = mkChrome();
  receivedChrome.current = null;
});
afterEach(() => cleanup());

const nodeMember: ChatNode = {
  sessionId: 'sess-m1',
  title: 'Alice',
  tag: 'sq_a · 单聊',
  squadId: 'squad-a',
};

describe('StudioChatRouter — SectionStudioChat 透传', () => {
  it('① onBack 传入 → SectionStudioChat 收到 onBack（has-back=true）+ 点击触发', () => {
    const onBack = vi.fn();
    render(<StudioChatRouter node={nodeMember} onBack={onBack} />);
    const stub = screen.getByText(`studio-chat-${nodeMember.sessionId}`);
    expect(stub.getAttribute('data-has-back')).toBe('true');
    fireEvent.click(stub);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('② onBack 缺省 → 收到 undefined onBack（下游自决不渲染 back）', () => {
    render(<StudioChatRouter node={nodeMember} />);
    expect(
      screen.getByText(`studio-chat-${nodeMember.sessionId}`).getAttribute('data-has-back'),
    ).toBe('false');
  });

  it('③ chrome 经 prop 下传（防双拉：stub 收到 hook 返回的同一引用）', () => {
    render(<StudioChatRouter node={nodeMember} />);
    expect(receivedChrome.current).toBe(chromeState.current.chrome);
  });

  it('⑤ chrome loading → 渲占位（不 mount SectionStudioChat）', () => {
    chromeState.current.loading = true;
    chromeState.current.chrome = null;
    render(<StudioChatRouter node={nodeMember} onBack={() => {}} />);
    expect(screen.getByText('…')).toBeTruthy();
    expect(screen.queryByText(`studio-chat-${nodeMember.sessionId}`)).toBeNull();
  });
});

describe('StudioChatRouter — workspaceSemantic 派生（chrome 数据驱动）', () => {
  it('群聊（capabilities.groupRender=true）→ team', () => {
    chromeState.current.chrome = mkChrome({
      kind: 'studio_group',
      memberId: null,
      capabilities: { ...(mkChrome().capabilities as SessionChromeView['capabilities']), groupRender: true },
    });
    render(<StudioChatRouter node={nodeMember} />);
    expect(screen.getByTestId('right-tabs-stub').getAttribute('data-ws-semantic')).toBe('team');
  });

  it('leader 单聊（对端 member.role=leader）→ team', () => {
    chromeState.current.chrome = mkChrome({ memberId: 'm-lead' });
    render(<StudioChatRouter node={nodeMember} />);
    expect(screen.getByTestId('right-tabs-stub').getAttribute('data-ws-semantic')).toBe('team');
  });

  it('mate 单聊 → personal', () => {
    render(<StudioChatRouter node={nodeMember} />);
    expect(screen.getByTestId('right-tabs-stub').getAttribute('data-ws-semantic')).toBe('personal');
  });
});

// ── 三栏响应式布局接线（外层 scroll 容器 + min-w-0 + hook 在 early return 前） ──
// 参考: specs/ui/components/studio-page/section-right-tabs.md §6（集成点注）
describe('StudioChatRouter 三栏响应式布局接线', () => {
  it('正常分支：外层 scroll 容器（flex-1 min-w-0 min-h-0 overflow-x-auto）+ 内行 minWidth', () => {
    const { container } = render(<StudioChatRouter node={nodeMember} />);
    const outer = container.firstElementChild as HTMLElement;
    expect(outer).toBeTruthy();
    expect(outer.className).toContain('flex-1');
    expect(outer.className).toContain('min-w-0');
    expect(outer.className).toContain('min-h-0');
    expect(outer.className).toContain('overflow-x-auto');
    // 内行 = outer.firstChild，含 minWidth style（clamp 到 ≥1px，防 available=0 塌陷）
    const inner = outer.firstElementChild as HTMLElement;
    expect(inner).toBeTruthy();
    expect(inner.className).toContain('flex');
    expect(inner.className).toContain('h-full');
    expect(inner.className).toContain('w-full');
    const minW = inner.style.minWidth;
    expect(minW).not.toBe('');
    expect(parseFloat(minW)).toBeGreaterThanOrEqual(1);
  });

  it('loading 分支：同样应用外层 scroll 容器 + min-w-0（hook 在 early return 前调用）', () => {
    chromeState.current.loading = true;
    chromeState.current.chrome = null;
    const { container } = render(<StudioChatRouter node={nodeMember} />);
    const outer = container.firstElementChild as HTMLElement;
    expect(outer).toBeTruthy();
    expect(outer.className).toContain('min-w-0');
    expect(outer.className).toContain('flex-1');
    expect(outer.className).toContain('overflow-x-auto');
    // loading 占位仍在内行里
    expect(screen.getByText('…')).toBeTruthy();
  });
});
