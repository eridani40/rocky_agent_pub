/**
 * @vitest-environment jsdom
 * section-studio-chat 单测 —— Studio 单/群聊薄壳（身份 header 两形态 + 透传契约）
 * 参考: specs/ui/components/studio-page/section-studio-chat.md（本组件契约）
 *       specs/ui/components/chat-page/section-chat-session.md（会话能力权威）
 *
 * 覆盖（自旧 section-member-chat / section-squad-chat 壳级断言迁移）：
 * ① 单聊（memberId 命中 members）→ topbarLeft 渲 MemberAvatar 首字母 + name + tag，
 *    backActionKey='studio.member-chat.back'
 * ② 群聊（memberId=null）→ topbarLeft 显式 ChatSessionTopbarLeft（v0.0.269 恢复 268 前
 *    形态——团队状态入口已挪 chat 浮菜单，topbar 不再挂 SquadStatusEntry），
 *    backActionKey='studio.group-chat.back'
 * ③ member 缺失兜底（memberId 有值但 members 无匹配）→ 同群聊路径（显式 ChatSessionTopbarLeft）
 * ④ 透传：chrome 同引用注入 / prefill / onBack / rootTag='main' / fadeIn
 *
 * 隔离策略：mock SectionChatSession 为断言桩（捕获 props + 渲 topbarLeft(chrome) 输出）；
 *   mock ChatSessionTopbarLeft 为桩（群聊缺省 header 断言用）。
 * vi.mock 路径用 __dirname 绝对派生（MEMORY test-vitest-mock-absolute-path）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { initI18n } from '../../../i18n';
import type { SessionChromeView } from '../../../lib/chat-api';

// ─── mock SectionChatSession（绝对路径）────────────────────────────────────
const sessionPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../chat-page/section-chat-session'),
);
const captured = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock(sessionPath, () => ({
  SectionChatSession: (props: {
    chrome: SessionChromeView;
    topbarLeft?: (c: SessionChromeView) => ReactNode;
    backActionKey?: string;
  }) => {
    captured.current = props as unknown as Record<string, unknown>;
    return (
      <div data-testid="session-stub" data-back-action-key={props.backActionKey ?? ''}>
        {props.topbarLeft ? props.topbarLeft(props.chrome) : <span data-testid="default-topbar" />}
      </div>
    );
  },
}));

// ─── mock ChatSessionTopbarLeft（群聊缺省 header 桩；v0.0.268 显式渲染）───────
const topbarLeftPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../chat-page/component-chat-session-topbar-left'),
);
vi.mock(topbarLeftPath, () => ({
  ChatSessionTopbarLeft: () => <span data-testid="chat-topbar-left-stub" />,
}));

// 延后 import：mock 生效后再 import 被测组件
import { SectionStudioChat } from '../section-studio-chat';

/** studio chrome 夹具（缺省单聊 mate 对端；over 覆盖群聊等形态） */
function mkChrome(over: Partial<SessionChromeView> = {}): SessionChromeView {
  return {
    sessionId: 'sess-1',
    kind: 'studio_member',
    readOnly: false,
    title: 'Alice',
    titled: true,
    tag: 'Squad A · mate',
    sessionModel: null,
    defaultModel: null,
    defaultRoutingPlan: null,
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
  captured.current = null;
});
afterEach(() => cleanup());

describe('SectionStudioChat — 身份 header 两形态（chrome.memberId 数据驱动）', () => {
  it('① 单聊：topbarLeft 渲 member name + tag，backActionKey=studio.member-chat.back', () => {
    render(<SectionStudioChat sessionId="sess-1" chrome={mkChrome()} />);
    // 身份 header：name + tag（MemberAvatar 首字母 A 一并渲出）
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Squad A · mate')).toBeTruthy();
    expect(screen.queryByTestId('default-topbar')).toBeNull();
    expect(screen.getByTestId('session-stub').getAttribute('data-back-action-key')).toBe(
      'studio.member-chat.back',
    );
  });

  it('② 群聊（memberId=null）：topbarLeft 显式 ChatSessionTopbarLeft + group back key（v0.0.269 恢复 268 前形态）', () => {
    render(
      <SectionStudioChat
        sessionId="sess-g"
        chrome={mkChrome({ kind: 'studio_group', memberId: null, tag: 'Squad A · 群聊' })}
      />,
    );
    // v0.0.269：团队状态入口已挪 chat 浮菜单，topbar 不再挂 SquadStatusEntry（无 squad-status-entry）
    //   + 显式 ChatSessionTopbarLeft（行为与现状缺省等价）
    expect(typeof captured.current!.topbarLeft).toBe('function');
    expect(screen.getByTestId('chat-topbar-left-stub')).toBeTruthy();
    expect(screen.queryByTestId('squad-status-entry')).toBeNull(); // 入口已删除（v0.0.269）
    expect(screen.queryByTestId('default-topbar')).toBeNull(); // 不再走 SectionChatSession 缺省
    expect(screen.getByTestId('session-stub').getAttribute('data-back-action-key')).toBe(
      'studio.group-chat.back',
    );
  });

  it('③ member 缺失兜底（memberId 无匹配）→ 同群聊路径（显式 ChatSessionTopbarLeft + group back key）', () => {
    render(
      <SectionStudioChat sessionId="sess-x" chrome={mkChrome({ memberId: 'ghost' })} />,
    );
    expect(typeof captured.current!.topbarLeft).toBe('function');
    expect(screen.getByTestId('chat-topbar-left-stub')).toBeTruthy();
    expect(screen.queryByTestId('squad-status-entry')).toBeNull(); // 入口已删除（v0.0.269）
    expect(screen.getByTestId('session-stub').getAttribute('data-back-action-key')).toBe(
      'studio.group-chat.back',
    );
  });
});

describe('SectionStudioChat — 透传契约', () => {
  it('④ chrome 同引用注入 + prefill/onBack/rootTag=main/fadeIn 透传', () => {
    const chrome = mkChrome();
    const onBack = vi.fn();
    const prefill = [{ id: 'x', label: 'X', type: 'member' }] as never[];
    render(
      <SectionStudioChat sessionId="sess-1" chrome={chrome} prefill={prefill} onBack={onBack} />,
    );
    const p = captured.current!;
    expect(p.chrome).toBe(chrome); // 防双拉：同一引用下传
    expect(p.sessionId).toBe('sess-1');
    expect(p.prefill).toBe(prefill);
    expect(p.onBack).toBe(onBack);
    expect(p.rootTag).toBe('main');
    expect(p.fadeIn).toBe(true);
    expect(p.emptyStateSlot).toBeTruthy(); // studio 空态文案经 emptyStateSlot 注入
  });
});
