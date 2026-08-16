// @vitest-environment jsdom
/**
 * chat 输入区单测（model-tag label / ModelPicker 方向 / composer 渲染 / input-bar 布局 / capabilities 门控）
 * 参考: states/v0.0.9/verify/test-plan.md UT #1/#2/#3
 *       specs/ui/components/chat-page/section-chat-session.md（v0.0.216 迁移：
 *       SectionChatDetail → ComponentChatSessionInput，断言语义逐条保留）
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ModelPicker } from '../../chat/ModelPicker';
import { ComponentChatSessionInput } from '../component-chat-session-input';
import {
  __setProvidersCacheForTest,
  __resetProvidersCacheForTest,
  type ProviderItem,
} from '../../../lib/providers';
import type { SessionChromeView } from '../../../lib/chat-api';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：ChatComposer 用 useTranslation('common')
beforeAll(async () => {
  await initI18n('zh-CN');
});

const FAKE_PROVIDERS: ProviderItem[] = [
  {
    id: '01HZPROVIDERMOCK',
    label: 'Mock Provider',
    models: [
      { modelId: 'claude-mock-1', label: 'Mock 1' },
      { modelId: 'claude-mock-2' }, // 无 label → 回退 modelId
    ],
  },
];

beforeEach(() => {
  __setProvidersCacheForTest(FAKE_PROVIDERS);
});
afterEach(() => {
  cleanup();
  __resetProvidersCacheForTest();
});

/** playground 全开 chrome 夹具（字段可覆盖） */
function mkChrome(over: Partial<SessionChromeView> = {}): SessionChromeView {
  return {
    sessionId: 's1',
    kind: 'playground',
    readOnly: false,
    title: 't',
    titled: false,
    tag: '',
    sessionModel: null,
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

/** 渲染统一输入区（chrome / sessionRunning 可覆盖） */
function renderInput(over: { sessionRunning?: boolean; chrome?: SessionChromeView } = {}) {
  return render(
    <ComponentChatSessionInput
      sessionId="s1"
      chrome={over.chrome ?? mkChrome()}
      sessionRunning={over.sessionRunning ?? false}
      sessionState={null}
      enqueueItems={[]}
      pendingToolCall={null}
      onSubmitReply={() => {}}
      onEnqueueCancel={() => {}}
      onSend={() => {}}
      onAbort={() => {}}
      onModelChange={() => {}}
      onEffortChange={() => {}}
      onApprovalModeChange={() => {}}
      sendError={null}
    />,
  );
}

// ============================================================
// UT #2: ModelPicker 下拉方向（向下，top-full 而非 bottom-full）
// ============================================================
describe('ModelPicker — 下拉方向向下', () => {
  it('展开面板容器 className 含 top-full（向下），不含 bottom-full', async () => {
    render(<ModelPicker value={null} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    const list = await screen.findByRole('listbox');
    const positionWrapper = list.parentElement as HTMLElement;
    expect(positionWrapper.className).toContain('top-full');
    expect(positionWrapper.className).not.toContain('bottom-full');
  });
});

// ============================================================
// UT #1: InputModelPicker trigger 纯图标——模型名仅 hover tooltip（aria-label）显
// ============================================================
describe('ComponentChatSessionInput — InputModelPicker trigger 纯图标（tooltip 显模型名）', () => {
  it('命中 provider+model.label → trigger 不内联模型名，aria-label 含「Mock Provider / Mock 1」', async () => {
    renderInput({ chrome: mkChrome({ sessionModel: { providerId: '01HZPROVIDERMOCK', modelId: 'claude-mock-1' } }) });
    await waitFor(() => {
      const picker = screen.getByRole('button', { name: /Mock Provider/ });
      expect(picker.textContent).not.toContain('Mock Provider');
      expect(picker.textContent).not.toContain('Mock 1');
      expect(picker.textContent).not.toContain('01HZPROVIDERMOCK');
      expect(picker.textContent).not.toContain('claude-mock-1');
      expect(picker.getAttribute('aria-label')).toContain('Mock Provider');
      expect(picker.getAttribute('aria-label')).toContain('Mock 1');
    });
  });

  it('model 无 label → aria-label 回退 modelId（provider 仍用 label）', async () => {
    renderInput({ chrome: mkChrome({ sessionModel: { providerId: '01HZPROVIDERMOCK', modelId: 'claude-mock-2' } }) });
    await waitFor(() => {
      const picker = screen.getByRole('button', { name: /Mock Provider/ });
      expect(picker.textContent).not.toContain('Mock Provider');
      expect(picker.textContent).not.toContain('claude-mock-2');
      expect(picker.getAttribute('aria-label')).toContain('Mock Provider');
      expect(picker.getAttribute('aria-label')).toContain('claude-mock-2');
      expect(picker.getAttribute('aria-label')).not.toContain('01HZPROVIDERMOCK');
    });
  });

  it('sessionModel=null 且无默认 → trigger 仅显图标（tooltip 未配置）+ 位于 input-bar 内', async () => {
    renderInput();
    await waitFor(() => {
      const picker = screen.getByRole('button', { name: /未配置/ }) as HTMLButtonElement;
      expect(picker.tagName).toBe('BUTTON');
      expect(picker.getAttribute('aria-label')).toContain('未配置');
      const inputBar = document.querySelector('[class*="focus-within"]');
      expect(inputBar?.contains(picker)).toBe(true);
    });
  });

  it('chrome.defaultModel 命中 → sessionModel=null 显「默认」态（defaultModelId 复合路径）', async () => {
    renderInput({
      chrome: mkChrome({ defaultModel: { providerId: '01HZPROVIDERMOCK', modelId: 'claude-mock-1' } }),
    });
    await waitFor(() => {
      const picker = document.querySelector('button[data-action-key="chat.model.open"]') as HTMLButtonElement;
      expect(picker).toBeTruthy();
      expect(picker.getAttribute('aria-label')).toContain('Mock 1');
      expect(picker.getAttribute('aria-label')).toContain('默认');
    });
  });
});

// ============================================================
// UT #3: ChatComposer 渲染
// ============================================================
describe('ComponentChatSessionInput — ChatComposer 渲染', () => {
  it('ChatComposer 渲染（Tiptap contenteditable 存在）', () => {
    renderInput();
    const editor = document.querySelector('[contenteditable="true"]');
    expect(editor).toBeTruthy();
  });
});

// ============================================================
// input-bar 上下分离 + 按钮顺序 picker→send→stop + 21px + send 常驻
// ============================================================
describe('ComponentChatSessionInput — input-bar 上下分离布局', () => {
  it('input-bar className 含 flex-col + gap-2（上下分离，非 items-end 横排）', () => {
    renderInput();
    const inputBar = document.querySelector('[class*="focus-within"]') as HTMLElement;
    expect(inputBar).toBeTruthy();
    expect(inputBar.className).toContain('flex-col');
    expect(inputBar.className).toContain('gap-2');
    expect(inputBar.className).not.toContain('items-end');
  });

  it('上段 editor + 下段按钮行（lastElementChild = button row, justify-end）', () => {
    renderInput();
    const inputBar = document.querySelector('[class*="focus-within"]') as HTMLElement;
    const upper = inputBar.firstElementChild as HTMLElement;
    const buttonRow = inputBar.lastElementChild as HTMLElement;
    expect(upper.className).toContain('min-w-0');
    expect(buttonRow.className).toContain('justify-end');
    expect(buttonRow.className).toContain('shrink-0');
  });

  it('idle（非 running）按钮行 = picker → send（无 stop）', () => {
    renderInput({ sessionRunning: false });
    const inputBar = document.querySelector('[class*="focus-within"]') as HTMLElement;
    const buttonRow = inputBar.lastElementChild as HTMLElement;
    const children = Array.from(buttonRow.children);
    const pickerIdx = children.findIndex((c) => c.querySelector('button[aria-haspopup]') || c.getAttribute('aria-haspopup'));
    const sendIdx = children.findIndex((c) => c.querySelector('button[aria-label="发送"]') || (c.tagName === 'BUTTON' && c.getAttribute('aria-label') === '发送'));
    expect(pickerIdx).toBeGreaterThanOrEqual(0);
    expect(sendIdx).toBeGreaterThan(pickerIdx);
    expect(screen.queryByRole('button', { name: '中断' })).toBeNull();
  });

  it('running 时 send 常驻 + stop 在 send 右侧（停止最右）', () => {
    renderInput({ sessionRunning: true });
    const inputBar = document.querySelector('[class*="focus-within"]') as HTMLElement;
    const buttonRow = inputBar.lastElementChild as HTMLElement;
    const children = Array.from(buttonRow.children);
    const sendIdx = children.findIndex((c) => c.querySelector('button[aria-label="发送"]') || (c.tagName === 'BUTTON' && c.getAttribute('aria-label') === '发送'));
    const stopIdx = children.findIndex((c) => c.querySelector('button[aria-label="中断"]') || (c.tagName === 'BUTTON' && c.getAttribute('aria-label') === '中断'));
    expect(sendIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeGreaterThan(sendIdx);
  });

  it('send + picker trigger 均 21px（h-[21px] w-[21px]）', () => {
    renderInput();
    const send = screen.getByRole('button', { name: '发送' });
    const picker = screen.getByRole('button', { name: /未配置/ });
    expect(send.className).toContain('h-[21px]');
    expect(send.className).toContain('w-[21px]');
    expect(picker.className).toContain('h-[21px]');
    expect(picker.className).toContain('w-[21px]');
  });
});

// ============================================================
// capabilities 门控（v0.0.216：群聊形态 = 无两 picker / 无 stop / 窄输入区）
// ============================================================
describe('ComponentChatSessionInput — capabilities 门控', () => {
  it('全开：审批 picker + effort picker + model picker + send 都渲染', () => {
    renderInput();
    expect(document.querySelector('[data-action-key="chat.approval-mode.open"]')).toBeTruthy();
    expect(document.querySelector('[data-action-key="chat.effort.open"]')).toBeTruthy();
    expect(document.querySelector('button[data-action-key="chat.model.open"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
  });

  it('群聊形态（runState/enqueue/两 picker 关 + groupRender）：无 stop、两 picker 不渲染、窄输入区', () => {
    const chrome = mkChrome({ kind: 'studio_group' });
    chrome.capabilities = {
      ...chrome.capabilities,
      runState: false, enqueue: false, effortPicker: false, approvalPicker: false, cron: false,
      groupRender: true,
    };
    renderInput({ chrome, sessionRunning: true }); // 即便 running 也不出 stop——mount 级门控
    expect(screen.queryByRole('button', { name: '中断' })).toBeNull();
    expect(document.querySelector('[data-action-key="chat.approval-mode.open"]')).toBeNull();
    expect(document.querySelector('[data-action-key="chat.effort.open"]')).toBeNull();
    expect(document.querySelector('button[data-action-key="chat.model.open"]')).toBeTruthy();
    const inputBar = document.querySelector('[class*="focus-within"]') as HTMLElement;
    expect(inputBar.className).toContain('max-w-[760px]');
  });
});
